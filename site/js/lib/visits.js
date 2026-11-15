// The visit rule (CT-5). Same rule, same output as pipeline/sx/visits.py; tests/vectors/visits.json holds the cases.
//
// Frames are sorted by mid-exposure time. A gap of more than VISIT_GAP_DAYS between two neighbours starts a new
// visit. A visit that then spans more than VISIT_RUN_DAYS (near the ecliptic poles the telescope looks all the
// time) is cut into bins of VISIT_BIN_DAYS counted from its first frame. A visit with fewer than VISIT_MIN_FRAMES
// frames is short.
/** @import { Frame, Visit } from '../contracts.js' */
import { VISIT_BIN_DAYS, VISIT_GAP_DAYS, VISIT_MIN_FRAMES, VISIT_RUN_DAYS } from '../contracts.js';

/**
 * Group frames into visits. With `det`, only the frames of that detector are used (and counted).
 * @param {Frame[]} frames
 * @param {number | null} [det]
 * @returns {Visit[]}
 */
export function visits(frames, det = null) {
  const use = frames.filter((f) => det === null || f.det === det);
  use.sort((a, b) => a.tmid - b.tmid || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  /** @type {Frame[][]} */
  const groups = [];
  for (const f of use) {
    const g = groups[groups.length - 1];
    if (g && f.tmid - g[g.length - 1].tmid <= VISIT_GAP_DAYS) g.push(f);
    else groups.push([f]);
  }
  /** @type {Visit[]} */
  const out = [];
  for (const g of groups) {
    /** @type {Frame[][]} */
    let parts = [g];
    if (g[g.length - 1].tmid - g[0].tmid > VISIT_RUN_DAYS) {
      const t0 = g[0].tmid;
      /** @type {Map<number, Frame[]>} */
      const bins = new Map();
      for (const f of g) {
        const k = Math.floor((f.tmid - t0) / VISIT_BIN_DAYS);
        const bin = bins.get(k);
        if (bin) bin.push(f);
        else bins.set(k, [f]);
      }
      parts = [...bins.keys()].sort((p, q) => p - q).map((k) => /** @type {Frame[]} */ (bins.get(k)));
    }
    for (const p of parts) out.push({ frames: p, short: p.length < VISIT_MIN_FRAMES });
  }
  return out;
}

/**
 * The default two visits to compare, as positions in `vs`, the earlier first; null when there are fewer than two
 * that are not short.
 *
 * Of the visits that are not short, those with at least half the frames of the deepest one count as deep. When two
 * or more are deep, the pair is the earliest and the latest of them; otherwise the two deepest visits (ties: the
 * earlier one), in time order.
 * @param {Visit[]} vs
 * @returns {[number, number] | null}
 */
export function defaultPair(vs) {
  const ok = [];
  for (let i = 0; i < vs.length; i++) if (!vs[i].short) ok.push(i);
  if (ok.length < 2) return null;
  const deepest = Math.max(...ok.map((i) => vs[i].frames.length));
  const deep = ok.filter((i) => 2 * vs[i].frames.length >= deepest);
  if (deep.length >= 2) return [deep[0], deep[deep.length - 1]];
  const top = [...ok].sort((p, q) => vs[q].frames.length - vs[p].frames.length || p - q).slice(0, 2);
  return [Math.min(...top), Math.max(...top)];
}
