// "Can you spot it?": pairs of pictures of one patch of sky, years apart, some with a star that moved and some
// without. The page already holds each pair side by side and its answer, closed, which the visitor opens with a
// tap; opening it shows the rings (the stylesheet does that). This file adds what needs a script: the two pictures
// of a pair laid over each other and blinked.
//
// Nothing is kept of what the visitor does: no answer is counted, stored or sent. The page has no state but which
// answers are open, and that is gone when the page is left.

import { createLoop, lessMotion, el } from './hero.js';
import { controlsOf } from './cards.js';

/**
 * Give one pair its blink: a button that lays the two pictures over each other and flips between them, and a
 * button that flips once. Only one loop of the page plays at a time. The buttons stand in the row joined under
 * the plate of the pair.
 *
 * With `auto` the pair is the lead of an item: it is laid over itself at once and flips on the beat of the page
 * whenever it is in view, until the visitor pauses it, with the name of the picture that shows (its cell) set on the
 * plate; with less motion asked for it stays side by side and is flipped by hand.
 * @param {HTMLElement} spot  An element that holds the two pictures in an element of class "jump".
 * @param {{auto?: boolean}} [how]
 * @returns {boolean}  True when the buttons are in place.
 */
export function mountSpot(spot, { auto = false } = {}) {
  const pair = spot.querySelector('.jump');
  if (!(pair instanceof HTMLElement) || pair.querySelectorAll(':scope > .jump-panel').length !== 2 || spot.querySelector('[data-spot-blink]')) return false;
  let second = false;
  const names = [...(pair.parentElement?.querySelectorAll('[data-panel] .cell-value') ?? [])].map((c) => (c.textContent ?? '').trim().toUpperCase());
  // the name of the picture that shows stands on a black band under the plate, inside its frame
  const named = auto && names.length === 2 ? (pair.parentElement?.querySelector(':scope > [data-verdict]') ?? el('p', { class: 'plate-verdict', 'data-verdict': '', 'data-plate': '', 'aria-hidden': 'true' })) : null;
  if (named && !named.parentElement) pair.after(named);
  const show = () => {
    pair.dataset.shows = second ? 'second' : 'first';
    if (named) named.textContent = pair.classList.contains('is-stacked') ? names[second ? 1 : 0] : '';
  };
  const label = el('span', { text: 'BLINK' });
  const blink = el('button', { type: 'button', class: 'btn btn-toggle', 'data-spot-blink': '', 'aria-pressed': 'false' }, [
    el('span', { class: 'btn-lamp', 'aria-hidden': 'true' }), label,
  ]);
  const flip = el('button', { type: 'button', class: 'btn', 'data-spot-flip': '', text: 'FLIP' });
  const apart = el('button', { type: 'button', class: 'btn', 'data-spot-apart': '', text: 'SIDE BY SIDE', hidden: '' });
  const loop = createLoop(pair, () => {
    second = !second;
    show();
  }, (playing) => {
    blink.setAttribute('aria-pressed', String(playing));
    if (auto) label.textContent = playing ? 'PAUSE' : 'BLINK';
  });
  /** @param {boolean} on  Lay the two pictures over each other, or put them back side by side. */
  const stack = (on) => {
    pair.classList.toggle('is-stacked', on);
    apart.hidden = !on;
    if (!on) loop.pause();
    show();
  };
  blink.addEventListener('click', () => {
    if (loop.playing()) loop.pause();
    else {
      stack(true);
      loop.play();
    }
  });
  flip.addEventListener('click', () => {
    loop.pause();
    stack(true);
    second = !second;
    show();
  });
  apart.addEventListener('click', () => stack(false));
  const sync = () => { blink.hidden = lessMotion(); };
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', sync);
  sync();
  controlsOf(pair.parentElement ?? spot).append(blink, flip, apart);
  show();
  if (auto && !lessMotion()) {
    stack(true);
    loop.auto();
  }
  return true;
}

/**
 * Give every pair under `root` its blink.
 * @param {ParentNode} root
 * @returns {number}  How many pairs got one.
 */
export function mountSpots(root) {
  let n = 0;
  for (const spot of root.querySelectorAll('[data-spot]')) if (spot instanceof HTMLElement && mountSpot(spot)) n++;
  return n;
}
