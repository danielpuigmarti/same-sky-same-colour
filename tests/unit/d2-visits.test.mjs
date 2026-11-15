// The visit rule (CT-5): JavaScript against the output of the Python rule in tests/vectors/visits.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { visits, defaultPair } from '../../site/js/lib/visits.js';
import { readJson } from '../helpers/fixtures.mjs';

const vec = JSON.parse(readFileSync(new URL('../vectors/visits.json', import.meta.url), 'utf8'));
const tile = readJson('idx', 'expected.json').frames;

test('every case of the shared vectors gives the same visits, the same short flags and the same default pair', () => {
  assert.ok(vec.cases.length >= 25);
  for (const c of vec.cases) {
    const frames = c.fixture ? tile : c.frames;
    const vs = visits(frames, c.det);
    assert.deepEqual(vs.map((v) => ({ keys: v.frames.map((f) => f.key), short: v.short })), c.expected.visits, c.name);
    assert.deepEqual(defaultPair(vs), c.expected.pair, c.name);
  }
});

test('an ecliptic-pole run of more than 60 days is cut into 30-day bins from its first frame', () => {
  const c = vec.cases.find((/** @type {{name: string}} */ x) => x.name === 'ecliptic pole, run of 208 days');
  const vs = visits(c.frames, 4);
  assert.ok(c.frames.at(-1).tmid - c.frames[0].tmid > 60);
  assert.equal(vs.length, 7);
  const t0 = vs[0].frames[0].tmid;
  vs.forEach((v) => v.frames.forEach((f) => assert.equal(Math.floor((f.tmid - t0) / 30), Math.floor((v.frames[0].tmid - t0) / 30))));
  assert.equal(vs.reduce((n, v) => n + v.frames.length, 0), 140);
});

test('the frames of a visit are sorted, a gap of exactly 10 days does not split, a gap above it does', () => {
  const mk = (/** @type {number[]} */ ts) => ts.map((t, i) => ({ key: `k${i}`, det: 2, tmid: 60000 + t, corners: /** @type {any} */ ([]) }));
  assert.equal(visits(mk([0, 10, 20])).length, 1);
  assert.equal(visits(mk([0, 10.0001, 20])).length, 2);
  assert.deepEqual(visits(mk([5, 0, 3]))[0].frames.map((f) => f.key), ['k1', 'k2', 'k0']);
  assert.deepEqual(visits([]), []);
  assert.deepEqual(defaultPair([]), null);
});

test('the fixture tile at 330.84 -56.79: visits per detector, short ones marked', () => {
  const counts = [1, 2, 3, 4, 5, 6].map((d) => visits(tile, d).map((v) => v.frames.length));
  assert.deepEqual(counts[3], [4, 19, 4, 19]);
  assert.deepEqual(counts[2], [24, 1, 3, 19, 4, 12]);
  assert.equal(visits(tile, 3)[1].short, true);
  assert.equal(visits(tile, 3)[2].short, false);
  assert.deepEqual(defaultPair(visits(tile, 4)), [1, 3]);
});
