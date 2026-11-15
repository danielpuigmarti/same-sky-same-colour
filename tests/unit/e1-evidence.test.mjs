// The challenge line by line, the table of tested tasks, the review sheet and the numbers of this part: each held to
// the files it speaks about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REVIEWS, PEOPLE, reviewRows, renderTable, renderReviewReadme } from '../../tools/review.mjs';
import { checkNumbers } from '../../tools/contracts.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const json = (/** @type {string} */ rel) => JSON.parse(read(rel));
const numbers = json('site/data/numbers.json');
const rows = json('site/data/checks/checks.json');
const challenge = json('site/data/challenge.json');
const tried = json('site/data/tried.json');
const names = json('site/data/names.json');

/** The decisions that other parts wrote: {S1: {eps-indi-b: {build}}, S5: {build}, ...}. */
const decisions = Object.assign({}, ...readdirSync(path.join(ROOT, 'site/data/checks/decisions')).filter((n) => n.endsWith('.json')).map((n) => json(`site/data/checks/decisions/${n}`)));

test('challenge.json: every line has a kind, a status, and a place', () => {
  const kinds = new Set(challenge.items.map((/** @type {{kind: string}} */ i) => i.kind));
  assert.deepEqual([...kinds].sort(), ['COULD', 'MUST']);
  assert.ok(challenge.items.filter((/** @type {{kind: string}} */ i) => i.kind === 'MUST').length >= 3);
  assert.ok(challenge.items.filter((/** @type {{kind: string}} */ i) => i.kind === 'COULD').length >= 9);
  const ids = challenge.items.map((/** @type {{id: string}} */ i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'an id is used twice');
  for (const item of challenge.items) {
    assert.ok(['built', 'partial', 'not built'].includes(item.status), `${item.id}: ${item.status}`);
    assert.ok(item.line.length > 20 && item.note.length > 20, `${item.id}: a line and a note in words`);
    assert.doesNotMatch(`${item.line} ${item.note}`.replace(/WISE 0855/g, ''), /\d/, `${item.id}: a number typed in a line`);
    if (item.status === 'not built') assert.ok(item.where === null && item.files.length === 0, `${item.id}: nothing that is not built is linked`);
    else assert.ok(item.files.length > 0 && (item.where || item.status === 'partial'), `${item.id}: a line that is built names its view; one that is partial names its files`);
  }
});

test('challenge.json: each address opens a view that exists, and each file is in the tree', () => {
  for (const item of challenge.items) {
    for (const where of [item.where, ...(item.also ?? [])].filter(Boolean)) {
      const m = /^([a-z]+\.html)(\?([^#]*))?(#(.+))?$/.exec(where);
      assert.ok(m, `${item.id}: "${where}" is not a page of the site`);
      const [, page, , query, , fragment] = m;
      assert.ok(existsSync(path.join(ROOT, 'site', page)), `${item.id}: site/${page} does not exist`);
      if (fragment) assert.match(read(`site/${page}`), new RegExp(`id="${fragment}"`), `${item.id}: no #${fragment} in ${page}`);
      const target = new URLSearchParams(query ?? '').get('t');
      if (target) assert.ok(names.entries.some((/** @type {{id: string}} */ e) => e.id === target) || existsSync(path.join(ROOT, 'site/data/targets', target)), `${item.id}: unknown target ${target}`);
      const mode = new URLSearchParams(query ?? '').get('mode');
      if (mode) assert.ok(['blink', 'diff', 'curtain', 'side', 'flip'].includes(mode), `${item.id}: mode ${mode}`);
    }
    for (const file of item.files) assert.ok(existsSync(path.join(ROOT, file)), `${item.id}: ${file} is not in the tree`);
  }
});

test('challenge.json: nothing is marked built that a decision has switched off or has not yet made', () => {
  const find = (/** @type {string} */ ref) => ref.split('.').reduce((/** @type {any} */ o, k) => (o === undefined ? undefined : o[k]), decisions);
  for (const item of challenge.items) {
    for (const ref of item.decisions) {
      const d = find(ref);
      if (item.status === 'built') assert.ok(d && d.build === true, `${item.id} is built but ${ref} is not decided in its favour`);
      if (d && d.build === false) assert.notEqual(item.status, 'built', `${item.id}: ${ref} is switched off`);
    }
  }
  const five = challenge.items.find((/** @type {{id: string}} */ i) => i.id === 'must-targets');
  assert.equal(five.status, 'built');
  assert.equal([five.where, ...five.also].filter((w) => /^view\.html\?t=/.test(w)).length, 5, 'the five named targets each have their address');
});

test('challenge.json: the challenge text is covered: coordinates, a little video, the five targets and the suggestions', () => {
  const text = challenge.items.map((/** @type {{line: string}} */ i) => i.line).join('\n');
  for (const part of [/coordinates/, /little video/, /Barnard/, /Epsilon Indi B/, /WISE 0855|WISE/, /RW Aurigae/, /R Draconis/, /new data|update/i, /colours/, /six detectors/, /spectra/i, /add or subtract/, /field of view/i, /Gaia/, /address/, /flags/, /Astropy/, /Aladin/]) assert.match(text, part);
});

test('tried.json: six tasks, the bar written before any session, and every count a real count', () => {
  assert.equal(tried.tasks.length, 6);
  assert.equal(new Set(tried.tasks.map((/** @type {{id: string}} */ t) => t.id)).size, 6);
  assert.equal(tried.pass_bar.testers, numbers['e1.tried.testers'].value);
  assert.equal(tried.pass_bar.needed, numbers['e1.tried.bar'].value);
  assert.equal(tried.tasks.length, numbers['e1.tried.tasks'].value);
  assert.match(tried.pass_bar.rule, /at least 4 of 5 testers complete .* without help/);
  assert.match(tried.pass_bar.written_on, /^\d{4}-\d{2}-\d{2}$/);
  for (const t of tried.tasks) {
    for (const k of ['attempted', 'completed']) assert.ok(t[k] === null || Number.isInteger(t[k]), `${t.id}.${k}`);
    if (t.completed !== null) {
      assert.ok(t.attempted !== null && t.completed <= t.attempted, `${t.id}: completed is more than attempted`);
      assert.equal(t.passed, t.completed >= tried.pass_bar.needed && t.attempted >= tried.pass_bar.testers, `${t.id}: passed is the bar applied to the counts, not rounded`);
    } else assert.equal(t.passed, null);
  }
  assert.equal(tried.session.adults_confirmed === true && tried.session.testers === null, false);
  assert.doesNotMatch(JSON.stringify(tried), /@/, 'no address of a person');
});

test('the numbers of this part are valid, and each is what its source file says', () => {
  const mine = json('site/data/numbers/e1.json');
  assert.deepEqual(checkNumbers(mine), []);
  assert.ok(Object.keys(mine).every((k) => k.startsWith('e1.')));
  // the bands of RW Aurigae that ship: the decision of the check that decides them
  const bands = Object.values(decisions.S2).map((/** @type {{build: boolean}} */ b) => b.build);
  assert.equal(mine['e1.rwaur.bands.total'].value, bands.length);
  assert.equal(mine['e1.rwaur.bands.shown'].value, bands.filter(Boolean).length);
  assert.equal(mine['e1.rwaur.bands.hidden'].value, bands.filter((b) => !b).length);
  // the dates of the comet's photos: the first photo of the hero is in August, the second in February
  const stamps = json('site/data/lemmon/hero/manifest.json').frames;
  const date = (/** @type {number} */ mjd) => { const d = new Date(Date.UTC(1858, 10, 17) + mjd * 86400000); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${d.getUTCFullYear()}`; };
  assert.ok(Array.isArray(stamps), 'the manifest of the hero lists its frames');
  assert.equal(date(stamps[0].mjd), mine['e1.lemmon.date.aug'].text);
  assert.equal(date(stamps[1].mjd), mine['e1.lemmon.date.feb'].text);
  assert.equal(date(mine['e1.lemmon.date.aug'].value), mine['e1.lemmon.date.aug'].text);
  assert.equal(date(mine['e1.lemmon.date.feb'].value), mine['e1.lemmon.date.feb'].text);
});

test('K14: the row of consistency and literature is there, unreviewed until someone has read it', () => {
  const k14 = rows.find((/** @type {{id: string}} */ r) => r.id === 'K14');
  assert.ok(k14);
  assert.ok(k14.status !== 'PASS' || (k14.reviewer_role && k14.reviewed_on));
  assert.match(k14.rerun, /gate/);
});

test('review: fifteen reviews, H1 to H15, 75 minutes, in two blocks, each with what is asked for', () => {
  assert.deepEqual(REVIEWS.map((r) => r.id), Array.from({ length: 15 }, (_, i) => `H${i + 1}`));
  assert.equal(REVIEWS.reduce((n, r) => n + r.minutes, 0), 75);
  assert.equal(REVIEWS.filter((r) => r.block === 'Sunday 08:00').reduce((n, r) => n + r.minutes, 0), 44);
  assert.equal(REVIEWS.filter((r) => r.block === 'Sunday 15:00').reduce((n, r) => n + r.minutes, 0), 31);
  for (const r of REVIEWS) {
    assert.ok(r.title && r.open && r.rule && r.number.label && r.command, r.id);
    assert.ok(r.minutes > 0 && r.rule.length < 330, `${r.id}: the rule is a line`);
    if (r.number.key) assert.ok(Object.hasOwn(numbers, r.number.key), `${r.id}: ${r.number.key} is not a number`);
    if (r.number.err) assert.ok(Object.hasOwn(numbers, r.number.err), `${r.id}: ${r.number.err} is not a number`);
  }
  assert.equal(PEOPLE.find((p) => p[0] === 'Sunday 08:00')?.[2], 44);
  assert.equal(PEOPLE.find((p) => p[0] === 'Sunday 15:00')?.[2], 31);
  assert.ok(PEOPLE.some((p) => p[0] === 'Tonight' && p[2] === 30) && PEOPLE.some((p) => p[0] === 'Sunday 09:00' && p[2] === 60) && PEOPLE.some((p) => p[0] === 'Sunday 12:00' && p[2] === 15));
});

test('review: the sheets that exist are the ones the table says exist, and the numbers are the site\'s', () => {
  const table = reviewRows({ root: ROOT, numbers, rows });
  for (const r of table) {
    const stem = r.id.toLowerCase();
    const md = existsSync(path.join(ROOT, 'review', `${stem}.md`)), png = existsSync(path.join(ROOT, 'review', `${stem}.png`));
    assert.equal(r.sheet.startsWith('yes'), md && png, r.id);
    if (r.number.key) assert.ok(r.value.includes(numbers[r.number.key].text), `${r.id}: ${r.value}`);
    else if (r.id !== 'H15') assert.match(r.value, /not measured yet/);
  }
  assert.ok(table.find((r) => r.id === 'H1')?.value.includes(numbers['lemmon.contrast.feb26.exact'].text));
  const h15 = table.find((r) => r.id === 'H15');
  assert.match(h15?.value ?? '', new RegExp(`: ${rows.filter((/** @type {{status: string}} */ r) => r.status === 'UNVERIFIED').length} of ${rows.length}$`));
  // the sheets say the same command as the table
  for (const r of table.filter((x) => x.sheet.startsWith('yes') && /python -m sx\.run (\w+)/.test(x.command) && read(`review/${x.id.toLowerCase()}.md`).includes('sx.run'))) {
    const job = /python -m sx\.run (\w+)/.exec(r.command)?.[1];
    assert.match(read(`review/${r.id.toLowerCase()}.md`), new RegExp(`sx\\.run ${job}\\b`), `${r.id}: its sheet does not name ${job}`);
  }
});

test('review/README.md is what review.mjs writes, and --list prints its table', () => {
  assert.equal(read('review/README.md'), renderReviewReadme({ root: ROOT, numbers, rows }), 'run "npm run gate"');
  const list = spawnSync(process.execPath, [path.join(ROOT, 'tools/review.mjs'), '--list'], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.trimEnd(), renderTable(reviewRows({ root: ROOT, numbers, rows })));
  assert.ok(read('review/README.md').includes(list.stdout.trimEnd()));
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'tools/review.mjs')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
