// SHA-256 of the fixture files described in tests/fixtures/README.md, kept in tests/fixtures/checksums.json and
// checked by the unit tests.
//   node tests/helpers/checksums.mjs           print the checksums of the files on disk
//   node tests/helpers/checksums.mjs --write   write those of the recorded folders to tests/fixtures/checksums.json
// Only run with --write after a fixture was changed on purpose; say why in tests/fixtures/README.md.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FIXTURES } from './fixtures.mjs';

/** Files that are not fixtures themselves. */
const SKIP = new Set(['README.md', 'checksums.json']);

/** The folders whose files are recorded. Fixtures kept in other folders are not part of the list. */
export const RECORDED = ['contracts/', 'frames/', 'idx/', 'showcase/barnard-d5/', 'wave/'];

/** @param {string} dir @param {string} [prefix] @returns {string[]} paths relative to the fixtures folder, sorted */
function files(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(path.join(dir, name)).isDirectory()) out.push(...files(path.join(dir, name), rel));
    else if (!SKIP.has(rel)) out.push(rel);
  }
  return out;
}

/** @returns {Record<string, {bytes: number, sha256: string}>} */
export function computeChecksums() {
  /** @type {Record<string, {bytes: number, sha256: string}>} */
  const out = {};
  for (const rel of files(FIXTURES)) {
    const b = readFileSync(path.join(FIXTURES, rel));
    out[rel] = { bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = computeChecksums();
  const recorded = Object.fromEntries(Object.entries(all).filter(([rel]) => RECORDED.some((f) => rel.startsWith(f))));
  if (process.argv.includes('--write')) writeFileSync(path.join(FIXTURES, 'checksums.json'), `${JSON.stringify(recorded, null, 1)}\n`);
  else process.stdout.write(`${JSON.stringify(all, null, 1)}\n`);
}
