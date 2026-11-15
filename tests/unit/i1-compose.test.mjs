// What the stage is given for two visits (site/js/lib/compose.js): on photos made by hand, where the answer is
// known, and on the four real stamps of Barnard's Star in tests/fixtures/showcase/barnard-d5, with the sky that
// astropy gives their frames (tests/fixtures/v2/sky.json) and the motion that Gaia gives the star.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose, alignText, starsAgree, saturatedAtTarget, STANDS_OUT_UNITS } from '../../site/js/lib/compose.js';
import { DISPLAY_SIZE, PIXEL_DEG, toDisplayGrid, detectorPixel, cropSquare } from '../../site/js/lib/display.js';
import { coadd, FLAG_FULLSAMPLE, FLAG_SOURCE } from '../../site/js/lib/stack.js';
import { ALIGN_WARN_PX } from '../../site/js/lib/align.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { makeWavelengthAt } from '../../site/js/lib/wave.js';
import { propagate } from '../../site/js/lib/gaia.js';
import { skyToPixel } from '../../site/js/ui/rings.js';
import { pictureMasks } from '../../site/js/ui/stage.js';
import { DIFF_RANGE, MATCH_BANDWIDTH_FRACTION } from '../../site/js/contracts.js';
import { readJson, readBytes } from '../helpers/fixtures.mjs';

const bits = (/** @type {Float32Array} */ a) => Array.from(new Uint32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)));

/** A random number generator that gives the same numbers every time. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()) };
}

/** The colour of a detector pixel in these tests: it changes along y only, as on the real detectors. */
const COLOUR = { perRow: 0.0005, bw: 0.03 };
/** @type {(det: number, x: number, y: number) => {lam: number, bw: number}} */
const wavelengthAt = (det, x, y) => ({ lam: det + COLOUR.perRow * y, bw: COLOUR.bw });

/** The stars of the field made by hand: where they are from the target (pixels of the grid, east and north) and how bright. */
const STARS = [
  { east: 9, north: -6, peak: 60 }, { east: -11, north: 8, peak: 45 }, { east: 4, north: 13, peak: 80 },
  { east: -7, north: -12, peak: 50 }, { east: 14, north: 5, peak: 40 },
];

/**
 * A photo of the field: 64 by 64, the detector turned by `turn` degrees, the target at (tx, ty).
 * @param {{turn: number, tx?: number, ty?: number, stars?: {east: number, north: number, peak: number}[], background?: number,
 *   noise?: number, seed?: number, mjd?: number, key?: string, y0?: number, offset?: [number, number]}} o
 *   `offset`: the sky is drawn this many pixels (east, north) away from where the stamp says it is.
 */
function photo({ turn, tx = 32.3, ty = 31.6, stars = STARS, background = 0.4, noise = 0.02, seed = 1, mjd = 61000, key = `photo-${seed}`, y0 = 700, offset = [0, 0] }) {
  const w = 64, h = 64, r = rng(seed), t = turn * Math.PI / 180;
  const cd = /** @type {[number, number, number, number]} */ ([-PIXEL_DEG * Math.cos(t), PIXEL_DEG * Math.sin(t), PIXEL_DEG * Math.sin(t), PIXEL_DEG * Math.cos(t)]);
  const data = new Float32Array(w * h), flags = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const east = (cd[0] * (x - tx) + cd[1] * (y - ty)) / PIXEL_DEG - offset[0], north = (cd[2] * (x - tx) + cd[3] * (y - ty)) / PIXEL_DEG - offset[1];
      let v = background + noise * r.normal(), lit = false;
      for (const s of stars) {
        const add = s.peak * Math.exp(-((east - s.east) ** 2 + (north - s.north) ** 2) / (2 * 0.9 * 0.9));
        v += add;
        if (add > 3 * noise) lit = true;
      }
      data[y * w + x] = v;
      flags[y * w + x] = FLAG_FULLSAMPLE | (lit ? FLAG_SOURCE : 0);
    }
  }
  const at = wavelengthAt(2, 500 + tx, y0 + ty);
  return { key, det: /** @type {2} */ (2), mjd, w, h, x0: 500, y0, tx, ty, lam: at.lam, bw: at.bw, data, flags, sky: { ra: 150, dec: 20, cd } };
}

/**
 * Pairs of photos of two visits: the earlier one turned by 10 degrees, the later one by 157, as SPHEREx does.
 * @param {number} n @param {{later?: Partial<Parameters<typeof photo>[0]>, both?: Partial<Parameters<typeof photo>[0]>}} [how]
 * @returns {[ReturnType<typeof photo>, ReturnType<typeof photo>][]}
 */
function visits(n, { later = {}, both = {} } = {}) {
  return Array.from({ length: n }, (_, k) => [
    photo({ turn: 10 + k, tx: 32.3 - 0.2 * k, ty: 31.6 + 0.15 * k, background: 0.4 + 0.05 * k, seed: 10 + k, mjd: 60900 + k, y0: 700 + 40 * k, ...both }),
    photo({ turn: 157 - k, tx: 31.8 + 0.1 * k, ty: 32.4 - 0.2 * k, background: 0.7 + 0.03 * k, seed: 50 + k, mjd: 61100 + k, y0: 700 + 40 * k, ...both, ...later }),
  ]);
}

/** The pixel of a picture with the largest value within `r` of (x, y). @param {{w: number, data: Float32Array}} p @param {number} x @param {number} y @param {number} [r] */
function brightestNear(p, x, y, r = 2) {
  let best = -Infinity, at = [NaN, NaN];
  for (let j = Math.round(y - r); j <= Math.round(y + r); j++) {
    for (let i = Math.round(x - r); i <= Math.round(x + r); i++) {
      const v = p.data[j * p.w + i];
      if (Number.isFinite(v) && v > best) { best = v; at = [i, j]; }
    }
  }
  return at;
}

test('two visits turned by 147 degrees come out upright and on the same pixels, without their backgrounds', () => {
  const pairs = visits(4), got = compose(pairs, { wavelengthAt });
  assert.ok(got);
  const { a, b } = got.view, mid = DISPLAY_SIZE / 2;
  assert.deepEqual([a.w, a.h, a.tx, a.ty, b.w, b.h, got.size, got.pairs], [44, 44, mid, mid, 44, 44, 44, 4]);
  assert.deepEqual([a.photos, b.photos, a.key, a.det, a.mjd, b.mjd], [4, 4, '', 2, 60900, 61100]);
  assert.ok(Number.isNaN(a.lam) && Number.isNaN(a.x0), 'a picture made of four colours has no single colour and no single frame');
  assert.deepEqual(a.sky, { ra: 150, dec: 20, cd: [-PIXEL_DEG, 0, 0, PIXEL_DEG] });
  // every star is where the sky has it: east to the left, north up, the same pixel in both visits
  for (const s of STARS) {
    const want = [mid - s.east, mid + s.north];
    assert.deepEqual(brightestNear(a, want[0], want[1]), want, `earlier visit, star at ${s.east}, ${s.north}`);
    assert.deepEqual(brightestNear(b, want[0], want[1]), want, `later visit, star at ${s.east}, ${s.north}`);
  }
  // the sky between the stars is at zero in both, though it was 0.4 to 0.55 in one visit and 0.7 to 0.79 in the other
  for (const p of [a, b]) {
    const sky = Array.from(p.data).filter((v, k) => Number.isFinite(v) && !(/** @type {Int32Array} */ (p.flags)[k] & FLAG_SOURCE)).sort((x, y) => x - y);
    assert.ok(sky.length > 1000 && Math.abs(sky[Math.floor(sky.length / 2)]) < 0.01, `median of the sky ${sky[Math.floor(sky.length / 2)]}`);
  }
  // the co-add is the one stack.js makes of the photos put on the grid by nearest neighbour: nothing is interpolated.
  // The background of a photo is measured on the whole of its stamp (a grid of 64), and the middle 44 pixels are shown
  const whole = coadd(pairs.map(([p]) => { const g = toDisplayGrid(p, 64); return { data: g.data, flags: g.flags }; }), 64, 64);
  const want = cropSquare(whole.data, 64, 44);
  for (let k = 0; k < 44 * 44; k++) if (Number.isFinite(a.data[k])) assert.equal(a.data[k], want[k]);
  assert.equal(got.shown, a.data.filter(Number.isFinite).length);
  assert.ok(got.shown > 44 * 44 * 0.99, `nearly every pixel is shown: ${got.shown}`);
  // no difference unless it is asked for
  assert.equal(got.view.diff, null);
  assert.equal(got.sigma, null);
});

test('the alignment line: photos that line up say so with the number of stars, photos that do not get a warning', () => {
  const good = compose(visits(4), { wavelengthAt });
  assert.ok(good?.align);
  assert.ok(Math.hypot(/** @type {number} */ (good.align.dx), /** @type {number} */ (good.align.dy)) < 0.1, `${good.align.dx}, ${good.align.dy}`);
  assert.ok(good.align.n >= 3 && !good.align.warn);
  assert.match(/** @type {string} */ (good.view.note), /^Photos aligned to 0\.0\d px \([3-9] stars\)\.$/);
  // the later visit drawn 0.6 pixel east of where its stamps say it is
  const off = compose(visits(4, { later: { offset: [0.6, 0] } }), { wavelengthAt });
  assert.ok(off?.align && off.align.warn);
  assert.ok(Math.abs(Math.hypot(/** @type {number} */ (off.align.dx), /** @type {number} */ (off.align.dy)) - 0.6) < 0.1, `${off.align.dx}, ${off.align.dy}`);
  assert.ok(/** @type {number} */ (off.align.dx) < 0, 'east is to the left: the stars of the later visit lie at smaller x');
  assert.match(/** @type {string} */ (off.view.note), /^Warning: the two visits are 0\.[56]\d px apart \(\d stars\), more than 0\.3 px\./);
  assert.equal(ALIGN_WARN_PX, 0.3);
  // one pair is enough to measure it, and reading the photos between their pixels keeps the half pixel of nearest neighbour out
  const one = compose(visits(1), { wavelengthAt });
  assert.ok(one?.align && !one.align.warn && Math.hypot(/** @type {number} */ (one.align.dx), /** @type {number} */ (one.align.dy)) < 0.15);
  // an empty patch has no star to measure on
  const empty = compose(visits(2, { both: { stars: [] } }), { wavelengthAt });
  assert.equal(empty?.align?.n, 0);
  assert.equal(empty?.view.note, 'No star in this patch is bright enough to check how well the two visits line up.');
  assert.equal(alignText({ dx: 0.03, dy: 0.02, n: 1, warn: false, scatter: null, stars: [{ x: 20, y: 20, dx: 0.03, dy: 0.02, peak: 30 }] }), 'Photos aligned to 0.04 px (1 star).');
});

test('the alignment line gives a number only when most of the stars agree on it', () => {
  /** @param {[number, number][]} shifts @returns {import('../../site/js/lib/align.js').Alignment} */
  const measured = (shifts) => {
    const mid = (/** @type {number[]} */ v) => { const s = [...v].sort((p, q) => p - q); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const dx = mid(shifts.map((s) => s[0])), dy = mid(shifts.map((s) => s[1]));
    return { dx, dy, n: shifts.length, warn: Math.hypot(dx, dy) > ALIGN_WARN_PX, scatter: null, stars: shifts.map(([sx, sy], i) => ({ x: 10 + i, y: 10, dx: sx, dy: sy, peak: 20 })) };
  };
  // around a saturated star (R Draconis, detector 2): three bright places of its glare, each with a shift of its own
  const glare = measured([[-0.015625, 0.65625], [0.5625, -0.828125], [0.875, 2.21875]]);
  assert.equal(glare.warn, true);
  assert.equal(starsAgree(glare), false);
  assert.equal(alignText(glare), 'The 3 brightest places of this patch do not agree on how the two visits line up, so that cannot be checked here.');
  // a field with a fast star in it (Barnard's Star, detector 6): the star itself moved, the six others did not
  const mover = measured([[-0.046875, 0.578125], [0.046875, 0.015625], [-0.015625, 0.015625], [0.015625, 0.03125], [0.015625, 0], [-0.046875, -0.015625], [-0.046875, 0.046875]]);
  assert.equal(starsAgree(mover), true);
  assert.equal(alignText(mover), 'Photos aligned to 0.02 px (7 stars).');
  // stars that agree on a large shift: that is a misalignment, and the warning stands
  const apart = measured([[0.6, 0.02], [0.58, -0.03], [0.64, 0.05], [0.61, 0]]);
  assert.equal(starsAgree(apart), true);
  assert.match(alignText(apart), /^Warning: the two visits are 0\.6\d px apart \(4 stars\), more than 0\.3 px\./);
  // two stars that disagree by more than twice the limit, and an alignment without stars
  assert.equal(starsAgree(measured([[0, 0], [0.7, 0]])), false);
  assert.equal(starsAgree(measured([[0, 0], [0.4, 0]])), true);
  assert.equal(starsAgree({ dx: null, dy: null, n: 0, warn: false, scatter: null, stars: [] }), false);
});

test('the veil covers the pixels where the colours of a pair differ by more than half the bandwidth, and no others', () => {
  const pairs = visits(3), got = compose(pairs, { wavelengthAt });
  assert.ok(got?.view.a.matched);
  const matched = got.view.a.matched, size = 44;
  assert.equal(got.view.b.matched, matched);
  // worked out again, pixel by pixel, from the detector pixel behind each pixel of the grid in each photo
  const grids = pairs.map(([p, q]) => [toDisplayGrid(p, size), toDisplayGrid(q, size)]);
  let veiled = 0;
  for (let k = 0; k < size * size; k++) {
    let same = true;
    for (const [ga, gb] of grids) {
      const pa = detectorPixel(ga, k % size, Math.floor(k / size)), pb = detectorPixel(gb, k % size, Math.floor(k / size));
      assert.ok(pa && pb, 'a grid of 44 pixels lies inside a stamp of 64 at any turn');
      const ca = wavelengthAt(2, pa.x, pa.y), cb = wavelengthAt(2, pb.x, pb.y);
      if (!(Math.abs(ca.lam - cb.lam) <= MATCH_BANDWIDTH_FRACTION * Math.min(ca.bw, cb.bw))) same = false;
    }
    assert.equal(matched[k], same ? 1 : 0, `pixel ${k % size}, ${Math.floor(k / size)}`);
    if (!same) veiled++;
  }
  // the photos are matched at the target and drift apart away from it: the middle is clear, two edges are veiled
  assert.equal(matched[22 * size + 22], 1);
  assert.ok(veiled > 100 && veiled < size * size / 2, `${veiled} pixels veiled`);
  assert.ok(matched[1 * size + 22] === 0 && matched[42 * size + 22] === 0, 'the far north and south, where the two detectors run opposite ways');
  // each pair on its own has its own veil, never larger than the veil of all pairs together
  for (const [sa, sb] of got.singles) {
    assert.ok(sa.matched && sa.matched === sb.matched);
    for (let k = 0; k < size * size; k++) assert.ok(sa.matched[k] >= matched[k]);
  }
  // without the wavelength tables there is no veil to draw
  const bare = compose(pairs);
  assert.equal(bare?.view.a.matched, null);
  assert.equal(bare?.singles[0][0].matched, null);
});

test('every pair on its own is the two photos as they are, on the grid, with the detector pixel behind each pixel', () => {
  const pairs = visits(3), got = compose(pairs, { wavelengthAt });
  assert.ok(got);
  assert.equal(got.singles.length, 3);
  assert.equal(got.photos.length, 6);
  for (const [k, [sa, sb]] of got.singles.entries()) {
    for (const [side, s] of [sa, sb].entries()) {
      const want = toDisplayGrid(pairs[k][side], 44);
      assert.deepEqual(bits(s.data), bits(want.data));
      assert.deepEqual(s.flags, want.flags);
      assert.deepEqual([s.key, s.mjd, s.lam, s.x0, s.y0, s.w, s.tx], [pairs[k][side].key, pairs[k][side].mjd, pairs[k][side].lam, 500, 700 + 40 * k, 44, 22]);
      assert.deepEqual(s.sx, want.sx);
      assert.ok(s.blank && s.blank.every((v) => v === 0), 'no pixel of a 44 pixel grid lies outside a 64 pixel stamp');
      assert.equal(got.photos[2 * k + side], s);
    }
  }
  assert.deepEqual(got.view.a.members, got.singles.map(([s]) => s));
  assert.deepEqual(got.view.b.members, got.singles.map(([, s]) => s));
  // one pair alone: the picture is that photo without its background, and still says which photo and which colour
  const one = compose(visits(1), { wavelengthAt });
  assert.ok(one);
  const p = visits(1)[0][0];
  assert.deepEqual([one.view.a.key, one.view.a.lam, one.view.a.bw, one.view.a.x0, one.view.a.y0, one.view.a.photos], [p.key, p.lam, p.bw, p.x0, p.y0, 1]);
  assert.deepEqual(one.view.a.sx, toDisplayGrid(p, 44).sx);
});

test('a pixel is shown when half of the photos of a visit could be used there, and both visits show it', () => {
  const pairs = visits(4);
  // on the sky: 5 pixels east and 9 north of the target. A cosmic-ray hit there in one photo of the earlier visit,
  // a dead pixel there in three; and a saturated pixel 6 west, 4 south in every photo of the later visit
  const HIT = 1 << 0, DEAD = 1 << 6, FULL = 1 << 1;
  /** The stamp pixel of a photo at a place of the sky. @param {ReturnType<typeof photo>} p @param {number} east @param {number} north */
  const pixelOf = (p, east, north) => {
    const [x, y] = skyToPixel(p.sky, p.tx, p.ty, 150 + east * PIXEL_DEG / Math.cos(20 * Math.PI / 180), 20 + north * PIXEL_DEG);
    return Math.round(y) * p.w + Math.round(x);
  };
  pairs[0][0].flags[pixelOf(pairs[0][0], 5, 9)] |= HIT;
  for (const k of [1, 2, 3]) pairs[k][0].flags[pixelOf(pairs[k][0], -8, -9)] |= DEAD;
  for (const [, q] of pairs) { const at = pixelOf(q, -6, -4); q.flags[at] |= FULL; q.data[at] = NaN; }
  const got = compose(pairs, { wavelengthAt });
  assert.ok(got);
  const { a, b } = got.view, at = (/** @type {number} */ east, /** @type {number} */ north) => (22 + north) * 44 + (22 - east);
  const ma = pictureMasks(a), mb = pictureMasks(b);
  // one hit in four photos: the pixel is shown from the other three, and nothing is drawn on it
  assert.ok(Number.isFinite(a.data[at(5, 9)]) && Number.isFinite(b.data[at(5, 9)]));
  assert.deepEqual([ma.saturated[at(5, 9)], ma.defect[at(5, 9)], /** @type {Int32Array} */ (a.flags)[at(5, 9)] & HIT], [0, 0, 0]);
  // dead in three of four: no data in either picture; the earlier visit is hatched as damaged, the later one is left alone
  assert.ok(Number.isNaN(a.data[at(-8, -9)]) && Number.isNaN(b.data[at(-8, -9)]));
  assert.deepEqual([ma.saturated[at(-8, -9)], ma.defect[at(-8, -9)]], [0, 1]);
  assert.deepEqual([mb.saturated[at(-8, -9)], mb.defect[at(-8, -9)]], [0, 0]);
  // saturated in every photo of the later visit: no data in either; the later visit is hatched as too bright
  assert.ok(Number.isNaN(a.data[at(-6, -4)]) && Number.isNaN(b.data[at(-6, -4)]));
  assert.deepEqual([mb.saturated[at(-6, -4)], mb.defect[at(-6, -4)]], [1, 0]);
  assert.deepEqual([ma.saturated[at(-6, -4)], ma.defect[at(-6, -4)]], [0, 0]);
  // a pixel never has a value in one picture and none in the other
  for (let k = 0; k < 44 * 44; k++) assert.equal(Number.isFinite(a.data[k]), Number.isFinite(b.data[k]));
  // a known source is still marked, on request, where the picture is shown
  assert.ok(ma.source && ma.source[at(STARS[0].east, STARS[0].north)] === 1);
  // photos whose flags were not loaded: a missing value is all there is to go by, and it is hatched as too bright
  const bare = visits(2).map(([p, q]) => /** @type {[any, any]} */ ([{ ...p, flags: null }, { ...q, flags: null }]));
  for (const [p] of bare) p.data[pixelOf(p, 3, 3)] = NaN;
  const noFlags = compose(bare, { wavelengthAt });
  assert.ok(noFlags && noFlags.view.a.flags === null);
  assert.equal(pictureMasks(noFlags.view.a).saturated[at(3, 3)], 1);
  assert.equal(pictureMasks(noFlags.view.b).saturated[at(3, 3)], 0);
});

test('the difference, when asked for, is later minus earlier in units of the noise, over matched pixels only', () => {
  // something that is there in the later visit only: 6 pixels west and 7 north of the target
  const extra = [...STARS, { east: -6, north: 7, peak: 3 }];
  const got = compose(visits(4, { later: { stars: extra } }), { wavelengthAt, difference: true });
  assert.ok(got?.view.diff && got.sigma);
  const d = got.view.diff, at = (22 + 7) * 44 + (22 + 6);
  assert.deepEqual([d.w, d.h, d.tx, d.ty, d.sigma], [44, 44, 22, 22, got.sigma]);
  assert.ok(d.data[at] > 2 * DIFF_RANGE, `the new source stands at ${d.data[at]} times the noise`);
  // four photos a side with a noise of 0.02 each would give 0.014; reading a photo between its pixels averages
  // neighbours and takes about a third off, and the unit is the noise as it is measured on the co-adds themselves
  assert.ok(got.sigma > 0.007 && got.sigma < 0.0145, `the noise of four photos a side: ${got.sigma}`);
  assert.equal(got.signs.quiet, false);
  // away from the stars the difference is noise: its values scatter by about one unit around zero
  const quiet = Array.from(d.data).filter((v, k) => Number.isFinite(v) && Math.abs(v) < 3 && k !== at);
  const mean = quiet.reduce((s, v) => s + v, 0) / quiet.length, sd = Math.sqrt(quiet.reduce((s, v) => s + (v - mean) ** 2, 0) / quiet.length);
  assert.ok(quiet.length > 600 && Math.abs(mean) < 0.15 && sd > 0.5 && sd < 1.3, `${quiet.length} pixels, mean ${mean}, scatter ${sd}`);
  // pixels that are veiled are not compared, and carry no other mark
  const veil = /** @type {Uint8Array} */ (d.matched), marks = pictureMasks(d);
  let veiled = 0;
  for (let k = 0; k < 44 * 44; k++) {
    if (veil[k]) continue;
    veiled++;
    assert.ok(Number.isNaN(d.data[k]) && marks.saturated[k] === 0);
  }
  assert.ok(veiled > 100);
  // an empty patch: nothing reaches the full scale
  const empty = compose(visits(4, { both: { stars: [] } }), { wavelengthAt, difference: true });
  assert.ok(empty?.view.diff);
  assert.deepEqual(empty.signs, { tooBright: false, tooFaint: true, quiet: true });
});

test('what the pictures say about the position: too bright, too faint, or neither', () => {
  // a star on the target, well measured
  const star = [{ east: 0, north: 0, peak: 30 }, ...STARS];
  assert.deepEqual(compose(visits(3, { both: { stars: star } }), { wavelengthAt })?.signs, { tooBright: false, tooFaint: false, quiet: false });
  // nothing there
  assert.deepEqual(compose(visits(3, { both: { stars: STARS } }), { wavelengthAt })?.signs, { tooBright: false, tooFaint: true, quiet: false });
  assert.equal(STANDS_OUT_UNITS, 3);
  // a star that fills its pixels: the heart has no value and is flagged
  const bright = visits(3, { both: { stars: star } });
  for (const p of bright.flat()) {
    const k = Math.floor(p.ty + 0.5) * p.w + Math.floor(p.tx + 0.5);
    p.data[k] = NaN;
    p.flags[k] |= 1 << 1;
  }
  assert.ok(bright.flat().every(saturatedAtTarget));
  assert.equal(compose(bright, { wavelengthAt })?.signs.tooBright, true);
  // one saturated photo among six is not enough to say so
  const mostly = visits(3, { both: { stars: star } });
  mostly[0][0].flags[32 * 64 + 32] |= 1 << 15;
  assert.equal(compose(mostly, { wavelengthAt })?.signs.tooBright, false);
});

test('stamps that are already on the grid, as a showcase holds them, come out as they went in', () => {
  const first = compose(visits(3), { wavelengthAt });
  assert.ok(first);
  // the photos on the grid are stamps with the sky of the grid: put together again, they give the same pictures
  /** @type {[any, any][]} */
  const again = first.singles.map(([p, q]) => [p, q]);
  const second = compose(again, { size: 44, difference: true });
  assert.ok(second);
  for (const [k, [p, q]] of second.singles.entries()) {
    assert.deepEqual(bits(p.data), bits(first.singles[k][0].data));
    assert.deepEqual(bits(q.data), bits(first.singles[k][1].data));
    assert.deepEqual(p.flags, first.singles[k][0].flags);
    assert.ok(/** @type {Int32Array} */ (p.sx).every((v, i) => v === i % 44), 'each pixel of the grid is its own source');
  }
  // and the two pictures are the co-adds of those stamps, pixel for pixel
  for (const [side, picture] of [second.view.a, second.view.b].entries()) {
    const want = coadd(first.singles.map((pair) => ({ data: pair[side].data, flags: pair[side].flags })), 44, 44);
    for (let k = 0; k < 44 * 44; k++) if (Number.isFinite(picture.data[k])) assert.equal(picture.data[k], want.data[k]);
    assert.ok(picture.data.filter(Number.isFinite).length > 1900);
  }
  // the stars are on the same pixels as before
  for (const s of STARS) assert.deepEqual(brightestNear(second.view.a, 22 - s.east, 22 + s.north), brightestNear(first.view.a, 22 - s.east, 22 + s.north));
  assert.ok(second.view.diff, 'and a showcase gets its difference');
  assert.equal(second.view.a.matched, null, 'the detector pixels behind a showcase are not known, so it has no veil');
});

test('what cannot be put together is not: no pairs, or stamps without a sky', () => {
  assert.equal(compose([]), null);
  const [p, q] = visits(1)[0];
  assert.equal(compose([[p, { ...q, sky: undefined }]]), null);
  // photos with almost nothing left to measure: one pair is shown as it is, and the page is told
  const [a, b] = visits(1)[0];
  a.flags.fill(1 << 6);
  const poor = compose([[a, b]], { wavelengthAt });
  assert.ok(poor && poor.pairs === 0 && poor.align === null);
  assert.equal(poor.view.a, poor.singles[0][0]);
  assert.match(/** @type {string} */ (poor.view.note), /one pair is shown as it is/);
});

test("Barnard's Star, four real stamps: it lies where Gaia puts it on each date, in both visits, to within a pixel", () => {
  const manifest = readJson('showcase', 'barnard-d5', 'manifest.json');
  const stamps = decodeShowcase(manifest, readBytes('showcase', 'barnard-d5', 'stamps.bin'), readBytes('showcase', 'barnard-d5', 'flags.bin'));
  const sky = readJson('v2', 'sky.json').frames;
  const tables = makeWavelengthAt(readJson('wave', 'tables.json'));
  const withSky = stamps.map((s) => ({ ...s, sky: sky[s.key].sky }));
  /** @type {[any, any][]} */
  const pairs = manifest.pairs.map((/** @type {[number, number]} */ [i, j]) => [withSky[i], withSky[j]]);
  const got = compose(pairs, { wavelengthAt: tables });
  assert.ok(got);
  assert.equal(got.pairs, 2);
  // the two visits are turned half a circle on the detector: 181 and 1 degrees
  const turns = withSky.map((s) => Math.round((Math.atan2(s.sky.cd[1], s.sky.cd[3]) * 180 / Math.PI + 360) % 360));
  assert.deepEqual(turns, [181, 181, 1, 1]);

  const names = JSON.parse(readFileSync(new URL('../../site/data/names.json', import.meta.url), 'utf8'));
  const star = names.entries.find((/** @type {{id: string}} */ e) => e.id === 'barnard').catalogue;
  /** Where the star's light is in a picture: the centre of the light within 4 pixels of a place. @param {any} p @param {number} x @param {number} y */
  const centre = (p, x, y) => {
    const near = [];
    for (let j = 0; j < p.h; j++) for (let i = 0; i < p.w; i++) if (Math.hypot(i - x, j - y) <= 4 && Number.isFinite(p.data[j * p.w + i])) near.push([i, j, p.data[j * p.w + i]]);
    const floor = Math.min(...near.map((v) => v[2]));
    let sum = 0, sx = 0, sy = 0;
    for (const [i, j, v] of near) { sum += v - floor; sx += (v - floor) * i; sy += (v - floor) * j; }
    return [sx / sum, sy / sum];
  };
  /** @type {number[][]} */
  const where = [];
  for (const [k, pair] of got.singles.entries()) {
    for (const [side, p] of pair.entries()) {
      const [ra, dec] = propagate(star, p.mjd);
      const want = skyToPixel(/** @type {any} */ (p.sky), p.tx, p.ty, ra, dec);
      const have = centre(p, want[0], want[1]);
      const off = Math.hypot(have[0] - want[0], have[1] - want[1]);
      assert.ok(off < 1, `pair ${k}, ${side ? 'later' : 'earlier'} visit: the star is ${off.toFixed(2)} px from where Gaia puts it (${want.map((v) => v.toFixed(2))} against ${have.map((v) => v.toFixed(2))})`);
      where.push(want);
    }
  }
  // between the two visits the star itself moved by nearly a pixel, to the north: that is in the catalogue, not in the grid
  const moved = [where[1][0] - where[0][0], where[1][1] - where[0][1]];
  assert.ok(moved[1] > 0.7 && moved[1] < 1.1 && Math.abs(moved[0]) < 0.3, `moved by ${moved}`);
  // the field stars, which do not move, line up between the visits
  assert.ok(got.align && got.align.n >= 3, `${got.align?.n} stars`);
  assert.ok(Math.hypot(/** @type {number} */ (got.align.dx), /** @type {number} */ (got.align.dy)) < ALIGN_WARN_PX, `${got.align.dx}, ${got.align.dy}`);
  // the star fills its pixels in this detector, and the pictures say so
  assert.equal(got.signs.tooBright, true);
  // the colour of each pixel in the readout comes from the detector pixel behind it: at the target it is the photo's own
  const p = got.singles[0][0], at = detectorPixel(/** @type {any} */ (p), 22, 22);
  assert.ok(at && Math.abs(tables(5, at.x, at.y).lam - p.lam) < 0.0005);
});
