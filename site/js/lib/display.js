// The display grid: the one set of pixels on which every picture of a view is drawn. Same rule, same output as
// pipeline/sx/display.py; tests/vectors/display.json holds the cases.
//
// Two visits of SPHEREx see the same sky turned by 145 to 180 degrees on the detector, so stamps in detector
// orientation do not line up. On the display grid north is up, east is to the left, a pixel is PIXEL_ARCSEC across
// and the target is the pixel (size // 2, size // 2). A stamp is put on it by nearest neighbour: each output pixel
// takes the value of the one source pixel that its centre falls in. Nothing is interpolated. A source pixel may be
// taken by two output pixels or by none; an output pixel whose centre falls outside the stamp has no value (NaN)
// and no flags (0), and says so in `sx` and `sy` (-1).
//
// The sky of a stamp is flat around its target pixel: `sky = {ra, dec, cd}` (CT-4). A stamp read live gets it from
// the transform of its own frame (skyOfFrame, createSkyReader).

/** @import { Stamp, LocalSky } from '../contracts.js' */
/** @import { Header } from './fitsio.js' */
/** @import { Wcs } from './wcs.js' */
import { BUCKET_URLS } from '../contracts.js';
import { localSky } from '../ui/hover.js';
import { makeWcs } from './wcs.js';
import { readHead } from './frame.js';
import { createQueue } from './queue.js';

/** The size of a pixel of the display grid, arcsec: the size of a SPHEREx pixel. */
export const PIXEL_ARCSEC = 6.15;
export const PIXEL_DEG = PIXEL_ARCSEC / 3600;

/**
 * The side of the display grid for a position read live. A square of this side fits inside a stamp of 64 pixels
 * whichever way the detector was turned (turned by 45 degrees it needs 62.2 pixels).
 */
export const DISPLAY_SIZE = 44;

/**
 * A stamp on the display grid: the fields of a stamp (CT-4), with `w` and `h` the side of the grid, `tx` and `ty`
 * its middle pixel, and `sky` the sky of the grid. `x0` and `y0` stay those of the stamp it was made from: with
 * `sx` and `sy` they give the detector pixel behind each pixel of the grid.
 * @typedef {Object} OnGrid
 * @property {LocalSky} sky  The sky of the grid: north up, east to the left.
 * @property {Int32Array} sx  For each pixel of the grid, the column of the stamp pixel it was taken from; -1 outside the stamp.
 * @property {Int32Array} sy  The row of that pixel; -1 outside the stamp.
 * @property {number} sw  Width of the stamp it was made from.
 * @property {number} sh  Height of that stamp.
 */

/** @typedef {Stamp & OnGrid} GridStamp */

/**
 * The sky of a picture on the display grid that is centred on the target of `sky`.
 * @param {LocalSky} sky
 * @returns {LocalSky}
 */
export function gridSky(sky) {
  return { ra: sky.ra, dec: sky.dec, cd: [-PIXEL_DEG, 0, 0, PIXEL_DEG] };
}

/**
 * Where each pixel of a size by size display grid lies in a stamp, not rounded: `x[k]` and `y[k]` are the column
 * and row of the stamp at the centre of grid pixel k (k = j * size + i). `sky` is the stamp's own, (tx, ty) its
 * target pixel.
 * @param {LocalSky} sky @param {number} tx @param {number} ty @param {number} size
 * @returns {{x: Float64Array, y: Float64Array}}
 */
export function sourceMap(sky, tx, ty, size) {
  const [cd0, cd1, cd2, cd3] = sky.cd, det = cd0 * cd3 - cd1 * cd2;
  if (!det || !Number.isFinite(det)) throw new Error('the sky transform of the stamp cannot be inverted');
  const c = Math.floor(size / 2);
  const x = new Float64Array(size * size), y = new Float64Array(size * size);
  for (let j = 0; j < size; j++) {
    const north = (j - c) * PIXEL_DEG;
    for (let i = 0; i < size; i++) {
      const east = (c - i) * PIXEL_DEG;
      x[j * size + i] = tx + (cd3 * east - cd1 * north) / det;
      y[j * size + i] = ty + (cd0 * north - cd2 * east) / det;
    }
  }
  return { x, y };
}

/**
 * For each pixel of a size by size display grid, the column and row of the stamp pixel that holds its centre
 * (-1 and -1 outside the w by h stamp).
 * @param {LocalSky} sky @param {number} tx @param {number} ty @param {number} w @param {number} h @param {number} size
 * @returns {{sx: Int32Array, sy: Int32Array}}
 */
export function sourcePixels(sky, tx, ty, w, h, size) {
  const at = sourceMap(sky, tx, ty, size);
  const sx = new Int32Array(size * size), sy = new Int32Array(size * size);
  for (let k = 0; k < sx.length; k++) {
    const x = Math.floor(at.x[k] + 0.5), y = Math.floor(at.y[k] + 0.5);
    const inside = x >= 0 && x < w && y >= 0 && y < h;
    sx[k] = inside ? x : -1;
    sy[k] = inside ? y : -1;
  }
  return { sx, sy };
}

/**
 * The stamp (CT-4, with `sky`) on the display grid, size by size, by nearest neighbour.
 * @param {Stamp} stamp
 * @param {number} [size]
 * @returns {GridStamp}
 */
export function toDisplayGrid(stamp, size = DISPLAY_SIZE) {
  if (!stamp.sky) throw new Error('the stamp has no sky transform');
  const { sx, sy } = sourcePixels(stamp.sky, stamp.tx, stamp.ty, stamp.w, stamp.h, size);
  const data = new Float32Array(size * size).fill(NaN);
  const flags = stamp.flags ? new Int32Array(size * size) : null;
  for (let k = 0; k < data.length; k++) {
    if (sx[k] < 0) continue;
    const from = sy[k] * stamp.w + sx[k];
    data[k] = stamp.data[from];
    if (flags && stamp.flags) flags[k] = stamp.flags[from];
  }
  const c = Math.floor(size / 2);
  return { ...stamp, w: size, h: size, tx: c, ty: c, data, flags, sky: gridSky(stamp.sky), sx, sy, sw: stamp.w, sh: stamp.h };
}

/**
 * True for a picture that is on the display grid and knows the stamp pixel behind each of its pixels.
 * @param {unknown} picture
 * @returns {picture is GridStamp}
 */
export function isOnGrid(picture) {
  const p = /** @type {{sx?: unknown, sy?: unknown} | null} */ (picture);
  return p !== null && typeof p === 'object' && p.sx instanceof Int32Array && p.sy instanceof Int32Array;
}

/**
 * The detector pixel behind a pixel of a picture on the display grid: full-frame, 0-based. Null outside the stamp.
 * @param {GridStamp} picture @param {number} x @param {number} y  A pixel of the grid.
 * @returns {{x: number, y: number} | null}
 */
export function detectorPixel(picture, x, y) {
  const k = y * picture.w + x;
  if (!(k >= 0 && k < picture.sx.length) || picture.sx[k] < 0) return null;
  return { x: picture.x0 + picture.sx[k], y: picture.y0 + picture.sy[k] };
}

/**
 * The middle size by size pixels of a square array of side `from`, as a new array: the pixels that a display grid
 * of side `size` shares with one of side `from` around the same target.
 * @template {Float32Array | Int32Array | Uint8Array} T
 * @param {T} values  from * from values.
 * @param {number} from @param {number} size
 * @returns {T}
 */
export function cropSquare(values, from, size) {
  if (size > from) throw new Error('the crop is larger than the picture');
  const o = Math.floor(from / 2) - Math.floor(size / 2);
  const out = /** @type {T} */ (new (/** @type {any} */ (values.constructor))(size * size));
  for (let j = 0; j < size; j++) out.set(values.subarray((j + o) * from + o, (j + o) * from + o + size), j * size);
  return out;
}

/**
 * The flat sky around the target pixel of a stamp, from the header of its frame (distortion included).
 * @param {Header | Wcs} frame  The IMAGE header of the frame, or its transform.
 * @param {{x0: number, y0: number, tx: number, ty: number}} stamp
 * @returns {LocalSky | null}  Null when the transform gives no position there.
 */
export function skyOfFrame(frame, stamp) {
  const wcs = typeof (/** @type {Wcs} */ (frame).pix2world) === 'function' ? /** @type {Wcs} */ (frame) : makeWcs(/** @type {Header} */ (frame));
  return localSky(wcs.pix2world, stamp);
}

/**
 * Reads the sky of stamps from the archive: the first bytes of a frame (its headers) give its transform. A frame is
 * asked for once; a frame that could not be read is asked for again the next time. Nothing is put into a cache
 * other than the memory of this page.
 * @param {{fetch?: typeof fetch, hosts?: readonly string[], limit?: number, kept?: number}} [options]
 *   `limit`: requests in flight per host (the reader of the stamps has its own six). `kept`: frames remembered.
 */
export function createSkyReader({ fetch: fetchFn, hosts = BUCKET_URLS, limit = 2, kept = 400 } = {}) {
  const queue = createQueue({ fetch: fetchFn, limit });
  /** @type {Map<string, Promise<Wcs>>} */
  const known = new Map();
  let turn = 0;

  /** @param {string} key @returns {Promise<Wcs>} */
  function transform(key) {
    let p = known.get(key);
    if (!p) {
      const first = turn++;
      p = readHead(async (start, end, kind, prio) => {
        /** @type {unknown} */
        let last;
        for (let k = 0; k < hosts.length; k++) {
          try {
            return await queue.get(hosts[(first + k) % hosts.length] + key, start, end, { kind, prio });
          } catch (e) {
            if (/** @type {{code?: string}} */ (e)?.code === 'aborted') throw e;
            last = e;
          }
        }
        throw last;
      }).then((head) => makeWcs(head.h));
      known.set(key, p);
      p.catch(() => { if (known.get(key) === p) known.delete(key); });
      while (known.size > kept) known.delete(/** @type {string} */ (known.keys().next().value));
    }
    return p;
  }

  return {
    /**
     * The sky around the target pixel of a stamp of the frame `key`. Null when the frame cannot be read.
     * @param {string} key  Bucket key of the frame.
     * @param {{x0: number, y0: number, tx: number, ty: number}} stamp
     * @returns {Promise<LocalSky | null>}
     */
    async skyOf(key, stamp) {
      try {
        return localSky((await transform(key)).pix2world, stamp);
      } catch {
        return null;
      }
    },
    /** Stop the requests that are running or waiting. */
    cancel() { queue.cancel(); },
    queue,
  };
}
