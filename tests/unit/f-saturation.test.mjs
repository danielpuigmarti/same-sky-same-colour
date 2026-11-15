// The sentence about a saturated centre (site/js/ui/saturation.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SATURATION_MASK } from '../../site/js/lib/flags.js';
import { centreSaturated, saturationNote } from '../../site/js/ui/saturation.js';

test('the centre is saturated when the flags of the target pixel say so, and not for a pixel beside it or a picture without flags', () => {
  const flags = new Int32Array(25);
  flags[2 * 5 + 2] = SATURATION_MASK;
  assert.equal(centreSaturated({ w: 5, h: 5, tx: 2.2, ty: 1.8, flags }), true);
  assert.equal(centreSaturated({ w: 5, h: 5, tx: 3, ty: 2, flags }), false);
  assert.equal(centreSaturated({ w: 5, h: 5, tx: 2, ty: 2, flags: null }), false);
  assert.equal(centreSaturated({ w: 5, h: 5, tx: 9, ty: 2, flags }), false);
  assert.equal(centreSaturated(null), false);
});

test('the sentence says what the hatching is and why there is no brightness; a mover points to the Difference view', () => {
  for (const n of [saturationNote(), saturationNote({ prepared: true }), saturationNote({ moves: true, prepared: true })]) {
    assert.match(n, /pink hatching marks pixels that are saturated or damaged/);
    assert.match(n, /no brightness is given/);
  }
  assert.match(saturationNote({ moves: true }), /Difference view/);
  assert.doesNotMatch(saturationNote({ prepared: true }), /Difference/);
});
