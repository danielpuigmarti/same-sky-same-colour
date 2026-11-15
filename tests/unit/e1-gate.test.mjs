// What the gate refuses beyond the merge: a Checks picture that is missing or is not the reviewed file, a PASS that
// nobody reviewed, a {{key}} in content/ that is not a number. Each is shown on a small project in a temporary folder,
// through the command line as well, and the texts of content/ are filled by the same run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGate } from '../../tools/gate.mjs';

const GATE = fileURLToPath(new URL('../../tools/gate.mjs', import.meta.url));
const PICTURE = Buffer.from('a picture, as far as the gate can tell');
const sha = (/** @type {Buffer | string} */ b) => createHash('sha256').update(b).digest('hex');

/** @param {number} value @param {string} text @param {string | null} [check] */
const num = (value, text, check = null) => ({ value, err: null, unit: null, text, check });

/** @param {string} id @param {Record<string, unknown>} [more] */
const row = (id, more = {}) => ({
  id, title: 'A title', claim: 'A claim', test: 'A test', pass_rule: 'A rule', rule_commit: null, status: 'UNVERIFIED',
  plain: 'not reviewed', value: 1, unit: null, reference: 1, tolerance: 0, image: 'img/a.png', image_sha256: sha(PICTURE),
  reviewer_role: null, reviewed_on: null, rerun: null, ...more,
});

/** @param {Record<string, unknown>} [files] a path and its content: text, a Buffer, or a value written as JSON */
function project(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'e1-'));
  const all = {
    'site/data/site.json': { name: 'A name' },
    'site/data/numbers/one.json': { 'demo.count': num(342, '342', 'demo-check') },
    'site/data/checks/rows/one.json': [row('demo-check')],
    'site/data/checks/img/a.png': PICTURE,
    'site/index.html': '<!doctype html>\n<html lang="en"><head><title data-page=""></title></head><body><span data-n="demo.count"></span></body></html>\n',
    'references/one.md': '## Libraries\n\n- Alpha | https://example.org/alpha | MIT | reading files\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === undefined) continue;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), Buffer.isBuffer(content) || typeof content === 'string' ? content : `${JSON.stringify(content, null, 1)}\n`);
  }
  return { root, run: () => runGate({ root }), check: () => runGate({ root, check: true }), done: () => rmSync(root, { recursive: true, force: true }) };
}

/** @param {string} root @param {string[]} args */
const cli = (root, args) => spawnSync(process.execPath, [GATE, ...args, '--root', root], { encoding: 'utf8' });

test('a Checks picture that matches its hash passes', () => {
  const p = project();
  try {
    assert.deepEqual(p.run().errors, []);
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
});

test('failure 1a: a Checks row whose picture file is missing', () => {
  const p = project({ 'site/data/checks/img/a.png': undefined });
  try {
    const want = 'Checks row "demo-check": image "img/a.png" is missing (site/data/checks/img/a.png)';
    assert.deepEqual(p.run().errors, [want]);
    const out = cli(p.root, ['--check']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /image "img\/a\.png" is missing/);
  } finally { p.done(); }
});

test('failure 1b: a Checks row whose picture is not the file that was reviewed', () => {
  const p = project({ 'site/data/checks/img/a.png': Buffer.from('another picture') });
  try {
    const errors = p.run().errors;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^Checks row "demo-check": image "img\/a\.png" hashes to [0-9a-f]{64} but the row says [0-9a-f]{64}; the file is not the one that was reviewed$/);
    assert.equal(cli(p.root, ['--check']).status, 1);
  } finally { p.done(); }
});

test('a picture outside site/data/checks/ is refused', () => {
  const p = project({ 'site/data/checks/rows/one.json': [row('demo-check', { image: '../../../index.html' })] });
  try {
    assert.deepEqual(p.run().errors, ['Checks row "demo-check": image "../../../index.html" lies outside site/data/checks/']);
  } finally { p.done(); }
});

test('a row without a picture needs none', () => {
  const p = project({ 'site/data/checks/rows/one.json': [row('demo-check', { image: null, image_sha256: null })], 'site/data/checks/img/a.png': undefined });
  try {
    assert.deepEqual(p.run().errors, []);
  } finally { p.done(); }
});

test('failure 2: a PASS row with no reviewer role and no date', () => {
  const p = project({ 'site/data/checks/rows/one.json': [row('demo-check', { status: 'PASS' })] });
  try {
    const errors = p.run().errors;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^site\/data\/checks\/rows\/one\.json: \$\[0\] \(demo-check\): a PASS row needs reviewer_role and reviewed_on$/);
    assert.equal(cli(p.root, ['--check']).status, 1);
  } finally { p.done(); }
  for (const half of [{ reviewer_role: 'physicist' }, { reviewed_on: '2026-11-15' }]) {
    const q = project({ 'site/data/checks/rows/one.json': [row('demo-check', { status: 'PASS', ...half })] });
    try {
      assert.ok(q.run().errors.some((e) => e.includes('a PASS row needs reviewer_role and reviewed_on')), JSON.stringify(half));
    } finally { q.done(); }
  }
  const good = project({ 'site/data/checks/rows/one.json': [row('demo-check', { status: 'PASS', reviewer_role: 'physicist', reviewed_on: '2026-11-15' })] });
  try {
    assert.deepEqual(good.run().errors, []);
  } finally { good.done(); }
});

test('failure 3: a {{key}} in a file under content/ that has no entry in numbers.json', () => {
  const p = project({ 'content/page.md': '# Page\n\nWe counted {{demo.count}}, and {{demo.nothing}} more.\n' });
  try {
    assert.deepEqual(p.run().errors, ['content/page.md: number "demo.nothing" is not in numbers.json']);
    assert.ok(!existsSync(path.join(p.root, 'content/out/page.md')), 'a text with a missing number is not written');
    const out = cli(p.root, ['--check']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /number "demo\.nothing" is not in numbers\.json/);
  } finally { p.done(); }
});

test('the texts of content/ are filled into content/out/ by the same run, and go stale with the numbers', () => {
  const p = project({ 'content/pitch.md': '## Script\n\nWe counted {{demo.count}} things for {{site.name}}.\n\n## Questions\n\n### Why?\n\nBecause.\n' });
  try {
    const first = p.run();
    assert.deepEqual(first.errors, []);
    assert.ok(first.wrote.includes('content/out/pitch.md'));
    assert.match(readFileSync(path.join(p.root, 'content/out/pitch.md'), 'utf8'), /We counted 342 things for A name\./);
    assert.deepEqual(p.check().errors, []);
    writeFileSync(path.join(p.root, 'site/data/numbers/one.json'), `${JSON.stringify({ 'demo.count': num(350, '350', 'demo-check') })}\n`);
    assert.ok(p.check().errors.some((e) => e.startsWith('content/out/pitch.md: differs')));
    const again = p.run();
    assert.deepEqual(again.errors, []);
    assert.match(readFileSync(path.join(p.root, 'content/out/pitch.md'), 'utf8'), /We counted 350 things/);
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
});

test('the gate fails on a project text that says what must not be said', () => {
  const p = project({ 'content/page.md': '## High-level summary\n\nA sentence of our own.\n\nWe confirm the first discovery.\n' });
  try {
    const errors = p.run().errors;
    assert.ok(errors.some((e) => e.includes('"first"')) && errors.some((e) => e.includes('discovery')) && errors.some((e) => e.includes('confirm')), errors.join('\n'));
    assert.ok(errors.some((e) => e.includes('at least 600')));
  } finally { p.done(); }
});
