// Checks for the three JSON contracts: numbers.json (CT-10), checks.json (CT-9) and a showcase manifest (CT-8).
// Each check returns a list of messages; an empty list means the data is valid.
// The shape comes from the schemas in tests/vectors/schema/; the rules a schema cannot say are written here.
// pipeline/sx/contracts.py holds the same checks in Python.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validate } from './schema.mjs';

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'vectors', 'schema');

/** @param {'numbers' | 'checks' | 'manifest'} name */
export function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, `${name}.schema.json`), 'utf8'));
}

/**
 * numbers.json, or one of the files it is merged from.
 * @param {unknown} numbers
 * @returns {string[]}
 */
export function checkNumbers(numbers) {
  return validate(numbers, loadSchema('numbers'));
}

/**
 * checks.json, or one of the files it is merged from.
 * Beyond the schema: ids are unique; a PASS row names the reviewer's role and the date of the review;
 * a row has a picture and its SHA-256 together, or neither.
 * @param {unknown} rows
 * @returns {string[]}
 */
export function checkChecks(rows) {
  const out = validate(rows, loadSchema('checks'));
  if (out.length || !Array.isArray(rows)) return out;
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    const at = `$[${i}] (${r.id})`;
    if (seen.has(r.id)) out.push(`${at}: id is used twice`);
    seen.add(r.id);
    if (r.status === 'PASS' && (r.reviewer_role === null || r.reviewed_on === null)) {
      out.push(`${at}: a PASS row needs reviewer_role and reviewed_on`);
    }
    if ((r.image === null) !== (r.image_sha256 === null)) out.push(`${at}: image and image_sha256 go together`);
  }
  return out;
}

/**
 * Every number that names a check names one that exists.
 * @param {Record<string, {check: string | null}>} numbers
 * @param {{id: string}[]} rows
 * @returns {string[]}
 */
export function checkNumbersHaveChecks(numbers, rows) {
  const ids = new Set(rows.map((r) => r.id));
  return Object.entries(numbers)
    .filter(([, n]) => n.check !== null && !ids.has(n.check))
    .map(([key, n]) => `number "${key}": there is no Checks row "${n.check}"`);
}

/**
 * A showcase manifest.
 * Beyond the schema: frames are sorted by mjd; visits count up from 0 without a gap; a pair names two different
 * frames, the first in an earlier visit; no frame is in two pairs; the binary files, when their sizes are given,
 * hold exactly frames * w * h values of four bytes.
 * @param {unknown} manifest
 * @param {{stamps?: number, flags?: number}} [bytes] sizes of the binary files in bytes
 * @returns {string[]}
 */
export function checkManifest(manifest, bytes = {}) {
  const out = validate(manifest, loadSchema('manifest'));
  if (out.length) return out;
  const m = /** @type {any} */ (manifest);
  const n = m.frames.length;
  for (let i = 1; i < n; i++) {
    if (m.frames[i].mjd < m.frames[i - 1].mjd) out.push(`$.frames[${i}]: frames are not sorted by mjd`);
    const step = m.frames[i].visit - m.frames[i - 1].visit;
    if (step !== 0 && step !== 1) out.push(`$.frames[${i}]: visit goes from ${m.frames[i - 1].visit} to ${m.frames[i].visit}`);
  }
  if (m.frames[0].visit !== 0) out.push('$.frames[0]: the first visit is 0');
  const used = new Set();
  for (const [k, [i, j]] of m.pairs.entries()) {
    const at = `$.pairs[${k}]`;
    if (i >= n || j >= n) { out.push(`${at}: there is no frame ${Math.max(i, j)}`); continue; }
    if (!(m.frames[i].visit < m.frames[j].visit)) out.push(`${at}: the first frame must be in an earlier visit than the second`);
    for (const f of [i, j]) {
      if (used.has(f)) out.push(`${at}: frame ${f} is in two pairs`);
      used.add(f);
    }
  }
  const want = n * m.w * m.h * 4;
  if (bytes.stamps !== undefined && bytes.stamps !== want) out.push(`stamps.bin: ${bytes.stamps} bytes, expected ${want}`);
  if (m.flags !== null && bytes.flags !== undefined && bytes.flags !== want) out.push(`flags.bin: ${bytes.flags} bytes, expected ${want}`);
  return out;
}

/**
 * A showcase folder: manifest.json with its binary files beside it.
 * @param {string} dir
 * @returns {string[]}
 */
export function checkShowcase(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return [`${file}: missing`];
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  /** @param {string} name */
  const size = (name) => (existsSync(path.join(dir, name)) ? statSync(path.join(dir, name)).size : -1);
  const out = checkManifest(manifest, {
    stamps: size('stamps.bin'),
    flags: manifest.flags === null ? undefined : size('flags.bin'),
  });
  if (manifest.id !== path.basename(dir)) out.push(`$.id: "${manifest.id}" is not the folder name "${path.basename(dir)}"`);
  return out;
}
