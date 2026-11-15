// The co-add of one visit: the mean of the photos that may be used at each pixel, shown where half of them saw it.
// JavaScript against the Python numbers in tests/vectors/stack.json (the "coadd" cases, which include eight photos
// with different empty corners and scattered flags), and a case of three photos whose answer is written by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coadd, difference, resampleCoadd, usableMask } from '../../site/js/lib/stack.js';
import { FLAG_TABLE, SATURATION_MASK, DEFECT_MASK } from '../../site/js/lib/flags.js';

const vec = JSON.parse(readFileSync(new URL('../vectors/stack.json', import.meta.url), 'utf8'));
const nan = (/** @type {(number | null)[]} */ xs) => Float32Array.from(xs, (x) => (x === null ? NaN : x));
const unb64 = (/** @type {string} */ s, /** @type {'f4' | 'u1'} */ type) => {
  const b = Buffer.from(s, 'base64');
  return type === 'f4' ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) : new Uint8Array(b);
};
const close = (/** @type {ArrayLike<number>} */ got, /** @type {ArrayLike<number>} */ want, /** @type {string} */ what) => {
  assert.equal(got.length, want.length, what);
  for (let i = 0; i < want.length; i++) {
    if (Number.isNaN(want[i])) { assert.ok(Number.isNaN(got[i]), `${what}[${i}] want NaN, got ${got[i]}`); continue; }
    assert.ok(Math.abs(got[i] - want[i]) <= 1e-6 * Math.max(Math.abs(got[i]), Math.abs(want[i])) + 1e-9, `${what}[${i}]: ${got[i]} against ${want[i]}`);
  }
};

test('the bits that exclude a pixel are exactly the saturation and defect tiers', () => {
  const bad = FLAG_TABLE.filter((r) => r.tier === 'saturation' || r.tier === 'defect').map((r) => r.bit).sort((a, b) => a - b);
  assert.deepEqual(bad, [0, 1, 2, 6, 9, 10, 11, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28]);
  const word = (/** @type {number[]} */ bits) => Int32Array.of(bits.reduce((w, b) => w | (1 << b), 0));
  const one = Float32Array.of(1);
  for (const b of bad) assert.equal(usableMask(one, word([b]))[0], 0, `bit ${b}`);
  for (const b of [7, 12, 14, 21]) assert.equal(usableMask(one, word([b]))[0], 1, `bit ${b}`);
  assert.equal(usableMask(Float32Array.of(NaN), word([12]))[0], 0);
  assert.equal(usableMask(one, null)[0], 1);
  assert.equal((SATURATION_MASK | DEFECT_MASK) & (1 << 21 | 1 << 12 | 1 << 7 | 1 << 14), 0);
});

test('co-add cases written by Python', () => {
  assert.ok(vec.coadd.length >= 7);
  for (const c of vec.coadd) {
    const k = c.data.length;
    const stamps = Array.from({ length: k }, (_, i) => ({ data: nan(c.data[i]), flags: c.flags === null ? null : Int32Array.from(c.flags[i]) }));
    const co = coadd(stamps, c.w, c.h), want = c.expected;
    assert.equal(co.photos, want.photos, c.name);
    assert.equal(co.need, want.need, c.name);
    assert.equal(co.dropped, want.dropped, c.name);
    assert.equal(co.basis, want.basis, c.name);
    assert.deepEqual([...co.n], [...unb64(want.n, 'u1')], `${c.name}: n`);
    assert.deepEqual([...co.valid], [...unb64(want.valid, 'u1')], `${c.name}: shown`);
    assert.deepEqual([...co.quiet], [...unb64(want.quiet, 'u1')], `${c.name}: quiet`);
    close(co.data, unb64(want.data, 'f4'), `${c.name}: data`);
    close(co.background, want.background, `${c.name}: backgrounds`);
    close([co.noise], [want.noise === null ? NaN : want.noise], `${c.name}: noise`);
  }
  const eight = vec.coadd.find((/** @type {{name: string}} */ c) => c.name.startsWith('eight photos'));
  assert.equal(eight.expected.photos, 8);
  assert.equal(eight.expected.need, 4);
});

test('three photos written by hand: 12 by 12, the corner block of 4 by 4 is the case', () => {
  const full = 1 << 12, mk = (/** @type {number} */ v) => new Float32Array(144).fill(0).map((_, i) => ((i % 12) < 4 && Math.floor(i / 12) < 4 ? v : 0));
  const A = mk(1), B = mk(2), C = mk(4);
  const fa = new Int32Array(144).fill(full), fb = new Int32Array(144).fill(full), fc = new Int32Array(144).fill(full);
  // pixel p of the block is at (p % 4) + 12 * floor(p / 4)
  const at = (/** @type {number} */ p) => (p % 4) + 12 * Math.floor(p / 4);
  fa[at(0)] |= 1 << 7; fa[at(1)] |= 1 << 14; fa[at(2)] |= 1 << 21; fa[at(3)] |= 1 << 10; fa[at(4)] |= 1 << 1; A[at(5)] = NaN;
  fb[at(3)] |= 1 << 10; fb[at(4)] |= 1 << 15; fb[at(6)] |= 1 << 25;
  fc[at(3)] |= 1 << 10; fc[at(6)] |= 1 << 22; C[at(7)] = NaN;
  const co = coadd([{ data: A, flags: fa }, { data: B, flags: fb }, { data: C, flags: fc }], 12, 12);
  assert.deepEqual(co.background, [0, 0, 0]);
  assert.equal(co.need, 2);
  assert.equal(co.photos, 3);
  const third = 7 / 3;
  // [n, value or NaN, quiet] for the 16 pixels of the block
  const want = [
    [3, third, 0], [3, third, 0], [3, third, 0], [0, NaN, 0],
    [1, NaN, 0], [2, 3, 1], [1, NaN, 0], [2, 1.5, 1],
    [3, third, 1], [3, third, 1], [3, third, 1], [3, third, 1],
    [3, third, 1], [3, third, 1], [3, third, 1], [3, third, 1],
  ];
  want.forEach(([n, v, q], p) => {
    const i = at(p);
    assert.equal(co.n[i], n, `pixel ${p}: n`);
    assert.equal(co.valid[i], n >= 2 ? 1 : 0, `pixel ${p}: shown`);
    assert.equal(co.quiet[i], q, `pixel ${p}: quiet`);
    if (Number.isNaN(v)) assert.ok(Number.isNaN(co.data[i]), `pixel ${p}`);
    else assert.ok(Math.abs(co.data[i] - v) < 1e-6, `pixel ${p}: ${co.data[i]} against ${v}`);
  });
  // outside the block all three photos are 0 and unflagged
  assert.equal(co.n[5 * 12 + 5], 3);
  assert.equal(co.data[5 * 12 + 5], 0);
});

test('two co-adds are compared only where both show the pixel', () => {
  const rows = 12, flat = (/** @type {number} */ v) => new Float32Array(rows * rows).map((_, i) => (i % 5 === 0 ? v + 0.01 : v));
  const ok = new Int32Array(rows * rows).fill(1 << 12), hot = ok.slice();
  for (let i = 0; i < 12; i++) hot[i] |= 1 << 10;
  const a = coadd([{ data: flat(1), flags: ok }], rows, rows);
  const b = coadd([{ data: flat(2), flags: hot }], rows, rows);
  assert.equal(b.valid.slice(0, 12).some((v) => v), false);
  assert.equal(a.valid.every((v) => v === 1), true);
  const d = difference(a, b);
  for (let i = 0; i < 144; i++) assert.equal(d.valid[i], i < 12 ? 0 : 1, `pixel ${i}`);
  assert.ok(Number.isNaN(d.diff[0]) && Number.isFinite(d.diff[50]));
  const m = Float64Array.from({ length: 144 }, (_, i) => i % 12), mm = Float64Array.from({ length: 144 }, (_, i) => Math.floor(i / 12));
  const r = resampleCoadd(b, m, mm, 12, 12);
  assert.equal(r.need, 1);
  assert.equal(r.n[50], 1);
  assert.equal(r.n[0], 0);
});
