// The numbers the viewer page quotes are the numbers the stage works with: site/data/numbers/v2.json against the
// constants of site/js/ui/stage.js and the contracts, and site/view.html against both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIFF_RANGE } from '../../site/js/contracts.js';
import { PIXEL_ARCSEC, STRETCH_PERCENTILE, MAX_FLIPS_PER_SECOND, DIFF_GREY_BELOW } from '../../site/js/ui/stage.js';
import { checkNumbers } from '../../tools/contracts.mjs';

/** @param {string} rel */
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const numbers = JSON.parse(read('site/data/numbers/v2.json'));

const WANT = {
  'stage.pixel_arcsec': PIXEL_ARCSEC,
  'stage.stretch_percentile': STRETCH_PERCENTILE,
  'stage.flips_per_second': MAX_FLIPS_PER_SECOND,
  'stage.diff_range': DIFF_RANGE,
  'stage.diff_grey_below': DIFF_GREY_BELOW,
};

test('the numbers of the viewer are valid, and each is the constant the code uses', () => {
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(Object.keys(numbers).sort(), Object.keys(WANT).sort());
  for (const [key, value] of Object.entries(WANT)) {
    assert.equal(numbers[key].value, value, key);
    assert.equal(numbers[key].text, String(value), key);
    assert.equal(numbers[key].check, null);
  }
});

test('the viewer page quotes numbers only through its keys, filled with their text', () => {
  const html = read('site/view.html');
  const spans = [...html.matchAll(/<span data-n="([^"]+)">([^<]*)<\/span>/g)];
  assert.equal(spans.length, (html.match(/data-n=/g) ?? []).length, 'every data-n is a plain span');
  assert.ok(spans.length >= 5);
  for (const [, key, text] of spans) {
    assert.ok(Object.hasOwn(numbers, key), `${key} is a number of the viewer`);
    assert.equal(text, numbers[key].text, key);
  }
  assert.deepEqual([...new Set(spans.map((s) => s[1]))].sort(), Object.keys(WANT).sort(), 'every number of the viewer is on the page');
  // outside those spans the text of the page's own part (what stands between <main> and </main>) holds no digit
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
  assert.ok(main.length > 500);
  const text = main.replace(/<span data-n="[^"]+">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '');
  assert.ok(!/\d/.test(text), `a number is typed into the page: ${text.match(/.{0,30}\d.{0,30}/)?.[0]}`);
});
