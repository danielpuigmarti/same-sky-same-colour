// The display grid (site/js/lib/display.js): the cases of tests/vectors/display.json, which the Python twin
// (pipeline/sx/display.py) wrote from real stamps; a stamp made by hand and turned by 0, 90, 147 and 180 degrees;
// and the sky of a stamp read from the header of its frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PIXEL_ARCSEC, PIXEL_DEG, DISPLAY_SIZE, gridSky, sourceMap, sourcePixels, toDisplayGrid, isOnGrid, detectorPixel, cropSquare,
  skyOfFrame, createSkyReader,
} from '../../site/js/lib/display.js';
import { PIXEL_ARCSEC as STAGE_PIXEL_ARCSEC } from '../../site/js/ui/stage.js';
import { parseFileStart } from '../../site/js/lib/fitsio.js';
import { makeWcs } from '../../site/js/lib/wcs.js';
import { BUCKET_URLS } from '../../site/js/contracts.js';
import { FRAME_IDS, loadFrame, rangeFetch } from '../helpers/fixtures.mjs';

const vectors = JSON.parse(readFileSync(new URL('../vectors/display.json', import.meta.url), 'utf8'));

/** The bits of float32 values, so that NaN compares too. @param {Float32Array} a */
const bits = (a) => Array.from(new Uint32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)));

/** A list with null for NaN, as float32 values. @param {(number | null)[]} list */
const f32 = (list) => Float32Array.from(list, (v) => (v === null ? NaN : v));

/** @param {any} c  A case of the vector file, as a stamp (CT-4). */
function stampOf(c) {
  const s = c.stamp;
  return {
    key: c.key, det: /** @type {1} */ (1), mjd: 0, w: s.w, h: s.h, x0: 100, y0: 200, tx: s.tx, ty: s.ty, lam: 1, bw: 0.1,
    data: f32(s.data), flags: Int32Array.from(s.flags), sky: s.sky,
  };
}

test('the grid is the one the pipeline and the stage use: 6.15 arcsec, east to the left, north up', () => {
  assert.equal(PIXEL_ARCSEC, vectors.pixelArcsec);
  assert.equal(PIXEL_DEG, vectors.pixelDeg);
  assert.equal(PIXEL_ARCSEC, STAGE_PIXEL_ARCSEC);
  assert.deepEqual(gridSky({ ra: 10, dec: -20, cd: [1, 2, 3, 4] }), vectors.gridSky);
  assert.equal(DISPLAY_SIZE, 44);
  // a square of DISPLAY_SIZE fits in a stamp of 64 pixels at any turn: its corner pixels lie within 31 pixels of the target
  assert.ok(Math.hypot((DISPLAY_SIZE - 1) / 2 + 0.5, (DISPLAY_SIZE - 1) / 2 + 0.5) <= 31.5);
});

test('every case of the shared vectors comes out the same: source pixels, values bit for bit, flags', () => {
  assert.ok(vectors.cases.length >= 9);
  for (const c of vectors.cases) {
    const g = toDisplayGrid(stampOf(c), c.size);
    assert.deepEqual(Array.from(g.sx), c.expect.sx, `${c.name}: sx`);
    assert.deepEqual(Array.from(g.sy), c.expect.sy, `${c.name}: sy`);
    assert.deepEqual(Array.from(/** @type {Int32Array} */ (g.flags)), c.expect.flags, `${c.name}: flags`);
    assert.deepEqual(bits(g.data), bits(f32(c.expect.data)), `${c.name}: data`);
    // the form: a stamp on the grid
    const mid = Math.floor(c.size / 2);
    assert.deepEqual([g.w, g.h, g.tx, g.ty, g.sw, g.sh], [c.size, c.size, mid, mid, c.stamp.w, c.stamp.h]);
    assert.deepEqual(g.sky, { ra: c.stamp.sky.ra, dec: c.stamp.sky.dec, cd: [-PIXEL_DEG, 0, 0, PIXEL_DEG] });
    assert.deepEqual([g.key, g.x0, g.y0], [c.key, 100, 200], 'the frame and the place of the stamp on the detector are kept');
    assert.ok(isOnGrid(g) && !isOnGrid(stampOf(c)));
    // the target pixel of the grid is the pixel of the target
    assert.equal(g.sx[mid * c.size + mid], Math.floor(c.stamp.tx + 0.5), c.name);
    assert.equal(g.sy[mid * c.size + mid], Math.floor(c.stamp.ty + 0.5), c.name);
    assert.deepEqual(detectorPixel(g, mid, mid), { x: 100 + Math.floor(c.stamp.tx + 0.5), y: 200 + Math.floor(c.stamp.ty + 0.5) });
  }
  const turns = vectors.cases.map((/** @type {{turn: number}} */ c) => c.turn);
  for (const want of [0, 90, 147, 180]) assert.ok(turns.some((/** @type {number} */ t) => Math.abs(((t - want + 540) % 360) - 180) < 12), `a case near ${want} degrees`);
});

test('a pixel without a source has no value and no flags, and says so; a stamp without flags gives none', () => {
  const c = vectors.cases.find((/** @type {{name: string}} */ x) => x.name.startsWith('target near the edge'));
  const g = toDisplayGrid(stampOf(c), c.size);
  let outside = 0;
  for (let k = 0; k < g.data.length; k++) {
    if (g.sx[k] >= 0) continue;
    outside++;
    assert.ok(Number.isNaN(g.data[k]) && /** @type {Int32Array} */ (g.flags)[k] === 0 && g.sy[k] === -1);
    assert.equal(detectorPixel(g, k % g.w, Math.floor(k / g.w)), null);
  }
  assert.ok(outside > 100, 'a grid larger than the stamp has pixels outside it');
  const bare = toDisplayGrid({ ...stampOf(c), flags: null }, 15);
  assert.equal(bare.flags, null);
  assert.throws(() => toDisplayGrid({ ...stampOf(c), sky: undefined }, 15), /no sky transform/);
  assert.throws(() => sourcePixels({ ra: 0, dec: 0, cd: [1, 2, 2, 4] }, 5, 5, 10, 10, 8), /cannot be inverted/);
});

/**
 * The sky of a detector whose north lies `turn` degrees from +y towards east, with pixels of the size of the grid.
 * Whole quarter turns are exact.
 * @param {number} turn
 * @returns {[number, number, number, number]}
 */
function cdOf(turn) {
  const q = ((turn % 360) + 360) % 360;
  const [c, s] = q === 0 ? [1, 0] : q === 90 ? [0, 1] : q === 180 ? [-1, 0] : q === 270 ? [0, -1] : [Math.cos(q * Math.PI / 180), Math.sin(q * Math.PI / 180)];
  return [-PIXEL_DEG * c, PIXEL_DEG * s, PIXEL_DEG * s, PIXEL_DEG * c];
}

/** A sky that says where it is: a slope to the east and to the north, in units of a pixel. @param {number} east @param {number} north */
const slope = (east, north) => 100 + 0.25 * east + 0.5 * north;

/**
 * A stamp of that sky, 64 by 64, target in its middle pixel, seen by a detector turned by `turn` degrees.
 * @param {number} turn
 */
function turnedStamp(turn) {
  const w = 64, h = 64, tx = 32, ty = 32, cd = cdOf(turn);
  const data = new Float32Array(w * h), flags = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const east = (cd[0] * (x - tx) + cd[1] * (y - ty)) / PIXEL_DEG, north = (cd[2] * (x - tx) + cd[3] * (y - ty)) / PIXEL_DEG;
      data[y * w + x] = slope(east, north);
      flags[y * w + x] = y * w + x + 1; // every pixel has its own word
    }
  }
  return { key: `turned-${turn}`, det: /** @type {2} */ (2), mjd: 61000, w, h, x0: 500, y0: 700, tx, ty, lam: 1.2, bw: 0.03, data, flags, sky: { ra: 150, dec: 20, cd } };
}

for (const turn of [0, 90, 147, 180]) {
  test(`a stamp turned by ${turn} degrees comes back upright, each pixel from one pixel of the stamp`, () => {
    const stamp = turnedStamp(turn), size = DISPLAY_SIZE, mid = size / 2;
    const g = toDisplayGrid(stamp, size);
    /** @type {Map<number, number>} how often each pixel of the stamp was taken */
    const taken = new Map();
    let worst = 0;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const k = j * size + i;
        assert.ok(g.sx[k] >= 0 && g.sy[k] >= 0, `the grid is covered at a turn of ${turn}: pixel ${i}, ${j}`);
        const from = g.sy[k] * stamp.w + g.sx[k];
        taken.set(from, (taken.get(from) ?? 0) + 1);
        // the value and the flags are those of that one pixel: nothing is mixed
        assert.equal(g.data[k], stamp.data[from]);
        assert.equal(/** @type {Int32Array} */ (g.flags)[k], from + 1);
        // upright: east is to the left and north is up, so the value is the sky's value at that place of the grid,
        // as close as the pixel the centre fell in (half a diagonal at most)
        worst = Math.max(worst, Math.abs(g.data[k] - slope(mid - i, j - mid)));
      }
    }
    const most = Math.max(...taken.values());
    if (turn % 90 === 0) {
      assert.equal(most, 1, 'a quarter turn moves pixels and repeats none');
      assert.ok(worst < 1e-4, `the picture is the sky itself: ${worst}`);
    } else {
      assert.ok(most <= 2, `a pixel of the stamp is taken by two pixels of the grid at most: ${most}`);
      assert.ok(worst <= Math.hypot(0.25, 0.5) * Math.SQRT1_2 + 1e-4, `within half a diagonal of the sky: ${worst}`);
    }
    // north of the target is up: the pixel above the middle is brighter by the slope to the north
    const up = g.data[(mid + 1) * size + mid] - g.data[mid * size + mid], left = g.data[mid * size + mid - 1] - g.data[mid * size + mid];
    assert.ok(Math.abs(up - 0.5) < 0.4 && Math.abs(left - 0.25) < 0.4, `up ${up}, left ${left}`);
  });
}

test('a smaller grid is the middle of a larger one', () => {
  for (const turn of [0, 147]) {
    const stamp = turnedStamp(turn);
    const large = toDisplayGrid(stamp, 64), small = toDisplayGrid(stamp, DISPLAY_SIZE);
    assert.deepEqual(bits(cropSquare(large.data, 64, DISPLAY_SIZE)), bits(small.data));
    assert.deepEqual(cropSquare(/** @type {Int32Array} */ (large.flags), 64, DISPLAY_SIZE), small.flags);
    assert.deepEqual(cropSquare(large.sx, 64, DISPLAY_SIZE), small.sx);
  }
  assert.deepEqual(Array.from(cropSquare(Uint8Array.from({ length: 25 }, (_, i) => i), 5, 3)), [6, 7, 8, 11, 12, 13, 16, 17, 18]);
  assert.deepEqual(Array.from(cropSquare(Uint8Array.from({ length: 16 }, (_, i) => i), 4, 2)), [5, 6, 9, 10]);
  assert.throws(() => cropSquare(new Uint8Array(4), 2, 3));
  // the map that is not rounded gives the same pixels when rounded
  const s = turnedStamp(147), at = sourceMap(s.sky, s.tx, s.ty, 20), px = sourcePixels(s.sky, s.tx, s.ty, s.w, s.h, 20);
  for (let k = 0; k < 400; k++) assert.deepEqual([Math.floor(at.x[k] + 0.5), Math.floor(at.y[k] + 0.5)], [px.sx[k], px.sy[k]]);
});

test('the sky of a stamp comes from the header of its frame, as astropy gives it', () => {
  assert.equal(vectors.localSky.length, 12);
  for (const c of vectors.localSky) {
    const frame = loadFrame(c.frame);
    const parts = parseFileStart(frame.ranges.find((/** @type {{start: number}} */ r) => r.start === 0).bytes);
    assert.ok(parts);
    for (const from of [parts.image.h, makeWcs(parts.image.h)]) {
      const sky = skyOfFrame(from, { x0: 0, y0: 0, tx: c.x, ty: c.y });
      assert.ok(sky);
      // astropy and this reader agree on a position to a millionth of a pixel, and on a pixel step to a part in a million
      assert.ok(Math.abs(sky.ra - c.sky.ra) * Math.cos(c.sky.dec * Math.PI / 180) < 2e-9 && Math.abs(sky.dec - c.sky.dec) < 2e-9, `${c.frame} ${c.x} ${c.y}: position`);
      for (let k = 0; k < 4; k++) assert.ok(Math.abs(sky.cd[k] - c.sky.cd[k]) < 2e-9, `${c.frame} ${c.x} ${c.y}: cd[${k}] ${sky.cd[k]} against ${c.sky.cd[k]}`);
    }
  }
  // the stamp of a fixture: its target pixel is at the position it was cut around
  for (const id of FRAME_IDS) {
    const frame = loadFrame(id), parts = parseFileStart(frame.ranges.find((/** @type {{start: number}} */ r) => r.start === 0).bytes);
    const sky = skyOfFrame(/** @type {NonNullable<typeof parts>} */ (parts).image.h, frame.meta.stamp);
    assert.ok(sky && Math.abs(sky.ra - frame.meta.target.ra) < 1e-7 && Math.abs(sky.dec - frame.meta.target.dec) < 1e-7, id);
    assert.ok(Math.abs(Math.hypot(sky.cd[0], sky.cd[2]) * 3600 - PIXEL_ARCSEC) < 0.1 && Math.abs(Math.hypot(sky.cd[1], sky.cd[3]) * 3600 - PIXEL_ARCSEC) < 0.1);
  }
});

test('the sky reader asks the archive once for a frame, by either address, and gives null for a frame it cannot read', async () => {
  const frames = FRAME_IDS.map(loadFrame), fetchRange = rangeFetch(frames);
  const reader = createSkyReader({ fetch: /** @type {any} */ (fetchRange) });
  const got = await Promise.all(frames.map((f) => reader.skyOf(f.meta.key, f.meta.stamp)));
  for (const [i, f] of frames.entries()) {
    const parts = parseFileStart(f.ranges.find((/** @type {{start: number}} */ r) => r.start === 0).bytes);
    assert.deepEqual(got[i], skyOfFrame(/** @type {NonNullable<typeof parts>} */ (parts).image.h, f.meta.stamp));
  }
  assert.equal(fetchRange.calls.length, 3, 'one request for each frame');
  assert.ok(fetchRange.calls.every((c) => c.start === 0 && c.end === 28799));
  assert.equal(new Set(fetchRange.calls.map((c) => c.host)).size, 2, 'the frames take the two addresses of the bucket in turn');
  await reader.skyOf(frames[0].meta.key, { x0: 3, y0: 4, tx: 10, ty: 10 });
  assert.equal(fetchRange.calls.length, 3, 'a frame that was read is not asked for again');
  for (const host of Object.values(fetchRange.maxInFlight)) assert.ok(host <= 2);

  // a frame that cannot be read: both addresses are tried, the answer is null, and the next call asks again
  /** @type {string[]} */
  const asked = [];
  let fail = true;
  const flaky = createSkyReader({
    fetch: /** @type {any} */ (async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      asked.push(url);
      if (fail) return new Response('', { status: 403 });
      return fetchRange(url, init);
    }),
  });
  assert.equal(await flaky.skyOf(frames[0].meta.key, frames[0].meta.stamp), null);
  assert.deepEqual(asked.map((u) => BUCKET_URLS.findIndex((b) => u.startsWith(b))).sort(), [0, 1]);
  fail = false;
  assert.deepEqual(await flaky.skyOf(frames[0].meta.key, frames[0].meta.stamp), got[0]);
});
