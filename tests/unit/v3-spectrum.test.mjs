// V3: the spectrum of a clicked place. Fluxes against known sources, the states that give no curve, the change spectrum, the
// cost of loading every colour, and the precomputed spectrum of Epsilon Indi B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measure, spectrumFor, changeSpectrum, allColoursCost, parseShowcase, pixelSr, niceTicks, MIN_SNR, LIVE_LABEL } from '../../site/js/ui/spectrum.js';
import { itemsOf, choosePairs } from '../../site/js/ui/isitreal.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { bytesPerFrame } from '../../site/js/lib/livepath.js';
import { makeField, makeStamp, gridSky, rng, BIT, PIXEL_DEG } from '../fixtures/v3/make.mjs';

const SITE = new URL('../../site/', import.meta.url);
const STAR = { x: 30, y: 34 };

test('the flux of a Gaussian source is its sum over the aperture, times the pixel solid angle, in mJy', () => {
  const sky = gridSky(10, 20);
  const s = makeStamp({ key: 'k', mjd: 1, lam: 4.3, sky, blips: [{ ...STAR, peak: 50, sigma: 1.2 }], noise: 0.2, bg: 10 });
  const m = measure(s, STAR.x, STAR.y);
  assert.equal(m.state, 'ok');
  // the sum of the Gaussian over the pixels within 2 pixels of its centre, worked out by hand
  let sum = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (Math.hypot(x - STAR.x, y - STAR.y) <= 2) sum += 50 * Math.exp(-((x - STAR.x) ** 2 + (y - STAR.y) ** 2) / (2 * 1.2 ** 2));
  const want = sum * PIXEL_DEG ** 2 * (Math.PI / 180) ** 2 * 1e9;
  assert.ok(Math.abs(m.flux - want) < 0.03 * want, `${m.flux} against ${want}`);
  assert.ok(m.snr > 30);
  assert.ok(Math.abs(pixelSr(s) - PIXEL_DEG ** 2 * (Math.PI / 180) ** 2) < 1e-18);
  assert.ok(Math.abs(pixelSr({ w: 1, h: 1 }) - (6.15 / 3600 * Math.PI / 180) ** 2) < 1e-18, 'without a sky, 6.15 arcsec');
});

test('one curve for each visit, by colour; every point is a photo and carries its key, colour and date', () => {
  const { stamps, frames } = makeField({ shape: () => ({ blips: [{ ...STAR, peak: 40 }] }) });
  const items = itemsOf(stamps, frames);
  const sp = spectrumFor(items, STAR.x, STAR.y);
  assert.equal(sp.state, 'ok');
  assert.equal(sp.curves.length, 2);
  assert.equal(sp.points.length, 12);
  for (const c of sp.curves) {
    assert.equal(c.points.length, 6);
    assert.deepEqual(c.points.map((p) => p.lam), [...c.points.map((p) => p.lam)].sort((a, b) => a - b));
  }
  for (const p of sp.points) {
    const s = stamps.find((q) => q.key === p.key);
    assert.equal(p.lam, s.lam);
    assert.equal(p.mjd, s.mjd);
    assert.equal(p.det, s.det);
  }
  assert.equal(new Set(sp.points.map((p) => p.key)).size, 12);
  assert.match(LIVE_LABEL, /^relative, not aperture-corrected$/);
});

test('a place where the pixels are saturated gives no curve and says why; so does an empty place', () => {
  const sat = makeField({ shape: () => ({ blips: [{ ...STAR, peak: 4000 }], flags: [{ ...STAR, bit: BIT.OVERFLOW, r: 2.5 }] }) });
  const a = spectrumFor(itemsOf(sat.stamps, sat.frames), STAR.x, STAR.y);
  assert.equal(a.state, 'too-bright');
  assert.deepEqual(a.curves, []);
  assert.match(a.why, /saturated/);
  const empty = makeField();
  const b = spectrumFor(itemsOf(empty.stamps, empty.frames), STAR.x, STAR.y);
  assert.equal(b.state, 'too-faint');
  assert.deepEqual(b.points, []);
  assert.match(b.why, new RegExp(`${MIN_SNR} times`));
  const some = makeField({ shape: (v, k) => (k === 0 ? { blips: [{ ...STAR, peak: 4000 }], flags: [{ ...STAR, bit: BIT.OVERFLOW, r: 2.5 }] } : { blips: [{ ...STAR, peak: 40 }] }) });
  const c = spectrumFor(itemsOf(some.stamps, some.frames), STAR.x, STAR.y);
  assert.equal(c.state, 'ok', 'two saturated photos of twelve do not stop the curve');
  assert.equal(c.points.length, 10);
  assert.equal(c.saturated, 2);
});

test('a flagged aperture leaves the photo out; the others still make a curve', () => {
  const { stamps, frames } = makeField({ shape: (v, k) => ({ blips: [{ ...STAR, peak: 40 }], flags: k === 3 ? [{ ...STAR, bit: BIT.GHOST, r: 1 }] : [] }) });
  const sp = spectrumFor(itemsOf(stamps, frames), STAR.x, STAR.y);
  assert.equal(sp.state, 'ok');
  assert.equal(sp.points.length, 10);
  assert.equal(sp.flagged, 2);
  assert.ok(!sp.points.some((p) => p.key === stamps[3].key));
});

test('the change spectrum is the later visit over the earlier one at each matched colour', () => {
  const { stamps, frames } = makeField({ shape: (v) => ({ blips: [{ ...STAR, peak: v ? 60 : 30 }] }) });
  const items = itemsOf(stamps, frames);
  const sp = spectrumFor(items, STAR.x, STAR.y);
  const ch = changeSpectrum(sp, items);
  assert.equal(ch.points.length, 6);
  assert.equal(ch.pairs, 6);
  assert.equal(ch.faint, 0);
  for (const p of ch.points) {
    assert.ok(Math.abs(p.ratio - 2) < 0.15, String(p.ratio));
    const a = stamps.find((s) => s.key === p.keyA), b = stamps.find((s) => s.key === p.keyB);
    assert.ok(a.mjd < b.mjd);
    assert.ok(Math.abs(p.lam - (a.lam + b.lam) / 2) < 1e-12);
  }
  const pairs = choosePairs(items);
  assert.deepEqual(ch.points.map((p) => [p.keyA, p.keyB]).sort(), pairs.pairs.map(([a, b]) => [a.key, b.key]).sort());
  // a source that is faint in the earlier visit gives no ratio there, and the panel counts them
  const f = makeField({ shape: (v) => ({ blips: [{ ...STAR, peak: v ? 40 : 0.1 }] }) });
  const fi = itemsOf(f.stamps, f.frames), fsp = spectrumFor(fi, STAR.x, STAR.y);
  const fch = changeSpectrum(fsp, fi);
  assert.equal(fch.faint, 6);
  assert.equal(fch.points.length, 0);
  assert.equal(changeSpectrum(spectrumFor(items.slice(0, 6), STAR.x, STAR.y), items.slice(0, 6)), null, 'one visit: no change spectrum');
});

test('"load all colours" counts the photos of the detectors that are not loaded, in the two visits compared, and what they cost', () => {
  const { stamps, frames } = makeField();
  const items = itemsOf(stamps, frames);
  const others = [];
  for (const det of [2, 3, 6]) for (let visit = 0; visit < 2; visit++) for (let i = 0; i < 20; i++) others.push({ key: `d${det}v${visit}i${i}`, det, visit, loaded: false });
  const c = allColoursCost([...frames, ...others], items);
  assert.equal(c.photos, 3 * 2 * 8, 'at most 8 pairs for a detector: 8 photos in each of the two visits');
  assert.equal(c.bytes, c.photos * bytesPerFrame());
  assert.ok(c.seconds >= 1);
  assert.equal(allColoursCost(frames, items).photos, 0, 'nothing else to load');
  // a detector that has photos in one visit only cannot make pairs
  assert.equal(allColoursCost([...frames, ...others.filter((o) => o.det === 2 && o.visit === 0)], items).photos, 0);
});

test('the precomputed spectrum of Epsilon Indi B is read as curves, without the points the file marks unusable', () => {
  const doc = JSON.parse(readFileSync(new URL('data/spectra/eps-indi-b.json', SITE), 'utf8'));
  const sc = parseShowcase(doc);
  assert.equal(sc.id, 'eps-indi-b');
  assert.equal(sc.label, 'relative only');
  assert.equal(sc.visits.length, doc.visits.length);
  let usable = 0, total = 0;
  for (const [k, v] of doc.visits.entries()) {
    total += v.lam.length;
    usable += v.flags.filter((f) => (f & doc.mask) === 0).length;
    assert.equal(sc.visits[k].points.length, v.flags.filter((f, i) => (f & doc.mask) === 0 && Number.isFinite(v.flux[i])).length);
    for (const p of sc.visits[k].points) assert.ok(Number.isFinite(p.lam) && Number.isFinite(p.flux) && p.det >= 1 && p.det <= 6 && p.key.endsWith('.fits'));
  }
  assert.ok(usable > 100 && usable < total);
  assert.equal(parseShowcase({}), null);
});

test('live fluxes on the photos of the showcase agree with the precomputed ones to within the labelled "relative" scatter', () => {
  const dir = new URL('data/targets/eps-indi-b/', SITE);
  const man = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const stamps = decodeShowcase(man, readFileSync(new URL('stamps.bin', dir)), readFileSync(new URL('flags.bin', dir))).map((s, i) => ({ ...s, sky: man.frames[i].sky }));
  const sp = spectrumFor(itemsOf(stamps, man.frames.map((f) => ({ key: f.key, visit: f.visit }))), 32.3, 32.25);
  assert.equal(sp.state, 'ok');
  const pre = new Map(parseShowcase(JSON.parse(readFileSync(new URL('data/spectra/eps-indi-b.json', SITE), 'utf8'))).visits.flatMap((v) => v.points.map((p) => [p.key, p])));
  const ratios = sp.points.filter((p) => pre.has(p.key)).map((p) => p.flux / pre.get(p.key).flux).sort((a, b) => a - b);
  assert.ok(ratios.length >= 8);
  const median = ratios[ratios.length >> 1];
  console.log(`live over precomputed, ${ratios.length} photos: median ${median.toFixed(3)}`);
  assert.ok(median > 0.75 && median < 1.25, String(median));
});

test('round ticks cover the range', () => {
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  const t = niceTicks(4.17, 4.52, 5);
  assert.ok(t[0] >= 4.17 && t[t.length - 1] <= 4.52 + 1e-9 && t.length >= 3);
  assert.deepEqual(niceTicks(-1, 1, 4).includes(0), true);
  void rng;
});
