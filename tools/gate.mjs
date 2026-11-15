#!/usr/bin/env node
// The consistency gate. One run does four things, in this order:
//
//   1. merges site/data/numbers/*.json into site/data/numbers.json and site/data/checks/rows/*.json into
//      site/data/checks/checks.json (one file per producer; a key or a row id defined twice is an error);
//   2. fills every <span data-n="key"> of the pages with the text of that number, every element marked
//      data-site="name" with the name in site/data/site.json, and every <title data-page="..."> from both;
//   3. checks the pictures of the Checks rows: each file exists and its SHA-256 is the one in the row;
//   4. joins references/*.md into REFERENCES.md under a fixed order of headings;
//   5. fills the {{key}} of the texts in content/ into content/out/ (tools/render-content.mjs), which fails when a
//      key is not a number that exists, and writes the review sheet's table (tools/review.mjs) when there is one.
//
//   node tools/gate.mjs            writes what changed; exits 1 if anything is wrong
//   node tools/gate.mjs --check    writes nothing; exits 1 if anything is wrong, or if a file on disk
//                                  differs from what a run would write
//   --root <folder>                the project folder (default: the folder above tools/)
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkNumbers, checkChecks, checkNumbersHaveChecks } from './contracts.mjs';
import { renderContent } from './render-content.mjs';
import { renderReviewReadme } from './review.mjs';
import { setNumber } from '../site/js/lib/setnumber.js';

/** The headings of REFERENCES.md, in the order they are written. A file in references/ uses these and no other. */
export const REFERENCE_HEADINGS = ['Datasets', 'Libraries', 'Tools and services', 'Images and fonts', 'Text sources'];

const REFERENCES_INTRO = [
  '# References',
  '',
  'Every dataset, library, tool, image and text source used in this project, with its address and its licence.',
  '',
  'This file is put together by `node tools/gate.mjs` from the files in `references/`. Edit those, not this one.',
];

/** @param {string} s */
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string} s */
const unix = (s) => s.replace(/\r\n/g, '\n');

/** @param {unknown} v */
const pretty = (v) => `${JSON.stringify(v, null, 1)}\n`;

/** A text file, without the byte-order mark that some editors put first. @param {string} file */
const read = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '');

/** Write a file in one step, so that nothing ever reads half of it. @param {string} file @param {string} text */
function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** @param {string} dir @param {(name: string) => boolean} keep @returns {string[]} names, sorted */
function list(dir, keep) {
  return existsSync(dir) ? readdirSync(dir).filter(keep).sort() : [];
}

/** @param {string} dir @param {string[]} ext @returns {string[]} every file below dir with one of the extensions, sorted */
function walk(dir, ext) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/**
 * The keys of the outermost object of a JSON text that occur more than once. JSON.parse keeps only the last
 * of them, so they have to be found in the text.
 * @param {string} text
 * @returns {string[]}
 */
export function repeatedKeys(text) {
  const seen = new Set(), twice = new Set();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1))) {
        const key = JSON.parse(text.slice(i, j + 1));
        (seen.has(key) ? twice : seen).add(key);
      }
      i = j;
    }
  }
  return [...twice];
}

/**
 * Merge the number files of all producers.
 * @param {string} root
 * @param {string[]} errors
 * @returns {Record<string, any> | null} null when the merge failed
 */
function mergeNumbers(root, errors) {
  const dir = path.join(root, 'site', 'data', 'numbers');
  /** @type {Record<string, any>} */
  const all = {};
  /** @type {Record<string, string>} */
  const from = {};
  let ok = true;
  for (const name of list(dir, (n) => n.endsWith('.json'))) {
    const rel = `site/data/numbers/${name}`, text = read(path.join(dir, name));
    let part;
    try { part = JSON.parse(text); } catch (e) { errors.push(`${rel}: not JSON (${/** @type {Error} */ (e).message})`); ok = false; continue; }
    const bad = checkNumbers(part);
    if (bad.length) { errors.push(...bad.map((m) => `${rel}: ${m}`)); ok = false; continue; }
    for (const key of repeatedKeys(text)) { errors.push(`${rel}: number "${key}" is defined twice in this file`); ok = false; }
    for (const [key, entry] of Object.entries(part)) {
      if (key in from) { errors.push(`number "${key}" is defined twice: in site/data/numbers/${from[key]} and in ${rel}`); ok = false; continue; }
      from[key] = name; all[key] = entry;
    }
  }
  if (!ok) return null;
  return Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
}

/**
 * Merge the Checks rows of all producers.
 * @param {string} root
 * @param {string[]} errors
 * @returns {any[] | null} null when the merge failed
 */
function mergeChecks(root, errors) {
  const dir = path.join(root, 'site', 'data', 'checks', 'rows');
  /** @type {any[]} */
  const all = [];
  /** @type {Record<string, string>} */
  const from = {};
  let ok = true;
  for (const name of list(dir, (n) => n.endsWith('.json'))) {
    const rel = `site/data/checks/rows/${name}`;
    let part;
    try { part = JSON.parse(read(path.join(dir, name))); } catch (e) { errors.push(`${rel}: not JSON (${/** @type {Error} */ (e).message})`); ok = false; continue; }
    const bad = checkChecks(part);
    if (bad.length) { errors.push(...bad.map((m) => `${rel}: ${m}`)); ok = false; continue; }
    for (const row of part) {
      if (row.id in from) { errors.push(`Checks row "${row.id}" is defined twice: in site/data/checks/rows/${from[row.id]} and in ${rel}`); ok = false; continue; }
      from[row.id] = name; all.push(row);
    }
  }
  return ok ? all : null;
}

/**
 * The picture of every Checks row: the file is there and is the file that was reviewed.
 * @param {string} root
 * @param {{id: string, image: string | null, image_sha256: string | null}[]} rows
 * @param {string[]} errors
 */
export function checkImages(root, rows, errors) {
  const dir = path.resolve(root, 'site', 'data', 'checks');
  for (const r of rows) {
    if (r.image === null) continue;
    const file = path.resolve(dir, r.image);
    if (file !== dir && !file.startsWith(dir + path.sep)) { errors.push(`Checks row "${r.id}": image "${r.image}" lies outside site/data/checks/`); continue; }
    if (!existsSync(file) || !statSync(file).isFile()) { errors.push(`Checks row "${r.id}": image "${r.image}" is missing (site/data/checks/${r.image})`); continue; }
    const have = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (have !== r.image_sha256) errors.push(`Checks row "${r.id}": image "${r.image}" hashes to ${have} but the row says ${r.image_sha256}; the file is not the one that was reviewed`);
  }
}

/**
 * Fill one page. Returns the page as it should be.
 * @param {string} html
 * @param {string} rel   the page's path, for the messages
 * @param {Record<string, any> | null} numbers
 * @param {string | null} siteName
 * @param {boolean} check   true: report what differs; false: report only what cannot be filled
 * @param {string[]} errors
 */
function fillPage(html, rel, numbers, siteName, check, errors) {
  let out = html;

  // numbers: <span data-n="key">text</span>
  const element = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*?\s)data-n="([^"]*)"([^<>]*)>([^<]*)<\/\1\s*>/g;
  let filled = 0;
  out = out.replace(element, (all, tag, before, key, after, text) => {
    filled++;
    if (tag.toLowerCase() !== 'span') { errors.push(`${rel}: number "${key}" sits in <${tag}>; a number goes in <span data-n="${key}">`); return all; }
    if (!numbers) return all;
    if (!Object.hasOwn(numbers, key)) { errors.push(`${rel}: number "${key}" is not in numbers.json`); return all; }
    const want = escapeHtml(setNumber(numbers[key].text));
    if (text !== want && check) errors.push(`${rel}: number "${key}" reads "${text}" on the page and "${want}" in numbers.json`);
    return `<${tag}${before}data-n="${key}"${after}>${want}</${tag}>`;
  });
  const marked = (html.match(/\bdata-n\s*=/g) ?? []).length;
  if (marked !== filled) errors.push(`${rel}: ${marked - filled} element(s) with data-n cannot be filled; write <span data-n="key"></span> with nothing but text inside`);

  // the name of the site
  if (siteName !== null) {
    const name = escapeHtml(siteName);
    const named = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^<>]*?\s)data-site="name"([^<>]*)>([^<]*)<\/\1\s*>/g;
    out = out.replace(named, (all, tag, before, after, text) => {
      if (text !== name && check) errors.push(`${rel}: the name reads "${text}" on the page and "${name}" in site.json`);
      return `<${tag}${before}data-site="name"${after}>${name}</${tag}>`;
    });
    out = out.replace(/<title\b([^<>]*?\s)data-page="([^"]*)"([^<>]*)>([^<]*)<\/title>/, (all, before, page, after, text) => {
      const want = page === '' ? name : `${page} · ${name}`;
      if (text !== want && check) errors.push(`${rel}: the title reads "${text}" and should read "${want}"`);
      return `<title${before}data-page="${page}"${after}>${want}</title>`;
    });
  }
  return out;
}

/**
 * Read the reference files of all producers and join them.
 * @param {string} root
 * @param {string[]} errors
 * @returns {{text: string, count: number} | null} null when a file is wrong
 */
function joinReferences(root, errors) {
  const dir = path.join(root, 'references');
  /** @type {Map<string, Map<string, {name: string, url: string, licence: string, uses: string[], from: string}>>} */
  const byHeading = new Map(REFERENCE_HEADINGS.map((h) => [h, new Map()]));
  let ok = true;
  for (const file of list(dir, (n) => n.endsWith('.md'))) {
    const rel = `references/${file}`;
    let heading = null;
    for (const [i, raw] of unix(read(path.join(dir, file))).split('\n').entries()) {
      const line = raw.trim(), at = `${rel}:${i + 1}`;
      if (line === '') continue;
      if (line.startsWith('## ')) {
        heading = line.slice(3).trim();
        if (!byHeading.has(heading)) { errors.push(`${at}: "${heading}" is not one of the headings: ${REFERENCE_HEADINGS.join(', ')}`); ok = false; heading = null; }
        continue;
      }
      if (!line.startsWith('- ')) { errors.push(`${at}: a line is a heading ("## ...") or an entry ("- name | address | licence | what it is used for")`); ok = false; continue; }
      if (heading === null) { errors.push(`${at}: an entry needs a heading above it`); ok = false; continue; }
      const parts = line.slice(2).split('|').map((s) => s.trim());
      if (parts.length !== 4 || parts.some((p) => p === '')) { errors.push(`${at}: an entry has four parts: name | address | licence | what it is used for`); ok = false; continue; }
      const [name, url, licence, use] = parts;
      if (!/^https?:\/\/\S+$/.test(url)) { errors.push(`${at}: "${url}" is not an address`); ok = false; continue; }
      const entries = /** @type {Map<string, any>} */ (byHeading.get(heading));
      const had = entries.get(url);
      if (!had) entries.set(url, { name, url, licence, uses: [use], from: rel });
      else if (had.name !== name || had.licence !== licence) { errors.push(`${at}: ${url} is also in ${had.from} with another name or licence`); ok = false; }
      else if (!had.uses.includes(use)) had.uses.push(use);
    }
  }
  if (!ok) return null;
  const lines = [...REFERENCES_INTRO];
  let count = 0;
  for (const heading of REFERENCE_HEADINGS) {
    const entries = [.../** @type {Map<string, any>} */ (byHeading.get(heading)).values()];
    if (!entries.length) continue;
    entries.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.url < b.url ? -1 : 1));
    lines.push('', `## ${heading}`, '', '| Name | Address | Licence | Used for |', '|---|---|---|---|');
    for (const e of entries) lines.push(`| ${e.name} | <${e.url}> | ${e.licence} | ${e.uses.join('; ')} |`);
    count += entries.length;
  }
  return { text: `${lines.join('\n')}\n`, count };
}

/**
 * Run the gate.
 * @param {{root: string, check?: boolean}} options
 * @returns {{errors: string[], wrote: string[], summary: string}}
 */
export function runGate({ root, check = false }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const wrote = [];

  /** @param {string} rel @param {string} text */
  const put = (rel, text) => {
    const file = path.join(root, rel);
    const disk = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (disk !== null && unix(disk) === unix(text)) return;
    if (check) { errors.push(`${rel}: ${disk === null ? 'is missing' : 'differs from what the gate writes'}; run "npm run gate"`); return; }
    write(file, text);
    wrote.push(rel);
  };

  // 1. merge
  const numbers = mergeNumbers(root, errors);
  const rows = mergeChecks(root, errors);
  if (numbers && rows) errors.push(...checkNumbersHaveChecks(numbers, rows));
  if (numbers) put('site/data/numbers.json', pretty(numbers));
  if (rows) put('site/data/checks/checks.json', pretty(rows));

  // 2. pages
  let siteName = null;
  const siteFile = path.join(root, 'site', 'data', 'site.json');
  try {
    siteName = JSON.parse(read(siteFile)).name;
    if (typeof siteName !== 'string' || siteName.trim() === '') { siteName = null; throw new Error('no name'); }
  } catch { errors.push('site/data/site.json: must be a JSON object with a "name"'); }
  const pages = walk(path.join(root, 'site'), ['.html']);
  for (const file of pages) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const html = readFileSync(file, 'utf8');
    const page = fillPage(html, rel, numbers, siteName, check, errors);
    if (page !== html && !check) { write(file, page); wrote.push(rel); }
  }

  // 3. the pictures of the Checks rows
  if (rows) checkImages(root, rows, errors);

  // 4. references
  const refs = joinReferences(root, errors);
  if (refs) put('REFERENCES.md', refs.text);

  // 5. the texts in content/, and the table of the review sheet
  if (numbers) {
    const content = renderContent({ root, numbers, rows: rows ?? [], references: refs ? refs.text : false, siteName });
    errors.push(...content.errors);
    for (const [rel, text] of Object.entries(content.files)) put(rel, text);
    if (existsSync(path.join(root, 'review', 'README.md'))) put('review/README.md', renderReviewReadme({ root, numbers, rows: rows ?? [] }));
  }

  const summary = `${numbers ? Object.keys(numbers).length : '?'} numbers, ${rows ? rows.length : '?'} Checks rows, ${pages.length} pages, ${refs ? refs.count : '?'} references`;
  return { errors, wrote, summary };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = path.resolve(at >= 0 ? args[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const check = args.includes('--check');
  const { errors, wrote, summary } = runGate({ root, check });
  for (const w of wrote) console.log(`gate: wrote ${w}`);
  for (const e of errors) console.error(`gate: ${e}`);
  if (errors.length) {
    console.error(`gate: ${errors.length} problem(s) (${summary})`);
    if (check) console.error('gate: "npm run gate" merges the parts and fills the pages; what it still reports has to be put right by hand');
    process.exit(1);
  }
  console.log(`gate: ${check ? 'nothing differs' : 'done'} (${summary})`);
}
