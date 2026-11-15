// The shared contracts: site/js/contracts.js against the one list in tests/vectors/contracts.json, the schemas
// against the same list, and the checks of the three JSON contracts against the fixture files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as C from '../../site/js/contracts.js';
import { validate } from '../../tools/schema.mjs';
import { checkNumbers, checkChecks, checkManifest, checkShowcase, checkNumbersHaveChecks, loadSchema } from '../../tools/contracts.mjs';
import { readJson, fixturePath } from '../helpers/fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** @param {string} rel */
const json = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const list = json('tests/vectors/contracts.json');
const source = readFileSync(path.join(ROOT, 'site/js/contracts.js'), 'utf8');

/** The typedefs of contracts.js: name -> its fields in order (records), or null (any other type). */
function typedefs() {
  /** @type {Record<string, string[] | null>} */
  const out = {};
  for (const [, block] of source.matchAll(/\/\*\*([\s\S]*?)\*\//g)) {
    const m = /@typedef\s+\{([\s\S]*?)\}\s+([A-Za-z0-9_]+)\s*$/m.exec(block);
    if (!m) continue;
    out[m[2]] = m[1].trim() === 'Object'
      ? [...block.matchAll(/@property\s+\{.*\}\s+\[?([A-Za-z0-9_]+)\]?/g)].map((p) => p[1])
      : null;
  }
  return out;
}

test('contracts.js exports the constants of the list, and no other', () => {
  assert.deepEqual(Object.keys(C).sort(), Object.keys(list.constants).sort());
  for (const [name, want] of Object.entries(list.constants)) {
    const got = /** @type {Record<string, unknown>} */ (C)[name];
    assert.deepEqual(got instanceof RegExp ? got.source : Array.isArray(got) ? [...got] : got, want, name);
  }
});

test('contracts.js declares the types of the list, with the same fields in the same order', () => {
  const found = typedefs();
  assert.deepEqual(Object.keys(found).sort(), [...Object.keys(list.records), ...list.others].sort());
  for (const [name, fields] of Object.entries(list.records)) assert.deepEqual(found[name], fields, name);
  for (const name of list.others) assert.equal(found[name], null, `${name} is not a record`);
});

test('the schemas hold the fields of the contracts, all required, in the same order', () => {
  const numbers = loadSchema('numbers'), checks = loadSchema('checks'), manifest = loadSchema('manifest');
  for (const [schema, record] of [
    [numbers.$defs.entry, 'NumberEntry'],
    [checks.$defs.row, 'CheckRow'],
    [manifest, 'Manifest'],
    [manifest.$defs.frame, 'ShowcaseFrame'],
  ]) {
    const optional = list.optional?.[record] ?? [];
    assert.deepEqual(schema.required, list.records[record].filter((/** @type {string} */ f) => !optional.includes(f)), `${record}: required`);
    assert.deepEqual(Object.keys(schema.properties), list.records[record], `${record}: properties`);
    assert.equal(schema.additionalProperties, false, `${record}: no other fields`);
  }
  assert.deepEqual(checks.$defs.row.properties.status.enum, list.constants.CHECK_STATUSES);
  assert.equal(manifest.properties.stamps.const, list.constants.STAMPS_FILE);
  assert.deepEqual(manifest.properties.flags.enum, [list.constants.FLAGS_FILE, null]);
});

test('KEY_REGEX takes real keys apart and KEY_PATTERN puts them together again', () => {
  const keys = readJson('idx', 'expected.json').frames.map((/** @type {{key: string}} */ f) => f.key);
  assert.equal(keys.length, 342);
  for (const key of keys) {
    const m = C.KEY_REGEX.exec(key);
    assert.ok(m, key);
    const [, week, ver, det, obs, exp] = m;
    const built = C.KEY_PATTERN
      .replaceAll('{week}', week).replaceAll('{ver}', ver).replaceAll('{det}', det)
      .replace('{obs:04d}', String(Number(obs)).padStart(4, '0')).replace('{exp}', exp);
    assert.equal(built, key);
  }
  const key = keys[0], det = /** @type {RegExpExecArray} */ (C.KEY_REGEX.exec(key))[3];
  const wrong = [
    '', 'level2.fits', `${key}\n`, ` ${key}`,
    key.replace('dr1', 'dr2'),
    key.replace(`/${det}/level2_`, '/7/level2_'), // no detector 7
    key.replace(`/${det}/level2_`, `/${det === '1' ? '2' : '1'}/level2_`), // folder and file name disagree
    key.replace('_spx_', '_spx_x'), // version in the folder and in the file name disagree
    key.replace(/_(\d{4})_(\d)D/, '_$1$2_$2D'), // five digits
  ];
  assert.equal(new Set(wrong).size, wrong.length);
  for (const bad of wrong) {
    assert.notEqual(bad, key);
    assert.equal(C.KEY_REGEX.test(bad), false, JSON.stringify(bad));
  }
});

test('the index fixture states the same key pattern and row layout', () => {
  const meta = readJson('idx', 'meta.json');
  assert.equal(meta.key, C.KEY_PATTERN);
  assert.equal(meta.row, `[${C.INDEX_ROW.join(', ')}]`);
  assert.deepEqual(Object.keys(meta), list.records.IndexMeta);
  assert.ok(existsSync(fixturePath('idx', C.INDEX_META_FILE)));
  assert.ok(existsSync(fixturePath('idx', C.INDEX_TILE_FILE.replace('{tile}', readJson('idx', 'expected.json').tile))));
});

test('the address forms of the bucket belong to its two hostnames', () => {
  assert.deepEqual(C.BUCKET_URLS.map((u) => new URL(u).host), [...C.BUCKET_HOSTS]);
  for (const u of C.BUCKET_URLS) assert.ok(u.startsWith('https://') && u.endsWith('/'));
});

/** @param {any} doc @param {any[]} ops */
function apply(doc, ops) {
  let out = structuredClone(doc);
  for (const [op, at, value] of ops) {
    if (at.length === 0) { out = structuredClone(value); continue; }
    let o = out;
    for (const k of at.slice(0, -1)) o = o[k];
    if (op === 'set') o[at.at(-1)] = structuredClone(value);
    else if (op === 'del') delete o[at.at(-1)];
    else throw new Error(`unknown step ${op}`);
  }
  return out;
}

test('the checks of the three JSON contracts agree with every case', () => {
  const cases = json('tests/vectors/contract-cases.json');
  const check = { numbers: checkNumbers, checks: checkChecks, manifest: checkManifest };
  const seen = { numbers: [0, 0], checks: [0, 0], manifest: [0, 0] };
  for (const c of cases.cases) {
    const kind = /** @type {'numbers' | 'checks' | 'manifest'} */ (c.kind);
    const doc = apply(json(`tests/${cases.bases[kind]}`), c.ops);
    const problems = check[kind](doc);
    assert.equal(problems.length === 0, c.valid, `${kind}: ${c.name}: ${problems.join('; ') || 'no problem found'}`);
    seen[kind][c.valid ? 0 : 1]++;
  }
  for (const [kind, [good, bad]] of Object.entries(seen)) assert.ok(good >= 2 && bad >= 5, `${kind}: ${good} valid and ${bad} invalid cases`);
});

test('the fixture files of the three contracts are valid', () => {
  const numbers = readJson('contracts', 'numbers.json'), rows = readJson('contracts', 'checks.json');
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(checkChecks(rows), []);
  assert.deepEqual(checkNumbersHaveChecks(numbers, rows), []);
  assert.deepEqual(checkNumbersHaveChecks({ x: { check: 'nowhere' } }, rows), ['number "x": there is no Checks row "nowhere"']);
  for (const id of readdirSync(fixturePath('showcase'))) assert.deepEqual(checkShowcase(fixturePath('showcase', id)), [], id);
});

test('a showcase with a binary file of the wrong size is refused', () => {
  const manifest = readJson('showcase', 'barnard-d5', 'manifest.json');
  const bytes = manifest.frames.length * manifest.w * manifest.h * 4;
  assert.deepEqual(checkManifest(manifest, { stamps: bytes, flags: bytes }), []);
  assert.equal(checkManifest(manifest, { stamps: bytes - 4, flags: bytes }).length, 1);
  assert.equal(checkManifest(manifest, { stamps: bytes, flags: 0 }).length, 1);
  assert.equal(checkShowcase(fixturePath('showcase', 'nowhere')).length, 1);
});

test('the data of the site is valid', () => {
  const numbers = json('site/data/numbers.json'), rows = json('site/data/checks/checks.json');
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(checkChecks(rows), []);
  assert.deepEqual(checkNumbersHaveChecks(numbers, rows), []);
  assert.equal(typeof json('site/data/site.json').name, 'string');
});

test('the wavelength tables of the site have the form of CT-3 and agree with the fixture', () => {
  const site = json(`site/${C.WAVE_TABLES_FILE}`), fixture = readJson('wave', 'tables.json');
  assert.deepEqual(Object.keys(site), ['1', '2', '3', '4', '5', '6']);
  for (const det of Object.keys(site)) {
    const t = site[det], f = fixture[det];
    assert.deepEqual(Object.keys(t), list.records.WaveTable, `detector ${det}`);
    assert.deepEqual(t.X, f.X);
    assert.deepEqual(t.Y, f.Y);
    for (const plane of ['lam', 'bw']) {
      assert.equal(t[plane].length, t.Y.length);
      for (const [i, row] of t[plane].entries()) {
        assert.equal(row.length, t.X.length);
        for (const [j, v] of row.entries()) assert.ok(Math.abs(v - f[plane][i][j]) < 1e-7, `detector ${det} ${plane}[${i}][${j}]`);
      }
    }
    assert.match(t.src, C.KEY_REGEX);
  }
});

test('the schema checker refuses a keyword it does not know', () => {
  assert.throws(() => validate(1, { type: 'number', multipleOf: 2 }), /not supported/);
  assert.throws(() => validate(1, { $ref: 'other.json' }), /not supported/);
  assert.deepEqual(validate(1, { type: 'number' }), []);
  assert.equal(validate(true, { type: 'number' }).length, 1);
  assert.equal(validate(1.5, { type: 'integer' }).length, 1);
  assert.equal(validate(null, { type: ['string', 'null'], minLength: 1 }).length, 0);
});
