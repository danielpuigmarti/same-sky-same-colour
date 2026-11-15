// The match rule (CT-6): JavaScript against the Python vectors in tests/vectors/match.json, and the other way round:
// tests/vectors/match-from-js.json is made here from a seeded generator and checked by pipeline/tests/test_d2_vectors.py.
// Run with D2_WRITE=1 to write that file again after the rule changed on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchPairs, matchedMask, reachesBadRows } from '../../site/js/lib/match.js';

const here = (/** @type {string} */ f) => fileURLToPath(new URL(f, import.meta.url));
const vec = JSON.parse(readFileSync(here('../vectors/match.json'), 'utf8'));
const nan = (/** @type {any[]} */ xs) => xs.map((x) => x === null ? NaN : x);
const frames = (/** @type {any[]} */ l) => l.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v === null ? NaN : v])));

test('every case of the shared vectors gives the same pairs', () => {
  assert.ok(vec.cases.length >= 70);
  for (const c of vec.cases) assert.deepEqual(matchPairs(frames(c.a), frames(c.b)), c.expected, c.name);
});

test('every mask of the shared vectors is the same', () => {
  assert.ok(vec.masks.length >= 4);
  for (const c of vec.masks) {
    const maps = c.maps.map((/** @type {any} */ m) => ({ lamA: nan(m.lamA), bwA: nan(m.bwA), lamB: nan(m.lamB), bwB: nan(m.bwB) }));
    assert.deepEqual([...matchedMask(maps, c.n)], c.expected, c.name);
  }
});

test('the rows that are never used', () => {
  assert.equal(reachesBadRows(1, 149, 64), true);
  assert.equal(reachesBadRows(1, 150, 64), false);
  assert.equal(reachesBadRows(2, 1897, 64), false);
  assert.equal(reachesBadRows(2, 1898, 64), true);
  for (const d of [3, 4, 5, 6]) assert.equal(reachesBadRows(d, 0, 2040), false);
});

test('pairs are one to one, at the same colour, closest first, at most 8; the rule in words', () => {
  const a = [{ det: 2, lam: 1.0, bw: 0.02 }, { det: 2, lam: 1.5, bw: 0.03 }];
  const b = [{ det: 2, lam: 1.5049, bw: 0.03 }, { det: 2, lam: 1.0049, bw: 0.02 }, { det: 3, lam: 1.0, bw: 0.02 }];
  assert.deepEqual(matchPairs(a, b), [[0, 1], [1, 0]]);
  assert.deepEqual(matchPairs(a, [{ det: 2, lam: 1.0101, bw: 0.02 }]), []);
});

/** A seeded generator (mulberry32), so the file below is the same on every run. */
function prng(/** @type {number} */ seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function madeHere() {
  const rnd = prng(14112026);
  const round = (/** @type {number} */ x, /** @type {number} */ k) => Number(x.toFixed(k));
  const list = (/** @type {number[]} */ dets, /** @type {boolean} */ rows, /** @type {boolean} */ dense) => Array.from({ length: Math.floor(rnd() * 22) }, () => {
    const lam = dense ? round(1.2 + rnd() * 0.02, 4) : round(0.75 + rnd() * 4.25, 4);
    const m = { det: dets[Math.floor(rnd() * dets.length)], lam, bw: round(lam / (30 + rnd() * 90), 5) };
    return rows ? { ...m, y0: Math.floor(rnd() * 2000), h: 64 } : m;
  });
  const cases = [];
  for (let i = 0; i < 60; i++) {
    const rows = i % 4 === 0;
    const dense = i % 5 === 1;
    const a = list(i % 3 === 0 ? [1, 2] : [3, 4, 5, 6], rows, dense), b = list(i % 3 === 0 ? [1, 2] : [3, 4, 5, 6], rows, dense);
    cases.push({ name: `random ${i}`, a, b, expected: matchPairs(a, b) });
  }
  const masks = [];
  for (let i = 0; i < 4; i++) {
    const n = 50 + i * 30, maps = [];
    for (let p = 0; p < 1 + i; p++) {
      const lamA = Array.from({ length: n }, () => round(1 + rnd(), 5));
      maps.push({ lamA, bwA: lamA.map((l) => round(l / 40, 6)), lamB: lamA.map((l) => round(l + (rnd() - 0.5) * 0.06, 5)), bwB: lamA.map((l) => round(l / 41, 6)) });
    }
    masks.push({ name: `random mask ${i}`, n, maps, expected: [...matchedMask(maps, n)] });
  }
  return { about: 'Written by tests/unit/d2-match.test.mjs from a seeded generator; pipeline/tests/test_d2_vectors.py checks Python against it.', cases, masks };
}

test('vectors made here are the committed ones (D2_WRITE=1 writes them), and Python checks them', () => {
  const file = here('../vectors/match-from-js.json');
  const text = `${JSON.stringify(madeHere())}\n`;
  if (process.env.D2_WRITE === '1' || !existsSync(file)) writeFileSync(file, text);
  assert.equal(readFileSync(file, 'utf8'), text);
  const made = JSON.parse(text);
  assert.ok(made.cases.some((/** @type {{expected: unknown[]}} */ c) => c.expected.length === 8));
});
