// V3: the frame map. One dot for every photo the index lists for a position, in the right place for its date and colour, quick
// with the 21,000 photos of a deep field, readable at 360 pixels, and the same photo whichever way it is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout, indexDots, framesInBand, dotState, dotText, summaryText, timeTicks, DENSE_ABOVE, HIT_PX } from '../../site/js/ui/framemap.js';
import { rng } from '../fixtures/v3/make.mjs';
import { readJson } from '../helpers/fixtures.mjs';
import { visits } from '../../site/js/lib/visits.js';

const expected = readJson('idx', 'expected.json');

/** The frames of the index fixture as map frames. Their colour is not in the index; it is spread over each detector's range. */
function indexFrames() {
  const vs = visits(expected.frames), visitOf = new Map();
  vs.forEach((v, i) => v.frames.forEach((f) => visitOf.set(f.key, i)));
  const range = { 1: [0.75, 1.1], 2: [1.1, 1.62], 3: [1.62, 2.42], 4: [2.42, 3.82], 5: [3.82, 4.42], 6: [4.42, 5.0] };
  const r = rng(5);
  return expected.frames.map((f) => ({ key: f.key, det: f.det, mjd: f.tmid, lam: range[f.det][0] + r() * (range[f.det][1] - range[f.det][0]), bw: 0.03, visit: visitOf.get(f.key), loaded: false, flagged: false }));
}

test('one dot for each photo the index lists: 342 at the fixture position, none left out', () => {
  const frames = indexFrames();
  assert.equal(frames.length, 342);
  const lay = layout(frames, 640, 230);
  assert.equal(lay.dots.length, expected.frames.length);
  assert.equal(lay.skipped, 0);
  assert.deepEqual(lay.dots.map((d) => d.frame.key), frames.map((f) => f.key), 'in the order of the list, each key once');
  assert.equal(new Set(lay.dots.map((d) => d.frame.key)).size, 342);
});

test('across is the date and up is the colour; every dot is inside the plotting area', () => {
  const frames = indexFrames();
  for (const width of [360, 640, 1000]) {
    const lay = layout(frames, width, 230);
    for (const d of lay.dots) {
      assert.ok(d.x >= lay.plot.l && d.x <= lay.plot.r, `x ${d.x} at ${width}`);
      assert.ok(d.y >= lay.plot.t && d.y <= lay.plot.b, `y ${d.y} at ${width}`);
    }
    const a = lay.dots.find((d) => d.frame.mjd === Math.min(...frames.map((f) => f.mjd))), b = lay.dots.find((d) => d.frame.mjd === Math.max(...frames.map((f) => f.mjd)));
    assert.ok(a.x < b.x);
    const lo = lay.dots.find((d) => d.frame.lam === Math.min(...frames.map((f) => f.lam))), hi = lay.dots.find((d) => d.frame.lam === Math.max(...frames.map((f) => f.lam)));
    assert.ok(hi.y < lo.y, 'longer wavelengths are higher up');
    assert.ok(Math.abs(lay.lamOf(lay.yOf(3.3)) - 3.3) < 1e-9);
  }
});

test('the visits are shaded: one band for each, in time order, each holding the dots of its visit', () => {
  const frames = indexFrames(), lay = layout(frames, 640, 230);
  const n = new Set(frames.map((f) => f.visit)).size;
  assert.equal(lay.bands.length, n);
  assert.ok(n >= 2);
  for (let i = 1; i < lay.bands.length; i++) assert.ok(lay.bands[i].x0 > lay.bands[i - 1].x0);
  for (const d of lay.dots) {
    const b = lay.bands.find((q) => q.visit === d.frame.visit);
    assert.ok(d.x >= b.x0 && d.x <= b.x1);
  }
  assert.equal(lay.bands.reduce((s, b) => s + b.n, 0), 342);
});

test('hollow is flagged, grey is indexed and not loaded, filled is loaded', () => {
  assert.equal(dotState({ loaded: true, flagged: false }), 'loaded');
  assert.equal(dotState({ loaded: true, flagged: true }), 'flagged');
  assert.equal(dotState({ loaded: false, flagged: false }), 'indexed');
  assert.equal(dotState({ loaded: false, flagged: true }), 'flagged');
});

test('21,000 dots (a deep field) are laid out, indexed and searched in well under a second; a loaded dot wins a near tie', () => {
  const r = rng(9);
  const frames = Array.from({ length: 21000 }, (_, i) => ({
    key: `dr1/level2/2025W20_1A/l2b-v27-2026-196/${(i % 6) + 1}/level2_2025W20_1A_${String(i % 9999).padStart(4, '0')}_${i % 4}D${(i % 6) + 1}_spx_l2b-v27-2026-196.fits#${i}`,
    det: (i % 6) + 1, mjd: 60800 + r() * 360, lam: 0.75 + r() * 4.25, bw: 0.03, visit: Math.floor(i / 3500), loaded: i < 12, flagged: i % 97 === 0,
  }));
  const t0 = performance.now();
  const lay = layout(frames, 640, 230);
  const index = indexDots(lay.dots);
  let found = 0;
  for (let k = 0; k < 2000; k++) if (index.nearest(lay.plot.l + r() * 600, lay.plot.t + r() * 200) >= 0) found++;
  const ms = performance.now() - t0;
  assert.equal(lay.dots.length, 21000);
  assert.ok(lay.dots.length > DENSE_ABOVE);
  assert.ok(ms < 1000, `${ms} ms`);
  assert.ok(found > 1500, 'a dense field is almost everywhere under the pointer');
  console.log(`21000 dots: layout, index and 2000 searches in ${ms.toFixed(0)} ms`);
  // a loaded dot and an indexed one at the same place: the loaded one is found
  const spot = [{ x: 100, y: 100, frame: { loaded: false, key: 'a' } }, { x: 101.5, y: 100, frame: { loaded: true, key: 'b' } }];
  const i = indexDots(spot).nearest(100, 100);
  assert.equal(spot[i].frame.key, 'b');
  assert.equal(indexDots(spot).nearest(100 + HIT_PX + 40, 100), -1);
});

test('every dot is found by its own place, whatever the width', () => {
  const frames = indexFrames();
  for (const width of [360, 900]) {
    const lay = layout(frames, width, 230), index = indexDots(lay.dots);
    let hit = 0;
    for (const [i, d] of lay.dots.entries()) {
      const j = index.nearest(d.x, d.y, 0.5);
      if (j === i || (j >= 0 && Math.hypot(lay.dots[j].x - d.x, lay.dots[j].y - d.y) < 0.5)) hit++;
    }
    assert.equal(hit, lay.dots.length);
  }
});

test('a band of colour gives the photos in it, and of those the ones that are loaded', () => {
  const frames = indexFrames().map((f, i) => ({ ...f, loaded: i % 5 === 0 }));
  const got = framesInBand(frames, 4.5, 3.9);
  const all = frames.filter((f) => f.lam >= 3.9 && f.lam <= 4.5);
  assert.deepEqual(got.all, all.map((f) => f.key));
  assert.deepEqual(got.loaded, all.filter((f) => f.loaded).map((f) => f.key));
  assert.ok(got.loaded.length > 0 && got.loaded.length < got.all.length);
});

test('50 random bands: every photo asked of the page has a dot at its own place, and that dot names the same file', () => {
  const frames = indexFrames().map((f, i) => ({ ...f, loaded: i % 4 === 0 }));
  const lay = layout(frames, 640, 230), index = indexDots(lay.dots), r = rng(77);
  let asked = 0;
  for (let n = 0; n < 50; n++) {
    const y0 = lay.plot.t + r() * (lay.plot.b - lay.plot.t), y1 = lay.plot.t + r() * (lay.plot.b - lay.plot.t);
    const { loaded } = framesInBand(frames, lay.lamOf(y0), lay.lamOf(y1));
    for (const key of loaded) {
      const dot = lay.dots.find((d) => d.frame.key === key);
      assert.ok(dot, key);
      assert.ok(dot.y >= Math.min(y0, y1) - 1e-6 && dot.y <= Math.max(y0, y1) + 1e-6, 'the dot is inside the band');
      const j = index.nearest(dot.x, dot.y, 0.01);
      assert.equal(lay.dots[j].frame.key, key, 'pointing at the dot finds the same file');
      asked++;
    }
  }
  assert.ok(asked > 50);
});

test('the words for a dot: colour, date, file, state; "present in one photo only" when it is the only one', () => {
  const f = indexFrames()[0];
  const plain = dotText({ ...f, loaded: true, flagged: false });
  assert.match(plain, /µm/);
  assert.match(plain, /loaded/);
  assert.doesNotMatch(plain, /present in one photo only/);
  assert.match(dotText({ ...f, loaded: true, flagged: true }, { onlyOne: true }), /flagged.*present in one photo only/);
  assert.equal(summaryText(indexFrames().slice(0, 3)), '3 photos cover this position · 0 loaded');
  assert.match(summaryText([{ ...f, loaded: true, flagged: true }]), /^1 photo cover this position · 1 loaded · centre pixel saturated or damaged in 1$/);
});

test('the date axis has months that are far enough apart at 360 pixels and at 1000', () => {
  const frames = indexFrames();
  for (const width of [360, 1000]) {
    const ticks = timeTicks(layout(frames, width, 230));
    assert.ok(ticks.length >= 2, `${width}: ${ticks.length}`);
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].x - ticks[i - 1].x >= 50, `${width}: ${ticks[i].x - ticks[i - 1].x}`);
  }
  const t = timeTicks(layout(indexFrames(), 1000, 230));
  assert.match(t[0].text, /^[A-Z][a-z]{2} 20\d\d$/);
});

test('frames with no date or colour are left out of the map and counted', () => {
  const frames = [...indexFrames().slice(0, 5), { key: 'x', det: 1, mjd: NaN, lam: 1, bw: 0, visit: 0, loaded: false, flagged: false }];
  const lay = layout(frames, 400, 200);
  assert.equal(lay.dots.length, 5);
  assert.equal(lay.skipped, 1);
  assert.equal(layout([], 400, 200).dots.length, 0);
});
