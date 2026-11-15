// The visit strip: one tile for each visit of the position, with its date and the colours of its photos that are
// known (a prepared target knows them all; a typed position learns them as photos are read); visits with few
// photos are greyed. Two tiles are chosen at a time: the two visits that are compared.
//
// A visit is named by the UTC date of its first photo, YYYY-MM-DD. That is what the address of a view carries
// as `a` and `b`.

/** @import { Visit } from '../contracts.js' */
import { formatDate } from './stage.js';
import { colourChip } from './ruler.js';

/** A name in the address still finds its visit when the first photo of the visit is at most this many days away. */
export const VISIT_NAME_DAYS = 15;

/**
 * One tile of the strip.
 * @typedef {Object} VisitTile
 * @property {string} id  The UTC date of the first photo, YYYY-MM-DD.
 * @property {number} mjd  Mid-exposure time of the first photo, MJD (UTC).
 * @property {number} photos  How many photos the visit has (in the detector that is shown).
 * @property {boolean} short  True for a visit with too few photos to rely on.
 * @property {{lam: number, det: number}[]} [colours]  The colours of its photos that are known, µm, with their detector.
 * @property {number} [index]  Where the visit is in the list the tiles were made from.
 */

/**
 * The name of a visit: the UTC date of a time, YYYY-MM-DD.
 * @param {number} mjd  MJD (UTC).
 * @returns {string}
 */
export function visitId(mjd) {
  return Number.isFinite(mjd) ? new Date(Math.round((mjd - 40587) * 86400000)).toISOString().slice(0, 10) : '';
}

/**
 * The time a name stands for: the start of that UTC day as MJD. NaN for text that is not a date.
 * @param {string} id
 * @returns {number}
 */
export function visitTime(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(id);
  if (!m) return NaN;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === id ? ms / 86400000 + 40587 : NaN;
}

/**
 * The tiles of the visits of a plan (CT-5), earliest first; `index` is the position of each visit in `visits`.
 * Visits without a photo are left out.
 * @param {Visit[]} visits
 * @returns {(VisitTile & {index: number})[]}
 */
export function tilesOfVisits(visits) {
  return visits
    .map((v, index) => ({ v, index }))
    .filter(({ v }) => v.frames.length > 0)
    .map(({ v, index }) => ({ id: visitId(v.frames[0].tmid), mjd: v.frames[0].tmid, photos: v.frames.length, short: Boolean(v.short), index }))
    .sort((p, q) => p.mjd - q.mjd);
}

/**
 * The tile a name in the address stands for: the tile with that name or, failing that, the one whose first photo
 * is nearest to that date and at most VISIT_NAME_DAYS away. -1 when there is none.
 * @param {VisitTile[]} tiles
 * @param {string | undefined} name  `a` or `b` of the address.
 * @returns {number}  Position in `tiles`.
 */
export function findVisit(tiles, name) {
  if (!name) return -1;
  const exact = tiles.findIndex((t) => t.id === name);
  if (exact >= 0) return exact;
  const when = visitTime(name);
  if (!Number.isFinite(when)) return -1;
  let best = -1, bestGap = VISIT_NAME_DAYS;
  for (const [i, t] of tiles.entries()) {
    const gap = Math.abs(Math.floor(t.mjd) - when);
    if (gap <= bestGap) { best = i; bestGap = gap; }
  }
  return best;
}

/**
 * Choosing a tile: the two tiles chosen last are the two that are compared. Choosing one of the two again changes
 * nothing.
 * @param {number[]} chosen  The tiles chosen so far, the one chosen longest ago first; at most two.
 * @param {number} picked  The tile that was pressed.
 * @returns {number[]}  The tiles chosen now, in the same order.
 */
export function choose(chosen, picked) {
  if (chosen.includes(picked)) return chosen;
  return [...chosen, picked].slice(-2);
}

/**
 * Build the strip in `root`.
 * @param {HTMLElement} root
 * @param {{onChoose?: (earlier: VisitTile, later: VisitTile) => void}} [options]  onChoose is called when the two chosen visits change.
 * @returns {{show: (tiles: VisitTile[], chosen?: [number, number] | null) => void, chosen: () => number[], press: (i: number) => void,
 *   setColours: (i: number, colours: {lam: number, det: number}[]) => void}}
 */
export function createVisitStrip(root, options = {}) {
  root.classList.add('visits');
  /** @type {VisitTile[]} */
  let tiles = [];
  /** @type {number[]} */
  let chosen = [];
  /** @type {HTMLButtonElement[]} */
  let buttons = [];

  function mark() {
    const pair = [...chosen].sort((p, q) => p - q);
    for (const [i, b] of buttons.entries()) {
      const role = pair.length === 2 && i === pair[0] ? 'earlier' : pair.length === 2 && i === pair[1] ? 'later' : chosen.includes(i) ? 'chosen' : '';
      b.setAttribute('aria-pressed', String(role !== ''));
      b.dataset.role = role;
      const tag = b.querySelector('.visit-role');
      if (tag) tag.textContent = role === 'earlier' ? 'Earlier visit' : role === 'later' ? 'Later visit' : role === 'chosen' ? 'Chosen' : '';
    }
  }

  /** @param {number} i */
  function press(i) {
    if (!(i >= 0 && i < tiles.length)) return;
    const next = choose(chosen, i);
    if (next === chosen) return;
    chosen = next;
    mark();
    if (chosen.length === 2) {
      const [p, q] = [...chosen].sort((x, y) => x - y);
      options.onChoose?.(tiles[p], tiles[q]);
    }
  }

  /** @param {VisitTile[]} next @param {[number, number] | null} [pair]  The two tiles compared now. */
  function show(next, pair = null) {
    // the same visits shown again with the same two compared: the order in which the two were chosen is kept,
    // so that the next tile pressed replaces the one chosen longest ago
    const kept = pair !== null && chosen.length === 2 && chosen.includes(pair[0]) && chosen.includes(pair[1])
      && next.length === tiles.length && next.every((t, i) => t.id === tiles[i].id);
    tiles = next;
    if (!kept) chosen = pair ? [pair[0], pair[1]] : [];
    root.replaceChildren();
    buttons = [];
    if (!tiles.length) return;
    const heading = document.createElement('h2');
    heading.className = 'visits-heading';
    heading.textContent = 'VISITS';
    const hint = document.createElement('p');
    hint.className = 'visits-hint';
    hint.textContent = tiles.length > 2
      ? 'SPHEREx came back to this position several times. Choose two visits to compare.'
      : 'The times SPHEREx photographed this position.';
    const list = document.createElement('ol');
    list.className = 'visits-list';
    for (const [i, t] of tiles.entries()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'visit-tile';
      b.dataset.id = t.id;
      b.dataset.short = String(t.short);
      const role = document.createElement('span');
      role.className = 'visit-role';
      const date = document.createElement('span');
      date.className = 'visit-date';
      date.textContent = formatDate(t.mjd);
      const photos = document.createElement('span');
      photos.className = 'visit-photos';
      photos.textContent = `${t.photos} ${t.photos === 1 ? 'photo' : 'photos'}${t.short ? ' · few photos' : ''}`;
      const colours = document.createElement('span');
      colours.className = 'visit-colours';
      for (const c of t.colours ?? []) colours.append(colourChip(c.lam, c.det));
      b.append(role, date, photos, colours);
      b.addEventListener('click', () => press(i));
      const item = document.createElement('li');
      item.append(b);
      list.append(item);
      buttons.push(b);
    }
    root.append(heading, hint, list);
    mark();
  }

  /**
   * Give a tile the colours of its photos that have become known, without building the strip again.
   * @param {number} i  Position in the tiles. @param {{lam: number, det: number}[]} colours
   */
  function setColours(i, colours) {
    if (!(i >= 0 && i < tiles.length)) return;
    tiles[i].colours = colours;
    buttons[i]?.querySelector('.visit-colours')?.replaceChildren(...colours.map((c) => colourChip(c.lam, c.det)));
  }

  return { show, chosen: () => [...chosen], press, setColours };
}
