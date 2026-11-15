// Typed positions (C1): parseCoords against astropy's answers in tests/vectors/coords.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoords, formatDegrees, formatSexagesimal } from '../../site/js/lib/coords.js';

const vec = JSON.parse(readFileSync(new URL('../vectors/coords.json', import.meta.url), 'utf8'));

/** Angular distance in arcsec between two positions of the vector and the parsed one. */
const arcsec = (/** @type {number} */ ra1, /** @type {number} */ dec1, /** @type {number} */ ra2, /** @type {number} */ dec2) => {
  const d = Math.PI / 180;
  const a = Math.sin(((dec2 - dec1) * d) / 2) ** 2 + Math.cos(dec1 * d) * Math.cos(dec2 * d) * Math.sin(((ra2 - ra1) * d) / 2) ** 2;
  return (2 * Math.asin(Math.sqrt(a)) * 3600) / d;
};

test('at least 20 strings, each within 0.1 arcsec of astropy', () => {
  assert.ok(vec.cases.length >= 20);
  for (const c of vec.cases) {
    const p = parseCoords(c.text);
    assert.ok(p.ok, `${JSON.stringify(c.text)}: ${p.ok ? '' : p.message}`);
    if (p.ok) assert.ok(arcsec(p.ra, p.dec, c.ra, c.dec) < 0.1, `${JSON.stringify(c.text)}: ${arcsec(p.ra, p.dec, c.ra, c.dec)} arcsec`);
  }
});

test("the challenge statement's own string for WISE 0855", () => {
  const p = parseCoords('08h55m10.831s -7d14m42.53s');
  assert.ok(p.ok);
  if (p.ok) {
    assert.ok(Math.abs(p.ra - 133.795129) < 1e-6);
    assert.ok(Math.abs(p.dec - -7.245147) < 1e-6);
    assert.equal(p.form, 'sexagesimal');
  }
});

test('plain numbers are degrees; the form says so', () => {
  const p = parseCoords('330.84 -56.79');
  assert.ok(p.ok && p.form === 'degrees' && p.ra === 330.84 && p.dec === -56.79);
});

test('a minus sign in front of a zero of degrees counts', () => {
  const p = parseCoords('12h30m00s -0d14m42s');
  assert.ok(p.ok && p.dec < 0 && Math.abs(p.dec + 0.245) < 1e-9);
});

test('nonsense is refused with a plain message', () => {
  assert.ok(vec.reject.length >= 20);
  for (const text of vec.reject) {
    const p = parseCoords(text);
    assert.equal(p.ok, false, JSON.stringify(text));
    if (!p.ok) {
      assert.ok(p.message.length > 20 && p.message.length < 260, JSON.stringify(text));
      assert.ok(!/undefined|NaN|\bnull\b/.test(p.message), p.message);
      assert.ok(/^[A-Z]/.test(p.message) && /[.)]$/.test(p.message), p.message);
    }
  }
  const p = parseCoords('25h00m00s +10d00m00s');
  assert.ok(!p.ok && /24/.test(p.message));
  const q = parseCoords('12h30m +91d00m');
  assert.ok(!q.ok && /90/.test(q.message));
  assert.ok(!parseCoords(/** @type {any} */ (undefined)).ok);
});

test('what is written comes back as what is read', () => {
  for (const [ra, dec] of [[330.84, -56.79], [133.795129, -7.245147], [0.0001, 89.99], [359.9999, -0.0003], [17.5, 0]]) {
    const a = parseCoords(formatDegrees(ra, dec, 6));
    assert.ok(a.ok && arcsec(a.ra, a.dec, ra, dec) < 1e-3);
    const b = parseCoords(formatSexagesimal(ra, dec, 3));
    assert.ok(b.ok, formatSexagesimal(ra, dec, 3));
    if (b.ok) assert.ok(arcsec(b.ra, b.dec, ra, dec) < 0.05, `${formatSexagesimal(ra, dec, 3)}`);
  }
  assert.equal(formatSexagesimal(133.795129, -7.245147), '08h55m10.83s -07d14m42.5s');
});
