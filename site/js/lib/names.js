// Named targets (C1): finding a target by name in data/names.json, and the suggestion that a position typed from an
// old catalogue belongs to a star that has since moved. No network, no DOM: the caller reads names.json.
/** @import { CatalogueStar } from './gaia.js' */
import { parseCoords } from './coords.js';
import { epochToMjd, offsetArcsec, propagate, separationDeg } from './gaia.js';

/** Where the list is, inside the site. */
export const NAMES_FILE = 'data/names.json';

/** A position typed within this distance of a fast star's track is offered the star, arcmin. */
export const SNAP_ARCMIN = 10;
/** A position this close to where the star is now needs no move, arcmin. */
const SNAP_NEAR_ARCMIN = 1;
/** The track of a fast star that is looked at starts in this year: older than any catalogue a person copies from. */
const TRACK_FROM_YEAR = 1950;

/**
 * @typedef {Object} NameEntry
 * @property {string} id
 * @property {string} name  As shown.
 * @property {string[]} aliases
 * @property {'star' | 'comet' | 'planet'} kind
 * @property {number} ra  Degrees (ICRS), at `epoch` (stars, planets) or `when` (the comet).
 * @property {number} dec
 * @property {number | null} epoch  Julian year of the position; null for a position at one moment (`when`).
 * @property {string} [when]  ISO date and time (UTC) of the position, when `epoch` is null.
 * @property {number} mjd
 * @property {boolean} fast  A fast star: its old catalogue position is no longer where it is.
 * @property {(CatalogueStar & {speed_arcsec_per_year: number, source: string, unverified: boolean, unverified_why?: string}) | undefined} [catalogue]
 * @property {string} [source]  Where the position of a comet or planet comes from.
 * @property {string} note
 */

/**
 * @typedef {Object} NamesFile
 * @property {number} version
 * @property {number} epoch
 * @property {NameEntry[]} entries
 */

/**
 * @typedef {Object} Snap
 * @property {NameEntry} entry  The star.
 * @property {number} ra  Where it is now, degrees: the position to go to.
 * @property {number} dec
 * @property {number} distanceArcmin  How far that is from the position that was typed.
 * @property {number} sinceArcmin  How far the star has moved since 2000.
 * @property {string} text  The sentence for the page.
 */

/**
 * @typedef {{kind: 'position', ra: number, dec: number, form: 'degrees' | 'sexagesimal', snap: Snap | null}
 *   | {kind: 'name', entry: NameEntry, ra: number, dec: number}
 *   | {kind: 'none', message: string, suggestions: NameEntry[]}} Resolved
 */

/**
 * A name in the form that is compared: lower case, no accents, Greek letters spelled, letters and digits only.
 * @param {string} s
 */
export function normaliseName(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ε/g, 'eps').replace(/epsilon/g, 'eps').replace(/[^a-z0-9]/g, '');
}

/**
 * The entry a typed name stands for, or null.
 * @param {string} text @param {NamesFile} names
 * @returns {NameEntry | null}
 */
export function findName(text, names) {
  const q = normaliseName(text);
  if (q === '') return null;
  return names.entries.find((e) => normaliseName(e.name) === q || e.aliases.some((a) => normaliseName(a) === q)) ?? null;
}

/** @param {string} a @param {string} b */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Entries that a name that was not found may have meant: the ones whose names start with, contain or are a
 * typing slip away from what was typed.
 * @param {string} text @param {NamesFile} names @param {number} [max]
 * @returns {NameEntry[]}
 */
export function suggestNames(text, names, max = 3) {
  const q = normaliseName(text);
  if (q.length < 2) return [];
  /** @type {[number, NameEntry][]} */
  const scored = [];
  for (const e of names.entries) {
    let best = Infinity;
    for (const n of [e.name, ...e.aliases].map(normaliseName)) {
      if (n.startsWith(q)) best = Math.min(best, 0);
      else if (q.length >= 3 && n.includes(q)) best = Math.min(best, 1);
      else if (q.length >= 4 && n.length >= 4) {
        const d = Math.min(editDistance(q, n), editDistance(q, n.slice(0, q.length)));
        if (d <= 2) best = Math.min(best, 1 + d);
      }
    }
    if (best < Infinity) scored.push([best, e]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, max).map((s) => s[1]);
}

/**
 * Whether a position typed from an old catalogue is where a fast star used to be. The star's path from 1950 to
 * its position now is a short line on the sky; a typed position within SNAP_ARCMIN of that line, and more than an
 * arcmin from where the star is now, gets a suggestion to go to the star.
 * @param {number} ra @param {number} dec @param {NamesFile} names
 * @returns {Snap | null}
 */
export function snapSuggestion(ra, dec, names) {
  /** @type {Snap | null} */
  let best = null;
  let bestTrack = Infinity;
  for (const e of names.entries) {
    if (!e.fast || !e.catalogue) continue;
    const cat = e.catalogue;
    const [ra0, dec0] = propagate(cat, epochToMjd(TRACK_FROM_YEAR), { parallax: false });
    const [ra2000, dec2000] = propagate(cat, epochToMjd(2000), { parallax: false });
    // flat map of the neighbourhood, arcmin, with the star's position now at the origin
    const toXY = (/** @type {number} */ r, /** @type {number} */ d) => offsetArcsec(e.ra, e.dec, r, d).map((v) => v / 60);
    const [px, py] = toXY(ra, dec), [ax, ay] = toXY(ra0, dec0);
    const sx = -ax, sy = -ay;  // from the start of the track to the end (the origin)
    const len2 = sx * sx + sy * sy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / len2));
    const track = Math.hypot(px - (ax + t * sx), py - (ay + t * sy));
    const distance = Math.hypot(px, py);
    if (track > SNAP_ARCMIN || distance <= SNAP_NEAR_ARCMIN || track >= bestTrack) continue;
    bestTrack = track;
    const since = separationDeg(ra2000, dec2000, e.ra, e.dec) * 60;
    best = {
      entry: e, ra: e.ra, dec: e.dec, distanceArcmin: distance, sinceArcmin: since,
      text: `This looks like ${e.name}, which has moved about ${since.toFixed(1)} arcmin since 2000.`,
    };
  }
  return best;
}

/**
 * What a typed text means: a position (with a snap suggestion when it is an old catalogue position of a fast
 * star), a named target, or nothing, with a plain message and the names that come close.
 * @param {string} text @param {NamesFile} names
 * @returns {Resolved}
 */
export function resolveInput(text, names) {
  const p = parseCoords(text);
  if (p.ok) return { kind: 'position', ra: p.ra, dec: p.dec, form: p.form, snap: snapSuggestion(p.ra, p.dec, names) };
  const e = findName(text, names);
  if (e) return { kind: 'name', entry: e, ra: e.ra, dec: e.dec };
  const suggestions = suggestNames(text, names);
  const list = names.entries.map((x) => x.name).join(', ');
  const hint = suggestions.length ? `Did you mean ${suggestions.map((s) => s.name).join(' or ')}? ` : '';
  return { kind: 'none', suggestions, message: `${hint}${p.message} Or type one of the named targets: ${list}.` };
}
