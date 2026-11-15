// Background, noise, co-add, resampling and difference (CT-7). Same rules, same numbers as pipeline/sx/stack.py.
//
// What changed in the co-add, and why. It used to keep a pixel only if it was valid in every photo of the visit, and
// "valid" counted every flag except FULLSAMPLE and SOURCE as a defect. Measured on real stamps that left 69% of the
// picture after one pair of photos, 20% after six and 13% after eight, so the main view would have been mostly
// empty. Two causes: flags that say nothing about the quality of a pixel (DICHROIC, PHANMISS) counted against it,
// and an intersection over many photos, each with its own empty corners, shrinks towards nothing. Now each photo may
// be used at a pixel if the value is finite and no bit of the saturation or defect tiers of flags.js is set (SOURCE,
// FULLSAMPLE, DICHROIC and PHANMISS never exclude); the co-add is the mean of the photos that may be used there,
// with their count `n`, and the pixel is shown when `n` reaches `need`, half of the photos (rounded up, at least 1).
// Two visits are compared only where both co-adds show the pixel.
//
// Arrays are flat, w*h values row by row with the first row at the lowest y, as in a Stamp. Everything is computed
// in float64 and stored as float32 where an array is returned.
//
// Flags (bits of the FLAGS extension of a frame, from its header): FULLSAMPLE = bit 12 ("pixel full sample history
// is available", set almost everywhere and not a defect) and SOURCE = bit 21 ("pixel mapped to a known source").
//
//   quiet  no flag other than FULLSAMPLE: the pixels that say what the sky background is.
//   valid  no flag other than FULLSAMPLE and SOURCE: the pixels that may be shown. A star is not a defect.
//
// Next to a bright star the SOURCE flag can cover the whole stamp. Background and noise are then taken over the valid
// pixels (the sigma-clipping drops the star): a stamp or co-add whose quiet pixels number fewer than MIN_PIXELS
// uses its valid pixels instead, and says so in `basis`.
import { CLIP_PASSES, CLIP_SIGMA, MAD_TO_SIGMA } from '../contracts.js';
import { DEFECT_MASK, SATURATION_MASK } from './flags.js';

export const FLAG_FULLSAMPLE = 1 << 12;
export const FLAG_SOURCE = 1 << 21;
/** Fewest pixels that background and noise are measured on. */
export const MIN_PIXELS = 100;

const NOT_FULLSAMPLE = ~FLAG_FULLSAMPLE;
const NOT_FULLSAMPLE_SOURCE = ~(FLAG_FULLSAMPLE | FLAG_SOURCE);
const UNUSABLE = SATURATION_MASK | DEFECT_MASK;

/**
 * A co-add, or a co-add on another grid.
 * @typedef {Object} Coadd
 * @property {number} w
 * @property {number} h
 * @property {Float32Array} data  MJy/sr, background subtracted; NaN where not shown.
 * @property {Uint8Array} valid  1 where the pixel is shown: `n` is at least `need`.
 * @property {Uint8Array} quiet  1 where the pixel is shown and every photo that was used there is quiet; the pixels the noise is measured on.
 * @property {Uint8Array} n  How many photos were used at each pixel.
 * @property {number} need  Photos required for a pixel to be shown: half of those used, rounded up, at least 1.
 * @property {number} photos  Photos used (the ones with a background).
 * @property {number} dropped  Stamps left out because they had no quiet pixel.
 * @property {number[]} background  Background subtracted from each stamp used, MJy/sr.
 * @property {number} noise  Robust noise of the co-add over its basis pixels, MJy/sr.
 * @property {'quiet' | 'valid'} basis  The pixels the noise was measured on: see basisMask.
 */

/**
 * The difference of two co-adds on one grid, later minus earlier.
 * @typedef {Object} Difference
 * @property {Float32Array} diff  MJy/sr.
 * @property {Float32Array} units  In noise units: diff / sigma.
 * @property {Uint8Array} valid  The pixels shown: valid in both.
 * @property {number} sigma  The noise of the difference, MJy/sr: the noise of the two sides added in quadrature.
 * @property {number} sigmaA
 * @property {number} sigmaB
 * @property {number} scatter  Robust noise of the difference itself over the same pixels, to compare with sigma.
 */

/**
 * 1 where the value is finite and the flag word has no bit other than FULLSAMPLE (all finite when flags is null).
 * @param {ArrayLike<number>} data @param {Int32Array | null} [flags]
 */
export function quietMask(data, flags = null) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isFinite(data[i]) && (flags === null || (flags[i] & NOT_FULLSAMPLE) === 0) ? 1 : 0;
  return out;
}

/**
 * 1 where the value is finite and the flag word has no bit other than FULLSAMPLE and SOURCE.
 * @param {ArrayLike<number>} data @param {Int32Array | null} [flags]
 */
export function validMask(data, flags = null) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isFinite(data[i]) && (flags === null || (flags[i] & NOT_FULLSAMPLE_SOURCE) === 0) ? 1 : 0;
  return out;
}

/**
 * 1 where the value is finite and the flag word has no bit of the saturation or defect tiers of flags.js (all
 * finite when flags is null): the pixels of a photo that may go into a co-add.
 * @param {ArrayLike<number>} data @param {Int32Array | null} [flags]
 */
export function usableMask(data, flags = null) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number.isFinite(data[i]) && (flags === null || (flags[i] & UNUSABLE) === 0) ? 1 : 0;
  return out;
}

/**
 * The pixels that background and noise are measured on: the quiet ones when there are MIN_PIXELS or more, else
 * the valid ones.
 * @param {Uint8Array} quiet @param {Uint8Array} valid
 * @returns {{mask: Uint8Array, basis: 'quiet' | 'valid'}}
 */
export function basisMask(quiet, valid) {
  let n = 0;
  for (let i = 0; i < quiet.length; i++) n += quiet[i];
  return n >= MIN_PIXELS ? { mask: quiet, basis: 'quiet' } : { mask: valid, basis: 'valid' };
}

/** @param {Float64Array} v  sorted in place; the median of the first n values */
function medianOf(v, n = v.length) {
  const s = v.subarray(0, n);
  s.sort();
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** @param {ArrayLike<number>} values  @returns {Float64Array} the finite values */
function finite(values) {
  const tmp = new Float64Array(values.length);
  let n = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) tmp[n++] = values[i];
  return tmp.slice(0, n);
}

/**
 * Sigma-clipped median: up to `passes` times, drop the values farther than `sigma` standard deviations from the
 * median (standard deviation of what is left), stopping when nothing is dropped. NaN when no value is left.
 * @param {ArrayLike<number>} values @param {number} [sigma] @param {number} [passes]
 */
export function clippedMedian(values, sigma = CLIP_SIGMA, passes = CLIP_PASSES) {
  let v = finite(values);
  for (let p = 0; p < passes; p++) {
    if (v.length === 0) break;
    const m = medianOf(v.slice());
    let mean = 0;
    for (let i = 0; i < v.length; i++) mean += v[i];
    mean /= v.length;
    let ss = 0;
    for (let i = 0; i < v.length; i++) ss += (v[i] - mean) * (v[i] - mean);
    const lim = sigma * Math.sqrt(ss / v.length);
    const keep = v.filter((x) => Math.abs(x - m) <= lim);
    if (keep.length === v.length) break;
    v = keep;
  }
  return v.length ? medianOf(v.slice()) : NaN;
}

/**
 * MAD_TO_SIGMA times the median absolute deviation from the median. NaN for no values.
 * @param {ArrayLike<number>} values
 */
export function robustNoise(values) {
  const v = finite(values);
  if (v.length === 0) return NaN;
  const m = medianOf(v.slice());
  for (let i = 0; i < v.length; i++) v[i] = Math.abs(v[i] - m);
  return MAD_TO_SIGMA * medianOf(v);
}

/**
 * Background and noise of one stamp. background is the sigma-clipped median of the quiet pixels (the valid ones
 * when quiet pixels number fewer than MIN_PIXELS; see the top of the file); noise is robustNoise of the stamp after
 * the background is subtracted. NaN and n = 0 when fewer than MIN_PIXELS pixels are left.
 * @param {ArrayLike<number>} data @param {Int32Array | null} [flags]
 * @returns {{background: number, noise: number, n: number, basis: 'quiet' | 'valid'}}
 */
export function stampStats(data, flags = null) {
  const { mask, basis } = basisMask(quietMask(data, flags), validMask(data, flags));
  const vals = where(data, mask);
  if (vals.length < MIN_PIXELS) return { background: NaN, noise: NaN, n: 0, basis };
  const background = clippedMedian(vals);
  return { background, noise: robustNoise(vals.map((x) => x - background)), n: vals.length, basis };
}

/**
 * Pixels of a mask-selected part of an array.
 * @param {ArrayLike<number>} data @param {ArrayLike<number>} mask
 */
function where(data, mask) {
  const out = [];
  for (let i = 0; i < data.length; i++) if (mask[i]) out.push(data[i]);
  return out;
}

/**
 * Mean of the stamps taken in one visit, each with its own background subtracted first, at each pixel over the
 * stamps that may be used there (usableMask). `n` counts them; the pixel is shown (`valid`) when `n` reaches `need`,
 * half of the stamps used rounded up and at least 1, and the value is NaN elsewhere. `quiet` is a shown pixel where
 * every stamp used is quiet.
 *
 * A stamp with too few pixels to measure a background on (see stampStats) is left out and counted in `dropped`.
 * @param {{data: ArrayLike<number>, flags: Int32Array | null}[]} stamps  All the same size, w*h values.
 * @param {number} w
 * @param {number} h
 * @returns {Coadd}
 */
export function coadd(stamps, w, h) {
  const len = w * h;
  const acc = new Float64Array(len);
  const count = new Uint8Array(len);
  const loud = new Uint8Array(len);
  /** @type {number[]} */
  const background = [];
  let dropped = 0;
  for (const s of stamps) {
    const st = stampStats(s.data, s.flags);
    if (st.n === 0) {
      dropped++;
      continue;
    }
    background.push(st.background);
    const u = usableMask(s.data, s.flags), q = quietMask(s.data, s.flags);
    for (let i = 0; i < len; i++) {
      if (!u[i]) continue;
      acc[i] = acc[i] + (s.data[i] - st.background);
      count[i]++;
      if (!q[i]) loud[i] = 1;
    }
  }
  const photos = background.length;
  const need = Math.max(1, Math.ceil(photos / 2));
  const data = new Float32Array(len).fill(NaN);
  if (photos === 0) return { w, h, data, valid: new Uint8Array(len), quiet: new Uint8Array(len), n: count, need, photos, dropped, background, noise: NaN, basis: 'valid' };
  const valid = new Uint8Array(len), quiet = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const m = acc[i] / count[i];
    if (count[i] >= need && Number.isFinite(m)) {
      valid[i] = 1;
      data[i] = m;
      quiet[i] = loud[i] ? 0 : 1;
    }
  }
  const { mask, basis } = basisMask(quiet, valid);
  return { w, h, data, valid, quiet, n: count, need, photos, dropped, background, noise: robustNoise(where(data, mask)), basis };
}

/**
 * Where each pixel (x, y) of a grid w by h falls in another image: x' = m0 x + m1 y + m2, y' = m3 x + m4 y + m5.
 * @param {number} w @param {number} h @param {ArrayLike<number>} m  Six numbers.
 * @returns {{x: Float64Array, y: Float64Array}}  w*h values each.
 */
export function affineMap(w, h, m) {
  const x = new Float64Array(w * h), y = new Float64Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      x[j * w + i] = m[0] * i + m[1] * j + m[2];
      y[j * w + i] = m[3] * i + m[4] * j + m[5];
    }
  }
  return { x, y };
}

/**
 * Bilinear interpolation of an image at the positions (mapX, mapY), given in pixels of `src` (0-based, whole
 * numbers at pixel centres). Returns data (float32) and ok (uint8) in the shape of the map.
 *
 * The value is the weighted mean of the four pixels around the position, the weights summing to 1: a surface
 * brightness (MJy/sr) stays a surface brightness, a flat sky stays flat, and for a pure shift the flux of an
 * object is conserved exactly (to its edge). Pixel areas are taken as equal, which holds between two frames of one
 * detector. A position outside the centres of the first and last pixel, or one that needs a pixel that is not ok
 * (not finite when `ok` is null), gives NaN and 0. A neighbour with weight exactly 0 is not looked at.
 * @param {ArrayLike<number>} src  w*h values.
 * @param {number} w
 * @param {number} h
 * @param {ArrayLike<number>} mapX
 * @param {ArrayLike<number>} mapY
 * @param {ArrayLike<number> | null} [ok]  1 where a source pixel may be used.
 * @returns {{data: Float32Array, ok: Uint8Array}}
 */
export function resample(src, w, h, mapX, mapY, ok = null) {
  const n = mapX.length;
  const data = new Float32Array(n).fill(NaN);
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const x = mapX[k], y = mapY[k];
    if (!(x >= 0 && x <= w - 1 && y >= 0 && y <= h - 1)) continue;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const nb = [
      [(1 - fx) * (1 - fy), y0 * w + x0],
      [fx * (1 - fy), y0 * w + x1],
      [(1 - fx) * fy, y1 * w + x0],
      [fx * fy, y1 * w + x1],
    ];
    let acc = 0, good = true;
    for (const [wt, idx] of nb) {
      if (wt === 0) continue;
      if (!(ok === null ? Number.isFinite(src[idx]) : ok[idx])) {
        good = false;
        break;
      }
      acc = acc + wt * src[idx];
    }
    if (good) {
      data[k] = acc;
      out[k] = 1;
    }
  }
  return { data, ok: out };
}

/**
 * A co-add on another grid: data, valid and quiet resampled by `resample`. Quiet is valid and quiet in every
 * pixel that took part. The count `n` is that of the pixel nearest to each position (halves round up). The noise is
 * measured again, on the new grid.
 * @param {Coadd} co  The co-add to resample.
 * @param {ArrayLike<number>} mapX  Positions in the pixels of `co`, one for each pixel of the new grid.
 * @param {ArrayLike<number>} mapY
 * @param {number} w  Width of the new grid.
 * @param {number} h
 * @returns {Coadd}
 */
export function resampleCoadd(co, mapX, mapY, w, h) {
  const a = resample(co.data, co.w, co.h, mapX, mapY, co.valid);
  const b = resample(co.data, co.w, co.h, mapX, mapY, co.quiet);
  const quiet = new Uint8Array(a.ok.length);
  for (let i = 0; i < quiet.length; i++) quiet[i] = b.ok[i] & a.ok[i];
  const { mask, basis } = basisMask(quiet, a.ok);
  const n = new Uint8Array(a.ok.length);
  for (let k = 0; k < n.length; k++) {
    if (!a.ok[k]) continue;
    const x = Math.floor(mapX[k] + 0.5), y = Math.floor(mapY[k] + 0.5);
    n[k] = co.n[Math.min(Math.max(y, 0), co.h - 1) * co.w + Math.min(Math.max(x, 0), co.w - 1)];
  }
  return {
    w, h, data: a.data, valid: a.ok, quiet, n, need: co.need, photos: co.photos, dropped: co.dropped, background: co.background,
    noise: robustNoise(where(a.data, mask)), basis,
  };
}

/**
 * b minus a, for two co-adds on one grid (b resampled onto the grid of a), a the earlier visit.
 *
 * The pixels shown are those that both co-adds show. The noise of each side is robustNoise of its co-add
 * over the pixels that are quiet in both (the shown ones when those number fewer than MIN_PIXELS); sigma is the two
 * added in quadrature, and units = diff / sigma. scatter is robustNoise of the difference over the same pixels, to
 * compare with sigma.
 * @param {Coadd} a
 * @param {Coadd} b
 * @returns {Difference}
 */
export function difference(a, b) {
  const n = a.data.length;
  const ok = new Uint8Array(n), both = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    ok[i] = a.valid[i] && b.valid[i] && Number.isFinite(a.data[i]) && Number.isFinite(b.data[i]) ? 1 : 0;
    both[i] = a.quiet[i] && b.quiet[i] && ok[i] ? 1 : 0;
  }
  const q = basisMask(both, ok).mask;
  const sigmaA = robustNoise(where(a.data, q)), sigmaB = robustNoise(where(b.data, q));
  const sigma = Math.sqrt(sigmaA * sigmaA + sigmaB * sigmaB);
  const diff = new Float32Array(n).fill(NaN), units = new Float32Array(n).fill(NaN);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    d[i] = b.data[i] - a.data[i];
    if (ok[i]) {
      diff[i] = d[i];
      units[i] = d[i] / sigma;
    }
  }
  return { diff, units, valid: ok, sigma, sigmaA, sigmaB, scatter: robustNoise(where(d, q)) };
}
