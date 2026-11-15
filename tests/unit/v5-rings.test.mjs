// V5: a named fast star that has no Gaia id (WISE 0855) is known to the rings, so that a click on it names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFast, nameStars, namedStars, ringsFor, loadFast, useStars } from '../../site/js/ui/rings.js';
import { assess, itemsOf } from '../../site/js/ui/isitreal.js';
import { gridSky, makeStamp } from '../fixtures/v3/make.mjs';

const SITE = new URL('../../site/', import.meta.url);
const names = JSON.parse(readFileSync(new URL('data/names.json', SITE), 'utf8')).entries;

test('the named fast targets that have no Gaia id are stars of the list; the ones that have one are not added twice', () => {
  const stars = namedStars(names);
  assert.deepEqual(stars.map((s) => s.id), ['wise0855']);
  const wise = stars[0];
  assert.match(wise.name, /^WISE 0855/);
  assert.equal(wise.g, null);
  assert.ok(Math.abs(wise.arcsecPerYear - 8.15) < 0.01);
  assert.deepEqual(namedStars([{ id: 'x', name: 'X', fast: true, catalogue: { ra: 1, dec: 2, epoch: 2000, pmra: 1, pmdec: 1, parallax: 10, source: 'Gaia DR3 123' } }]), []);
  assert.deepEqual(namedStars([{ id: 'x', name: 'X', fast: false, catalogue: { ra: 1, dec: 2, epoch: 2000, pmra: 1, pmdec: 1, parallax: 10, source: 'Paper' } }]), []);
  assert.deepEqual(namedStars([{ id: 'x', name: 'X', fast: true, catalogue: { ra: 1, dec: 2, epoch: 2000, pmra: 1, pmdec: 1, source: 'Paper' } }]), [], 'no parallax, no ring');
});

test('WISE 0855 has its ring on the centre of its own view, on the date of a photo', () => {
  const entry = names.find((n) => n.id === 'wise0855');
  const sky = gridSky(entry.ra, entry.dec);
  const wise = namedStars(names)[0];
  const rings = ringsFor({ sky, mjd: entry.mjd, size: { w: 44, h: 44 }, tx: 22, ty: 22, stars: [wise] });
  assert.equal(rings.length, 1);
  assert.ok(Math.hypot(rings[0].x - 22, rings[0].y - 22) < 1, `${rings[0].x}, ${rings[0].y}`);
  assert.equal(rings[0].name, wise.name);
});

test('a click on the faint object of WISE 0855 is answered with its name, not as unknown or as an artefact', () => {
  const entry = names.find((n) => n.id === 'wise0855');
  const sky = gridSky(entry.ra, entry.dec);
  const stars = namedStars(names);
  const blip = { x: 32, y: 32, peak: 30, sigma: 1 };
  const stamps = [
    makeStamp({ key: 'a', mjd: entry.mjd, lam: 1.3, sky, blips: [], noise: 0.5, bg: 5 }),
    makeStamp({ key: 'b', mjd: entry.mjd + 100, lam: 1.3, sky, blips: [blip], noise: 0.5, bg: 5 }),
  ];
  const a = assess({ pick: { x: 32, y: 32 }, stamps, frames: [{ key: 'a', visit: 0 }, { key: 'b', visit: 1 }], stars });
  assert.equal(a.ready, true);
  assert.equal(a.ring.answer, true);
  assert.match(a.ring.text, /WISE 0855/);
  assert.equal(a.verdict, 'This is probably a known star.');
  assert.ok(itemsOf(stamps, []).length === 2);
});

test('loadFast puts the named star after the Gaia stars, so that the rings of the page find it', async () => {
  const files = {
    'data/gaia/fast.json': { epoch: 2016, stars: [[111, 10, 10, 500, 500, 100, 12]] },
    'data/names.json': { entries: names },
  };
  const fetchFn = async (/** @type {string} */ url) => {
    const doc = files[/** @type {keyof typeof files} */ (url)];
    return { ok: Boolean(doc), json: async () => doc };
  };
  const got = await loadFast('', /** @type {any} */ (fetchFn));
  assert.deepEqual(got.map((s) => s.id), ['111', 'wise0855']);
  useStars([]);
  assert.equal(parseFast({ stars: [] }).length + nameStars([], names).length, 0);
});
