// The three pages that tell a result (targets.html, lemmon.html, checks.html) say what the data files say.
//
// Those pages are plain HTML, so that they read the same with scripts off. Their parts that come from data are made
// by site/js/ui/cards.js, site/js/ui/checks.js and site/js/pages/{targets,lemmon,checks}.js, and written into the
// elements marked data-built (tests/fixtures/v4/make.mjs does the making). This file is both the check and the
// writer:
//
//   node --test tests/unit/v4-pages.test.mjs        fails when a page, or site/data/numbers/v4.json, is not what
//                                                   the data files give (it is part of "npm test")
//   node tests/unit/v4-pages.test.mjs --write       runs the gate, makes the pages and numbers/v4.json again, and
//                                                   runs the gate once more so that numbers.json holds them
//
// Run the second after any change to the data the pages show: a new or reviewed Checks row, a number, a card, a
// decision, challenge.json, tried.json, limits.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getBlock } from '../../site/js/ui/cards.js';
import { checkNumbers, checkNumbersHaveChecks } from '../../tools/contracts.mjs';
import { runGate } from '../../tools/gate.mjs';
import { ROOT, PAGES, unix, loadSite, makePages, readPages } from '../fixtures/v4/make.mjs';

const OWN = 'site/data/numbers/v4.json';
const HOW = 'run "node tests/unit/v4-pages.test.mjs --write"';

/** @param {unknown} v */
const pretty = (v) => `${JSON.stringify(v, null, 1)}\n`;

if (process.argv.includes('--write')) {
  const before = runGate({ root: ROOT });
  const made = makePages(loadSite(), readPages());
  const wrote = [];
  /** @param {string} rel @param {string} text */
  const put = (rel, text) => {
    const file = path.join(ROOT, rel);
    if (existsSync(file) && unix(readFileSync(file, 'utf8')) === text) return;
    writeFileSync(file, text);
    wrote.push(rel);
  };
  put(OWN, pretty(made.own));
  for (const name of PAGES) put(`site/${name}`, made.pages[name]);
  const after = runGate({ root: ROOT });
  for (const rel of new Set([...before.wrote, ...wrote, ...after.wrote])) console.log(`wrote ${rel}`);
  for (const what of made.left) console.log(`left out, because the site does not have it: ${what}`);
  for (const e of after.errors) console.error(`gate: ${e}`);
  console.log(after.errors.length ? `the gate still reports ${after.errors.length} problem(s)` : `the pages are made (${after.summary})`);
}

const site = loadSite();
const disk = readPages();
const made = makePages(site, disk);

test('the numbers these pages add are valid, and are what the data files give', () => {
  assert.deepEqual(checkNumbers(made.own), []);
  assert.deepEqual(checkNumbersHaveChecks(made.own, site.rows), []);
  assert.ok(Object.keys(made.own).every((k) => k.startsWith('v4.')), 'every key of this part starts with v4.');
  assert.ok(existsSync(path.join(ROOT, OWN)), `${OWN} is missing; ${HOW}`);
  assert.equal(unix(readFileSync(path.join(ROOT, OWN), 'utf8')), pretty(made.own), `${OWN} is not what the data gives; ${HOW}`);
});

for (const name of PAGES) {
  test(`site/${name} says what the data files say`, () => {
    const have = unix(disk[name]), want = made.pages[name];
    if (have === want) return;
    // say which part differs, so that the reader knows which data changed
    const parts = [...have.matchAll(/\sdata-built="([^"]+)"/g)].map((m) => m[1]).filter((part) => getBlock(have, part) !== getBlock(want, part));
    assert.fail(`site/${name} is not what the data gives${parts.length ? ` (parts: ${parts.join(', ')})` : ' (a tag or a number outside the made parts)'}; ${HOW}`);
  });
}

test('nothing that the five targets, the comet or the Checks page need was left out for want of data', (t) => {
  for (const what of made.left) t.diagnostic(`left out: ${what}`);
  const needed = made.left.filter((w) => /^(target |check K[0-9]|pair of photos |picture )/.test(w));
  assert.deepEqual(needed, []);
});
