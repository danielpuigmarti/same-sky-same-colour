// The frame map: every photo of a position as one dot. Across is the date, with the visits shaded; up is the colour
// (the wavelength at the target pixel), and a dot takes the colour of its detector's span on the ruler. A filled dot is
// a photo that is loaded, a grey one is indexed but not loaded, a hollow one is flagged. Hovering a dot asks the page to
// show that photo; dragging a band of colour asks it to blink only the photos in the band.
//
// It is drawn on a canvas, so that 21,000 dots (the deep fields at the ecliptic poles) stay quick: above DENSE_ABOVE the
// photos that are not loaded are drawn as small counted cells, and the loaded ones are always drawn one by one.
//
// The first half of this file has no need of a page; createFrameMap builds the map in one.

/** @import { Det } from '../contracts.js' */
import { formatDate } from './stage.js';
import { fileId } from './hover.js';
import { formatColour } from './ruler.js';

/** Above this many dots the photos that are not loaded are binned. */
export const DENSE_ABOVE = 1500;
/** A dot is found by the pointer within this many pixels. */
export const HIT_PX = 9;
/** A drag shorter than this is a click. */
export const DRAG_PX = 5;

/**
 * A photo of the position, as the page lists it.
 * @typedef {Object} MapFrame
 * @property {string} key
 * @property {number} det
 * @property {number} mjd
 * @property {number} lam  µm, at the target pixel.
 * @property {number} bw
 * @property {number} visit
 * @property {boolean} loaded
 * @property {boolean} flagged
 */

/** @typedef {'loaded' | 'flagged' | 'indexed'} DotState */

/**
 * How a photo is drawn: flagged wins (hollow), then loaded (filled in the colour of its detector), else grey.
 * @param {MapFrame} f
 * @returns {DotState}
 */
export const dotState = (f) => (f.flagged ? 'flagged' : f.loaded ? 'loaded' : 'indexed');

/** @param {number} mjd @returns {Date} */
export const mjdToDate = (mjd) => new Date(Date.UTC(1858, 10, 17) + mjd * 86400000);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Where the dots go.
 * @typedef {Object} Layout
 * @property {{l: number, t: number, r: number, b: number}} plot  The plotting area, pixels.
 * @property {number} t0 @property {number} t1  MJD at the left and right edges.
 * @property {number} l0 @property {number} l1  µm at the bottom and top edges.
 * @property {(mjd: number) => number} xOf
 * @property {(lam: number) => number} yOf
 * @property {(y: number) => number} lamOf
 * @property {{frame: MapFrame, x: number, y: number}[]} dots
 * @property {{visit: number, x0: number, x1: number, n: number}[]} bands  The visits, shaded.
 * @property {number} skipped  Photos left out because their date or colour is not a number.
 */

/**
 * Lay the frames out in a box of width x height pixels.
 * @param {MapFrame[]} frames
 * @param {number} width @param {number} height
 * @param {{l?: number, t?: number, r?: number, b?: number}} [margin]
 * @returns {Layout}
 */
export function layout(frames, width, height, margin = {}) {
  const plot = { l: margin.l ?? 44, t: margin.t ?? 8, r: width - (margin.r ?? 10), b: height - (margin.b ?? 26) };
  const ok = frames.filter((f) => Number.isFinite(f.mjd) && Number.isFinite(f.lam));
  let t0 = Math.min(...ok.map((f) => f.mjd)), t1 = Math.max(...ok.map((f) => f.mjd));
  if (!ok.length) { t0 = 0; t1 = 1; }
  if (t1 - t0 < 1) { t0 -= 3; t1 += 3; }
  const tpad = (t1 - t0) * 0.03;
  t0 -= tpad; t1 += tpad;
  let l0 = Math.min(...ok.map((f) => f.lam)), l1 = Math.max(...ok.map((f) => f.lam));
  if (!ok.length) { l0 = 0.75; l1 = 5; }
  if (l1 - l0 < 0.3) { const m = (l0 + l1) / 2; l0 = m - 0.15; l1 = m + 0.15; }
  const lpad = (l1 - l0) * 0.05;
  l0 -= lpad; l1 += lpad;
  const xOf = (/** @type {number} */ mjd) => plot.l + ((mjd - t0) / (t1 - t0)) * (plot.r - plot.l);
  const yOf = (/** @type {number} */ lam) => plot.b - ((lam - l0) / (l1 - l0)) * (plot.b - plot.t);
  const lamOf = (/** @type {number} */ y) => l0 + ((plot.b - y) / (plot.b - plot.t)) * (l1 - l0);
  const dots = ok.map((frame) => ({ frame, x: xOf(frame.mjd), y: yOf(frame.lam) }));
  /** @type {Map<number, {x0: number, x1: number, n: number}>} */
  const byVisit = new Map();
  for (const d of dots) {
    const b = byVisit.get(d.frame.visit);
    if (b) { b.x0 = Math.min(b.x0, d.x); b.x1 = Math.max(b.x1, d.x); b.n++; } else byVisit.set(d.frame.visit, { x0: d.x, x1: d.x, n: 1 });
  }
  const bands = [...byVisit.entries()].sort((p, q) => p[0] - q[0]).map(([visit, b]) => ({ visit, x0: b.x0 - 2, x1: b.x1 + 2, n: b.n }));
  return { plot, t0, t1, l0, l1, xOf, yOf, lamOf, dots, bands, skipped: frames.length - ok.length };
}

/**
 * Month ticks along the date axis, as few as keep them 56 pixels apart.
 * @param {Layout} lay
 * @returns {{x: number, text: string}[]}
 */
export function timeTicks(lay) {
  const width = lay.plot.r - lay.plot.l;
  const d0 = mjdToDate(lay.t0), d1 = mjdToDate(lay.t1);
  const months = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d1.getUTCMonth() - d0.getUTCMonth() + 1;
  const step = [1, 2, 3, 6, 12, 24].find((s) => (width * s) / Math.max(months, 1) >= 56) ?? 24;
  /** @type {{x: number, text: string}[]} */
  const out = [];
  let y = d0.getUTCFullYear(), m = d0.getUTCMonth();
  m = Math.ceil(m / step) * step;
  for (let guard = 0; guard < 400; guard++) {
    const t = Date.UTC(y + Math.floor(m / 12), m % 12, 1) / 86400000 + 40587;
    if (t > lay.t1) break;
    if (t >= lay.t0) out.push({ x: lay.xOf(t), text: m % 12 === 0 || out.length === 0 ? `${MONTHS[m % 12]} ${y + Math.floor(m / 12)}` : MONTHS[m % 12] });
    m += step;
  }
  return out;
}

/**
 * A spatial index of the dots for the pointer.
 * @param {Layout['dots']} dots
 * @param {number} [cell]
 * @returns {{nearest: (x: number, y: number, radius?: number) => number}}  Position in `dots` of the nearest dot, -1 for none. A loaded dot wins a near tie.
 */
export function indexDots(dots, cell = 12) {
  /** @type {Map<string, number[]>} */
  const grid = new Map();
  for (const [i, d] of dots.entries()) {
    const k = `${Math.floor(d.x / cell)},${Math.floor(d.y / cell)}`;
    const a = grid.get(k);
    if (a) a.push(i); else grid.set(k, [i]);
  }
  return {
    nearest(x, y, radius = HIT_PX) {
      const c0 = Math.floor((x - radius) / cell), c1 = Math.floor((x + radius) / cell), r0 = Math.floor((y - radius) / cell), r1 = Math.floor((y + radius) / cell);
      let best = -1, bestScore = Infinity;
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          for (const i of grid.get(`${cx},${cy}`) ?? []) {
            const dist = Math.hypot(dots[i].x - x, dots[i].y - y);
            if (dist > radius) continue;
            const score = dist + (dots[i].frame.loaded ? 0 : 2);
            if (score < bestScore) { bestScore = score; best = i; }
          }
        }
      }
      return best;
    },
  };
}

/**
 * The photos in a band of colour: all of them, and the loaded ones, which are what the stage can blink.
 * @param {MapFrame[]} frames
 * @param {number} lo @param {number} hi  µm, in either order.
 * @returns {{all: string[], loaded: string[]}}
 */
export function framesInBand(frames, lo, hi) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const inside = frames.filter((f) => f.lam >= a && f.lam <= b);
  return { all: inside.map((f) => f.key), loaded: inside.filter((f) => f.loaded).map((f) => f.key) };
}

/**
 * The words for one dot: colour, date, file, and what is known about it.
 * @param {MapFrame} f
 * @param {{onlyOne?: boolean}} [more]  `onlyOne`: the place clicked shows in this photo and no other.
 * @returns {string}
 */
export function dotText(f, { onlyOne = false } = {}) {
  return [
    formatColour(f.lam), formatDate(f.mjd), fileId(f.key),
    f.loaded ? 'loaded' : 'not loaded', f.flagged ? 'flagged' : '', onlyOne ? 'present in one photo only' : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Photos and their states, counted: "1234 photos · 16 loaded · centre pixel saturated or damaged in 2".
 * @param {MapFrame[]} frames
 * @returns {string}
 */
export function summaryText(frames) {
  const loaded = frames.filter((f) => f.loaded).length, flagged = frames.filter((f) => f.flagged).length;
  return `${frames.length} ${frames.length === 1 ? 'photo' : 'photos'} cover this position · ${loaded} loaded${flagged ? ` · centre pixel saturated or damaged in ${flagged}` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------------------------------------------------

const FALLBACK = { ink: '#f1ead6', muted: '#cfc6a8', faint: '#a89f82', line: '#3b3521', surface: '#16140d', accent: '#ebc144', mark: '#ff6b5e', grey: '#a89c6b',
  bands: ['#9aa8ff', '#5cc8f0', '#5ed6a0', '#e3d05a', '#f59a4a', '#f0626e'], font: 'monospace' };

/**
 * The colours and the typewriter face of the page, read from its tokens. Hand in the plate the map is drawn on: a
 * plate keeps the inks of the night in both editions of the page.
 * @param {HTMLElement} el
 */
export function readColours(el) {
  const cs = getComputedStyle(el);
  const v = (/** @type {string} */ name, /** @type {string} */ fb) => cs.getPropertyValue(name).trim() || fb;
  return {
    ink: v('--color-text', FALLBACK.ink), muted: v('--color-text-muted', FALLBACK.muted), faint: v('--color-text-faint', FALLBACK.faint),
    line: v('--color-line', FALLBACK.line), surface: v('--color-surface', FALLBACK.surface), accent: v('--color-accent', FALLBACK.accent),
    mark: v('--color-mark-alt', FALLBACK.mark), grey: v('--color-line-strong', FALLBACK.grey),
    bands: FALLBACK.bands.map((fb, i) => v(`--color-band-${i + 1}`, fb)), font: v('--font-mono', FALLBACK.font),
  };
}

/**
 * What is drawn besides the dots.
 * @typedef {Object} Overlay
 * @property {Set<string>} lit  Photos marked: hovered, on the stage, or a point of the spectrum.
 * @property {Set<string>} selected  Photos picked by a band.
 * @property {Set<string>} present  Photos in which the clicked place shows.
 * @property {{lo: number, hi: number} | null} band  The band being dragged or kept, in µm.
 * @property {string | null} hover
 */

/**
 * Draw the map.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Layout} lay
 * @param {number} width @param {number} height
 * @param {Overlay} ov
 * @param {ReturnType<typeof readColours>} col
 */
export function draw(ctx, lay, width, height, ov, col) {
  ctx.clearRect(0, 0, width, height);
  const { plot } = lay;
  ctx.font = `11px ${col.font}`;
  // the visits, shaded
  for (const [k, b] of lay.bands.entries()) {
    ctx.fillStyle = k % 2 ? 'rgba(241,234,214,0.09)' : 'rgba(241,234,214,0.04)';
    ctx.fillRect(b.x0, plot.t, Math.max(3, b.x1 - b.x0), plot.b - plot.t);
  }
  // axes
  ctx.strokeStyle = col.line; ctx.lineWidth = 1; ctx.fillStyle = col.faint;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of ticksOf(lay.l0, lay.l1, 4)) {
    const y = Math.round(lay.yOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(plot.l, y); ctx.lineTo(plot.r, y); ctx.stroke();
    ctx.fillText(String(Number(v.toPrecision(3))), plot.l - 5, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of timeTicks(lay)) {
    ctx.beginPath(); ctx.moveTo(Math.round(t.x) + 0.5, plot.b); ctx.lineTo(Math.round(t.x) + 0.5, plot.b + 4); ctx.stroke();
    ctx.fillText(t.text, t.x, plot.b + 6);
  }
  ctx.strokeStyle = col.grey;
  ctx.beginPath(); ctx.moveTo(plot.l + 0.5, plot.t); ctx.lineTo(plot.l + 0.5, plot.b + 0.5); ctx.lineTo(plot.r, plot.b + 0.5); ctx.stroke();
  ctx.save(); ctx.translate(11, (plot.t + plot.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = col.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('colour (µm)', 0, 0); ctx.restore();

  const dense = lay.dots.length > DENSE_ABOVE;
  const r = dense ? 1.6 : lay.dots.length > 500 ? 2.4 : 3.4;
  /** @param {MapFrame} f */
  const fill = (f) => (f.loaded || f.flagged ? col.bands[Math.min(5, Math.max(0, f.det - 1))] ?? col.ink : col.grey);
  if (dense) {
    // the photos that are not loaded, as cells of 4 pixels whose strength is their count
    const cell = 4;
    /** @type {Map<string, {x: number, y: number, n: number, det: number}>} */
    const cells = new Map();
    for (const d of lay.dots) {
      if (d.frame.loaded || d.frame.flagged) continue;
      const cx = Math.floor(d.x / cell), cy = Math.floor(d.y / cell), k = `${cx},${cy}`;
      const c = cells.get(k);
      if (c) c.n++; else cells.set(k, { x: cx * cell, y: cy * cell, n: 1, det: d.frame.det });
    }
    for (const c of cells.values()) {
      ctx.globalAlpha = Math.min(0.95, 0.25 + Math.log2(1 + c.n) * 0.12);
      ctx.fillStyle = col.bands[Math.min(5, Math.max(0, c.det - 1))] ?? col.grey;
      ctx.fillRect(c.x, c.y, cell - 1, cell - 1);
    }
    ctx.globalAlpha = 1;
  }
  // indexed photos first, then flagged, then loaded on top
  for (const state of /** @type {DotState[]} */ (['indexed', 'flagged', 'loaded'])) {
    for (const d of lay.dots) {
      const f = d.frame;
      if (dotState(f) !== state || (dense && state === 'indexed')) continue;
      const rad = state === 'indexed' ? r : Math.max(r, 3.4);
      ctx.beginPath(); ctx.arc(d.x, d.y, rad, 0, Math.PI * 2);
      if (state === 'flagged') { ctx.strokeStyle = fill(f); ctx.lineWidth = 1.5; ctx.stroke(); } else { ctx.fillStyle = fill(f); ctx.fill(); }
    }
  }
  // marks: the clicked place shows here; picked by a band; lit by a hover or a spectrum point
  for (const d of lay.dots) {
    const k = d.frame.key;
    if (ov.present.has(k)) { ctx.strokeStyle = col.mark; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(d.x, d.y, 6.5, 0, Math.PI * 2); ctx.stroke(); }
    if (ov.selected.has(k)) { ctx.strokeStyle = col.ink; ctx.lineWidth = 1.5; ctx.strokeRect(d.x - 5, d.y - 5, 10, 10); }
    if (ov.lit.has(k) || ov.hover === k) { ctx.strokeStyle = col.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(d.x, d.y, 8, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (ov.band) {
    const y0 = lay.yOf(Math.max(ov.band.lo, ov.band.hi)), y1 = lay.yOf(Math.min(ov.band.lo, ov.band.hi));
    ctx.fillStyle = 'rgba(241,234,214,0.14)'; ctx.fillRect(plot.l, y0, plot.r - plot.l, y1 - y0);
    ctx.strokeStyle = col.ink; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plot.l, y0 + 0.5); ctx.lineTo(plot.r, y0 + 0.5); ctx.moveTo(plot.l, y1 - 0.5); ctx.lineTo(plot.r, y1 - 0.5); ctx.stroke();
  }
}

/** @param {number} lo @param {number} hi @param {number} n */
function ticksOf(lo, hi, n) {
  const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  /** @type {number[]} */
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * Build the map in `root`.
 * @param {HTMLElement} root
 * @param {{onHover: (key: string | null) => void, onBand: (band: {lo: number, hi: number} | null, keys: {all: string[], loaded: string[]}) => void}} hooks
 */
export function createFrameMap(root, { onHover, onBand }) {
  root.classList.add('framemap');
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'EVERY PHOTO OF THIS POSITION';
  const summary = document.createElement('p');
  summary.className = 'panel-hint framemap-summary';
  // the map is a drawing made of data: it stands on a plate
  const wrap = document.createElement('div');
  wrap.className = 'framemap-wrap';
  wrap.setAttribute('data-plate', '');
  const canvas = document.createElement('canvas');
  canvas.className = 'framemap-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  const tip = document.createElement('div');
  tip.className = 'framemap-tip';
  tip.hidden = true;
  wrap.append(canvas, tip);
  const live = document.createElement('p');
  live.className = 'framemap-live';
  live.setAttribute('aria-live', 'polite');
  const note = document.createElement('p');
  note.className = 'panel-hint framemap-note';
  const bandNote = document.createElement('p');
  bandNote.className = 'panel-hint framemap-bandnote';
  const legend = document.createElement('p');
  legend.className = 'framemap-legend';
  legend.textContent = 'Across: date, each visit shaded. Up: colour. Filled: loaded. Grey: not loaded yet. Hollow: centre pixel saturated or damaged. Drag up or down to pick a band of colour to blink.';
  const tools = document.createElement('p');
  tools.className = 'framemap-tools';
  const pick = document.createElement('select');
  pick.setAttribute('aria-label', 'Blink one detector');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn';
  clear.textContent = 'BLINK ALL AGAIN';
  clear.hidden = true;
  tools.append(pick, clear);
  root.replaceChildren(title, summary, wrap, live, note, bandNote, legend, tools);

  /** @type {MapFrame[]} */
  let frames = [];
  let lay = layout([], 300, 200);
  /** @type {ReturnType<typeof indexDots>} */
  let index = indexDots([]);
  let width = 300, height = 200;
  /** @type {Overlay} */
  const ov = { lit: new Set(), selected: new Set(), present: new Set(), band: null, hover: null };
  let onlyOne = false;
  /** @type {string | null} */
  let pinned = null;
  let col = readColours(wrap);
  /** @type {{y: number, x: number, id: number} | null} */
  let drag = null;
  /** @type {number} */
  let queued = 0;

  function paint() {
    queued = 0;
    const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, lay, width, height, ov, col);
  }
  const redraw = () => { if (!queued) queued = requestAnimationFrame(paint); };

  function relayout() {
    width = Math.max(240, Math.floor(wrap.clientWidth || 300));
    height = width < 420 ? 170 : frames.length <= 40 ? 150 : 230;
    lay = layout(frames, width, height);
    index = indexDots(lay.dots);
    redraw();
  }

  function describe() {
    const bands = lay.bands.length, loaded = frames.filter((f) => f.loaded).length;
    canvas.setAttribute('aria-label', bands === 0
      ? 'Map of the photos by date and colour. There are no photos on it yet.'
      : `Map of ${frames.length} ${frames.length === 1 ? 'photo' : 'photos'} by date and colour, from ${bands} ${bands === 1 ? 'visit' : 'visits'}. ${loaded} ${loaded === 1 ? 'is' : 'are'} loaded. Use the arrow keys to step through the loaded photos.`);
    summary.textContent = frames.length ? summaryText(frames) : 'No photos yet. They appear when a position is chosen.';
    const dets = [...new Set(frames.map((f) => f.det))].sort();
    pick.replaceChildren(new Option('Blink: all colours', ''), ...dets.map((d) => {
      const ls = frames.filter((f) => f.det === d).map((f) => f.lam);
      return new Option(`Blink: detector ${d}, ${Math.min(...ls).toFixed(2)} to ${Math.max(...ls).toFixed(2)} µm`, String(d));
    }));
    pick.hidden = dets.length < 2;
  }

  /** @param {number} i */
  function hoverDot(i) {
    const d = i >= 0 ? lay.dots[i] : null;
    const key = d ? d.frame.key : null;
    if (key !== ov.hover) {
      ov.hover = key;
      onHover(key);
      redraw();
    }
    if (!d) { tip.hidden = true; live.textContent = ''; return; }
    const one = onlyOne && ov.present.has(d.frame.key);
    tip.textContent = dotText(d.frame, { onlyOne: one });
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(0, d.x - 20), Math.max(0, width - 220))}px`;
    tip.style.top = `${d.y > height / 2 ? d.y - 52 : d.y + 14}px`;
    live.textContent = tip.textContent;
  }

  /** @param {PointerEvent} e */
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    const p = local(e);
    if (p.x < lay.plot.l || p.y < lay.plot.t || p.y > lay.plot.b) return;
    drag = { x: p.x, y: p.y, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (drag && Math.abs(p.y - drag.y) > DRAG_PX) {
      ov.band = { lo: lay.lamOf(drag.y), hi: lay.lamOf(Math.min(lay.plot.b, Math.max(lay.plot.t, p.y))) };
      tip.hidden = true;
      redraw();
      return;
    }
    if (!drag) hoverDot(index.nearest(p.x, p.y));
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const p = local(e), moved = Math.abs(p.y - drag.y) > DRAG_PX;
    drag = null;
    if (moved && ov.band) {
      const band = ov.band;
      onBand(band, framesInBand(frames, band.lo, band.hi));
    } else {
      const i = index.nearest(p.x, p.y);
      if (i >= 0) { pinned = lay.dots[i].frame.key; hoverDot(i); } else { pinned = null; ov.band = null; onBand(null, { all: [], loaded: [] }); hoverDot(-1); }
    }
    redraw();
  });
  canvas.addEventListener('pointercancel', () => { drag = null; ov.band = null; redraw(); });
  canvas.addEventListener('pointerleave', () => { if (!drag && pinned === null) hoverDot(-1); });
  // a tap on a phone: show that photo and keep it
  canvas.addEventListener('click', (e) => {
    if (/** @type {any} */ (e).pointerType !== 'touch' && e.detail !== 0) return;
    const p = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top };
    const i = index.nearest(p.x, p.y, HIT_PX + 6);
    hoverDot(i);
  });
  canvas.addEventListener('keydown', (e) => {
    const loaded = lay.dots.filter((d) => d.frame.loaded).sort((p, q) => p.frame.mjd - q.frame.mjd || p.frame.lam - q.frame.lam);
    if (e.key === 'Escape') { ov.band = null; onBand(null, { all: [], loaded: [] }); hoverDot(-1); return; }
    if (!loaded.length || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const at = loaded.findIndex((d) => d.frame.key === ov.hover);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? loaded.length - 1 : Math.min(loaded.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)));
    hoverDot(lay.dots.indexOf(loaded[at < 0 && e.key === 'ArrowLeft' ? loaded.length - 1 : next]));
  });
  canvas.addEventListener('blur', () => { if (pinned === null) hoverDot(-1); });
  pick.addEventListener('change', () => {
    const det = Number(pick.value);
    if (!pick.value) { ov.band = null; onBand(null, { all: [], loaded: [] }); redraw(); return; }
    const ls = frames.filter((f) => f.det === det).map((f) => f.lam);
    const band = { lo: Math.min(...ls) - 1e-6, hi: Math.max(...ls) + 1e-6 };
    ov.band = band;
    onBand(band, framesInBand(frames, band.lo, band.hi));
    redraw();
  });
  clear.addEventListener('click', () => { ov.band = null; pick.value = ''; onBand(null, { all: [], loaded: [] }); redraw(); });

  const resizer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { col = readColours(wrap); relayout(); }) : null;
  resizer?.observe(wrap);

  return {
    /** @param {MapFrame[]} next */
    setFrames(next) {
      frames = next;
      if (pinned !== null && !frames.some((f) => f.key === pinned)) pinned = null;
      relayout();
      describe();
    },
    /** Photos to mark as lit. @param {Iterable<string>} keys */
    setLit(keys) { ov.lit = new Set(keys); redraw(); },
    /** Photos picked by a band, as the page blinks them. @param {Iterable<string>} keys */
    setSelected(keys) { ov.selected = new Set(keys); clear.hidden = ov.selected.size === 0 && !ov.band; redraw(); },
    /** The photos in which the clicked place shows; null for no place. @param {{keys: Set<string>, checked: number} | null} p */
    setPresent(p) {
      ov.present = p ? p.keys : new Set();
      onlyOne = Boolean(p && p.keys.size === 1 && p.checked >= 2);
      note.textContent = p ? (onlyOne ? 'The place you clicked shows in one photo only.' : `The place you clicked shows in ${p.keys.size} of ${p.checked} loaded photos.`) : '';
      note.dataset.onlyOne = String(onlyOne);
      redraw();
    },
    /** A line about the band picked. @param {string} text */
    setBandNote(text) { bandNote.textContent = text; },
    /** @param {string | null} key  A photo hovered somewhere else. */
    setHover(key) { ov.hover = key; redraw(); },
    /** The dots, as drawn (for tests and for the page). */
    dots: () => lay.dots,
    resize: relayout,
    layout: () => lay,
    destroy() { resizer?.disconnect(); if (queued) cancelAnimationFrame(queued); root.replaceChildren(); root.classList.remove('framemap'); },
  };
}
