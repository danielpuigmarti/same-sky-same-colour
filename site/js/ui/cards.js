// The items of the targets page, the parts that the three pages of results share, and the small blink a plate holds.
//
// The pages of this site that tell a result (targets, comet, checks) are made from the data files and stored as
// plain HTML, so that they read the same with scripts off. The first half of this file makes that HTML as text;
// it needs no page, and tests/unit/v4-pages.test.mjs runs it, both to write the pages and to fail when a page no
// longer says what the data says. The second half brings a plate to life in a page: the two photos of a matched
// pair become one picture that blinks.
//
// The pages are set as a bulletin: an item is headed by the name of its object, a row of ruled cells carries what
// is measured, a photo or a drawing stands on a black plate with its own cells joined under it, a table is a
// ledger, and the check behind a claim is a quiet link: the mark of its status and its id. Only the Checks page
// prints a status as a stamp.
//
// Three rules hold for everything made here:
//   - a number is written only as <span data-n="key">, with the text numbers.json gives it;
//   - a tag is a quiet link to the entry of its check, checks.html#<row id>: the mark of that row's status and its
//     id, and, after it, the plain words of the check;
//   - what the data names and the site does not have is left out and listed (Build.left), never guessed.

/** @import { CheckRow, CheckStatus, Numbers } from '../contracts.js' */
/** @import { Loop, Photo } from './hero.js' */
import { loadShowcase, displayRule, viewSize, lineUp, paintPhoto, createLoop, lessMotion, el, formatMonth } from './hero.js';
import { formatColour } from './ruler.js';
import { setNumber } from '../lib/setnumber.js';

// ---------------------------------------------------------------------------------------------
// Making HTML from data
// ---------------------------------------------------------------------------------------------

/**
 * What the makers of a page are given.
 * @typedef {Object} Build
 * @property {Numbers} numbers  numbers.json.
 * @property {CheckRow[]} rows  checks.json.
 * @property {(path: string) => [number, number] | null} size  Width and height of a picture of the site, by its path inside the site; null when there is no such file.
 * @property {string[]} left  What the data named and the site does not have. Each is left out of the page and said here.
 */

/** The page of the checks; a tag links to an entry on it. */
export const CHECKS_PAGE = 'checks.html';

/** The name of a status, as it is said. */
export const STATUS_NAME = Object.freeze(/** @type {Record<CheckStatus, string>} */ ({
  PASS: 'Passed',
  CORRECTED: 'Corrected',
  LIMIT: 'A limit',
  UNVERIFIED: 'Not reviewed by a person',
  FAIL: 'Failed',
}));

/** The name of a status as a stamp prints it: in capitals, written as capitals. */
export const STATUS_STAMP = Object.freeze(/** @type {Record<CheckStatus, string>} */ (
  Object.fromEntries(Object.entries(STATUS_NAME).map(([status, name]) => [status, name.toUpperCase()]))));

/** Text as it stands between two tags. @param {unknown} s */
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text as the value of an attribute. @param {unknown} s */
export const attr = (s) => esc(s).replace(/"/g, '&quot;');

/** The name that the shared status mark (components.css) gives each status. */
const MARK_NAME = Object.freeze(/** @type {Record<CheckStatus, string>} */ ({
  PASS: 'pass', FAIL: 'fail', LIMIT: 'limit', CORRECTED: 'corrected', UNVERIFIED: 'unverified',
}));

/**
 * The mark of a status, so that a status is never told by its colour alone: the shared drawn mark, which stands
 * beside the word of the status, which says it to a reader who cannot see it.
 * @param {CheckStatus} status
 * @returns {string}
 */
export function statusMark(status) {
  return `<span class="status-mark" data-status="${MARK_NAME[status] ?? 'unverified'}" aria-hidden="true"></span>`;
}

/**
 * The status of a row as a stamp: its word in capitals, in a box of its own ink. The stylesheet draws its mark.
 * @param {CheckStatus} status
 * @returns {string}
 */
export function stamp(status) {
  return `<span class="stamp" data-status="${attr(status)}">${esc(STATUS_STAMP[status] ?? status)}</span>`;
}

/**
 * A row of ruled cells: in each, the word the form prints and, under it, what is typed. A cell with nothing to
 * say is still drawn, with a dash in it: a slot is never closed up.
 * @param {[label: string, html: string, attributes?: string][]} cells  The label is written in capitals; the
 *   attributes of a cell are given as they stand in its tag, with a space before them.
 * @param {{cls?: string, cols?: number}} [row]  A class of the row beside "cells", and the number of slots in a
 *   line of it when that is fixed.
 * @returns {string}
 */
export function cellRow(cells, { cls = '', cols = 0 } = {}) {
  return `<dl class="cells${cls ? ` ${attr(cls)}` : ''}"${cols ? ` data-cols="${cols}"` : ''}>
${cellList(cells)}
</dl>`;
}

/** Three words made of letters only: a sentence, not a reading, a date or an identifier. */
const isProse = (/** @type {string} */ html) => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').split(/\s+/).filter((w) => /^[A-Za-z’'()-]{2,}[,.;:]?$/.test(w)).length >= 3;

/**
 * The cells of a row without the row around them, for a row that already stands in a page.
 * @param {[label: string, html: string, attributes?: string][]} cells
 * @returns {string}
 */
export function cellList(cells) {
  return cells.map(([label, html, attributes = '']) => `<div class="cell"${attributes}><dt class="cell-label">${esc(label)}</dt><dd class="cell-value${isProse(html) ? ' is-prose' : ''}">${html}</dd></div>`).join('\n');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE = new RegExp(`(?:(\\d{1,2}) )?\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')}) (\\d{4})(?:, (\\d{2}):(\\d{2}) UTC)?|\\b((?:19|20)\\d{2})-(\\d{2})-(\\d{2})\\b|\\b((?:19|20)\\d{2})\\b`, 'g');

/** @param {string | number} n */
const two = (n) => String(n).padStart(2, '0');

/** "February 2026": the month of a time given in MJD (UTC). @param {number} mjd */
function monthOf(mjd) {
  const d = new Date((mjd - 40587) * 86400000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * A date written as 2026-11-14, in words: "14 November 2026", marked as a date. Anything else is given back escaped.
 * @param {unknown} iso
 * @returns {string}
 */
export function dateWords(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m || !MONTHS[Number(m[2]) - 1]) return esc(iso);
  return `<time datetime="${m[0]}">${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}</time>`;
}

/**
 * Mark the dates in a text as dates: "April 2026", "26 February 2026", "25 Feb 2026, 07:12 UTC", "2010-04-28" and a
 * year standing alone each become a <time> element. The text must already be escaped.
 * @param {string} html
 * @returns {string}
 */
export function markDates(html) {
  return html.replace(DATE, (all, day, month, year, hour, minute, isoYear, isoMonth, isoDay, alone, at, whole) => {
    // four figures that are a part of a longer number ("2010.5 pixels") are not a year
    if (alone && (/^[.,]\d/.test(whole.slice(at + all.length)) || /\d[.,]$/.test(whole.slice(0, at)))) return all;
    let when = alone;
    if (isoYear) when = `${isoYear}-${isoMonth}-${isoDay}`;
    else if (month) {
      const m = two(MONTHS.findIndex((name) => name.startsWith(month)) + 1);
      when = day ? `${year}-${m}-${two(day)}` : `${year}-${m}`;
      if (day && hour) when += `T${hour}:${minute}Z`;
    }
    return `<time datetime="${when}">${all}</time>`;
  });
}

/**
 * A number of numbers.json as the page carries it. Empty, and said in `left`, when there is no such number.
 * @param {Build} b @param {string} key
 * @returns {string}
 */
export function numberSpan(b, key) {
  if (!Object.hasOwn(b.numbers, key)) {
    b.left.push(`number ${key}`);
    return '';
  }
  return `<span data-n="${attr(key)}">${esc(setNumber(b.numbers[key].text))}</span>`;
}

/**
 * A sentence with numbers in it. The sentence names its numbers as {{key}}, the way the data files do; its own
 * words are escaped and its dates marked. Empty when one of its numbers does not exist: a sentence is never shown
 * with a hole in it.
 * @param {Build} b @param {unknown} template
 * @returns {string}
 */
export function fill(b, template) {
  if (typeof template !== 'string' || template === '') return '';
  let whole = true;
  const out = template.split(/(\{\{\s*[^{}\s]+\s*\}\})/).map((part) => {
    const key = /^\{\{\s*([^{}\s]+)\s*\}\}$/.exec(part)?.[1];
    if (key === undefined) return markDates(esc(part));
    const span = numberSpan(b, key);
    if (span === '') whole = false;
    return span;
  }).join('');
  return whole ? out : '';
}

/**
 * The tag of a check: a quiet link to its entry. `words` are the words of the place that shows it; without
 * them the tag says what the row says. Empty when there is no such row.
 * @param {Build} b @param {string} id  Id of the row. @param {string} [words]
 * @returns {string}
 */
export function tagLink(b, id, words) {
  const row = b.rows.find((r) => r.id === id);
  if (!row) {
    b.left.push(`check ${id}`);
    return '';
  }
  return tagOf(row, words);
}

/**
 * The tag of a row: a quiet link to the entry of its check, the drawn mark of its status and its id as its text
 * ("K5"), so that it reads the same with scripts off. Its name says the status in words. The words of the place that
 * shows it are kept on the tag (data-words); a place with room for them writes them beside the tag (see plainWords).
 * @param {CheckRow} row @param {string} [words]
 * @returns {string}
 */
export function tagOf(row, words) {
  const own = typeof words === 'string' && words !== '' ? ` data-words="${attr(words)}"` : '';
  return `<a class="check-link" data-check="${attr(row.id)}"${own} data-status="${row.status}" href="${CHECKS_PAGE}#${attr(encodeURIComponent(row.id))}" aria-label="Check ${attr(row.id)}: ${attr((STATUS_NAME[row.status] ?? row.status).toLowerCase())}">${statusMark(row.status)}${esc(row.id)}</a>`;
}

/**
 * The plain words of a check, as they stand beside its stamp. Words that say no more than the status ("not
 * reviewed") are left to the stamp: then this is empty.
 * @param {unknown} words
 * @returns {string}
 */
export function plainWords(words) {
  const plain = typeof words === 'string' ? words.trim() : '';
  return plain === '' || /^not reviewed( yet)?$/i.test(plain) ? '' : esc(plain);
}

/**
 * Fill the tags that a page holds in its own words: every <a class="check-link" data-check="id"> gets the status of its
 * row, the address of its entry and the words of the row (or its own, when it names them in data-words).
 * @param {string} html @param {Build} b
 * @returns {string}
 */
export function fillTags(html, b) {
  return html.replace(/<a class="(?:tag|check-link)" data-check="([^"]*)"([^>]*)>[\s\S]*?<\/a>/g, (all, id, rest) => {
    const words = /\sdata-words="([^"]*)"/.exec(rest)?.[1];
    const unescaped = words?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return tagLink(b, id.replace(/&amp;/g, '&'), unescaped) || all;
  });
}

/**
 * A picture of the site. Empty, and said in `left`, when the file is not there. It is fetched when it comes near the
 * window (most pictures of these pages sit far down, or inside an entry that is closed).
 * @param {Build} b @param {string} src  Path inside the site. @param {string} alt @param {string} [cls]
 * @returns {string}
 */
export function picture(b, src, alt, cls = '') {
  const size = b.size(src);
  if (!size) {
    b.left.push(`picture ${src}`);
    return '';
  }
  return `<img${cls ? ` class="${attr(cls)}"` : ''} src="${attr(src)}" width="${size[0]}" height="${size[1]}" alt="${attr(alt)}" loading="lazy" decoding="async">`;
}

/**
 * Where a made part of a page lies: the inside of the element that carries data-built="name".
 * @param {string} html @param {string} name
 * @returns {{start: number, end: number} | null}  The inside is html.slice(start, end); null when the page has no such element.
 */
function blockAt(html, name) {
  const open = new RegExp('<([a-zA-Z][a-zA-Z0-9]*)\\b[^<>]*\\sdata-built="' + name.replace(/[^A-Za-z0-9_-]/g, '') + '"[^<>]*>').exec(html);
  if (!open) return null;
  const tag = open[1], start = open.index + open[0].length;
  const next = new RegExp('<(/?)' + tag + '\\b[^<>]*>', 'g');
  next.lastIndex = start;
  let depth = 1;
  for (let m = next.exec(html); m; m = next.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { start, end: m.index };
  }
  return null;
}

/**
 * The inside of a made part of a page, without the line breaks around it. Null when the page has no such part.
 * @param {string} html @param {string} name
 * @returns {string | null}
 */
export function getBlock(html, name) {
  const at = blockAt(html, name);
  return at ? html.slice(at.start, at.end).replace(/^\n|\n$/g, '') : null;
}

/**
 * Put a made part into a page. An empty part leaves its element empty, with no white space in it, so that the
 * stylesheet can tell that it holds nothing. Throws when the page has no element for the part.
 * @param {string} html @param {string} name @param {string} inner
 * @returns {string}
 */
export function setBlock(html, name, inner) {
  const at = blockAt(html, name);
  if (!at) throw new Error(`the page has no element marked data-built="${name}"`);
  return html.slice(0, at.start) + (inner === '' ? '' : `\n${inner}\n`) + html.slice(at.end);
}

/**
 * Fill the numbers a page carries, as the gate does: every <span data-n="key"> gets the text of its number. A key
 * that is not a number is left as it is; the gate says so.
 * @param {string} html @param {Numbers} numbers
 * @returns {string}
 */
export function fillNumbers(html, numbers) {
  return html.replace(/<span\b([^<>]*?\s)data-n="([^"]*)"([^<>]*)>([^<]*)<\/span\s*>/g, (all, before, key, after) => (
    Object.hasOwn(numbers, key) ? `<span${before}data-n="${key}"${after}>${esc(setNumber(numbers[key].text))}</span>` : all));
}

/** What each of the five targets is, in a line. The comet has its own page. */
const WHAT = Object.freeze(/** @type {Record<string, string>} */ ({
  'eps-indi-b': 'Two brown dwarfs, close to the Sun, drifting across the sky.',
  barnard: 'The fastest-moving star in the sky.',
  wise0855: 'The coldest brown dwarf known, and a fast mover.',
  'rw-aur': 'A young star that dims and brightens without warning.',
  'r-dra': 'A red giant that brightens and fades over months.',
}));

/** What was measured on a target of each kind, and what it was set against: two cells of the row under its name. */
const MEASURED = Object.freeze(/** @type {Record<string, [measured: string, against: string]>} */ ({
  mover: ['How far it moved across the sky since the earlier image', 'Where its catalogue puts it on both dates'],
  gallery: ['How far it moved across the sky since the earlier image', 'Where its catalogue puts it on both dates'],
  variable: ['How much its brightness changed, in each band of colour', 'Steady stars in the same photos'],
  saturated: ['How many of its photos are saturated', 'Nothing: it is too bright to compare'],
}));

/** A number with three decimals at most, for a place in a drawing. @param {number} v */
const place = (v) => String(Math.round(v * 1000) / 1000);

/**
 * The two pictures of a jump and what is marked on them, from a card of a target (card.jump) or of a gallery star
 * (the card itself). Null when the card has none.
 * @param {any} card
 * @returns {{panels: any[], rings: {u: number, v: number}[], measured: {u: number, v: number}[], track: {u: number, v: number}[], neighbours: any[]} | null}
 */
function jumpOf(card) {
  const j = card?.jump ?? card;
  const rings = j?.catalogue ?? j?.rings;
  if (!Array.isArray(j?.panels) || j.panels.length !== 2 || !Array.isArray(rings) || rings.length !== 2) return null;
  const ok = (/** @type {any} */ p) => Number.isFinite(p?.u) && Number.isFinite(p?.v);
  if (!rings.every(ok)) return null;
  return {
    panels: j.panels,
    rings,
    measured: Array.isArray(j.measured) ? j.measured.filter(ok) : [],
    track: Array.isArray(j.track) ? j.track.filter(ok) : [],
    neighbours: Array.isArray(j.neighbours) ? j.neighbours.filter(ok) : [],
  };
}

/**
 * The marks over one picture of a jump: the path, a ring where the catalogue puts the object on the date of this
 * picture, a dashed ring where it puts it on the date of the other, a cross where it was measured, and a square on
 * each star beside it that the catalogue knows. Places are parts of the picture, from its left and from its top.
 * @param {NonNullable<ReturnType<typeof jumpOf>>} jump @param {0 | 1} panel
 * @returns {string}
 */
function jumpMarks(jump, panel) {
  const here = jump.rings[panel], there = jump.rings[1 - panel], seen = jump.measured[panel];
  const parts = [];
  if (jump.track.length > 1) parts.push(`<polyline class="jump-path" points="${jump.track.map((p) => `${place(p.u * 100)},${place(p.v * 100)}`).join(' ')}"/>`);
  parts.push(`<circle class="jump-ring jump-ring-other" cx="${place(there.u * 100)}" cy="${place(there.v * 100)}" r="5"/>`);
  parts.push(`<circle class="jump-ring" cx="${place(here.u * 100)}" cy="${place(here.v * 100)}" r="5"/>`);
  if (seen) {
    const x = seen.u * 100, y = seen.v * 100;
    parts.push(`<path class="jump-cross" d="M${place(x - 2.2)} ${place(y)}H${place(x + 2.2)}M${place(x)} ${place(y - 2.2)}V${place(y + 2.2)}"/>`);
  }
  if (panel === 1) for (const n of jump.neighbours) parts.push(`<rect class="jump-star" x="${place(n.u * 100 - 2.2)}" y="${place(n.v * 100 - 2.2)}" width="4.4" height="4.4"/>`);
  return `<svg class="jump-marks" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

/**
 * The jump of a moving target: a picture of long ago beside SPHEREx's, on one grid of the sky.
 * @param {Build} b @param {any} card @param {string} folder
 * @returns {string}
 */
function jumpFigure(b, card, folder) {
  const jump = jumpOf(card);
  if (!jump) return '';
  const name = String(card.name);
  const year = Number.isFinite(jump.panels[0].year) ? Math.floor(jump.panels[0].year)
    : Number.isFinite(jump.panels[0].mjd) ? new Date((jump.panels[0].mjd - 40587) * 86400000).getUTCFullYear() : NaN;
  const telescope = String(jump.panels[0].label ?? '').split(',')[0].trim();
  const panels = jump.panels.map((p, i) => {
    const img = picture(b, `${folder}${p.file}`, `${name} and the sky around it: ${p.label}.`);
    return img === '' ? '' : `<div class="jump-panel">${img}${jumpMarks(jump, /** @type {0 | 1} */ (i))}</div>`;
  });
  if (panels.some((p) => p === '') || !telescope || !Number.isFinite(year)) return '';
  const beside = jump.neighbours.length
    ? ` The small square marks ${jump.neighbours.length === 1 ? 'a star' : 'stars'} that the Gaia catalogue lists (${jump.neighbours.map((n) => `<cite>${esc(n.source)}</cite>`).join(', ')}): ${jump.neighbours.length === 1 ? 'it stays' : 'they stay'} put, and ${jump.neighbours.length === 1 ? 'is' : 'are'} not the target.`
    : '';
  const what = jump.panels.map((p) => (p.what ? `<p><cite>${esc(p.label)}: ${esc(p.what)}</cite></p>` : '')).join('\n');
  // a star of the gallery has these two pictures and no other: they are marked so that they can be blinked (spotit.js)
  return `<figure class="tcard-jump" data-jump${card.kind === 'gallery' ? ' data-spot' : ' data-lead-flip'}>
${pairPlate(panels, [['Earlier image', markDates(esc(jump.panels[0].label))], ['Later image', markDates(esc(jump.panels[1].label))]], card.kind !== 'gallery')}
<figcaption>
<p class="jump-key">With a ${esc(telescope)} image of ${markDates(String(year))}, on the same grid of the sky as the SPHEREx one: north is up and east is to the left in both. The ring is where the catalogue puts it on the date of each picture, the dashed ring where it puts it on the date of the other, and the line is its path between the two.${jump.measured.length === 2 ? ' The cross is where it was measured.' : ''}${beside}</p>
<details class="about">
<summary>What these two pictures are</summary>
${what}
<p>Both are drawn on one grid of the sky, north up and east to the left, so they are resampled; the grey scale of each is its own.</p>
</details>
</figcaption>
</figure>`;
}

/**
 * Two pictures of one patch of sky on one plate, side by side, each over the cell that says what it is.
 * @param {string[]} panels  The two pictures, each in its element of class "jump-panel".
 * @param {[label: string, html: string][]} cells  What each picture is: the cell under it.
 * @param {boolean} [verdict]  Keep the place of the band under the plate where the name of the picture that shows stands.
 * @returns {string}
 */
function pairPlate(panels, cells, verdict = false) {
  return `<div class="plate-frame">
<div class="plate jump" data-plate>
${panels.join('\n')}
</div>
${verdict ? '<p class="plate-verdict" data-verdict data-plate aria-hidden="true"></p>\n' : ''}${cellRow(cells.map(([label, html], i) => [label, html, ` data-panel="${i}"`]), { cols: 2 })}
</div>`;
}

/**
 * The first of the keys that ends in `ending`.
 * @param {unknown} keys @param {string} ending
 * @returns {string | undefined}
 */
export function keyEnding(keys, ending) {
  return Array.isArray(keys) ? keys.find((k) => typeof k === 'string' && k.endsWith(ending)) : undefined;
}

/**
 * A short ledger of facts in ruled rows: on each line a label and what stands against it.
 * @param {[string, string][]} lines  [label, HTML]; a line without HTML (a sentence that lacked a number) is left out.
 * @param {string} [cls]  A class of the ledger beside "facts".
 * @returns {string}
 */
export function factList(lines, cls = '') {
  const items = lines.filter(([, html]) => html !== '');
  if (!items.length) return '';
  return `<dl class="facts${cls ? ` ${attr(cls)}` : ''}">\n${items.map(([label, html]) => `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`).join('\n')}\n</dl>`;
}

/**
 * The colour bands of a variable star: a short ruler with the six bands on it, and for each band its change, or
 * the words that say why none is given.
 * @param {Build} b @param {any[]} bands
 * @returns {string}
 */
function bandList(b, bands) {
  const spans = bands.map((band) => {
    const from = keyEnding(band.numbers, '.colour.from'), to = keyEnding(band.numbers, '.colour.to');
    const a = from ? b.numbers[from]?.value : NaN, z = to ? b.numbers[to]?.value : NaN;
    return { band, from, to, a, z };
  }).filter((s) => Number.isFinite(s.a) && Number.isFinite(s.z) && s.z > s.a);
  if (!spans.length) return '';
  const lo = Math.min(...spans.map((s) => s.a)), hi = Math.max(...spans.map((s) => s.z));
  const ruler = spans.map((s) => `<span class="band-span" data-det="${attr(s.band.detector)}" data-shown="${s.band.shown === true}" style="left:${place(100 * (s.a - lo) / (hi - lo))}%;width:${place(100 * (s.z - s.a) / (hi - lo))}%"></span>`).join('');
  const items = spans.map((s) => {
    const range = fill(b, `{{${s.from}}} to {{${s.to}}}`);
    let text;
    if (s.band.shown === true) {
      const error = keyEnding(s.band.numbers, '.masked.error'), pairs = keyEnding(s.band.numbers, '.masked.pairs');
      const stars = keyEnding(s.band.numbers, '.stars.median'), count = keyEnding(s.band.numbers, '.stars');
      const more = [
        error && pairs ? fill(b, `give or take {{${error}}} %, from {{${pairs}}} pairs of photos`) : '',
        stars && count ? fill(b, `the {{${count}}} steady stars beside it changed by {{${stars}}} %`) : '',
      ].filter(Boolean).join('; ');
      text = `<span class="band-text">${fill(b, s.band.text)}</span>${more ? ` <span class="band-more">${more}</span>` : ''}`;
    } else text = `<span class="band-text">${range} µm</span> <span class="band-more">${esc(s.band.text)}</span>`;
    return `<li data-det="${attr(s.band.detector)}" data-shown="${s.band.shown === true}"><span class="band-swatch" data-plate aria-hidden="true"></span>${text}</li>`;
  });
  // the ruler is a drawing made of data: it stands on a plate, and the lines under it hang from it in its order
  return `<div class="bands">
<p class="label">Its change in each band of colour</p>
<div class="band-ruler" data-plate aria-hidden="true">${ruler}</div>
<ul class="band-list">
${items.join('\n')}
</ul>
<p class="note">Colours are wavelengths in micrometres (µm), from the shortest on the left of the ruler to the longest on the right. A band without a figure is too close to saturation: the star's own light spoils the measurement there.</p>
</div>`;
}

/**
 * One item of the bulletin: a target seen at two visits at one colour. Under its name, a row of cells says what
 * kind of object it is, what was measured, what that was set against and how its check stands; then come the
 * plate of its two visits, what was found, the way into the viewer, and the figures behind the verdict.
 * @param {Build} b
 * @param {any} card  card.json of the target.
 * @param {any} manifest  manifest.json of its showcase.
 * @param {{folder: string, viewer: string | null, heading?: 'h2' | 'h3'}} at  `folder`: the showcase's
 *   folder inside the site, ending in "/"; `viewer`: the `t` of its address in the viewer, or null when it has none.
 * @returns {string}
 */
export function targetCard(b, card, manifest, at) {
  const id = String(card.id), name = String(card.name), h = at.heading ?? 'h2', kind = String(card.kind ?? '');
  // the two photos that are shown are the first pair of the showcase: the months are those of these two photos.
  // A star of the gallery has no such picture: what it shows is its jump since the earlier image.
  const paired = kind !== 'gallery';
  /** @type {number[]} */
  const times = (paired && Array.isArray(manifest?.pairs?.[0]) ? manifest.pairs[0] : []).map((/** @type {number} */ i) => manifest.frames?.[i]?.mjd);
  const months = times.length === 2 && times.every(Number.isFinite) ? times.sort((p, q) => p - q).map(monthOf) : [];
  if (paired && !months.length) b.left.push(`pair of photos of ${id}`);
  const still = months.length ? picture(b, `${at.folder}${card.preview ?? 'pair.png'}`,
    `Two photos of the patch of sky around ${name}, side by side: ${months[0]} on the left and ${months[1]} on the right. Both were taken at the same infrared colour.`, 'blink-still') : '';
  const pairs = keyEnding(manifest?.numbers, '.pairs');
  const empty = kind === 'saturated' ? ' The middle of the star is left empty: the light there was too much for the detector.' : '';
  // what there is to see between these two visits: the movers move by about a pixel
  const stays = kind === 'mover'
    ? fill(b, `Between these two visits the star moves about {{v4.targets.${id}.visits_px}} of one SPHEREx pixel: blink the two and look for the jump.`)
    : kind === 'variable' ? 'It does not move: what changes between the two visits is its brightness.'
      : kind === 'saturated' ? 'It does not move: it is too bright for the detector.' : '';
  // the plate of the two visits: the two photos side by side as they stand in the page, and one photo that blinks
  // once the script of the page has drawn it. The cells joined under it are the two visits and their colour; the
  // script marks the visit that is on the plate and writes the colour of its photo.
  const blink = still === '' ? '' : `<figure class="tcard-blink" data-blink data-manifest="${attr(at.folder)}manifest.json">
<div class="plate-frame">
<div class="plate blink-box" data-box data-plate>
${still}
</div>
<p class="plate-verdict" data-verdict data-plate aria-hidden="true"></p>
${cellRow([
    ['Earlier visit', markDates(esc(months[0])), ' data-visit="early"'],
    ['Later visit', markDates(esc(months[1])), ' data-visit="late"'],
    ['Colour', '<span data-colour>The same in both</span>'],
  ], { cols: 3 })}
</div>
<figcaption>${stays ? `<span class="blink-lead">${stays}</span> ` : ''}<span class="blink-sides">The earlier visit is on the left, the later one on the right. </span>${pairs ? fill(b, `{{${pairs}}} pairs of photos match in colour; this is the first.`) : ''}${empty}</figcaption>
</figure>`;

  // the row of cells under the name: the last of them is the quiet link to its check, with the plain words of the
  // check beside it
  const [measured, against] = MEASURED[kind] ?? ['', ''];
  const tag = tagLink(b, String(card.check), typeof card.plain === 'string' ? card.plain : undefined);
  const plain = tag === '' ? '' : plainWords(card.plain ?? b.rows.find((r) => r.id === String(card.check))?.plain);
  const cells = cellRow([
    ['Object', esc(WHAT[id] ?? (kind === 'gallery' ? 'A fast star of the Gaia catalogue.' : ''))],
    ['Measured', esc(measured)],
    ['Against', esc(against)],
    ['Check', `${tag}${plain ? ` <span class="tag-plain">${plain}</span>` : ''}`],
  ], { cls: 'tcard-cells', cols: 4 });

  // what was found, in two or three sentences
  const verdict = fill(b, typeof card.verdict === 'string' ? card.verdict.replace(/^From (\{\{[^}]+\}\}) to (\{\{[^}]+\}\}) it /, 'Between $1 and $2 it ') : card.verdict);
  const found = [];
  if (verdict) found.push(`<p class="tcard-verdict">${verdict}</p>`);
  if (card.within_tolerance === false) found.push('<p class="tcard-outside">This is outside the tolerance written down beforehand.</p>');
  if (typeof card.note === 'string') found.push(`<p class="tcard-note">${markDates(esc(card.note))}</p>`);
  if (card.motion?.build === true) {
    // the motion was measured on the photos of one detector, which are not the pair of visits that the plate blinks: say so
    const own = Number.isInteger(card.detector) && typeof card.motion.line === 'string'
      ? card.motion.line.replace(/^(Within SPHEREx.s own data,)/, `$1 in the photos of detector ${['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][card.detector] ?? card.detector},`) : card.motion.line;
    const line = fill(b, own), motionTag = tagLink(b, String(card.motion.check));
    if (line) found.push(`<p class="tcard-motion">${[line, motionTag].filter(Boolean).join(' ')}</p>`);
  }
  if (at.viewer) found.push(`<p class="links tcard-open"><a href="view.html?t=${attr(encodeURIComponent(at.viewer).replace(/%2F/g, '/'))}">Blink it yourself<span class="visually-hidden">: ${esc(name)}</span></a></p>`);

  // the figures behind the verdict, as a ledger
  const facts = [];
  let bands = '';
  const p = keyEnding(card.numbers, '.shift.measured')?.replace(/\.shift\.measured$/, '');
  const reference = typeof card.reference?.text === 'string' ? `<cite>${esc(card.reference.text)}</cite>${card.reference.unverified === true ? ' <span class="tcard-unread">These values were taken from a database; the paper itself has not been read yet.</span>' : ''}` : '';
  if (kind === 'variable' && Array.isArray(card.bands)) {
    bands = bandList(b, card.bands);
    facts.push(factList([
      ['Compared with', 'Steady stars in the same photos, measured the same way: where they change too, the change is not the star’s own.'],
      ['Tolerance', fill(b, `A band is shown where those steady stars hold to within {{v4.tolerance.${id}}} %.`)],
      ['The star', reference],
    ], 'tcard-values'));
    if (typeof card.outside_comparison === 'string' && card.outside_comparison !== '') facts.push(`<p class="tcard-note">${esc(card.outside_comparison.charAt(0).toUpperCase() + card.outside_comparison.slice(1))}.</p>`);
  } else if (kind === 'saturated') {
    facts.push(factList([['The star', reference]], 'tcard-values'));
  } else if (p) {
    const catalogue = fill(b, `{{${p}.shift.catalogue}} arcsec`);
    // the earlier image is a sum of exposures: one month when they all fall in it, and otherwise from one to another
    const earlier = b.numbers[`${p}.wise.first`]?.text === b.numbers[`${p}.wise.last`]?.text ? `{{${p}.wise.first}}` : `{{${p}.wise.first}} to {{${p}.wise.last}}`;
    facts.push(factList([
      ['Measured', fill(b, `{{${p}.shift.measured}} arcsec in {{${p}.shift.years}} years, between the earlier image (${earlier}) and SPHEREx ({{${p}.spherex.month}})`)],
      ['Reference', catalogue && reference ? `${catalogue}, from ${reference}` : ''],
      ['Gap between the two shifts', fill(b, `{{${p}.shift.diff}} arcsec, which is {{${p}.shift.diff_px}} of a SPHEREx pixel. The two shifts are compared east and north, so this is never smaller than the plain difference of the two lengths above.`)],
      ['Tolerance', fill(b, `{{${p}.shift.tolerance}} arcsec`)],
      ['In SPHEREx alone', fill(b, `{{${p}.position.off_px}} of a pixel from where the catalogue puts it; tolerance {{${p}.position.tolerance_px}}`)],
    ], 'tcard-values'));
  } else {
    const speed = keyEnding(card.numbers, '.pm'), jump = keyEnding(card.numbers, '.jump');
    facts.push(factList([
      ['Moves', speed ? fill(b, `{{${speed}}} arcsec a year`) : ''],
      ['Since the earlier image', jump ? fill(b, `{{${jump}}} arcsec`) : ''],
      ['Reference', reference],
    ], 'tcard-values'));
  }

  // an object that moved leads with the flip of the picture of long ago and SPHEREx's; the two visits come after it
  const lead = jumpFigure(b, card, at.folder);

  // capitals are written as capitals: a name may hold a number, which a stylesheet must not be left to change
  return `<article class="item tcard" id="${attr(id)}" data-kind="${attr(kind)}" aria-labelledby="${attr(id)}-name">
<${h} class="object-name tcard-name" id="${attr(id)}-name">${esc(name.toUpperCase())}</${h}>
${cells}
<div class="tcard-body">
${lead || blink}
<div class="tcard-text">
${[...found, ...facts].filter(Boolean).join('\n')}
</div>
${lead ? blink : ''}
${bands}
</div>
</article>`.replace(/\n{2,}/g, '\n');
}

/**
 * "Can you spot it?": pairs of pictures, some with a star that moved and some without. The answer of each pair is
 * closed until the visitor opens it; opening it shows the rings on the pictures. Nothing is kept of what the
 * visitor does.
 * @param {Build} b
 * @param {any} set  spotit/set.json. @param {any} answers  spotit/answers.json. @param {string} folder
 * @returns {string}
 */
export function spotList(b, set, answers, folder) {
  const items = Array.isArray(set?.items) ? set.items : [];
  const out = [];
  for (const [i, item] of items.entries()) {
    const answer = answers?.answers?.[item.id];
    if (!answer) {
      b.left.push(`answer ${item.id}`);
      continue;
    }
    /** @param {string} file @param {any} ring @param {string} label */
    const panel = (file, ring, label) => {
      const img = picture(b, `${folder}${file}`, `Pair ${i + 1}: ${label}.`);
      const marks = ring && Number.isFinite(ring.u) && Number.isFinite(ring.v)
        ? `<svg class="jump-marks" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle class="jump-ring" cx="${place(ring.u * 100)}" cy="${place(ring.v * 100)}" r="5"/></svg>` : '';
      return img === '' ? '' : `<div class="jump-panel">${img}${marks}</div>`;
    };
    const first = panel(item.a, answer.ring2010, 'the earlier picture'), second = panel(item.b, answer.ring2026, 'SPHEREx');
    if (!first || !second) continue;
    const colour = answer.mode === 'matched' ? 'The SPHEREx picture is at the colour of the earlier one.' : 'The SPHEREx picture is at another colour than the earlier one, as in a plain blink.';
    out.push(`<li class="spot" data-spot>
${pairPlate([first, second], [['Earlier picture', 'From a survey years before'], ['Later picture', 'SPHEREx']])}
<details class="about spot-answer">
<summary>Show the answer</summary>
<p>${answer.mover === true ? 'A star moved here. The rings mark where it is in each picture.' : 'Nothing moved here.'} ${colour}</p>
</details>
</li>`);
  }
  return out.length ? `<ol class="spots">\n${out.join('\n')}\n</ol>` : '';
}

// ---------------------------------------------------------------------------------------------
// In a page: the blink of a plate
// ---------------------------------------------------------------------------------------------

/**
 * The row of buttons joined under a plate, inside its frame. It is made the first time it is asked for.
 * @param {Element} frame  The frame that holds the plate and its cells.
 * @returns {HTMLElement}
 */
export function controlsOf(frame) {
  const have = frame.querySelector(':scope > .transport');
  if (have instanceof HTMLElement) return have;
  const row = el('div', { class: 'transport' });
  frame.append(row);
  return row;
}

/**
 * A photo as it is, with its target moved to its brightest pixel within `reach` pixels of the target. The middle
 * of a saturated star has no value, so the one display rule finds no peak there; it finds one here, on the rim.
 * @param {Photo} photo @param {number} reach
 * @returns {Photo}
 */
function atBrightest(photo, reach) {
  let best = -Infinity, tx = photo.tx, ty = photo.ty;
  for (let y = 0; y < photo.h; y++) {
    for (let x = 0; x < photo.w; x++) {
      const v = photo.shown[y * photo.w + x];
      if (v > best && Math.hypot(x - photo.tx, y - photo.ty) <= reach) { best = v; tx = x; ty = y; }
    }
  }
  return { ...photo, tx, ty };
}

/**
 * A blink that is in place.
 * @typedef {Object} Blink
 * @property {HTMLElement} plate  The picture that blinks.
 * @property {Loop} loop
 */

/**
 * Turn the picture of a matched pair into one picture that blinks between the two photos. The element names its
 * showcase in `data-manifest` (address of manifest.json) and may name, in `data-pair`, the two frames to blink as
 * "i,j"; without it the first pair of the manifest is taken. It holds, in an element marked `data-box`, the plain
 * picture, which stays in place when the showcase cannot be had or its two photos cannot be laid over each other.
 *
 * With each flip the month of the photo lands on the plate, and what the cells under the plate say changes in
 * place: the cell of the visit that is shown (marked `data-visit="early"` or `"late"`) is filled, and the element
 * marked `data-colour` gets the colour of the photo. The buttons stand in a row joined under those cells.
 * @param {HTMLElement} figure
 * @returns {Promise<Blink | null>}
 */
export async function mountBlink(figure) {
  const address = figure.dataset.manifest, box = figure.querySelector('[data-box]');
  if (!address || !(box instanceof HTMLElement)) return null;
  const showcase = await loadShowcase(new URL(address, document.baseURI));
  if (!showcase) return null;
  const { manifest, photos } = showcase;
  const named = (figure.dataset.pair ?? '').split(',').map((s) => (s.trim() === '' ? NaN : Number(s)));
  const pair = named.length === 2 && named.every(Number.isInteger) ? named : Array.isArray(manifest.pairs) ? manifest.pairs[0] : undefined;
  if (!pair) return null;
  let early = photos[pair[0]], late = photos[pair[1]];
  if (!early || !late || early === late) return null;
  if (early.mjd > late.mjd) [early, late] = [late, early];
  // a showcase on the display grid has north up in every photo; one in the detector's own pixels is turned, and
  // the turn is measured on the stars
  if (/** @type {{grid?: string}} */ (manifest).grid === 'north-up') early.turn = late.turn = 0;
  else if (!lineUp(late, late) || !lineUp(late, early)) return null;
  const size = viewSize([early, late]);
  const rule = displayRule([early, late]) ?? displayRule([early, late].map((p) => atBrightest(p, (size - 1) / 2)));
  if (!rule) return null;

  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const plate = el('div', { class: 'plate-live' }, [canvas, el('span', { class: 'plate-mark', 'aria-hidden': 'true' })]);
  // the frame holds the plate and the cells joined under it; the figure is inside it or around it
  const frame = box.closest('.plate-frame') ?? figure;
  // the month of the photo stands on a black band under the plate, inside the frame, never over the photo's pixels
  const when = frame.querySelector(':scope > [data-verdict]') ?? el('p', { class: 'plate-verdict', 'data-verdict': '', 'data-plate': '', 'aria-hidden': 'true' });
  if (!when.parentElement) {
    let under = box;
    while (under.parentElement && under.parentElement !== frame) under = under.parentElement;
    under.after(when);
  }
  const visits = [...frame.querySelectorAll('[data-visit]')].filter((cell) => cell instanceof HTMLElement);
  const colour = frame.querySelector('[data-colour]');
  // capitals are written as capitals: these are the words the form prints on its buttons
  const play = el('button', { type: 'button', class: 'btn transport-play', 'data-play': '' });
  const flip = el('button', { type: 'button', class: 'btn', 'data-flip': '', text: 'FLIP' });
  const spoken = el('p', { class: 'visually-hidden', role: 'status' });

  let showLate = true;
  /** @param {boolean} [say]  Also tell a screen reader: for a step the visitor asked for, never for the loop. */
  const render = (say = false) => {
    const photo = showLate ? late : early, shows = photo === early ? 'early' : 'late';
    paintPhoto(canvas, photo, rule, size);
    when.textContent = formatMonth(photo.mjd).toUpperCase();
    for (const cell of visits) cell.toggleAttribute('data-on', /** @type {HTMLElement} */ (cell).dataset.visit === shows);
    if (colour) colour.textContent = formatColour(photo.lam);
    plate.dataset.shows = shows;
    play.textContent = loop.playing() ? 'PAUSE' : 'BLINK';
    play.setAttribute('aria-pressed', String(loop.playing()));
    play.hidden = lessMotion();
    if (say) spoken.textContent = `Showing ${formatMonth(photo.mjd)}.`;
  };
  const loop = createLoop(plate, () => {
    showLate = !showLate;
    render();
  }, () => render());
  play.addEventListener('click', () => {
    if (loop.playing()) loop.pause();
    else loop.play();
  });
  flip.addEventListener('click', () => {
    loop.pause();
    showLate = !showLate;
    render(true);
  });
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => render());

  const still = box.querySelector('img');
  if (still) still.classList.add('visually-hidden');   // its description still speaks for the two photos
  box.append(plate);
  controlsOf(frame).append(play, flip, spoken);
  box.classList.add('is-live');
  render();
  // on the beat of the page, whenever it is in view, until the visitor pauses it
  loop.auto();
  return { plate, loop };
}

/**
 * Give the marks of a jump a button that hides them, so that the two pictures can be looked at bare.
 * @param {HTMLElement} figure  An element marked `data-jump`.
 */
export function mountJump(figure) {
  const frame = figure.querySelector('.plate-frame');
  if (!frame || !figure.querySelector('.jump-marks')) return;
  const button = el('button', { type: 'button', class: 'btn btn-toggle jump-toggle', 'aria-pressed': 'true' }, [
    el('span', { class: 'btn-lamp', 'aria-hidden': 'true' }), el('span', { text: 'MARKS' }),
  ]);
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    figure.classList.toggle('is-bare', !on);
  });
  controlsOf(frame).append(button);
}

/** The units that stand after a number, and stay with it on one line. */
const UNITS = 'arcsec|arcminutes|arcmin|arcseconds|µm|nm|mJy|millijanskys|micrometres|pixels?|years?|%|degrees?|kilometres';

/**
 * Set the text of a page as it is printed: curly quotes and apostrophes, a no-break space between a number and its
 * unit, an en dash between the two ends of a range of figures (4.20–4.32 µm) and × for "times" after a figure. Only
 * the words between tags and the alt, aria-label and title of a tag are touched; scripts, styles, code and drawings
 * are left as they are. Setting a text that is already set changes nothing.
 * @param {string} html
 * @returns {string}
 */
export function typeset(html) {
  /** @param {string} text */
  const curly = (text) => text
    .replace(/(^|[\s(\[\u2013\u2014])"/g, '$1\u201c').replace(/"/g, '\u201d')
    .replace(/(^|[\s(\[])'/g, '$1\u2018').replace(/'/g, '\u2019');
  const parts = html.split(/(<(script|style|code|svg)\b[\s\S]*?<\/\2>|<[^>]+>)/gi);
  // split with two capture groups gives, for each match, the match and the name of its element
  const out = [];
  for (let i = 0; i < parts.length; i += 3) {
    out.push(curly(parts[i]));
    if (i + 1 < parts.length) {
      const piece = parts[i + 1];
      out.push(/^<(script|style|code|svg)\b/i.test(piece) ? piece : piece.replace(/(\s(?:alt|aria-label|title)=")([^"]*)(")/g, (all, a, v, z) => a + curly(v) + z));
    }
  }
  return out.join('')
    .replace(new RegExp(`(data-n="[^"]*">[^<]*</span>) (${UNITS})(?![\w])`, 'g'), '$1\u00a0$2')
    .replace(/(data-n="[^"]*">\d[\d.]*<\/span>) to (<span[^>]*data-n="[^"]*">\d[\d.]*<\/span>)/g, '$1\u2013$2')
    .replace(/(data-n="[^"]*">\d[\d.]*<\/span>) times\b/g, '$1\u00d7');
}
