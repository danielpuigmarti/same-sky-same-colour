// From the stamps of two visits to what the stage draws.
//
// The matched pairs of two visits come in as stamps with their sky (CT-4): photos read live, in the orientation of
// the detector, or the stamps of a showcase that is already on the display grid. Out go, all on the display grid
// (display.js), centred on the target:
//   - for each visit, the co-add of its photos (stack.js: coadd), each photo put on the grid by nearest neighbour.
//     No pixel of these two pictures is interpolated. The two visits are compared only where both co-adds show a
//     pixel; everywhere else both pictures have no data;
//   - the veil: the pixels where the colours of the two photos of some pair differ by more than the match rule
//     allows (match.js: matchedMask), from the wavelength of the detector pixel behind each pixel of the grid;
//   - how well the two visits line up, measured on the stars of the field (align.js: alignShift). For this the
//     photos are read between their pixels (stack.js: resample), each without its own background, so that the
//     half pixel by which nearest neighbour may misplace a photo does not pass for a misalignment. The line that
//     says it gives a number only when most of the stars agree on it: the target itself when it moves, and the
//     glare of a saturated star, are not stars of the field;
//   - when asked for, the difference, later minus earlier, in units of the noise (stack.js: difference), from the
//     same interpolated co-adds, over the pixels matched in every pair;
//   - every matched pair on its own, on the same grid, for stepping.
// Nothing here has a rule of its own for background, noise, co-adding, matching or alignment, and nothing touches
// a page.

/** @import { Stamp, Det, Wavelength, LocalSky } from '../contracts.js' */
/** @import { Picture, DifferencePicture, StageView } from '../ui/stage.js' */
/** @import { Alignment } from './align.js' */
/** @import { Coadd } from './stack.js' */
/** @import { GridStamp } from './display.js' */
import { DIFF_RANGE } from '../contracts.js';
import { DISPLAY_SIZE, toDisplayGrid, sourceMap, cropSquare, gridSky } from './display.js';
import { coadd, difference, resample, stampStats, usableMask, quietMask, FLAG_SOURCE, MIN_PIXELS } from './stack.js';
import { matchedMask } from './match.js';
import { alignShift, ALIGN_WARN_PX } from './align.js';
import { SATURATION_MASK, DEFECT_MASK, SOURCE_MASK } from './flags.js';

/** Something at the target stands out when a co-add reaches this many times its noise within a pixel of it. */
export const STANDS_OUT_UNITS = 3;
/** A target is too bright when, in at least this share of its photos, a pixel next to it is saturated or has no value. */
export const TOO_BRIGHT_SHARE = 0.5;

const HATCHED = SATURATION_MASK | DEFECT_MASK;

/**
 * What the pictures say about the position, for the plain messages of the page. None of them is a measurement.
 * @typedef {Object} Signs
 * @property {boolean} tooBright  The target fills its pixels in most photos.
 * @property {boolean} tooFaint  Nothing within a pixel of the target stands out from the noise of either co-add.
 * @property {boolean} quiet  A difference was made, and no pixel of it reaches the full scale (DIFF_RANGE times the noise).
 */

/**
 * @typedef {Object} Composed
 * @property {StageView} view  The two co-adds with the veil, the line about the alignment and, when asked for, the difference.
 * @property {[Picture, Picture][]} singles  Every pair on its own, on the display grid, in the order given.
 * @property {GridStamp[]} photos  Every photo on the display grid: the two of the first pair, then the two of the next.
 * @property {Alignment | null} align  Null when the photos could not be added up.
 * @property {Signs} signs
 * @property {number} size  Side of the pictures.
 * @property {number} pairs  Pairs that were added up.
 * @property {number} shown  Pixels that both co-adds show.
 * @property {number | null} sigma  The noise one unit of the difference stands for, MJy/sr; null without a difference.
 */

/**
 * One photo, ready to be added up.
 * @typedef {Object} Plane
 * @property {Stamp} stamp
 * @property {GridStamp} grid  On the work grid, nearest neighbour.
 * @property {Float64Array} lam  Colour of each pixel of the work grid, µm; NaN outside the stamp.
 * @property {Float64Array} bw
 * @property {{data: Float32Array, flags: Int32Array}} smooth  Without its background, read between the pixels.
 */

/**
 * @param {Stamp} stamp @param {number} work
 * @param {((det: Det, x: number, y: number) => Wavelength) | null} wavelengthAt
 * @returns {Plane | null}  Null for a stamp too empty to measure a background on.
 */
function planeOf(stamp, work, wavelengthAt) {
  const stats = stampStats(stamp.data, stamp.flags);
  if (stats.n === 0 || !stamp.sky) return null;
  const n = work * work, grid = toDisplayGrid(stamp, work);
  const lam = new Float64Array(n).fill(NaN), bw = new Float64Array(n).fill(NaN);
  if (wavelengthAt) {
    for (let k = 0; k < n; k++) {
      if (grid.sx[k] < 0) continue;
      const c = wavelengthAt(stamp.det, stamp.x0 + grid.sx[k], stamp.y0 + grid.sy[k]);
      lam[k] = c.lam;
      bw[k] = c.bw;
    }
  }
  const flat = Float64Array.from(stamp.data, (v) => v - stats.background);
  const at = sourceMap(stamp.sky, stamp.tx, stamp.ty, work);
  const used = resample(flat, stamp.w, stamp.h, at.x, at.y, usableMask(stamp.data, stamp.flags));
  const quiet = resample(flat, stamp.w, stamp.h, at.x, at.y, quietMask(stamp.data, stamp.flags));
  // in the form coadd reads: a quiet pixel carries no flag, a pixel that may be used but is not quiet carries
  // SOURCE, any other pixel carries a flag that leaves it out
  const flags = new Int32Array(n);
  for (let k = 0; k < n; k++) flags[k] = used.ok[k] ? (quiet.ok[k] ? 0 : FLAG_SOURCE) : 1;
  return { stamp, grid, lam, bw, smooth: { data: used.data, flags } };
}

/**
 * The pixels of the work grid where the colours of a pair are the same (match.js). A pixel that lies outside one
 * of the two photos has no colour to compare and is left to the co-add: it counts as matched here.
 * @param {[Plane, Plane][]} pairs @param {number} n
 * @returns {Uint8Array}
 */
function veilOf(pairs, n) {
  return matchedMask(pairs.map(([a, b]) => {
    const lamA = a.lam.slice(), bwA = a.bw.slice(), lamB = b.lam.slice(), bwB = b.bw.slice();
    for (let k = 0; k < n; k++) {
      if (a.grid.sx[k] >= 0 && b.grid.sx[k] >= 0) continue;
      lamA[k] = lamB[k] = 0;
      bwA[k] = bwB[k] = 1;
    }
    return { lamA, bwA, lamB, bwB };
  }), n);
}

/** A co-add that counts only the pixels of `keep`. @param {Coadd} co @param {Uint8Array} keep @returns {Coadd} */
function restrict(co, keep) {
  return { ...co, valid: co.valid.map((v, k) => v & keep[k]), quiet: co.quiet.map((v, k) => v & keep[k]) };
}

/**
 * True when the target of a stamp fills its pixels: a pixel within one pixel of it has no value or a flag of
 * saturation.
 * @param {Stamp} s
 */
export function saturatedAtTarget(s) {
  const cx = Math.floor(s.tx + 0.5), cy = Math.floor(s.ty + 0.5);
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      const k = y * s.w + x;
      if (!Number.isFinite(s.data[k]) || (s.flags !== null && (s.flags[k] & SATURATION_MASK) !== 0)) return true;
    }
  }
  return false;
}

/**
 * The largest value within one pixel of the middle of a co-add, in units of its noise. NaN when it has none there.
 * @param {Coadd} co
 */
function peakAtTarget(co) {
  const c = Math.floor(co.w / 2);
  let best = NaN;
  for (let y = c - 1; y <= c + 1; y++) {
    for (let x = c - 1; x <= c + 1; x++) {
      const v = co.data[y * co.w + x] / co.noise;
      if (Number.isFinite(v) && !(v <= best)) best = v;
    }
  }
  return best;
}

/**
 * Whether the stars of an alignment agree: more than half of them lie within ALIGN_WARN_PX of the shift they give
 * together. Where they do not, what was measured is not the stars of the field: around a saturated star the
 * brightest places are its glare, which turns with the detector.
 * @param {Alignment} a
 */
export function starsAgree(a) {
  const { dx, dy } = a;
  if (dx === null || dy === null || !a.stars.length) return false;
  return a.stars.filter((s) => Math.hypot(s.dx - dx, s.dy - dy) <= ALIGN_WARN_PX).length * 2 > a.stars.length;
}

/**
 * The line under the pictures: how well the two visits line up.
 * @param {Alignment} a
 * @returns {string}
 */
export function alignText(a) {
  if (a.dx === null || a.dy === null || a.n === 0) return 'No star in this patch is bright enough to check how well the two visits line up.';
  const shift = Math.hypot(a.dx, a.dy), stars = `${a.n} ${a.n === 1 ? 'star' : 'stars'}`;
  if (!starsAgree(a)) return `The ${a.n} brightest places of this patch do not agree on how the two visits line up, so that cannot be checked here.`;
  if (a.warn) return `Warning: the two visits are ${shift.toFixed(2)} px apart (${stars}), more than ${ALIGN_WARN_PX} px. A steady star then seems to shift.`;
  return `Photos aligned to ${shift.toFixed(2)} px (${stars}).`;
}

/**
 * Put the matched pairs of two visits together.
 * @param {[Stamp, Stamp][]} pairs  Each pair: the photo of the earlier visit, then its match of the later one. Stamps with `sky`.
 * @param {{wavelengthAt?: ((det: Det, x: number, y: number) => Wavelength) | null, size?: number, difference?: boolean}} [using]
 *   `wavelengthAt` (CT-3) gives the veil; without it there is none. `size` is the side of the pictures (default
 *   DISPLAY_SIZE). `difference`: also make the difference picture (default false).
 * @returns {Composed | null}  Null when there is no pair, or a stamp has no sky: such stamps cannot be lined up.
 */
export function compose(pairs, { wavelengthAt = null, size = DISPLAY_SIZE, difference: wantDifference = false } = {}) {
  if (!pairs.length || pairs.some(([a, b]) => !a.sky || !b.sky)) return null;
  const all = pairs.flat();
  const work = Math.max(size, ...all.map((s) => Math.max(s.w, s.h)));
  const n = work * work, mid = Math.floor(size / 2);
  const sky = gridSky(/** @type {LocalSky} */ (pairs[0][0].sky));
  /** @template {Float32Array | Int32Array | Uint8Array} T @param {T} values @returns {T} */
  const crop = (values) => cropSquare(values, work, size);

  /** @type {[Plane | null, Plane | null][]} */
  const planes = pairs.map(([a, b]) => [planeOf(a, work, wavelengthAt), planeOf(b, work, wavelengthAt)]);

  // every pair on its own: the photos as they are, on the grid
  /** @param {Stamp} stamp @param {Uint8Array | null} matched @returns {Picture} */
  const single = (stamp, matched) => {
    const g = toDisplayGrid(stamp, size);
    return { ...g, matched, blank: Uint8Array.from(g.sx, (v) => (v < 0 ? 1 : 0)) };
  };
  /** @type {[Picture, Picture][]} */
  const singles = pairs.map(([a, b], k) => {
    const [pa, pb] = planes[k], matched = pa && pb && wavelengthAt ? crop(veilOf([[pa, pb]], n)) : null;
    return [single(a, matched), single(b, matched)];
  });
  const photos = /** @type {GridStamp[]} */ (/** @type {unknown} */ (singles.flat()));

  const saturated = all.filter(saturatedAtTarget).length;
  /** @type {Signs} */
  const signs = { tooBright: saturated >= all.length * TOO_BRIGHT_SHARE, tooFaint: false, quiet: false };

  /** The pairs whose two photos can be added up, as positions in `pairs`. */
  const goodAt = planes.map(([a, b], k) => (a && b ? k : -1)).filter((k) => k >= 0);
  const good = /** @type {[Plane, Plane][]} */ (goodAt.map((k) => planes[k]));
  if (!good.length) {
    // too little of these stamps is left to measure a background on: the first pair is shown as it is
    const note = 'Too few pixels of these photos can be measured to add them up; one pair is shown as it is.';
    return { view: { a: singles[0][0], b: singles[0][1], diff: null, note }, singles, photos, align: null, signs, size, pairs: 0, shown: 0, sigma: null };
  }

  const matched = wavelengthAt ? veilOf(good, n) : null;
  /** The veil as the pictures carry it: one array for the three of them. */
  const veil = matched ? crop(matched) : null;
  const sides = /** @type {[Plane[], Plane[]]} */ ([good.map(([p]) => p), good.map(([, p]) => p)]);
  const coadds = sides.map((side) => coadd(side.map((p) => ({ data: p.grid.data, flags: p.grid.flags })), work, work));
  // the two visits are compared only where both co-adds show the pixel
  const both = coadds[0].valid.map((v, k) => v & coadds[1].valid[k]);

  /**
   * One visit as a picture: the co-add of its photos as they are on the grid.
   * @param {0 | 1} which  0 for the earlier visit, 1 for the later one.
   * @returns {Picture}
   */
  const visit = (which) => {
    const side = sides[which], co = coadds[which];
    const haveFlags = side.every((p) => p.grid.flags !== null);
    const data = new Float32Array(n).fill(NaN), flags = new Int32Array(n), blank = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      let word = 0, missing = false;
      for (const p of side) {
        if (p.grid.flags) word |= p.grid.flags[k];
        if (p.grid.sx[k] >= 0 && !Number.isFinite(p.grid.data[k])) missing = true;
      }
      if (both[k]) {
        // a pixel that is shown has a value from photos that could be used there: what a photo that was left out
        // was flagged with is not drawn on it; a known source may still be marked
        data[k] = co.data[k];
        flags[k] = word & SOURCE_MASK;
        continue;
      }
      // no data here. When this visit itself has no value, the flags of its photos say why and are drawn; a pixel
      // whose photos have no value and no flag to explain it is the heart of a star that filled its pixel
      if (!co.valid[k]) flags[k] = word & HATCHED;
      if (co.valid[k] || flags[k] !== 0 || !missing) blank[k] = 1;
    }
    const one = side.length === 1 ? side[0] : null, first = side.reduce((p, q) => (q.stamp.mjd < p.stamp.mjd ? q : p));
    return {
      key: one ? one.stamp.key : '', det: first.stamp.det, mjd: first.stamp.mjd, w: size, h: size,
      x0: one ? one.stamp.x0 : NaN, y0: one ? one.stamp.y0 : NaN, tx: mid, ty: mid,
      lam: one ? one.stamp.lam : NaN, bw: one ? one.stamp.bw : NaN,
      data: crop(data), flags: haveFlags ? crop(flags) : null, sky, matched: veil,
      photos: side.length, blank: crop(blank),
      ...(one ? { sx: crop(one.grid.sx), sy: crop(one.grid.sy), sw: one.stamp.w, sh: one.stamp.h } : {}),
      members: goodAt.map((k) => singles[k][which]),
    };
  };
  const a = visit(0), b = visit(1);
  let shown = 0;
  for (const v of crop(both)) shown += v;

  // the alignment, and the difference when it is asked for: co-adds of the photos read between their pixels
  const smoothA = coadd(sides[0].map((p) => p.smooth), work, work), smoothB = coadd(sides[1].map((p) => p.smooth), work, work);
  const align = alignShift(smoothA, smoothB);
  const peaks = [peakAtTarget(smoothA), peakAtTarget(smoothB)];
  signs.tooFaint = !signs.tooBright && peaks.every((p) => Number.isFinite(p) && p < STANDS_OUT_UNITS);

  /** @type {DifferencePicture | null} */
  let diff = null;
  /** @type {number | null} */
  let sigma = null;
  if (wantDifference) {
    const keep = matched ?? new Uint8Array(n).fill(1);
    const d = difference(restrict(smoothA, keep), restrict(smoothB, keep));
    const units = crop(d.units), compared = crop(d.valid);
    let count = 0, largest = 0;
    for (let k = 0; k < units.length; k++) {
      if (!compared[k]) continue;
      count++;
      largest = Math.max(largest, Math.abs(units[k]));
    }
    if (Number.isFinite(d.sigma) && d.sigma > 0 && count >= MIN_PIXELS) {
      sigma = d.sigma;
      signs.quiet = largest < DIFF_RANGE;
      // a pixel that is not compared because it is veiled, or because a visit has no data there, needs no other mark
      diff = { w: size, h: size, data: units, tx: mid, ty: mid, sigma, sky, matched: veil, blank: compared.map((v) => (v ? 0 : 1)) };
    }
  }

  return { view: { a, b, diff, note: alignText(align) }, singles, photos, align, signs, size, pairs: good.length, shown, sigma };
}
