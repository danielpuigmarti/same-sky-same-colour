// The plan and the progress in words (site/js/ui/plan.js), one message for each state (site/js/ui/states.js),
// and the names and choices of the visit strip (site/js/ui/visitstrip.js): the parts that need no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_STATES } from '../../site/js/contracts.js';
import { formatMB, formatSeconds, planCounts, planText, progressOf, progressText } from '../../site/js/ui/plan.js';
import { STATE_TEXT, STATE_LINKS, isFailure } from '../../site/js/ui/states.js';
import { visitId, visitTime, tilesOfVisits, findVisit, choose, VISIT_NAME_DAYS } from '../../site/js/ui/visitstrip.js';
import { readJson } from '../helpers/fixtures.mjs';

/** A frame (CT-1) with a time. @param {number} tmid @param {number} [n] */
const frame = (tmid, n = 0) => ({ key: `k${tmid}-${n}`, det: 2, tmid, corners: [[0, 0], [1, 0], [1, 1], [0, 1]] });
/** A visit (CT-5) of n frames from a time on. @param {number} t0 @param {number} n */
const visit = (t0, n) => ({ frames: Array.from({ length: n }, (_, i) => frame(t0 + i * 0.01, i)), short: n < 3 });

test('megabytes and seconds in words', () => {
  assert.deepEqual([4.1e6, 9e6, 9.04e6, 0, 0.04e6, 0.96e6, 9.94e6, 9.96e6, 12.3e6, 157.4e6].map(formatMB), ['4.1', '9', '9', '0', '0', '1', '9.9', '10', '12', '157']);
  assert.deepEqual([NaN, -5, Infinity].map(formatMB), ['0', '0', '0']);
  assert.deepEqual([0, 0.4, 1, 12, 12.4, 89, 90, 150, 600].map(formatSeconds), [
    'about 1 second', 'about 1 second', 'about 1 second', 'about 12 seconds', 'about 12 seconds', 'about 89 seconds', 'about 2 minutes', 'about 3 minutes', 'about 10 minutes',
  ]);
});

test('the plan before loading: visits, photos, MB, seconds', () => {
  const visits = [visit(60900, 12), visit(61100, 9), { frames: [], short: true }];
  const pair = /** @type {[any, any]} */ ([visits[0].frames[0], visits[1].frames[0]]);
  const plan = { visits, pairs: Array.from({ length: 8 }, () => pair), bytes: 9.0e6, seconds: 12 };
  assert.deepEqual(planCounts(plan), { visits: 2, photos: 16, bytes: 9.0e6, seconds: 12 });
  assert.equal(planText(plan), '2 visits · 16 photos · 9 MB · about 12 seconds');
  assert.equal(planText({ visits: [visits[0]], pairs: [], bytes: 0, seconds: 0 }), '1 visit · 0 photos · 0 MB · about 1 second');
  assert.equal(planText({ visits, pairs: [pair], bytes: 1.19e6, seconds: 95 }), '2 visits · 2 photos · 1.2 MB · about 2 minutes');
});

test('progress while loading reads "photo 7 of 16 · 4.1 of 9 MB"', () => {
  // the report of the reader of this site: {type, done, total, bytes, ms, key, cached, pair}
  const report = { type: 'stamp', done: 7, total: 16, bytes: 4.1e6, ms: 3100, key: 'k', cached: false, pair: 2 };
  const p = progressOf(report);
  assert.deepEqual(p, { done: 7, total: 16, bytes: 4.1e6 });
  assert.equal(progressText(/** @type {any} */ (p), 9e6), 'photo 7 of 16 · 4.1 of 9 MB');
  assert.equal(progressText({ done: 1, total: 2, bytes: null }, 9e6), 'photo 1 of 2');
  assert.equal(progressText({ done: 1, total: 2, bytes: 3e5 }), 'photo 1 of 2');
  assert.equal(progressText({ done: 16, total: 16, bytes: 9.6e6 }, 9e6), 'photo 16 of 16 · 9.6 of 9.6 MB', 'never more read than the whole');
  // reports that carry no count are not progress
  for (const other of [{ type: 'warning', key: 'k', what: 'x' }, { type: 'more', plan: {} }, null, undefined, 5, 'text', { done: 'x', total: 3 }, []]) assert.equal(progressOf(other), null);
  assert.deepEqual(progressOf({ done: 2, total: 4 }), { done: 2, total: 4, bytes: null });
});

test('every state of CT-12 has one plain message and a next step; cancelled has none', () => {
  const shown = FAILURE_STATES.filter((s) => s !== 'cancelled');
  assert.deepEqual(Object.keys(STATE_TEXT).sort(), [...shown].sort());
  assert.equal(shown.length, 8);
  assert.ok(!Object.hasOwn(STATE_TEXT, 'cancelled'));
  const titles = new Set();
  for (const state of shown) {
    const t = STATE_TEXT[/** @type {keyof typeof STATE_TEXT} */ (state)];
    assert.ok(t.title.length > 20 && /[.]$/.test(t.title), state);
    assert.ok(t.next.length > 20, state);
    assert.ok((t.actions.length >= 1 || state === 'too-faint') && t.actions.every((a) => ['retry', 'targets', 'comet', 'home'].includes(a)), state);
    assert.equal(new Set(t.actions).size, t.actions.length);
    assert.equal(typeof t.keeps, 'boolean');
    assert.ok(!/\d/.test(t.title + t.next), `${state}: no number is typed into a message`);
    assert.ok(!/\b(frame|error|exception|undefined|null)\b/i.test(t.title + t.next), `${state}: plain words`);
    titles.add(t.title);
  }
  assert.equal(titles.size, 8, 'no two states say the same');
  assert.equal(STATE_TEXT.quiet.title, 'Nothing changed above the noise here, which is normal.');
  assert.ok(STATE_TEXT.quiet.keeps && STATE_TEXT.slow.keeps && STATE_TEXT['too-bright'].keeps && STATE_TEXT['too-faint'].keeps);
  assert.ok(!STATE_TEXT['no-coverage'].keeps && !STATE_TEXT['one-visit'].keeps && !STATE_TEXT['not-indexed'].keeps);
  assert.ok(STATE_TEXT.slow.actions.includes('retry') && STATE_TEXT.unreachable.actions.includes('retry'));
  assert.ok(STATE_TEXT.unreachable.actions.includes('targets'), 'the prepared targets still work');
  assert.deepEqual(STATE_LINKS, { targets: 'targets.html', comet: 'lemmon.html', home: './' });
});

test('a failure is an object with one of the states; anything else is a result', () => {
  for (const state of FAILURE_STATES) assert.ok(isFailure({ state }), state);
  for (const other of [null, undefined, [], [{ state: 'quiet' }], { state: 'happy' }, { visits: [], pairs: [], bytes: 0, seconds: 0 }, 'quiet', 0]) assert.ok(!isFailure(other));
});

test('a visit is named by the UTC date of its first photo', () => {
  const m = readJson('showcase', 'barnard-d5', 'manifest.json');
  assert.equal(visitId(m.frames[0].mjd), '2025-08-25');
  assert.equal(visitId(m.frames[2].mjd), '2026-03-15');
  assert.equal(visitId(40587), '1970-01-01');
  assert.equal(visitId(40587.99999), '1970-01-01');
  assert.equal(visitId(NaN), '');
  assert.equal(visitTime('2025-08-25'), Math.floor(m.frames[0].mjd));
  assert.equal(visitId(visitTime('2026-03-15')), '2026-03-15');
  for (const bad of ['', '2025-8-25', '2025-13-01', '2025-02-30', 'yesterday', '20250825']) assert.ok(Number.isNaN(visitTime(bad)), bad);
});

test('the tiles of a plan: one for each visit with photos, earliest first, short ones marked', () => {
  const visits = [visit(61100.4, 9), { frames: [], short: true }, visit(60900.7, 2), visit(61300.2, 40)];
  const tiles = tilesOfVisits(visits);
  assert.deepEqual(tiles, [
    { id: '2025-08-13', mjd: 60900.7, photos: 2, short: true, index: 2 },
    { id: '2026-03-01', mjd: 61100.4, photos: 9, short: false, index: 0 },
    { id: '2026-09-17', mjd: 61300.2, photos: 40, short: false, index: 3 },
  ]);
  assert.deepEqual(tilesOfVisits([]), []);
});

test('a name in the address finds its visit, also when the first photo moved by a few days', () => {
  const tiles = tilesOfVisits([visit(60900.7, 5), visit(61100.4, 9), visit(61300.2, 40)]);
  assert.equal(findVisit(tiles, '2026-03-01'), 1);
  assert.equal(findVisit(tiles, '2026-02-27'), 1, 'two days before');
  assert.equal(findVisit(tiles, '2026-03-16'), 1, `${VISIT_NAME_DAYS} days after`);
  assert.equal(findVisit(tiles, '2026-03-17'), -1, 'too far');
  assert.equal(findVisit(tiles, '2025-08-13'), 0);
  assert.equal(findVisit(tiles, '2027-01-01'), -1);
  for (const none of [undefined, '', 'first', '1', '2026-3-1']) assert.equal(findVisit(tiles, none), -1);
  assert.equal(findVisit([], '2026-03-01'), -1);
});

test('choosing tiles: the two chosen last are compared; choosing one of them again changes nothing', () => {
  assert.deepEqual(choose([], 2), [2]);
  assert.deepEqual(choose([2], 0), [2, 0]);
  assert.deepEqual(choose([2, 0], 1), [0, 1]);
  assert.deepEqual(choose([0, 1], 2), [1, 2]);
  const same = [0, 1];
  assert.equal(choose(same, 1), same);
  assert.equal(choose(same, 0), same);
});
