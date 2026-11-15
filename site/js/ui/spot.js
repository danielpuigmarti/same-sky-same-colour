// The picture of the empty viewer: one of the prepared targets, two photos of it blinking on a plate, with a black
// band under it that names the place and the month on show and leads to that place in the viewer. It is read from
// the files of this site; when they cannot be had, nothing is drawn and the page goes on without it.

/** @import { Photo } from './hero.js' */
import { loadShowcase, displayRule, viewSize, lineUp, paintPhoto, createLoop, lessMotion, formatMonth, el } from './hero.js';

/** About how wide the plate is, CSS px. */
const SPOT_WIDTH = 330;

/**
 * Put the blinking plate of a prepared target in `host`.
 * @param {HTMLElement} host
 * @param {{folder: string, name: string, href: string, pair?: number}} what  The target's folder (ending in "/"), its name, its address in the viewer, and which pair of its manifest.
 * @returns {Promise<boolean>}  False when the plate could not be made.
 */
export async function mountSpot(host, { folder, name, href, pair = 0 }) {
  const showcase = await loadShowcase(new URL(`${folder}manifest.json`, document.baseURI));
  if (!showcase) return false;
  const { manifest, photos } = showcase;
  const named = Array.isArray(manifest.pairs) ? manifest.pairs[pair] : undefined;
  if (!named) return false;
  let early = photos[named[0]], late = photos[named[1]];
  if (!early || !late || early === late) return false;
  if (early.mjd > late.mjd) [early, late] = [late, early];
  if (/** @type {{grid?: string}} */ (manifest).grid === 'north-up') early.turn = late.turn = 0;
  else if (!lineUp(late, late) || !lineUp(late, early)) return false;
  const size = viewSize([early, late]);
  const rule = displayRule([early, late]);
  if (!rule) return false;

  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const plate = el('div', { class: 'plate spot-plate', 'data-plate': '' }, [canvas, el('span', { class: 'plate-mark', 'aria-hidden': 'true' })]);
  const verdict = el('a', { class: 'plate-verdict spot-verdict', 'data-plate': '', href, 'aria-label': `Open ${name} in the viewer` });
  const play = el('button', { type: 'button', class: 'btn' });
  const flip = el('button', { type: 'button', class: 'btn', text: 'FLIP' });
  const spoken = el('p', { class: 'visually-hidden', role: 'status' });
  const frame = el('div', { class: 'plate-frame spot-frame' }, [plate, verdict, el('div', { class: 'spot-controls' }, [play, flip, spoken])]);

  let showLate = false;
  /** @param {boolean} [say] */
  const render = (say = false) => {
    const photo = showLate ? late : early;
    paintPhoto(canvas, photo, rule, size);
    verdict.replaceChildren(el('span', { text: name.toUpperCase() }), el('br'), el('span', { text: formatMonth(photo.mjd).toUpperCase() }));
    plate.dataset.shows = showLate ? 'late' : 'early';
    play.textContent = loop.playing() ? 'PAUSE' : 'BLINK';
    play.setAttribute('aria-pressed', String(loop.playing()));
    play.hidden = lessMotion();
    if (say) spoken.textContent = `Showing ${formatMonth(photo.mjd)}.`;
  };
  const loop = createLoop(plate, () => { showLate = !showLate; render(); }, () => render());
  play.addEventListener('click', () => (loop.playing() ? loop.pause() : loop.play()));
  flip.addEventListener('click', () => { loop.pause(); showLate = !showLate; render(true); });
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => render());

  // a whole number of screen pixels to a pixel of the photo
  const width = size * Math.max(1, Math.ceil(SPOT_WIDTH / size));
  plate.style.width = frame.style.width = `${width}px`;
  host.replaceChildren(frame);
  render();
  loop.auto();
  return true;
}
