#!/usr/bin/env node
// Fills the texts in content/ and writes them to content/out/.
//
//   {{some.key}}      the text of that number in site/data/numbers.json
//   {{site.name}}     the name in site/data/site.json (also {{site.team}} and {{site.url}} when they are there)
//   {{@references}}   the list of REFERENCES.md, one line each (the test files that are single SPHEREx frames
//                     are counted in one line)
//   {{@challenge}}    the lines of site/data/challenge.json, one each, with how far each is built
//
// What it checks while it fills:
//   page.md      each field of the project page is under its own heading; the length of the filled text is
//                counted and held to the range of its field; words that must not be there are not there
//   captions.txt "0:00-0:02 | caption | what is on screen", one line each; the video ends by 0:30; no more than
//                12 words are on screen at any moment
//   pitch.md     the spoken part is counted in words, and one minute is taken as 130 words
//
//   node tools/render-content.mjs            write content/out/
//   node tools/render-content.mjs --check    write nothing; fail if content/out/ is not what a run writes
//   node tools/render-content.mjs --final    also fail on what must be put right before the text is used: a
//                                            name, team or address that is not yet in site.json, and a number
//                                            from a Checks row that nobody has reviewed
//   --root <folder>                          the project folder (default: the folder above tools/)
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { challengeText } from '../site/js/ui/checks.js';

/** The fields of the project page: their heading, and the number of characters allowed (inclusive). */
export const FIELDS = [
  { heading: 'Project name', min: 1, max: 80 },
  { heading: 'High-level summary', min: 600, max: 1400 },
  { heading: 'Detailed description', min: 2400, max: 4000 },
  { heading: 'NASA data', min: 200, max: null },
  { heading: 'Space agency partner data and other references', min: 200, max: null },
];

/** What a text for the public must not say. Each is a pattern and the reason, in the words of the message. */
export const BANNED = [
  [/\bfirst\b/i, '"first" claims a priority we have not shown'],
  [/\bdiscover/i, '"discovery" is not what a blink at 6 arcseconds a pixel can promise'],
  [/\bconfirm/i, '"confirms" is too strong; the checks reproduce and bound, they do not confirm'],
  [/every number\b[^.]*\bchecked/i, '"every number is checked" is not claimed'],
  [/\b3I\b|ATLAS/, 'the 3I/ATLAS row is shown on the Checks page and nowhere else'],
  [/\bswells?\b|\bmoved next day\b/i, 'a change of colour must not read as a change in time'],
];

/** What stands round the list of references while the text is checked: the list names sources, whatever they are. */
const LIST_OPEN = '\u0001', LIST_CLOSE = '\u0002';
/** @param {string} s */
const unlisted = (s) => s.replace(/\u0001[^\u0002]*\u0002/g, '');
/** @param {string} s */
const unmarked = (s) => s.replace(/[\u0001\u0002]/g, '');

/** The words per minute a three-minute script is counted at. */
export const WORDS_PER_MINUTE = 130;

/** @param {string} s @returns {number} the characters of s, an astral character counted once */
export const countChars = (s) => [...s].length;

/** @param {string} s @returns {number} */
export const countWords = (s) => (s.match(/\S+/g) ?? []).length;

/** @param {string} s */
const unix = (s) => s.replace(/\r\n/g, '\n');
/** @param {string} file */
const read = (file) => unix(readFileSync(file, 'utf8').replace(/^﻿/, ''));
/** @param {string} heading */
const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** @param {number} n */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** @param {string} dir @returns {string[]} the .md and .txt files directly in dir, sorted */
function sources(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((n) => /\.(md|txt)$/.test(n) && statSync(path.join(dir, n)).isFile()).sort() : [];
}

/**
 * The lines of REFERENCES.md as "name (licence): address".
 * @param {string} text REFERENCES.md
 * @returns {string[]}
 */
export function referenceLines(text) {
  /** @type {string[]} */
  const lines = [];
  let frames = 0;
  for (const raw of unix(text).split('\n')) {
    const m = /^\| (.+?) \| <(\S+)> \| (.+?) \| .* \|$/.exec(raw);
    if (!m || m[1] === 'Name') continue;
    if (/^SPHEREx frame level2_/.test(m[1])) { frames++; continue; }
    lines.push(`- ${m[1]} (${m[3]}): ${m[2]}`);
  }
  if (frames) lines.push(`- ${frames} single SPHEREx Level 2 frames kept as test files (each with its address in REFERENCES.md of the repository): Public, no usage restrictions`);
  return lines;
}

/**
 * Fill the {{keys}} of one text.
 * @param {string} text
 * @param {string} rel   the file's path, for the messages
 * @param {{numbers: Record<string, any>, site: Record<string, any>, references: string | null | false, challenge?: any}} src
 *   references: the text of REFERENCES.md; null when there is none (an error); false when it could not be put
 *   together (the gate has said so, and a text that needs it is left alone)
 * @returns {{text: string, errors: string[], used: Set<string>, open: string[], skipped: boolean}}
 *   used: the number keys it used; open: the site values that are still missing
 */
export function fill(text, rel, { numbers, site, references, challenge = null }) {
  /** @type {string[]} */
  const errors = [];
  const used = new Set();
  /** @type {string[]} */
  const open = [];
  let skipped = false;
  const out = text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (all, key) => {
    if (key === '@references') {
      if (references === false) { skipped = true; return all; }
      if (references === null) { errors.push(`${rel}: {{@references}} needs REFERENCES.md`); return all; }
      return `${LIST_OPEN}${referenceLines(references).join('\n')}${LIST_CLOSE}`;
    }
    if (key === '@challenge') {
      const lines = challengeText(challenge);
      if (!lines.length) { errors.push(`${rel}: {{@challenge}} needs site/data/challenge.json`); return all; }
      return lines.join('\n');
    }
    if (key.startsWith('site.')) {
      const v = site[key.slice(5)];
      if (typeof v === 'string' && v.trim() !== '') return v;
      if (key === 'site.name') { errors.push(`${rel}: site.json has no name for {{site.name}}`); return all; }
      open.push(key);
      return `[${key.slice(5)}]`;
    }
    if (!Object.hasOwn(numbers, key)) { errors.push(`${rel}: number "${key}" is not in numbers.json`); return all; }
    used.add(key);
    return numbers[key].text;
  });
  return { text: out, errors, used, open, skipped };
}

/**
 * The project page, field by field.
 * @param {string} filled the text with its numbers in
 * @param {string} rel
 * @returns {{text: string, errors: string[], fields: {heading: string, chars: number, body: string}[]}}
 */
export function renderPage(filled, rel) {
  /** @type {string[]} */
  const errors = [];
  const parts = filled.split(/^## +/m);
  const lines = [parts[0].replace(/\s+$/, '')];
  /** @type {{heading: string, chars: number, body: string}[]} */
  const fields = [];
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim();
    const raw = (nl < 0 ? '' : part.slice(nl + 1)).replace(/^\s+|\s+$/g, '');
    const body = unmarked(raw);
    const chars = countChars(body);
    const rule = FIELDS.find((f) => f.heading === heading);
    let note = `Length: ${grouped(chars)} characters`;
    if (rule) {
      note += rule.max === null ? ` (at least ${grouped(rule.min)})` : ` (${grouped(rule.min)} to ${grouped(rule.max)})`;
      if (chars < rule.min) errors.push(`${rel}: "${heading}" has ${chars} characters; at least ${rule.min}`);
      if (rule.max !== null && chars > rule.max) errors.push(`${rel}: "${heading}" has ${chars} characters; at most ${rule.max}`);
    }
    for (const [pattern, why] of BANNED) if (pattern.test(unlisted(raw))) errors.push(`${rel}: "${heading}": ${why}`);
    fields.push({ heading, chars, body });
    lines.push('', `## ${heading}`, '', note, '', body);
  }
  if (!fields.length) for (const [pattern, why] of BANNED) if (pattern.test(unlisted(filled))) errors.push(`${rel}: ${why}`);
  return { text: `${lines.join('\n').replace(/^\n+/, '')}\n`, errors, fields };
}

/** @param {string} t "m:ss" @returns {number} seconds */
export const seconds = (t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; };

/**
 * The captions of the video.
 * @param {string} filled
 * @param {string} rel
 * @returns {{errors: string[], captions: {start: number, end: number, text: string, shot: string, words: number}[], busiest: number}}
 */
export function parseCaptions(filled, rel) {
  /** @type {string[]} */
  const errors = [];
  /** @type {{start: number, end: number, text: string, shot: string, words: number}[]} */
  const captions = [];
  for (const [i, raw] of filled.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(\d+:\d\d)\s*-\s*(\d+:\d\d)\s*\|\s*(.+?)\s*\|\s*(.+)$/.exec(line);
    if (!m) { errors.push(`${rel}:${i + 1}: a line is "0:00-0:02 | caption | what is on screen"`); continue; }
    const [, a, b, text, shot] = m;
    const start = seconds(a), end = seconds(b);
    if (!(end > start)) errors.push(`${rel}:${i + 1}: ${a}-${b} ends before it starts`);
    if (end > 30) errors.push(`${rel}:${i + 1}: ${b} is after the 30 seconds of the video`);
    captions.push({ start, end, text, shot, words: countWords(text) });
  }
  let busiest = 0;
  for (let t = 0; t < 30; t += 0.5) {
    const words = captions.filter((c) => c.start <= t && t < c.end).reduce((n, c) => n + c.words, 0);
    busiest = Math.max(busiest, words);
    if (words > 12) { errors.push(`${rel}: ${words} words are on screen at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}; at most 12`); break; }
  }
  for (const [pattern, why] of BANNED) for (const c of captions) if (pattern.test(c.text)) errors.push(`${rel}: "${c.text}": ${why}`);
  return { errors, captions, busiest };
}

/**
 * The spoken part of the pitch: what stands under the heading "Script" and above "Questions". Headings and
 * the bracketed stage directions are not spoken.
 * @param {string} filled
 * @param {string} rel
 */
export function pitchStats(filled, rel) {
  /** @type {string[]} */
  const errors = [];
  const from = filled.search(/^## +Script\b/m), to = filled.search(/^## +Questions\b/m);
  const script = filled.slice(Math.max(from, 0), to < 0 ? undefined : to).split('\n').filter((l) => !l.startsWith('#')).join('\n').replace(/\[[^\]]*\]/g, '');
  const words = countWords(script);
  for (const [pattern, why] of BANNED) if (pattern.test(filled)) errors.push(`${rel}: ${why}`);
  return { errors, words, minutes: words / WORDS_PER_MINUTE };
}

/**
 * Render every text in content/.
 * @param {{root: string, numbers: Record<string, any>, rows?: any[], references?: string | null | false, siteName?: string | null, final?: boolean}} options
 * @returns {{errors: string[], files: Record<string, string>, notes: string[]}}
 *   files: what content/out/ must hold, by path; notes: what is not yet right for the final text
 */
export function renderContent({ root, numbers, rows = [], references = null, siteName = null, final = false }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {Record<string, string>} */
  const files = {};
  /** @type {Record<string, any>} */
  let site = {};
  try { site = JSON.parse(read(path.join(root, 'site', 'data', 'site.json'))); } catch { /* the gate reports a site.json that is wrong */ }
  if (siteName !== null && typeof siteName === 'string') site = { ...site, name: siteName };
  /** @type {any} */
  let challenge = null;
  try { challenge = JSON.parse(read(path.join(root, 'site', 'data', 'challenge.json'))); } catch { /* a text that needs it says so */ }
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const dir = path.join(root, 'content');
  for (const name of sources(dir)) {
    const rel = `content/${name}`;
    const f = fill(read(path.join(dir, name)), rel, { numbers, site, references, challenge });
    errors.push(...f.errors);
    for (const key of f.open) notes.push(`${rel}: ${key} is not in site.json yet`);
    const unreviewed = [...new Set([...f.used].map((k) => numbers[k].check).filter((c) => c !== null && status.get(c) !== undefined && !['PASS', 'LIMIT', 'CORRECTED'].includes(status.get(c))))];
    if (unreviewed.length) notes.push(`${rel}: uses numbers of Checks rows nobody has reviewed: ${unreviewed.sort().join(', ')}`);
    if (f.errors.length || f.skipped) continue;
    let text = f.text;
    if (name === 'page.md') {
      const page = renderPage(text, rel);
      errors.push(...page.errors);
      text = page.text;
      for (const field of page.fields) files[`content/out/fields/${slug(field.heading)}.txt`] = `${field.body}\n`;
    } else if (name === 'captions.txt') {
      errors.push(...parseCaptions(text, rel).errors);
    } else if (name === 'pitch.md') {
      errors.push(...pitchStats(text, rel).errors);
    }
    files[`content/out/${name}`] = text;
  }
  if (final) errors.push(...notes);
  return { errors, files, notes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = path.resolve(at >= 0 ? args[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const check = args.includes('--check');
  const numbers = JSON.parse(read(path.join(root, 'site', 'data', 'numbers.json')));
  const rows = JSON.parse(read(path.join(root, 'site', 'data', 'checks', 'checks.json')));
  const refsFile = path.join(root, 'REFERENCES.md');
  const { errors, files, notes } = renderContent({ root, numbers, rows, references: existsSync(refsFile) ? read(refsFile) : null, final: args.includes('--final') });
  let bad = errors.length;
  for (const e of errors) console.error(`render-content: ${e}`);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    const disk = existsSync(file) ? read(file) : null;
    if (disk === text) continue;
    if (check) { console.error(`render-content: ${rel} ${disk === null ? 'is missing' : 'differs from what a run writes'}`); bad++; continue; }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`render-content: wrote ${rel}`);
  }
  if (!args.includes('--final')) for (const n of notes) console.log(`render-content: not final yet: ${n}`);
  if (bad) process.exit(1);
  console.log(`render-content: ${check ? 'nothing differs' : 'done'} (${Object.keys(files).length} files)`);
}
