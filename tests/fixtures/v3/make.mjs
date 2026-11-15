// Pictures made by hand for the tests of the panels (V3): stamps on the display grid with a known sky, a known blip, and flags
// put where the test wants them, so that every answer has a value that is known in advance. A seeded generator makes
// the noise, so a run gives the same numbers every time.
//
// A field has two visits of six photos each. The photos of the two visits are at matched colours (the match rule pairs
// them one to one), and every photo is 64 by 64 pixels with the target at its middle.

export const PIXEL_DEG = 6.15 / 3600;
export const SIZE = 64;
export const FULLSAMPLE = 1 << 12;
export const BIT = { OVERFLOW: 1, PERSIST: 17, SOURCE: 21, GHOST: 22 };

/** A small seeded generator: numbers in [0, 1). @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal noise from the generator. @param {() => number} r */
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** The sky of a display-grid picture: north up, east to the left, 6.15 arcsec a pixel. @param {number} ra @param {number} dec */
export const gridSky = (ra, dec) => ({ ra, dec, cd: /** @type {[number, number, number, number]} */ ([-PIXEL_DEG, 0, 0, PIXEL_DEG]) });

/** The bucket key of a photo of the test field. @param {number} n @param {string} [week] @param {number} [det] */
export const keyOf = (n, week = '2025W35_1A', det = 5) => `dr1/level2/${week}/l2b-v27-2026-230/${det}/level2_${week}_${String(n).padStart(4, '0')}_${(n % 4) + 1}D${det}_spx_l2b-v27-2026-230.fits`;

/**
 * One photo.
 * @param {Object} o
 * @param {string} o.key @param {number} o.mjd @param {number} o.lam @param {number} [o.bw] @param {number} [o.det]
 * @param {ReturnType<typeof gridSky>} o.sky
 * @param {{x: number, y: number, peak: number, sigma?: number}[]} [o.blips]  Gaussian sources.
 * @param {{x: number, y: number, bit: number, r?: number}[]} [o.flags]  A flag on the pixels within r (default 1.5) of a place.
 * @param {number} [o.seed] @param {number} [o.noise] @param {number} [o.bg]
 */
export function makeStamp({ key, mjd, lam, bw = 0.037, det = 5, sky, blips = [], flags = [], seed = 1, noise = 1, bg = 100 }) {
  const r = rng(seed), n = SIZE * SIZE;
  const data = new Float32Array(n), word = new Int32Array(n).fill(FULLSAMPLE);
  const level = bg * (1 + 0.05 * (r() - 0.5));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = level + noise * normal(r);
      for (const b of blips) v += b.peak * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * (b.sigma ?? 1.1) ** 2));
      data[y * SIZE + x] = v;
    }
  }
  for (const f of flags) {
    const rad = f.r ?? 1.5;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (Math.hypot(x - f.x, y - f.y) <= rad) word[y * SIZE + x] |= 1 << f.bit;
  }
  return { key, det, mjd, w: SIZE, h: SIZE, x0: 100, y0: 100, tx: SIZE / 2, ty: SIZE / 2, lam, bw, data, flags: word, sky };
}

/**
 * The two visits of a field: six photos each, at colours 4.20 to 4.50 µm, 150 days apart.
 * `shape(visit, k)` gives the extra of the photo k of a visit: {blips, flags}.
 * @param {Object} o
 * @param {ReturnType<typeof gridSky>} [o.sky]
 * @param {(visit: number, k: number, mjd: number) => {blips?: any[], flags?: any[]}} [o.shape]
 * @param {number} [o.mjdA] @param {number} [o.mjdB]
 */
export function makeField({ sky = gridSky(269.44, 4.77), shape = () => ({}), mjdA = 60900, mjdB = 61050 } = {}) {
  /** @type {ReturnType<typeof makeStamp>[]} */
  const stamps = [];
  for (let visit = 0; visit < 2; visit++) {
    for (let k = 0; k < 6; k++) {
      const n = visit * 6 + k;
      const mjd = (visit ? mjdB : mjdA) + k * 0.004;
      stamps.push(makeStamp({ key: keyOf(100 + n, visit ? '2026W11_2A' : '2025W35_1A'), mjd, lam: 4.2 + 0.06 * k + (visit ? 0.002 : 0), sky, seed: 10 + n, ...shape(visit, k, mjd) }));
    }
  }
  const frames = stamps.map((s, i) => ({ key: s.key, det: s.det, mjd: s.mjd, lam: s.lam, bw: s.bw, visit: i < 6 ? 0 : 1, loaded: true, flagged: false }));
  return { sky, stamps, frames };
}
