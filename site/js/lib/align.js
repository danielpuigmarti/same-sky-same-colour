// Alignment check (E4): how far two co-adds of one field are from each other, measured on the field's stars.
//
// For each bright, unflagged star of the first co-add, a small box around it is compared with the second co-add at
// shifts of a fraction of a pixel (cross-correlation, with the second image read between its pixels by cubic
// convolution); the shift where the two agree best is that star's shift. The answer is the median over the stars.
// A shift is the position of a feature in the second image minus its position in the first, in pixels, x then y.
import { robustNoise } from './stack.js';

/** A shift above this, in pixels, is a warning. */
export const ALIGN_WARN_PX = 0.3;
/** A star is a local maximum above this many times the noise. */
const PEAK_SIGMA = 8;
/** Half the side of the box around a star, pixels. */
const HALF_BOX = 4;
/** The largest shift looked for, pixels. */
const SEARCH = 3;
/** At most this many stars, the brightest first. */
const MAX_STARS = 20;

/**
 * What alignment reads from a co-add: the fields of a Coadd it needs.
 * @typedef {Object} AlignInput
 * @property {number} w
 * @property {number} h
 * @property {ArrayLike<number>} data  Background subtracted; NaN where not valid.
 * @property {ArrayLike<number>} valid  1 where the value may be used.
 */

/**
 * @typedef {Object} Alignment
 * @property {number | null} dx  Shift in x, pixels; null when no star could be used.
 * @property {number | null} dy
 * @property {number} n  Number of stars used.
 * @property {boolean} warn  The shift is above ALIGN_WARN_PX.
 * @property {number | null} scatter  Spread of the stars' shifts (robust, pixels), null with fewer than 3 stars.
 * @property {{x: number, y: number, dx: number, dy: number, peak: number}[]} stars  Each star used: where it is in the first image, its shift, its peak in noise units.
 */

/**
 * Cubic convolution (Keys, a = -0.5) weights for a fraction t of a pixel.
 * @param {number} t @returns {[number, number, number, number]}
 */
function cubic(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/**
 * Normalised cross-correlation of a reference box with the second image shifted by (sx, sy), over the pixels of
 * `use` (1 = may be used), whose values in `ref` are already zero elsewhere.
 * @param {Float64Array} ref  Box values, side 2*HALF_BOX+1, row by row, zero where not used.
 * @param {Uint8Array} use  The same box: 1 where the pixel counts.
 * @param {number} refNorm
 * @param {Float64Array} img  The second image, zero where invalid.
 * @param {number} w @param {number} h
 * @param {number} cx @param {number} cy  Centre of the box, whole pixels.
 * @param {number} sx @param {number} sy
 */
function correlate(ref, use, refNorm, img, w, h, cx, cy, sx, sy) {
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const wx = cubic(sx - ix), wy = cubic(sy - iy);
  const side = 2 * HALF_BOX + 1;
  let dot = 0, nn = 0;
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      if (!use[j * side + i]) continue;
      const x = cx - HALF_BOX + i + ix, y = cy - HALF_BOX + j + iy;
      let v = 0;
      for (let q = 0; q < 4; q++) {
        const yy = y - 1 + q;
        if (yy < 0 || yy >= h) return NaN;
        let row = 0;
        for (let p = 0; p < 4; p++) {
          const xx = x - 1 + p;
          if (xx < 0 || xx >= w) return NaN;
          row += wx[p] * img[yy * w + xx];
        }
        v += wy[q] * row;
      }
      dot += ref[j * side + i] * v;
      nn += v * v;
    }
  }
  return nn > 0 && refNorm > 0 ? dot / (refNorm * Math.sqrt(nn)) : NaN;
}

/**
 * The shift of one star: coarse search over whole pixels, then finer and finer around the best.
 * @param {Float64Array} ref @param {Uint8Array} use @param {number} refNorm
 * @param {Float64Array} img @param {number} w @param {number} h @param {number} cx @param {number} cy
 * @returns {[number, number] | null}
 */
function starShift(ref, use, refNorm, img, w, h, cx, cy) {
  let bx = 0, by = 0, best = -Infinity;
  for (let sy = -SEARCH; sy <= SEARCH; sy++) {
    for (let sx = -SEARCH; sx <= SEARCH; sx++) {
      const c = correlate(ref, use, refNorm, img, w, h, cx, cy, sx, sy);
      if (c > best) { best = c; bx = sx; by = sy; }
    }
  }
  if (!(best > -Infinity)) return null;
  for (const step of [0.25, 0.0625, 0.015625]) {
    const cx0 = bx, cy0 = by;
    for (let j = -4; j <= 4; j++) {
      for (let i = -4; i <= 4; i++) {
        const sx = cx0 + i * step, sy = cy0 + j * step;
        const c = correlate(ref, use, refNorm, img, w, h, cx, cy, sx, sy);
        if (c > best) { best = c; bx = sx; by = sy; }
      }
    }
  }
  return [bx, by];
}

/** @param {number[]} v */
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/**
 * 1 where a pixel and its eight neighbours are all usable.
 * @param {Uint8Array} ok @param {number} w @param {number} h
 */
function erode(ok, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let j = -1; j <= 1 && all; j++) for (let i = -1; i <= 1; i++) if (!ok[(y + j) * w + x + i]) { all = 0; break; }
      out[y * w + x] = all;
    }
  }
  return out;
}

/**
 * Measure the shift between two co-adds on one grid (the same size) from the stars in them.
 *
 * Pixels that are not valid in both images, or next to one that is not, are left out of the comparison; a star
 * with a flagged core (a saturated star) is therefore compared by its wings. A star needs at least half of its
 * box to be left.
 * @param {AlignInput} a  The first co-add.
 * @param {AlignInput} b  The second, to be compared with it.
 * @returns {Alignment}
 */
export function alignShift(a, b) {
  const { w, h } = a;
  const n = w * h;
  const margin = HALF_BOX + SEARCH + 3;
  const A = new Float64Array(n), B = new Float64Array(n), okA = new Uint8Array(n), okBoth = new Uint8Array(n);
  /** @type {number[]} */
  const usable = [];
  for (let i = 0; i < n; i++) {
    const va = a.valid[i] && Number.isFinite(a.data[i]), vb = b.valid[i] && Number.isFinite(b.data[i]);
    okA[i] = va ? 1 : 0;
    okBoth[i] = va && vb ? 1 : 0;
    if (va) usable.push(a.data[i]);
  }
  const sigma = robustNoise(usable);
  const med = median(usable);
  if (!(sigma > 0)) return { dx: null, dy: null, n: 0, warn: false, scatter: null, stars: [] };
  for (let i = 0; i < n; i++) {
    A[i] = okA[i] ? a.data[i] - med : 0;
    B[i] = b.valid[i] && Number.isFinite(b.data[i]) ? b.data[i] - med : 0;
  }
  const use = erode(okBoth, w, h);
  /** @type {{x: number, y: number, peak: number}[]} */
  const found = [];
  const side = 2 * HALF_BOX + 1;
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const v = A[y * w + x];
      if (!okA[y * w + x] || !(v > PEAK_SIGMA * sigma)) continue;
      let top = true;
      for (let j = -1; j <= 1 && top; j++) for (let i = -1; i <= 1; i++) if ((i || j) && A[(y + j) * w + x + i] > v) top = false;
      if (!top) continue;
      let left = 0;
      for (let j = -HALF_BOX; j <= HALF_BOX; j++) for (let i = -HALF_BOX; i <= HALF_BOX; i++) left += use[(y + j) * w + x + i];
      if (left * 2 >= side * side) found.push({ x, y, peak: v / sigma });
    }
  }
  found.sort((p, q) => q.peak - p.peak || p.y - q.y || p.x - q.x);
  // one star at a time: a brighter star within a box of another takes it over
  /** @type {typeof found} */
  const stars = [];
  for (const f of found) {
    if (stars.length === MAX_STARS) break;
    if (stars.every((s) => Math.max(Math.abs(s.x - f.x), Math.abs(s.y - f.y)) > 2 * HALF_BOX)) stars.push(f);
  }
  /** @type {Alignment['stars']} */
  const used = [];
  for (const s of stars) {
    const ref = new Float64Array(side * side), box = new Uint8Array(side * side);
    let nn = 0;
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const k = (s.y - HALF_BOX + j) * w + s.x - HALF_BOX + i;
        if (!use[k]) continue;
        box[j * side + i] = 1;
        ref[j * side + i] = A[k];
        nn += A[k] * A[k];
      }
    }
    const r = starShift(ref, box, Math.sqrt(nn), B, w, h, s.x, s.y);
    if (r) used.push({ x: s.x, y: s.y, dx: r[0], dy: r[1], peak: s.peak });
  }
  if (used.length === 0) return { dx: null, dy: null, n: 0, warn: false, scatter: null, stars: [] };
  const dx = median(used.map((s) => s.dx)), dy = median(used.map((s) => s.dy));
  const scatter = used.length >= 3 ? robustNoise([...used.map((s) => s.dx - dx), ...used.map((s) => s.dy - dy)]) : null;
  return { dx, dy, n: used.length, warn: Math.hypot(dx, dy) > ALIGN_WARN_PX, scatter, stars: used };
}
