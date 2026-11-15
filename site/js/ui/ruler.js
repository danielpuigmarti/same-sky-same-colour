// The colour ruler: one bar of infrared colours from 0.75 to 5.0 µm with the spans of the six detectors on it,
// read from data/wave/tables.json. It is the key for every colour chip: a chip is a swatch in the colour of its
// detector's span and the wavelength in µm, and the ruler shows where that wavelength lies.
//
// Nothing here touches the page until createRuler or colourChip is called, so the rest can be used anywhere.

/** @import { WaveTables, WaveTable, Wavelength, Det } from '../contracts.js' */
import { WAVE_TABLES_FILE } from '../contracts.js';

/** The ends of the ruler, µm: the range the telescope was built for. The bar is widened where a table goes beyond them. */
export const RULER_MIN = 0.75;
export const RULER_MAX = 5.0;

/** Decimals of a wavelength in µm, as shown on chips and in the readout. */
export const COLOUR_DECIMALS = 3;

/**
 * The span of one detector: the smallest and largest wavelength of its table.
 * @typedef {Object} Span
 * @property {Det} det
 * @property {number} min  µm
 * @property {number} max  µm
 */

/**
 * The spans of the six detectors, from the extremes of their tables.
 * @param {WaveTables} tables
 * @returns {Span[]}  Detector 1 first.
 */
export function detectorSpans(tables) {
  /** @type {Span[]} */
  const out = [];
  for (let det = 1; det <= 6; det++) {
    const t = tables[String(det)];
    if (!t) continue;
    let min = Infinity, max = -Infinity;
    for (const row of t.lam) {
      for (const v of row) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    out.push({ det: /** @type {Det} */ (det), min, max });
  }
  return out;
}

/**
 * The two ends of the bar: RULER_MIN and RULER_MAX, widened so that every span fits whole.
 * @param {Span[]} spans
 * @returns {{min: number, max: number}}
 */
export function rulerRange(spans) {
  return {
    min: Math.min(RULER_MIN, ...spans.map((s) => s.min)),
    max: Math.max(RULER_MAX, ...spans.map((s) => s.max)),
  };
}

/**
 * Where a wavelength lies on the bar: 0 at its left end, 1 at its right end; the bar is linear in wavelength.
 * @param {number} lam  µm
 * @param {{min: number, max: number}} range
 * @returns {number}
 */
export function rulerPosition(lam, range) {
  return (lam - range.min) / (range.max - range.min);
}

/**
 * The cell of a grid that holds a position, and how far into the cell it lies (0 to 1). Outside the grid the
 * first or last cell is extended.
 * @param {number[]} knots  Increasing. @param {number} p
 * @returns {[number, number]}
 */
function cellOf(knots, p) {
  let k = 0;
  while (k < knots.length - 2 && p >= knots[k + 1]) k++;
  return [k, (p - knots[k]) / (knots[k + 1] - knots[k])];
}

/**
 * Wavelength and bandwidth at a pixel of a detector (CT-3): linear in x and in y inside each cell of the table.
 * @param {WaveTable} table
 * @param {number} x  0-based full-frame pixel.
 * @param {number} y  0-based full-frame pixel.
 * @returns {Wavelength}
 */
export function tableColour(table, x, y) {
  const [j, b] = cellOf(table.X, x + 1), [i, a] = cellOf(table.Y, y + 1); // the tables count pixels from 1
  /** @param {number[][]} g */
  const at = (g) => (1 - a) * ((1 - b) * g[i][j] + b * g[i][j + 1]) + a * ((1 - b) * g[i + 1][j] + b * g[i + 1][j + 1]);
  return { lam: at(table.lam), bw: at(table.bw) };
}

/**
 * The function of CT-3 for a set of tables. A detector without a table gives NaN, never an exception.
 * @param {WaveTables} tables
 * @returns {(det: Det, x: number, y: number) => Wavelength}
 */
export function colourLookup(tables) {
  return (det, x, y) => {
    const t = tables[String(det)];
    return t && Number.isFinite(x) && Number.isFinite(y) ? tableColour(t, x, y) : { lam: NaN, bw: NaN };
  };
}

/**
 * Fetch the tables. Null when they cannot be had; the page then shows chips without a ruler.
 * @param {string | URL} [url]  Address of tables.json; by default the file of this site, seen from a page in its top folder.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<WaveTables | null>}
 */
export async function loadTables(url = WAVE_TABLES_FILE, fetchFn = globalThis.fetch) {
  try {
    const r = await fetchFn(String(url));
    if (!r.ok) return null;
    const tables = await r.json();
    for (let det = 1; det <= 6; det++) {
      const t = tables?.[String(det)];
      if (!t || !Array.isArray(t.X) || !Array.isArray(t.Y) || !Array.isArray(t.lam) || !Array.isArray(t.bw)) return null;
    }
    return tables;
  } catch {
    return null;
  }
}

/**
 * A wavelength as text: "4.296 µm".
 * @param {number} lam  µm
 * @returns {string}
 */
export function formatColour(lam) {
  return Number.isFinite(lam) ? `${lam.toFixed(COLOUR_DECIMALS)} µm` : 'colour unknown';
}

/**
 * A colour chip: a swatch in the colour of the detector's span, and the wavelength.
 * @param {number} lam  µm
 * @param {number} det  Detector, 1 to 6.
 * @returns {HTMLSpanElement}
 */
export function colourChip(lam, det) {
  const chip = document.createElement('span');
  chip.className = 'colour-chip';
  chip.dataset.det = String(det);
  chip.dataset.lam = String(lam);
  const swatch = document.createElement('span');
  swatch.className = 'colour-chip-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'colour-chip-text';
  text.textContent = formatColour(lam);
  chip.append(swatch, text);
  return chip;
}

/**
 * A mark on the ruler.
 * @typedef {Object} RulerMark
 * @property {number} lam  µm
 * @property {string} [label]  What the mark is, for the description of the ruler ("earlier visit").
 */

/**
 * Draw the ruler into `root`.
 * @param {HTMLElement} root
 * @param {WaveTables} tables
 * @returns {{el: HTMLElement, spans: Span[], range: {min: number, max: number}, setMarks: (marks: RulerMark[]) => void}}
 */
export function createRuler(root, tables) {
  const spans = detectorSpans(tables), range = rulerRange(spans);
  /** @param {number} lam */
  const percent = (lam) => `${(100 * rulerPosition(lam, range)).toFixed(3)}%`;

  const el = document.createElement('div');
  el.className = 'ruler';
  el.setAttribute('role', 'img');

  const bar = document.createElement('div');
  bar.className = 'ruler-bar';
  for (const s of spans) {
    const part = document.createElement('span');
    part.className = 'ruler-span';
    part.dataset.det = String(s.det);
    part.dataset.min = String(s.min);
    part.dataset.max = String(s.max);
    part.style.left = percent(s.min);
    part.style.width = `${(100 * (rulerPosition(s.max, range) - rulerPosition(s.min, range))).toFixed(3)}%`;
    bar.append(part);
  }
  const marksEl = document.createElement('div');
  marksEl.className = 'ruler-marks';
  bar.append(marksEl);

  const ticks = document.createElement('div');
  ticks.className = 'ruler-ticks';
  ticks.setAttribute('aria-hidden', 'true');
  // the two ends, and the whole numbers between them that stand clear of the ends
  /** @type {number[]} */
  const at = [RULER_MIN];
  for (let v = Math.ceil(RULER_MIN); v < RULER_MAX; v++) if (v - RULER_MIN >= 0.5 && RULER_MAX - v >= 0.5) at.push(v);
  at.push(RULER_MAX);
  for (const [i, v] of at.entries()) {
    const tick = document.createElement('span');
    tick.className = 'ruler-tick';
    tick.style.left = percent(v);
    tick.textContent = i === at.length - 1 ? `${v} µm` : String(v);
    ticks.append(tick);
  }
  el.append(bar, ticks);
  root.append(el);

  /** @param {RulerMark[]} marks */
  function setMarks(marks) {
    marksEl.replaceChildren();
    const shown = marks.filter((m) => Number.isFinite(m.lam));
    for (const m of shown) {
      const mark = document.createElement('span');
      mark.className = 'ruler-mark';
      mark.dataset.lam = String(m.lam);
      mark.style.left = percent(m.lam);
      marksEl.append(mark);
    }
    const what = shown.map((m) => (m.label ? `${m.label}: ${formatColour(m.lam)}` : formatColour(m.lam))).join('; ');
    el.setAttribute('aria-label', `Colour ruler: infrared colours from ${RULER_MIN} to ${RULER_MAX} µm, in six parts, one for each detector.${what ? ` Marked: ${what}.` : ''}`);
  }
  setMarks([]);

  return { el, spans, range, setMarks };
}
