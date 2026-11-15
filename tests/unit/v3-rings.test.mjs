// V3: the rings of known fast stars. A ring must land within 1 pixel of the star itself, at the date of each photo: Epsilon Indi B
// and Barnard's Star are found in the pictures of their showcases (data/targets/), where each photo was taken on another date and
// the star is somewhere else every time. The positions come from propagate() in lib/gaia.js, which the tests of D2 check against
// astropy to 0.01 pixel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { propagate } from '../../site/js/lib/gaia.js';
import { skyAt } from '../../site/js/ui/hover.js';
import { parseFast, nameStars, ringsFor, skyToPixel, useStars } from '../../site/js/ui/rings.js';
import { gridSky } from '../fixtures/v3/make.mjs';

const SITE = new URL('../../site/', import.meta.url);
const names = JSON.parse(readFileSync(new URL('data/names.json', SITE), 'utf8')).entries;

/** A target of names.json as a fast star. @param {string} id */
function starOf(id) {
  const e = names.find((n) => n.id === id);
  const m = /Gaia DR3 (\d+)/.exec(e.catalogue.source);
  return { ...e.catalogue, id: m[1], name: e.name, g: e.g_mag, arcsecPerYear: e.catalogue.speed_arcsec_per_year };
}

/** The photos of a showcase, each with the sky of its own picture. @param {string} id */
function pictures(id) {
  const dir = new URL(`data/targets/${id}/`, SITE);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const stamps = decodeShowcase(manifest, readFileSync(new URL('stamps.bin', dir)), readFileSync(new URL('flags.bin', dir)));
  return stamps.map((s, i) => ({ ...s, sky: manifest.frames[i].sky }));
}

/** Where the light of the star is in a photo: the centroid of the pixels above the sky within 2 pixels of the brightest one near `near`. */
function centroid(s, near) {
  const sorted = [...s.data].filter(Number.isFinite).sort((a, b) => a - b), sky = sorted[sorted.length >> 1];
  let best = -Infinity, bx = 0, by = 0;
  for (let y = Math.max(0, Math.round(near[1]) - 4); y <= Math.min(s.h - 1, Math.round(near[1]) + 4); y++) {
    for (let x = Math.max(0, Math.round(near[0]) - 4); x <= Math.min(s.w - 1, Math.round(near[0]) + 4); x++) {
      if (s.data[y * s.w + x] > best) { best = s.data[y * s.w + x]; bx = x; by = y; }
    }
  }
  let w = 0, sx = 0, sy = 0;
  for (let y = by - 2; y <= by + 2; y++) for (let x = bx - 2; x <= bx + 2; x++) { const v = s.data[y * s.w + x] - sky; if (v > 0) { w += v; sx += v * x; sy += v * y; } }
  return [sx / w, sy / w];
}

for (const id of ['eps-indi-b', 'barnard']) {
  test(`${id}: in every photo of its showcase the ring is within 1 pixel of the star, on the date of that photo`, () => {
    const star = starOf(id);
    const pics = pictures(id);
    assert.ok(pics.length >= 10);
    let worst = 0;
    const dates = new Set();
    for (const s of pics) {
      const rings = ringsFor({ sky: s.sky, mjd: s.mjd, size: { w: s.w, h: s.h }, tx: s.tx, ty: s.ty, stars: [star] });
      assert.equal(rings.length, 1, `the ring is in the picture of ${s.key}`);
      const [cx, cy] = centroid(s, [rings[0].x, rings[0].y]);
      const d = Math.hypot(rings[0].x - cx, rings[0].y - cy);
      worst = Math.max(worst, d);
      assert.ok(d < 1, `${s.key}: ${d.toFixed(2)} pixels`);
      dates.add(Math.round(s.mjd / 20));
    }
    assert.ok(dates.size >= 2, 'the photos span more than one date');
    console.log(`${id}: worst distance from the star ${worst.toFixed(2)} pixel over ${pics.length} photos`);
  });
}

test("Barnard's Star moves between the visits by what its proper motion says", () => {
  const star = starOf('barnard'), pics = pictures('barnard');
  const first = pics[0], last = pics[pics.length - 1];
  const a = ringsFor({ sky: first.sky, mjd: first.mjd, size: 64, stars: [star] })[0];
  const b = ringsFor({ sky: first.sky, mjd: last.mjd, size: 64, stars: [star] })[0];
  const years = (last.mjd - first.mjd) / 365.25;
  assert.ok(years > 0.3);
  const moved = Math.hypot(b.x - a.x, b.y - a.y), expected = (10.3933 * years) / 6.15;
  assert.ok(moved > 0.5);
  assert.ok(Math.abs(moved - expected) < 0.05 * expected + 0.1, `${moved} against ${expected}`);
});

test('skyToPixel turns skyAt round', () => {
  const sky = { ra: 331.0966, dec: -56.8007, cd: [-0.0017, 0.0004, 0.0003, 0.0017] };
  for (const [x, y] of [[0, 0], [63, 0], [12.5, 40.25], [32, 32], [63, 63]]) {
    const [ra, dec] = skyAt(sky, 32, 32, x, y);
    const [bx, by] = skyToPixel(sky, 32, 32, ra, dec);
    assert.ok(Math.hypot(bx - x, by - y) < 1e-6, `${x},${y}: ${bx},${by}`);
  }
});

test('a star outside the picture has no ring, and the quick cut loses none that the full test keeps', () => {
  const star = starOf('barnard');
  const sky = gridSky(...propagate(star, 61000));
  const here = ringsFor({ sky, mjd: 61000, size: 64, stars: [star] });
  assert.equal(here.length, 1);
  assert.ok(Math.hypot(here[0].x - 32, here[0].y - 32) < 0.01);
  const far = ringsFor({ sky: gridSky(sky.ra + 0.5, sky.dec), mjd: 61000, size: 64, stars: [star] });
  assert.equal(far.length, 0);
  // 25 years earlier it was 260 arcsec (42 pixels) to the south: inside a wide picture, outside a narrow one
  const early = ringsFor({ sky, mjd: 61000 - 25 * 365.25, size: 160, stars: [star] });
  assert.equal(early.length, 1);
  assert.ok(80 - early[0].y > 40 && 80 - early[0].y < 45, String(early[0].y));
  assert.equal(ringsFor({ sky, mjd: 61000 - 25 * 365.25, size: 64, stars: [star] }).length, 0);
  // the edge: a ring centred a pixel outside is still wanted so that part of it can be drawn, but not one far away
  const edge = ringsFor({ sky, mjd: 61000, size: 64, tx: 64.5, ty: 32, stars: [star] });
  assert.equal(edge.length, 1);
  assert.equal(ringsFor({ sky, mjd: 61000, size: 64, tx: 70, ty: 32, stars: [star] }).length, 0);
});

test('the file of fast stars is read in its own form, and stars without a parallax are left out', () => {
  const doc = { epoch: 2016, stars: [['1', 10, 20, 100, -200, 5, 12.3], ['2', 10, 20, 100, -200, null, 12], ['3', 11, 21, 300, 0, 9, null]] };
  const stars = parseFast(doc);
  assert.deepEqual(stars.map((s) => s.id), ['1', '3']);
  assert.equal(stars[0].name, 'Gaia DR3 1');
  assert.ok(Math.abs(stars[0].arcsecPerYear - Math.hypot(100, 200) / 1000) < 1e-12);
  assert.equal(stars[1].g, null);
  assert.deepEqual(parseFast(null), []);
  assert.equal(nameStars(stars, [{ name: 'A', catalogue: { source: 'Gaia DR3 3, ESA' } }])[1].name, 'A');
  useStars(stars);
  assert.equal(ringsFor({ sky: gridSky(10, 20), mjd: 57400, size: 64 }).length, 1, 'the stars in use are the default');
  useStars([]);
});

const fastFile = new URL('data/gaia/fast.json', SITE);
if (existsSync(fastFile)) {
  test('data/gaia/fast.json holds Barnard and Epsilon Indi B, and its rings agree with those from the names file', () => {
    const stars = nameStars(parseFast(JSON.parse(readFileSync(fastFile, 'utf8'))), names);
    assert.ok(stars.length > 100);
    for (const id of ['barnard', 'eps-indi-b']) {
      const ref = starOf(id), got = stars.find((s) => s.id === ref.id);
      assert.ok(got, `${id} (Gaia DR3 ${ref.id}) is in the list`);
      const [ra1, dec1] = propagate(got, 61041), [ra2, dec2] = propagate(ref, 61041);
      assert.ok(Math.hypot((ra1 - ra2) * Math.cos((dec1 * Math.PI) / 180), dec1 - dec2) * 3600 < 0.01, 'same place within 0.01 arcsec');
    }
  });
}
