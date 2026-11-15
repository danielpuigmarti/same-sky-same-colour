import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyAt } from '../../site/js/ui/hover.js';
import { parseAt, formatAt, skyToPixel } from '../../site/js/lib/skypick.js';

const sky = { ra: 283.3963, dec: 33.0291, cd: /** @type {[number, number, number, number]} */ ([-0.0017, 0.0002, 0.0001, 0.0017]) };

test('skyToPixel undoes skyAt for every pixel of a picture', () => {
  for (const [x, y] of [[0, 0], [10, 50], [32, 32], [63, 63], [5, 60]]) {
    const [ra, dec] = skyAt(sky, 32, 32, x, y);
    assert.deepEqual(skyToPixel(sky, 32, 32, ra, dec), { x, y }, `${x},${y}`);
  }
});

test('skyToPixel gives nothing for the other side of the sky', () => {
  assert.equal(skyToPixel(sky, 32, 32, 103.4, -33), null);
});

test('the at part of an address is read back as it was written, and nonsense is left out', () => {
  const text = formatAt(283.396251, 33.029152);
  assert.equal(text, '283.39625,33.02915');
  assert.deepEqual(parseAt(`?t=barnard&at=${text}`), [283.39625, 33.02915]);
  assert.deepEqual(parseAt(`at=${formatAt(0, -0)}`), [0, 0]);
  for (const bad of ['', '?at=', '?at=abc', '?at=1', '?at=1,2,3', '?at=400,10', '?at=10,100', '?at=1e3,2', '?at=NaN,1']) assert.equal(parseAt(bad), null, bad);
});
