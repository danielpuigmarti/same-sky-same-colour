// The comet on the first page: the plate of the lead item, which flips between two photos of one patch of sky
// taken at the same colour, and the ruler that holds the photos of one night at their colours.
//
// The first half of this file is what the small stages of the first page share (lie.js uses it too): reading a
// showcase (CT-8), the one display rule, lining photos up, drawing a photo, the beat of the page, and the rule
// that one loop plays at a time. Nothing here touches the page until mountFlip, mountNight or mountBars is called.

/** @import { Manifest, Numbers } from '../contracts.js' */
import { KEY_REGEX, STAMPS_FILE, FLAGS_FILE, CLIP_SIGMA, CLIP_PASSES, MAD_TO_SIGMA, MATCH_BANDWIDTH_FRACTION, NUMBERS_FILE } from '../contracts.js';

// ---------------------------------------------------------------------------------------------
// What the small stages share
// ---------------------------------------------------------------------------------------------

/** How long a blink shows each photo, ms, where the page does not give its beat: the rhythm of the viewer's blink. */
export const FLIP_MS = 800;
/** No loop changes the picture more often than twice a second. */
export const MIN_FLIP_MS = 500;

/**
 * The beat of the page, ms: the one clock that everything which blinks by itself keeps. The page gives it in its
 * styles, as --beat; without it the beat is FLIP_MS. Never shorter than MIN_FLIP_MS.
 * @returns {number}
 */
export function beat() {
  const text = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement).getPropertyValue('--beat').trim() : '';
  const ms = text.endsWith('ms') ? parseFloat(text) : text.endsWith('s') ? 1000 * parseFloat(text) : NaN;
  return Math.max(Number.isFinite(ms) && ms > 0 ? ms : FLIP_MS, MIN_FLIP_MS);
}

/** Black is this many times the sky noise (below the sky); the asinh curve softens at SOFTEN_NOISE times it. */
const BLACK_NOISE = -2;
const SOFTEN_NOISE = 3;
/** White is the brightest pixel within this many pixels of the target, over all photos of a stage. */
const PEAK_RADIUS = 2;
/** A faulty pixel is filled in for display when at least this many of its eight neighbours are good. */
const FILL_NEIGHBOURS = 3;
/** A turn smaller than this many degrees is taken as none: the photo is then drawn pixel for pixel. */
const NO_TURN_BELOW = 1;

/** Decimals of a wavelength in µm; the viewer writes colours the same way. */
export const COLOUR_DECIMALS = 3;

/**
 * The flags that leave a pixel without a value of its own, by bit number. The names are the ones the frames give
 * in the header of their FLAGS part (MSKN cards): 0 TRANSIENT, 1 OVERFLOW, 2 SUR_ERROR, 6 NONFUNC, 9 MISSING_DATA,
 * 10 HOT, 11 COLD, 15 NONLINEAR, 17 PERSIST. The small stages do not draw flags: they fill such a pixel from its
 * neighbours and say so once in their caption. The viewer hatches flagged pixels instead.
 */
export const FAULTY_BITS = Object.freeze([0, 1, 2, 6, 9, 10, 11, 15, 17]);
const FAULTY_MASK = FAULTY_BITS.reduce((word, bit) => word | (1 << bit), 0);

/**
 * One photo of a showcase, ready to draw.
 * @typedef {Object} Photo
 * @property {number} index  Position in the frames of the manifest.
 * @property {string} key  Bucket key of the frame.
 * @property {number} det  Detector, 1 to 6, read from the key.
 * @property {number} mjd  Mid-exposure time, MJD (UTC).
 * @property {number} lam  Wavelength at the target, µm.
 * @property {number} bw  Bandwidth at the target, µm.
 * @property {number} visit  0 for the earliest visit.
 * @property {number} w
 * @property {number} h
 * @property {number} tx  The target in stamp pixels.
 * @property {number} ty
 * @property {Float32Array} data  The stamp as it is in the showcase: w*h values in MJy/sr, first row at the lowest y.
 * @property {Float32Array} shown  What is drawn: `data`, with each faulty pixel filled from its good neighbours, or NaN where it has too few.
 * @property {number} filled  How many pixels of `shown` were filled in.
 * @property {number} sky  Level of the empty sky, MJy/sr.
 * @property {number} noise  Noise of the empty sky, MJy/sr.
 * @property {number} turn  Degrees by which the photo is turned against the photo it is lined up with; NaN when not known.
 */

/**
 * One display rule for all photos of a stage, in MJy/sr above the sky of each photo.
 * @typedef {Object} DisplayRule
 * @property {number} black
 * @property {number} white
 * @property {number} soften
 */

/** @param {Float64Array} v  sorted in place */
function medianOf(v) {
  v.sort();
  const n = v.length;
  return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/**
 * Sky level and sky noise of a stamp, by the rule for a stamp whose flags are not looked at (CT-7): the
 * sigma-clipped median of its finite values, and MAD_TO_SIGMA times the median distance from the median once
 * that level is taken off. Here the rule runs over the good pixels of a photo, for display only.
 * @param {ArrayLike<number>} values
 * @returns {{sky: number, noise: number}}
 */
export function skyOf(values) {
  const all = Float64Array.from(values).filter(Number.isFinite);
  if (all.length === 0) return { sky: NaN, noise: NaN };
  let v = all;
  for (let pass = 0; pass < CLIP_PASSES; pass++) {
    const m = medianOf(v.slice());
    let mean = 0;
    for (let i = 0; i < v.length; i++) mean += v[i];
    mean /= v.length;
    let ss = 0;
    for (let i = 0; i < v.length; i++) ss += (v[i] - mean) * (v[i] - mean);
    const limit = CLIP_SIGMA * Math.sqrt(ss / v.length);
    const keep = v.filter((x) => Math.abs(x - m) <= limit);
    if (keep.length === v.length || keep.length === 0) break;
    v = keep;
  }
  const sky = medianOf(v.slice());
  const off = all.map((x) => x - sky);
  const m = medianOf(off.slice());
  return { sky, noise: MAD_TO_SIGMA * medianOf(off.map((x) => Math.abs(x - m))) };
}

/**
 * What is drawn of a stamp: its values, with every faulty pixel (no value, or one of the flags of FAULTY_BITS)
 * given the median of its good neighbours when it has FILL_NEIGHBOURS of them, and NaN when it has not. A single
 * bad pixel is filled; the middle of a saturated star stays empty.
 * @param {Float32Array} data @param {Int32Array | null} flags @param {number} w @param {number} h
 * @returns {{shown: Float32Array, filled: number}}
 */
export function fillFaulty(data, flags, w, h) {
  const good = new Uint8Array(w * h);
  for (let i = 0; i < good.length; i++) good[i] = Number.isFinite(data[i]) && (flags === null || (flags[i] & FAULTY_MASK) === 0) ? 1 : 0;
  const shown = Float32Array.from(data);
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (good[y * w + x]) continue;
      const near = [];
      for (let j = Math.max(y - 1, 0); j <= Math.min(y + 1, h - 1); j++) {
        for (let i = Math.max(x - 1, 0); i <= Math.min(x + 1, w - 1); i++) if (good[j * w + i]) near.push(data[j * w + i]);
      }
      if (near.length >= FILL_NEIGHBOURS) {
        shown[y * w + x] = medianOf(Float64Array.from(near));
        filled++;
      } else shown[y * w + x] = NaN;
    }
  }
  return { shown, filled };
}

/** Four-byte values of a little-endian file. @param {ArrayBuffer} bytes @param {boolean} float */
function fourByteValues(bytes, float) {
  const view = new DataView(bytes), n = bytes.byteLength / 4;
  const out = float ? new Float32Array(n) : new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = float ? view.getFloat32(i * 4, true) : view.getInt32(i * 4, true);
  return out;
}

/**
 * The photos of a showcase from its manifest and the bytes of its files. Throws when they do not fit together.
 * @param {Manifest} manifest
 * @param {ArrayBuffer} stampBytes  stamps.bin: little-endian float32, frames in order.
 * @param {ArrayBuffer | null} [flagBytes]  flags.bin: little-endian int32 in the same layout, or null.
 * @returns {Photo[]}
 */
export function readShowcase(manifest, stampBytes, flagBytes = null) {
  const { w, h, frames } = manifest;
  if (!Array.isArray(frames) || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error('showcase: not a manifest');
  const n = w * h;
  if (stampBytes.byteLength !== frames.length * n * 4) throw new Error('showcase: the stamps do not fit the manifest');
  if (flagBytes && flagBytes.byteLength !== stampBytes.byteLength) throw new Error('showcase: the flags do not fit the stamps');
  const values = /** @type {Float32Array} */ (fourByteValues(stampBytes, true));
  const words = flagBytes ? /** @type {Int32Array} */ (fourByteValues(flagBytes, false)) : null;
  return frames.map((f, index) => {
    const data = values.subarray(index * n, (index + 1) * n);
    const { shown, filled } = fillFaulty(data, words ? words.subarray(index * n, (index + 1) * n) : null, w, h);
    const key = KEY_REGEX.exec(f.key);
    return {
      index, key: f.key, det: key ? Number(key[3]) : manifest.det, mjd: f.mjd, lam: f.lam, bw: f.bw, visit: f.visit,
      w, h, tx: f.tx, ty: f.ty, data, shown, filled, ...skyOf(shown), turn: NaN,
    };
  });
}

/**
 * Fetch a showcase. Null when it cannot be had or cannot be used: the caller keeps what the page already shows.
 * @param {string | URL} manifestUrl  Address of manifest.json; the other files sit beside it.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{manifest: Manifest, photos: Photo[]} | null>}
 */
export async function loadShowcase(manifestUrl, fetchFn = globalThis.fetch) {
  try {
    const first = await fetchFn(String(manifestUrl));
    if (!first.ok) return null;
    /** @type {Manifest} */
    const manifest = await first.json();
    const [stamps, flags] = await Promise.all([
      fetchFn(String(new URL(STAMPS_FILE, manifestUrl))),
      manifest.flags ? fetchFn(String(new URL(FLAGS_FILE, manifestUrl))) : null,
    ]);
    if (!stamps.ok || (flags && !flags.ok)) return null;
    return { manifest, photos: readShowcase(manifest, await stamps.arrayBuffer(), flags ? await flags.arrayBuffer() : null) };
  } catch {
    return null;
  }
}

/**
 * The one display rule of a stage: black a little below the empty sky, white at the peak of the brightest photo.
 * The sky noise is that of the quietest photo. Null when the photos give no usable numbers.
 * @param {Photo[]} photos
 * @returns {DisplayRule | null}
 */
export function displayRule(photos) {
  let noise = Infinity, peak = -Infinity;
  for (const p of photos) {
    if (p.noise > 0 && p.noise < noise) noise = p.noise;
    const x0 = Math.round(p.tx), y0 = Math.round(p.ty);
    for (let y = y0 - PEAK_RADIUS; y <= y0 + PEAK_RADIUS; y++) {
      for (let x = x0 - PEAK_RADIUS; x <= x0 + PEAK_RADIUS; x++) {
        if (x < 0 || y < 0 || x >= p.w || y >= p.h || Math.hypot(x - p.tx, y - p.ty) > PEAK_RADIUS + 0.5) continue;
        const v = p.shown[y * p.w + x] - p.sky;
        if (v > peak) peak = v;
      }
    }
  }
  if (!Number.isFinite(noise) || !Number.isFinite(peak)) return null;
  const black = BLACK_NOISE * noise;
  return { black, white: Math.max(peak, black + 10 * noise), soften: SOFTEN_NOISE * noise };
}

/**
 * Where a value falls between black (0) and white (1) under a display rule: an asinh curve, clipped at both ends.
 * @param {number} v  MJy/sr above the sky.
 * @param {DisplayRule} rule
 */
export function greyOf(v, rule) {
  const lo = Math.asinh(rule.black / rule.soften);
  const g = (Math.asinh(v / rule.soften) - lo) / (Math.asinh(rule.white / rule.soften) - lo);
  return g < 0 ? 0 : g > 1 ? 1 : g;
}

/** How far the target of a photo is from the nearest edge of its stamp, pixels. @param {Photo} p */
const reach = (p) => Math.min(p.tx, p.ty, p.w - 1 - p.tx, p.h - 1 - p.ty);

/**
 * The side of the square that is drawn, in photo pixels: the largest odd number for which the square around the
 * target stays inside every stamp however the photo is turned.
 * @param {Photo[]} photos
 */
export function viewSize(photos) {
  const r = Math.floor(Math.min(...photos.map(reach)) / Math.SQRT2);
  return Math.max(2 * r + 1, 3);
}

/** The stars of a photo for lining up: what stands above its sky, in units of its noise, capped at this. */
const STAR_CAP = 25;
/** The target itself says nothing about a turn, and may have changed: pixels closer than this are left out. */
const TURN_INNER = 4;

/**
 * How far a photo is turned against a reference photo of the same patch of sky, measured on the stars around the
 * target. The telescope comes back to a patch of sky turned by about half a circle, and a stamp is never rotated,
 * so two photos can only be laid over each other once this is known.
 *
 * The turn is the angle t (degrees) for which the sky at offset (dx, dy) from the target of the reference lies at
 * offset (dx cos t - dy sin t, dx sin t + dy cos t) from the target of the photo. Turns are tried all round the
 * circle and the one where the two star fields agree best is kept; `sure` says whether that agreement is clear.
 * @param {Photo} ref
 * @param {Photo} photo
 * @param {{near?: number, within?: number}} [options]  Look only within `within` degrees of `near`.
 * @returns {{turn: number, score: number, sure: boolean}}
 */
export function findTurn(ref, photo, { near = 0, within = 180 } = {}) {
  const outer = Math.min(reach(ref), reach(photo)) - 1;
  /** @param {Photo} p @param {number} x @param {number} y */
  const star = (p, x, y) => {
    const v = (p.shown[y * p.w + x] - p.sky) / p.noise;
    return v > 0 ? Math.min(v, STAR_CAP) : 0;   // empty pixels and everything below the sky count as nothing
  };
  const dxs = /** @type {number[]} */ ([]), dys = /** @type {number[]} */ ([]), vals = /** @type {number[]} */ ([]);
  let mean = 0;
  for (let y = 0; y < ref.h; y++) {
    for (let x = 0; x < ref.w; x++) {
      const dx = x - ref.tx, dy = y - ref.ty, r = Math.hypot(dx, dy);
      if (r < TURN_INNER || r > outer) continue;
      const v = star(ref, x, y);
      dxs.push(dx); dys.push(dy); vals.push(v);
      mean += v;
    }
  }
  const n = vals.length;
  if (n < 50 || !(ref.noise > 0) || !(photo.noise > 0)) return { turn: NaN, score: NaN, sure: false };
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i++) { vals[i] -= mean; norm += vals[i] * vals[i]; }

  /** Agreement of the two star fields at one turn: their correlation, -1 to 1. @param {number} deg */
  const agreement = (deg) => {
    const t = deg * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    let sum = 0, sumB = 0, sumBB = 0;
    for (let i = 0; i < n; i++) {
      const x = photo.tx + cos * dxs[i] - sin * dys[i], y = photo.ty + sin * dxs[i] + cos * dys[i];
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const x1 = Math.min(x0 + 1, photo.w - 1), y1 = Math.min(y0 + 1, photo.h - 1);
      const b = (1 - fy) * ((1 - fx) * star(photo, x0, y0) + fx * star(photo, x1, y0))
        + fy * ((1 - fx) * star(photo, x0, y1) + fx * star(photo, x1, y1));
      sum += vals[i] * b; sumB += b; sumBB += b * b;
    }
    const spread = sumBB - sumB * sumB / n;
    return norm > 0 && spread > 0 ? sum / Math.sqrt(norm * spread) : -1;
  };

  // every 2 degrees first, then closer and closer around the best
  let best = near, bestScore = -Infinity;
  /** @type {[number, number][]} */
  const coarse = [];
  for (let d = -within; d < within; d += 2) {
    const s = agreement(near + d);
    coarse.push([near + d, s]);
    if (s > bestScore) { bestScore = s; best = near + d; }
  }
  for (const step of [0.5, 0.1]) {
    const from = best;
    for (let k = -4; k <= 4; k++) {
      const s = agreement(from + k * step);
      if (s > bestScore) { bestScore = s; best = from + k * step; }
    }
  }
  // clear means: the fields agree, and no turn far from the best one agrees nearly as well
  let rival = 0;
  for (const [d, s] of coarse) {
    const away = Math.abs(((d - best) % 360 + 540) % 360 - 180);
    if (away > 15 && s > rival) rival = s;
  }
  let turn = ((best % 360) + 540) % 360 - 180;
  if (Math.abs(turn) < NO_TURN_BELOW) turn = 0;
  return { turn, score: bestScore, sure: bestScore >= 0.3 && bestScore - rival >= 0.15 };
}

/**
 * Line a photo up with a reference: set its `turn`. A photo of the reference's own visit is looked for near no
 * turn first, since the telescope turns slowly. False when the turn could not be told: the photo must not be shown
 * beside or after the reference, because its stars would seem to jump.
 * @param {Photo} ref @param {Photo} photo
 */
export function lineUp(ref, photo) {
  if (photo === ref) {
    photo.turn = 0;
    return true;
  }
  let found = photo.visit === ref.visit ? findTurn(ref, photo, { near: 0, within: 30 }) : null;
  if (!found || !found.sure) found = findTurn(ref, photo);
  photo.turn = found.sure ? found.turn : NaN;
  return found.sure;
}

/**
 * The pixels of a drawn photo: red, green, blue and opacity for each of size*size pixels, the top row first. It
 * is the square of `size` photo pixels around the target, turned by the photo's `turn`. Every pixel takes the
 * value of the one nearest photo pixel: nothing is blended or smoothed. Where the photo has no value the pixel
 * stays clear.
 * @param {Uint8ClampedArray | Uint8Array} out  size*size*4 values, all 0 on entry.
 * @param {Photo} photo
 * @param {DisplayRule} rule
 * @param {number} size
 */
export function fillPixels(out, photo, rule, size) {
  const c = (size - 1) / 2;
  const t = (Number.isFinite(photo.turn) ? photo.turn : 0) * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  for (let j = 0; j < size; j++) {
    const dy = size - 1 - j - c;   // the first row of a photo is its lowest: it is drawn at the bottom
    for (let i = 0; i < size; i++) {
      const dx = i - c;
      const x = Math.round(photo.tx + cos * dx - sin * dy), y = Math.round(photo.ty + sin * dx + cos * dy);
      if (x < 0 || y < 0 || x >= photo.w || y >= photo.h) continue;
      const v = photo.shown[y * photo.w + x];
      if (!Number.isFinite(v)) continue;
      const k = (j * size + i) * 4, g = Math.round(255 * greyOf(v - photo.sky, rule));
      out[k] = g; out[k + 1] = g; out[k + 2] = g; out[k + 3] = 255;
    }
  }
}

/**
 * Draw a photo on a canvas, one canvas pixel for each photo pixel (see fillPixels). The page enlarges the canvas
 * without smoothing.
 * @param {HTMLCanvasElement} canvas
 * @param {Photo} photo
 * @param {DisplayRule} rule
 * @param {number} size
 */
export function paintPhoto(canvas, photo, rule, size) {
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(size, size);
  fillPixels(image.data, photo, rule, size);
  ctx.putImageData(image, 0, 0);
  canvas.dataset.photo = String(photo.index);
}

/** @param {number} mjd @returns {Date} */
const dateOf = (mjd) => new Date((mjd - 40587) * 86400000);

/** "26 February 2026" (UTC). @param {number} mjd */
export function formatDay(mjd) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(dateOf(mjd));
}

/** "February 2026" (UTC). @param {number} mjd */
export function formatMonth(mjd) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(dateOf(mjd));
}

/** "20:43 UTC". @param {number} mjd */
export function formatTime(mjd) {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(dateOf(mjd))} UTC`;
}

/** A wavelength as the number on the ruler: "4.266". @param {number} lam */
export function formatColour(lam) {
  return lam.toFixed(COLOUR_DECIMALS);
}

// ---- one loop at a time ----

/**
 * A loop of the page: something that changes a picture again and again.
 * @typedef {Object} Loop
 * @property {() => void} play  Start, and stop whichever other loop was playing. Does nothing when the visitor asked for less motion.
 * @property {() => void} pause  Stop, and stay stopped until play is called.
 * @property {() => void} auto  Let the loop play by itself: it starts whenever it comes into view, unless the visitor paused it or another loop is playing in view.
 * @property {() => boolean} playing  True from play to pause, also while the loop waits out of view.
 */

/** @type {Set<{stop: () => void, running: () => boolean, wake: () => void}>} */
const loops = new Set();

/** True when the visitor's system asks for less motion: then nothing plays by itself, and every change is a step. */
export function lessMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Make a loop. Only one loop of the page plays at a time; a loop waits while its element is out of view or the
 * page is hidden; no loop steps more often than twice a second.
 * @param {Element} element  What the loop changes: the loop waits while this is out of view.
 * @param {() => void} step  One change.
 * @param {(playing: boolean) => void} [onChange]  Called when the loop starts or stops.
 * @param {number} [period]  ms between two steps.
 * @returns {Loop}
 */
export function createLoop(element, step, onChange = () => {}, period = FLIP_MS) {
  // wanted: playing, or waiting to; byItself: may start without being asked; byHand: the visitor paused it;
  // seen: whether it is in view is known, not assumed
  let wanted = false, inView = true, byItself = false, byHand = false, seen = typeof IntersectionObserver !== 'function';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const every = Math.max(period, MIN_FLIP_MS);
  const tick = () => {
    timer = undefined;
    if (!wanted || !inView || document.hidden) return;
    step();
    timer = setTimeout(tick, every);
  };
  const sync = () => {
    if (wanted && inView && !document.hidden) {
      if (timer === undefined) timer = setTimeout(tick, every);
    } else if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const start = () => {
    for (const other of loops) if (other !== me) other.stop();
    wanted = true;
    sync();
    onChange(true);
  };
  const me = {
    stop() {
      if (!wanted) return;
      wanted = false;
      sync();
      onChange(false);
    },
    running: () => wanted && inView && !document.hidden,
    // a loop that plays by itself starts when it is in view and nothing else is playing there
    wake() {
      if (!byItself || !seen || !inView || wanted || byHand || lessMotion()) return;
      for (const other of loops) if (other !== me && other.running()) return;
      start();
    },
  };
  loops.add(me);
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      seen = true;
      inView = entries[entries.length - 1].isIntersecting;
      sync();
      // one that comes into view may start; one that leaves makes room for another that was waiting
      if (inView) me.wake();
      else for (const other of loops) other.wake();
    }, { threshold: 0.25 }).observe(element);
  }
  document.addEventListener('visibilitychange', sync);
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (lessMotion()) me.stop(); });
  }
  return {
    play() {
      if (wanted || lessMotion()) return;
      byHand = false;
      start();
    },
    pause() {
      byHand = true;
      me.stop();
    },
    auto() {
      byItself = true;
      me.wake();
    },
    playing: () => wanted,
  };
}

/**
 * A small element.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string>} [attributes]  `text` is the text inside; every other name is an attribute.
 * @param {(Node | string)[]} [children]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

// ---------------------------------------------------------------------------------------------
// The comet, from a showcase: what the plate of the lead item falls back to
// ---------------------------------------------------------------------------------------------

/**
 * What a showcase of the comet gives: the two photos of the plate, and the photos of the later visit by colour.
 * @typedef {Object} HeroPlan
 * @property {Photo} before  The earlier visit, at the colour of `after`.
 * @property {Photo} beside  The later visit at a neighbouring colour.
 * @property {Photo} after  The later visit at the colour that has a twin in the earlier visit.
 * @property {Photo[]} stops  The photos of the later visit, by colour.
 * @property {number} home  Position of `after` in `stops`.
 * @property {Map<Photo, Photo>} twins  For a photo of the later visit, the photo of an earlier visit at the same colour.
 * @property {DisplayRule} rule
 * @property {number} size  Side of the square that is drawn, photo pixels.
 */

/**
 * Read a showcase as the comet of the first page. The first pair of the manifest gives the earlier and the later
 * photo of the plate (`before` and `after`); the photos of the later visit, in colour order, are `stops`, and
 * the first of them that is not `after` is `beside`. Every photo is lined up with `after`; one that cannot be
 * is left out. Null when that leaves too little to show.
 * @param {Manifest} manifest
 * @param {Photo[]} photos
 * @returns {HeroPlan | null}
 */
export function planHero(manifest, photos) {
  const first = Array.isArray(manifest.pairs) ? manifest.pairs[0] : undefined;
  if (!first) return null;
  let before = photos[first[0]], after = photos[first[1]];
  if (!before || !after || before.visit === after.visit) return null;
  if (before.visit > after.visit) [before, after] = [after, before];

  /** @type {Map<Photo, Photo>} */
  const twins = new Map();
  for (const [i, j] of manifest.pairs) {
    const a = photos[i], b = photos[j];
    if (!a || !b) continue;
    const [early, late] = a.visit < b.visit ? [a, b] : [b, a];
    if (late.visit === after.visit && early.visit < late.visit && !twins.has(late) && lineUp(after, early)) twins.set(late, early);
  }
  if (twins.get(after) !== before) return null;

  const stops = photos.filter((p) => p.visit === after.visit && lineUp(after, p)).sort((p, q) => p.lam - q.lam);
  const beside = stops.find((p) => p !== after);
  if (!beside) return null;
  const all = [...stops, ...twins.values()];
  const rule = displayRule(all);
  if (!rule) return null;
  return { before, beside, after, stops, home: stops.indexOf(after), twins, rule, size: viewSize(all) };
}

// ---------------------------------------------------------------------------------------------
// The photos of the comet's field
// ---------------------------------------------------------------------------------------------

/**
 * One picture of the comet's field, as the manifest beside it names it (site/data/lemmon/wide).
 * @typedef {Object} FieldPicture
 * @property {string} file  The picture, beside the manifest.
 * @property {number} mjd  Mid-exposure time, MJD (UTC).
 * @property {number} lam_um  Wavelength at the comet's place, µm.
 * @property {number} bw_um  Bandwidth there, µm.
 * @property {[number, number] | null} comet_px  Where the comet is in the picture; null when it is not in it.
 */

/**
 * What the page makes of the pictures of a field.
 * @typedef {Object} FieldPlan
 * @property {FieldPicture} before  The earliest picture that does not hold the comet.
 * @property {FieldPicture} after  Of the pictures that hold the comet, the one at the colour of `before`.
 * @property {FieldPicture[]} night  The pictures that hold the comet, by colour.
 */

/** @param {any} p @returns {p is FieldPicture} */
function isPicture(p) {
  return Boolean(p) && typeof p.file === 'string' && Number.isFinite(p.mjd) && Number.isFinite(p.lam_um) && Number.isFinite(p.bw_um)
    && (p.comet_px === null || Array.isArray(p.comet_px));
}

/**
 * Read the pictures of a field as the page uses them. The plate flips between the earliest picture without the
 * comet and the picture with the comet that is nearest to it in colour; the two must be at the same colour by
 * the match rule of the site (CT-6: within MATCH_BANDWIDTH_FRACTION of the smaller bandwidth). Null when there is
 * no such pair.
 * @param {FieldPicture[]} pictures
 * @returns {FieldPlan | null}
 */
export function planField(pictures) {
  const before = pictures.filter((p) => p.comet_px === null).sort((a, b) => a.mjd - b.mjd)[0];
  const night = pictures.filter((p) => p.comet_px !== null).sort((a, b) => a.lam_um - b.lam_um);
  if (!before || night.length === 0) return null;
  let after = night[0];
  for (const p of night) if (Math.abs(p.lam_um - before.lam_um) < Math.abs(after.lam_um - before.lam_um)) after = p;
  if (Math.abs(after.lam_um - before.lam_um) > MATCH_BANDWIDTH_FRACTION * Math.min(after.bw_um, before.bw_um)) return null;
  return { before, after, night };
}

/** @type {Map<string, Promise<{pictures: FieldPicture[]} | null>>} */
const fields = new Map();

/**
 * Fetch the manifest of the pictures of a field, once for the page however many parts ask for it. Null when it
 * cannot be had or is not one.
 * @param {string | URL} manifestUrl
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{pictures: FieldPicture[]} | null>}
 */
export function loadField(manifestUrl, fetchFn = globalThis.fetch) {
  const key = String(manifestUrl);
  let got = fields.get(key);
  if (!got) {
    got = (async () => {
      try {
        const r = await fetchFn(key);
        if (!r.ok) return null;
        const manifest = await r.json();
        return Array.isArray(manifest?.pictures) && manifest.pictures.every(isPicture) ? manifest : null;
      } catch {
        return null;
      }
    })();
    fields.set(key, got);
  }
  return got;
}

/**
 * Write when a photo was taken and at which colour into the places an element keeps for them: `data-when="day"`
 * takes the day, `data-when="time"` the time of day, `data-colour` the wavelength.
 * @param {Element} holder @param {number} mjd @param {number} lam
 */
function writeWhenAndColour(holder, mjd, lam) {
  for (const place of holder.querySelectorAll('[data-when]')) {
    place.textContent = place.getAttribute('data-when') === 'time' ? formatTime(mjd) : formatDay(mjd);
    if (place instanceof HTMLTimeElement) place.dateTime = `${dateOf(mjd).toISOString().slice(0, place.getAttribute('data-when') === 'time' ? 16 : 10)}${place.getAttribute('data-when') === 'time' ? 'Z' : ''}`;
  }
  for (const place of holder.querySelectorAll('[data-colour]')) place.textContent = formatColour(lam);
}

/**
 * Point the picture of an element at a picture of a field and write its date and colour beside it.
 * @param {Element} holder @param {FieldPicture} picture @param {URL} manifestUrl
 * @returns {HTMLImageElement | null}  The picture, or null when the element has none.
 */
function showPicture(holder, picture, manifestUrl) {
  const img = holder.querySelector('img');
  if (!(img instanceof HTMLImageElement)) return null;
  const src = String(new URL(picture.file, manifestUrl));
  if (img.src !== src) img.src = src;
  writeWhenAndColour(holder, picture.mjd, picture.lam_um);
  return img;
}

// ---------------------------------------------------------------------------------------------
// The plate of the lead item: two photos of one patch of sky, flipped on the beat of the page
// ---------------------------------------------------------------------------------------------

/** The small drawings of the controls, each one stroke on a square of 12: nothing here is a letter or a sign of a font. */
const DRAWINGS = Object.freeze({
  pause: 'M3.5 2v8M8.5 2v8',
  play: 'M3 2l7 4-7 4z',
  flip: 'M1.5 4h9M8 1.5L10.5 4 8 6.5M10.5 8h-9M4 5.5L1.5 8 4 10.5',
  previous: 'M10.5 6h-9M5 2.5L1.5 6 5 9.5',
  next: 'M1.5 6h9M7 2.5L10.5 6 7 9.5',
});

/**
 * A small drawing for a control.
 * @param {keyof typeof DRAWINGS} name
 * @returns {SVGSVGElement}
 */
export function drawing(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  for (const [key, value] of Object.entries({ viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  path.setAttribute('d', DRAWINGS[name]);
  svg.append(path);
  return svg;
}

/**
 * The two photos of the plate from the pictures of the comet's field. Null when the pictures cannot be had: the
 * plate then asks the showcase.
 * @param {HTMLElement} root @param {HTMLElement} before @param {HTMLElement} after
 * @returns {Promise<[number, number] | null>}  When the two photos were taken, MJD.
 */
async function platesFromField(root, before, after) {
  const address = root.dataset.manifest;
  if (!address) return null;
  const url = new URL(address, document.baseURI);
  const field = await loadField(url);
  const plan = field && planField(field.pictures);
  if (!plan) return null;
  try {
    await Promise.all([showPicture(before, plan.before, url), showPicture(after, plan.after, url)].map((img) => (img ? img.decode() : Promise.reject(new Error('no picture')))));
  } catch {
    return null;
  }
  return [plan.before.mjd, plan.after.mjd];
}

/**
 * The two photos of the plate drawn from a showcase (CT-8), pixel for pixel: what the plate falls back to while
 * the pictures of the field are missing. Null when the showcase cannot be had either.
 * @param {HTMLElement} root @param {HTMLElement} before @param {HTMLElement} after
 * @returns {Promise<[number, number] | null>}  When the two photos were taken, MJD.
 */
async function platesFromShowcase(root, before, after) {
  const address = root.dataset.showcase;
  if (!address) return null;
  const showcase = await loadShowcase(new URL(address, document.baseURI));
  const plan = showcase && planHero(showcase.manifest, showcase.photos);
  if (!plan) return null;
  for (const [state, photo] of /** @type {[HTMLElement, Photo][]} */ ([[before, plan.before], [after, plan.after]])) {
    const plate = state.querySelector('[data-plate]'), img = state.querySelector('img');
    if (!plate) return null;
    const canvas = el('canvas', { role: 'img', 'aria-label': img?.getAttribute('alt') ?? '' });
    paintPhoto(canvas, photo, plan.rule, plan.size);
    if (img) img.replaceWith(canvas);
    else plate.prepend(canvas);
    writeWhenAndColour(state, photo.mjd, photo.lam);
  }
  return [plan.before.mjd, plan.after.mjd];
}

/**
 * Bring the plate of the lead item to life. As the page is written, the plate holds two states side by side
 * (`data-state="before"` and `"after"`), each a photo with its verdict and its cells. Here the two are laid on
 * each other and shown in turn on the beat of the page, so that the photo, the verdict and the cells change in
 * place, at once. A control under the plate pauses it. When the visitor asked for less motion nothing plays by
 * itself: the control flips the plate once for each press.
 *
 * The element names the pictures of the comet's field in `data-manifest`, and in `data-showcase` the showcase it
 * draws its two photos from while those pictures are missing. When neither can be had, the page stays as it is
 * written.
 * @param {HTMLElement} root
 * @returns {Promise<boolean>}  True when the plate is live.
 */
export async function mountFlip(root) {
  const before = root.querySelector('[data-state="before"]'), after = root.querySelector('[data-state="after"]');
  const holder = root.querySelector('.flip-states');
  if (!(before instanceof HTMLElement) || !(after instanceof HTMLElement) || !(holder instanceof HTMLElement)) return false;
  const taken = await platesFromField(root, before, after) ?? await platesFromShowcase(root, before, after);
  if (!taken) return false;
  const months = { before: formatMonth(taken[0]).toUpperCase(), after: formatMonth(taken[1]).toUpperCase() };

  /** @type {'before' | 'after'} */
  let shows = 'after';
  const other = () => (shows === 'after' ? 'before' : 'after');
  const control = el('button', { type: 'button', class: 'btn flip-control', 'data-flip-control': '' });

  const render = () => {
    root.dataset.shows = shows;
    if (lessMotion()) control.replaceChildren(drawing('flip'), `FLIP TO ${months[other()]}`);
    else if (loop.playing()) control.replaceChildren(drawing('pause'), 'PAUSE THE BLINK');
    else control.replaceChildren(drawing('play'), 'PLAY THE BLINK');
  };

  const loop = createLoop(holder, () => {
    shows = other();
    render();
  }, () => render(), beat());

  control.addEventListener('click', () => {
    if (lessMotion()) shows = other();
    else if (loop.playing()) loop.pause();
    else {
      shows = other();                // the first flip is at once, so the press is answered
      loop.play();
    }
    render();
  });
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', render);

  holder.after(control);
  root.classList.add('is-live');
  render();
  loop.auto();
  return true;
}

// ---------------------------------------------------------------------------------------------
// One night on the ruler: the photos of the comet at their colours, and a chip that goes from one to the next
// ---------------------------------------------------------------------------------------------

/**
 * Bring the ruler of the night to life. As the page is written, the element holds the photos of the night in
 * order of colour (each marked `data-night-photo`, with `data-band="inside"` where carbon dioxide glows) inside
 * the element marked `data-night-ruler`. Here a chip is laid along the ruler: it steps from photo to photo, by
 * keyboard or by pointer; the photo it is on stands in a heavy frame, and a line under the ruler says what that
 * photo is. A press on a photo brings the chip to it.
 *
 * The element names the pictures in `data-manifest`: the photos, their times and their colours are read from
 * that manifest. When it cannot be had, or does not hold as many photos as the page, the page stays as it is.
 * @param {HTMLElement} root
 * @returns {Promise<boolean>}  True when the chip is in place.
 */
export async function mountNight(root) {
  const address = root.dataset.manifest, ruler = root.querySelector('[data-night-ruler]');
  const items = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-night-photo]')]);
  if (!address || !(ruler instanceof HTMLElement) || items.length < 2) return false;
  const url = new URL(address, document.baseURI);
  const field = await loadField(url);
  const plan = field && planField(field.pictures);
  if (!plan || plan.night.length !== items.length) return false;
  const stops = plan.night;
  for (const [i, item] of items.entries()) showPicture(item, stops[i], url);

  let at = stops.indexOf(plan.after);
  const lo = stops[0].lam_um, hi = stops[stops.length - 1].lam_um;
  /** Where a colour lies on the ruler, 0 at the first photo to 1000 at the last. @param {number} lam */
  const place = (lam) => (hi > lo ? Math.round(1000 * (lam - lo) / (hi - lo)) : 0);
  const input = el('input', { type: 'range', class: 'scale-input night-input', min: '0', max: '1000', step: '1', 'aria-label': 'Colour of the photo in the heavy frame' });
  const readout = el('p', { class: 'readout night-readout', 'data-night-readout': '' });

  const render = () => {
    const picture = stops[at], item = items[at];
    for (const [i, each] of items.entries()) each.classList.toggle('is-on', i === at);
    const where = item.dataset.band === 'inside' ? 'where carbon dioxide glows' : 'beside the colours of carbon dioxide';
    const bright = item.querySelector('.night-data [data-n]')?.textContent ?? '';
    const day = formatDay(picture.mjd), time = formatTime(picture.mjd), colour = formatColour(picture.lam_um);
    input.value = String(place(picture.lam_um));
    input.setAttribute('aria-valuetext', `${colour} micrometres, ${where}: photo ${at + 1} of ${stops.length}, ${day}, ${time}`);
    readout.textContent = `PHOTO ${at + 1} OF ${stops.length}: ${day.toUpperCase()}, ${time}. COLOUR ${colour} µm, ${where.toUpperCase()}.${bright ? ` BRIGHTNESS ${bright} mJy.` : ''}`;
  };

  /** Move the chip. @param {number} to */
  const go = (to) => {
    at = Math.max(0, Math.min(stops.length - 1, to));
    render();
  };
  input.addEventListener('input', () => {
    const want = Number(input.value);
    let nearest = 0;
    for (const [i, p] of stops.entries()) if (Math.abs(place(p.lam_um) - want) < Math.abs(place(stops[nearest].lam_um) - want)) nearest = i;
    go(nearest);
  });
  input.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1 }[event.key];
    if (step !== undefined) go(at + step);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(stops.length - 1);
    else return;
    event.preventDefault();
  });
  for (const [i, item] of items.entries()) item.querySelector('[data-plate]')?.addEventListener('click', () => go(i));

  ruler.append(input, readout);
  render();
  root.classList.add('is-live');
  return true;
}

/**
 * Draw a bar under each photo of the night, as long as the comet is bright in it: the longest bar is the
 * brightest photo. The page holds the brightness of each photo as text (filled by the gate); the bars need
 * them as numbers, which are read from numbers.json. Without them the text stands alone.
 * @param {HTMLElement} root  The element that holds the photos of the night.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<boolean>}  True when the bars are drawn.
 */
export async function mountBars(root, fetchFn = globalThis.fetch) {
  const items = [...root.querySelectorAll('[data-night-photo]')];
  const bars = items.map((item) => item.querySelector('.meter-bar')), spans = items.map((item) => item.querySelector('.night-data [data-n]'));
  if (items.length === 0 || !spans.every((s) => s instanceof HTMLElement && s.textContent !== '')) return false;
  /** @type {Numbers} */
  let numbers;
  try {
    const r = await fetchFn(String(new URL(NUMBERS_FILE, document.baseURI)));
    if (!r.ok) return false;
    numbers = await r.json();
  } catch {
    return false;
  }
  const fills = barFills(spans.map((s) => numbers[/** @type {HTMLElement} */ (s).dataset.n ?? '']?.value));
  if (!fills) return false;
  for (const [i, bar] of bars.entries()) if (bar instanceof HTMLElement) bar.style.setProperty('--fill', fills[i].toFixed(4));
  return true;
}

/**
 * The length of each bar under the photos of the night, 0 to 1: each brightness over the largest. A brightness
 * below zero, which noise can give where there is nothing, draws no bar. Null when a number is missing or when
 * nothing is brighter than zero.
 * @param {(number | undefined)[]} values
 * @returns {number[] | null}
 */
export function barFills(values) {
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const top = Math.max(.../** @type {number[]} */ (values));
  return top > 0 ? /** @type {number[]} */ (values).map((v) => Math.max(v, 0) / top) : null;
}
