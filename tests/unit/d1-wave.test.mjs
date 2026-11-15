// D1: wavelength and bandwidth from the six small tables, against astropy's values at 1,200 reference pixels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readJson } from '../helpers/fixtures.mjs';
import { makeWavelengthAt, loadWaveTables, initWave, wavelengthAt } from '../../site/js/lib/wave.js';
import { makeWcs } from '../../site/js/lib/wcs.js';
import { parseFileStart } from '../../site/js/lib/fitsio.js';
import { loadFrame } from '../helpers/fixtures.mjs';

const tables = readJson('wave', 'tables.json');
const reference = readJson('wave', 'reference.json');

test('wavelengthAt agrees with the reference pixels within 1e-5 um in all six detectors', () => {
  const at = makeWavelengthAt(tables);
  for (const det of [1, 2, 3, 4, 5, 6]) {
    const r = reference[String(det)];
    assert.equal(r.x.length, 200);
    let worstLam = 0, worstBw = 0;
    for (let i = 0; i < r.x.length; i++) {
      const w = at(det, r.x[i], r.y[i]);
      worstLam = Math.max(worstLam, Math.abs(w.lam - r.lam[i]));
      worstBw = Math.max(worstBw, Math.abs(w.bw - r.bw[i]));
    }
    assert.ok(worstLam < 1e-5, `detector ${det}: wavelength off by ${worstLam}`);
    assert.ok(worstBw < 1e-5, `detector ${det}: bandwidth off by ${worstBw}`);
    console.log(`detector ${det}: worst wavelength error ${worstLam.toExponential(2)} um, bandwidth ${worstBw.toExponential(2)} um`);
  }
});

test('the tables of the site are the tables of the fixture', () => {
  const site = JSON.parse(readFileSync(new URL('../../site/data/wave/tables.json', import.meta.url), 'utf8'));
  const at = makeWavelengthAt(site), ref = makeWavelengthAt(tables);
  for (const det of [1, 2, 3, 4, 5, 6]) {
    for (const [x, y] of [[0, 0], [2039, 2039], [1020.5, 700.25], [13, 1900]]) {
      assert.ok(Math.abs(at(det, x, y).lam - ref(det, x, y).lam) < 1e-6 && Math.abs(at(det, x, y).bw - ref(det, x, y).bw) < 1e-6);
    }
  }
});

test('the wavelength is read at the pixel, not at the sky position: the distortion plays no part', () => {
  // the position of a pixel centre goes through the sky and back: the pixel is the same and so is its wavelength
  const f = loadFrame('eps-indi-d4');
  const head = parseFileStart(f.ranges[0].bytes);
  const wcs = makeWcs(head.image.h);
  const [ra, dec] = wcs.pix2world(500, 800);
  const [x, y] = wcs.world2pix(ra, dec);
  assert.ok(Math.abs(x - 500) < 1e-6 && Math.abs(y - 800) < 1e-6);
  const at = makeWavelengthAt(tables);
  assert.ok(Math.abs(at(4, x, y).lam - at(4, 500, 800).lam) < 1e-8);
});

test('wavelengthAt needs initWave; initWave takes tables or an address', async () => {
  assert.throws(() => wavelengthAt(2, 10, 10), /initWave/);
  await initWave(tables);
  assert.deepEqual(wavelengthAt(2, 10, 10), makeWavelengthAt(tables)(2, 10, 10));
  const served = async (url) => new Response(JSON.stringify(tables), { status: url.endsWith('tables.json') ? 200 : 404 });
  assert.equal(Object.keys(await loadWaveTables('http://x/tables.json', served)).length, 6);
  await assert.rejects(loadWaveTables('http://x/none.json', served), /404/);
  const five = { ...tables }; delete five['3'];
  await assert.rejects(loadWaveTables('http://x/tables.json', async () => new Response(JSON.stringify(five))), /detector 3/);
  assert.throws(() => makeWavelengthAt(five)(3, 1, 1), /detector 3/);
});
