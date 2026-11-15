// The suggestions under a box where a visitor types a name or a sky position: a combobox, after the WAI-ARIA 1.2
// pattern of an input that owns a listbox.
//
// To put it on a form, a page needs three things.
//
//   1. The stylesheet, after the shared ones:
//        <link rel="stylesheet" href="css/suggest.css">
//
//   2. A form that leads to the viewer, with a labelled text box named "q" and a button. Nothing else is asked of
//      the markup; classes are the page's own business:
//        <form action="view.html" method="get" role="search" aria-label="Sky position">
//          <label for="where">Type a star's name or a sky position</label>
//          <div>
//            <input id="where" name="q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
//            <button type="submit">Blink it</button>
//          </div>
//        </form>
//
//   3. One call, once the form is in the page:
//        import { mountSuggest } from './ui/suggest.js';   // from js/pages/…: '../ui/suggest.js'
//        mountSuggest(form);
//
// The call adds the list and a line for screen readers after the input, inside the input's parent, and sets the
// ARIA attributes on the input. Every hook it leaves is an attribute, for a stylesheet to dress:
//   [data-suggest-anchor]   the input's parent, which the list is placed against
//   [data-suggest-list]     the list (role="listbox"); it has the attribute `hidden` while it is closed
//   [data-suggest-option]   a row (role="option"), with data-type = position | target | place | lookup | moving |
//                           first and, when it leads somewhere, data-href; the active row has aria-selected="true"
//   [data-suggest-label]    in a row: the name that matched, or "Go to RA …, Dec …"
//   [data-suggest-note]     in a row: the name of the place when another of its names matched, and what it is
//   [data-suggest-status]   the line that tells a screen reader how many rows there are
//
// What is suggested, at most eight rows. When the box is empty and has the focus: the good first places of
// data/first-places.json (below). When the text names the Sun, the Moon, a planet or Pluto: one plain row that says
// the object moves and this tool shows fixed places, and leads to the page of the comet; the text is not offered to
// the name service. Otherwise, in this order:
//   a position, when the text reads as one (lib/coords.js): "Go to RA …, Dec …";
//   the targets of the site's own list (data/names.json) that match, however they match;
//   the places of the long list (data/places.json): a name that is the text; then one that starts with it; then one
//   with a word that starts with it; then one that contains it; within each, the most cited first;
//   when nothing matches as typed: the names within one typing mistake of it (two when the text is longer than
//   five letters; a swap of neighbours counts as one; a digit is never taken for a mistake), and after them the
//   offer to look the text up in the name service the viewer uses.
// A star brighter than visual magnitude 4 (the `vmag` of its place) says in its note "very bright: SPHEREx saturates".
// Case, spaces, hyphens, apostrophes and accents do not count, Greek letters are read as their names, and the
// designation of a star is found however it is abbreviated ("alf Lyr", "Alpha Lyrae", "α Lyr").
//
// Keys: Down and Up move through the rows, round and round; Enter takes the active row, or with none active the
// first row (the text is submitted as it is when the first row is only the offer to look it up or the note on a moving
// object, whose page then says why it is not shown and links to the comet's, and when the box
// is empty); Escape closes the list, and once more clears the box; Tab leaves. A row can be clicked
// or tapped. Choosing a row leads where the form leads: view.html?t=<id> for a prepared target (or wherever the
// page's own link for that target leads, an <a data-target="id">), view.html?ra=&dec=&q=<name> for a place, so
// that no name service is asked, view.html?ra=&dec= for a position. The offer to look a text up submits the form.
//
// The good first places, data/first-places.json, a list for the home page and the empty viewer to show too:
//   [{ "label": "Ring Nebula", "line": "what the visitor will see, in one line", "href": "view.html?ra=…&dec=…&q=…" }]
// The href is relative to the site, as a row's address is. A row of it has data-type="first"; its label is the name
// that lands in the box when the row is taken.
//
// Nothing that is typed leaves the page: the three lists are files of the site, read once, when the box is first
// used. The text is sent to the name service only when the visitor submits it or takes that offer.

/** @import { NameEntry, NamesFile } from '../lib/names.js' */
/** @import { CatalogueStar } from '../lib/gaia.js' */
import { parseCoords } from '../lib/coords.js';
import { NAMES_FILE, snapSuggestion } from '../lib/names.js';
import { separationDeg } from '../lib/gaia.js';
import { looksLikeName } from '../lib/sesame.js';
import { viewUrl } from '../lib/urlstate.js';

/** Where the long list is, inside the site. */
export const PLACES_FILE = 'data/places.json';

/** The good first places shown under an empty box: the file is a list of FirstPlace. */
export const FIRST_FILE = 'data/first-places.json';

/** The page a moving object is sent to. */
export const MOVING_PAGE = 'lemmon.html';

/** A star brighter than this (visual magnitude) saturates in SPHEREx. */
export const SATURATES_BRIGHTER = 4;

/** The most rows that are shown. */
export const MAX_ROWS = 8;

/** A text of this many letters and digits or fewer is forgiven one typing mistake, a longer one two. */
const SHORT_TEXT = 5;
/** The shortest text in which a typing mistake is looked for. */
const MISTAKE_FROM = 4;
/** The shortest text that is looked for inside a name. */
const PART_FROM = 3;
/** A place this close to a target of the site's own list is that target, arcsec. */
const SAME_PLACE_ARCSEC = 5;
/** Added to the address of a place that lies where a fast star used to be: the viewer then shows it as it stands
 * (AS_TYPED in pages/view.js). */
const AS_IT_STANDS = '#as-typed';

/**
 * An entry of data/places.json.
 * @typedef {Object} Place
 * @property {string} name  The name to show.
 * @property {string[]} aliases  Its other names.
 * @property {string} kind  What it is, in plain words.
 * @property {number} ra  Degrees (ICRS), at the epoch of the file.
 * @property {number} dec
 * @property {boolean} [fast]  A star that moves more than half an arcsec a year.
 * @property {number} [vmag]  Visual magnitude, given for a star brighter than 5.
 * @property {CatalogueStar} [catalogue]  The catalogue astrometry of a fast star.
 */

/**
 * An entry of data/first-places.json.
 * @typedef {Object} FirstPlace
 * @property {string} label
 * @property {string} line
 * @property {string} href
 */

/**
 * data/places.json.
 * @typedef {Object} PlacesFile
 * @property {number} epoch
 * @property {Record<string, string>} [letters]  Greek letters: the abbreviation SIMBAD uses, and the name.
 * @property {Record<string, string>} [constellations]  The abbreviation of a constellation, and its genitive.
 * @property {Place[]} places  The most cited first.
 */

/** How a row matches what was typed, from the best to the worst. @typedef {'whole' | 'start' | 'word' | 'part' | 'near'} Match */

/**
 * One suggestion.
 * @typedef {Object} Row
 * @property {'position' | 'target' | 'place' | 'lookup' | 'moving' | 'first'} type
 * @property {string} label  What the row says first: the name that matched, or what the row does.
 * @property {string} note  What it says after that: the name of the place when another name matched, and its kind.
 * @property {string | null} href  Where it leads, relative to the site; null for the row that submits the form.
 * @property {string} [name]  The name to show of a target or a place.
 * @property {string} [id]  The id of a target.
 * @property {number} [ra]  Degrees.
 * @property {number} [dec]
 * @property {Match} [match]
 */

/**
 * A name as it is looked up: its words run together, written as typed and with the designation of a star in its
 * shortest form. The first text of each list is the whole name; the others start at its second word, its third…
 * @typedef {{text: string, plain: string[], short: string[]}} Spelling
 */

/**
 * A target or a place, ready to be matched.
 * @typedef {Object} Entry
 * @property {'target' | 'place'} type
 * @property {string} name
 * @property {string} kind
 * @property {number} [vmag]
 * @property {number} ra
 * @property {number} dec
 * @property {string} [id]
 * @property {string} also  Another name to say beside the name to show; empty when there is none.
 * @property {Spelling[]} names  The name to show first.
 * @property {number} order  Its place in its list.
 */

/**
 * The two lists, ready to be searched.
 * @typedef {Object} SuggestIndex
 * @property {Entry[]} entries  The targets, then the places.
 * @property {Map<string, string>} table  Words of a designation and the short form of each.
 * @property {NamesFile | null} names
 * @property {Row[]} first  The rows under an empty box.
 */

/** The names of the Greek letters, for a designation typed with the letter itself. */
const GREEK = /** @type {Record<string, string>} */ ({
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ι: 'iota', κ: 'kappa',
  λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', ο: 'omicron', π: 'pi', ρ: 'rho', σ: 'sigma', ς: 'sigma', τ: 'tau', υ: 'upsilon',
  φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega',
});

/**
 * The words of a text as they are compared: lower case, without accents, a Greek letter as its name; apostrophes
 * vanish, and anything else that is not a letter or a digit ends a word.
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[α-ω]/g, (letter) => ` ${GREEK[letter] ?? ''} `)
    .replace(/['’‘ʼ`´]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * A text as it is compared: its words run together.
 * @param {string} text
 */
export const plain = (text) => words(text).join('');

/**
 * The words of a text with the parts of a star's designation in their short form: "alpha" is "alf", "canis
 * majoris" is "cma". The same is done to what is typed and to the names, so that "alf CMa", "Alpha Canis Majoris"
 * and "alpha cma" meet.
 * @param {string[]} list  What words() gave.
 * @param {Map<string, string>} table
 * @returns {string[]}
 */
function shortForm(list, table) {
  if (table.size === 0) return list;
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const two = i + 1 < list.length ? table.get(`${list[i]} ${list[i + 1]}`) : undefined;
    if (two !== undefined) {
      out.push(two);
      i++;
      continue;
    }
    // a letter with its number: "omicron2"
    const numbered = /^([a-z]+)(\d+)$/.exec(list[i]);
    const short = numbered ? table.get(numbered[1]) : undefined;
    out.push(numbered && short !== undefined ? short + numbered[2] : table.get(list[i]) ?? list[i]);
  }
  return out;
}

/**
 * The texts a list of words is found by: all of them run together, then from the second word on, from the third…
 * @param {string[]} list
 * @returns {string[]}
 */
function fromEachWord(list) {
  return list.map((_, i) => list.slice(i).join(''));
}

/**
 * @param {string} text  A name as written.
 * @param {Map<string, string>} table
 * @returns {Spelling}
 */
function spelling(text, table) {
  const list = words(text);
  return { text, plain: fromEachWord(list), short: fromEachWord(shortForm(list, table)) };
}

/**
 * Make the two lists ready to be searched. Either may be missing. A place that is one of the site's own targets
 * (the same name, or the same spot) is left out: the target stands for it.
 * @param {NamesFile | null} names  data/names.json.
 * @param {PlacesFile | null} places  data/places.json.
 * @param {FirstPlace[] | null} [first]  data/first-places.json.
 * @returns {SuggestIndex}
 */
export function buildIndex(names, places, first = null) {
  /** @type {Map<string, string>} */
  const table = new Map();
  for (const [short, name] of Object.entries(places?.letters ?? {})) table.set(plain(name), short.toLowerCase());
  for (const [short, genitive] of Object.entries(places?.constellations ?? {})) table.set(words(genitive).join(' '), short.toLowerCase());

  /** @type {Entry[]} */
  const entries = [];
  const own = new Set();
  for (const [order, e] of (names?.entries ?? []).entries()) {
    const all = [e.name, ...e.aliases].map((text) => spelling(text, table));
    for (const s of all) own.add(s.short[0]);
    entries.push({ type: 'target', name: e.name, kind: e.kind, ra: e.ra, dec: e.dec, id: e.id, also: '', names: all, order });
  }
  const stars = (names?.entries ?? []).filter((e) => e.kind === 'star');
  for (const [order, p] of (places?.places ?? []).entries()) {
    const all = [p.name, ...p.aliases].map((text) => spelling(text, table));
    if (all.some((s) => own.has(s.short[0]))) continue;
    if (stars.some((e) => separationDeg(e.ra, e.dec, p.ra, p.dec) * 3600 < SAME_PLACE_ARCSEC)) continue;
    entries.push({ type: 'place', name: p.name, kind: p.kind, ra: p.ra, dec: p.dec, ...(typeof p.vmag === 'number' ? { vmag: p.vmag } : {}), also: p.aliases[0] ?? '', names: all, order });
  }
  const firstRows = (Array.isArray(first) ? first : [])
    .filter((f) => f && typeof f.label === 'string' && typeof f.line === 'string' && typeof f.href === 'string')
    .map((f) => /** @type {Row} */ ({ type: 'first', label: f.label, note: f.line, href: f.href, name: f.label }));
  return { entries, table, names, first: firstRows };
}

const DIGIT = /[0-9]/;

/**
 * How many typing mistakes lie between a typed text and the start of a name: letters left out, put in or
 * mistaken, and neighbours swapped (one mistake). A digit is never part of a mistake. More than `most` mistakes
 * come back as `most + 1`.
 * @param {string} typed  @param {string} name  @param {number} most
 */
export function mistakes(typed, name, most) {
  const over = most + 1, n = typed.length, m = Math.min(name.length, n + most);
  if (n - m > most) return over;
  /** @param {string} c */
  const one = (c) => (DIGIT.test(c) ? over : 1);
  /** @type {number[]} */
  let before = [];
  let prev = [0];
  for (let j = 1; j <= m; j++) prev[j] = Math.min(over, prev[j - 1] + one(name[j - 1]));
  for (let i = 1; i <= n; i++) {
    const a = typed[i - 1], row = [Math.min(over, prev[0] + one(a))];
    let least = row[0];
    for (let j = 1; j <= m; j++) {
      const b = name[j - 1];
      let d = Math.min(prev[j] + one(a), row[j - 1] + one(b), prev[j - 1] + (a === b ? 0 : Math.max(one(a), one(b))));
      if (i > 1 && j > 1 && a !== b && a === name[j - 2] && typed[i - 2] === b && !DIGIT.test(a) && !DIGIT.test(b)) d = Math.min(d, before[j - 2] + 1);
      row[j] = Math.min(over, d);
      if (row[j] < least) least = row[j];
    }
    if (least > most) return over;
    before = prev;
    prev = row;
  }
  return Math.min(...prev);
}

/** The classes of a match, in the order of the rows. */
const MATCHES = /** @type {const} */ (['whole', 'start', 'word', 'part']);

/**
 * How one spelling of a name matches what was typed: 0 the whole name, 1 its start, 2 the start of one of its
 * words, 3 a part of it; 9 when it does not.
 * @param {Spelling} s
 * @param {string} typed  What was typed, run together.
 * @param {string} short  The same with designations in their short form.
 * @param {boolean} parts  Whether a part of a name counts.
 */
function matchOf(s, typed, short, parts) {
  let best = 9;
  for (const [texts, q] of /** @type {[string[], string][]} */ ([[s.plain, typed], [s.short, short]])) {
    if (texts[0] === q) return 0;
    if (texts[0].startsWith(q)) best = Math.min(best, 1);
    else if (best > 2 && texts.some((t, i) => i > 0 && t.startsWith(q))) best = 2;
    else if (best > 3 && parts && texts[0].includes(q)) best = 3;
  }
  return best;
}

/**
 * The address a target or a place is opened at.
 * @param {Entry} e  @param {NamesFile | null} names
 */
function hrefOf(e, names) {
  if (e.type === 'target') return viewUrl(e.kind === 'star' ? { t: e.id } : { q: e.name });
  // a place carries its position, so that no name service is asked. One that lies where a fast star of the site's
  // own list used to be would be taken for that star's old catalogue position: it is opened as it stands
  const moved = names ? snapSuggestion(e.ra, e.dec, names) : null;
  return viewUrl({ ra: e.ra, dec: e.dec, q: e.name }) + (moved ? AS_IT_STANDS : '');
}

/**
 * The row of a target or a place.
 * @param {Entry} e  @param {Spelling} by  The name that matched.  @param {Match} match  @param {NamesFile | null} names
 * @returns {Row}
 */
function rowOf(e, by, match, names) {
  const beside = by.text !== e.name ? e.name : e.type === 'place' ? e.also : '';
  const what = beside ? `${beside} · ${e.kind}` : e.kind;
  return {
    type: e.type, label: by.text, note: e.vmag !== undefined && e.vmag < SATURATES_BRIGHTER ? `${what} · very bright: SPHEREx saturates` : what, href: hrefOf(e, names),
    name: e.name, ra: e.ra, dec: e.dec, match, ...(e.id !== undefined ? { id: e.id } : {}),
  };
}

/**
 * A position as a row says it, the way the viewer writes one: "RA 269.4464°, Dec +4.7671°".
 * @param {number} ra  @param {number} dec
 */
function sayPosition(ra, dec) {
  return `RA ${ra.toFixed(4)}°, Dec ${dec < 0 ? '−' : '+'}${Math.abs(dec).toFixed(4)}°`;
}

/** The objects that move: the texts that name each, run together, its name, and the words said of its motion. */
const MOVING = /** @type {[string[], string, string][]} */ ([
  [['sun', 'thesun'], 'The Sun', 'moves through the stars over the year'],
  [['moon', 'themoon'], 'The Moon', 'moves across the sky from day to day'],
  [['mercury'], 'Mercury', 'wanders among the stars from night to night'],
  [['venus'], 'Venus', 'wanders among the stars from night to night'],
  [['mars'], 'Mars', 'wanders among the stars from night to night'],
  [['jupiter'], 'Jupiter', 'wanders among the stars from night to night'],
  [['saturn'], 'Saturn', 'wanders among the stars from night to night'],
  [['uranus'], 'Uranus', 'wanders among the stars from night to night'],
  [['neptune'], 'Neptune', 'wanders among the stars from night to night'],
  [['pluto', '134340pluto'], 'Pluto', 'wanders among the stars from night to night'],
]);

/**
 * The one row for a text that names a moving object, or null.
 * @param {string} typed  The text, run together (plain()).
 * @returns {Row | null}
 */
function movingRow(typed) {
  const found = movingBody(typed);
  if (!found) return null;
  return { type: 'moving', label: found.said, note: "The comet's page shows a moving object", href: MOVING_PAGE };
}

/**
 * The moving object that a text names, with the sentence that says why it is not shown: for the pages that answer
 * a typed name by themselves.
 * @param {string} text  What was typed.
 * @returns {{name: string, said: string} | null}
 */
export function movingBody(text) {
  const typed = plain(text.trim());
  const found = MOVING.find(([texts]) => texts.includes(typed));
  return found ? { name: found[1], said: `${found[1]} ${found[2]}; this tool shows fixed places.` } : null;
}

/**
 * What to suggest for a typed text. See the top of the file for the order of the rows.
 * @param {string} text  What is in the box.
 * @param {SuggestIndex} index
 * @param {number} [max]
 * @returns {Row[]}
 */
export function suggest(text, index, max = MAX_ROWS) {
  const asTyped = text.trim().replace(/\s+/g, ' ');
  if (asTyped === '') return [];
  const moving = movingRow(plain(asTyped));
  if (moving) return [moving];
  /** @type {Row[]} */
  const rows = [];
  const position = parseCoords(asTyped);
  if (position.ok) {
    rows.push({
      type: 'position', label: `Go to ${sayPosition(position.ra, position.dec)}`, note: 'a position',
      href: viewUrl({ ra: Number(position.ra.toFixed(6)), dec: Number(position.dec.toFixed(6)) }), ra: position.ra, dec: position.dec,
    });
  }
  const list = words(asTyped), typed = list.join(''), short = shortForm(list, index.table).join('');
  // numbers with a sign, a point or a colon are a position being typed, not a name
  const numbers = !/\p{L}/u.test(asTyped) && /[^\s\d]/.test(asTyped);
  if (typed === '' || numbers) return rows.slice(0, max);

  const parts = typed.length >= PART_FROM && /[a-z]/.test(typed);
  /** @type {{e: Entry, by: Spelling, rank: number}[]} */
  const found = [];
  for (const e of index.entries) {
    let rank = 9, by = e.names[0];
    for (const s of e.names) {
      const r = matchOf(s, typed, short, parts);
      if (r < rank) { rank = r; by = s; }
      if (rank === 0) break;
    }
    if (rank < 9) found.push({ e, by, rank });
  }
  /** The targets of the site first, then the better match, then the order of the list. @param {{e: Entry, rank: number}} a @param {{e: Entry, rank: number}} b */
  const inOrder = (a, b) => (a.e.type === b.e.type ? a.rank - b.rank || a.e.order - b.e.order : a.e.type === 'target' ? -1 : 1);
  found.sort(inOrder);
  for (const f of found.slice(0, max)) rows.push(rowOf(f.e, f.by, MATCHES[f.rank], index.names));
  if (rows.length > 0) return rows.slice(0, max);

  // nothing matches as typed: the names a typing mistake away, and the offer to look the text up
  const lookup = looksLikeName(asTyped);
  if (typed.length >= MISTAKE_FROM) {
    const most = typed.length <= SHORT_TEXT ? 1 : 2;
    /** @type {{e: Entry, by: Spelling, rank: number}[]} */
    const near = [];
    for (const e of index.entries) {
      let rank = most + 1, by = e.names[0];
      for (const s of e.names) {
        const d = Math.min(mistakes(typed, s.plain[0], most), mistakes(short, s.short[0], most));
        if (d < rank) { rank = d; by = s; }
      }
      if (rank <= most) near.push({ e, by, rank });
    }
    near.sort(inOrder);
    for (const f of near.slice(0, max - (lookup ? 1 : 0))) rows.push(rowOf(f.e, f.by, 'near', index.names));
  }
  if (lookup) rows.push({ type: 'lookup', label: `Look up “${asTyped}”`, note: 'asks the name service of the CDS', href: null });
  return rows.slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// On the page
// ---------------------------------------------------------------------------------------------

/** @type {Map<string, Promise<SuggestIndex>>} */
const loading = new Map();

/**
 * Read the two lists of the site, once for a page however many boxes it has. A list that cannot be had is done
 * without.
 * @param {string | URL} base  The address the files are relative to: the page's.
 * @returns {Promise<SuggestIndex>}
 */
export function loadIndex(base) {
  const key = String(base);
  let index = loading.get(key);
  if (!index) {
    /** @param {string} file */
    const read = (file) => fetch(new URL(file, base)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    index = Promise.all([read(NAMES_FILE), read(PLACES_FILE), read(FIRST_FILE)]).then(([names, places, first]) => buildIndex(names, places, first));
    loading.set(key, index);
  }
  return index;
}

let mounted = 0;

/**
 * Put the suggestions on a form. See the top of the file for the markup it needs and what it adds.
 * @param {HTMLFormElement} form
 * @param {{input?: HTMLInputElement, max?: number, load?: () => Promise<SuggestIndex>, go?: (href: string) => void}} [options]
 *   `input`: the box, when it is not the form's input named "q". `max`: the most rows. `load`: where the lists come
 *   from, in place of the files of the site. `go`: what opens an address, in place of leaving for it.
 * @returns {{close: () => void, destroy: () => void} | null}  Null when the form has no box.
 */
export function mountSuggest(form, options = {}) {
  const found = options.input ?? form.querySelector('input[name="q"]');
  if (!(found instanceof HTMLInputElement) || !found.parentElement) return null;
  const input = found, anchor = found.parentElement;
  const max = options.max ?? MAX_ROWS;
  const load = options.load ?? (() => loadIndex(document.baseURI));
  const go = options.go ?? ((href) => { location.assign(href); });
  const off = new AbortController(), signal = off.signal;

  const list = document.createElement('ul'), status = document.createElement('p');
  list.id = `${input.id || `suggest-${++mounted}`}-suggestions`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Suggestions');
  list.setAttribute('data-suggest-list', '');
  list.hidden = true;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('data-suggest-status', '');
  anchor.setAttribute('data-suggest-anchor', '');
  input.after(list, status);
  const before = ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-haspopup'].map((name) => /** @type {[string, string | null]} */ ([name, input.getAttribute(name)]));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);

  /** @type {SuggestIndex | null} */
  let index = null;
  /** @type {Promise<void> | null} */
  let asked = null;
  /** @type {Row[]} */
  let rows = [];
  let active = -1, pressing = false, told = false;

  const isOpen = () => !list.hidden;

  function close() {
    list.hidden = true;
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  /** Mark the active row, for the eye and for a screen reader. */
  function mark() {
    for (const [i, option] of [...list.children].entries()) option.setAttribute('aria-selected', i === active ? 'true' : 'false');
    const option = list.children[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  /** Where a row leads on this page: a target that the page links to itself goes where that link goes. @param {Row} row */
  function addressOf(row) {
    const own = row.type === 'target' && row.id ? document.querySelector(`a[data-target="${CSS.escape(row.id)}"]`) : null;
    return own?.getAttribute('href') ?? row.href;
  }

  /** Work out the rows for what is in the box, and show them. */
  function show() {
    const empty = input.value.trim() === '';
    // until the lists are here only a position can be told
    rows = empty ? (index?.first ?? []).slice(0, max)
      : index ? suggest(input.value, index, max) : suggest(input.value, buildIndex(null, null), max).filter((r) => r.type === 'position');
    active = -1;
    list.replaceChildren(...rows.map((row, i) => {
      const option = document.createElement('li'), label = document.createElement('span'), note = document.createElement('span');
      option.id = `${list.id}-${i}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.setAttribute('data-suggest-option', '');
      option.setAttribute('data-type', row.type);
      const href = addressOf(row);
      if (href) option.setAttribute('data-href', href);
      label.setAttribute('data-suggest-label', '');
      label.textContent = row.label;
      note.setAttribute('data-suggest-note', '');
      note.textContent = row.note;
      option.append(label, ' ', note);
      return option;
    }));
    if (rows.length === 0) {
      close();
      status.textContent = input.value.trim() === '' || !index ? '' : 'No suggestions.';
      return;
    }
    // the list hangs under the box, wherever the box stands in its parent
    list.style.setProperty('--suggest-top', `${input.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top - anchor.clientTop}px`);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    status.textContent = `${rows.length} ${empty ? 'places to start with' : rows.length === 1 ? 'suggestion' : 'suggestions'}.${told ? '' : ' Use the up and down arrows to choose one.'}`;
    told = true;
  }

  /** Read the lists, the first time the box is used. */
  function ready() {
    asked ??= load().then((got) => { index = got; }, () => { index = buildIndex(null, null); }).then(() => {
      if (!signal.aborted && document.activeElement === input) show();
    });
    return asked;
  }

  /** Take a row. @param {number} i */
  function choose(i) {
    const row = rows[i], href = row ? addressOf(row) : null;
    if (!row) return;
    close();
    if (href) {
      if (row.name) input.value = row.name;
      go(href);
    } else if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  }

  /** Move the active row by one, round and round. @param {1 | -1} step */
  function move(step) {
    if (!isOpen()) {
      show();
      if (!isOpen()) return;
    }
    active = active < 0 ? (step > 0 ? 0 : rows.length - 1) : (active + step + rows.length) % rows.length;
    mark();
  }

  input.addEventListener('focus', () => { ready(); }, { signal });
  input.addEventListener('click', () => { if (!isOpen() && index) show(); }, { signal });
  input.addEventListener('input', () => {
    ready();
    show();
  }, { signal });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      ready();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      // the row the visitor chose; with none chosen, the first row, as a search box does, unless the first row is
      // only the offer to look the text up. An empty box is submitted as it is.
      if (isOpen() && active >= 0) {
        event.preventDefault();
        choose(active);
      } else if (input.value.trim() === '') close();
      else {
        event.preventDefault();
        // the lists may still be on their way when the text is typed and sent at once
        ready().then(() => {
          if (signal.aborted) return;
          show();
          if (rows.length && rows[0].type !== 'lookup' && rows[0].type !== 'moving') choose(0);
          else {
            close();
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
          }
        });
      }
    } else if (event.key === 'Escape') {
      if (isOpen()) {
        event.preventDefault();
        close();
        status.textContent = '';
      } else if (input.value !== '') {
        event.preventDefault();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        status.textContent = '';
      }
    } else if (event.key === 'Tab') close();
  }, { signal });
  input.addEventListener('blur', () => { if (!pressing) close(); }, { signal });
  form.addEventListener('submit', close, { signal });

  // a press on the list must not take the focus from the box, or the list would close under the pointer
  list.addEventListener('mousedown', (event) => { event.preventDefault(); }, { signal });
  list.addEventListener('pointerdown', () => { pressing = true; }, { signal });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(type, () => { pressing = false; }, { signal });
  list.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest('[data-suggest-option]') : null;
    const i = option ? [...list.children].indexOf(option) : -1;
    pressing = false;
    if (i >= 0) choose(i);
  }, { signal });

  return {
    close,
    destroy() {
      off.abort();
      list.remove();
      status.remove();
      anchor.removeAttribute('data-suggest-anchor');
      input.removeAttribute('aria-activedescendant');
      for (const [name, value] of before) {
        if (value === null) input.removeAttribute(name);
        else input.setAttribute(name, value);
      }
    },
  };
}
