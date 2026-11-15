// The spectrum of a clicked place. SPHEREx sees one position at a different colour in each photo, so the photos that
// cover a place are the points of its spectrum: the flux in a small aperture around the place, at the colour of the
// photo. One curve for each visit; the change spectrum is the later visit over the earlier one at each matched colour.
//
// The aperture is 2 pixels in radius with the sky taken from a ring of 6 to 10 pixels, as in the precomputed spectra of
// data/spectra/. The flux is relative: the aperture holds only part of a point source's light, so every live spectrum is
// labelled "relative, not aperture-corrected". The colour of a point is the colour of its photo at the target pixel.
//
// The first half of this file has no need of a page; createSpectrum builds the panel in one.

/** @import { Det } from '../contracts.js' */
/** @import { Picture, Item } from './isitreal.js' */
/** @import { Band } from './bands.js' */
import { MATCH_MAX_PAIRS } from '../contracts.js';
import { estimateSeconds, bytesPerFrame } from '../lib/livepath.js';
import { matchPairs } from '../lib/match.js';
import { DEFECT_MASK, SATURATION_MASK, SOURCE_MASK } from '../lib/flags.js';
import { BANDS, REFERENCES, bandText, binned, pointsOfFile, scaleToObject } from './bands.js';
import { clippedMedian, robustNoise } from '../lib/stack.js';
import { choosePairs, disc } from './isitreal.js';
import { formatDate } from './stage.js';
import { formatMB, formatSeconds } from './plan.js';
import { formatColour } from './ruler.js';

export const APERTURE_PX = 2;
export const RING_PX = [6, 10];
/** A place needs a photo at this many times its noise to get a curve. */
export const MIN_SNR = 5;
/** The flags that make a live point unusable: every flag of the tiers "defect" and "saturation" (lib/flags.js). */
export const POINT_MASK = SATURATION_MASK | DEFECT_MASK;
/** The `mask` of the precomputed spectra (data/spectra/*.json), used when a file does not say. */
const FILE_MASK = 167495;
/** Ring pixels are left out for the point mask and for SOURCE (a star in the sky ring would raise the sky). */
const RING_MASK = POINT_MASK | SOURCE_MASK;
const MIN_RING_PIXELS = 20;

export const LIVE_LABEL = 'relative, not aperture-corrected';

/**
 * Solid angle of one pixel of a picture, steradians: from its sky transform, else 6.15 arcsec square.
 * @param {Picture} s
 * @returns {number}
 */
export function pixelSr(s) {
  const D = Math.PI / 180;
  if (s.sky && s.sky.cd.every(Number.isFinite)) {
    const [a, b, c, d] = s.sky.cd, area = Math.abs(a * d - b * c);
    if (area > 0) return area * D * D;
  }
  return (6.15 / 3600 * D) ** 2;
}

/**
 * One photo's flux at a place.
 * @typedef {Object} Measure
 * @property {'ok' | 'saturated' | 'flagged' | 'nodata'} state
 * @property {number} flux  mJy; NaN unless state is ok.
 * @property {number} err  mJy
 * @property {number} snr
 */

/**
 * Aperture photometry on one photo of a place whose pixel is (x, y).
 * @param {Picture} s @param {number} x @param {number} y
 * @returns {Measure}
 */
export function measure(s, x, y) {
  /** @type {Measure} */
  const bad = { state: 'nodata', flux: NaN, err: NaN, snr: NaN };
  const ap = disc(s, x, y, APERTURE_PX);
  if (ap.length < 8) return bad;
  let word = 0;
  if (s.flags) for (const i of ap) word |= s.flags[i];
  if (word & SATURATION_MASK) return { ...bad, state: 'saturated' };
  if (word & POINT_MASK) return { ...bad, state: 'flagged' };
  if (ap.some((i) => !Number.isFinite(s.data[i]))) return bad;
  // the sky ring leaves out SOURCE pixels (a star's wings would raise the sky); beside a very bright star the flag can
  // cover the whole ring, and then it is only the defects that are left out
  /** @type {number[]} */
  let ring = [];
  for (const keep of [RING_MASK, POINT_MASK]) {
    ring = [];
    for (const i of disc(s, x, y, RING_PX[1])) {
      const r = Math.hypot((i % s.w) - x, Math.floor(i / s.w) - y);
      if (r < RING_PX[0] || !Number.isFinite(s.data[i]) || (s.flags && s.flags[i] & keep)) continue;
      ring.push(s.data[i]);
    }
    if (ring.length >= MIN_RING_PIXELS) break;
  }
  if (ring.length < MIN_RING_PIXELS) return bad;
  const sky = clippedMedian(ring), noise = robustNoise(ring.map((v) => v - sky));
  const k = pixelSr(s) * 1e9; // MJy/sr over a pixel -> mJy
  let sum = 0;
  for (const i of ap) sum += s.data[i] - sky;
  const flux = sum * k, err = noise * Math.sqrt(ap.length * (1 + ap.length / ring.length)) * k;
  return { state: 'ok', flux, err, snr: err > 0 ? flux / err : NaN };
}

/**
 * One point of a spectrum.
 * @typedef {Object} SpectrumPoint
 * @property {string} key  The photo.
 * @property {number} lam  µm @property {number} bw
 * @property {number} mjd
 * @property {number} det
 * @property {number} visit
 * @property {number} flux  mJy @property {number} err @property {number} snr
 */

/**
 * @typedef {Object} Curve
 * @property {number} visit
 * @property {number} mjd  Date of its first photo.
 * @property {SpectrumPoint[]} points  By colour.
 */

/**
 * @typedef {Object} Spectrum
 * @property {'ok' | 'too-bright' | 'too-faint' | 'nothing'} state  Anything but ok gives no curve.
 * @property {string} why  A plain sentence for a state that is not ok.
 * @property {Curve[]} curves
 * @property {SpectrumPoint[]} points
 * @property {number} photos  Photos asked.
 * @property {number} saturated @property {number} flagged
 */

/**
 * The spectrum of the place (x, y) from the photos loaded.
 * @param {Item[]} items
 * @param {number} x @param {number} y
 * @returns {Spectrum}
 */
export function spectrumFor(items, x, y) {
  /** @type {SpectrumPoint[]} */
  const points = [];
  let saturated = 0, flagged = 0;
  for (const it of items) {
    const m = measure(it.stamp, x, y);
    if (m.state === 'saturated') saturated++;
    else if (m.state === 'flagged') flagged++;
    if (m.state !== 'ok') continue;
    points.push({ key: it.key, lam: it.stamp.lam, bw: it.stamp.bw, mjd: it.mjd, det: it.stamp.det, visit: it.visit, flux: m.flux, err: m.err, snr: m.snr });
  }
  points.sort((p, q) => p.lam - q.lam);
  /** @type {Spectrum} */
  const out = { state: 'ok', why: '', curves: [], points, photos: items.length, saturated, flagged };
  if (items.length === 0) return { ...out, state: 'nothing', why: 'No photo is loaded yet.' };
  if (saturated * 2 >= items.length || (points.length === 0 && saturated > 0)) {
    return { ...out, state: 'too-bright', curves: [], points: [], why: `Too bright to measure: the pixels here are saturated or nearly so in ${saturated} of ${items.length} photos, so no curve is drawn.` };
  }
  if (points.length === 0) return { ...out, state: 'nothing', why: `No photo can be measured here: ${flagged} of ${items.length} have flagged pixels in the aperture, or too few pixels around it.` };
  if (!points.some((p) => p.snr >= MIN_SNR)) {
    return { ...out, state: 'too-faint', curves: [], points: [], why: `Too faint: in no photo does this place stand ${MIN_SNR} times above its noise, so no curve is drawn.` };
  }
  /** @type {Map<number, Curve>} */
  const byVisit = new Map();
  for (const p of points) {
    const c = byVisit.get(p.visit) ?? { visit: p.visit, mjd: p.mjd, points: [] };
    c.points.push(p);
    c.mjd = Math.min(c.mjd, p.mjd);
    byVisit.set(p.visit, c);
  }
  out.curves = [...byVisit.values()].sort((p, q) => p.visit - q.visit);
  return out;
}

/**
 * One point of the change spectrum.
 * @typedef {Object} ChangePoint
 * @property {number} lam  Mean colour of the two photos, µm.
 * @property {number} ratio  Later over earlier. @property {number} err
 * @property {string} keyA  The earlier photo. @property {string} keyB  The later.
 * @property {number} det
 */

/**
 * The later visit over the earlier one, at each matched colour (CT-6). A pair counts when the earlier photo is measured
 * at MIN_SNR or better; the others are counted in `faint`.
 * @param {Spectrum} sp
 * @param {Item[]} items
 * @param {string[]} [selection]
 * @returns {{points: ChangePoint[], faint: number, pairs: number, a: number, b: number} | null}  Null when there are no matched pairs.
 */
export function changeSpectrum(sp, items, selection = []) {
  const chosen = choosePairs(items, selection);
  if (!chosen) return null;
  const at = new Map(sp.points.map((p) => [p.key, p]));
  /** @type {ChangePoint[]} */
  const points = [];
  let faint = 0, pairs = 0;
  for (const [a, b] of chosen.pairs) {
    const pa = at.get(a.key), pb = at.get(b.key);
    if (!pa || !pb) continue;
    pairs++;
    if (!(pa.snr >= MIN_SNR)) { faint++; continue; }
    const ratio = pb.flux / pa.flux;
    points.push({ lam: (pa.lam + pb.lam) / 2, ratio, err: Math.abs(ratio) * Math.hypot(pa.err / pa.flux, pb.err / pb.flux), keyA: pa.key, keyB: pb.key, det: pa.det });
  }
  points.sort((p, q) => p.lam - q.lam);
  return { points, faint, pairs, a: chosen.a, b: chosen.b };
}

/**
 * What loading every colour would cost: the photos of the detectors that have none loaded, in the two visits compared, at
 * most as many as the pairs allow for each detector; megabytes and seconds on a fast link, as the plan reckons them.
 * @param {{key: string, det: number, visit: number, loaded?: boolean}[]} frames
 * @param {Item[]} items  Loaded photos.
 * @param {string[]} [selection]
 * @returns {{photos: number, bytes: number, seconds: number}}
 */
export function allColoursCost(frames, items, selection = []) {
  const chosen = choosePairs(items, selection);
  const vs = chosen ? [chosen.a, chosen.b] : [Math.min(...frames.map((f) => f.visit)), Math.max(...frames.map((f) => f.visit))];
  /** @type {Set<number>} */
  const have = new Set(items.map((it) => it.stamp.det));
  let photos = 0;
  for (let det = 1; det <= 6; det++) {
    if (have.has(det)) continue;
    const per = vs.map((v) => frames.filter((f) => f.det === det && f.visit === v && !f.loaded).length);
    if (vs[0] === vs[1] || per.some((n) => n === 0)) continue;
    photos += per.reduce((s, n) => s + Math.min(n, MATCH_MAX_PAIRS), 0);
  }
  const bytes = photos * bytesPerFrame();
  return { photos, bytes, seconds: estimateSeconds(bytes, false) };
}

/**
 * The precomputed spectrum of a target (data/spectra/<id>.json), as curves.
 * @typedef {Object} Showcase
 * @property {string} id @property {string} name
 * @property {string} label  "relative only" or what the file says.
 * @property {string} correction
 * @property {{first_mjd: number, n: number, short: boolean, points: SpectrumPoint[]}[]} visits
 */

/**
 * @param {any} doc  The file.
 * @returns {Showcase | null}  Null when it is not a spectra file.
 */
export function parseShowcase(doc) {
  if (!doc || !Array.isArray(doc.visits)) return null;
  const mask = Number.isFinite(doc.mask) ? doc.mask : FILE_MASK;
  const visits = doc.visits.map((/** @type {any} */ v, /** @type {number} */ k) => {
    /** @type {SpectrumPoint[]} */
    const points = [];
    for (let i = 0; i < (v.lam?.length ?? 0); i++) {
      if (v.flags && (v.flags[i] & mask)) continue;
      if (![v.lam[i], v.flux[i], v.err[i]].every(Number.isFinite)) continue;
      const det = /\/(\d)\/level2_/.exec(v.key?.[i] ?? '');
      points.push({ key: v.key?.[i] ?? '', lam: v.lam[i], bw: v.bw?.[i] ?? NaN, mjd: v.mjd?.[i] ?? NaN, det: det ? Number(det[1]) : 0, visit: k, flux: v.flux[i], err: v.err[i], snr: v.err[i] > 0 ? v.flux[i] / v.err[i] : NaN });
    }
    return { first_mjd: v.first_mjd, n: v.n, short: Boolean(v.short), points };
  });
  return { id: String(doc.id), name: String(doc.name ?? doc.id), label: String(doc.label ?? LIVE_LABEL), correction: String(doc.correction ?? LIVE_LABEL), visits };
}

// ---------------------------------------------------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------------------------------------------------

/** A few round numbers that cover [lo, hi]. @param {number} lo @param {number} hi @param {number} [n] */
export function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  /** @type {number[]} */
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/**
 * @typedef {Object} ChartPoint
 * @property {number} x @property {number} y @property {number} err
 * @property {string} key  The photo; empty for a point of a change spectrum that has two (see `keys`).
 * @property {string[]} keys
 * @property {number} det
 * @property {number} series  Which curve: the shape of the marker.
 * @property {string} label  Words for a screen reader and the tooltip.
 */

const NS = 'http://www.w3.org/2000/svg';
/** @param {string} tag @param {Record<string, string | number>} [attrs] */
function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * The mark of a series: a circle, a square, a triangle or a diamond, by turns. The key of a chart draws the same.
 * @param {number} series @param {number} cx @param {number} cy
 * @returns {SVGElement}
 */
function markOf(series, cx, cy) {
  const r = 4, shape = series % 4;
  return shape === 0 ? svg('circle', { cx, cy, r })
    : shape === 1 ? svg('rect', { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r })
      : shape === 2 ? svg('polygon', { points: `${cx},${cy - r - 1} ${cx + r + 1},${cy + r} ${cx - r - 1},${cy + r}` })
        : svg('polygon', { points: `${cx},${cy - r - 1} ${cx + r + 1},${cy} ${cx},${cy + r + 1} ${cx - r - 1},${cy}` });
}

let chartCount = 0;

/**
 * Draw a chart of points with error bars and one line for each series.
 * @param {Object} o
 * @param {ChartPoint[]} o.points
 * @param {string} o.xLabel @param {string} o.yLabel
 * @param {number} [o.baseline]  A horizontal line, such as 1 for a ratio.
 * @param {Set<string>} o.lit  Keys of photos to mark as lit (hovered or on the stage).
 * @param {(key: string | null) => void} o.onHover
 * @param {readonly Band[]} [o.bands]  Bands of gases to mark on the colour axis.
 * @param {{lam: number, flux: number}[]} [o.reference]  A line to hold the points against, already scaled.
 * @returns {SVGSVGElement}
 */
export function drawChart({ points, xLabel, yLabel, baseline, lit, onHover, bands = [], reference = [] }) {
  const W = 560, H = 250, L = 52, R = 12, T = 10, B = 40;
  // a chart is a drawing made of data: it stands on a plate
  const el = /** @type {SVGSVGElement} */ (svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', 'data-plate': '', role: 'group', 'aria-label': `${yLabel} against ${xLabel}` }));
  const xs = points.map((p) => p.x), ys = points.flatMap((p) => [p.y - p.err, p.y + p.err, p.y]);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x1 - x0 < 0.02) { x0 -= 0.05; x1 += 0.05; }
  const xpad = (x1 - x0) * 0.04;
  x0 -= xpad; x1 += xpad;
  let y0 = Math.min(...ys, baseline ?? Infinity), y1 = Math.max(...ys, baseline ?? -Infinity);
  if (baseline === undefined && y0 > 0) y0 = 0;
  if (y1 - y0 < 1e-9) { y0 -= 1; y1 += 1; }
  const ypad = (y1 - y0) * 0.06;
  y0 -= ypad; y1 += ypad;
  const px = (/** @type {number} */ v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const py = (/** @type {number} */ v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  // where gases take light out: strips of the plot, with the name of the gas over each
  for (const b of bands) {
    if (b.to < x0 || b.from > x1) continue;
    const bx0 = px(Math.max(b.from, x0)), bx1 = px(Math.min(b.to, x1));
    el.append(svg('rect', { x: bx0, y: T, width: Math.max(1, bx1 - bx0), height: H - T - B, class: 'band', 'data-band': b.id }));
    const name = svg('text', { x: (bx0 + bx1) / 2, y: T + 11, class: 'band-label', 'text-anchor': 'middle', 'data-band': b.id });
    name.textContent = b.short;
    if (bx1 - bx0 >= 14) el.append(name);
  }
  for (const v of niceTicks(y0, y1, 4)) {
    el.append(svg('line', { x1: L, x2: W - R, y1: py(v), y2: py(v), class: 'grid' }));
    const t = svg('text', { x: L - 6, y: py(v) + 4, class: 'tick', 'text-anchor': 'end' });
    t.textContent = String(Number(v.toPrecision(3)));
    el.append(t);
  }
  for (const v of niceTicks(x0, x1, 5)) {
    el.append(svg('line', { x1: px(v), x2: px(v), y1: H - B, y2: H - B + 4, class: 'axis' }));
    const t = svg('text', { x: px(v), y: H - B + 16, class: 'tick', 'text-anchor': 'middle' });
    t.textContent = String(Number(v.toPrecision(3)));
    el.append(t);
  }
  el.append(svg('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, class: 'axis' }), svg('line', { x1: L, x2: L, y1: T, y2: H - B, class: 'axis' }));
  if (baseline !== undefined) el.append(svg('line', { x1: L, x2: W - R, y1: py(baseline), y2: py(baseline), class: 'baseline' }));
  const xl = svg('text', { x: (L + W - R) / 2, y: H - 6, class: 'axis-label', 'text-anchor': 'middle' });
  xl.textContent = xLabel;
  const yl = svg('text', { x: 12, y: (T + H - B) / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 12 ${(T + H - B) / 2})` });
  yl.textContent = yLabel;
  el.append(xl, yl);
  if (reference.length > 1) {
    const clip = `chart-clip-${++chartCount}`;
    el.append(svg('clipPath', { id: clip }));
    /** @type {SVGElement} */ (el.lastChild).append(svg('rect', { x: L, y: T, width: W - L - R, height: H - T - B }));
    el.append(svg('polyline', { points: reference.map((p) => `${px(p.lam).toFixed(1)},${py(p.flux).toFixed(1)}`).join(' '), class: 'reference', 'clip-path': `url(#${clip})`, 'data-reference': '' }));
  }
  const seriesIds = [...new Set(points.map((p) => p.series))].sort((a, b) => a - b);
  for (const s of seriesIds) {
    const line = points.filter((p) => p.series === s).sort((a, b) => a.x - b.x);
    if (line.length > 1) el.append(svg('polyline', { points: line.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' '), class: 'curve', 'data-series': s }));
  }
  const focusable = points.length <= 60;
  for (const p of points) {
    const cx = px(p.x), cy = py(p.y);
    const g = svg('g', { class: 'pt', 'data-det': p.det, 'data-key': p.key, 'data-series': p.series, tabindex: focusable ? 0 : -1, role: 'img', 'aria-label': p.label });
    if (p.err > 0) g.append(svg('line', { x1: cx, x2: cx, y1: py(p.y - p.err), y2: py(p.y + p.err), class: 'err' }));
    g.append(markOf(p.series, cx, cy));
    const mark = svg('circle', { cx, cy, r: 8, class: 'lit' });
    g.append(mark);
    const keys = p.keys.length ? p.keys : [p.key];
    g.dataset.lit = String(keys.some((k) => lit.has(k)));
    const title = svg('title');
    title.textContent = p.label;
    g.append(title);
    g.addEventListener('pointerenter', () => onHover(keys[keys.length - 1]));
    g.addEventListener('pointerleave', () => onHover(null));
    g.addEventListener('focus', () => onHover(keys[keys.length - 1]));
    g.addEventListener('blur', () => onHover(null));
    el.append(g);
  }
  return el;
}

/**
 * Build the panel in `root`.
 * @param {HTMLElement} root
 * @param {{onHover: (key: string | null) => void, onLoadAll: () => Promise<unknown> | void}} hooks
 */
export function createSpectrum(root, { onHover, onLoadAll }) {
  /** @type {string | null} The reference spectrum held against the clicked object: an id of REFERENCES, or none. */
  let compare = null;
  /** @type {Map<string, {lam: number, flux: number}[] | 'failed'>} The stored spectra that were loaded, as lines. */
  const loaded = new Map();
  root.classList.add('spectrum');
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'SPECTRUM';
  const hint = document.createElement('p');
  hint.className = 'panel-hint';
  const body = document.createElement('div');
  body.className = 'spectrum-body';
  const label = document.createElement('p');
  label.className = 'spectrum-label';
  label.textContent = `Brightness in a 2-pixel circle, ${LIVE_LABEL}. Each point is one photo, coloured by its detector.`;
  const legend = document.createElement('ul');
  legend.className = 'spectrum-legend';
  const changeTitle = document.createElement('h3');
  changeTitle.className = 'panel-subtitle';
  changeTitle.textContent = 'Change between the two visits';
  const changeBody = document.createElement('div');
  changeBody.className = 'spectrum-change';
  const bandNote = document.createElement('p');
  bandNote.className = 'spectrum-bands';
  const compareRow = document.createElement('div');
  compareRow.className = 'spectrum-compare';
  const compareName = document.createElement('p');
  compareName.className = 'spectrum-compare-name';
  compareName.textContent = 'Hold it against';
  const compareChoice = document.createElement('div');
  compareChoice.className = 'choice spectrum-compare-choice';
  compareChoice.setAttribute('role', 'group');
  compareChoice.setAttribute('aria-label', 'Hold the spectrum against a stored one');
  for (const [id, text] of [['', 'Nothing'], ...REFERENCES.map((r) => [r.id, r.label])]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.compare = id;
    b.textContent = text;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => chooseCompare(id || null));
    compareChoice.append(b);
  }
  const compareNote = document.createElement('p');
  compareNote.className = 'spectrum-compare-note';
  compareNote.setAttribute('role', 'status');
  compareRow.append(compareName, compareChoice, compareNote);
  const loadRow = document.createElement('p');
  loadRow.className = 'spectrum-load';
  const loadBtn = document.createElement('button');
  loadBtn.type = 'button';
  loadBtn.className = 'btn';
  const loadNote = document.createElement('span');
  loadNote.setAttribute('role', 'status');
  loadRow.append(loadBtn, loadNote);
  root.replaceChildren(title, hint, body, label, legend, bandNote, compareRow, changeTitle, changeBody, loadRow);

  /** @param {string | null} id */
  async function chooseCompare(id) {
    compare = id;
    const ref = REFERENCES.find((r) => r.id === id);
    if (ref && !loaded.has(ref.id)) {
      compareNote.textContent = 'Loading the stored spectrum…';
      try {
        const r = await fetch(new URL(ref.file, document.baseURI).href);
        loaded.set(ref.id, r.ok ? binned(pointsOfFile(await r.json())) : 'failed');
      } catch {
        loaded.set(ref.id, 'failed');
      }
    }
    render();
  }

  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    loadNote.textContent = ' Loading…';
    try { await onLoadAll(); loadNote.textContent = ''; } catch { loadNote.textContent = ' Could not load them.'; }
    loadBtn.disabled = false;
  });

  /**
   * @typedef {Object} View
   * @property {'none' | 'live' | 'showcase'} mode
   * @property {Spectrum | null} spectrum
   * @property {ReturnType<typeof changeSpectrum>} change
   * @property {Showcase | null} showcase
   * @property {{photos: number, bytes: number, seconds: number} | null} cost
   * @property {Set<string>} lit
   */
  /** @type {View} */
  let view = { mode: 'none', spectrum: null, change: null, showcase: null, cost: null, lit: new Set() };

  /** @param {Partial<View>} next */
  function show(next) {
    view = { ...view, ...next };
    render();
  }

  function render() {
    const { mode, spectrum, change, showcase, cost, lit } = view;
    root.dataset.mode = mode;
    root.dataset.state = mode === 'live' && spectrum ? spectrum.state : mode;
    body.replaceChildren();
    changeBody.replaceChildren();
    legend.replaceChildren();
    const live = mode === 'live' && spectrum !== null;
    changeTitle.hidden = changeBody.hidden = !(live && spectrum?.state === 'ok');
    label.hidden = mode === 'none';
    label.textContent = mode === 'showcase' && showcase
      ? `${showcase.name}: worked out beforehand from every photo of the archive, ${showcase.label}. Brightness in a 2-pixel circle, not corrected for the light outside it.`
      : `Brightness in a 2-pixel circle, ${LIVE_LABEL}. Each point is one photo, coloured by its detector.`;
    if (mode === 'none') hint.textContent = 'Click a place in the picture to see its spectrum, one curve for each visit.';
    else hint.textContent = mode === 'showcase' ? 'The place you clicked is the target.' : 'For the place you clicked.';

    /** @type {ChartPoint[]} */
    let pts = [];
    /** @type {{visit: number, mjd: number}[]} */
    let visitsShown = [];
    if (mode === 'showcase' && showcase) {
      const shown = showcase.visits.filter((v) => !v.short && v.points.length);
      pts = shown.flatMap((v, k) => v.points.map((p) => chartPoint(p, k)));
      visitsShown = shown.map((v) => ({ visit: v.points[0].visit, mjd: v.first_mjd }));
    } else if (live && spectrum && spectrum.state === 'ok') {
      pts = spectrum.curves.flatMap((c, k) => c.points.map((p) => chartPoint(p, k)));
      visitsShown = spectrum.curves.map((c) => ({ visit: c.visit, mjd: c.mjd }));
    } else if (live && spectrum) {
      const p = document.createElement('p');
      p.className = 'panel-state';
      p.textContent = spectrum.why;
      body.append(p);
    }
    // the bands of the gases, and a stored spectrum held against the object at one colour: shape only
    const own = pts.map((p) => ({ lam: p.x, flux: p.y }));
    const ref = REFERENCES.find((r) => r.id === compare);
    const line = ref ? loaded.get(ref.id) : undefined;
    const scaled = Array.isArray(line) ? scaleToObject(line, own) : null;
    compareRow.hidden = bandNote.hidden = !pts.length;
    for (const b of compareChoice.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.compare || null) === compare));
    compareNote.textContent = !ref ? '' : line === undefined ? 'Loading the stored spectrum…'
      : line === 'failed' ? 'The stored spectrum could not be read.'
        : !scaled ? 'The two have no colour in common at which to scale, so none is drawn.'
          : `Dashed line: ${ref.label}, scaled to the object at ${formatColour(scaled.at)}. Compare the shape only: both are relative.`;
    bandNote.textContent = `Strips mark where gases absorb: ${BANDS.map(bandText).join('; ')}. In a brown dwarf the water and methane strips are dim.`;
    if (pts.length) {
      body.append(drawChart({ points: pts, xLabel: 'colour (µm)', yLabel: 'brightness (mJy)', lit, onHover, bands: BANDS, reference: scaled?.line ?? [] }));
      for (const [k, v] of visitsShown.entries()) {
        const li = document.createElement('li');
        li.dataset.series = String(k);
        const mark = svg('svg', { viewBox: '0 0 12 12', class: 'spectrum-mark', 'aria-hidden': 'true' });
        mark.append(markOf(k, 6, 6));
        li.append(mark, `visit of ${formatDate(v.mjd)}`);
        legend.append(li);
      }
    }
    if (live && spectrum?.state === 'ok') {
      if (change && change.points.length) {
        changeBody.append(drawChart({
          points: change.points.map((c) => ({ x: c.lam, y: c.ratio, err: c.err, key: c.keyB, keys: [c.keyA, c.keyB], det: c.det, series: 0, label: `${formatColour(c.lam)}: later over earlier ${c.ratio.toFixed(2)} ± ${c.err.toFixed(2)}` })),
          xLabel: 'colour (µm)', yLabel: 'later over earlier', baseline: 1, lit, onHover,
        }));
        const note = document.createElement('p');
        note.className = 'panel-hint';
        note.textContent = `${change.points.length} matched colours${change.faint ? `; ${change.faint} left out because the earlier photo is too faint for a ratio` : ''}. A flat line at 1 is no change.`;
        changeBody.append(note);
      } else {
        const p = document.createElement('p');
        p.className = 'panel-state';
        p.textContent = change ? 'No matched colour has an earlier photo bright enough for a ratio.' : 'Two visits at the same colour are needed for a change spectrum.';
        changeBody.append(p);
      }
    }
    loadRow.hidden = mode === 'showcase' || !cost || cost.photos === 0;
    if (cost && cost.photos > 0) loadBtn.textContent = `load all colours (${formatMB(cost.bytes)} MB, ${formatSeconds(cost.seconds)})`;
  }

  /** @param {SpectrumPoint} p @param {number} series @returns {ChartPoint} */
  function chartPoint(p, series) {
    return {
      x: p.lam, y: p.flux, err: p.err, key: p.key, keys: [], det: p.det, series,
      label: `${formatColour(p.lam)}, ${formatDate(p.mjd)}: ${p.flux.toFixed(2)} ± ${p.err.toFixed(2)} mJy${p.key ? `, ${p.key.split('/').pop()?.replace(/^level2_/, '').replace(/_spx_.*$/, '')}` : ''}`,
    };
  }

  render();
  return { show, render, current: () => view };
}
