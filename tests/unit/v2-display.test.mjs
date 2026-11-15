// What the stage draws, without a page: the display rule, the colours of a difference, the marks from the flags,
// the curtain, and the geometry (site/js/ui/stage.js, first half). Reference values: tests/fixtures/v2/, made with
// numpy and astropy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFF_RANGE, MATCH_BANDWIDTH_FRACTION } from '../../site/js/contracts.js';
import { SATURATION_MASK, DEFECT_MASK, SOURCE_MASK } from '../../site/js/lib/flags.js';
import {
  PIXEL_ARCSEC, STRETCH_PERCENTILE, STRETCH_SOFTENING, MAX_FLIPS_PER_SECOND, MIN_FLIP_MS, FLIP_MS, DIFF_GREY_BELOW, DEFAULT_PALETTE,
  percentileOf, displayLimits, stretchByte, greyRgba, diffRgb, diffRgba, pictureMasks, curtainSplit, curtainOf, maskPath, scaleBar,
  compassOf, colourMatch, formatDate, parseHexColour, STAGE_MODES,
} from '../../site/js/ui/stage.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { FRAME_IDS, loadFrame, readJson, readBytes } from '../helpers/fixtures.mjs';

const manifest = readJson('showcase', 'barnard-d5', 'manifest.json');
const stamps = decodeShowcase(manifest, readBytes('showcase', 'barnard-d5', 'stamps.bin'), readBytes('showcase', 'barnard-d5', 'flags.bin'));
const reference = readJson('v2', 'display.json');
const sky = readJson('v2', 'sky.json');
const W = manifest.w, H = manifest.h;

test('the constants of the stage are the ones the viewer is specified with and the contracts give', () => {
  assert.equal(PIXEL_ARCSEC, 6.15);
  assert.equal(STRETCH_PERCENTILE, 99.5);
  assert.equal(MAX_FLIPS_PER_SECOND, 2);
  assert.equal(MIN_FLIP_MS, 500);
  assert.ok(FLIP_MS >= MIN_FLIP_MS, 'Blink plays no faster than the limit');
  assert.equal(DIFF_RANGE, 5);
  assert.equal(DIFF_GREY_BELOW, 3);
  assert.deepEqual([...STAGE_MODES], ['blink', 'diff', 'curtain', 'side']);
});

test('the black and white points are the percentiles of both pictures together, as numpy computes them', () => {
  for (const p of reference.pairs) {
    const [i, j] = p.frames;
    const { lo, hi } = displayLimits([stamps[i].data, stamps[j].data]);
    assert.ok(Math.abs(lo - p.lo) < 1e-9 * Math.abs(p.lo) && Math.abs(hi - p.hi) < 1e-9 * Math.abs(p.hi), `${lo} ${hi} against ${p.lo} ${p.hi}`);
    assert.deepEqual(displayLimits([stamps[j].data, stamps[i].data]), { lo, hi }, 'the order of the pictures does not matter');
  }
  assert.equal(percentileOf([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentileOf([1, 2, 3, 4], 0), 1);
  assert.equal(percentileOf([1, 2, 3, 4], 100), 4);
  assert.equal(percentileOf([7], 99.5), 7);
  assert.ok(Number.isNaN(percentileOf([], 50)));
  assert.deepEqual(displayLimits([new Float32Array([NaN, NaN])]), { lo: 0, hi: 1 }, 'no value at all');
  assert.deepEqual(displayLimits([new Float32Array([2, 2, 2])]), { lo: 2, hi: 3 }, 'a flat picture');
  assert.deepEqual(displayLimits([]), { lo: 0, hi: 1 });
});

test('every pixel of the showcase gets the grey that numpy gives it', () => {
  for (const p of reference.pairs) {
    const limits = displayLimits(p.frames.map((/** @type {number} */ i) => stamps[i].data));
    for (const [k, i] of p.frames.entries()) {
      const want = Buffer.from(p.grey[k], 'base64'), rgba = greyRgba(stamps[i].data, W, H, limits);
      assert.equal(want.length, W * H);
      let differ = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = stamps[i].data[y * W + x], o = ((H - 1 - y) * W + x) * 4; // the canvas has the top row first
          if (!Number.isFinite(v)) {
            assert.deepEqual([...rgba.subarray(o, o + 4)], [...DEFAULT_PALETTE.none, 255], 'a pixel without a value has its own colour');
            continue;
          }
          assert.ok(rgba[o] === rgba[o + 1] && rgba[o] === rgba[o + 2] && rgba[o + 3] === 255, 'grey and opaque');
          assert.equal(rgba[o], stretchByte(v, limits.lo, limits.hi));
          if (rgba[o] !== want[y * W + x]) differ++;
        }
      }
      assert.equal(differ, 0, `frame ${i}`);
    }
  }
});

test('the curve: black at the black point, white at the white point, asinh between, never out of range', () => {
  assert.equal(stretchByte(0, 0, 1), 0);
  assert.equal(stretchByte(1, 0, 1), 255);
  assert.equal(stretchByte(-5, 0, 1), 0);
  assert.equal(stretchByte(99, 0, 1), 255);
  assert.equal(stretchByte(Infinity, 0, 1), 255);
  assert.equal(stretchByte(NaN, 0, 1), 0);
  for (const t of [0.01, 0.1, 0.25, 0.5, 0.9]) {
    assert.equal(stretchByte(10 + 30 * t, 10, 40), Math.round(255 * Math.asinh(STRETCH_SOFTENING * t) / Math.asinh(STRETCH_SOFTENING)), `t = ${t}`);
  }
  let last = -1;
  for (let v = -1; v <= 2; v += 0.001) {
    const g = stretchByte(v, 0, 1);
    assert.ok(g >= last && Number.isInteger(g) && g >= 0 && g <= 255);
    last = g;
  }
  assert.ok(stretchByte(0.1, 0, 1) > 255 * 0.1, 'faint things are lifted');
});

test('a value has one grey wherever it stands: a stamp set by hand', () => {
  const data = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, NaN, 4]); // 4 wide, 3 high; the first row is the lowest
  const limits = { lo: 0, hi: 9 };
  const rgba = greyRgba(data, 4, 3, limits);
  /** @param {number} x @param {number} y  y counted from the lowest row */
  const at = (x, y) => [...rgba.subarray(((3 - 1 - y) * 4 + x) * 4, ((3 - 1 - y) * 4 + x) * 4 + 4)];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      const v = data[y * 4 + x];
      if (Number.isFinite(v)) assert.deepEqual(at(x, y), [stretchByte(v, 0, 9), stretchByte(v, 0, 9), stretchByte(v, 0, 9), 255], `pixel ${x}, ${y}`);
    }
  }
  assert.deepEqual(at(0, 0), [0, 0, 0, 255], 'the value 0, in the lowest row, is the first pixel of the last row of the canvas');
  assert.deepEqual([...rgba.subarray(8 * 4, 8 * 4 + 4)], [0, 0, 0, 255]);
  assert.deepEqual(at(1, 2), [255, 255, 255, 255], 'the value 9');
  assert.deepEqual(at(0, 1), at(3, 2), 'the value 4 has the same grey in both places');
  assert.deepEqual(at(2, 2), [...DEFAULT_PALETTE.none, 255], 'no value');
  // the same stamp again, alone or beside another: the same bytes
  assert.deepEqual(greyRgba(data.slice(), 4, 3, limits), rgba);
});

test('a difference is grey below 3 times the noise, coloured above, and full at 5 and beyond', () => {
  const { neg, pos, none } = DEFAULT_PALETTE;
  const grey = (/** @type {number[]} */ c) => c[0] === c[1] && c[1] === c[2];
  for (const u of [0, 0.5, -0.5, 1, -1, 2.9, -2.9, 2.999, -2.999]) assert.ok(grey(diffRgb(u)), `${u} is grey`);
  for (const u of [3, -3, 3.5, -3.5, 4, -4, 5, -5, 50, -50]) assert.ok(!grey(diffRgb(u)), `${u} is coloured`);
  assert.deepEqual(diffRgb(DIFF_RANGE), pos);
  assert.deepEqual(diffRgb(-DIFF_RANGE), neg);
  assert.deepEqual(diffRgb(12), pos, 'the scale is fixed: beyond its end nothing changes');
  assert.deepEqual(diffRgb(-1e6), neg);
  assert.deepEqual(diffRgb(Infinity), none);
  assert.deepEqual(diffRgb(NaN), none);
  assert.ok(diffRgb(-2)[0] < diffRgb(0)[0] && diffRgb(0)[0] < diffRgb(2)[0], 'inside the grey, fainter is darker and brighter is lighter');
  assert.deepEqual(diffRgb(-0), diffRgb(0));
  // towards the end of the scale the colour only grows
  const closeness = (/** @type {number[]} */ c, /** @type {number[]} */ to) => Math.hypot(c[0] - to[0], c[1] - to[1], c[2] - to[2]);
  for (let u = 3; u < 5; u += 0.1) {
    assert.ok(closeness(diffRgb(u + 0.1), pos) <= closeness(diffRgb(u), pos));
    assert.ok(closeness(diffRgb(-u - 0.1), neg) <= closeness(diffRgb(-u), neg));
  }
  const other = { neg: /** @type {[number, number, number]} */ ([1, 2, 3]), pos: /** @type {[number, number, number]} */ ([4, 5, 6]), none: /** @type {[number, number, number]} */ ([7, 8, 9]) };
  assert.deepEqual([diffRgb(9, other), diffRgb(-9, other), diffRgb(NaN, other)], [[4, 5, 6], [1, 2, 3], [7, 8, 9]], 'the colours are the ones handed in');

  const data = new Float32Array([-9, -1, 0, 1, 9, NaN]);
  const rgba = diffRgba(data, 3, 2);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) assert.deepEqual([...rgba.subarray(((1 - y) * 3 + x) * 4, ((1 - y) * 3 + x) * 4 + 4)], [...diffRgb(data[y * 3 + x]), 255]);
  }
});

test('marks: saturation and defects are hatched, a known source alone is not, a missing value counts as saturated', () => {
  const all = [...stamps, ...FRAME_IDS.map((id) => { const f = loadFrame(id); return { data: f.data, flags: f.flags }; })];
  let sourceOnly = 0, saturated = 0, defect = 0, missing = 0;
  for (const s of all) {
    const flags = /** @type {Int32Array} */ (s.flags);
    const m = pictureMasks(s);
    assert.ok(m.source && m.veiled === null);
    for (let i = 0; i < s.data.length; i++) {
      const w = flags[i], none = !Number.isFinite(s.data[i]);
      assert.equal(m.saturated[i], (w & SATURATION_MASK) !== 0 || none ? 1 : 0);
      assert.equal(m.defect[i], (w & DEFECT_MASK) !== 0 ? 1 : 0);
      assert.equal(m.source[i], (w & SOURCE_MASK) !== 0 ? 1 : 0);
      if (none) { missing++; assert.equal(m.saturated[i], 1); }
      if (w === SOURCE_MASK && !none) { sourceOnly++; assert.deepEqual([m.saturated[i], m.defect[i], m.source[i]], [0, 0, 1]); }
      saturated += m.saturated[i];
      defect += m.defect[i];
    }
  }
  // the fixtures hold all the cases, and a known source alone is by far the most common
  assert.ok(sourceOnly > 20000 && saturated > 100 && defect > 500 && missing > 30, `${sourceOnly} ${saturated} ${defect} ${missing}`);

  const byHand = pictureMasks({
    data: new Float32Array([1, 1, 1, NaN, 1, 1]),
    flags: new Int32Array([0, 1 << 21, 1 << 1, 0, 1 << 12, (1 << 0) | (1 << 26) | (1 << 21)]),
    matched: new Uint8Array([1, 0, 1, 1, 0, 1]),
  });
  assert.deepEqual([...byHand.saturated], [0, 0, 1, 1, 0, 1]);
  assert.deepEqual([...byHand.defect], [0, 0, 0, 0, 0, 1]);
  assert.deepEqual([.../** @type {Uint8Array} */ (byHand.source)], [0, 1, 0, 0, 0, 1]);
  assert.deepEqual([.../** @type {Uint8Array} */ (byHand.veiled)], [0, 1, 0, 0, 1, 0], 'veiled where the colours do not match');
  const bare = pictureMasks({ data: new Float32Array([1, NaN]), flags: null });
  assert.deepEqual([[...bare.saturated], [...bare.defect], bare.source, bare.veiled], [[0, 1], [0, 0], null, null], 'without flags only a missing value is marked');
});

test('the curtain takes whole columns: at its two ends it is one picture, bit for bit', () => {
  const a = stamps[0].data, b = stamps[2].data;
  const bits = (/** @type {Float32Array} */ v) => new Uint32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  assert.deepEqual(bits(curtainOf(a, b, W, H, 0)), bits(b), 'no column from the earlier visit: the later visit');
  assert.deepEqual(bits(curtainOf(a, b, W, H, W)), bits(a), 'every column from the earlier visit');
  const half = curtainOf(a, b, W, H, 20), hb = bits(half), ab = bits(a), bb = bits(b);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert.equal(hb[y * W + x], (x < 20 ? ab : bb)[y * W + x]);
  assert.ok(half !== a && half !== b && bits(a).every((v, i) => v === bits(stamps[0].data)[i]), 'the pictures themselves are not written to');

  const limits = displayLimits([a, b]), ra = greyRgba(a, W, H, limits), rb = greyRgba(b, W, H, limits);
  assert.deepEqual(curtainOf(ra, rb, W, H, 0, 4), rb);
  assert.deepEqual(curtainOf(ra, rb, W, H, W, 4), ra);
  const mixed = curtainOf(ra, rb, W, H, 40, 4);
  for (let row = 0; row < H; row++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) assert.equal(mixed[(row * W + x) * 4 + c], (x < 40 ? ra : rb)[(row * W + x) * 4 + c]);

  assert.deepEqual([curtainSplit(0, 64), curtainSplit(1, 64), curtainSplit(0.5, 64), curtainSplit(0.26, 64), curtainSplit(-3, 64), curtainSplit(7, 64), curtainSplit(NaN, 64)], [0, 64, 32, 17, 0, 64, 32]);
});

test('the outline of a mask: one rectangle for each run of pixels, the lowest row at the bottom', () => {
  //   y = 1:  . # # .
  //   y = 0:  # . . #
  const mask = new Uint8Array([1, 0, 0, 1, 0, 1, 1, 0]);
  assert.equal(maskPath(mask, 4, 2), 'M0 1h1v1h-1zM3 1h1v1h-1zM1 0h2v1h-2z');
  assert.equal(maskPath(new Uint8Array(8), 4, 2), '');
  assert.equal(maskPath(null, 4, 2), '');
  assert.equal(maskPath(new Uint8Array(8).fill(1), 4, 2), 'M0 1h4v1h-4zM0 0h4v1h-4z');
  // every set pixel is covered exactly once
  const m = pictureMasks(stamps[0]).defect, path = maskPath(m, W, H);
  let area = 0;
  for (const [, len] of path.matchAll(/h(\d+)v1/g)) area += Number(len);
  assert.equal(area, m.reduce((n, v) => n + v, 0));
});

test('the scale bar is a round length that fits, drawn at 6.15 arcsec to a pixel', () => {
  assert.deepEqual(scaleBar(64), { arcsec: 60, pixels: 60 / 6.15 });
  assert.deepEqual(scaleBar(128), { arcsec: 120, pixels: 120 / 6.15 });
  assert.deepEqual(scaleBar(32), { arcsec: 30, pixels: 30 / 6.15 });
  assert.deepEqual(scaleBar(8), { arcsec: 10, pixels: 10 / 6.15 });
  for (const w of [8, 16, 33, 64, 100, 256, 2040]) assert.ok(scaleBar(w).pixels <= 0.3 * w && scaleBar(w).pixels > 0.1 * w, `${w}`);
  // the frames' own transforms give the same size of a pixel within half a percent
  for (const f of Object.values(sky.frames)) assert.ok(Math.abs(/** @type {any} */ (f).pixel_arcsec / PIXEL_ARCSEC - 1) < 0.005);
});

test('the compass points where astropy says north and east are, in all seven frames', () => {
  const angles = [];
  for (const [key, f] of Object.entries(sky.frames)) {
    const frame = /** @type {any} */ (f), c = compassOf(frame.sky);
    assert.ok(c, key);
    for (const [got, want] of [[c.north, frame.north], [c.east, frame.east]]) {
      assert.ok(Math.abs(got[0] - want[0]) < 1e-12 && Math.abs(got[1] - want[1]) < 1e-12, key);
      assert.ok(Math.abs(Math.hypot(got[0], got[1]) - 1) < 1e-12);
    }
    // east is a quarter turn from north, to the left when north is up (the sky seen from below). The distortion
    // of the camera bends that by up to a degree and a half (detector 4), which is why the two are drawn apart.
    const cross = c.north[0] * c.east[1] - c.north[1] * c.east[0], dot = c.north[0] * c.east[0] + c.north[1] * c.east[1];
    assert.ok(cross > 0.999 && Math.abs(dot) < 0.03, `${key}: ${cross} ${dot}`);
    angles.push(Math.round((Math.atan2(c.north[0], c.north[1]) * 180 / Math.PI + 360) % 360));
    assert.equal(angles.at(-1), Math.round(frame.north_angle) % 360);
  }
  // the two visits of the showcase are turned half a circle against each other: the compass must show it
  assert.deepEqual(angles.slice(3), [181, 181, 1, 1]);
  assert.equal(compassOf(null), null);
  assert.equal(compassOf(undefined), null);
  assert.equal(compassOf({ ra: 0, dec: 0, cd: [1, 2, 2, 4] }), null, 'a transform that cannot be turned round');
  assert.equal(compassOf(/** @type {any} */ ({ ra: 0, dec: 0, cd: [1, 0, NaN, 1] })), null);
  assert.deepEqual(compassOf({ ra: 0, dec: 0, cd: [-1, 0, 0, 1] }), { north: [0, 1], east: [-1, 0] }, 'north up, east left');
});

test('how far apart two colours are, and how far apart they may be', () => {
  for (const [i, j] of manifest.pairs) {
    const a = stamps[i], b = stamps[j], m = colourMatch(a, b);
    assert.ok(m && m.same);
    assert.equal(m.apart, Math.abs(a.lam - b.lam));
    assert.equal(m.allowed, MATCH_BANDWIDTH_FRACTION * Math.min(a.bw, b.bw));
    assert.ok(m.apart < 0.001 && m.allowed > 0.018 && m.allowed < 0.02, 'as the description of the fixture says');
  }
  const off = colourMatch(stamps[0], stamps[3]);
  assert.ok(off && !off.same && off.apart > 0.07);
  assert.equal(colourMatch({ lam: NaN, bw: 0.03 }, { lam: 4, bw: 0.03 }), null);
  assert.deepEqual(colourMatch({ lam: 4, bw: 0.04 }, { lam: 4.01, bw: 0.02 }), { apart: 0.009999999999999787, allowed: 0.01, same: true });
});

test('dates on screen are UTC, and the fixture shows the ones in its description', () => {
  const want = ['25 Aug 2025, 17:09 UTC', '25 Aug 2025, 17:13 UTC', '15 Mar 2026, 00:51 UTC', '15 Mar 2026, 07:18 UTC'];
  assert.deepEqual(stamps.map((s) => formatDate(s.mjd, true)), want);
  assert.deepEqual(stamps.map((s) => formatDate(s.mjd)), ['25 Aug 2025', '25 Aug 2025', '15 Mar 2026', '15 Mar 2026']);
  assert.equal(formatDate(40587), '1 Jan 1970');
  assert.equal(formatDate(51544.5, true), '1 Jan 2000, 12:00 UTC');
  assert.equal(formatDate(NaN), 'date unknown');
});

test('a colour of the tokens is read as three numbers', () => {
  assert.deepEqual(parseHexColour('#4f9dff'), [79, 157, 255]);
  assert.deepEqual(parseHexColour('  #FF9A3D '), [255, 154, 61]);
  assert.equal(parseHexColour('rgb(1 2 3)'), null);
  assert.equal(parseHexColour(''), null);
  assert.deepEqual([parseHexColour('#4f9dff'), parseHexColour('#ff9a3d'), parseHexColour('#3b3521')], [DEFAULT_PALETTE.neg, DEFAULT_PALETTE.pos, DEFAULT_PALETTE.none]);
});
