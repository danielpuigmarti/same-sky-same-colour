// The frame index (CT-2): which frames of the archive cover a sky position, read from static files.
// Declination bands are cut into tiles in right ascension; a frame is written into every tile its circumscribed
// circle touches, so one tile holds every frame that covers any position inside it. `meta.json` lists the finished
// tiles; for any other tile the answer is "not indexed yet". A tile is a gzip file holding a JSON list of rows.
import { INDEX_META_FILE } from '../contracts.js';

/** @import { Frame, IndexMeta, IndexRow, RaDec } from '../contracts.js' */

const RAD = Math.PI / 180;

/** @param {number} ra @param {number} dec @returns {[number, number, number]} */
const vec = (ra, dec) => [Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD)];

/** A frame is never larger than this from corner to corner, degrees (2.47 degrees from the centre, with room). */
const FRAME_REACH = 6;
const COS_REACH = Math.cos(FRAME_REACH * RAD);

/**
 * Whether the point `p` (a unit vector) lies inside the quadrilateral `c`, and at least `margin` degrees from every
 * side. With margin 0 a point on a side counts as inside.
 * @param {[number, number, number]} p @param {RaDec[]} c @param {number} [margin]
 */
export function inside(p, c, margin = 0) {
  const v = c.map((q) => vec(q[0], q[1]));
  let front = 0;
  for (const q of v) front += q[0] * p[0] + q[1] * p[1] + q[2] * p[2];
  if (front <= 0) return false; // the other side of the sky
  const lo = margin > 0 ? Math.sin(margin * RAD) : -1e-12;
  let pos = true, neg = true;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    const nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
    const s = (nx * p[0] + ny * p[1] + nz * p[2]) / Math.hypot(nx, ny, nz); // sine of the distance to the side's great circle
    if (s < lo) pos = false;
    if (s > -lo) neg = false;
  }
  return pos || neg;
}

/**
 * The name of the tile that holds a position: "band_j".
 * @param {number} ra @param {number} dec @param {{nbands: number, nra: number[]}} meta
 */
export function tileOf(ra, dec, meta) {
  const nb = meta.nbands, b = Math.min(nb - 1, Math.max(0, Math.floor((dec + 90) / (180 / nb))));
  const n = meta.nra[b];
  return `${b}_${Math.floor((((ra % 360) + 360) % 360) / (360 / n)) % n}`;
}

/**
 * The bucket key of a tile row.
 * @param {IndexRow} r @param {string[]} wv
 */
export function keyOf(r, wv) {
  const [week, ver] = wv[r[0]].split('/'), obs = String(r[1]).padStart(4, '0'), exp = r[2], det = r[3];
  return `dr1/level2/${week}/${ver}/${det}/level2_${week}_${obs}_${exp}D${det}_spx_${ver}.fits`;
}

/**
 * Unpack gzip bytes with the browser's DecompressionStream.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function gunzip(bytes) {
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @param {string} base */
const folder = (base) => (base.endsWith('/') ? base : base + '/');

/**
 * @typedef {Object} IndexOptions
 * @property {typeof fetch} [fetch]  Default: the global fetch.
 * @property {(bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array} [gunzip]  Default: DecompressionStream. Node tests pass zlib's.
 * @property {number} [tilesKept]  Tiles kept in memory (default 3).
 */

/** @typedef {{margin?: number}} CoverOptions  margin: degrees; a frame counts only when the position is at least that far inside its outline. */

/**
 * The reader of an index. `base` is the address of the index folder (the one with meta.json).
 * @param {IndexOptions} [options]
 */
export function createIndex({ fetch: fetchFn, gunzip: unzip = gunzip, tilesKept = 3 } = {}) {
  const get = (/** @type {string} */ url) => (fetchFn ?? globalThis.fetch)(url);
  /** @type {Map<string, Promise<IndexMeta>>} */
  const metas = new Map();
  /** @type {Map<string, Promise<IndexRow[] | null>>} */
  const tiles = new Map();

  /** @param {string} base */
  function meta(base) {
    const url = folder(base) + INDEX_META_FILE;
    let p = metas.get(url);
    if (!p) {
      p = get(url).then(async (r) => {
        if (!r.ok) throw new Error(`index: ${r.status} ${url}`);
        return /** @type {IndexMeta} */ (await r.json());
      });
      metas.set(url, p);
      p.catch(() => metas.delete(url));
    }
    return p;
  }

  /** The rows of a tile, or null when there is no such file (a tile without frames is not written). @param {string} base @param {string} name */
  function tile(base, name) {
    const url = `${folder(base)}t/${name}.json.gz`;
    let p = tiles.get(url);
    if (!p) {
      p = get(url).then(async (r) => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`index: ${r.status} ${url}`);
        /** @type {Uint8Array} */
        let bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await unzip(bytes); // a host may already have unpacked it
        return /** @type {IndexRow[]} */ (JSON.parse(new TextDecoder().decode(bytes)));
      });
      tiles.set(url, p);
      p.catch(() => tiles.delete(url));
      while (tiles.size > tilesKept) tiles.delete(/** @type {string} */ (tiles.keys().next().value));
    }
    return p;
  }

  /**
   * CT-2. The frames whose outline contains the position, in the order of the tile (by time).
   * @param {number} ra @param {number} dec @param {string} base @param {CoverOptions} [opt]
   * @returns {Promise<Frame[]>}
   */
  async function framesCovering(ra, dec, base, opt = {}) {
    const m = await meta(base);
    const rows = await tile(base, tileOf(ra, dec, m));
    if (!rows) return [];
    const p = vec(ra, dec), margin = opt.margin ?? 0, out = [];
    for (const r of rows) {
      const v1 = vec(r[5], r[6]);
      if (v1[0] * p[0] + v1[1] * p[1] + v1[2] * p[2] < COS_REACH) continue; // far away: no need to look closer
      /** @type {[RaDec, RaDec, RaDec, RaDec]} */
      const c = [[r[5], r[6]], [r[7], r[8]], [r[9], r[10]], [r[11], r[12]]];
      if (!inside(p, c, margin)) continue;
      out.push({ key: keyOf(r, m.wv), det: /** @type {Frame['det']} */ (r[3]), tmid: r[4], corners: c });
    }
    return out;
  }

  /**
   * CT-2. False while the tile of the position is not in `complete`: the frames listed may be only some of them.
   * @param {number} ra @param {number} dec @param {string} base
   */
  async function isIndexed(ra, dec, base) {
    const m = await meta(base);
    return (m.complete || []).includes(tileOf(ra, dec, m));
  }

  return { framesCovering, isIndexed, meta };
}

const shared = createIndex();

/** CT-2, with the global fetch. @type {(ra: number, dec: number, base: string, opt?: CoverOptions) => Promise<Frame[]>} */
export const framesCovering = shared.framesCovering;

/** CT-2, with the global fetch. @type {(ra: number, dec: number, base: string) => Promise<boolean>} */
export const isIndexed = shared.isIndexed;
