// "A plain blink lies": one small stage that plays the photos of a showcase (CT-8) three ways, and a meter
// that says how much steady stars seem to change in each.
//
//   all       every photo of one visit, in time order: each is at a different colour
//   detector  the photos of that visit from one detector only: a narrower range of colours
//   matched   two photos months apart at the same colour: what the tool blinks
//
// The stage shows one photo at a time under one display rule; below it a short colour ruler shows the colour of
// the photo that is on. Nothing here touches the page until mountLie or mountMeter is called.

/** @import { Manifest, Numbers } from '../contracts.js' */
/** @import { Photo, DisplayRule } from './hero.js' */
import { NUMBERS_FILE } from '../contracts.js';
import {
  loadShowcase, displayRule, viewSize, lineUp, paintPhoto, createLoop, lessMotion, el, drawing, beat,
  formatDay, formatTime, formatColour,
} from './hero.js';

/** The three stops, in the order of the page. */
export const STOPS = Object.freeze(/** @type {const} */ (['all', 'detector', 'matched']));

/** @typedef {typeof STOPS[number]} Stop */

/**
 * What the stage plays.
 * @typedef {Object} LiePlan
 * @property {Record<Stop, Photo[]>} photos  The photos of each stop, in the order they are played.
 * @property {DisplayRule} rule  One rule for every photo of every stop.
 * @property {number} size  Side of the square that is drawn, photo pixels.
 * @property {{min: number, max: number}} range  The ends of the colour ruler, µm.
 * @property {number} left  Photos left out because they could not be lined up with the others.
 */

/**
 * Read a showcase as the three stops. The visit with the most photos gives "all" and, with the detector the
 * manifest names, "detector"; the pair of the manifest whose two colours are closest gives "matched". Every photo
 * is lined up with one reference photo; one that cannot be is left out. Null when a stop is left with fewer than
 * two photos.
 * @param {Manifest} manifest
 * @param {Photo[]} photos
 * @returns {LiePlan | null}
 */
export function planLie(manifest, photos) {
  /** @type {Map<number, Photo[]>} */
  const visits = new Map();
  for (const p of photos) visits.set(p.visit, [...(visits.get(p.visit) ?? []), p]);
  let visit = -1, most = 0;
  for (const [v, list] of visits) if (list.length > most || (list.length === most && v > visit)) { visit = v; most = list.length; }

  /** @type {[Photo, Photo] | null} */
  let pair = null;
  for (const [i, j] of Array.isArray(manifest.pairs) ? manifest.pairs : []) {
    const a = photos[i], b = photos[j];
    if (!a || !b || a.visit === b.visit) continue;
    if (!pair || Math.abs(a.lam - b.lam) < Math.abs(pair[0].lam - pair[1].lam)) pair = a.mjd <= b.mjd ? [a, b] : [b, a];
  }
  if (!pair) return null;

  const inVisit = (visits.get(visit) ?? []).slice().sort((p, q) => p.mjd - q.mjd);
  const ref = pair.find((p) => p.visit === visit) ?? inVisit.find((p) => p.det === manifest.det) ?? inVisit[0];
  if (!ref) return null;
  const wanted = new Set([...inVisit, ...pair]);
  let left = 0;
  for (const p of wanted) if (!lineUp(ref, p)) left++;
  /** @param {Photo} p */
  const ok = (p) => Number.isFinite(p.turn);
  const all = inVisit.filter(ok), detector = all.filter((p) => p.det === manifest.det), matched = pair.filter(ok);
  if (all.length < 2 || detector.length < 2 || matched.length < 2) return null;

  const used = [...new Set([...all, ...matched])];
  const rule = displayRule(used);
  if (!rule) return null;
  const lams = used.map((p) => p.lam), min = Math.min(...lams), max = Math.max(...lams), pad = Math.max((max - min) * 0.03, 1e-6);
  return { photos: { all, detector, matched }, rule, size: viewSize(used), range: { min: min - pad, max: max + pad }, left };
}

/**
 * The length of each bar of the meter, 0 to 1, from the three numbers. The numbers are factors ("steady stars
 * seem to change 2.7 times over"), so the bars are on a logarithmic scale that starts at 1, no change; the longest
 * bar is the largest factor. A factor below 1 is as far from no change as its inverse. Null when a number is
 * missing or cannot be a factor.
 * @param {(number | undefined)[]} values
 * @returns {number[] | null}
 */
export function meterFills(values) {
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null;
  const logs = /** @type {number[]} */ (values).map((v) => Math.abs(Math.log(v))), top = Math.max(...logs);
  return logs.map((v) => (top > 0 ? v / top : 0));
}

/**
 * Draw the bars of the meter beside the three stops. The page holds the numbers as text (filled by the gate);
 * the bars need them as numbers, which are read from numbers.json. Without them the text stands alone.
 * @param {HTMLElement} root  The part of the page that holds the stops.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<boolean>}  True when the bars are drawn.
 */
export async function mountMeter(root, fetchFn = globalThis.fetch) {
  const spans = STOPS.map((stop) => root.querySelector(`[data-stop="${stop}"] [data-n]`));
  if (!spans.every((s) => s instanceof HTMLElement && s.textContent !== '')) return false;
  /** @type {Numbers} */
  let numbers;
  try {
    const r = await fetchFn(String(new URL(NUMBERS_FILE, document.baseURI)));
    if (!r.ok) return false;
    numbers = await r.json();
  } catch {
    return false;
  }
  const fills = meterFills(spans.map((s) => numbers[/** @type {HTMLElement} */ (s).dataset.n ?? '']?.value));
  if (!fills) return false;
  for (const [i, stop] of STOPS.entries()) {
    const bar = root.querySelector(`[data-stop="${stop}"] .meter-bar`);
    if (bar instanceof HTMLElement) bar.style.setProperty('--fill', fills[i].toFixed(4));
  }
  return true;
}

/**
 * Build the stage. The element names its showcase in `data-manifest` (address of manifest.json) and holds an
 * empty element marked `data-lie-stage`, where the stage goes, and the list of stops marked `data-stops`, whose
 * items (`data-stop`) become a choice. When the showcase cannot be had, the page stays as it is.
 * @param {HTMLElement} root
 * @returns {Promise<boolean>}  True when the stage is in place.
 */
export async function mountLie(root) {
  const address = root.dataset.manifest;
  const stage = root.querySelector('[data-lie-stage]'), list = root.querySelector('[data-stops]');
  if (!address || !(stage instanceof HTMLElement) || !(list instanceof HTMLElement)) return false;
  const showcase = await loadShowcase(new URL(address, document.baseURI));
  const plan = showcase && planLie(showcase.manifest, showcase.photos);
  if (!plan) return false;
  const name = showcase.manifest.name;

  /** @type {Stop} */
  let stop = 'all';
  let at = 0;
  const sequence = () => plan.photos[stop];

  // ---- the photo ----
  const canvas = el('canvas', { role: 'img' });
  const tag = el('span', { class: 'plate-tag', 'aria-hidden': 'true' });
  const plate = el('div', { class: 'plate', 'data-plate': '' }, [canvas, tag]);

  // ---- the colour of the photo, on a ruler ----
  const ticks = el('ol', { class: 'scale-ticks', 'aria-hidden': 'true' });
  const chip = el('span', { class: 'scale-chip', 'aria-hidden': 'true' });
  /** Where a colour lies on the ruler, 0 to 1. @param {number} lam */
  const place = (lam) => (lam - plan.range.min) / (plan.range.max - plan.range.min);
  const ends = [plan.range.min, plan.range.max].map((lam, i) => el('li', { class: 'scale-tick scale-end', style: `--at: ${i * 100}%` }, [
    el('span', { class: 'scale-tick-value', text: lam.toFixed(1) }),
  ]));
  const scale = el('div', { class: 'scale' }, [
    el('span', { class: 'scale-label' }, ['Colour of the photo that is on', el('span', { class: 'scale-unit', text: ', in micrometres' })]),
    el('div', { class: 'scale-track' }, [ticks, chip]),
  ]);

  // ---- what is on, in words ----
  const readout = el('p', { class: 'readout' });
  const spoken = el('p', { class: 'visually-hidden', role: 'status' });

  // ---- the buttons ----
  const play = el('button', { type: 'button', class: 'btn transport-play', text: 'PLAY' });
  const previous = el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Previous photo' }, [drawing('previous')]);
  const next = el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Next photo' }, [drawing('next')]);
  const transport = el('div', { class: 'transport' }, [play, previous, next]);

  /** @param {boolean} [say]  Also tell a screen reader: for a step the visitor asked for, never for the loop. */
  const render = (say = false) => {
    const photos = sequence(), photo = photos[at];
    paintPhoto(canvas, photo, plan.rule, plan.size);
    const when = `${formatDay(photo.mjd)}, ${formatTime(photo.mjd)}`;
    const words = `Photo ${at + 1} of ${photos.length}: ${when}, colour ${formatColour(photo.lam)}`;
    canvas.setAttribute('aria-label', `${name} and the stars around it. ${words} micrometres.`);
    tag.textContent = when;
    readout.textContent = `${words}`;
    if (say) spoken.textContent = `${words} micrometres.`;
    chip.dataset.det = String(photo.det);
    chip.style.setProperty('--at-fraction', place(photo.lam).toFixed(4));
    play.textContent = loop.playing() ? 'PAUSE' : 'PLAY';
    play.hidden = lessMotion();
  };

  /** The ticks of the ruler: one for each photo of the stop that is chosen. */
  const drawTicks = () => {
    ticks.replaceChildren(...ends, ...sequence().map((p) => el('li', { class: 'scale-tick', 'data-det': String(p.det), style: `--at: ${(100 * place(p.lam)).toFixed(2)}%` })));
  };

  const loop = createLoop(plate, () => {
    at = (at + 1) % sequence().length;
    render();
  }, () => render(), beat());

  /** @param {number} by */
  const step = (by) => {
    loop.pause();
    const n = sequence().length;
    at = (at + by + n) % n;
    render(true);
  };
  play.addEventListener('click', () => (loop.playing() ? loop.pause() : loop.play()));
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  // ---- the three stops become a choice ----
  list.setAttribute('role', 'radiogroup');
  for (const item of list.querySelectorAll('[data-stop]')) {
    const text = item.querySelector('.stop-text'), value = /** @type {HTMLElement} */ (item).dataset.stop;
    if (!text || !STOPS.includes(/** @type {Stop} */ (value))) continue;
    const input = el('input', { type: 'radio', name: 'lie-stop', value: String(value) });
    input.checked = value === stop;
    input.addEventListener('change', () => {
      stop = /** @type {Stop} */ (value);
      at = 0;
      drawTicks();
      render(true);
    });
    item.setAttribute('role', 'none');
    item.prepend(el('label', { class: 'stop-choice' }, [input, text]));
  }

  stage.replaceChildren(plate, readout, spoken, scale, transport, el('p', { class: 'note lie-note', text: `${name}, at the centre, is the one star here that really varies. Watch the stars round it.` }));
  if (plan.left > 0) stage.append(el('p', { class: 'note', text: `${plan.left} ${plan.left === 1 ? 'photo is' : 'photos are'} left out: ${plan.left === 1 ? 'it' : 'they'} could not be lined up with the others.` }));
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => render());
  drawTicks();
  render();
  root.classList.add('is-live');
  loop.auto();   // plays while it is in view, unless the visitor asked for less motion or another loop is playing there
  return true;
}
