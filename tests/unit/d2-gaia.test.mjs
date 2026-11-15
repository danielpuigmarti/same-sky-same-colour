// Catalogue propagation: gaia.js against astropy (tests/vectors/gaia.json): 10 stars on 4 dates, within 0.01 pixel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { propagate, offsetArcsec, separationDeg, epochToMjd } from '../../site/js/lib/gaia.js';

const vec = JSON.parse(readFileSync(new URL('../vectors/gaia.json', import.meta.url), 'utf8'));
/** One SPHEREx pixel, arcsec. */
const PIXEL = 6.15;

test('10 stars on 4 dates agree with astropy to within 0.01 pixel (0.06 arcsec)', () => {
  assert.equal(vec.stars.length, 10);
  assert.equal(vec.dates_mjd.length, 4);
  let worst = 0;
  for (const s of vec.stars) {
    for (const t of s.at) {
      const [ra, dec] = propagate(s, t.mjd);
      const [e, n] = offsetArcsec(t.ra, t.dec, ra, dec);
      worst = Math.max(worst, Math.hypot(e, n));
      assert.ok(Math.hypot(e, n) < 0.01 * PIXEL, `${s.name} at ${t.mjd}: ${Math.hypot(e, n)} arcsec`);
    }
  }
  assert.ok(worst < 0.01 * PIXEL);
  console.log(`worst difference from astropy: ${worst.toFixed(5)} arcsec`);
});

test('Barnard moves about 10.4 arcsec a year, with a parallax loop of about half an arcsec', () => {
  const b = vec.stars.find((/** @type {{name: string}} */ s) => s.name === "Barnard's Star");
  const [r1, d1] = propagate(b, epochToMjd(2026), { parallax: false });
  const [r2, d2] = propagate(b, epochToMjd(2027), { parallax: false });
  assert.ok(Math.abs(separationDeg(r1, d1, r2, d2) * 3600 - 10.4) < 0.05);
  const [ra, dec] = propagate(b, epochToMjd(2026));
  const off = Math.hypot(...offsetArcsec(r1, d1, ra, dec));
  assert.ok(off < 0.6);
});
