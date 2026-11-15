// Background, noise, co-add, resampling and difference (CT-7): JavaScript against the Python numbers in
// tests/vectors/stack.json, on small made-up arrays and on the real stamps of tests/fixtures/ (the empty field in
// d2/empty, Barnard's Star in showcase/barnard-d5). Agreement is required within 1e-6 relative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FLAG_FULLSAMPLE, FLAG_SOURCE, MIN_PIXELS, clippedMedian, robustNoise, stampStats, quietMask, validMask, usableMask,
  coadd, affineMap, resample, resampleCoadd, difference,
} from '../../site/js/lib/stack.js';
import { SATURATION_MASK, DEFECT_MASK } from '../../site/js/lib/flags.js';
import { readJson, readFloat32, readInt32 } from '../helpers/fixtures.mjs';

const vec = JSON.parse(readFileSync(new URL('../vectors/stack.json', import.meta.url), 'utf8'));
const REL = 1e-6;
const nan = (/** @type {(number | null)[]} */ xs) => Float64Array.from(xs, (x) => (x === null ? NaN : x));

/** Equal within 1e-6 relative to the larger of the two (and 1e-9 of the largest value, for values near zero). */
function close(/** @type {ArrayLike<number>} */ got, /** @type {ArrayLike<number>} */ want, /** @type {string} */ what) {
  assert.equal(got.length, want.length, `${what}: length`);
  let scale = 0;
  for (let i = 0; i < want.length; i++) if (Number.isFinite(want[i])) scale = Math.max(scale, Math.abs(want[i]));
  for (let i = 0; i < want.length; i++) {
    if (Number.isNaN(want[i])) { assert.ok(Number.isNaN(got[i]), `${what}[${i}]: want NaN, got ${got[i]}`); continue; }
    const tol = REL * Math.max(Math.abs(got[i]), Math.abs(want[i])) + 1e-9 * scale;
    assert.ok(Math.abs(got[i] - want[i]) <= tol, `${what}[${i}]: ${got[i]} against ${want[i]}`);
  }
}
const scalar = (/** @type {number} */ got, /** @type {number | null} */ want, /** @type {string} */ what) => close([got], [want === null ? NaN : want], what);
const unb64 = (/** @type {string} */ s, /** @type {'f4' | 'u1'} */ type) => {
  const b = Buffer.from(s, 'base64');
  return type === 'f4' ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) : new Uint8Array(b);
};

test('the flag bits used are the ones in the frame headers', () => {
  assert.equal(FLAG_FULLSAMPLE, 4096);
  assert.equal(FLAG_SOURCE, 2097152);
  assert.deepEqual([vec.constants.FLAG_FULLSAMPLE, vec.constants.FLAG_SOURCE, vec.constants.MIN_PIXELS], [FLAG_FULLSAMPLE, FLAG_SOURCE, MIN_PIXELS]);
  assert.deepEqual([vec.constants.SATURATION_MASK, vec.constants.DEFECT_MASK], [SATURATION_MASK, DEFECT_MASK]);
});

test('sigma-clipped median and robust noise', () => {
  for (const c of vec.clip) {
    const v = nan(c.values);
    scalar(clippedMedian(v), c.median, `${c.name}: median`);
    scalar(robustNoise(v), c.noise, `${c.name}: noise`);
  }
  assert.equal(clippedMedian([1, 2, 3, 4, 100]), 3);
  assert.ok(Number.isNaN(clippedMedian([])));
});

test('background and noise of a stamp, and its masks', () => {
  for (const c of vec.synthetic_stamps) {
    const data = Float32Array.from(nan(c.data)), flags = Int32Array.from(c.flags);
    const st = stampStats(data, flags);
    scalar(st.background, c.stats.background, `${c.name}: background`);
    scalar(st.noise, c.stats.noise, `${c.name}: noise`);
    assert.equal(st.n, c.stats.n, c.name);
    assert.equal(st.basis, c.stats.basis, c.name);
    assert.deepEqual([...quietMask(data, flags)], c.quiet, c.name);
    assert.deepEqual([...validMask(data, flags)], c.valid, c.name);
  }
  const sources = vec.synthetic_stamps.find((/** @type {{name: string}} */ c) => c.name === 'all source');
  assert.equal(stampStats(Float32Array.from(nan(sources.data)), Int32Array.from(sources.flags)).basis, 'valid');
  assert.equal(stampStats(Float32Array.from(nan(vec.synthetic_stamps[0].data)), null).basis, 'quiet');
});

test('bilinear resampling', () => {
  for (const c of vec.resample) {
    const r = resample(Float32Array.from(nan(c.src)), c.w, c.h, nan(c.mapX), nan(c.mapY), c.ok);
    close(r.data, nan(c.data), c.name);
    assert.deepEqual([...r.ok], c.ok_out, c.name);
  }
});

test('a shift keeps the flux of an object, a flat sky stays flat', () => {
  const img = new Float32Array(40 * 40);
  for (let j = 15; j < 25; j++) for (let i = 15; i < 25; i++) img[j * 40 + i] = 1 + ((i * 7 + j * 3) % 10) / 10;
  const m = affineMap(40, 40, [1, 0, 0.37, 0, 1, -0.21]);
  const r = resample(img, 40, 40, m.x, m.y);
  let a = 0, b = 0;
  for (const v of img) a += v;
  for (const v of r.data) if (Number.isFinite(v)) b += v;
  assert.ok(Math.abs(a - b) <= 1e-6 * a);
  const flat = new Float32Array(100).fill(2.5);
  const t = affineMap(10, 10, [0.9, -0.3, 1.1, 0.3, 0.9, 0.2]);
  const f = resample(flat, 10, 10, t.x, t.y);
  assert.ok(f.ok.some((o) => o));
  f.data.forEach((v, i) => { if (f.ok[i]) assert.ok(Math.abs(v - 2.5) < 1e-6); });
});

/** The stamps of a real case as arrays, in the order of the vector. @param {number} k */
function realStamps(k) {
  if (k === 1) {
    const man = readJson('showcase', 'barnard-d5', 'manifest.json'), n = man.frames.length, len = man.w * man.h;
    const d = readFloat32('showcase', 'barnard-d5', 'stamps.bin'), f = readInt32('showcase', 'barnard-d5', 'flags.bin');
    return Array.from({ length: n }, (_, i) => ({ data: d.subarray(i * len, (i + 1) * len), flags: /** @type {Int32Array | null} */ (f.subarray(i * len, (i + 1) * len)) }));
  }
  const man = readJson('d2', 'empty', 'manifest.json'), n = man.frames.length, len = 64 * 64;
  const d = readFloat32('d2', 'empty', 'stamps.bin'), f = readInt32('d2', 'empty', 'flags.bin');
  return Array.from({ length: n }, (_, i) => ({ data: d.subarray(i * len, (i + 1) * len), flags: /** @type {Int32Array | null} */ (k === 2 ? null : f.subarray(i * len, (i + 1) * len)) }));
}

/** @param {import('../../site/js/lib/stack.js').Coadd} got @param {any} want @param {string} what */
function sameCoadd(got, want, what) {
  assert.equal(got.photos, want.photos, `${what}: photos`);
  assert.equal(got.need, want.need, `${what}: need`);
  assert.deepEqual([...got.n], [...unb64(want.n, 'u1')], `${what}: n`);
  assert.equal(got.dropped, want.dropped, `${what}: dropped`);
  assert.equal(got.basis, want.basis, `${what}: basis`);
  close(got.background, want.background, `${what}: backgrounds`);
  scalar(got.noise, want.noise, `${what}: noise`);
  close(got.data, unb64(want.data, 'f4'), `${what}: data`);
  assert.deepEqual([...got.valid], [...unb64(want.valid, 'u1')], `${what}: valid`);
  assert.deepEqual([...got.quiet], [...unb64(want.quiet, 'u1')], `${what}: quiet`);
}

test('real stamps: statistics, co-add of each visit, the second visit on the grid of the first, the difference', () => {
  assert.equal(vec.real.length, 3);
  vec.real.forEach((/** @type {any} */ c, /** @type {number} */ k) => {
    const stamps = realStamps(k);
    stamps.forEach((s, i) => {
      const st = stampStats(s.data, s.flags);
      scalar(st.background, c.stats[i].background, `${c.name} ${i}: background`);
      scalar(st.noise, c.stats[i].noise, `${c.name} ${i}: noise`);
      assert.equal(st.basis, c.stats[i].basis);
    });
    const cos = [0, 1].map((v) => coadd(stamps.filter((_, i) => c.visit_of[i] === v), c.w, c.h));
    sameCoadd(cos[0], c.coadd[0], `${c.name}: visit 0`);
    sameCoadd(cos[1], c.coadd[1], `${c.name}: visit 1`);
    const m = affineMap(c.w, c.h, c.matrix);
    const rb = resampleCoadd(cos[1], m.x, m.y, c.w, c.h);
    sameCoadd(rb, c.resampled, `${c.name}: resampled`);
    const d = difference(cos[0], rb);
    close(d.diff, unb64(c.difference.diff, 'f4'), `${c.name}: diff`);
    close(d.units, unb64(c.difference.units, 'f4'), `${c.name}: units`);
    assert.deepEqual([...d.valid], [...unb64(c.difference.valid, 'u1')]);
    for (const key of ['sigma', 'sigmaA', 'sigmaB', 'scatter']) scalar(/** @type {any} */ (d)[key], c.difference[key], `${c.name}: ${key}`);
  });
});

test('a pixel is shown where half the photos may be used; a star is not a defect; units are in noise', () => {
  const c = vec.real[0], stamps = realStamps(0);
  const one = stamps.filter((_, i) => c.visit_of[i] === 0);
  const co = coadd(one, 64, 64);
  assert.equal(co.need, 2);
  const lost = (/** @type {number} */ px) => one.filter((s) => !usableMask(s.data, s.flags)[px]).length;
  let few = -1, many = -1;
  for (let px = 0; px < 64 * 64; px++) {
    if (few < 0 && lost(px) === 1) few = px;
    if (many < 0 && lost(px) >= 2) many = px;
  }
  assert.ok(few >= 0 && many >= 0);
  assert.equal(co.n[few], 2);
  assert.equal(co.valid[few], 1);
  assert.ok(Number.isFinite(co.data[few]));
  assert.equal(co.valid[many], 0);
  assert.ok(Number.isNaN(co.data[many]));
  const withSource = /** @type {Int32Array} */ (one[0].flags).slice();
  withSource[100] = FLAG_SOURCE;
  assert.equal(validMask(one[0].data, withSource)[100], 1);
  assert.equal(quietMask(one[0].data, withSource)[100], 0);
  const d = difference(co, co);
  assert.ok(d.valid.some((v) => v) && [...d.diff].every((v) => Number.isNaN(v) || v === 0));
  const x = affineMap(64, 64, [-1, 0, 63.9, 0, -1, 63.8]);
  const second = coadd(stamps.filter((_, i) => c.visit_of[i] === 1), 64, 64);
  const dd = difference(co, resampleCoadd(second, x.x, x.y, 64, 64));
  const spread = robustNoise([...dd.units].filter(Number.isFinite));
  assert.ok(spread > 0.5 && spread < 2.5, `units spread ${spread}`);
});
