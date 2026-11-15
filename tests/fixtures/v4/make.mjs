// What the three pages that tell a result are made from, and the making of them.
//
// targets.html, lemmon.html and checks.html are plain HTML whose parts that come from data are written into the
// elements marked data-built (see the top of site/js/ui/cards.js). This file reads the data files of a site and
// makes those pages from them. tests/unit/v4-pages.test.mjs uses it to check the pages and to write them; the
// other tests of these pages use it to make a page from other data than the site's.
import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setBlock, fillTags, fillNumbers, typeset } from '../../../site/js/ui/cards.js';
import { buildTargets, targetNumbers, TARGET_ORDER } from '../../../site/js/pages/targets.js';
import { buildComet, cometNumbers } from '../../../site/js/pages/lemmon.js';
import { buildChecks, checksNumbers } from '../../../site/js/pages/checks.js';
import { challengeScorecard } from '../../../site/js/ui/checks.js';

/** The folder of the project. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The three pages, by their file names inside the site. */
export const PAGES = Object.freeze(['targets.html', 'lemmon.html', 'checks.html', 'index.html']);

/** A text with the line ends of every system made one. @param {string} s */
export const unix = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/**
 * Everything the three pages are made from, read from a site folder.
 * @param {string} [site]  The folder of the site.
 */
export function loadSite(site = path.join(ROOT, 'site')) {
  /** @param {string} rel @returns {any} null when there is no such file */
  const json = (rel) => (existsSync(path.join(site, rel)) ? JSON.parse(unix(readFileSync(path.join(site, rel), 'utf8'))) : null);
  /** @param {string} rel */
  const showcase = (rel) => {
    const card = json(`${rel}/card.json`), manifest = json(`${rel}/manifest.json`);
    return card && manifest ? { card, manifest } : null;
  };
  /** Width and height of a PNG picture of the site. @param {string} rel @returns {[number, number] | null} */
  const size = (rel) => {
    const file = path.join(site, rel);
    if (!existsSync(file)) return null;
    const head = Buffer.alloc(24), fd = openSync(file, 'r');
    try { readSync(fd, head, 0, 24, 0); } finally { closeSync(fd); }
    return head.toString('latin1', 1, 4) === 'PNG' ? [head.readUInt32BE(16), head.readUInt32BE(20)] : null;
  };
  const decisionDir = path.join(site, 'data/checks/decisions');
  const decisions = Object.assign({}, ...(existsSync(decisionDir) ? readdirSync(decisionDir).filter((n) => n.endsWith('.json')).sort() : []).map((n) => json(`data/checks/decisions/${n}`)));
  const targets = TARGET_ORDER.map((id) => showcase(`data/targets/${id}`)).filter((t) => t !== null);
  const index = json('data/gallery/index.json');
  const stars = (Array.isArray(index?.items) ? index.items : []).map((/** @type {any} */ i) => showcase(`data/gallery/${i.id}`)).filter((/** @type {any} */ t) => t !== null);
  const set = json('data/spotit/set.json'), answers = json('data/spotit/answers.json');
  return {
    /** @type {import('../../../site/js/contracts.js').Numbers} */
    numbers: json('data/numbers.json') ?? {},
    /** @type {import('../../../site/js/contracts.js').CheckRow[]} */
    rows: json('data/checks/checks.json') ?? [],
    size,
    targets: {
      targets,
      tolerances: json('data/targets/tolerances.json'),
      decisions,
      /** @type {{index: any, cards: {card: any, manifest: any}[]} | null} */
      gallery: index ? { index, cards: stars } : null,
      /** @type {{set: any, answers: any} | null} */
      spotit: set && answers ? { set, answers } : null,
      pluto: showcase('data/pluto'),
    },
    comet: {
      track: json('data/lemmon/track.json'),
      spectrum: json('data/lemmon/spectrum.json'),
      strip: json('data/lemmon/strip/manifest.json'),
      templates: json('data/lemmon/templates/manifest.json'),
      wide: json('data/lemmon/wide/manifest.json'),
    },
    checks: {
      limits: json('data/checks/limits.json'),
      challenge: json('data/challenge.json'),
      tried: json('data/tried.json'),
      names: Object.fromEntries(targets.map((t) => [String(t.card.id), String(t.card.name)])),
    },
  };
}

/** @typedef {ReturnType<typeof loadSite>} SiteData */

/**
 * The data of a site with the parts that are shown only when their checks allow them put in from a fixture
 * (tests/fixtures/v4/optional.json): the gallery, "Can you spot it?" and Pluto, with their numbers, their Checks
 * rows and their decisions. A picture that the fixture names has the size given here.
 * @param {SiteData} data
 * @param {any} optional
 * @param {{decisions?: Record<string, any>}} [change]  Decisions to use in place of the fixture's.
 * @returns {SiteData}
 */
export function withOptional(data, optional, change = {}) {
  const ids = new Set(optional.rows.map((/** @type {{id: string}} */ r) => r.id));
  return {
    ...data,
    numbers: { ...data.numbers, ...optional.numbers },
    rows: [...data.rows.filter((r) => !ids.has(r.id)), ...optional.rows],
    size: (rel) => (/^data\/(gallery|spotit|pluto)\//.test(rel) ? [244, 244] : data.size(rel)),
    targets: {
      ...data.targets,
      decisions: { ...data.targets.decisions, ...(change.decisions ?? optional.decisions) },
      gallery: optional.gallery,
      spotit: optional.spotit,
      pluto: optional.pluto,
    },
  };
}

/**
 * Make the three pages and the numbers they add, from the data of a site and the pages as they are.
 * @param {SiteData} data
 * @param {Record<string, string>} pages  The text of each page, by its file name.
 * @returns {{pages: Record<string, string>, own: Record<string, import('../../../site/js/contracts.js').NumberEntry>, left: string[]}}
 */
export function makePages(data, pages) {
  const own = Object.fromEntries(Object.entries({ ...targetNumbers({ ...data.targets, numbers: data.numbers }), ...cometNumbers(data.comet), ...checksNumbers(data.rows, data.checks) }).sort(([a], [b]) => (a < b ? -1 : 1)));
  // a number names the check behind it; where that row is not there, it names none
  const ids = new Set(data.rows.map((r) => r.id));
  for (const n of Object.values(own)) if (n.check !== null && !ids.has(n.check)) n.check = null;
  /** @type {import('../../../site/js/ui/cards.js').Build} */
  const b = { numbers: { ...data.numbers, ...own }, rows: data.rows, size: data.size, left: [] };
  const blocks = {
    'targets.html': buildTargets(b, { ...data.targets, numbers: data.numbers }),
    'lemmon.html': buildComet(b, data.comet),
    'checks.html': buildChecks(b, data.checks),
    'index.html': { scorecard: data.checks.challenge ? challengeScorecard(data.checks.challenge) : '' },
  };
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, parts] of Object.entries(blocks)) {
    let html = unix(pages[name]);
    for (const [part, inner] of Object.entries(parts)) html = setBlock(html, part, name === 'index.html' ? typeset(inner) : inner);
    // the first page is written by hand: only its made part is set, and the rest of it is left as it is
    out[name] = name === 'index.html' ? html : typeset(fillNumbers(fillTags(html, b), b.numbers));
  }
  return { pages: out, own, left: [...new Set(b.left)] };
}

/**
 * The three pages as they are in a project.
 * @param {string} [root]
 * @returns {Record<string, string>}
 */
export function readPages(root = ROOT) {
  return Object.fromEntries(PAGES.map((name) => [name, readFileSync(path.join(root, 'site', name), 'utf8')]));
}

/**
 * What a reader of a page is told, as plain text: the words between the tags, and the words that stand in for a
 * picture or name a control (alt, aria-label, title), each on a line of its own. Scripts and styles are left out.
 * @param {string} html
 * @returns {string}
 */
export function wordsOf(html) {
  const body = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const said = [...body.matchAll(/\s(?:alt|aria-label|title|content)="([^"]*)"/g)].map((m) => m[1]);
  return unescape([body.replace(/<[^>]*>/g, ' '), ...said].join('\n')).replace(/[ \t]+/g, ' ');
}

/** @param {string} s */
function unescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
