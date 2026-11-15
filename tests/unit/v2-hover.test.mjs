// The readout under the pointer (site/js/ui/hover.js): what it says about a pixel is what the stamp itself holds
// there, and the sky position and the colour agree with astropy and scipy (tests/fixtures/v2/sky.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagNames } from '../../site/js/lib/flags.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { colourLookup } from '../../site/js/ui/ruler.js';
import { readout, readingText, skyAt, localSky, tangentOffset, fileId, formatValue, formatSky } from '../../site/js/ui/hover.js';
import { BUCKET_URLS } from '../../site/js/contracts.js';
import { FRAME_IDS, loadFrame, readJson, readBytes } from '../helpers/fixtures.mjs';

const sky = readJson('v2', 'sky.json').frames;
const wavelengthAt = colourLookup(readJson('wave', 'tables.json'));

/** The distance between two sky positions, arcsec. @param {number[]} p @param {number[]} q */
const apart = (p, q) => 3600 * Math.hypot((p[0] - q[0]) * Math.cos(q[1] * Math.PI / 180), p[1] - q[1]);

/** The frame fixtures and the frames of the showcase, as pictures with their sky. */
function pictures() {
  const out = FRAME_IDS.map((id) => {
    const f = loadFrame(id);
    return { name: id, picture: { ...f.meta.stamp, data: f.data, flags: f.flags, sky: sky[f.meta.key].sky } };
  });
  const manifest = readJson('showcase', 'barnard-d5', 'manifest.json');
  const stamps = decodeShowcase(manifest, readBytes('showcase', 'barnard-d5', 'stamps.bin'), readBytes('showcase', 'barnard-d5', 'flags.bin'));
  for (const [i, s] of stamps.entries()) out.push({ name: `showcase frame ${i}`, picture: { ...s, sky: sky[s.key].sky } });
  return out;
}

test('at five points of each of seven stamps the readout is the stamp: value, flags, date, file, colour, sky', () => {
  let checked = 0, worst = 0;
  for (const { name, picture } of pictures()) {
    const ref = sky[picture.key];
    assert.equal(ref.points.length, 5);
    for (const p of ref.points) {
      const r = readout({ kind: 'a', picture, x: p.x, y: p.y }, { wavelengthAt });
      const i = p.y * picture.w + p.x, at = `${name}, pixel ${p.x}, ${p.y}`;
      // the stamp's own values, exactly
      assert.ok(Object.is(r.value, Number.isFinite(picture.data[i]) ? picture.data[i] : null), at);
      assert.equal(r.unit, 'MJy/sr');
      assert.equal(r.word, picture.flags[i], at);
      assert.deepEqual(r.flags, flagNames(picture.flags[i]), at);
      assert.equal(r.mjd, picture.mjd);
      assert.equal(r.id, picture.key.split('/').pop().slice('level2_'.length).split('_spx_')[0], at);
      assert.deepEqual([r.kind, r.x, r.y, r.photos], ['a', p.x, p.y, 1]);
      // the colour of that pixel of the detector, as scipy interpolates the table
      assert.ok(Math.abs(/** @type {number} */ (r.lam) - p.lam) < 1e-12 && Math.abs(/** @type {number} */ (r.bw) - p.bw) < 1e-12, at);
      // the sky position, as astropy computes it with the distortion terms
      const d = apart([/** @type {number} */ (r.ra), /** @type {number} */ (r.dec)], [p.ra, p.dec]);
      worst = Math.max(worst, d);
      assert.ok(d < 0.1, `${at}: ${d} arcsec from astropy`);
      checked++;
    }
  }
  assert.equal(checked, 35);
  assert.ok(worst < 0.1, `largest distance from astropy: ${worst} arcsec`);
});

test('the readout says what a pixel lacks instead of making it up', () => {
  const [{ picture }] = pictures();
  const none = picture.data.findIndex((v) => !Number.isFinite(v));
  assert.ok(none >= 0, 'the fixture has a pixel without a value');
  const r = readout({ kind: 'b', picture, x: none % picture.w, y: Math.floor(none / picture.w) }, { wavelengthAt });
  assert.equal(r.value, null);
  assert.ok(r.flags.includes('OVERFLOW') && r.flags.includes('SUR_ERROR'), 'a missing value is a pixel the star filled up');

  const bare = { ...picture, flags: null, sky: null };
  const b = readout({ kind: 'a', picture: bare, x: 3, y: 4 });
  assert.deepEqual([b.ra, b.dec, b.lam, b.bw, b.word, b.flags], [null, null, null, null, null, []]);
  assert.equal(b.value, picture.data[4 * picture.w + 3]);

  // a co-add is not one photo of one frame: no file, no colour by pixel
  const coadd = { ...picture, key: '', x0: NaN, y0: NaN, photos: 8 };
  const c = readout({ kind: 'a', picture: coadd, x: 3, y: 4 }, { wavelengthAt });
  assert.deepEqual([c.id, c.lam, c.photos], ['', null, 8]);

  // a difference is counted in units of the noise and has no flags, date or file
  const diff = { w: 2, h: 2, data: new Float32Array([0.5, -4, NaN, 7]), tx: 0.5, ty: 0.5, sky: picture.sky };
  const d = readout({ kind: 'diff', picture: diff, x: 1, y: 0 }, { wavelengthAt });
  assert.deepEqual([d.value, d.unit, d.word, d.flags, d.mjd, d.id, d.lam], [-4, 'noise', null, [], null, '', null]);
  assert.ok(d.ra !== null && d.dec !== null);
  assert.equal(readout({ kind: 'diff', picture: diff, x: 0, y: 1 }).value, null);
});

test('the flat sky of a picture gives back the target, and steps the way its numbers say', () => {
  for (const f of Object.values(sky)) {
    const { ra, dec, cd } = f.sky;
    assert.ok(apart(skyAt(f.sky, f.tx, f.ty, f.tx, f.ty), [ra, dec]) < 1e-9);
    assert.ok(apart([ra, dec], [f.target.ra, f.target.dec]) < 1e-4, 'the target pixel is where the target is');
    // one pixel to the right and one pixel up, measured back on the touching plane
    const right = tangentOffset(ra, dec, ...skyAt(f.sky, f.tx, f.ty, f.tx + 1, f.ty));
    const up = tangentOffset(ra, dec, ...skyAt(f.sky, f.tx, f.ty, f.tx, f.ty + 1));
    for (const [got, want] of [[right[0], cd[0]], [right[1], cd[2]], [up[0], cd[1]], [up[1], cd[3]]]) assert.ok(Math.abs(got - want) < 1e-12);
  }
  // across 0 hours, and near a pole
  const wrap = skyAt({ ra: 0.001, dec: 0, cd: [-0.0017, 0, 0, 0.0017] }, 0, 0, 10, 0);
  assert.ok(wrap[0] > 359.98 && wrap[0] < 360 && Math.abs(wrap[1]) < 1e-9);
  const pole = skyAt({ ra: 10, dec: 89.9, cd: [-0.0017, 0, 0, 0.0017] }, 0, 0, 0, 30);
  assert.ok(pole[1] > 89.9 && pole[1] <= 90);
});

test('localSky reads the flat sky off a transform', () => {
  // a plain gnomonic projection: reference pixel (100.5, 200.25), a matrix turned by 30 degrees with east to the left
  const D2R = Math.PI / 180, ra0 = 150, dec0 = -35, s = 6.15 / 3600, c = Math.cos(30 * D2R), sn = Math.sin(30 * D2R);
  const CD = [-s * c, s * sn, s * sn, s * c];
  /** @param {number} x @param {number} y @returns {[number, number]} */
  const pix2world = (x, y) => {
    const dx = x - 100.5, dy = y - 200.25;
    return skyAt({ ra: ra0, dec: dec0, cd: /** @type {[number, number, number, number]} */ (CD) }, 0, 0, dx, dy);
  };
  const atRef = localSky(pix2world, { x0: 70, y0: 170, tx: 30.5, ty: 30.25 });
  assert.ok(atRef);
  assert.ok(Math.abs(atRef.ra - ra0) < 1e-12 && Math.abs(atRef.dec - dec0) < 1e-12);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(atRef.cd[k] - CD[k]) < 1e-12, `cd[${k}]: ${atRef.cd[k]} against ${CD[k]}`);

  // two degrees from the reference pixel the sky is no longer flat, and the flat sky of a stamp still follows the
  // transform to a hundredth of a pixel at its corners
  const picture = { x0: 900, y0: 1500, tx: 32.2, ty: 31.7 };
  const local = localSky(pix2world, picture);
  assert.ok(local);
  for (const [x, y] of [[0, 0], [63, 0], [0, 63], [63, 63], [32, 32]]) {
    const d = apart(skyAt(local, picture.tx, picture.ty, x, y), pix2world(picture.x0 + x, picture.y0 + y));
    assert.ok(d < 0.06, `pixel ${x}, ${y}: ${d} arcsec`);
  }
  assert.ok(apart(skyAt(local, picture.tx, picture.ty, 32, 32), pix2world(picture.x0 + 32, picture.y0 + 32)) < 1e-4, 'next to the target it is exact');
  assert.equal(localSky(() => [NaN, NaN], picture), null, 'a transform without an answer gives no sky');
});

test('the short name of a file is its observation and detector', () => {
  assert.equal(fileId('dr1/level2/2026W11_2A/l2b-v27-2026-234/2/level2_2026W11_2A_0501_1D2_spx_l2b-v27-2026-234.fits'), '2026W11_2A_0501_1D2');
  assert.equal(fileId('dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits'), '2025W35_1A_0146_3D5');
  assert.equal(fileId(''), '');
  assert.equal(fileId('somewhere/else.fits'), '');
});

test('numbers in the readout carry as many decimals as their size calls for', () => {
  assert.deepEqual([0.26871, 4.5, 12.345, 176.24, 1800.04, -0.143, -24.245].map(formatValue), ['0.269', '4.500', '12.35', '176.2', '1800', '-0.143', '-24.25']);
  assert.equal(formatSky(269.44636, 4.76706), 'RA 269.4464°, Dec +4.7671°');
  assert.equal(formatSky(330.84, -56.79), 'RA 330.8400°, Dec -56.7900°');
  assert.equal(formatSky(0, 0), 'RA 0.0000°, Dec +0.0000°');
});

test('the receipt of a reading: position, colour, brightness or why none, flags in words, the photo and its archive address', () => {
  const key = 'dr1/level2/2025W35_1A/l2b-v27-2026-230/5/level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits';
  const base = { kind: 'a', x: 3, y: 4, ra: 269.44636, dec: 4.76706, lam: 4.929, bw: 0.04, value: 12.345, unit: 'MJy/sr', word: 0, flags: [], mjd: 60902.8, id: '2025W35_1A_0146_3D5', keys: [key], photos: 1 };
  const text = readingText(base, 'https://example.org/view.html?t=barnard');
  const lines = text.split('\n');
  assert.equal(lines[0], 'One pixel of a SPHEREx photo, read on Same Sky, Same Colour (one visit)');
  assert.equal(lines[1], 'Sky position: RA 269.4464°, Dec +4.7671° (ICRS)');
  assert.equal(lines[2], 'Colour: 4.929 µm');
  assert.equal(lines[3], 'Brightness: 12.35 MJy/sr');
  assert.equal(lines[4], 'Flags: none');
  assert.match(lines[5], /^Photo taken: \d+ [A-Z][a-z]{2} 2025, \d\d:\d\d UTC$/);
  assert.deepEqual(lines.slice(6), ['Photo: 2025W35_1A_0146_3D5', `Archive: ${BUCKET_URLS[0]}${key}`, 'View: https://example.org/view.html?t=barnard']);
  // a saturated pixel says why it has no brightness, and each flag is named and explained
  const hot = readingText({ ...base, value: null, word: 6, flags: ['OVERFLOW', 'SUR_ERROR'] });
  assert.match(hot, /Brightness: none: too bright to be measured/);
  assert.match(hot, /Flags: OVERFLOW: [^;]+; SUR_ERROR: /);
  assert.ok(!hot.includes('View:'));
  // photos added up have no single file: each member is listed, up to ten, and the rest is counted
  const keys = Array.from({ length: 12 }, (_, i) => key.replace('0146', String(1000 + i)));
  const stack = readingText({ ...base, photos: 12, keys, id: '' });
  assert.match(stack, /Photos: 12 added up/);
  assert.equal(stack.split('\n').filter((l) => l.startsWith('Archive: ')).length, 10);
  assert.match(stack, /and 2 more/);
  // no photo to point to, and no sky: said, not made up
  const bare = readingText({ ...base, ra: null, dec: null, lam: null, keys: [], photos: 8, id: '', word: null, mjd: null });
  assert.match(bare, /Sky position: not known for this picture\n/);
  assert.match(bare, /Colour: not known for this pixel/);
  assert.match(bare, /Flags: not loaded/);
  assert.match(bare, /Archive: no single photo to point to/);
  assert.match(readingText({ ...base, kind: 'diff', unit: 'noise', value: -4.2, keys: [] }), /Brightness: -4\.200 times the noise/);
});
