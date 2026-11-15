// What the reader needs to know about the layout of a SPHEREx Level 2 file, written as functions on bytes:
// headers, where each part starts, and how to cut a box out of the IMAGE (plain float32) and out of the FLAGS
// (a tile-compressed image: RICE_1, one row to a tile). Nothing here fetches anything.
import { riceDecode } from './rice.js';

/** @typedef {Record<string, any>} Header  Keyword to value: a number, a string, a boolean or null. */
/** @typedef {{h: Header, hoff: number, doff: number, dlen: number, next: number}} Hdu
 *  A part of the file: its header, where the header starts, where the data start, the data length and where the next part starts. */
/** @typedef {{x0: number, y0: number, w: number, h: number}} Box  A box of pixels, 0-based, first pixel x0 and y0. */

export const BLOCK = 2880;

/** The first request of a frame: the primary header and the IMAGE header fit in it (bytes 0 to 28,799). */
export const HEADER_START_BYTES = 28800;

/** The request that reads the FLAGS header and, usually, the whole pointer table behind it. */
export const FLAGS_HEAD_BYTES = BLOCK * 8 + 2040 * 8;

/**
 * One 80-character card as text. A header holds a byte above 127, so the bytes are read as Latin-1.
 * @param {Uint8Array} buf @param {number} i
 */
function card(buf, i) {
  let s = '';
  for (let k = 0; k < 80; k++) s += String.fromCharCode(buf[i + k]);
  return s;
}

/** @param {string} s */
function value(s) {
  s = s.trimStart();
  if (s[0] === "'") {
    let v = '', i = 1;
    for (; i < s.length; i++) {
      if (s[i] === "'") { if (s[i + 1] === "'") { v += "'"; i++; } else break; } else v += s[i];
    }
    return v.trimEnd();
  }
  const t = s.split('/')[0].trim();
  if (t === 'T') return true;
  if (t === 'F') return false;
  if (t === '') return null;
  const n = Number(t.replace(/[dD]/, 'E'));
  return Number.isNaN(n) ? t : n;
}

/**
 * Parse the header that starts at byte `start` of `buf`.
 * @param {Uint8Array} buf @param {number} [start]
 * @returns {{h: Header, len: number} | null}  `len` is the length of the header in whole blocks; null when END is not inside `buf`.
 */
export function parseHeader(buf, start = 0) {
  /** @type {Header} */
  const h = {};
  for (let i = start; i + 80 <= buf.length; i += 80) {
    const c = card(buf, i), key = c.slice(0, 8).trimEnd();
    if (key === 'END') { const n = (i - start) / 80 + 1; return { h, len: Math.ceil(n / 36) * BLOCK }; }
    if (c[8] === '=' && c[9] === ' ' && key) h[key] = value(c.slice(10));
  }
  return null;
}

/** Length of the data of a part, in bytes, without the padding. @param {Header} h */
export function dataLength(h) {
  const nax = h.NAXIS || 0;
  if (!nax) return 0;
  let n = 1;
  for (let i = 1; i <= nax; i++) n *= h['NAXIS' + i];
  return Math.abs(h.BITPIX) / 8 * (h.GCOUNT ?? 1) * ((h.PCOUNT || 0) + n);
}

/** @param {number} n  Length rounded up to whole blocks. */
export const pad = (n) => Math.ceil(n / BLOCK) * BLOCK;

/**
 * The part whose header starts at `off`, or null when its END is not inside `buf`.
 * @param {Uint8Array} buf @param {number} off
 * @returns {Hdu | null}
 */
export function parseHdu(buf, off) {
  const p = parseHeader(buf, off);
  if (!p) return null;
  const dlen = dataLength(p.h);
  return { h: p.h, hoff: off, doff: off + p.len, dlen, next: off + p.len + pad(dlen) };
}

/**
 * The primary header and the IMAGE header, from the bytes at the start of the file.
 * @param {Uint8Array} buf
 * @returns {{primary: Hdu, image: Hdu} | null}  null when the bytes end before the IMAGE header does.
 */
export function parseFileStart(buf) {
  const primary = parseHdu(buf, 0);
  if (!primary) return null;
  const image = parseHdu(buf, primary.next);
  return image ? { primary, image } : null;
}

/** The part of a box that lies inside an image of nx by ny pixels. @param {Box} b @param {number} nx @param {number} ny */
function clip(b, nx, ny) {
  return { xa: Math.max(0, b.x0), xb: Math.min(nx, b.x0 + b.w), ya: Math.max(0, b.y0), yb: Math.min(ny, b.y0 + b.h) };
}

/**
 * The bytes (both ends included) that hold the rows of an uncompressed image that a box crosses, whole rows.
 * @param {Hdu} hdu @param {Box} box
 * @returns {{start: number, end: number} | null}  null when the box is outside the image.
 */
export function imageRowsRange(hdu, box) {
  const nx = hdu.h.NAXIS1, ny = hdu.h.NAXIS2, c = clip(box, nx, ny);
  if (c.yb <= c.ya || c.xb <= c.xa) return null;
  return { start: hdu.doff + c.ya * nx * 4, end: hdu.doff + c.yb * nx * 4 - 1 };
}

/**
 * The box out of the bytes of whole rows (from `imageRowsRange`) of a BITPIX -32 image. Values are copied bit for bit, so a
 * missing value keeps its pattern. Pixels outside the image are NaN.
 * @param {Uint8Array} raw @param {Hdu} hdu @param {Box} box
 * @returns {Float32Array}  box.w * box.h values, row by row, first row at the lowest y.
 */
export function decodeImageBox(raw, hdu, box) {
  const h = hdu.h, nx = h.NAXIS1, ny = h.NAXIS2;
  if (h.BITPIX !== -32 || (h.BSCALE !== undefined && h.BSCALE !== 1) || h.BZERO) throw new Error('IMAGE is not an unscaled BITPIX -32 image');
  const out = new Float32Array(box.w * box.h).fill(NaN), bits = new Uint32Array(out.buffer);
  const c = clip(box, nx, ny);
  if (c.yb <= c.ya || c.xb <= c.xa) return out;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let y = c.ya; y < c.yb; y++) {
    for (let x = c.xa; x < c.xb; x++) bits[(y - box.y0) * box.w + (x - box.x0)] = dv.getUint32(((y - c.ya) * nx + x) * 4, false);
  }
  return out;
}

/**
 * @typedef {Object} FlagsLayout  How the FLAGS part stores its image.
 * @property {number} nx  Pixels per row.
 * @property {number} ny  Rows.
 * @property {number} t2  Rows to a tile (1).
 * @property {number} blocksize  Values to a Rice block.
 * @property {number} bytepix  Bytes to a value.
 * @property {number} cpos  Offset of the COMPRESSED_DATA field in a table row.
 * @property {string} ccode  Type letter of that field: P (32-bit pointers) or Q (64-bit pointers).
 * @property {number} rowBytes  Bytes in a table row.
 * @property {number} theap  Offset of the heap from the start of the table data.
 */

/** @param {string} t */
function tformSize(t) {
  const m = /^(\d*)([LXBIJKAEDCMPQ])/.exec(t.trim());
  if (!m) throw new Error(`FLAGS: unknown field type ${t}`);
  const r = m[1] === '' ? 1 : +m[1], c = m[2];
  /** @type {Record<string, number>} */
  const w = { L: 1, X: 1 / 8, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };
  return { size: c === 'X' ? Math.ceil(r / 8) : r * w[c], code: c };
}

/**
 * Read the compression layout from the header of the FLAGS part. Only the layout of SPHEREx is supported: RICE_1 with
 * one whole row to a tile and 32-bit values. Anything else throws.
 * @param {Header} h
 * @returns {FlagsLayout}
 */
export function flagsLayout(h) {
  const nx = h.ZNAXIS1, ny = h.ZNAXIS2, t1 = h.ZTILE1 ?? nx, t2 = h.ZTILE2 ?? 1;
  if (!h.ZIMAGE || h.ZCMPTYPE !== 'RICE_1' || t1 !== nx || h.ZBITPIX !== 32) {
    throw new Error(`FLAGS: unsupported layout ${h.ZCMPTYPE} ${t1}x${t2} ZBITPIX ${h.ZBITPIX}`);
  }
  let col = 0, cpos = -1, ccode = '';
  for (let i = 1; i <= h.TFIELDS; i++) {
    const f = tformSize(h['TFORM' + i]);
    if (h['TTYPE' + i] === 'COMPRESSED_DATA') { cpos = col; ccode = f.code; }
    col += f.size;
  }
  if (cpos < 0 || col !== h.NAXIS1) throw new Error('FLAGS: no COMPRESSED_DATA column');
  if ((h.BSCALE ?? 1) !== 1 || (h.BZERO ?? 0) !== 0) throw new Error('FLAGS: scaled integers are not supported');
  return { nx, ny, t2, blocksize: h.ZVAL1 ?? 32, bytepix: h.ZVAL2 ?? 4, cpos, ccode, rowBytes: h.NAXIS1, theap: h.THEAP ?? h.NAXIS1 * h.NAXIS2 };
}

/**
 * The tiles a box crosses and the bytes of the pointer table that describe them.
 * @param {Hdu} hdu @param {FlagsLayout} lay @param {Box} box
 * @returns {{ta: number, tb: number, start: number, end: number} | null}  tiles ta to tb-1; null when the box is outside the image.
 */
export function flagsTableRange(hdu, lay, box) {
  const c = clip(box, lay.nx, lay.ny);
  if (c.yb <= c.ya || c.xb <= c.xa) return null;
  const ta = Math.floor(c.ya / lay.t2), tb = Math.floor((c.yb - 1) / lay.t2) + 1;
  return { ta, tb, start: hdu.doff + ta * lay.rowBytes, end: hdu.doff + tb * lay.rowBytes - 1 };
}

/**
 * The pointers [length, offset in the heap] of `count` tiles, from the bytes of the table rows.
 * @param {Uint8Array} tab @param {FlagsLayout} lay @param {number} count
 * @returns {[number, number][]}
 */
export function parseDescriptors(tab, lay, count) {
  const dv = new DataView(tab.buffer, tab.byteOffset, tab.byteLength);
  /** @type {[number, number][]} */
  const desc = [];
  for (let t = 0; t < count; t++) {
    const o = t * lay.rowBytes + lay.cpos;
    desc.push(lay.ccode === 'P'
      ? [dv.getInt32(o, false), dv.getInt32(o + 4, false)]
      : [Number(dv.getBigInt64(o, false)), Number(dv.getBigInt64(o + 8, false))]);
  }
  return desc;
}

/**
 * The bytes of the heap that hold the given tiles, both ends included, as positions in the file.
 * @param {Hdu} hdu @param {FlagsLayout} lay @param {[number, number][]} desc
 * @returns {{start: number, end: number, lo: number}}  `lo` is the heap offset of `start`.
 */
export function flagsHeapRange(hdu, lay, desc) {
  const lo = Math.min(...desc.map((d) => d[1])), hi = Math.max(...desc.map((d) => d[1] + d[0]));
  const heap = hdu.doff + lay.theap;
  return { start: heap + lo, end: heap + hi - 1, lo };
}

/**
 * The box out of the compressed tiles.
 * @param {Uint8Array} raw  The heap bytes from `flagsHeapRange`.
 * @param {[number, number][]} desc  The pointers of the tiles the box crosses, in order.
 * @param {number} lo  Heap offset of raw[0].
 * @param {FlagsLayout} lay @param {Box} box
 * @returns {Int32Array}  box.w * box.h flag words, row by row, first row at the lowest y; 0 outside the image.
 */
export function decodeFlagsBox(raw, desc, lo, lay, box) {
  const { nx, ny, t2, blocksize, bytepix } = lay;
  const c = clip(box, nx, ny);
  const out = new Int32Array(box.w * box.h);
  if (c.yb <= c.ya || c.xb <= c.xa) return out;
  const ta = Math.floor(c.ya / t2);
  const tile = new Int32Array(nx * t2);
  for (let t = 0; t < desc.length; t++) {
    const [len, off] = desc[t];
    if (len === 0) throw new Error('FLAGS: empty tile (a fallback column is not supported)');
    const rows = Math.min(t2, ny - (ta + t) * t2);
    riceDecode(raw.subarray(off - lo, off - lo + len), nx * rows, blocksize, bytepix, tile);
    for (let r = 0; r < rows; r++) {
      const y = (ta + t) * t2 + r;
      if (y < c.ya || y >= c.yb) continue;
      for (let x = c.xa; x < c.xb; x++) out[(y - box.y0) * box.w + (x - box.x0)] = tile[r * nx + x];
    }
  }
  return out;
}
