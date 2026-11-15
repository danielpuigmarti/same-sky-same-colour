// The colour ruler (site/js/ui/ruler.js): its six spans are the extremes of the wavelength tables of the site, and
// the colour it gives a pixel is the one astropy gives (tests/fixtures/wave/reference.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WAVE_TABLES_FILE } from '../../site/js/contracts.js';
import {
  RULER_MIN, RULER_MAX, COLOUR_DECIMALS, detectorSpans, rulerRange, rulerPosition, tableColour, colourLookup, loadTables, formatColour,
} from '../../site/js/ui/ruler.js';
import { readJson } from '../helpers/fixtures.mjs';

const tables = JSON.parse(readFileSync(new URL(`../../site/${WAVE_TABLES_FILE}`, import.meta.url), 'utf8'));

test('the ruler runs from 0.75 to 5.0 µm', () => {
  assert.deepEqual([RULER_MIN, RULER_MAX], [0.75, 5.0]);
});

test('the six spans are the smallest and the largest wavelength of each table of the site', () => {
  const spans = detectorSpans(tables);
  assert.deepEqual(spans.map((s) => s.det), [1, 2, 3, 4, 5, 6]);
  for (const s of spans) {
    const all = tables[String(s.det)].lam.flat();
    assert.equal(s.min, Math.min(...all));
    assert.equal(s.max, Math.max(...all));
    assert.ok(s.max > s.min);
  }
  // from the shortest wavelengths to the longest, each part overlapping the next a little
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i].min > spans[i - 1].min && spans[i].max > spans[i - 1].max);
    assert.ok(spans[i].min < spans[i - 1].max, `detectors ${i} and ${i + 1} overlap`);
  }
  assert.deepEqual(detectorSpans({ 2: tables['2'] }).map((s) => s.det), [2], 'a missing table is left out');
});

test('the bar holds every span whole, and a wavelength lies on it in proportion', () => {
  const spans = detectorSpans(tables), range = rulerRange(spans);
  assert.ok(range.min <= RULER_MIN && range.max >= RULER_MAX);
  assert.equal(range.min, Math.min(RULER_MIN, spans[0].min));
  assert.equal(range.max, Math.max(RULER_MAX, spans[5].max));
  assert.ok(RULER_MIN - range.min < 0.03 && range.max - RULER_MAX < 0.03, 'the tables go only a little beyond 0.75 and 5.0');
  for (const s of spans) for (const lam of [s.min, s.max]) assert.ok(rulerPosition(lam, range) >= 0 && rulerPosition(lam, range) <= 1);
  assert.equal(rulerPosition(range.min, range), 0);
  assert.equal(rulerPosition(range.max, range), 1);
  assert.ok(Math.abs(rulerPosition((range.min + range.max) / 2, range) - 0.5) < 1e-15);
  assert.deepEqual(rulerRange([]), { min: RULER_MIN, max: RULER_MAX });
});

test('the colour of a pixel agrees with astropy at 1,200 pixels, and its bandwidth too', () => {
  const ref = readJson('wave', 'reference.json'), at = colourLookup(tables);
  let n = 0, worst = 0;
  for (const det of ['1', '2', '3', '4', '5', '6']) {
    const r = ref[det];
    for (let i = 0; i < r.x.length; i++) {
      const c = at(/** @type {any} */ (Number(det)), r.x[i], r.y[i]);
      worst = Math.max(worst, Math.abs(c.lam - r.lam[i]), Math.abs(c.bw - r.bw[i]));
      n++;
    }
  }
  assert.equal(n, 1200);
  assert.ok(worst < 1e-9, `largest difference ${worst} µm`);
});

test('at a node the table itself is given back, and a detector without a table gives no colour', () => {
  const t = tables['5'];
  assert.deepEqual(tableColour(t, t.X[0] - 1, t.Y[0] - 1), { lam: t.lam[0][0], bw: t.bw[0][0] });
  assert.deepEqual(tableColour(t, t.X.at(-1) - 1, t.Y.at(-1) - 1), { lam: t.lam.at(-1).at(-1), bw: t.bw.at(-1).at(-1) });
  const i = 3, j = 4;
  const c = tableColour(t, t.X[j] - 1, t.Y[i] - 1);
  assert.ok(Math.abs(c.lam - t.lam[i][j]) < 1e-12 && Math.abs(c.bw - t.bw[i][j]) < 1e-12);
  // half way between two nodes of a row: half way between their values
  const mid = tableColour(t, (t.X[j] + t.X[j + 1]) / 2 - 1, t.Y[i] - 1);
  assert.ok(Math.abs(mid.lam - (t.lam[i][j] + t.lam[i][j + 1]) / 2) < 1e-12);
  const at = colourLookup({ 5: t });
  assert.ok(Number.isNaN(at(/** @type {any} */ (3), 10, 10).lam) && Number.isNaN(at(/** @type {any} */ (3), 10, 10).bw));
  assert.ok(Number.isNaN(at(5, NaN, 10).lam));
});

test('a wavelength on a chip has three decimals', () => {
  assert.equal(COLOUR_DECIMALS, 3);
  assert.equal(formatColour(4.295837949190033), '4.296 µm');
  assert.equal(formatColour(0.75), '0.750 µm');
  assert.equal(formatColour(NaN), 'colour unknown');
});

test('loadTables gives the tables, or null when they cannot be had', async () => {
  /** @param {unknown} body @param {number} [status] */
  const answer = (body, status = 200) => /** @type {typeof fetch} */ (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  assert.deepEqual(await loadTables('x', answer(tables)), tables);
  assert.equal(await loadTables('x', answer(tables, 404)), null);
  assert.equal(await loadTables('x', answer('<html>')), null);
  assert.equal(await loadTables('x', answer({ 1: tables['1'] })), null, 'all six are needed');
  assert.equal(await loadTables('x', /** @type {typeof fetch} */ (async () => { throw new TypeError('offline'); })), null);
});
