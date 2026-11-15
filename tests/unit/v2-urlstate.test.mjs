// The address of a view (CT-11): site/js/lib/urlstate.js reads and writes it, and every field survives the round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_PARAMS, VIEW_MODES, VIEW_PAGE } from '../../site/js/contracts.js';
import { parseAddress, formatAddress, viewUrl, TARGET_PATTERN } from '../../site/js/lib/urlstate.js';

/** One value for every field of CT-11, none of them a default. */
const FULL = { ra: 269.44636, dec: -56.79, det: 5, mode: 'curtain', a: '2025-08-25', b: '2026-03-15', fov: 0.1093, t: 'barnard-d5', embed: true, pitch: true, q: "Barnard's Star" };

test('an address with every field is written in the order of CT-11 and read back the same', () => {
  assert.deepEqual(Object.keys(FULL), [...VIEW_PARAMS], 'the test covers every field of CT-11');
  const text = formatAddress(FULL);
  assert.equal(text, 'ra=269.44636&dec=-56.79&det=5&mode=curtain&a=2025-08-25&b=2026-03-15&fov=0.1093&t=barnard-d5&embed=1&pitch=1&q=Barnard%27s+Star');
  assert.deepEqual(parseAddress(text), FULL);
  assert.deepEqual(parseAddress(`?${text}`), FULL);
  assert.deepEqual(parseAddress(`https://example.org/site/${VIEW_PAGE}?${text}#stage`), FULL);
  assert.deepEqual(parseAddress(new URL(`https://example.org/${VIEW_PAGE}?${text}`)), FULL);
  assert.deepEqual(parseAddress(new URLSearchParams(text)), FULL);
  assert.equal(viewUrl(FULL), `${VIEW_PAGE}?${text}`);
});

test('every field round-trips on its own, and an absent field stays absent', () => {
  for (const name of VIEW_PARAMS) {
    const one = { [name]: /** @type {Record<string, unknown>} */ (FULL)[name] };
    const back = parseAddress(formatAddress(one));
    assert.deepEqual(back, one, name);
    assert.deepEqual(Object.keys(back), [name]);
  }
  assert.deepEqual(parseAddress(''), {});
  assert.deepEqual(parseAddress(VIEW_PAGE), {});
  assert.equal(formatAddress({}), '');
  assert.equal(viewUrl({}), VIEW_PAGE);
});

test('numbers come back as the same numbers, however awkward', () => {
  const awkward = [0, 1e-7, 0.1 + 0.2, 359.99999999999994, 123.456789012345678, 5e-324];
  for (const ra of awkward) assert.equal(parseAddress(formatAddress({ ra })).ra, ra, String(ra));
  for (const dec of [-90, 90, -0.000001, 4.76706, -56.79, 89.99999999999999]) assert.equal(parseAddress(formatAddress({ dec })).dec, dec, String(dec));
  for (const fov of [0.1093, 1e-9, 180, 2.5]) assert.equal(parseAddress(formatAddress({ fov })).fov, fov, String(fov));
  for (const det of [1, 2, 3, 4, 5, 6]) assert.equal(parseAddress(formatAddress({ det: /** @type {any} */ (det) })).det, det);
  for (const mode of VIEW_MODES) assert.equal(parseAddress(formatAddress({ mode: /** @type {any} */ (mode) })).mode, mode);
});

test('what parseAddress gives is always written back to the same thing', () => {
  const texts = [
    'ra=370&dec=10', 'ra=-10&dec=-0', 'ra=1e2&dec=+4.5', 't=falsepos/ghost-1&mode=diff', 'a=first%20visit&b=x%26y%3Dz',
    'embed=1', 'pitch=1&embed=1&det=6', 'fov=0.25&ra=0&dec=0&a=%C3%A9',
  ];
  for (const text of texts) {
    const once = parseAddress(text);
    assert.deepEqual(parseAddress(formatAddress(once)), once, text);
  }
  assert.equal(parseAddress('ra=370').ra, 10, 'any angle is a right ascension');
  assert.equal(parseAddress('ra=-10').ra, 350);
  assert.ok(Object.is(parseAddress('dec=-0').dec, 0), 'minus zero is read as zero, as it is written');
  assert.equal(formatAddress({ t: 'falsepos/ghost-1' }), 't=falsepos/ghost-1');
  assert.deepEqual(parseAddress('a=first%20visit&b=x%26y%3Dz'), { a: 'first visit', b: 'x&y=z' });
  // what was typed in the box is kept as it was written, whatever it holds
  for (const typed of ['08h55m10.831s -7d14m42.53s', 'ε Indi B', '330.84 -56.79', ' Vega ', 'a&b=c#d+e%20f']) {
    assert.deepEqual(parseAddress(formatAddress({ q: typed })), { q: typed }, typed);
  }
  assert.deepEqual(parseAddress('q=RW+Aurigae&ra=76.956'), { ra: 76.956, q: 'RW Aurigae' });
});

test('a part that makes no sense is left out, and nothing throws', () => {
  const wrong = {
    ra: ['', 'abc', 'NaN', 'Infinity', ' '],
    dec: ['', '91', '-90.0001', 'north', 'Infinity'],
    det: ['0', '7', '2.5', 'two', ''],
    mode: ['', 'Blink', 'movie', 'diff '],
    a: ['', 'x'.repeat(65)],
    b: ['', 'y'.repeat(65)],
    fov: ['0', '-1', '181', 'wide', ''],
    t: ['', 'Barnard', '../secret', 'a/b/c', 'a b', '-x', 'x/', '/x', 'x_y'],
    embed: ['0', 'true', '', 'yes'],
    pitch: ['0', 'true', '', '2'],
    q: ['', '   ', 'x'.repeat(201)],
  };
  assert.deepEqual(Object.keys(wrong), [...VIEW_PARAMS]);
  for (const [name, values] of Object.entries(wrong)) {
    for (const v of values) assert.deepEqual(parseAddress(`${name}=${encodeURIComponent(v)}`), {}, `${name}=${JSON.stringify(v)}`);
  }
  assert.deepEqual(parseAddress('ra=10&dec=95&det=5&other=1'), { ra: 10, det: 5 }, 'the good parts are kept');
  assert.deepEqual(parseAddress('%E0%A4%A&ra=5'), { ra: 5 });
  assert.equal(formatAddress(/** @type {any} */ ({ embed: false, pitch: undefined, a: '', other: 'x' })), '');
});

test('the pattern of a target accepts folder names and one group', () => {
  for (const good of ['barnard', 'eps-indi-b', 'w0855', 'lemmon/hero', 'falsepos/ghost-1', '3i']) assert.ok(TARGET_PATTERN.test(good), good);
  for (const bad of ['', 'Barnard', 'a/b/c', '..', 'a..b', 'a/', '/a', 'a b', 'a.json']) assert.ok(!TARGET_PATTERN.test(bad), bad);
});
