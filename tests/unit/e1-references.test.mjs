// Everything the project uses is in REFERENCES.md: the packages it depends on, the actions its workflows run, every
// host its code talks to or links to, every font and every file kept from outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '');

/** Hosts that appear in the code without being a source: the machine itself, and the name of an XML dialect. */
const NOT_SOURCES = new Set(['localhost', '127.0.0.1', 'www.w3.org', 'danielpuigmarti.github.io']);

/**
 * @param {string} dir  a folder, relative to the project
 * @param {string[]} ext
 * @param {string[]} skip names of folders that are not walked
 * @returns {string[]} the paths, relative to the project, with forward slashes
 */
function walk(dir, ext, skip) {
  const base = path.join(ROOT, dir);
  if (!existsSync(base)) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(base).sort()) {
    if (skip.includes(name)) continue;
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel, ext, skip));
    else if (ext.some((e) => name.endsWith(e))) out.push(rel);
  }
  return out;
}

/** The files of the code: the site (not its data), the pipeline (not its tests, data or environment), the tools, the workflows. */
const CODE = [
  ...walk('site', ['.js', '.html', '.css', '.svg'], ['data', 'idx']),
  ...walk('pipeline', ['.py'], ['.venv', '__pycache__', 'tests', 'frozen']),
  ...walk('tools', ['.mjs'], []),
  ...walk('.github', ['.yml'], []),
];

const REFERENCES = read('REFERENCES.md');
const TEXT = REFERENCES.toLowerCase();
const REF_HOSTS = [...REFERENCES.matchAll(/<https?:\/\/([^/>\s]+)/g)].map((m) => m[1].toLowerCase());

/** @param {string} host @returns {boolean} whether an address in REFERENCES.md is on that host, or on a host it belongs to */
function listed(host) {
  return REF_HOSTS.some((r) => r === host || host.endsWith(`.${r}`) || (host.split('.').length >= 3 && r.endsWith(`.${host}`)));
}

test('REFERENCES.md is there and has entries', () => {
  assert.ok(REF_HOSTS.length > 10, `only ${REF_HOSTS.length} addresses in REFERENCES.md`);
});

test('every package the project depends on is in REFERENCES.md', () => {
  const pkg = JSON.parse(read('package.json'));
  const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const python = read('pipeline/requirements.txt').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.split(/[=<>~!\[; ]/)[0]);
  assert.ok(names.length >= 2 && python.length >= 6, 'the lists of packages were not read');
  const missing = [...names, ...python].filter((n) => !TEXT.includes(n.toLowerCase().replace(/^@[^/]+\//, '').replace(/\/.*$/, '')));
  assert.deepEqual(missing, [], `packages that REFERENCES.md does not name: ${missing.join(', ')}`);
});

test('every action a workflow runs is in REFERENCES.md', () => {
  const used = new Set();
  for (const file of walk('.github', ['.yml'], [])) for (const m of read(file).matchAll(/\buses:\s*([\w.-]+\/[\w./-]+)@/g)) used.add(m[1]);
  assert.ok(used.size > 0);
  const missing = [...used].filter((a) => !TEXT.includes(`github.com/${a.toLowerCase()}`) && !TEXT.includes(a.toLowerCase()));
  assert.deepEqual(missing, [], `actions that REFERENCES.md does not name: ${missing.join(', ')}`);
});

test('every host that appears in the code is in REFERENCES.md', () => {
  /** @type {Map<string, Set<string>>} */
  const hosts = new Map();
  for (const file of CODE) {
    for (const m of read(file).matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
      const host = m[1].replace(/\.$/, '').toLowerCase();
      if (NOT_SOURCES.has(host)) continue;
      if (!hosts.has(host)) hosts.set(host, new Set());
      /** @type {Set<string>} */ (hosts.get(host)).add(file);
    }
  }
  assert.ok(hosts.size >= 5, 'no hosts were found: the code was not read');
  const missing = [...hosts].filter(([h]) => !listed(h)).map(([h, f]) => `${h} (in ${[...f].slice(0, 2).join(', ')})`);
  assert.deepEqual(missing, [], `hosts that REFERENCES.md does not cover:\n${missing.join('\n')}`);
});

test('every font, vendored script and image kept in the site is named in REFERENCES.md', () => {
  const kept = [
    ...walk('site', ['.woff', '.woff2', '.ttf', '.otf'], ['idx']),
    ...walk('site/js/vendor', ['.js', '.mjs'], []),
    ...walk('site/vendor', ['.js', '.mjs', '.css'], []),
    ...walk('site/img', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'], []),
  ];
  const missing = kept.filter((f) => !TEXT.includes(path.basename(f).toLowerCase()) && !TEXT.includes(path.basename(f, path.extname(f)).toLowerCase()));
  assert.deepEqual(missing, [], `files that REFERENCES.md does not name: ${missing.join(', ')}`);
  const css = walk('site/css', ['.css'], []).map(read).join('\n');
  const faces = [...css.matchAll(/@font-face\s*{[^}]*font-family:\s*["']?([^;"'}]+)/g)].map((m) => m[1].trim().toLowerCase());
  assert.deepEqual(faces.filter((f) => !TEXT.includes(f)), [], 'a font family that REFERENCES.md does not name');
  assert.doesNotMatch(css, /url\(\s*["']?https?:/, 'a stylesheet loads something from another host');
});
