// One frame, read with byte ranges: the headers, where a sky position falls on the detector, and the stamp
// (IMAGE and FLAGS) around it. A frame is reached only through `get(start, end, kind, prio)`, which returns the
// bytes start to end, both included; the queue and the choice of host are somebody else's business.
import {
  HEADER_START_BYTES, FLAGS_HEAD_BYTES, parseFileStart, parseHdu, imageRowsRange, decodeImageBox,
  flagsLayout, flagsTableRange, parseDescriptors, flagsHeapRange, decodeFlagsBox,
} from './fitsio.js';

/** @import { Hdu, Header, Box } from './fitsio.js' */
/** @import { Wcs } from './wcs.js' */

/** @typedef {(start: number, end: number, kind: 'header' | 'row', prio: number) => Promise<Uint8Array>} Get */

/** Side of a stamp, pixels. */
export const STAMP_SIZE = 64;

/**
 * @typedef {Object} FrameHead  What the first request of a frame tells.
 * @property {number} nx  Pixels per row of the IMAGE.
 * @property {number} ny  Rows.
 * @property {number} doff  File offset of the first IMAGE value.
 * @property {number} next  File offset of the FLAGS part (its header).
 * @property {number} mjd  Mid-exposure time, MJD (UTC), from the header's MJD-AVG.
 * @property {Header} h  The IMAGE header (wcs.js reads the sky coordinates from it).
 */

/** @typedef {Pick<FrameHead, 'nx' | 'ny' | 'doff' | 'next'>} Layout  Where the stamp's bytes are: all `readStamp` needs. */

/** @param {Uint8Array} a @param {Uint8Array} b */
function join(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Read the primary header and the IMAGE header: bytes 0 to 28,799 hold both; if the IMAGE header is longer, read on.
 * @param {Get} get @param {number} [prio]
 * @returns {Promise<FrameHead>}
 */
export async function readHead(get, prio = 0) {
  let buf = await get(0, HEADER_START_BYTES - 1, 'header', prio);
  for (let tries = 0; ; tries++) {
    const parts = parseFileStart(buf);
    if (parts) {
      const { primary, image } = parts;
      const h = image.h;
      if (h.EXTNAME !== 'IMAGE') throw new Error('the second part of the file is ' + h.EXTNAME);
      if (h.BITPIX !== -32 || (h.BSCALE !== undefined && h.BSCALE !== 1) || h.BZERO) throw new Error('IMAGE is not an unscaled BITPIX -32 image');
      const mjd = image.h['MJD-AVG'] ?? primary.h['MJD-AVG'];
      return { nx: image.h.NAXIS1, ny: image.h.NAXIS2, doff: image.doff, next: image.next, mjd, h: image.h };
    }
    if (tries >= 8) throw new Error('no END card in the first 100 kB of the file');
    buf = join(buf, await get(buf.length, buf.length + 4 * 2880 - 1, 'header', prio));
  }
}

/**
 * @typedef {Object} Placement  Where a sky position falls on a frame, and the stamp around it.
 * @property {number} x  Target pixel x, not rounded (0-based). @property {number} y  Target pixel y.
 * @property {number} x0  Full-frame x of the first stamp element: floor(x + 0.5) - n/2.
 * @property {number} y0  Same for y.
 * @property {number} tx  The target's x in stamp pixels (x - x0). @property {number} ty  The target's y.
 * @property {number} n  Stamp side.
 * @property {boolean} inside  The whole stamp lies on the detector.
 */

/**
 * @param {Wcs} wcs @param {number} nx @param {number} ny @param {number} ra @param {number} dec @param {number} [n]
 * @returns {Placement}
 */
export function place(wcs, nx, ny, ra, dec, n = STAMP_SIZE) {
  const [x, y] = wcs.world2pix(ra, dec);
  const x0 = Math.floor(x + 0.5) - n / 2, y0 = Math.floor(y + 0.5) - n / 2;
  return { x, y, x0, y0, tx: x - x0, ty: y - y0, n, inside: x0 >= 0 && y0 >= 0 && x0 + n <= nx && y0 + n <= ny };
}

/**
 * Rows of a stamp where the background of a frame is not to be trusted, whatever the target: in detector 1 the
 * rows below 150, in detector 2 the rows above 1960. A stamp that reaches them is never used.
 * @param {number} det @param {number} y0 First stamp row. @param {number} n Stamp side.
 */
export function reachesBadRows(det, y0, n = STAMP_SIZE) {
  return (det === 1 && y0 < 150) || (det === 2 && y0 + n - 1 > 1960);
}

/**
 * The IMAGE and FLAGS values of a stamp. A frame is read in four requests: the IMAGE rows the stamp crosses; the
 * FLAGS header with the table of pointers; then the compressed FLAGS rows. When the FLAGS cannot be read, `flags`
 * is null and `flagsError` says why: the stamp is still good.
 * @param {Get} get @param {Layout} head @param {Placement} at @param {{flags?: boolean, prio?: number}} [options]
 * @returns {Promise<{data: Float32Array, flags: Int32Array | null, flagsError: string | null, bytes: number}>}
 */
export async function readStamp(get, head, at, { flags = true, prio = 0 } = {}) {
  /** @type {Hdu} */
  const image = { h: { NAXIS1: head.nx, NAXIS2: head.ny, BITPIX: -32 }, hoff: 0, doff: head.doff, dlen: 0, next: head.next };
  /** @type {Box} */
  const box = { x0: at.x0, y0: at.y0, w: at.n, h: at.n };
  const rows = imageRowsRange(image, box);
  if (!rows) throw new Error('the stamp is outside the image');
  let bytes = 0;
  const imageJob = get(rows.start, rows.end, 'row', prio).then((raw) => { bytes += raw.length; return decodeImageBox(raw, image, box); });
  /** @type {Promise<{flags: Int32Array | null, flagsError: string | null}>} */
  const flagsJob = flags
    ? readFlags(get, head, box, prio).then((r) => { bytes += r.bytes; return { flags: r.flags, flagsError: null }; },
      (e) => (isFetchFailure(e) ? Promise.reject(e) : { flags: null, flagsError: String(e?.message ?? e) }))
    : Promise.resolve({ flags: null, flagsError: null });
  const [data, f] = await Promise.all([imageJob, flagsJob]);
  return { data, flags: f.flags, flagsError: f.flagsError, bytes };
}

/** A failed request, as opposed to bytes that could not be understood. @param {any} e */
const isFetchFailure = (e) => e && typeof e.code === 'string';

/**
 * @param {Get} get @param {Layout} head @param {Box} box @param {number} prio
 * @returns {Promise<{flags: Int32Array, bytes: number}>}
 */
async function readFlags(get, head, box, prio) {
  let buf = await get(head.next, head.next + FLAGS_HEAD_BYTES - 1, 'header', prio);
  let bytes = buf.length;
  /** @type {Hdu | null} */
  let hdu = parseHdu(buf, 0);
  while (!hdu) {
    const more = await get(head.next + buf.length, head.next + buf.length + 4 * 2880 - 1, 'header', prio);
    bytes += more.length;
    buf = join(buf, more);
    hdu = parseHdu(buf, 0);
  }
  if (hdu.h.EXTNAME !== 'FLAGS') throw new Error('the third part of the file is ' + hdu.h.EXTNAME);
  const lay = flagsLayout(hdu.h);
  // hdu is relative to head.next here; the offsets below are relative to the start of the file
  const abs = { ...hdu, hoff: head.next, doff: head.next + hdu.doff, next: head.next + hdu.next };
  const tr = flagsTableRange(abs, lay, box);
  if (!tr) throw new Error('the stamp is outside the FLAGS image');
  const have = head.next + buf.length;
  /** @type {Uint8Array} */
  let tab;
  if (tr.end + 1 <= have) tab = buf.subarray(tr.start - head.next, tr.end + 1 - head.next);
  else { tab = await get(tr.start, tr.end, 'header', prio); bytes += tab.length; }
  const desc = parseDescriptors(tab, lay, tr.tb - tr.ta);
  const heap = flagsHeapRange(abs, lay, desc);
  const raw = await get(heap.start, heap.end, 'row', prio);
  bytes += raw.length;
  return { flags: decodeFlagsBox(raw, desc, heap.lo, lay, box), bytes };
}
