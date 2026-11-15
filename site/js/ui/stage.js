// The stage: two visits of one sky position at one colour, drawn so that nothing but the sky can look like change.
//
// What it promises, and what the tests read back:
//   - every square on the screen is one pixel of a stamp (nearest neighbour, never rotated). "Smooth pixels" lets
//     the browser smooth the enlarged picture instead: that changes the screen and nothing else;
//   - one display rule for the whole view: black and white points from the pixels of both pictures together,
//     an asinh curve between, so a pixel value has one grey whichever picture and whichever mode it is in;
//   - Blink changes picture at most MAX_FLIPS_PER_SECOND times a second, whoever asks for the change;
//   - the curtain takes whole columns from one picture or the other, so at its two ends it is one picture;
//   - the difference is drawn in units of the noise on a fixed scale, grey below DIFF_GREY_BELOW;
//   - saturated pixels are hatched one way and damaged ones the other way, from the one table of flags
//     (lib/flags.js); known sources are marked only on request; pixels whose colours differ between the two
//     visits are veiled.
// The stage draws; it computes nothing about the sky. Co-adds, differences and the mask of matched colours are
// handed to it.
//
// The first half of this file has no need of a page (constants, the display rule, masks, geometry);
// createStage, in the second half, builds the stage in a page.

/** @import { Stamp } from '../contracts.js' */
import { DIFF_RANGE, MATCH_BANDWIDTH_FRACTION } from '../contracts.js';
import { SATURATION_MASK, DEFECT_MASK, SOURCE_MASK } from '../lib/flags.js';
import { colourChip } from './ruler.js';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Size of a detector pixel on the sky, arcsec: the pixel scale of the spectral images in the archive's documentation. */
export const PIXEL_ARCSEC = 6.15;

/** White is the value at this percentile of the pixels shown; black the value at the percentile 100 minus this. */
export const STRETCH_PERCENTILE = 99.5;

/** The curve between black and white: asinh(q t) / asinh(q) for t from 0 to 1, with this q. */
export const STRETCH_SOFTENING = 10;

/** Blink never changes picture more often than this. */
export const MAX_FLIPS_PER_SECOND = 2;

/** The shortest time between two changes of picture, ms. */
export const MIN_FLIP_MS = 1000 / MAX_FLIPS_PER_SECOND;

/** How long Blink shows each picture when it plays, ms. */
export const FLIP_MS = 800;

/** The steps of the white point: the percentile of the pixels shown that is white (the first is the default), and the last, the brightest pixel with a little room above it. */
export const WHITE_STEPS = Object.freeze([
  { label: '99.5', percentile: 99.5 },
  { label: '99.9', percentile: 99.9 },
  { label: '99.99', percentile: 99.99 },
  { label: 'Peak', percentile: 100 },
]);

/** At the last step white lies this share of the range above the brightest pixel, so that the brightest pixel is not white. */
export const WHITE_HEADROOM = 0.1;

/** How long Blink shows each picture, ms, for the three speeds; Normal is FLIP_MS. */
export const SPEEDS = Object.freeze({ slow: 1600, normal: FLIP_MS, fast: MIN_FLIP_MS });

/** A difference smaller than this many times the noise is drawn grey. */
export const DIFF_GREY_BELOW = 3;

/** Where the ticks beside a marked place start and end, in pixels of the picture from the place. */
export const MARK_NEAR = 2, MARK_FAR = 4.5;

/** The grey of a difference of zero, and how far the grey moves from it at DIFF_GREY_BELOW (of 255). */
const DIFF_GREY_ZERO = 72, DIFF_GREY_SWING = 24;
/** How much of the full colour a difference has just above DIFF_GREY_BELOW; it is full at DIFF_RANGE. */
const DIFF_COLOUR_START = 0.35;

// A picture stands on a plate: a black frame that also holds its scale bar and its compass, with a row of cells
// joined under it. On a wide window the scale bar and the compass stand in a margin at the right of the picture, so
// that the picture can be as tall as the window allows; otherwise in a strip under it. All in CSS px; stage.css
// reads them as --plate-margin and --plate-strip.
/** The margin at the right of a picture, at least. */
const PLATE_MARGIN = 128;
/** With that margin a plate is never narrower than this: the room its row of cells needs to stay one row. */
const PLATE_MIN_WIDTH = 496;
/** The strip under a picture. */
const PLATE_STRIP = 64;
/** One row of the cells under a plate, with its rule. */
const PLATE_ROW = 36;
/** What is kept free between a plate and the lower edge of the window. */
const PLATE_BOTTOM = 8;
/** The room under a plate for its buttons, and the width a plate beside the desk has at least, CSS px. */
const PLATE_BUTTONS = 64;
const PLATE_LEAST = 560;
/** The room at each side of a scale bar inside the margin. */
const PLATE_PAD = 12;

/** What each view does, in one line: said under the row of views. */
const MODE_HINTS = Object.freeze({
  blink: 'Blink shows the earlier and the later visit in turn, on one grey scale. Look for a pixel that is not the same in both.',
  curtain: 'Curtain puts the earlier visit left of the line and the later visit right of it. Drag the line across the picture, or move the slider.',
  side: 'Side by side shows the two visits next to each other, on one grey scale.',
  diff: 'Difference is the later visit minus the earlier one, in units of the noise: what got brighter and what got fainter.',
});

/**
 * The colours the stage paints with, as [red, green, blue]. In a page they are read from the tokens.
 * @typedef {Object} Palette
 * @property {[number, number, number]} neg  A difference below zero (fainter).
 * @property {[number, number, number]} pos  A difference above zero (brighter).
 * @property {[number, number, number]} none  A pixel without a value.
 */

/** @type {Palette}  The values of --color-diff-neg, --color-diff-pos and --color-line, as a plate has them. */
export const DEFAULT_PALETTE = Object.freeze({ neg: [79, 157, 255], pos: [255, 154, 61], none: [59, 53, 33] });

// ---------------------------------------------------------------------------------------------
// What the stage is given
// ---------------------------------------------------------------------------------------------

/**
 * The sky around the target of a picture, as a flat approximation: pixel (tx, ty) is at (ra, dec), and one pixel
 * to the right moves cd[0] degrees east and cd[2] degrees north; one pixel up moves cd[1] east and cd[3] north.
 * See localSky in ui/hover.js for how to make one from the transform of a frame.
 * @typedef {Object} LocalSky
 * @property {number} ra  Degrees (ICRS).
 * @property {number} dec  Degrees (ICRS).
 * @property {[number, number, number, number]} cd  [east per x, east per y, north per x, north per y], degrees per pixel.
 */

/**
 * A place to mark beside, such as where a known fast star should be on the date of the picture.
 * @typedef {Object} Mark
 * @property {number} x  Pixel of the picture, whole numbers at pixel centres; may be a fraction.
 * @property {number} y
 * @property {string} name  What is expected there.
 */

/**
 * What a picture may carry beyond the fields of a stamp.
 * @typedef {Object} PictureExtras
 * @property {LocalSky | null} [sky]  Without it there is no compass and no sky position in the readout.
 * @property {Uint8Array | null} [matched]  w*h values: 1 where the colours of the two visits match, 0 where they differ (veiled).
 * @property {number} [photos]  How many photos were added up to make it; 1 or absent for a single photo.
 * @property {Uint8Array | null} [blank]  w*h values: 1 where a pixel has no value for a reason other than being too
 *   bright (it lies outside the photo, or a flag that is drawn says why); such a pixel is not hatched as saturated.
 * @property {Mark[]} [marks]  Places to mark with ticks set off from them.
 * @property {Int32Array} [sx]  For a picture on the display grid: the column of the stamp pixel behind each pixel, -1 for none.
 * @property {Int32Array} [sy]  The row of that pixel.
 * @property {number} [sw]  Width of the stamp the picture was made from.
 * @property {number} [sh]  Height of that stamp.
 * @property {Picture[]} [members]  For a co-add: the photos it is made of, on the same grid.
 */

/**
 * One picture on the stage: a stamp (CT-4), or a co-add handed over in the same form (key '' when it has no
 * single file; x0 and y0 NaN when its pixels are not pixels of one frame).
 * @typedef {Stamp & PictureExtras} Picture
 */

/**
 * The difference of the two visits on one sky grid: later minus earlier, in units of the noise.
 * @typedef {Object} DifferencePicture
 * @property {number} w
 * @property {number} h
 * @property {Float32Array} data  w*h values in units of the noise, row by row, first row at the lowest y; NaN where there is none.
 * @property {number} tx  The target's x in pixels of this grid.
 * @property {number} ty
 * @property {number} [sigma]  The noise that one unit stands for, MJy/sr.
 * @property {LocalSky | null} [sky]
 * @property {Uint8Array | null} [matched]
 * @property {Uint8Array | null} [blank]  1 where a pixel was not compared for a reason that needs no mark of its own (see Picture).
 * @property {Mark[]} [marks]
 */

/**
 * What the stage shows.
 * @typedef {Object} StageView
 * @property {Picture} a  The earlier visit.
 * @property {Picture} b  The later visit.
 * @property {DifferencePicture | null} [diff]  Without it the Difference view says that there is none.
 * @property {string} [note]  A line shown under the pictures, such as how well the two visits line up.
 * @property {string} [diffNote]  Why there is no difference picture, in place of the stage's own words.
 * @property {{why: string, href: string, label: string} | null} [diffOff]  The Difference view is switched off for
 *   this view: one line that says why, and a link (address and words) to the check behind it.
 */

/** @typedef {'blink' | 'diff' | 'curtain' | 'side'} StageMode  The views the stage has. */

export const STAGE_MODES = Object.freeze(/** @type {StageMode[]} */ (['blink', 'diff', 'curtain', 'side']));

// ---------------------------------------------------------------------------------------------
// The display rule
// ---------------------------------------------------------------------------------------------

/**
 * The value at a percentile of sorted values, linear between neighbours (as numpy.percentile does).
 * @param {ArrayLike<number>} sorted  Increasing. @param {number} p  0 to 100.
 * @returns {number}
 */
export function percentileOf(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const at = (n - 1) * p / 100, i = Math.floor(at);
  return i + 1 < n ? sorted[i] + (at - i) * (sorted[i + 1] - sorted[i]) : sorted[n - 1];
}

/**
 * The black and white points of a view: the percentiles 100 - p and p of the finite values of all its pictures
 * taken together. One rule for the whole view. Pictures without a finite value give 0 and 1.
 * @param {ArrayLike<number>[]} arrays  The values of every picture of the view.
 * @param {number} [p]
 * @returns {{lo: number, hi: number}}
 */
export function displayLimits(arrays, p = STRETCH_PERCENTILE) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const all = new Float64Array(n);
  let k = 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) all[k++] = a[i];
  if (k === 0) return { lo: 0, hi: 1 };
  const sorted = all.subarray(0, k).sort();
  const lo = percentileOf(sorted, 100 - p), hi = percentileOf(sorted, p);
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

/**
 * The limits of a view at a step of the white point: black as displayLimits gives it; white higher at each step,
 * and at the last one above the brightest pixel. One set of limits for every picture of the view.
 * @param {ArrayLike<number>[]} arrays @param {number} [step]  0 to WHITE_STEPS.length - 1; 0 is displayLimits.
 * @returns {{lo: number, hi: number}}
 */
export function whiteLimits(arrays, step = 0) {
  const base = displayLimits(arrays);
  const at = Math.min(WHITE_STEPS.length - 1, Math.max(0, Math.round(step) || 0));
  if (at === 0) return base;
  const p = WHITE_STEPS[at].percentile;
  const top = displayLimits(arrays, p).hi;
  if (p < 100) return { lo: base.lo, hi: Math.max(base.hi, top) };
  const range = Math.max(top - base.lo, 1e-9);
  return { lo: base.lo, hi: Math.max(base.hi, top + WHITE_HEADROOM * range) };
}

const ASINH_Q = Math.asinh(STRETCH_SOFTENING);

/**
 * The grey of a value, 0 (black) to 255 (white): 0 at or below lo, 255 at or above hi, an asinh curve between.
 * @param {number} v @param {number} lo @param {number} hi
 * @returns {number}  A whole number.
 */
export function stretchByte(v, lo, hi) {
  const t = (v - lo) / (hi - lo);
  if (!(t > 0)) return 0;
  if (t >= 1) return 255;
  return Math.round(255 * Math.asinh(STRETCH_SOFTENING * t) / ASINH_Q);
}

/**
 * A picture as the bytes of a canvas: red, green, blue, alpha for each pixel, the top row first (the values have
 * the bottom row first). A pixel without a value gets the colour `none`.
 * @param {ArrayLike<number>} data  w*h values.
 * @param {number} w @param {number} h
 * @param {{lo: number, hi: number}} limits
 * @param {[number, number, number]} [none]
 * @param {boolean} [invert]  Dark for bright: 255 minus the grey.
 * @returns {Uint8ClampedArray}
 */
export function greyRgba(data, w, h, limits, none = DEFAULT_PALETTE.none, invert = false) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x], o = ((h - 1 - y) * w + x) * 4;
      if (Number.isFinite(v)) {
        const g = invert ? 255 - stretchByte(v, limits.lo, limits.hi) : stretchByte(v, limits.lo, limits.hi);
        out[o] = g; out[o + 1] = g; out[o + 2] = g;
      } else {
        out[o] = none[0]; out[o + 1] = none[1]; out[o + 2] = none[2];
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * The colour of a difference of `u` times the noise: grey while |u| is below DIFF_GREY_BELOW (darker below zero,
 * lighter above), then the colour of its sign, full at DIFF_RANGE and beyond.
 * @param {number} u
 * @param {Palette} [palette]
 * @returns {[number, number, number]}
 */
export function diffRgb(u, palette = DEFAULT_PALETTE) {
  if (!Number.isFinite(u)) return [palette.none[0], palette.none[1], palette.none[2]];
  const size = Math.abs(u);
  if (size < DIFF_GREY_BELOW) {
    const g = Math.round(DIFF_GREY_ZERO + DIFF_GREY_SWING * (u / DIFF_GREY_BELOW));
    return [g, g, g];
  }
  const edge = DIFF_GREY_ZERO + (u > 0 ? DIFF_GREY_SWING : -DIFF_GREY_SWING);
  const full = u > 0 ? palette.pos : palette.neg;
  const f = DIFF_COLOUR_START + (1 - DIFF_COLOUR_START) * Math.min(1, (size - DIFF_GREY_BELOW) / (DIFF_RANGE - DIFF_GREY_BELOW));
  /** @param {number} c */
  const mix = (c) => Math.round(edge + f * (full[c] - edge));
  return [mix(0), mix(1), mix(2)];
}

/**
 * A difference as the bytes of a canvas, the top row first.
 * @param {ArrayLike<number>} data  w*h values in units of the noise.
 * @param {number} w @param {number} h
 * @param {Palette} [palette]
 * @returns {Uint8ClampedArray}
 */
export function diffRgba(data, w, h, palette = DEFAULT_PALETTE) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = diffRgb(data[y * w + x], palette), o = ((h - 1 - y) * w + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Masks, the curtain, geometry
// ---------------------------------------------------------------------------------------------

/**
 * The marks of a picture, each w*h values with 1 where the mark is drawn.
 * @typedef {Object} Masks
 * @property {Uint8Array} saturated  A flag of the tier "saturation" is set, or the pixel has no value.
 * @property {Uint8Array} defect  A flag of the tier "defect" is set.
 * @property {Uint8Array | null} source  The SOURCE flag is set; null when the picture has no flags.
 * @property {Uint8Array | null} veiled  The colours of the two visits differ; null when no mask was given.
 */

/**
 * The pixels of a picture that are marked. A pixel without a value counts as saturated: in the frames a missing
 * value is the core of a star that filled its pixel, and without flags the image is all there is to go by. A
 * picture on the display grid says which of its pixels have no value for another reason (`blank`): those are left
 * as they are, "no data", unless a flag marks them.
 * @param {{data: ArrayLike<number>, flags?: Int32Array | null, matched?: Uint8Array | null, blank?: Uint8Array | null}} picture
 * @returns {Masks}
 */
export function pictureMasks(picture) {
  const n = picture.data.length, flags = picture.flags ?? null, matched = picture.matched ?? null, blank = picture.blank ?? null;
  const saturated = new Uint8Array(n), defect = new Uint8Array(n);
  const source = flags ? new Uint8Array(n) : null, veiled = matched ? new Uint8Array(n) : null;
  for (let i = 0; i < n; i++) {
    const word = flags ? flags[i] : 0;
    if ((!Number.isFinite(picture.data[i]) && !(blank && blank[i])) || (word & SATURATION_MASK) !== 0) saturated[i] = 1;
    if ((word & DEFECT_MASK) !== 0) defect[i] = 1;
    if (source && (word & SOURCE_MASK) !== 0) source[i] = 1;
    if (veiled && matched && !matched[i]) veiled[i] = 1;
  }
  return { saturated, defect, source, veiled };
}

/**
 * How many columns the curtain takes from the earlier picture: a whole number from 0 to w.
 * @param {number} fraction  0 to 1. @param {number} w
 * @returns {number}
 */
export function curtainSplit(fraction, w) {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0.5)) * w);
}

/**
 * The curtain: the columns left of `split` from `a`, the others from `b`. Works for values (stride 1) and for
 * canvas bytes (stride 4); rows may be in either order, as long as both have the same.
 * @template {Float32Array | Uint8Array | Uint8ClampedArray} T
 * @param {T} a @param {T} b
 * @param {number} w @param {number} h
 * @param {number} split  Columns taken from `a`, 0 to w.
 * @param {number} [stride]
 * @returns {T}
 */
export function curtainOf(a, b, w, h, split, stride = 1) {
  const out = /** @type {T} */ (a.slice());
  for (let y = 0; y < h; y++) {
    const row = y * w * stride;
    for (let i = row + split * stride; i < row + w * stride; i++) out[i] = b[i];
  }
  return out;
}

/**
 * The outline of the pixels set in a mask, as the path of an SVG whose user unit is one pixel and whose top left
 * is the top left of the picture: one rectangle for each run of set pixels in a row.
 * @param {ArrayLike<number> | null} mask  w*h values, first row at the lowest y.
 * @param {number} w @param {number} h
 * @returns {string}
 */
export function maskPath(mask, w, h) {
  if (!mask) return '';
  let d = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      let end = x + 1;
      while (end < w && mask[y * w + end]) end++;
      d += `M${x} ${h - 1 - y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  }
  return d;
}

/**
 * The ticks beside marked places, as the path of an SVG whose user unit is one pixel and whose top left is the top
 * left of the picture: one tick to the left of each place and one below it, set off from the place so that nothing
 * is drawn on it. Marks outside the columns `from` (included) to `to` (excluded) are left out.
 * @param {Mark[] | null | undefined} marks
 * @param {number} h  Rows of the picture.
 * @param {number} [from] @param {number} [to]
 * @returns {string}
 */
export function marksPath(marks, h, from = -Infinity, to = Infinity) {
  let d = '';
  for (const m of marks ?? []) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || m.x < from || m.x >= to) continue;
    const x = m.x + 0.5, y = h - (m.y + 0.5);
    d += `M${(x - MARK_FAR).toFixed(2)} ${y.toFixed(2)}H${(x - MARK_NEAR).toFixed(2)}M${x.toFixed(2)} ${(y + MARK_NEAR).toFixed(2)}V${(y + MARK_FAR).toFixed(2)}`;
  }
  return d;
}

/**
 * A scale bar for a picture `w` pixels wide: the longest round length that is at most three tenths of its width.
 * @param {number} w
 * @param {number} [pixelArcsec]
 * @returns {{arcsec: number, pixels: number}}
 */
export function scaleBar(w, pixelArcsec = PIXEL_ARCSEC) {
  const room = 0.3 * w * pixelArcsec;
  let arcsec = 1;
  for (const round of [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600]) if (round <= room) arcsec = round;
  return { arcsec, pixels: arcsec / pixelArcsec };
}

/**
 * Which way north and east point in a picture, as unit vectors in its pixels (x to the right, y up).
 * Null without a transform, or with one that cannot be inverted.
 * @param {LocalSky | null | undefined} sky
 * @returns {{north: [number, number], east: [number, number]} | null}
 */
export function compassOf(sky) {
  if (!sky || !Array.isArray(sky.cd) || sky.cd.length !== 4 || !sky.cd.every(Number.isFinite)) return null;
  const [eastX, eastY, northX, northY] = sky.cd;
  const det = eastX * northY - eastY * northX;
  if (!(Math.abs(det) > 0)) return null;
  /** @param {number} x @param {number} y @returns {[number, number]} */
  const unit = (x, y) => { const len = Math.hypot(x, y); return [x / len, y / len]; };
  // the pixel step that moves one unit north and none east, and the one that moves one unit east and none north
  return { north: unit(-eastY / det, eastX / det), east: unit(northY / det, -northX / det) };
}

/**
 * How far apart the colours of two pictures are, and how far apart they may be to count as the same colour
 * (CT-6: MATCH_BANDWIDTH_FRACTION of the smaller bandwidth). Null when a colour is unknown.
 * @param {{lam: number, bw: number}} a @param {{lam: number, bw: number}} b
 * @returns {{apart: number, allowed: number, same: boolean} | null}
 */
export function colourMatch(a, b) {
  if (![a.lam, a.bw, b.lam, b.bw].every(Number.isFinite)) return null;
  const apart = Math.abs(a.lam - b.lam), allowed = MATCH_BANDWIDTH_FRACTION * Math.min(a.bw, b.bw);
  return { apart, allowed, same: apart <= allowed };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A time as a date on screen: "25 Aug 2025", or with the time of day "25 Aug 2025, 17:09 UTC".
 * @param {number} mjd  MJD (UTC).
 * @param {boolean} [withTime]
 * @returns {string}
 */
export function formatDate(mjd, withTime = false) {
  if (!Number.isFinite(mjd)) return 'date unknown';
  const d = new Date(Math.round((mjd - 40587) * 86400000));
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return day;
  return `${day}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * A colour written as #rrggbb, as [red, green, blue]; null for anything else.
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseHexColour(text) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// ---------------------------------------------------------------------------------------------
// The stage in a page
// ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
let stageCount = 0;

/**
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined>} [attrs]  `class`, `text`, and attributes; null, undefined and false are left out.
 * @param {(Node | string | null | undefined)[]} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {(Node | null)[]} [children]
 * @returns {SVGElement}
 */
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  for (const child of children) if (child) node.append(child);
  return node;
}

/**
 * One picture as it is drawn: its bytes, its masks and their outlines.
 * @typedef {Object} Layer
 * @property {'a' | 'b' | 'diff'} kind
 * @property {Picture | DifferencePicture} picture
 * @property {number} w @property {number} h
 * @property {Uint8ClampedArray} rgba
 * @property {Masks} masks
 */

/**
 * What a pointer is over.
 * @typedef {Object} StagePoint
 * @property {'a' | 'b' | 'diff'} kind  Which picture.
 * @property {Picture | DifferencePicture} picture
 * @property {number} x  Column of the pixel in the picture.
 * @property {number} y  Row of the pixel, counted from the lowest row.
 * @property {boolean} [touch]  The pointer is a finger or a pen, not a mouse.
 */

/**
 * What is on a canvas now, for whoever wants to check it.
 * @typedef {Object} PanelReadback
 * @property {'a' | 'b' | 'curtain' | 'diff'} kind
 * @property {number} w @property {number} h
 * @property {Float32Array} values  The values the canvas was drawn from: for one picture, its own array.
 * @property {Uint8ClampedArray} rgba  The bytes the canvas holds, the top row first.
 * @property {Uint8Array} saturated  1 where the hatching of saturated pixels is drawn.
 * @property {Uint8Array} defect  1 where the hatching of damaged pixels is drawn.
 * @property {Uint8Array | null} veiled  1 where the veil is drawn; null when there is no mask.
 * @property {Uint8Array | null} source  1 where known sources are marked; null while they are not shown.
 * @property {number} cssWidth  Width of the picture on the page, CSS px.
 * @property {string} caption
 */

/**
 * @typedef {Object} StageOptions
 * @property {StageMode} [mode]  The view to open with (default blink).
 * @property {boolean} [reducedMotion]  Step mode: Blink never plays by itself. Default: what the browser says the visitor asked for.
 * @property {boolean} [autoplay]  Blink plays as soon as there is something to show (default true; never under reduced motion).
 * @property {(mode: StageMode) => void} [onMode]  Called when the view changes.
 * @property {boolean} [smooth]  Open with "Smooth pixels" on (default off).
 * @property {(on: boolean) => void} [onSmooth]  Called when the visitor switches "Smooth pixels".
 * @property {number} [white]  Open with this step of the white point (default 0).
 * @property {(step: number) => void} [onWhite]  Called when the visitor chooses a step of the white point.
 * @property {'slow' | 'normal' | 'fast'} [speed]  Open at this speed of Blink (default normal).
 * @property {(speed: 'slow' | 'normal' | 'fast') => void} [onSpeed]
 * @property {boolean} [invert]  Open with the pictures inverted (default off).
 * @property {(on: boolean) => void} [onInvert]
 * @property {(point: StagePoint | null) => void} [onPoint]  Called with the pixel under the pointer, and null when it leaves.
 * @property {(side: "a" | "b") => void} [onSide]  Called when Blink shows the other visit.
 * @property {(point: StagePoint) => void} [onPick]  Called with the pixel the visitor clicked or tapped.
 * @property {() => void} [onUnpick]  Called when Escape takes the mark of that pixel away.
 * @property {Palette} [palette]  Default: read from the tokens of the page.
 */

/**
 * Build the stage inside `root`.
 * @param {HTMLElement} root
 * @param {StageOptions} [options]
 */
export function createStage(root, options = {}) {
  const id = ++stageCount;
  const win = root.ownerDocument.defaultView ?? window;
  const motionQuery = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = options.reducedMotion ?? Boolean(motionQuery?.matches);

  // the colours are read as a plate has them: a plate keeps the inks of the night in both editions of the page
  const probe = root.appendChild(el('span', { 'data-plate': true, hidden: true }));
  const style = win.getComputedStyle(probe);
  /** @type {Palette} */
  const palette = options.palette ?? {
    neg: parseHexColour(style.getPropertyValue('--color-diff-neg')) ?? DEFAULT_PALETTE.neg,
    pos: parseHexColour(style.getPropertyValue('--color-diff-pos')) ?? DEFAULT_PALETTE.pos,
    none: parseHexColour(style.getPropertyValue('--color-line')) ?? DEFAULT_PALETTE.none,
  };
  probe.remove();

  // ---- state
  /** @type {StageView | null} */
  let view = null;
  /** @type {StageMode} */
  let mode = options.mode && STAGE_MODES.includes(options.mode) ? options.mode : 'blink';
  /** @type {StageMode} */
  let modeBeforeDiff = mode === 'diff' ? 'blink' : mode;
  /** @type {'a' | 'b'} */
  let side = 'a';
  let playing = false;
  let split = 0;
  let showSource = false;
  /** "Smooth pixels": how the browser enlarges the pictures on the screen. Their values stay as they are. */
  let smooth = Boolean(options.smooth);
  let limits = { lo: 0, hi: 1 };
  let white = Math.min(WHITE_STEPS.length - 1, Math.max(0, Math.round(options.white ?? 0) || 0));
  /** @type {'slow' | 'normal' | 'fast'} */
  let speed = options.speed && Object.hasOwn(SPEEDS, options.speed) ? options.speed : 'normal';
  let invert = Boolean(options.invert);
  /** @type {{a: Layer, b: Layer, diff: Layer | null} | null} */
  let layers = null;
  let flips = 0;
  let lastFlip = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let playTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingFlip = null;
  /** True once the visitor has stopped the blink; it then stays stopped until they start it. */
  let stopped = false;
  /** @type {{panel: number, x: number, y: number} | null} The pixel the pointer rests on. */
  let hoverAt = null;
  /** @type {{x: number, y: number, w: number, h: number} | null} The pixel the visitor clicked, marked on every picture until the next click or Escape. */
  let picked = null;
  let touching = false; // the last pointer event was not a mouse
  let destroyed = false;

  // ---- the parts that are always there
  root.classList.add('stage');
  root.dataset.mode = mode;
  if (!root.hasAttribute('aria-label')) root.setAttribute('aria-label', 'Two visits at one colour');

  /** @type {Record<StageMode, HTMLButtonElement>} */
  const modeButtons = /** @type {any} */ ({});
  /** @param {StageMode} m @param {string} label */
  const modeButton = (m, label) => {
    const b = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'stage-mode', 'data-mode': m, 'aria-pressed': 'false', text: label }));
    b.addEventListener('click', () => setMode(m));
    modeButtons[m] = b;
    return b;
  };
  // the views stand in one row; the one that is on is filled, and a line under the row says what it does
  const hint = el('p', { class: 'stage-hint', id: `stage-hint-${id}` });
  const modes = el('div', { class: 'choice stage-modes', role: 'group', 'aria-label': 'View', 'aria-describedby': `stage-hint-${id}` }, [
    modeButton('blink', 'Blink'), modeButton('curtain', 'Curtain'), modeButton('side', 'Side by side'), modeButton('diff', 'Difference'),
  ]);

  const playButton = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn transport-play stage-play', text: 'PLAY' }));
  const stepButton = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn stage-step', text: 'STEP' }));
  const playBox = el('div', { class: 'transport stage-playback', role: 'group', 'aria-label': 'Blink' }, [playButton, stepButton]);
  playButton.addEventListener('click', () => (playing ? pause() : play()));
  stepButton.addEventListener('click', () => step());

  const curtainInput = /** @type {HTMLInputElement} */ (el('input', { type: 'range', class: 'stage-curtain-input', min: 0, max: 1, step: 1, value: 0, id: `stage-curtain-${id}` }));
  const curtainBox = el('div', { class: 'stage-curtain' }, [
    el('label', { for: `stage-curtain-${id}`, text: 'Curtain: earlier visit on the left, later visit on the right' }),
    curtainInput,
  ]);
  curtainInput.addEventListener('input', () => setCurtainColumns(Number(curtainInput.value)));

  // how the pictures are enlarged on the screen: a square for each pixel, or smoothed. The values do not change.
  const smoothButton = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn btn-toggle stage-smooth', 'aria-pressed': 'false', 'aria-describedby': `stage-smooth-hint-${id}` }, [
    el('span', { class: 'btn-lamp', 'aria-hidden': 'true' }), el('span', { text: 'Smooth pixels' }),
  ]));
  const displayBox = el('div', { class: 'stage-display' }, [
    smoothButton,
    el('p', { class: 'stage-smooth-hint', id: `stage-smooth-hint-${id}`, text: 'Display only: the values under the pointer do not change.' }),
  ]);
  smoothButton.addEventListener('click', () => setSmooth(!smooth));

  // how the two pictures are drawn, alike: where white is, how fast Blink goes, and light for dark
  /** @param {string} name @param {HTMLElement} group @returns {HTMLElement} */
  const labelled = (name, group) => el('div', { class: 'stage-setting' }, [el('p', { class: 'stage-setting-name', text: name }), group]);
  const whiteButtons = WHITE_STEPS.map((step, i) => {
    const b = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'stage-white', 'data-white': i, 'aria-pressed': 'false', text: step.label }));
    b.addEventListener('click', () => setWhite(i));
    return b;
  });
  const whiteGroup = el('div', { class: 'choice stage-whites', role: 'group', 'aria-label': 'White point: the share of pixels shown below white, or the brightest pixel' }, whiteButtons);
  const speedButtons = /** @type {const} */ (['slow', 'normal', 'fast']).map((name) => {
    const b = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'stage-speed', 'data-speed': name, 'aria-pressed': 'false', text: name[0].toUpperCase() + name.slice(1) }));
    b.addEventListener('click', () => setSpeed(name));
    return b;
  });
  const speedGroup = el('div', { class: 'choice stage-speeds', role: 'group', 'aria-label': 'Speed of Blink' }, speedButtons);
  const invertButton = /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: 'btn btn-toggle stage-invert', 'aria-pressed': 'false' }, [
    el('span', { class: 'btn-lamp', 'aria-hidden': 'true' }), el('span', { text: 'Invert' }),
  ]));
  invertButton.addEventListener('click', () => setInvert(!invert));
  const settings = el('div', { class: 'stage-settings' }, [
    labelled('White point (percentile)', whiteGroup), labelled('Speed', speedGroup), labelled('Grey scale', invertButton),
  ]);
  const keys = el('p', { class: 'stage-keys' });

  const pictures = el('div', { class: 'stage-pictures', tabindex: 0, role: 'group', 'aria-label': 'Pictures. Space plays or pauses the blink, the arrow keys step, D shows the difference.' });
  const message = el('p', { class: 'stage-message', role: 'status' });
  const diffOff = el('p', { class: 'stage-diff-off', hidden: true });
  const match = el('p', { class: 'stage-match' });
  const note = el('p', { class: 'stage-note' });

  const sourceInput = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `stage-source-${id}`, class: 'stage-source-input' }));
  const sourceBox = el('div', { class: 'stage-toggle' }, [sourceInput, el('label', { for: `stage-source-${id}`, text: 'Mark known stars and galaxies' })]);
  sourceInput.addEventListener('change', () => setSource(sourceInput.checked));

  const legend = el('ul', { class: 'stage-legend', 'aria-label': 'What the marks mean' });
  const diffWords = el('p', { class: 'stage-diff-words' });
  // The plate leads. In its column stand the choices of view above it, and under it the play buttons, what the
  // view does and the curtain. Beside it on a wide window, under it on a narrow one, stands the desk: a place for
  // the page to put what it says and the readout of the pointer, then what the stage says about the view.
  const slot = el('div', { class: 'stage-slot' });
  // what only some visitors want stands in one disclosure, closed: how the pictures are enlarged, the keys, the
  // known sources and the legend of the marks
  const displayDetails = el('details', { class: 'disclosure stage-display-details' }, [
    el('summary', { text: 'Display' }),
    el('div', { class: 'stage-display-body' }, [settings, displayBox, keys, sourceBox, legend, diffWords]),
  ]);
  if (white || speed !== 'normal' || invert) displayDetails.setAttribute('open', ''); // a choice that was kept in the address is seen
  const notes = el('div', { class: 'stage-notes' }, [message, diffOff, match]);
  const main = el('div', { class: 'stage-main' }, [modes, pictures, playBox, note, hint, curtainBox, displayDetails]);
  const desk = el('div', { class: 'stage-desk' }, [slot, notes]);

  root.style.setProperty('--plate-margin', `${PLATE_MARGIN}px`);
  root.style.setProperty('--plate-strip', `${PLATE_STRIP}px`);
  root.replaceChildren(main, desk);

  // ---- panels
  /**
   * @typedef {Object} Panel
   * @property {'a' | 'b' | 'curtain' | 'diff'} kind
   * @property {number} w @property {number} h
   * @property {HTMLElement} figure @property {HTMLElement} frame @property {HTMLCanvasElement} canvas
   * @property {SVGElement} patternSat @property {SVGElement} patternDef
   * @property {SVGElement} veil @property {SVGElement} source @property {SVGElement} hatchSat @property {SVGElement} hatchDef
   * @property {SVGElement} target @property {SVGElement} marks @property {SVGElement} pickHalo @property {SVGElement} pickMark @property {SVGElement} line
   * @property {HTMLElement} under @property {HTMLElement} caption
   * @property {Float32Array} values
   * @property {Masks} masks
   */
  /** @type {Panel[]} */
  let panels = [];

  /** @param {'a' | 'b' | 'curtain' | 'diff'} kind @param {number} w @param {number} h @returns {Panel} */
  function makePanel(kind, w, h) {
    const canvas = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'stage-canvas', width: w, height: h }));
    /** @param {string} name */
    const hatchPattern = (name) => svg('pattern', { id: `stage-hatch-${name}-${id}-${kind}`, patternUnits: 'userSpaceOnUse', width: 0.5, height: 0.5 }, [svg('path', { class: 'stage-hatch-line' })]);
    const patternSat = hatchPattern('sat'), patternDef = hatchPattern('def');
    const veil = svg('path', { class: 'stage-veil' });
    const source = svg('path', { class: 'stage-source' });
    const hatchSat = svg('path', { class: 'stage-hatch stage-hatch-saturated', fill: `url(#stage-hatch-sat-${id}-${kind})` });
    const hatchDef = svg('path', { class: 'stage-hatch stage-hatch-defect', fill: `url(#stage-hatch-def-${id}-${kind})` });
    const target = svg('path', { class: 'stage-target' });
    const marks = svg('path', { class: 'stage-marks' });
    const pickHalo = svg('path', { class: 'stage-pick-halo' });
    const pickMark = svg('path', { class: 'stage-pick' });
    const line = svg('line', { class: 'stage-curtain-line', y1: 0, y2: h });
    const overlay = svg('svg', { class: 'stage-overlay', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, [
      svg('defs', {}, [patternSat, patternDef]), veil, source, hatchSat, hatchDef, target, marks, pickHalo, pickMark, line,
    ]);
    const frame = el('div', { class: 'stage-frame' }, [canvas, overlay]);
    const under = el('div', { class: 'stage-under' });
    const caption = el('figcaption', { class: 'cells stage-caption' });
    // a plate: black in both editions of the page, with its own row of cells joined under it
    const figure = el('figure', { class: 'plate-frame stage-panel', 'data-plate': true, 'data-kind': kind }, [frame, under, caption]);
    frame.addEventListener('pointermove', (e) => point(panel, e));
    frame.addEventListener('pointerdown', (e) => {
      point(panel, e);
      if (panel.kind === 'curtain') {
        frame.setPointerCapture?.(e.pointerId);
        dragCurtain(panel, e);
      }
    });
    frame.addEventListener('click', (e) => {
      touching = /** @type {PointerEvent} */ (e).pointerType !== 'mouse';
      const at = pixelAt(panel, e);
      if (at) emitPick(panel, at.x, at.y);
    });
    frame.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return; // a tap leaves its readout in place
      hoverAt = null;
      options.onPoint?.(null);
    });
    /** @type {Panel} */
    const panel = {
      kind, w, h, figure, frame, canvas, patternSat, patternDef, veil, source, hatchSat, hatchDef, target, marks, pickHalo, pickMark, line, under, caption,
      values: new Float32Array(0), masks: { saturated: new Uint8Array(0), defect: new Uint8Array(0), source: null, veiled: null },
    };
    return panel;
  }

  /** @param {Panel} panel @param {{clientX: number, clientY: number}} e @returns {{x: number, y: number} | null} the pixel under the pointer */
  function pixelAt(panel, e) {
    const box = panel.canvas.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return null;
    const x = Math.floor((e.clientX - box.left) / box.width * panel.w), row = Math.floor((e.clientY - box.top) / box.height * panel.h);
    if (x < 0 || x >= panel.w || row < 0 || row >= panel.h) return null;
    return { x, y: panel.h - 1 - row };
  }

  /** Tell the page which pixel of which picture is under the pointer. @param {Panel} panel @param {number} x @param {number} y */
  function emitPoint(panel, x, y) {
    if (!options.onPoint || !layers) return;
    const kind = panel.kind === 'curtain' ? (x < split ? 'a' : 'b') : panel.kind;
    const layer = kind === 'diff' ? layers.diff : layers[kind];
    if (layer) options.onPoint({ kind, picture: layer.picture, x, y, touch: touching });
  }

  /** Tell the page which pixel of which picture was clicked. @param {Panel} panel @param {number} x @param {number} y @param {'a' | 'b'} [want]  The visit to read, when it is not the one shown. */
  function emitPick(panel, x, y, want) {
    if (!layers) return;
    picked = { x, y, w: panel.w, h: panel.h };
    for (const p of panels) drawPick(p);
    if (!options.onPick) return;
    const kind = want && layers[want] && panel.kind !== 'diff' ? want : panel.kind === 'curtain' ? (x < split ? 'a' : 'b') : panel.kind;
    const layer = kind === 'diff' ? layers.diff : layers[kind];
    if (layer) options.onPick({ kind, picture: layer.picture, x, y, touch: touching });
  }

  /** The mark of the clicked pixel: four corner ticks round it, drawn on a dark halo so that it shows on white and on black. @param {Panel} panel */
  function drawPick(panel) {
    let d = '';
    if (picked && picked.w === panel.w && picked.h === panel.h) {
      const cx = picked.x + 0.5, cy = panel.h - (picked.y + 0.5), r = 2.5, t = 1.4;
      d = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => `M${cx + sx * r} ${cy + sy * (r - t)}V${cy + sy * r}H${cx + sx * (r - t)}`).join('');
    }
    panel.pickHalo.setAttribute('d', d);
    panel.pickMark.setAttribute('d', d);
  }

  /** Take the mark away, and tell the page when there was one. @returns {boolean} */
  function clearPick() {
    if (!picked) return false;
    picked = null;
    for (const p of panels) drawPick(p);
    options.onUnpick?.();
    return true;
  }

  /** @param {Panel} panel @param {PointerEvent} e */
  function point(panel, e) {
    touching = e.pointerType !== 'mouse';
    const at = pixelAt(panel, e);
    hoverAt = at ? { panel: panels.indexOf(panel), x: at.x, y: at.y } : null;
    if (at) emitPoint(panel, at.x, at.y);
    else options.onPoint?.(null);
  }

  /** @param {Panel} panel @param {PointerEvent} e */
  function dragCurtain(panel, e) {
    /** @param {PointerEvent} ev */
    const move = (ev) => {
      const box = panel.canvas.getBoundingClientRect();
      setCurtainColumns(Math.round((ev.clientX - box.left) / box.width * panel.w));
    };
    const stop = () => {
      panel.frame.removeEventListener('pointermove', move);
      panel.frame.removeEventListener('pointerup', stop);
      panel.frame.removeEventListener('pointercancel', stop);
    };
    panel.frame.addEventListener('pointermove', move);
    panel.frame.addEventListener('pointerup', stop);
    panel.frame.addEventListener('pointercancel', stop);
    move(e);
  }

  // ---- drawing
  /** @param {Picture | DifferencePicture} picture @param {'a' | 'b' | 'diff'} kind @returns {Layer} */
  function makeLayer(picture, kind) {
    const { w, h } = picture;
    return {
      kind, picture, w, h,
      rgba: kind === 'diff' ? diffRgba(picture.data, w, h, palette) : greyRgba(picture.data, w, h, limits, palette.none, invert),
      masks: pictureMasks(picture),
    };
  }

  /** @param {Panel} panel @param {Uint8ClampedArray} rgba */
  function paint(panel, rgba) {
    const ctx = panel.canvas.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(panel.w, panel.h);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
  }

  /** The four ticks around the target: nothing is drawn on the target itself. @param {number} tx @param {number} ty @param {number} h */
  function targetPath(tx, ty, h) {
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return '';
    const x = tx + 0.5, y = h - (ty + 0.5), near = 3, far = 6;
    return `M${x - far} ${y}H${x - near}M${x + near} ${y}H${x + far}M${x} ${y - far}V${y - near}M${x} ${y + near}V${y + far}`;
  }

  /** @param {Picture | DifferencePicture} picture @param {string} [tag] @returns {HTMLElement | null} a compass for the strip under a picture */
  function compassIcon(picture, tag) {
    const c = compassOf(picture.sky);
    if (!c) return null;
    const size = 60, mid = size / 2, len = 20;
    /** An arrow from the middle, with its head and its letter. @param {[number, number]} v @param {number} length @param {string} letter */
    const arrow = (v, length, letter) => {
      const ux = v[0], uy = -v[1]; // on the screen y runs down
      const x = mid + ux * length, y = mid + uy * length, head = 5, half = 2.6;
      const bx = x - ux * head, by = y - uy * head;
      return svg('g', {}, [
        svg('line', { x1: mid, y1: mid, x2: x, y2: y }),
        svg('polygon', { points: `${x},${y} ${bx - uy * half},${by + ux * half} ${bx + uy * half},${by - ux * half}` }),
        Object.assign(svg('text', { x: mid + ux * (length + 6.5), y: mid + uy * (length + 6.5) }), { textContent: letter }),
      ]);
    };
    const icon = svg('svg', { class: 'stage-compass-icon', viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' }, [
      arrow(c.north, len, 'N'), arrow(c.east, len * 0.7, 'E'),
    ]);
    const northAngle = Math.round((Math.atan2(c.north[0], c.north[1]) * 180 / Math.PI + 360) % 360);
    const box = el('span', { class: 'stage-compass', 'data-north': northAngle, role: 'img', 'aria-label': `Compass${tag ? ` of the ${tag}` : ''}: north points ${northAngle} degrees clockwise from the top of the picture` }, [icon]);
    if (tag) box.append(el('span', { class: 'stage-compass-tag', text: tag }));
    return box;
  }

  /** @param {number} w @returns {HTMLElement} the scale bar of a plate whose picture is `w` pixels wide; fit() gives it its length */
  function scaleIcon(w) {
    const s = scaleBar(w);
    return el('span', { class: 'stage-scale', 'data-arcsec': s.arcsec, 'data-pixels': s.pixels }, [
      el('span', { class: 'stage-scale-bar' }),
      el('span', { class: 'stage-scale-label', text: `${s.arcsec} arcsec` }),
    ]);
  }

  /** @param {'a' | 'b'} which */
  const sideName = (which) => (which === 'a' ? 'Earlier visit' : 'Later visit');

  /**
   * The cells under a visit, in fixed slots: which visit, its date, its colour, how many photos it is made of.
   * A slot with nothing to say stays, empty.
   * @param {Picture} p @param {'a' | 'b'} which
   * @returns {HTMLElement[]}
   */
  function visitCaption(p, which) {
    const added = (p.photos ?? 1) > 1; // photos taken at several times: the day of the first, not a minute
    // one photo of a visit that began on another day: the photo says its own time, and the line says which visit it is
    const visit = /** @type {any} */ (p).visitMjd;
    const began = !added && Number.isFinite(visit) && Number.isFinite(p.mjd) && formatDate(visit) !== formatDate(p.mjd) ? formatDate(visit) : '';
    return [
      el('span', { class: 'cell stage-caption-side', 'data-side': which, text: sideName(which) }),
      el('span', { class: 'cell stage-caption-date', text: formatDate(added && Number.isFinite(/** @type {any} */ (p).visitMjd) ? /** @type {any} */ (p).visitMjd : p.mjd, !added) }),
      el('span', { class: 'cell stage-caption-colour' }, [Number.isFinite(p.lam) ? colourChip(p.lam, p.det) : null]),
      el('span', { class: 'cell stage-caption-photos', text: added ? `${p.photos} photos added up` : began ? `1 photo of the visit of ${began}` : '1 photo' }),
    ];
  }

  /** Fill one panel from the state. @param {Panel} panel */
  function drawPanel(panel) {
    if (!layers || !view) return;
    const { a, b, diff } = layers;
    panel.under.replaceChildren();
    panel.caption.replaceChildren();
    panel.line.setAttribute('visibility', 'hidden');
    /** @type {Layer} */
    let shown;
    if (panel.kind === 'curtain') {
      shown = a;
      panel.values = curtainOf(/** @type {Float32Array} */ (a.picture.data), /** @type {Float32Array} */ (b.picture.data), panel.w, panel.h, split);
      paint(panel, curtainOf(a.rgba, b.rgba, panel.w, panel.h, split, 4));
      panel.masks = {
        saturated: curtainOf(a.masks.saturated, b.masks.saturated, panel.w, panel.h, split),
        defect: curtainOf(a.masks.defect, b.masks.defect, panel.w, panel.h, split),
        source: a.masks.source || b.masks.source
          ? curtainOf(a.masks.source ?? new Uint8Array(panel.w * panel.h), b.masks.source ?? new Uint8Array(panel.w * panel.h), panel.w, panel.h, split)
          : null,
        veiled: a.masks.veiled || b.masks.veiled
          ? curtainOf(a.masks.veiled ?? new Uint8Array(panel.w * panel.h), b.masks.veiled ?? new Uint8Array(panel.w * panel.h), panel.w, panel.h, split)
          : null,
      };
      panel.line.setAttribute('x1', String(split));
      panel.line.setAttribute('x2', String(split));
      panel.line.setAttribute('visibility', 'visible');
      panel.under.append(...[scaleIcon(panel.w), compassIcon(a.picture, 'earlier visit'), compassIcon(b.picture, 'later visit')].filter((n) => n !== null));
      panel.caption.append(
        el('span', { class: 'stage-caption-half' }, visitCaption(view.a, 'a')),
        el('span', { class: 'stage-caption-half' }, visitCaption(view.b, 'b')),
      );
    } else {
      shown = panel.kind === 'diff' ? /** @type {Layer} */ (diff) : panel.kind === 'a' ? a : b;
      panel.values = /** @type {Float32Array} */ (shown.picture.data);
      paint(panel, shown.rgba);
      panel.masks = shown.masks;
      panel.under.append(...[scaleIcon(panel.w), compassIcon(shown.picture)].filter((n) => n !== null));
      if (panel.kind === 'diff') {
        panel.caption.append(
          el('span', { class: 'cell stage-caption-side', text: 'Difference: later visit minus earlier visit' }),
          el('span', { class: 'cell stage-caption-tag' }, [el('span', { class: 'stamp stage-resampled', text: 'resampled' })]),
        );
      } else panel.caption.append(...visitCaption(panel.kind === 'a' ? view.a : view.b, panel.kind));
    }
    panel.figure.dataset.shows = panel.kind === 'curtain' ? 'curtain' : shown.kind;
    // what the picture is, for someone who cannot see it
    /** @param {Picture} p @param {'a' | 'b'} which */
    const spoken = (p, which) => `${sideName(which)}, ${formatDate(p.mjd, true)}${Number.isFinite(p.lam) ? `, at ${p.lam.toFixed(3)} µm` : ''}`;
    panel.canvas.setAttribute('role', 'img');
    panel.canvas.setAttribute('aria-label', panel.kind === 'curtain'
      ? `Curtain. Left of the line: ${spoken(view.a, 'a')}. Right of the line: ${spoken(view.b, 'b')}.`
      : panel.kind === 'diff'
        ? `Difference of the two visits in units of the noise, ${panel.w} by ${panel.h} pixels.`
        : `${spoken(panel.kind === 'a' ? view.a : view.b, panel.kind)}: ${panel.w} by ${panel.h} pixels.`);
    panel.veil.setAttribute('d', maskPath(panel.masks.veiled, panel.w, panel.h));
    panel.source.setAttribute('d', showSource ? maskPath(panel.masks.source, panel.w, panel.h) : '');
    panel.hatchSat.setAttribute('d', maskPath(panel.masks.saturated, panel.w, panel.h));
    panel.hatchDef.setAttribute('d', maskPath(panel.masks.defect, panel.w, panel.h));
    panel.target.setAttribute('d', targetPath(shown.picture.tx, shown.picture.ty, panel.h));
    panel.marks.setAttribute('d', panel.kind === 'curtain'
      ? marksPath(a.picture.marks, panel.h, -Infinity, split - 0.5) + marksPath(b.picture.marks, panel.h, split - 0.5)
      : marksPath(shown.picture.marks, panel.h));
    drawPick(panel);
    panel.figure.dataset.marks = (panel.kind === 'curtain' ? [...(a.picture.marks ?? []), ...(b.picture.marks ?? [])] : shown.picture.marks ?? []).map((m) => m.name).join('; ');
  }

  /** True when the two visits have pictures of one size, which the curtain needs. */
  const sameSize = () => Boolean(layers && layers.a.w === layers.b.w && layers.a.h === layers.b.h);

  /** The kinds of panel a view needs. @returns {('a' | 'b' | 'curtain' | 'diff')[]} */
  function wanted() {
    if (!layers) return [];
    if (mode === 'side') return ['a', 'b'];
    if (mode === 'curtain') return sameSize() ? ['curtain'] : ['a', 'b'];
    if (mode === 'diff') return layers.diff ? ['diff'] : [];
    return [side];
  }

  /** @param {'a' | 'b' | 'curtain' | 'diff'} kind @returns {Layer} the picture that gives a panel its size */
  function layerOf(kind) {
    const all = /** @type {NonNullable<typeof layers>} */ (layers);
    return kind === 'diff' ? /** @type {Layer} */ (all.diff) : kind === 'b' ? all.b : all.a;
  }

  /** @param {Uint8Array | null} mask */
  const any = (mask) => Boolean(mask && mask.some((v) => v !== 0));

  function drawLegend() {
    legend.replaceChildren();
    diffWords.textContent = '';
    if (!layers) return;
    const isDiff = mode === 'diff' && Boolean(layers.diff);
    /** @param {string} cls @param {string} text */
    const entry = (cls, text) => el('li', { class: 'stage-legend-item' }, [el('span', { class: `stage-swatch ${cls}`, 'data-plate': true, 'aria-hidden': 'true' }), el('span', { text })]);
    if (panels.some((p) => any(p.masks.saturated))) legend.append(entry('stage-swatch-saturated', isDiff ? 'no value: this pixel could not be compared' : 'saturated: too bright to measure'));
    if (panels.some((p) => any(p.masks.defect))) legend.append(entry('stage-swatch-defect', 'damaged or disturbed pixel'));
    if (panels.some((p) => any(p.masks.veiled))) legend.append(entry('stage-swatch-veil', 'colours differ here'));
    if (showSource && panels.some((p) => any(p.masks.source))) legend.append(entry('stage-swatch-source', 'known star or galaxy'));
    const marked = [...new Set(panels.flatMap((p) => (p.figure.dataset.marks ? p.figure.dataset.marks.split('; ') : [])))];
    if (marked.length) legend.append(entry('stage-swatch-marks', `ticks: where ${marked.join(' and ')} should be on the date of this picture`));
    if (isDiff) {
      const key = /** @type {HTMLCanvasElement} */ (el('canvas', { class: 'stage-diff-key', width: 201, height: 1, 'aria-hidden': 'true' }));
      const ctx = key.getContext('2d');
      if (ctx) {
        const image = ctx.createImageData(201, 1);
        for (let i = 0; i <= 200; i++) image.data.set([...diffRgb(DIFF_RANGE * (i - 100) / 100, palette), 255], i * 4);
        ctx.putImageData(image, 0, 0);
      }
      legend.append(el('li', { class: 'stage-legend-item stage-legend-diff' }, [
        el('span', { class: 'stage-diff-end', text: `fainter, −${DIFF_RANGE}` }),
        key,
        el('span', { class: 'stage-diff-end', text: `+${DIFF_RANGE}, brighter` }),
      ]));
      diffWords.textContent = `The scale is in units of the noise and never changes; grey means less than ${DIFF_GREY_BELOW} times the noise. A steady star can still leave a dark and a bright pixel side by side, because a pixel is wider than the image of a star.`;
    }
  }

  /**
   * Lay the pictures out: each as large as fits, with a whole number of screen pixels to a pixel of the picture.
   * Beside the desk a plate is no taller than the window leaves under its top edge, so that it shows whole, with
   * its cells, before anything is scrolled. Its scale bar and its compass then stand at the right of the picture or
   * under it, whichever leaves the picture larger. In one column the picture may fill the width.
   */
  function fit() {
    if (!panels.length) return;
    const gap = parseFloat(win.getComputedStyle(pictures).columnGap) || 0, dpr = win.devicePixelRatio || 1;
    // on a wide window the plate's column takes about 7 of 12 columns and the desk the rest
    const grid = win.getComputedStyle(root);
    const twoColumns = grid.gridTemplateColumns.trim().split(/\s+/).length > 1;
    const room = twoColumns ? (root.clientWidth - (parseFloat(grid.columnGap) || 0)) * 7 / 12 : main.clientWidth;
    if (!(room > 0)) return; // not on the page, or hidden: nothing to measure against
    const first = panels[0];
    const edge = first.figure.offsetWidth - first.figure.clientWidth; // the rules of the frame of a plate
    const wide = (room - gap * (panels.length - 1)) / panels.length - edge;
    const rows = first.kind === 'curtain' ? 2 : 1; // the curtain has a row of cells for each visit
    const top = pictures.getBoundingClientRect().top + (win.scrollY || 0);
    const high = win.innerHeight - top - edge - PLATE_BOTTOM;
    // the plate leads: at least this wide beside the desk, when the column has the room, and else as large as fits
    const least = twoColumns && panels.length === 1 ? Math.min(PLATE_LEAST, win.innerHeight * 0.63) : 0;
    /** @param {Panel} p @param {number} each @returns {number} CSS px to a pixel of the picture */
    const zoomAt = (p, each) => {
      const side = Math.max(p.w, p.h);
      let z = Math.max(1, Math.floor(each * dpr / side));
      while (least && z * side / dpr < least && (z + 1) * side / dpr <= wide) z++;
      return z / dpr;
    };

    // under the picture: the strip, the cells, and the buttons
    const tallUnder = twoColumns ? Math.max(high - PLATE_STRIP - rows * PLATE_ROW - PLATE_BUTTONS, least) : win.innerHeight * 0.72;
    const zooms = panels.map((p) => zoomAt(p, Math.min(Math.max(240, tallUnder), wide)));
    // the plate is as wide as its photo: the scale bar and the compass stand under it, at its two edges
    const layout = 'under';
    root.dataset.plateAt = layout;

    for (const [i, p] of panels.entries()) {
      const zoom = zooms[i], width = zoom * p.w;
      p.frame.style.width = `${width.toFixed(3)}px`;
      p.frame.style.height = `${(zoom * p.h).toFixed(3)}px`;
      p.figure.style.width = `${width.toFixed(3)}px`;
      p.figure.dataset.zoom = String(zoom);
      for (const scale of p.under.querySelectorAll('.stage-scale')) {
        const bar = scale.firstElementChild;
        if (bar instanceof HTMLElement && scale instanceof HTMLElement) bar.style.width = `${(Number(scale.dataset.pixels) * zoom).toFixed(2)}px`;
      }
      // hatching about 4 CSS px apart, whatever the zoom: saturated pixels rising to the right, damaged ones falling
      const t = 4 / zoom, q = t / 4;
      const rising = `M0 ${t}L${t} 0M${-q} ${q}L${q} ${-q}M${t - q} ${t + q}L${t + q} ${t - q}`;
      const falling = `M0 0L${t} ${t}M${-q} ${t - q}L${q} ${t + q}M${t - q} ${-q}L${t + q} ${q}`;
      for (const [pattern, d] of /** @type {[SVGElement, string][]} */ ([[p.patternSat, rising], [p.patternDef, falling]])) {
        pattern.setAttribute('width', String(t));
        pattern.setAttribute('height', String(t));
        const line = /** @type {SVGElement} */ (pattern.firstChild);
        line.setAttribute('d', d);
        line.setAttribute('stroke-width', String(1.2 / zoom));
      }
    }
    // beside the desk the plate's column is as wide as the plate, and the desk has the rest
    if (twoColumns && panels.length === 1) root.style.setProperty('--plate-col', `${(parseFloat(panels[0].figure.style.width) || 0) + edge}px`);
    else root.style.removeProperty('--plate-col');
    // A square on the screen is one pixel of the picture only when the picture starts on a whole pixel of the
    // screen. What stands above it may end between two: the picture is then moved by that fraction.
    for (const p of panels) {
      p.frame.style.translate = '';
      const box = p.frame.getBoundingClientRect();
      /** @param {number} at @returns {number} how far a place on the page lies past a whole pixel of the screen, CSS px */
      const past = (at) => (at * dpr - Math.round(at * dpr)) / dpr;
      const dx = past(box.left + (win.scrollX || 0)), dy = past(box.top + (win.scrollY || 0));
      if (Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4) p.frame.style.translate = `${(-dx).toFixed(4)}px ${(-dy).toFixed(4)}px`;
    }
  }

  function render() {
    if (destroyed) return;
    root.dataset.mode = mode;
    root.dataset.side = side;
    root.dataset.playing = String(playing);
    root.classList.toggle('stage-reduced-motion', reducedMotion);
    for (const m of STAGE_MODES) modeButtons[m].setAttribute('aria-pressed', String(m === mode));
    modeButtons.diff.dataset.empty = String(Boolean(layers) && !layers?.diff);
    // a view may switch the difference off: the button stays, cannot be pressed, and a line says why
    const off = view?.diffOff ?? null;
    modeButtons.diff.disabled = Boolean(off);
    diffOff.hidden = !off;
    diffOff.replaceChildren();
    if (off) diffOff.append(`${off.why} `, el('a', { href: off.href, text: off.label }));
    hint.textContent = mode === 'blink' && reducedMotion ? `${MODE_HINTS.blink} Nothing plays by itself here: press Step.` : MODE_HINTS[mode];
    playBox.hidden = mode !== 'blink' || !layers;
    playButton.hidden = reducedMotion;
    playButton.textContent = playing ? 'PAUSE' : 'PLAY';
    curtainBox.hidden = mode !== 'curtain' || !sameSize();
    root.dataset.smooth = String(smooth);
    smoothButton.setAttribute('aria-pressed', String(smooth));
    displayBox.hidden = !layers;
    displayDetails.hidden = !layers;
    for (const b of whiteButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.white) === white));
    for (const b of speedButtons) b.setAttribute('aria-pressed', String(b.dataset.speed === speed));
    invertButton.setAttribute('aria-pressed', String(invert));
    root.dataset.white = String(white);
    root.dataset.speed = speed;
    root.dataset.invert = String(invert);
    // what the keys do in this view, in words
    const dKey = off || !layers || !layers.diff ? '' : mode === 'diff' ? 'D goes back' : 'D shows the difference';
    const own = !layers ? '' : mode === 'blink' ? (reducedMotion ? 'Space and the arrow keys step' : 'Space plays and pauses, the arrow keys step') : mode === 'curtain' && sameSize() ? 'the arrow keys move the line' : '';
    const said = [own, dKey].filter(Boolean).join(', ');
    keys.textContent = said ? `Keys: ${said}.` : '';
    sourceBox.hidden = !layers || !(layers.a.masks.source || layers.b.masks.source) || (mode === 'diff');

    // a canvas is kept as long as it shows the same kind of thing at the same size: in Blink, one canvas shows
    // the two visits in turn
    /** @param {string} kind */
    const slot = (kind) => (kind === 'a' || kind === 'b' ? 'visit' : kind);
    const kinds = wanted();
    const keep = kinds.length === panels.length && kinds.every((k, i) => slot(k) === slot(panels[i].kind) && layerOf(k).w === panels[i].w && layerOf(k).h === panels[i].h);
    if (keep) kinds.forEach((k, i) => { panels[i].kind = k; });
    else {
      panels = kinds.map((k) => makePanel(k, layerOf(k).w, layerOf(k).h));
      pictures.replaceChildren(...panels.map((p) => p.figure));
      hoverAt = null;
    }
    for (const p of panels) {
      p.figure.dataset.kind = p.kind;
      drawPanel(p);
    }
    fit();
    if (hoverAt && panels[hoverAt.panel]) emitPoint(panels[hoverAt.panel], hoverAt.x, hoverAt.y); // the readout follows the picture

    message.textContent = '';
    if (layers && mode === 'diff' && !layers.diff) message.textContent = view?.diffNote ?? 'There is no difference picture for these two visits. Blink shows them one after the other.';
    else if (layers && mode === 'curtain' && !sameSize()) message.textContent = 'The two pictures differ in size, so they are shown side by side.';
    const m = view ? colourMatch(view.a, view.b) : null;
    match.textContent = '';
    match.dataset.same = '';
    if (m && mode !== 'diff') {
      match.dataset.same = String(m.same);
      match.textContent = m.same
        ? `Same colour: the two pictures are ${m.apart.toFixed(4)} µm apart; up to ${m.allowed.toFixed(4)} µm counts as the same colour.`
        : `Not the same colour: the two pictures are ${m.apart.toFixed(4)} µm apart; only up to ${m.allowed.toFixed(4)} µm counts as the same colour.`;
    }
    note.textContent = view?.note ?? '';
    drawLegend();
  }

  // ---- blink
  function clearTimers() {
    if (playTimer !== null) clearTimeout(playTimer);
    if (pendingFlip !== null) clearTimeout(pendingFlip);
    playTimer = null;
    pendingFlip = null;
  }

  /**
   * Show a visit in Blink. A change that would come sooner than MIN_FLIP_MS after the last one waits its turn;
   * of several that wait, the last one asked for wins.
   * @param {'a' | 'b'} next
   */
  function showSide(next) {
    if (pendingFlip !== null) { clearTimeout(pendingFlip); pendingFlip = null; }
    if (next === side) return;
    const wait = lastFlip + MIN_FLIP_MS - win.performance.now();
    if (wait > 0) {
      pendingFlip = setTimeout(() => { pendingFlip = null; showSide(next); }, wait);
      return;
    }
    side = next;
    lastFlip = win.performance.now();
    flips++;
    if (mode === 'blink') { render(); options.onSide?.(side); }
  }

  function schedule() {
    if (playTimer !== null) clearTimeout(playTimer);
    playTimer = null;
    if (!playing || destroyed) return;
    playTimer = setTimeout(() => {
      playTimer = null;
      if (!playing) return;
      if (!root.ownerDocument.hidden && mode === 'blink' && layers) showSide(side === 'a' ? 'b' : 'a');
      schedule();
    }, Math.max(SPEEDS[speed], MIN_FLIP_MS));
  }

  /** Whether Blink plays by itself when it comes on: not under reduced motion, and not once the visitor stopped it. */
  const plays = () => !reducedMotion && !stopped && options.autoplay !== false;

  function play() {
    if (reducedMotion || !layers) return;
    stopped = false;
    if (mode !== 'blink') { setMode('blink'); return; }
    playing = true;
    schedule();
    render();
  }

  function pause() {
    stopped = true;
    playing = false;
    if (playTimer !== null) clearTimeout(playTimer);
    playTimer = null;
    render();
  }

  /** Show the other visit, or the one named, and stop playing. @param {'a' | 'b'} [to] */
  function step(to) {
    if (!layers) return;
    if (playing || !stopped) pause();
    if (mode !== 'blink') setMode('blink');
    showSide(to ?? (side === 'a' ? 'b' : 'a'));
  }

  // ---- views
  /** @param {StageMode} next */
  function setMode(next) {
    if (!STAGE_MODES.includes(next)) next = 'blink';
    if (next === 'diff' && view?.diffOff) return; // switched off for this view
    if (next === mode) return;
    if (next !== 'diff') modeBeforeDiff = next;
    else if (mode !== 'diff') modeBeforeDiff = mode;
    mode = next;
    clearTimers();
    playing = mode === 'blink' && Boolean(layers) && plays();
    lastFlip = win.performance.now(); // another view is a change of picture too
    render();
    schedule();
    options.onMode?.(mode);
  }

  /** @param {number} columns  How many columns show the earlier visit. */
  function setCurtainColumns(columns) {
    if (!layers) return;
    const next = Math.min(layers.a.w, Math.max(0, Math.round(columns)));
    if (next === split) return;
    split = next;
    curtainInput.value = String(split);
    if (mode === 'curtain') render();
  }

  /** @param {boolean} on */
  function setSource(on) {
    showSource = Boolean(on);
    sourceInput.checked = showSource;
    render();
  }

  /**
   * "Smooth pixels": let the browser smooth the pictures as it enlarges them, or draw a square for each pixel.
   * Only the screen changes: the values, the readout and what readback() gives stay as they are.
   * @param {boolean} on
   */
  function setSmooth(on) {
    if (Boolean(on) === smooth) return;
    smooth = Boolean(on);
    render();
    options.onSmooth?.(smooth);
  }

  /** The grey pictures are drawn again, with the limits and the grey scale as they are now. */
  function redrawGrey() {
    if (!view || !layers) return;
    limits = whiteLimits([view.a.data, view.b.data], white);
    layers = { a: makeLayer(view.a, 'a'), b: makeLayer(view.b, 'b'), diff: layers.diff };
    render();
  }

  /** @param {number} step  A step of WHITE_STEPS. */
  function setWhite(step) {
    const next = Math.min(WHITE_STEPS.length - 1, Math.max(0, Math.round(step) || 0));
    if (next === white) return;
    white = next;
    redrawGrey();
    options.onWhite?.(white);
  }

  /** @param {'slow' | 'normal' | 'fast'} next */
  function setSpeed(next) {
    if (!Object.hasOwn(SPEEDS, next) || next === speed) return;
    speed = next;
    if (playing) schedule();
    render();
    options.onSpeed?.(speed);
  }

  /** @param {boolean} on */
  function setInvert(on) {
    if (Boolean(on) === invert) return;
    invert = Boolean(on);
    redrawGrey();
    options.onInvert?.(invert);
  }

  /**
   * Show a view, or nothing.
   * @param {StageView | null} next
   * @param {'a' | 'b'} [first]  The visit that Blink shows first (default: the earlier one).
   */
  function show(next, first = 'a') {
    clearTimers();
    if (!next || (picked && (picked.w !== next.a.w || picked.h !== next.a.h))) picked = null;
    view = next;
    panels = [];
    pictures.replaceChildren();
    if (!view) {
      layers = null;
      playing = false;
      render();
      return;
    }
    if (view.diffOff && mode === 'diff') mode = modeBeforeDiff; // the address may ask for a view this view does not have
    limits = whiteLimits([view.a.data, view.b.data], white);
    layers = { a: makeLayer(view.a, 'a'), b: makeLayer(view.b, 'b'), diff: view.diff ? makeLayer(view.diff, 'diff') : null };
    split = curtainSplit(0.5, view.a.w);
    curtainInput.max = String(view.a.w);
    curtainInput.value = String(split);
    side = first === 'b' ? 'b' : 'a';
    hoverAt = null;
    lastFlip = win.performance.now(); // a new view is a change of picture too
    playing = mode === 'blink' && plays();
    render();
    schedule();
  }

  // ---- keys
  /**
   * The keys of the stage. In Blink, Space plays or pauses (under reduced motion it steps) and the left and right
   * arrows show the earlier and the later visit. In Curtain the arrows move the curtain. D shows the difference,
   * and D again goes back.
   * @param {KeyboardEvent} e
   * @returns {boolean} true when the key was used
   */
  function key(e) {
    if (!layers || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === 'Escape') return clearPick();
    const on = e.target instanceof Element ? e.target : null;
    const control = on?.closest('button, a, input, select, textarea, summary, [contenteditable]') ?? null;
    const typing = Boolean(control?.matches('input:not([type=range]):not([type=checkbox]), select, textarea, [contenteditable]'));
    if (e.key === ' ' || e.code === 'Space') {
      // Space presses the control that has the focus, a button that chooses the view included. Only the button of
      // Blink, while Blink is on, has nothing to choose: there it plays and pauses
      if ((control && !(mode === 'blink' && control.matches('.stage-mode[data-mode="blink"]'))) || mode !== 'blink') return false;
      if (e.repeat) return true;
      if (reducedMotion) step();
      else if (playing) pause();
      else play();
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (typing || control?.matches('input[type=range]')) return false;
      const right = e.key === 'ArrowRight';
      if (mode === 'curtain' && sameSize()) setCurtainColumns(split + (right ? 1 : -1) * (e.shiftKey ? 8 : 1));
      else if (mode === 'blink') step(right ? 'b' : 'a');
      else return false;
      return true;
    }
    if (e.key === 'd' || e.key === 'D') {
      if (typing || view?.diffOff || !layers.diff) return false; // no difference picture: nothing to show
      if (e.repeat) return true;
      setMode(mode === 'diff' ? modeBeforeDiff : 'diff');
      return true;
    }
    return false;
  }

  /** @param {KeyboardEvent} e */
  const onKey = (e) => { if (key(e)) e.preventDefault(); };
  root.addEventListener('keydown', onKey);

  const onMotion = () => {
    if (options.reducedMotion !== undefined) return;
    reducedMotion = Boolean(motionQuery?.matches);
    if (reducedMotion) pause();
    else render();
  };
  motionQuery?.addEventListener?.('change', onMotion);

  const resize = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => fit()) : null;
  resize?.observe(root);
  // the height of the window decides how tall a plate may be, and no part of the page changes size with it
  const onWindow = () => fit();
  win.addEventListener('resize', onWindow);

  render();

  return {
    /** A place beside the pictures (under them on a narrow window) for the page to put the readout of the pointer. */
    slot,
    show,
    /** Draw again what is shown: for a view whose pictures were given marks after it was shown. */
    redraw: render,
    setMode,
    play,
    pause,
    step,
    key,
    /** Take away the mark of the pixel that was clicked. */
    clearPick,
    /**
     * Mark a pixel as if it had been clicked: for a place that the address carries.
     * @param {number} x @param {number} y @param {'a' | 'b'} [kind]  The visit whose photo is read; the one shown when left out.
     * @returns {boolean} false when there is no picture or the pixel is not on it
     */
    pickAt(x, y, kind) {
      const panel = panels[0];
      if (!layers || !panel || !(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < panel.w && y < panel.h)) return false;
      emitPick(panel, x, y, kind);
      return true;
    },
    /** The pixel that is marked, or null. */
    get picked() { return picked ? { x: picked.x, y: picked.y } : null; },
    setSource,
    setSmooth,
    setWhite,
    setSpeed,
    setInvert,
    get white() { return white; },
    get speed() { return speed; },
    get invert() { return invert; },
    /** @param {number} fraction  0: all of the later visit; 1: all of the earlier visit. */
    setCurtain(fraction) { if (layers) setCurtainColumns(curtainSplit(fraction, layers.a.w)); },
    get mode() { return mode; },
    get side() { return side; },
    get playing() { return playing; },
    get reducedMotion() { return reducedMotion; },
    /** True while "Smooth pixels" is on. */
    get smooth() { return smooth; },
    /** How many times Blink has changed picture since the stage was made. */
    get flips() { return flips; },
    /**
     * What is drawn now: the state, and for each canvas the values it was drawn from and the bytes it holds.
     * @returns {{mode: StageMode, side: 'a' | 'b', playing: boolean, split: number, limits: {lo: number, hi: number}, flips: number, panels: PanelReadback[]}}
     */
    readback() {
      return {
        mode, side, playing, split, limits: { ...limits }, flips,
        panels: panels.map((p) => ({
          kind: p.kind, w: p.w, h: p.h, values: p.values,
          rgba: p.canvas.getContext('2d')?.getImageData(0, 0, p.w, p.h).data ?? new Uint8ClampedArray(0),
          saturated: p.masks.saturated, defect: p.masks.defect, veiled: p.masks.veiled, source: showSource ? p.masks.source : null,
          cssWidth: p.canvas.getBoundingClientRect().width,
          caption: p.caption.textContent ?? '',
        })),
      };
    },
    destroy() {
      destroyed = true;
      clearTimers();
      resize?.disconnect();
      win.removeEventListener('resize', onWindow);
      motionQuery?.removeEventListener?.('change', onMotion);
      root.removeEventListener('keydown', onKey);
      root.replaceChildren();
    },
  };
}

/** @typedef {ReturnType<typeof createStage>} Stage */
