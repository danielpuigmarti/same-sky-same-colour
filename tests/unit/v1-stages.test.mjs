// The small stages of the first page (site/js/ui/hero.js and lie.js): reading a showcase, the display rule,
// lining photos up, drawing a photo, and what the two stages make of a showcase. No browser is needed here; what
// needs one is in tests/e2e/v1-first-screen.spec.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixturePath, readJson, readBytes, readFloat32, readInt32 } from '../helpers/fixtures.mjs';
import {
  readShowcase, skyOf, fillFaulty, displayRule, greyOf, viewSize, findTurn, lineUp, fillPixels, planHero,
  formatDay, formatMonth, formatTime, formatColour, FAULTY_BITS, FLIP_MS, MIN_FLIP_MS,
} from '../../site/js/ui/hero.js';
import { planLie, meterFills, STOPS } from '../../site/js/ui/lie.js';

/** @param {...string} parts @returns {ArrayBuffer} */
const bytesOf = (...parts) => {
  const b = readFileSync(fixturePath(...parts));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

/** @param {string[]} folder */
const showcase = (...folder) => {
  const manifest = readJson(...folder, 'manifest.json');
  return { manifest, photos: readShowcase(manifest, bytesOf(...folder, 'stamps.bin'), bytesOf(...folder, 'flags.bin')) };
};

/** A photo made of a list of stars on a flat, noisy sky. @param {[number, number, number][]} stars  x, y, brightness */
function field(stars, { w = 64, h = 64, tx = 32, ty = 32, sky = 1, seed = 1 } = {}) {
  const data = new Float32Array(w * h);
  let s = seed;
  const noise = () => { s = (s * 1664525 + 1013904223) % 4294967296; return (s / 4294967296 - 0.5) * 0.2; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = sky + noise();
      for (const [sx, sy, b] of stars) v += b * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 2);
      data[y * w + x] = v;
    }
  }
  return { index: 0, key: '', det: 1, mjd: 0, lam: 1, bw: 0.01, visit: 0, w, h, tx, ty, data, shown: data, filled: 0, ...skyOf(data), turn: NaN };
}

/** The same stars turned by `deg` about (32, 32), as findTurn defines a turn. @param {[number, number, number][]} stars @param {number} deg */
const turned = (stars, deg) => stars.map(([x, y, b]) => {
  const t = deg * Math.PI / 180, dx = x - 32, dy = y - 32;
  return /** @type {[number, number, number]} */ ([32 + dx * Math.cos(t) - dy * Math.sin(t), 32 + dx * Math.sin(t) + dy * Math.cos(t), b]);
});

/** @type {[number, number, number][]} */
const STARS = [[12, 40, 9], [45, 51, 6], [50, 20, 12], [20, 14, 5], [38, 8, 7], [8, 22, 4], [27, 47, 8], [55, 36, 5]];

test('the fixture of the lie stage is the two fixtures of the foundation it says it is made of', () => {
  const lie = readJson('v1', 'lie', 'manifest.json'), d5 = readJson('showcase', 'barnard-d5', 'manifest.json');
  const d2 = readJson('frames', 'barnard-d2', 'frame.json');
  assert.deepEqual(lie.frames.map((/** @type {{key: string}} */ f) => f.key), [d5.frames[0].key, d5.frames[1].key, d2.key, d5.frames[2].key, d5.frames[3].key]);
  assert.deepEqual(lie.pairs, [[0, 3], [1, 4]]);
  const n = 64 * 64 * 4, order = [0, 1, -1, 2, 3];
  for (const [file, single] of /** @type {const} */ ([['stamps.bin', 'image.f32'], ['flags.bin', 'flags.i32']])) {
    const joined = readBytes('v1', 'lie', file), parts = readBytes('showcase', 'barnard-d5', file), extra = readBytes('frames', 'barnard-d2', single);
    assert.equal(joined.length, 5 * n);
    for (const [i, from] of order.entries()) {
      const want = from < 0 ? extra : parts.subarray(from * n, (from + 1) * n);
      assert.ok(Buffer.from(joined.subarray(i * n, (i + 1) * n)).equals(Buffer.from(want)), `${file}, frame ${i}`);
    }
  }
});

test('a showcase is read without changing a value, and only faulty pixels differ in what is drawn', () => {
  const { manifest, photos } = showcase('showcase', 'barnard-d5');
  const values = readFloat32('showcase', 'barnard-d5', 'stamps.bin'), words = readInt32('showcase', 'barnard-d5', 'flags.bin');
  const faulty = FAULTY_BITS.reduce((word, bit) => word | (1 << bit), 0);
  assert.equal(photos.length, 4);
  for (const [k, p] of photos.entries()) {
    assert.equal(p.det, 5);
    assert.equal(p.index, k);
    assert.equal(p.lam, manifest.frames[k].lam);
    let filled = 0;
    for (let i = 0; i < 4096; i++) {
      const v = values[k * 4096 + i], bad = !Number.isFinite(v) || (words[k * 4096 + i] & faulty) !== 0;
      assert.ok(Object.is(p.data[i], v), 'data is the stamp, bit for bit');
      if (!bad) assert.ok(Object.is(p.shown[i], v), 'a good pixel is drawn as it is');
      else if (Number.isFinite(p.shown[i])) filled++;
    }
    assert.equal(p.filled, filled);
    assert.ok(p.filled > 0 && p.filled < 200, `filled ${p.filled}`);
    assert.ok(p.noise > 0.04 && p.noise < 0.08, `noise ${p.noise}`);
  }
  assert.throws(() => readShowcase(manifest, new ArrayBuffer(12)), /do not fit/);
});

test('the detector of a photo is read from its key', () => {
  const { photos } = showcase('v1', 'lie');
  assert.deepEqual(photos.map((p) => p.det), [5, 5, 2, 5, 5]);
});

test('sky level and noise follow the rule for a stamp without flags', () => {
  // 100 values 0..99: nothing is clipped; median 49.5, median distance from it 25
  const ramp = Array.from({ length: 100 }, (_, i) => i);
  const flat = skyOf(ramp);
  assert.equal(flat.sky, 49.5);
  assert.ok(Math.abs(flat.noise - 1.4826 * 25) < 1e-9);
  // a bright star on a flat sky does not move the sky level; missing values are skipped
  const sky = [...Array.from({ length: 400 }, (_, i) => 10 + ((i * 7) % 11 - 5) * 0.01), 5000, 4000, NaN, Infinity];
  const starry = skyOf(sky);
  assert.ok(Math.abs(starry.sky - 10) < 0.011, `sky ${starry.sky}`);
  assert.ok(starry.noise > 0.02 && starry.noise < 0.06, `noise ${starry.noise}`);
  assert.deepEqual(skyOf([NaN]), { sky: NaN, noise: NaN });
});

test('a single faulty pixel is filled from its neighbours; the middle of a larger gap stays empty; other flags are left alone', () => {
  const w = 7, h = 7, data = Float32Array.from({ length: w * h }, (_, i) => i);
  const flags = new Int32Array(w * h);
  data[1 * w + 1] = NaN;                                  // a pixel without a value
  flags[1 * w + 5] = 1 << 10;                             // HOT
  flags[5 * w + 1] = (1 << 21) | (1 << 28) | (1 << 12);   // SOURCE, HALO, FULLSAMPLE: not faulty here
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) flags[y * w + x] = 1 << 1;   // a 3 by 3 block, OVERFLOW
  const { shown, filled } = fillFaulty(data, flags, w, h);
  assert.equal(shown[1 * w + 1], 8);                      // median of the 8 neighbours of pixel 8
  assert.equal(shown[1 * w + 5], 12);                     // and of pixel 12
  assert.equal(shown[5 * w + 1], 36);                     // untouched
  assert.ok(Number.isNaN(shown[4 * w + 4]), 'the middle of the block has no good neighbour');
  assert.ok(Number.isFinite(shown[3 * w + 3]), 'its corner has five');
  assert.equal(filled, 2 + 8);
  assert.ok(Number.isNaN(data[1 * w + 1]) && data[1 * w + 5] === 12, 'the stamp itself is not changed');
  // without flags only missing values are faulty
  assert.equal(fillFaulty(data, null, w, h).filled, 1);
});

test('one display rule: black at twice the noise of the quietest photo below the sky, white at the brightest peak near a target', () => {
  const a = field([[32, 32, 50]]), b = field([[32, 32, 400], [10, 10, 9000]], { seed: 7 });
  b.noise = a.noise * 3;
  const rule = displayRule([a, b]);
  assert.ok(rule);
  assert.equal(rule.black, -2 * a.noise);
  assert.equal(rule.soften, 3 * a.noise);
  const peak = b.data[32 * 64 + 32] - b.sky;
  assert.ok(Math.abs(rule.white - peak) < 1e-6, 'the star at the target sets white, not the brighter star in the corner');
  assert.equal(greyOf(rule.black, rule), 0);
  assert.equal(greyOf(rule.white, rule), 1);
  assert.equal(greyOf(rule.black - 5, rule), 0);
  assert.equal(greyOf(rule.white * 9, rule), 1);
  // an asinh curve: rising all the way, and far steeper near the sky than near white
  let last = -1;
  for (let v = rule.black; v <= rule.white; v += (rule.white - rule.black) / 200) {
    const g = greyOf(v, rule);
    assert.ok(g >= last);
    last = g;
  }
  assert.ok(greyOf(rule.white / 20, rule) > 0.5, 'a twentieth of white is already past mid grey');
  assert.equal(displayRule([]), null);
});

test('the turn between two photos is found on their stars, to a fraction of a degree', () => {
  const ref = field(STARS);
  for (const deg of [0, 37.4, 147.3, 180, -92.6, -179.5]) {
    const other = field(turned(STARS, deg), { seed: 99 });
    const found = findTurn(ref, other);
    const off = Math.abs(((found.turn - deg) % 360 + 540) % 360 - 180);
    assert.ok(off < 0.3, `turned ${deg}, found ${found.turn}`);
    assert.ok(found.sure, `sure at ${deg} (score ${found.score})`);
  }
  // a turn below one degree counts as none: the photo is then drawn pixel for pixel
  assert.equal(findTurn(ref, field(turned(STARS, 0.4), { seed: 5 })).turn, 0);
  // an empty field says nothing, and says so
  const blank = findTurn(field([]), field([], { seed: 3 }));
  assert.equal(blank.sure, false);
  // a target too close to the edge leaves too little sky to compare
  assert.equal(findTurn(field(STARS, { tx: 3, ty: 3 }), ref).sure, false);
});

test('the two visits of the fixture are half a turn apart, and photos of one visit are not turned', () => {
  const { photos } = showcase('showcase', 'barnard-d5');
  const ref = photos[2];
  for (const k of [0, 1]) {
    assert.ok(lineUp(ref, photos[k]));
    assert.ok(Math.abs(Math.abs(photos[k].turn) - 179.5) < 0.6, `photo ${k} turned ${photos[k].turn}`);
  }
  assert.ok(lineUp(ref, photos[3]));
  assert.equal(photos[3].turn, 0);
  assert.ok(lineUp(ref, ref));
  assert.equal(ref.turn, 0);
  // a photo of another detector, taken in the same pointing, lines up too
  const lie = showcase('v1', 'lie').photos;
  assert.ok(lineUp(lie[3], lie[2]));
  assert.equal(lie[2].turn, 0);
});

test('a drawn photo is its pixels around the target, each as it is: never blended, never moved by a fraction', () => {
  const { photos } = showcase('showcase', 'barnard-d5');
  const rule = displayRule(photos);
  assert.ok(rule);
  const size = viewSize(photos), c = (size - 1) / 2;
  assert.equal(size, 43);
  const p = photos[2];
  p.turn = 0;
  const out = new Uint8Array(size * size * 4);
  fillPixels(out, p, rule, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = Math.round(p.tx) + i - c, y = Math.round(p.ty) + (size - 1 - j) - c, v = p.shown[y * p.w + x], k = (j * size + i) * 4;
      if (Number.isFinite(v)) assert.deepEqual([...out.subarray(k, k + 4)], [...Array(3).fill(Math.round(255 * greyOf(v - p.sky, rule))), 255]);
      else assert.equal(out[k + 3], 0, 'a pixel without a value stays clear');
    }
  }
  // half a turn: the same pixels, read from the other end
  p.turn = 180;
  const flipped = new Uint8Array(size * size * 4);
  fillPixels(flipped, p, rule, size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const a = (j * size + i) * 4, b = ((size - 1 - j) * size + (size - 1 - i)) * 4;
      assert.deepEqual([...flipped.subarray(a, a + 4)], [...out.subarray(b, b + 4)]);
    }
  }
  // any turn: every grey on the canvas is the grey of one pixel of the photo
  p.turn = 151.7;
  const greys = new Set([...p.shown].filter(Number.isFinite).map((v) => Math.round(255 * greyOf(v - p.sky, rule))));
  const any = new Uint8Array(size * size * 4);
  fillPixels(any, p, rule, size);
  for (let k = 0; k < any.length; k += 4) if (any[k + 3]) assert.ok(greys.has(any[k]));
});

test('the comet: the first pair gives the left and right panels, the later visit the stops of the chip', () => {
  const { manifest, photos } = showcase('showcase', 'barnard-d5');
  const plan = planHero(manifest, photos);
  assert.ok(plan);
  assert.equal(plan.before.index, 0);
  assert.equal(plan.after.index, 2);
  assert.equal(plan.beside.index, 3);
  assert.deepEqual(plan.stops.map((p) => p.index), [2, 3]);
  assert.equal(plan.home, 0);
  assert.deepEqual([...plan.twins].map(([late, early]) => [late.index, early.index]), [[2, 0], [3, 1]]);
  assert.equal(plan.size, 43);
  // without a pair there is nothing to blink, and the page keeps its picture
  assert.equal(planHero({ ...manifest, pairs: [] }, photos), null);
  // a pair inside one visit is not a pair of visits
  assert.equal(planHero({ ...manifest, pairs: [[0, 1]] }, photos), null);
});

test('the lie stage: one visit in time order, one detector of it, and the closest pair in colour', () => {
  const { manifest, photos } = showcase('v1', 'lie');
  const plan = planLie(manifest, photos);
  assert.ok(plan);
  assert.deepEqual(STOPS, ['all', 'detector', 'matched']);
  assert.deepEqual(plan.photos.all.map((p) => p.index), [2, 3, 4]);
  assert.deepEqual(plan.photos.detector.map((p) => p.index), [3, 4]);
  assert.deepEqual(plan.photos.matched.map((p) => p.index), [1, 4]);
  assert.equal(plan.left, 0);
  assert.ok(plan.range.min < 1.4456 && plan.range.max > 4.3703);
  for (const p of [...plan.photos.all, ...plan.photos.matched]) assert.ok(Number.isFinite(p.turn));
  assert.equal(planLie({ ...manifest, pairs: [] }, photos), null);
});

test('the bars of the meter are the logarithms of the factors; anything that is not a factor draws no bars', () => {
  const fills = meterFills([49.8, 2.71, 1.04]);
  assert.ok(fills);
  assert.equal(fills[0], 1);
  assert.ok(Math.abs(fills[1] - Math.log(2.71) / Math.log(49.8)) < 1e-12);
  assert.ok(fills[2] > 0 && fills[2] < 0.02);
  assert.deepEqual(meterFills([1, 1, 1]), [0, 0, 0]);
  // a factor a little below 1 is as short a bar as one a little above it
  assert.ok(Math.abs(/** @type {number[]} */ (meterFills([49.8, 2.71, 0.96]))[2] - Math.log(1 / 0.96) / Math.log(49.8)) < 1e-12);
  assert.equal(meterFills([49.8, undefined, 1.04]), null);
  assert.equal(meterFills([49.8, 0, 1.04]), null);
  assert.equal(meterFills([49.8, -3, 1.04]), null);
  assert.equal(meterFills([NaN, 2, 3]), null);
});

test('dates, times and colours are written one way', () => {
  assert.equal(formatDay(61097.863770865), '26 February 2026');
  assert.equal(formatMonth(60897.452261965), 'August 2025');
  assert.equal(formatTime(61097.863770865), '20:43 UTC');
  assert.equal(formatTime(61114.032669638), '00:47 UTC');
  assert.equal(formatColour(4.2656), '4.266');
});

test('no loop changes the picture more often than twice a second', () => {
  assert.ok(MIN_FLIP_MS >= 500);
  assert.ok(FLIP_MS >= MIN_FLIP_MS);
});
