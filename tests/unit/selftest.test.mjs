// The live self-test of the Checks page: the comparison of what was read with the stored answer, and the stored
// answer itself, which must be what the prepared target says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compare } from '../../site/js/ui/selftest.js';

const json = (rel) => JSON.parse(readFileSync(new URL(`../../site/data/${rel}`, import.meta.url), 'utf8'));
const answer = json('selftest/answer.json');
const matching = Object.fromEntries(answer.values.map((v) => [v.id, v.stored]));

test('a read that equals the stored answer matches in every line', () => {
  const r = compare(answer, matching);
  assert.equal(r.matches, true);
  assert.equal(r.lines.length, answer.values.length);
  assert.ok(r.lines.every((l) => l.ok));
});

test('a difference inside the tolerance matches, and just outside it does not', () => {
  const mjd = answer.values.find((v) => v.id === 'mjd');
  assert.equal(compare(answer, { ...matching, mjd: mjd.stored + mjd.tolerance / 2 }).matches, true);
  assert.equal(compare(answer, { ...matching, mjd: mjd.stored + mjd.tolerance * 2 }).matches, false);
  const round = answer.values.find((v) => v.id === 'roundtrip');
  assert.equal(compare(answer, { ...matching, roundtrip: round.tolerance }).matches, true);
  assert.equal(compare(answer, { ...matching, roundtrip: round.tolerance * 1.01 }).matches, false);
});

test('a differing value says which line differs, and only that line', () => {
  const r = compare(answer, { ...matching, x0: matching.x0 + 1 });
  assert.equal(r.matches, false);
  assert.deepEqual(r.lines.filter((l) => !l.ok).map((l) => l.value.id), ['x0']);
  assert.equal(r.lines.find((l) => l.value.id === 'x0').read, matching.x0 + 1);
});

test('a value that is missing, not a number or infinite does not match', () => {
  for (const bad of [undefined, null, NaN, Infinity, '60989']) {
    const r = compare(answer, { ...matching, mjd: bad });
    assert.equal(r.matches, false, String(bad));
    assert.equal(r.lines.find((l) => l.value.id === 'mjd').read, null);
  }
  const dropped = { ...matching };
  delete dropped.y0;
  assert.equal(compare(answer, dropped).matches, false);
  assert.equal(compare(answer, {}).matches, false);
});

test('a stored value that is not a number cannot match', () => {
  const broken = { ...answer, values: answer.values.map((v) => (v.id === 'nx' ? { ...v, stored: null } : v)) };
  assert.equal(compare(broken, matching).matches, false);
});

test('the stored answer is what the prepared target holds, and every tolerance has its reason', () => {
  const manifest = json(`targets/${answer.target.id}/manifest.json`);
  const frame = manifest.frames.find((f) => f.key === answer.key);
  assert.ok(frame, 'the frame is one of the target');
  const stored = (id) => answer.values.find((v) => v.id === id).stored;
  assert.equal(stored('x0'), frame.x0);
  assert.equal(stored('y0'), frame.y0);
  assert.equal(stored('mjd'), frame.mjd);
  assert.equal(stored('pixels'), manifest.w * manifest.h);
  assert.equal(answer.target.ra, manifest.ra);
  assert.equal(answer.target.dec, manifest.dec);
  assert.equal(answer.target.det, manifest.det);
  for (const v of answer.values) assert.ok(v.why.length > 20, `${v.id} has a reason`);
  // the position rule is the typed-position rule: 0.1 arcsec
  assert.equal(answer.values.find((v) => v.id === 'roundtrip').tolerance, 0.1);
});
