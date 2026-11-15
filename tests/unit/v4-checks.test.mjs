// The Checks page: the three sentences it opens on, the filter, one card for each row, the table of what the tool
// can and cannot see, the challenge line by line and the table of observed use.
//
// The makers are tried on rows written here, so that every status and every count is seen, and then on the rows,
// the limits, the challenge and the tasks of the site itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { esc, getBlock, STATUS_STAMP } from '../../site/js/ui/cards.js';
import {
  STATUS_ORDER, STATUS_NAME, STATUS_MEANS, countKey, countRows, countNumbers, sortRows, checksIntro, checksFilter, checksList, checkCard,
  limitsNumbers, limitsTables, challengeLines, challengeScorecard, challengeText, triedNumbers, triedTable,
} from '../../site/js/ui/checks.js';
import { buildChecks, checksNumbers } from '../../site/js/pages/checks.js';
import { checkChecks, checkNumbers } from '../../tools/contracts.mjs';
import { ROOT, loadSite, makePages, readPages, wordsOf } from '../fixtures/v4/make.mjs';

const site = loadSite();
const made = makePages(site, readPages());
const page = made.pages['checks.html'];

/** A valid row, for a test. @param {string} id @param {string} status @param {Record<string, unknown>} [more] */
const row = (id, status, more = {}) => /** @type {any} */ ({
  id, title: `Title of ${id}`, claim: `Claim of ${id}.`, test: `Test of ${id}.`, pass_rule: `Rule of ${id}.`, rule_commit: null, status,
  plain: `words of ${id}`, value: null, unit: null, reference: null, tolerance: null, image: null, image_sha256: null,
  reviewer_role: status === 'PASS' ? 'a physics student' : null, reviewed_on: status === 'PASS' ? '2026-11-15' : null, rerun: null, ...more,
});

/** What the makers are given for a list of rows: the counts as numbers, and pictures of one size. @param {any[]} rows @param {Record<string, any>} [numbers] */
const build = (rows, numbers = {}) => ({ numbers: { ...countNumbers(rows), ...numbers }, rows, size: () => /** @type {[number, number]} */ ([800, 400]), left: /** @type {string[]} */ ([]) });

/** @param {string} html */
const keysOf = (html) => [...html.matchAll(/\sdata-n="([^"]+)"/g)].map((m) => m[1]);

/** @param {string} html  The words of some HTML on one line, as they read. */
const said = (html) => wordsOf(html).replace(/\s+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').trim();

test('the rows are counted by status, and the counts are numbers of the page', () => {
  const rows = [row('K1', 'PASS'), row('K2', 'UNVERIFIED'), row('K3', 'UNVERIFIED'), row('K4', 'LIMIT'), row('K5', 'FAIL'), row('K6', 'CORRECTED')];
  assert.deepEqual(checkChecks(rows), [], 'the rows of this test are valid');
  assert.deepEqual(countRows(rows), { PASS: 1, CORRECTED: 1, LIMIT: 1, UNVERIFIED: 2, FAIL: 1, total: 6 });
  const numbers = countNumbers(rows);
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(Object.fromEntries(Object.entries(numbers).map(([k, n]) => [k, n.text])), {
    'v4.checks.total': '6', 'v4.checks.pass': '1', 'v4.checks.corrected': '1', 'v4.checks.limit': '1', 'v4.checks.unverified': '2', 'v4.checks.fail': '1',
    'v4.checks.reviewed': '1', 'v4.checks.notbuilt': '0',
  });
  assert.equal(countKey('UNVERIFIED'), 'v4.checks.unverified');
  assert.deepEqual(countRows([]), { PASS: 0, CORRECTED: 0, LIMIT: 0, UNVERIFIED: 0, FAIL: 0, total: 0 });
});

test('the cards stand in the order K1, K2, ..., each followed by the rows that hang on it, then the others as given', () => {
  const ids = ['d2-align', 'K14', 'K10', 'K3-corrected', 'K-pluto', 'K2', 'K3', 'K1-limit', 'x-other', 'K1', 'K-gallery', 'K6-rdra', 'K6'];
  assert.deepEqual(sortRows(ids.map((id) => row(id, 'UNVERIFIED'))).map((r) => r.id),
    ['K1', 'K1-limit', 'K2', 'K3', 'K3-corrected', 'K6', 'K6-rdra', 'K10', 'K14', 'K-pluto', 'K-gallery', 'd2-align', 'x-other']);
});

test('the page opens on what it is, in plain words, then what the checks cover and how many a person has looked at; each count is a number of the page', () => {
  const intro = (/** @type {any[]} */ rows) => {
    const b = build(rows), html = checksIntro(b, rows);
    assert.deepEqual(b.left, []);
    for (const m of html.matchAll(/<span data-n="([^"]+)">([^<]*)<\/span>/g)) assert.equal(m[2], b.numbers[m[1]].text, m[1]);
    assert.ok(!/\d/.test(html.replace(/<span data-n="[^"]+">[^<]*<\/span>/g, '').replace('3I/ATLAS', '')), 'no digit outside a number but the comet’s name');
    return [...html.matchAll(/<p[^>]*>(.*?)<\/p>/g)].map((m) => said(m[1]));
  };
  const some = intro([row('K1', 'UNVERIFIED'), row('K2', 'CORRECTED'), row('K3', 'LIMIT'), row('K4', 'FAIL')]);
  assert.equal(some.length, 3);
  assert.ok(some[0].startsWith('Nothing here is for you to do.'), 'first what the page is, for a visitor who is not a scientist');
  assert.equal(some[1], 'In short: of 4 checks, 0 have passed, 1 failed, 1 mark limits, 1 corrected an earlier figure and 1 were run by the code but not reviewed by a person. A person reviewed 0 of 4 within the hackathon, and a check counts as passed only once a person has reviewed it. Where a check failed, its row says what was switched off because of it.', 'then the bottom line, every count a number of the page');
  assert.ok(some[2].startsWith('There are 4 checks, for what the site claims:'), 'then how many, and what they cover');
  assert.ok(some[2].endsWith('a person has reviewed the result.'));
  const looked = intro([row('K1', 'PASS'), row('K2', 'UNVERIFIED')]);
  assert.ok(looked[1].includes('A person reviewed 1 of 2 within the hackathon'));
  const keyed = checksIntro(build([row('K1', 'FAIL')]), [row('K1', 'FAIL')]);
  assert.deepEqual([...keyed.matchAll(/<dt><span class="status-mark" data-status="([a-z]+)" aria-hidden="true"><\/span>([^<]+)<\/dt>/g)].map((m) => [m[1], m[2]]),
    [['fail', 'Failed'], ['limit', 'A limit'], ['corrected', 'Corrected'], ['pass', 'Passed'], ['unverified', 'Not reviewed by a person']], 'a key to the five marks');
  assert.ok(intro([row('K1', 'PASS')])[2].startsWith('There is 1 check, for what'), 'one check is said in the singular');
});

test('the filter offers "All" and each status that has a row, with the count in each choice, and nothing is chosen but "All"', () => {
  const rows = [row('K1', 'PASS'), row('K2', 'UNVERIFIED'), row('K3', 'UNVERIFIED'), row('K4', 'FAIL')];
  const b = build(rows), html = checksFilter(b, rows);
  assert.deepEqual([...html.matchAll(/<input type="radio" name="show" value="([^"]+)"( checked)?>/g)].map((m) => [m[1], m[2] !== undefined]),
    [['all', true], ['FAIL', false], ['PASS', false], ['UNVERIFIED', false]]);
  assert.deepEqual(keysOf(html), ['v4.checks.total', 'v4.checks.fail', 'v4.checks.pass', 'v4.checks.unverified']);
  assert.match(html, /<fieldset class="cfilter" data-filter>\n<legend>Show<\/legend>/);
  assert.match(html, /<p class="visually-hidden" role="status" data-filter-status><\/p>/);
  assert.equal(said(html), 'Show All 4 Failed 1 Passed 1 Not reviewed by a person 2');
});

test('the stylesheet hides, for each choice of the filter, the rows of the other statuses, and never the row an address names', () => {
  const css = readFileSync(path.join(ROOT, 'site/css/cards.css'), 'utf8');
  for (const status of STATUS_ORDER) {
    assert.ok(css.includes(`.checks:has(.cfilter input[value="${status}"]:checked) .ccard:not([data-status="${status}"]):not(:target)`), status);
  }
});

test('a row opens to the claim, the number with its reference and tolerance, the pass rule, the status in plain words, the review and the command', () => {
  const full = row('K5', 'PASS', {
    value: '0.5', unit: 'arcsec', reference: 73.9, tolerance: '4.2 arcsec', image: 'img/k5.png', image_sha256: 'ab'.repeat(32),
    rerun: 'python -m sx.run targets', rule_commit: '0123456789abcdef',
  });
  assert.deepEqual(checkChecks([full]), []);
  const b = build([full]), html = checkCard(b, full);
  assert.deepEqual(b.left, []);
  assert.ok(html.startsWith('<li class="ccard" id="K5" data-status="PASS">\n<details class="ccard-details" open>'));
  // the line of the row: the mark and the word of its status, its id, its title and its figure
  const [line] = /<summary class="ccard-row">.*?<\/summary>/.exec(html) ?? [''];
  assert.equal(said(line), 'K5 Passed Title of K5 0.5 arcsec');
  assert.ok(line.includes('<span class="status-mark"'), 'the mark of the status');
  assert.ok(html.includes(`<span class="stamp" data-status="PASS">${STATUS_STAMP.PASS}</span>`), 'the status, as a stamp, in the entry');
  assert.ok(html.includes('<p class="ccard-claim">Claim of K5.</p>'));
  assert.ok(html.includes('<a href="data/checks/img/k5.png"><img src="data/checks/img/k5.png" width="800" height="400" alt="The picture of this check: Title of K5."'), 'the picture, with a way to its full size');
  assert.ok(html.includes('<code>abababababababab</code>'), 'the start of the SHA-256 of the picture');
  assert.ok(html.includes('The picture this check rests on; it opens at full size.') && !html.includes('was reviewed'), 'a caption that is true whether or not a person has looked');
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map((m) => [m[1], said(m[2])]), [
    ['Measured', '0.5 arcsec'], ['Reference', '73.9'], ['Tolerance', '4.2 arcsec'], ['Pass rule', 'Rule of K5.'],
    ['What the status means', STATUS_MEANS.PASS], ['In plain words', 'words of K5'], ['How it was tested', 'Test of K5.'],
    ['Rule recorded as', '0123456789ab'], ['Run it again', 'python -m sx.run targets'],
  ]);
  assert.ok(html.includes('a physics student, <time datetime="2026-11-15">15 November 2026</time>'), 'who looked at it, and when');
  assert.ok(html.includes('<dd><code>python -m sx.run targets</code></dd>'));
  // one list item, one disclosure: nothing else hides what the row says
  assert.equal(html.split('<details').length, 2);
});

test('a long figure stays out of the line of its row; a row leaves out what it does not have, and says when nobody has reviewed it', () => {
  const bare = row('K9', 'UNVERIFIED');
  const b = build([bare]), html = checkCard(b, bare);
  assert.ok(!html.includes('<figure') && !html.includes('ccard-values') && !html.includes('Run it again'));
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['Pass rule', 'What the status means', 'In plain words', 'How it was tested']);
  assert.ok(html.includes('<dt class="cell-label">Reviewed</dt><dd class="cell-value">Not yet</dd>'));
  assert.ok(html.includes('<span class="ccard-figure"></span>'), 'the line has no figure');
  const wide = row('K6', 'LIMIT', { value: 'D1 +18.8% (13 pairs) not shown; D2 +36.0% (11 pairs); D3 +28.2% (14 pairs)' });
  assert.ok(checkCard(build([wide]), wide).includes('<span class="ccard-figure"></span>'), 'a sentence is not read in the line');
  // a picture that is not in the site is left out and said
  const lost = row('K8', 'FAIL', { image: 'img/gone.png', image_sha256: 'cd'.repeat(32) });
  const none = { ...build([lost]), size: () => null };
  assert.ok(!checkCard(none, lost).includes('<figure'));
  assert.deepEqual(none.left, ['picture data/checks/img/gone.png']);
  // the number 0 is a value; an empty text is not
  assert.ok(checkCard(build([]), row('K7', 'UNVERIFIED', { value: 0, reference: 0, tolerance: 0.1 })).includes('<dt>Measured</dt><dd>0</dd>'));
  assert.ok(!checkCard(build([]), row('K7', 'UNVERIFIED', { value: '' })).includes('Measured'));
});

test('a long value reads as a sentence, a short one as a reading; what a row says is never taken as markup', () => {
  const long = row('K6', 'LIMIT', { value: 'D1 +18.8% (13 pairs) not shown; D2 +36.0% (11 pairs); D3 +28.2% (14 pairs)', reference: 'short' });
  const html = checkCard(build([long]), long);
  assert.match(html, /<dt>Measured<\/dt><dd class="is-long">D1 /);
  assert.match(html, /<dt>Reference<\/dt><dd>short<\/dd>/);
  const sharp = row('K2', 'UNVERIFIED', { title: 'a < b & "c"', claim: '<script>alert(1)</script>', value: '<b>1</b>', plain: '<i>x</i>', rerun: 'run > out', test: '</p><p>', pass_rule: '<img src=x>' });
  const safe = checkCard(build([sharp]), sharp);
  for (const raw of ['<script>', '<b>1</b>', '<i>x</i>', '<img src=x>', '</p><p>']) assert.ok(!safe.includes(raw), raw);
  assert.ok(safe.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && safe.includes('a &lt; b &amp; "c"') && safe.includes('<code>run &gt; out</code>'));
});

test('the list is one ruled row for each check: failures, limits, corrections, then passed, then not reviewed by a person', () => {
  const rows = [row('K1', 'UNVERIFIED'), row('K2', 'PASS'), row('K3-corrected', 'CORRECTED'), row('K4', 'LIMIT'), row('K8', 'FAIL')];
  const html = checksList(build(rows), rows);
  assert.deepEqual([...html.matchAll(/<li class="ccard" id="([^"]+)" data-status="([A-Z]+)">/g)].map((m) => [m[1], m[2]]), [['K8', 'FAIL'], ['K4', 'LIMIT'], ['K3-corrected', 'CORRECTED'], ['K2', 'PASS'], ['K1', 'UNVERIFIED']]);
  assert.ok(html.startsWith('<ol class="checklist" aria-label="The checks">'));
});

// ---- what the tool can and cannot see ----

const LIMITS = {
  units: 5, fraction: 0.8,
  table: {
    coadd: [
      { speed_arcsec_per_year: 0.1, shift_px: 0.008038, limit_mjy: { 1: 562.341325190349, 2: 100 } },
      { speed_arcsec_per_year: 200, shift_px: 16.07698, limit_mjy: { 1: null, 2: 3.1622776601683795 } },
    ],
  },
};

test('the table of limits: every cell is a number of the page, and a detector in which nothing shows says so', () => {
  const numbers = limitsNumbers(LIMITS);
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(Object.fromEntries(Object.entries(numbers).map(([k, n]) => [k, `${n.text} ${n.unit}`])), {
    'v4.limits.coadd.1.speed': '0.1 arcsec per year', 'v4.limits.coadd.1.shift': '0.01 pixels', 'v4.limits.coadd.1.d1': '560 mJy', 'v4.limits.coadd.1.d2': '100 mJy',
    'v4.limits.coadd.2.speed': '200 arcsec per year', 'v4.limits.coadd.2.shift': '16.08 pixels', 'v4.limits.coadd.2.d2': '3.2 mJy',
  });
  assert.ok(Object.values(numbers).every((n) => n.check === 'K10'));
  const rule = { 'limits.units': { value: 5, err: null, unit: null, text: '5', check: 'K10' }, 'limits.fraction_pct': { value: 80, err: null, unit: '%', text: '80', check: 'K10' } };
  const b = build([row('K10', 'UNVERIFIED')], { ...numbers, ...rule });
  const html = limitsTables(b, LIMITS);
  assert.deepEqual(b.left, []);
  assert.match(html, /<h2 id="limits-title">/);
  assert.equal((html.match(/<table class="ledger limits">/g) ?? []).length, 1, 'the view the file does not hold gives no table');
  assert.deepEqual([...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m) => m[1]), ['Speed, arcsec a year', 'Shift between the visits, pixels', 'Detector 1', 'Detector 2']);
  const lines = html.split('<tbody>')[1].split('</tbody>')[0].trim().split('\n');
  assert.deepEqual(lines.map(said), ['0.1 0.01 560 100', '200 16.08 not seen 3.2']);
  assert.deepEqual(keysOf(lines[1]), ['v4.limits.coadd.2.speed', 'v4.limits.coadd.2.shift', 'v4.limits.coadd.2.d2']);
  assert.ok(html.includes('reaches <span data-n="limits.units">5</span> times the noise in at least <span data-n="limits.fraction_pct">80</span> of every hundred tries'));
  assert.ok(html.includes('href="checks.html#K10"'), 'the tag of its check');
  // without the numbers of the rule the sentence is left out; without a table there is no part at all
  const plain = build([], numbers);
  assert.ok(!limitsTables(plain, LIMITS).includes('times the noise'));
  assert.deepEqual(plain.left, []);
  assert.equal(limitsTables(build([]), { table: {} }), '');
  assert.equal(limitsTables(build([]), {}), '');
  assert.deepEqual(limitsNumbers(null), {});
});

// ---- the challenge, line by line ----

test('the challenge line by line: what it asks for and what it suggests, each with its status and the view that does it', () => {
  const challenge = {
    updated: '2026-11-14',
    items: [
      { id: 'must-a', kind: 'MUST', line: 'A public tool.', status: 'built', where: 'index.html', note: 'Static files.' },
      { id: 'must-b', kind: 'MUST', line: 'Tried on five targets.', status: 'partial', where: 'targets.html', also: ['view.html?t=barnard', 'view.html?t=unknown', 7] },
      { id: 'could-a', kind: 'COULD', line: 'Easy to update.', status: 'not built' },
      { id: 'could-b', kind: 'COULD', line: 'Unknown status.', status: 'done' },
      { kind: 'COULD', status: 'built' },
    ],
  };
  const html = challengeLines(challenge, { barnard: "Barnard's Star" });
  assert.deepEqual([...html.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['What it asks for', 'What it suggests']);
  assert.deepEqual([...html.matchAll(/<li class="line" id="([^"]*)" data-status="([^"]+)">/g)].map((m) => [m[1], m[2]]), [['must-a', 'built'], ['must-b', 'partial'], ['could-a', 'not built']]);
  assert.deepEqual([...html.matchAll(/<p class="line-status"><span class="status-mark"[^>]*><\/span>([^<]+)<\/p>/g)].map((m) => m[1]), ['Built', 'Partly built', 'Not built']);
  assert.ok(html.includes('<a href="index.html">See it<span class="visually-hidden">: A public tool.</span></a>'));
  assert.ok(html.includes('<a href="view.html?t=barnard">Barnard\'s Star</a>') && !html.includes('t=unknown'), 'a link to a target that is known, and none to one that is not');
  assert.ok(html.includes('<p class="line-note">Static files.</p>'));
  assert.ok(html.includes('As of <time datetime="2026-11-14">14 November 2026</time>.'));
  assert.ok(!said(html).includes('Unknown status'), 'a line with a status the page does not know is left out');
  assert.equal(challengeLines({ items: [] }), '');
  assert.equal(challengeLines(null), '');
});

test('the scorecard of the first page: one line for each line of the challenge, with the status words of the Checks page', () => {
  const challenge = {
    items: [
      { id: 'a', kind: 'MUST', line: 'A public tool.', short: 'Public tool', status: 'built', where: 'index.html' },
      { id: 'b', kind: 'COULD', line: 'Choose it.', short: 'Choose it', status: 'not built', where: null },
      { id: 'c', kind: 'COULD', line: 'Half of it.', status: 'partial', where: 'view.html' },
      { id: 'd', kind: 'COULD', line: 'Odd.', status: 'done' },
    ],
  };
  const html = challengeScorecard(challenge);
  assert.deepEqual([...html.matchAll(/<li class="score" data-status="([^"]+)">/g)].map((m) => m[1]), ['built', 'not built', 'partial']);
  assert.deepEqual([...html.matchAll(/<span class="score-status"><span class="status-mark"[^>]*><\/span>([^<]+)<\/span>/g)].map((m) => m[1]), ['Built', 'Not built', 'Partly built']);
  assert.ok(html.includes('<a href="index.html">See it<span class="visually-hidden">: A public tool.</span></a>'));
  assert.equal(html.match(/See it/g)?.length, 2, 'a line with no view has no link');
  assert.deepEqual(challengeText(challenge), ['- Public tool: built.', '- Choose it: not built.'], 'the text has the lines that have a short form');
  assert.equal(challengeScorecard({ items: [] }), '');
  assert.equal(challengeScorecard(null), '');
  assert.deepEqual(challengeText(null), []);
});

test('the scorecard on the real first page is the file challenge.json, line by line, in the same order', () => {
  const items = site.checks.challenge.items;
  const rows = [...made.pages['index.html'].matchAll(/<li class="score" data-status="([^"]+)">\s*<span class="score-line">([^<]*)<\/span>/g)];
  assert.equal(rows.length, items.length);
  const plain = (/** @type {string} */ t) => t.replace(/&#39;|’/g, "'").replace(/&amp;/g, '&');
  rows.forEach((m, k) => {
    assert.equal(m[1], items[k].status);
    assert.equal(plain(m[2]), plain(items[k].line));
  });
  assert.ok(items.every((/** @type {{short?: string}} */ i) => typeof i.short === 'string' && i.short.length > 3), 'every line has a short form for the project page');
});

// ---- observed use ----

const TRIED = {
  pass_bar: { written_on: '2026-11-14', rule: 'A task counts as passed when most testers complete it without help.' },
  session: { date: null, testers: null, roles: [], adults_confirmed: false },
  tasks: [{ id: 'a', task: 'Find the star.', attempted: null, completed: null, passed: null, quote: null }, { id: 'b', task: 'Say why it flickers.', attempted: null, completed: null, passed: null, quote: null }],
  spot_the_mover: { built: false, hits: null, of: null, testers: null },
  community: { posts: null, replies: null, quotes: [] },
};

test('observed use, before the session: the tasks and the bar, and nothing beside them', () => {
  assert.deepEqual(triedNumbers(TRIED), {});
  const b = build([]), html = triedTable(b, TRIED);
  assert.deepEqual(b.left, []);
  assert.match(html, /<h2 id="tried-title">TRIED BY<\/h2>/);
  assert.ok(html.includes('The session has not been held yet.'));
  assert.ok(html.includes('The bar, written on <time datetime="2026-11-14">14 November 2026</time>: a task counts as passed when most testers complete it without help.'));
  const lines = html.split('<tbody>')[1].split('</tbody>')[0].trim().split('\n');
  assert.deepEqual(lines.map(said), ['Find the star. not tried yet', 'Say why it flickers. not tried yet']);
  assert.deepEqual(keysOf(html), []);
  assert.equal(triedTable(build([]), { tasks: [] }), '');
  assert.equal(triedTable(build([]), null), '');
});

test('observed use, after the session: every count is a number of the page, whichever way it went', () => {
  const after = {
    ...TRIED,
    session: { date: '2026-11-15', testers: 5, roles: ['a teacher', 'a designer'], adults_confirmed: true },
    tasks: [{ ...TRIED.tasks[0], attempted: 5, completed: 4, passed: true, quote: 'It <jumps>!' }, { ...TRIED.tasks[1], attempted: 5, completed: 1, passed: false, quote: null }],
    spot_the_mover: { built: true, hits: 9, of: 12, testers: 1 },
    community: { posts: 1, replies: 2, quotes: ['Looks right.'] },
  };
  const numbers = triedNumbers(after);
  assert.deepEqual(checkNumbers(numbers), []);
  assert.deepEqual(Object.fromEntries(Object.entries(numbers).map(([k, n]) => [k, n.value])), {
    'v4.tried.task1.completed': 4, 'v4.tried.task1.attempted': 5, 'v4.tried.task2.completed': 1, 'v4.tried.task2.attempted': 5,
    'v4.tried.testers': 5, 'v4.tried.spot.hits': 9, 'v4.tried.spot.of': 12, 'v4.tried.spot.testers': 1, 'v4.tried.posts': 1, 'v4.tried.replies': 2,
  });
  const b = build([], numbers), html = triedTable(b, after);
  assert.deepEqual(b.left, []);
  assert.ok(said(html).includes('The session was held on 15 November 2026 with 5 testers (a teacher, a designer). Each is named by role and nothing else.'));
  const lines = html.split('<tbody>')[1].split('</tbody>')[0].trim().split('\n');
  assert.deepEqual(lines.map(said), ['Find the star. 4 of 5 Passed “It <jumps>!”', 'Say why it flickers. 1 of 5 Not passed']);
  assert.ok(html.includes('“It &lt;jumps&gt;!”'));
  assert.ok(said(html).includes('Spot the mover: 9 right of 12, by 1 tester.'));
  assert.ok(said(html).includes('Asked for checking in 1 place; 2 replies. “Looks right.”'));
  assert.deepEqual([...new Set(keysOf(html))].sort(), Object.keys(numbers).sort(), 'every count stands in the page as a number');
  assert.ok(!/\d/.test(said(html.replace(/<span data-n="[^"]+">[^<]*<\/span>/g, '').replace(/<time [^>]*>[^<]*<\/time>/g, ''))), 'no digit outside a number or a date');
});

// ---- the page of the site ----

test('the Checks page of the site has a card for every row, in order, each with the id that a tag leads to', () => {
  assert.deepEqual(checkChecks(site.rows), []);
  const cards = [...page.matchAll(/<li class="ccard" id="([^"]+)" data-status="([A-Z]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cards, sortRows(site.rows).map((r, i) => ({ r, i })).sort((p, q) => STATUS_ORDER.indexOf(p.r.status) - STATUS_ORDER.indexOf(q.r.status) || p.i - q.i).map(({ r }) => [r.id, r.status]));
  assert.equal(new Set(cards.map(([id]) => id)).size, cards.length);
  // the ids of the page are unique, so that an address finds one card
  const ids = [...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  // every row shows its picture when it has one, and the page says nothing was missing
  for (const r of site.rows.filter((x) => x.image)) assert.ok(page.includes(`<a href="data/checks/${r.image}"><img src="data/checks/${r.image}"`), r.id);
  assert.deepEqual(made.left.filter((w) => w.startsWith('picture data/checks/')), []);
});

test('the filter of the site counts the rows of each status, and the opening says how many there are and how many a person has looked at', () => {
  const n = countRows(site.rows);
  const intro = /<div class="checks-intro" data-built="intro">\n([\s\S]*?)\n<\/div>/.exec(page)?.[1] ?? '';
  assert.equal((intro.match(/<p>/g) ?? []).length, 1, 'one paragraph of words, besides the plain sentence and the bottom line');
  assert.equal(new RegExp('<span data-n="v4.checks.reviewed">(\\d+)</span>').exec(intro)?.[1], String(site.rows.filter((r) => r.reviewer_role && r.reviewed_on).length));
  assert.equal(new RegExp(`<span data-n="${countKey('total')}">(\\d+)</span>`).exec(intro)?.[1], String(site.rows.length));
  assert.equal(n.PASS + n.CORRECTED + n.LIMIT + n.UNVERIFIED + n.FAIL, site.rows.length, 'every row has a status the page knows');
  // the same counts stand on the buttons of the filter
  for (const status of STATUS_ORDER.filter((s) => n[s] > 0)) {
    assert.match(page, new RegExp(`<input type="radio" name="show" value="${status}">[\\s\\S]*?<span class="cfilter-name">${{ FAIL: 'Failed', LIMIT: 'Limits', CORRECTED: 'Corrected', PASS: 'Passed', UNVERIFIED: 'Not reviewed by a person' }[status]}</span> <span class="cfilter-count"><span data-n="${countKey(status)}">${n[status]}</span></span>`));
  }
});

test('the numbers the Checks page adds are the counts, the cells of the limits and the counts of observed use', () => {
  const own = checksNumbers(site.rows, site.checks);
  assert.deepEqual(checkNumbers(own), []);
  for (const [key, n] of Object.entries(own)) assert.deepEqual(made.own[key], n, key);
  // every cell of the limits file is in the page with the value of the file
  for (const [view, rows] of Object.entries(site.checks.limits?.table ?? {})) {
    for (const [i, r] of /** @type {any[]} */ (rows).entries()) {
      for (const [det, v] of Object.entries(r.limit_mjy)) {
        const key = `v4.limits.${view}.${i + 1}.d${det}`;
        if (v === null) assert.ok(!(key in own), key);
        else {
          assert.equal(own[key].value, v, key);
          assert.ok(page.includes(`<span data-n="${key}">${esc(own[key].text)}</span>`), key);
        }
      }
    }
  }
});

test('the parts that depend on a file are there when the file is, and empty when it is not', () => {
  const b = { numbers: { ...site.numbers, ...made.own }, rows: site.rows, size: site.size, left: /** @type {string[]} */ ([]) };
  const parts = buildChecks(b, site.checks);
  assert.equal(parts.limits !== '', site.checks.limits !== null);
  assert.equal(parts.challenge !== '', site.checks.challenge !== null);
  assert.equal(parts['tried-by'] !== '', site.checks.tried !== null);
  const none = buildChecks({ ...b, rows: [], left: [] }, { limits: null, challenge: null, tried: null, names: {} });
  assert.deepEqual(none, { intro: '', checks: '', limits: '', challenge: '', 'tried-by': '' });
  // the challenge of the site: every line is there with its status, and every view it names is a page of the site
  const items = site.checks.challenge?.items ?? [];
  assert.equal((getBlock(page, 'challenge')?.match(/<li class="line"/g) ?? []).length, items.length);
  for (const m of (getBlock(page, 'challenge') ?? '').matchAll(/<a href="([^"#?]+)/g)) assert.ok(['index.html', 'view.html', 'lemmon.html', 'targets.html', 'checks.html'].includes(m[1]), m[1]);
});
