// The panels beside the stage: the frame map, the spectrum and "Is it real?". One call mounts the three and ties them
// to each other and to the page:
//
//   const panels = mountPanels({ frameMap, spectrum, isItReal }, { showFrame, selectFrames, loadAllColours });
//   panels.setFrames(frames);        every photo of the position: {key, det, mjd, lam, bw, visit, loaded, flagged}
//   panels.setPictures(stamps);      the stamps as they arrive: the shared form, on the display grid, with `sky`
//   panels.setSelection(keys);       the photos the stage is blinking
//   panels.pointAt({ra, dec, x, y, values} | null);   the place the visitor clicked
//   panels.destroy();
//
// What the panels ask of the page: showFrame(key) to show one photo on the stage (null to go back), selectFrames(keys)
// to blink only those photos (an empty list to go back to all), loadAllColours() to load the other detectors.
// Hovering a dot, a point of the spectrum and the photo on the stage always name the same file.
//
// Nothing is stored and nothing is sent.

/** @import { Picture, Item } from './isitreal.js' */
/** @import { MapFrame } from './framemap.js' */
/** @import { Spectrum, Showcase } from './spectrum.js' */
import { separationDeg } from '../lib/gaia.js';
import { createFrameMap } from './framemap.js';
import { assess, createIsItReal, excessAt, itemsOf, notReady, placeOf } from './isitreal.js';
import { allColoursCost, changeSpectrum, createSpectrum, parseShowcase, spectrumFor } from './spectrum.js';
import { loadFast } from './rings.js';

/** A clicked place this close to the target (pixels) gets the precomputed spectrum of the target, when there is one. */
export const TARGET_PX = 2.5;
/** A place shows in a photo when it stands this many times the noise above the photo's sky. */
export const PRESENT_UNITS = 5;
/** A target counts as the position shown when it is within this many arcsec of the picture's centre. */
export const TARGET_ARCSEC = 60;

/**
 * @typedef {Object} PanelRoots
 * @property {HTMLElement} frameMap
 * @property {HTMLElement} spectrum
 * @property {HTMLElement} isItReal
 */

/**
 * @typedef {Object} PanelApi
 * @property {(key: string | null) => void} showFrame
 * @property {(keys: string[]) => void} selectFrames
 * @property {() => Promise<unknown> | void} loadAllColours
 */

/**
 * @typedef {Object} Pick
 * @property {number} [ra] @property {number} [dec]  Degrees.
 * @property {number} [x] @property {number} [y]  Pixel on the display grid.
 * @property {unknown} [values]
 */

/**
 * @typedef {Object} PanelOptions
 * @property {string} [base]  Address of the site's top folder, ending in "/"; default "" (the page's own folder).
 * @property {typeof fetch} [fetchFn]
 * @property {boolean} [fast]  False to leave out fast.json (no rings, no fast-star check).
 * @property {boolean} [spectra]  False to leave out the precomputed spectra.
 * @property {(text: string) => Promise<void> | void} [copy]  Replaces the clipboard, for tests.
 * @property {(answer: Answer | null) => void} [onAnswer]  Called with the short answers for the place that was clicked, and null when there is none.
 */

/**
 * What the two panels say about the clicked place, in one line each, for the page to show beside the picture.
 * @typedef {Object} Answer
 * @property {string} real  The line of "Is it real?": its verdict, or why it cannot be given.
 * @property {boolean} realReady  True when the verdict comes from the checks.
 * @property {string} spectrum  The line of the spectrum: that one was made, or why not.
 * @property {boolean} spectrumReady  True when a spectrum was made.
 */

/**
 * @param {PanelRoots} roots
 * @param {PanelApi} api
 * @param {PanelOptions} [options]
 */
export function mountPanels(roots, api, options = {}) {
  const { base = '', fetchFn = globalThis.fetch } = options;
  /** @type {MapFrame[]} */
  let frames = [];
  /** @type {Picture[]} */
  let stamps = [];
  /** @type {string[]} */
  let selection = [];
  /** @type {Pick | null} */
  let pick = null;
  /** @type {string | null} */
  let hoverKey = null;
  /** @type {Showcase | null} */
  let showcase = null;
  let showcaseAsked = '';
  let timer = 0;
  let dead = false;

  /** @param {string | null} key  @param {'map' | 'spectrum'} from */
  function hover(key, from) {
    if (hoverKey === key) return;
    hoverKey = key;
    api.showFrame(key);
    if (from === 'spectrum') map.setHover(key);
    spectrum.show({ lit: litKeys() });
  }
  const litKeys = () => new Set(hoverKey ? [hoverKey] : []);

  const map = createFrameMap(roots.frameMap, {
    onHover: (key) => hover(key, 'map'),
    onBand(band, keys) {
      if (!band) { selection = []; map.setSelected([]); map.setBandNote(''); api.selectFrames([]); schedule(); return; }
      if (!keys.loaded.length) {
        map.setBandNote(`${keys.all.length} ${keys.all.length === 1 ? 'photo is' : 'photos are'} in this band of colour and none is loaded yet.`);
        return;
      }
      selection = keys.loaded;
      map.setSelected(keys.loaded);
      map.setBandNote(`${keys.loaded.length} of the ${keys.all.length} photos in this band are loaded, and the stage blinks them.`);
      api.selectFrames(keys.loaded);
      schedule();
    },
  });
  const spectrum = createSpectrum(roots.spectrum, { onHover: (key) => hover(key, 'spectrum'), onLoadAll: () => api.loadAllColours() });
  const real = createIsItReal(roots.isItReal, { copy: options.copy });
  if (options.fast !== false) loadFast(base, fetchFn).then(() => { if (!dead) schedule(); });

  function pushFrames() {
    const have = new Set(stamps.map((s) => s.key));
    map.setFrames(frames.map((f) => (have.has(f.key) && !f.loaded ? { ...f, loaded: true } : f)));
  }

  /** The spectrum file of the target in the picture, if the place on screen is a named target that has one. */
  async function lookForShowcase() {
    const sky = stamps.find((p) => p.sky)?.sky;
    if (!sky || options.spectra === false) return;
    const at = `${sky.ra.toFixed(4)},${sky.dec.toFixed(4)}`;
    if (at === showcaseAsked) return;
    showcaseAsked = at;
    showcase = null;
    try {
      const names = await (await fetchFn(`${base}data/names.json`)).json();
      const hit = /** @type {{id: string, ra: number, dec: number}[]} */ (names.entries ?? []).find((e) => separationDeg(e.ra, e.dec, sky.ra, sky.dec) * 3600 <= TARGET_ARCSEC);
      if (!hit) return;
      // the list of the spectra that exist: a target without one is not asked for
      const listed = await (await fetchFn(`${base}data/spectra/index.json`)).json();
      if (!(/** @type {string[]} */ (listed.ids ?? [])).includes(hit.id)) return;
      const r = await fetchFn(`${base}data/spectra/${hit.id}.json`);
      if (!r.ok) return;
      const got = parseShowcase(await r.json());
      if (!dead && showcaseAsked === at) { showcase = got; schedule(); }
    } catch { /* no precomputed spectrum: the live one is shown */ }
  }

  function schedule() {
    if (dead || timer) return;
    timer = /** @type {any} */ (setTimeout(flush, 30));
  }

  /** Work out everything at once. */
  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (dead) return;
    const place = pick ? placeOf(pick, stamps) : null;
    if (!pick || !place || !stamps.length) {
      map.setPresent(null);
      spectrum.show({ mode: 'none', spectrum: null, change: null, showcase: null, cost: null, lit: litKeys() });
      const why = stamps.length ? 'Click a place inside the picture.' : 'No photo is loaded yet.';
      real.show(pick ? notReady(why) : null);
      options.onAnswer?.(pick ? { real: why, realReady: false, spectrum: why, spectrumReady: false } : null);
      return;
    }
    const [x, y] = place;
    const items = itemsOf(stamps, frames);
    // where the place shows: the photos in which it stands 3 times above its sky
    /** @type {Set<string>} */
    const keys = new Set();
    let checked = 0;
    for (const it of items) {
      const u = excessAt(it.stamp, x, y);
      if (!Number.isFinite(u)) continue;
      checked++;
      if (u >= PRESENT_UNITS) keys.add(it.key);
    }
    map.setPresent({ keys, checked });
    const sp = spectrumFor(items, x, y);
    const s0 = stamps[0];
    const atTarget = Boolean(showcase) && Math.hypot(x - s0.tx, y - s0.ty) <= TARGET_PX;
    spectrum.show({
      mode: atTarget ? 'showcase' : 'live', spectrum: sp, change: sp.state === 'ok' ? changeSpectrum(sp, items, selection) : null,
      showcase: atTarget ? showcase : null, cost: allColoursCost(frames, items, selection), lit: litKeys(),
    });
    const said = assess({ pick, stamps, frames, selection });
    real.show(said);
    options.onAnswer?.({
      real: said.ready ? said.verdict : said.why, realReady: said.ready,
      spectrum: sp.state === 'ok' ? `A spectrum was made: ${sp.points.length} of ${sp.photos} photos measured here.` : sp.state === 'too-bright' ? 'No spectrum: too bright to measure here.' : sp.state === 'too-faint' ? 'No spectrum: too faint here.' : 'No spectrum: no photo can be measured here.', spectrumReady: sp.state === 'ok',
    });
  }

  return {
    /** @param {MapFrame[]} next */
    setFrames(next) { frames = next; pushFrames(); schedule(); },
    /** @param {Picture[]} next */
    setPictures(next) { stamps = next; pushFrames(); lookForShowcase(); schedule(); },
    /** @param {string[]} keys */
    setSelection(keys) { selection = [...keys]; map.setSelected(selection); schedule(); },
    /** @param {Pick | null} p */
    pointAt(p) { pick = p; flush(); },
    /** Work out now what would otherwise wait a moment. */
    flush,
    /** For tests and for the page: the parts. */
    parts: { map, spectrum, real },
    destroy() {
      dead = true;
      clearTimeout(timer);
      map.destroy();
      roots.spectrum.replaceChildren();
      roots.isItReal.replaceChildren();
    },
  };
}
