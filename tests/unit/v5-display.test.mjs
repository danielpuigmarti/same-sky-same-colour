// V5: white point, speed and invert. The two pictures of a view always share one grey scale; the default draws as it
// always did; and on RW Aurigae, with white raised to the star's peak, its change can be seen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeShowcase, defaultVisits, pairsBetween } from '../../site/js/lib/showcase.js';
import { compose } from '../../site/js/lib/compose.js';
import { displayLimits, whiteLimits, greyRgba, stretchByte, WHITE_STEPS, SPEEDS, MAX_FLIPS_PER_SECOND, MIN_FLIP_MS } from '../../site/js/ui/stage.js';
import { parseAddress, formatAddress } from '../../site/js/lib/urlstate.js';

const SITE = new URL('../../site/', import.meta.url);

/** The two pictures the viewer shows for a prepared target, as it puts them together. @param {string} id */
function view(id) {
  const dir = new URL(`data/targets/${id}/`, SITE);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));
  const stamps = decodeShowcase(manifest, readFileSync(new URL('stamps.bin', dir)), readFileSync(new URL('flags.bin', dir)))
    .map((s, i) => ({ ...s, sky: manifest.frames[i].sky }));
  const [a, b] = defaultVisits(manifest);
  const pairs = pairsBetween(manifest, a, b).map(([i, j]) => [stamps[i], stamps[j]]);
  const own = compose(pairs, { size: Math.min(manifest.w, 44), difference: true });
  assert.ok(own, id);
  return own.view;
}

const peak = (p) => { let m = -Infinity, at = 0; for (let i = 0; i < p.data.length; i++) if (p.data[i] > m) { m = p.data[i]; at = i; } return { value: m, at }; };

test('one set of limits for both pictures at every step; white rises with the step and the first step is the old rule', () => {
  for (const id of ['rw-aur', 'barnard', 'eps-indi-b']) {
    const v = view(id);
    const arrays = [v.a.data, v.b.data];
    assert.deepEqual(whiteLimits(arrays, 0), displayLimits(arrays), `${id}: step 0 is the 99.5th percentile`);
    let last = -Infinity;
    for (const [step] of WHITE_STEPS.entries()) {
      const lim = whiteLimits(arrays, step);
      assert.equal(lim.lo, displayLimits(arrays).lo, `${id}: black does not move`);
      assert.ok(lim.hi >= last && lim.hi > lim.lo, `${id}: white rises at step ${step}`);
      last = lim.hi;
      // both pictures are drawn with that one pair: the same value has the same grey in both
      const ga = greyRgba(v.a.data, v.a.w, v.a.h, lim), gb = greyRgba(v.b.data, v.b.w, v.b.h, lim);
      for (const [data, g] of [[v.a.data, ga], [v.b.data, gb]]) {
        const w = v.a.w, h = v.a.h;
        for (let k = 0; k < 40; k++) {
          const i = (k * 97) % (w * h);
          if (!Number.isFinite(data[i])) continue;
          const y = Math.floor(i / w), x = i % w, o = ((h - 1 - y) * w + x) * 4;
          assert.equal(g[o], stretchByte(data[i], lim.lo, lim.hi));
        }
      }
    }
    assert.ok(whiteLimits(arrays, 3).hi > Math.max(...[v.a.data, v.b.data].map((d) => d.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), -Infinity))), `${id}: at the last step the brightest pixel is below white`);
  }
});

test('the default draws pixel for pixel as it did, and invert is 255 minus the grey on the pixels that have a value', () => {
  const v = view('barnard');
  const lim = displayLimits([v.a.data, v.b.data]);
  const was = greyRgba(v.a.data, v.a.w, v.a.h, lim);
  assert.deepEqual(greyRgba(v.a.data, v.a.w, v.a.h, whiteLimits([v.a.data, v.b.data], 0)), was);
  assert.deepEqual(greyRgba(v.a.data, v.a.w, v.a.h, lim, undefined, false), was);
  const flipped = greyRgba(v.a.data, v.a.w, v.a.h, lim, undefined, true);
  for (let i = 0; i < v.a.data.length; i++) {
    const o = ((v.a.h - 1 - Math.floor(i / v.a.w)) * v.a.w + (i % v.a.w)) * 4;
    if (Number.isFinite(v.a.data[i])) assert.equal(flipped[o], 255 - was[o]);
    else assert.equal(flipped[o], was[o]);
  }
});

test('RW Aurigae with white raised to the star\'s peak: its brightest pixel is below white in both pictures and the greys differ by 10 or more', () => {
  const v = view('rw-aur');
  const arrays = [v.a.data, v.b.data];
  const grey = (p, lim) => stretchByte(peak(p).value, lim.lo, lim.hi);
  const before = whiteLimits(arrays, 0);
  assert.equal(grey(v.a, before), 255, 'today: white in the earlier picture');
  assert.equal(grey(v.b, before), 255, 'today: white in the later picture');
  const raised = whiteLimits(arrays, WHITE_STEPS.length - 1);
  const ga = grey(v.a, raised), gb = grey(v.b, raised);
  assert.ok(ga < 255 && gb < 255, `${ga} and ${gb}`);
  assert.ok(Math.abs(ga - gb) >= 10, `${ga} and ${gb} differ by ${Math.abs(ga - gb)}`);
});

test('three speeds, none faster than twice a second; the choices are kept in the address and the default is not written', () => {
  assert.ok(SPEEDS.slow > SPEEDS.normal && SPEEDS.normal > SPEEDS.fast);
  assert.ok(SPEEDS.fast >= MIN_FLIP_MS && 1000 / SPEEDS.fast <= MAX_FLIPS_PER_SECOND);
  assert.equal(formatAddress({ t: 'barnard', white: 2, speed: 'fast', invert: true, smooth: true }), 't=barnard&smooth=1&white=2&speed=fast&invert=1');
  assert.equal(formatAddress({ t: 'barnard', white: 0, speed: undefined }), 't=barnard');
  assert.deepEqual(parseAddress('?t=barnard&white=3&speed=slow&invert=1'), { t: 'barnard', white: 3, speed: 'slow', invert: true });
  assert.deepEqual(parseAddress('?white=9&speed=warp&invert=0&white=x'), {}, 'what makes no sense is left out');
  const a = { t: 'barnard', white: 1, speed: /** @type {'slow'} */ ('slow'), invert: true };
  assert.deepEqual(parseAddress(formatAddress(a)), a);
});
