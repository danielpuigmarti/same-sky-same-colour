// Rice decoding of one tile of a FITS tile-compressed image (the RICE_1 scheme of the FITS tiled-image
// convention). One call decodes one tile into `out`; the values are integers of 1, 2 or 4 bytes.

const NONZERO = new Uint8Array(256);
for (let i = 1; i < 256; i++) NONZERO[i] = 32 - Math.clz32(i);

/**
 * @param {Uint8Array} c  The compressed bytes of the tile.
 * @param {number} nx  Number of values in the tile.
 * @param {number} nblock  Values per block (ZVAL1, usually 32).
 * @param {number} bytepix  Bytes per value: 1, 2 or 4 (ZVAL2).
 * @param {Int32Array} out  Receives the first `nx` values.
 * @returns {Int32Array} out
 */
export function riceDecode(c, nx, nblock, bytepix, out) {
  const [fsbits, fsmax, bbits] = bytepix === 1 ? [3, 6, 8] : bytepix === 2 ? [4, 14, 16] : [5, 25, 32];
  /** @type {(v: number) => number} */
  const wrap = bytepix === 4 ? (v) => v | 0 : bytepix === 2 ? (v) => v & 0xffff : (v) => v & 0xff;
  let p = 0, lastpix = 0;
  for (let k = 0; k < bytepix; k++) lastpix = (lastpix << 8) | c[p++];
  lastpix = wrap(lastpix);
  let b = c[p++], nbits = 8, i = 0;
  while (i < nx) {
    nbits -= fsbits;
    while (nbits < 0) { b = (b << 8) | c[p++]; nbits += 8; }
    const fs = (b >>> nbits) - 1;
    b &= (1 << nbits) - 1;
    const imax = Math.min(i + nblock, nx);
    if (fs < 0) {
      for (; i < imax; i++) out[i] = lastpix;
    } else if (fs === fsmax) {
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = k >= 32 ? 0 : (b << k) >>> 0;
        for (k -= 8; k >= 0; k -= 8) { b = c[p++]; diff = (diff | (b << k)) >>> 0; }
        if (nbits > 0) { b = c[p++]; diff = (diff | (b >>> -k)) >>> 0; b &= (1 << nbits) - 1; } else b = 0;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = wrap(diff + lastpix); out[i] = lastpix;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = c[p++]; }
        const nzero = nbits - NONZERO[b];
        nbits -= nzero + 1;
        b ^= 1 << nbits;
        nbits -= fs;
        while (nbits < 0) { b = (b << 8) | c[p++]; nbits += 8; }
        let diff = ((nzero << fs) | (b >>> nbits)) >>> 0;
        b &= (1 << nbits) - 1;
        diff = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = wrap(diff + lastpix); out[i] = lastpix;
      }
    }
    if (p > c.length) throw new Error(`rice: read past the end of the tile (${p} > ${c.length})`);
  }
  return out;
}
