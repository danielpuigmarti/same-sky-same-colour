// The match rule (CT-6). Same rule, same output as pipeline/sx/match.py; tests/vectors/match.json holds the cases.
//
// Two lists of frames, one for each visit, are paired so that the two frames of a pair were taken at the same
// colour: same detector, one to one, the closest colours first, accepted when the colours at the target pixel differ
// by at most MATCH_BANDWIDTH_FRACTION of the smaller of the two bandwidths, and at most MATCH_MAX_PAIRS pairs.
/** @import { Matchable, Pair } from '../contracts.js' */
import { MATCH_BANDWIDTH_FRACTION, MATCH_MAX_PAIRS } from '../contracts.js';

/** In detector 1 the rows below this have background structure that changes between visits. */
export const BAD_ROWS_D1_BELOW = 150;
/** The same, in detector 2, for the rows above this. */
export const BAD_ROWS_D2_ABOVE = 1960;

/**
 * A Matchable may also say where its stamp lies: `y0`, the full-frame row of its first row, and `h`, its rows.
 * @typedef {Matchable & {y0?: number, h?: number}} Candidate
 */

/**
 * True when a stamp of h rows starting at full-frame row y0 reaches the rows that are never used.
 * @param {number} det @param {number} y0 @param {number} h
 */
export function reachesBadRows(det, y0, h) {
  if (det === 1) return y0 < BAD_ROWS_D1_BELOW;
  if (det === 2) return y0 + h - 1 > BAD_ROWS_D2_ABOVE;
  return false;
}

/** A frame can be paired unless its stamp (`y0` and `h`, when given) reaches the unused rows of its detector. @param {Candidate} m */
export function usable(m) {
  if (m.y0 === undefined || m.h === undefined) return true;
  return !reachesBadRows(m.det, m.y0, m.h);
}

/**
 * Pairs [position in a, position in b], the closest colours first.
 * @param {Candidate[]} a
 * @param {Candidate[]} b
 * @returns {Pair[]}
 */
export function matchPairs(a, b) {
  /** @type {[number, number, number][]} */
  const cand = [];
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    if (!usable(p)) continue;
    for (let j = 0; j < b.length; j++) {
      const q = b[j];
      if (p.det !== q.det || !usable(q)) continue;
      const d = Math.abs(p.lam - q.lam);
      if (d <= MATCH_BANDWIDTH_FRACTION * Math.min(p.bw, q.bw)) cand.push([d, i, j]);
    }
  }
  cand.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const usedA = new Set(), usedB = new Set();
  /** @type {Pair[]} */
  const out = [];
  for (const [, i, j] of cand) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    out.push([i, j]);
    if (out.length === MATCH_MAX_PAIRS) break;
  }
  return out;
}

/**
 * The pixels that are within tolerance in every pair: 1 = matched, 0 = veiled.
 *
 * `maps` has one entry for each pair, with four arrays of the same length n (one value for each pixel of the grid
 * that is being compared): lamA and bwA, the colour and bandwidth of the first frame of the pair there; lamB and
 * bwB, the same for the second frame at the same place on the sky. A pixel is within tolerance in a pair when
 * |lamA - lamB| <= MATCH_BANDWIDTH_FRACTION * min(bwA, bwB); a missing value (NaN) is never within tolerance.
 * Without pairs nothing is matched.
 * @param {{lamA: ArrayLike<number>, bwA: ArrayLike<number>, lamB: ArrayLike<number>, bwB: ArrayLike<number>}[]} maps
 * @param {number} [n]  Number of pixels; needed only when there are no pairs.
 * @returns {Uint8Array}
 */
export function matchedMask(maps, n) {
  const len = n ?? (maps.length ? maps[0].lamA.length : 0);
  const out = new Uint8Array(len).fill(maps.length ? 1 : 0);
  for (const m of maps) {
    for (let k = 0; k < len; k++) {
      if (!out[k]) continue;
      if (!(Math.abs(m.lamA[k] - m.lamB[k]) <= MATCH_BANDWIDTH_FRACTION * Math.min(m.bwA[k], m.bwB[k]))) out[k] = 0;
    }
  }
  return out;
}
