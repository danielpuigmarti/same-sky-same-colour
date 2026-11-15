// V3: "Is it real?". Four answers for a blip, each with a value known in advance from the picture it was made in
// (tests/fixtures/v3/make.mjs); then the four real false positives of the pipeline, when their files are in the tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { assess, summaryText, NOT_KNOWN, CAUTION, choosePairs, itemsOf, residualAt, BACKYARD_WORLDS_URL, MPC_URL } from '../../site/js/ui/isitreal.js';
import { propagate } from '../../site/js/lib/gaia.js';
import { skyToPixel, nameStars, parseFast } from '../../site/js/ui/rings.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { makeField, gridSky, BIT } from '../fixtures/v3/make.mjs';

const SITE = new URL('../../site/', import.meta.url);
const BLIP = { x: 40, y: 25 };
const answers = (a) => [a.flagged.answer, a.pairs.answer, a.catalogue.answer, a.ring.answer];

/** Words that must never appear on the panel. */
const BANNED = /\b(new|candidates?|discover\w*)\b/i;

test('a blip in one photo only, no flag: not flagged, one pair, no star, no ring, and the line "not a known star"', () => {
  const { stamps, frames } = makeField({ shape: (v, k) => (v === 1 && k === 2 ? { blips: [{ ...BLIP, peak: 30 }] } : {}) });
  const a = assess({ pick: { x: BLIP.x, y: BLIP.y }, stamps, frames, stars: [] });
  assert.equal(a.ready, true);
  assert.deepEqual(answers(a), [false, false, false, false]);
  assert.equal(a.pairsShowing, 1);
  assert.equal(a.pairsTotal, 6);
  assert.equal(a.verdict, NOT_KNOWN);
  assert.equal(a.verdict, 'Not a known star; asteroids are not checked here.');
});

test('a blip on GHOST pixels in one photo: flagged, named, and still in one pair only', () => {
  const { stamps, frames } = makeField({ shape: (v, k) => (v === 1 && k === 2 ? { blips: [{ ...BLIP, peak: 30 }], flags: [{ ...BLIP, bit: BIT.GHOST }] } : {}) });
  const a = assess({ pick: { x: BLIP.x, y: BLIP.y }, stamps, frames, stars: [] });
  assert.deepEqual(answers(a), [true, false, false, false]);
  assert.deepEqual(a.flagNames, ['GHOST']);
  assert.match(a.flagged.text, /GHOST/);
  assert.match(a.verdict, /artefact/);
});

test('a blip on PERSIST pixels in one photo: flagged PERSIST', () => {
  const { stamps, frames } = makeField({ shape: (v, k) => (v === 0 && k === 4 ? { blips: [{ ...BLIP, peak: -30 }], flags: [{ ...BLIP, bit: BIT.PERSIST }] } : {}) });
  const a = assess({ pick: { x: BLIP.x, y: BLIP.y }, stamps, frames, stars: [] });
  assert.deepEqual(answers(a), [true, false, false, false]);
  assert.deepEqual(a.flagNames, ['PERSIST']);
});

test('a steady star that the archive marks as a source: in every pair, a catalogued source, not flagged', () => {
  const star = { x: 20, y: 40 };
  const { stamps, frames } = makeField({
    shape: (v) => ({ blips: [{ x: star.x + (v ? 0.4 : 0), y: star.y, peak: 250 }], flags: [{ ...star, bit: BIT.SOURCE, r: 3 }] }),
  });
  const a = assess({ pick: { x: star.x, y: star.y }, stamps, frames, stars: [] });
  assert.deepEqual(answers(a), [false, true, true, false]);
  assert.equal(a.pairsShowing, 6);
  assert.match(a.catalogue.text, /SOURCE/);
  assert.match(a.verdict, /known star/);
});

test('a change in every later photo with nothing else to explain it is not flagged, in every pair and unexplained', () => {
  const { stamps, frames } = makeField({ shape: (v) => (v === 1 ? { blips: [{ x: 45, y: 45, peak: 25 }] } : {}) });
  const a = assess({ pick: { x: 45, y: 45 }, stamps, frames, stars: [] });
  assert.deepEqual(answers(a), [false, true, false, false]);
  assert.equal(a.verdict, NOT_KNOWN);
});

test("Barnard's Star moving through the field is on its ring at the date of each photo, though it is not at its catalogue place", () => {
  const entries = JSON.parse(readFileSync(new URL('data/names.json', SITE), 'utf8')).entries;
  const cat = entries.find((e) => e.id === 'barnard').catalogue;
  const star = { ...cat, id: '4472832130942575872', g: 8.2 };
  const [ra0, dec0] = propagate(star, 60975);
  const sky = gridSky(ra0, dec0);
  const at = (mjd) => skyToPixel(sky, 32, 32, ...propagate(star, mjd));
  const field = makeField({
    sky, mjdA: 60900, mjdB: 61050,
    shape: (v, k, mjd) => { const [x, y] = at(mjd); return { blips: [{ x, y, peak: 40 }] }; },
  });
  // between the two visits it moves by more than half a pixel: the blips are placed by date, not by catalogue
  const [x0, y0] = at(60900), [x1, y1] = at(61050);
  assert.ok(Math.hypot(x1 - x0, y1 - y0) > 0.5);
  const fast = parseFast({ epoch: star.epoch, stars: [[star.id, star.ra, star.dec, star.pmra, star.pmdec, star.parallax, star.g]] });
  const a = assess({ pick: { x: x0, y: y0 }, stamps: field.stamps, frames: field.frames, stars: fast });
  assert.equal(a.ring.answer, true);
  assert.equal(a.rings.length, 1);
  assert.equal(a.rings[0].id, star.id);
  assert.equal(a.catalogue.answer, true, 'a bright fast star is a catalogued source too');
  assert.match(a.verdict, /known star/);
  // with the star left out of the list nothing explains the blip
  assert.equal(assess({ pick: { x: x0, y: y0 }, stamps: field.stamps, frames: field.frames, stars: [] }).ring.answer, false);
  assert.equal(nameStars(fast, entries)[0].name, "Barnard's Star");
});

test('the pick may be given by sky position instead of pixel', () => {
  const { sky, stamps, frames } = makeField({ shape: (v, k) => (v === 1 && k === 2 ? { blips: [{ ...BLIP, peak: 30 }] } : {}) });
  const D = Math.PI / 180;
  const ra = sky.ra + ((BLIP.x - 32) * sky.cd[0]) / Math.cos(sky.dec * D), dec = sky.dec + (BLIP.y - 32) * sky.cd[3];
  const a = assess({ pick: { ra, dec }, stamps, frames, stars: [] });
  assert.equal(a.ready, true);
  assert.deepEqual(answers(a), [false, false, false, false]);
});

test('with too little loaded the panel says what is missing and answers nothing', () => {
  const { stamps, frames } = makeField();
  assert.equal(assess({ pick: { x: 10, y: 10 }, stamps: stamps.slice(0, 6), frames, stars: [] }).ready, false, 'one visit only');
  assert.match(assess({ pick: {}, stamps, frames }).why, /Click/);
  const one = assess({ pick: { x: 10, y: 10 }, stamps: [stamps[0], stamps[6]], frames, stars: [] });
  assert.equal(one.ready, true);
  assert.equal(one.pairs.answer, null, 'one pair cannot say whether it is in more than one');
});

test('the selection on the stage decides which two visits are compared', () => {
  const { stamps, frames } = makeField();
  const items = itemsOf(stamps, frames);
  const c = choosePairs(items, []);
  assert.equal(c.pairs.length, 6);
  for (const [a, b] of c.pairs) assert.ok(Math.abs(a.stamp.lam - b.stamp.lam) < 0.0185);
  const s = choosePairs(items, [stamps[1].key, stamps[8].key]);
  assert.equal(s.a, 0);
  assert.equal(s.b, 1);
});

test('the residual of a pair is later minus earlier in units of the noise', () => {
  const { stamps } = makeField({ shape: (v, k) => (v === 1 && k === 0 ? { blips: [{ x: 30, y: 30, peak: 40 }] } : {}) });
  const r = residualAt(stamps[0], stamps[6], 30, 30);
  assert.ok(r.units > 10 && r.units < 40, String(r.units));
  assert.deepEqual([r.x, r.y], [30, 30]);
});

test('no sentence on the panel uses the words new, candidate or discovery; the closing line and both links are there', () => {
  const { stamps, frames } = makeField({ shape: (v, k) => (v === 1 && k === 2 ? { blips: [{ ...BLIP, peak: 30 }], flags: [{ ...BLIP, bit: BIT.GHOST }] } : {}) });
  for (const pick of [{ x: BLIP.x, y: BLIP.y }, { x: 10, y: 10 }, { x: 45, y: 45 }]) {
    const a = assess({ pick, stamps, frames, stars: [] });
    const text = [a.why, a.flagged.text, a.pairs.text, a.catalogue.text, a.ring.text, a.verdict, a.caution, summaryText(a)].join('\n');
    assert.doesNotMatch(text, BANNED);
    assert.equal(a.caution, 'Most blips that pass these checks are still artefacts or known objects.');
    assert.equal(a.caution, CAUTION);
  }
  assert.match(summaryText(assess({ pick: { x: BLIP.x, y: BLIP.y }, stamps, frames, stars: [] })), /nothing was stored or sent/);
  assert.match(BACKYARD_WORLDS_URL, /^https:\/\/www\.backyardworlds\.org\//);
  assert.match(MPC_URL, /^https:\/\/www\.minorplanetcenter\.net\//);
  for (const file of ['isitreal', 'panels', 'spectrum', 'framemap', 'rings']) {
    const src = readFileSync(new URL(`js/ui/${file}.js`, SITE), 'utf8');
    for (const call of ['localStorage', 'sessionStorage', 'indexedDB', 'sendBeacon', 'XMLHttpRequest']) assert.ok(!src.includes(call), `${file}: ${call}`);
  }
});

// The four real false positives, written by the pipeline (site/data/falsepos/cases.json). Each case says where to click and
// what each question must answer. Without the file, the two star showcases that are already in the tree are run alone.
const casesFile = new URL('data/falsepos/cases.json', SITE);

/** The photos of a showcase as the panels get them. @param {string} folder */
function showcaseStamps(folder) {
  const dir = new URL(`data/${folder}/`, SITE);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const stamps = decodeShowcase(manifest, readFileSync(new URL('stamps.bin', dir)), manifest.flags ? readFileSync(new URL('flags.bin', dir)) : null);
  return { manifest, stamps: stamps.map((s, i) => ({ ...s, sky: manifest.frames[i].sky ?? null })), frames: manifest.frames.map((f) => ({ key: f.key, visit: f.visit })) };
}

if (existsSync(casesFile)) {
  const doc = JSON.parse(readFileSync(casesFile, 'utf8'));
  for (const c of doc.cases) {
    test(`false positive "${c.id}": each of the four answers is the one its file expects`, () => {
      const { manifest, stamps, frames } = showcaseStamps(c.showcase);
      assert.ok(manifest.frames.every((f) => f.sky), 'the showcase is on the display grid');
      const click = c.residual.click.a;
      const a = assess({ pick: { x: click.x, y: click.y }, stamps, frames, stars: [] });
      assert.equal(a.ready, true, a.why);
      const e = c.expected;
      assert.equal(a.flagged.answer, e.flagged.answer, `flagged: ${a.flagged.text}`);
      assert.equal(a.pairs.answer, e.more_than_one_pair.answer, `pairs: ${a.pairs.text}`);
      assert.equal(a.catalogue.answer, e.bright_gaia_star_within_2px.answer, `catalogue: ${a.catalogue.text}`);
      assert.equal(a.ring.answer, e.on_fast_star_ring.answer, `ring: ${a.ring.text}`);
    });
  }
} else {
  for (const id of ['star-a', 'star-b']) {
    test(`false positive "${id}" (no cases.json yet): a steady bright star shows in several pairs and is a catalogued source`, () => {
      const { stamps, frames } = showcaseStamps(`falsepos/${id}`);
      const a = assess({ pick: { x: 32, y: 32 }, stamps, frames, stars: [] });
      assert.equal(a.ready, true, a.why);
      assert.equal(a.flagged.answer, false);
      assert.equal(a.pairs.answer, true, a.pairs.text);
      assert.equal(a.catalogue.answer, true, a.catalogue.text);
    });
  }
}
