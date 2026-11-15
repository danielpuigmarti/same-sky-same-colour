// The consistency gate (tools/gate.mjs), run on small sites built in a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGate, repeatedKeys, REFERENCE_HEADINGS } from '../../tools/gate.mjs';

const GATE = fileURLToPath(new URL('../../tools/gate.mjs', import.meta.url));

/** @param {number} value @param {string} text @param {string | null} [check] */
const num = (value, text, check = null) => ({ value, err: null, unit: null, text, check });

/** @param {string} id @param {Record<string, unknown>} [more] */
const row = (id, more = {}) => ({
  id, title: 'A title', claim: 'A claim', test: 'A test', pass_rule: 'A rule', rule_commit: null, status: 'UNVERIFIED',
  plain: 'not reviewed', value: 1, unit: null, reference: 1, tolerance: 0, image: null, image_sha256: null,
  reviewer_role: null, reviewed_on: null, rerun: null, ...more,
});

const PAGE = `<!doctype html>
<html lang="en">
<head><title data-page="Counts"></title></head>
<body>
<a href="./" data-site="name"></a>
<p>There are <span data-n="demo.count"></span> of them, <span class="n" data-n="demo.share" title="share"></span> of all.</p>
</body>
</html>
`;

/**
 * A small project in a temporary folder. `files` maps a path to its content (text, or a value written as JSON).
 * @param {Record<string, unknown>} [files]
 */
function project(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-'));
  const all = {
    'site/data/site.json': { name: 'A & B' },
    'site/data/numbers/one.json': { 'demo.count': num(342, '342', 'demo-check'), 'demo.share': num(0.5, '50 %') },
    'site/data/checks/rows/one.json': [row('demo-check')],
    'site/index.html': PAGE,
    'references/one.md': '## Libraries\n\n- Alpha | https://example.org/alpha | MIT | reading files\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === undefined) continue;
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 1)}\n`);
  }
  return {
    root,
    /** @param {string} rel */
    read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
    /** @param {string} rel @param {unknown} content */
    write: (rel, content) => writeFileSync(path.join(root, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 1)}\n`),
    run: () => runGate({ root }),
    check: () => runGate({ root, check: true }),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('a run merges, fills the pages and joins the references; a second run changes nothing', () => {
  const p = project();
  try {
    const first = p.run();
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.wrote.sort(), ['REFERENCES.md', 'site/data/checks/checks.json', 'site/data/numbers.json', 'site/index.html']);
    assert.deepEqual(JSON.parse(p.read('site/data/numbers.json')), { 'demo.count': num(342, '342', 'demo-check'), 'demo.share': num(0.5, '50 %') });
    assert.deepEqual(JSON.parse(p.read('site/data/checks/checks.json')), [row('demo-check')]);
    const html = p.read('site/index.html');
    assert.ok(html.includes('<span data-n="demo.count">342</span>'));
    assert.ok(html.includes('<span class="n" data-n="demo.share" title="share">50 %</span>'), 'a number is set as it is printed: a no-break space before its unit');
    assert.ok(html.includes('<a href="./" data-site="name">A &amp; B</a>'));
    assert.ok(html.includes('<title data-page="Counts">Counts · A &amp; B</title>'));
    assert.ok(p.read('REFERENCES.md').includes('| Alpha | <https://example.org/alpha> | MIT | reading files |'));

    const second = p.run();
    assert.deepEqual([second.errors, second.wrote], [[], []]);
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
});

test('a deliberately wrong value on a page fails the check, and names the page, the key and both values', () => {
  const p = project();
  try {
    p.run();
    p.write('site/index.html', p.read('site/index.html').replace('>342</span>', '>343</span>'));
    const { errors, wrote } = p.check();
    assert.deepEqual(wrote, []);
    assert.deepEqual(errors, ['site/index.html: number "demo.count" reads "343" on the page and "342" in numbers.json']);
    assert.ok(p.read('site/index.html').includes('>343</span>'), 'the check writes nothing');

    // from the command line: exit code 1 and the message; then a run repairs the page and the check passes
    const cli = spawnSync(process.execPath, [GATE, '--check', '--root', p.root], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /number "demo\.count" reads "343" on the page and "342" in numbers\.json/);
    assert.equal(spawnSync(process.execPath, [GATE, '--root', p.root], { encoding: 'utf8' }).status, 0);
    assert.ok(p.read('site/index.html').includes('<span data-n="demo.count">342</span>'));
    assert.equal(spawnSync(process.execPath, [GATE, '--check', '--root', p.root], { encoding: 'utf8' }).status, 0);
  } finally { p.done(); }
});

test('a number that changes makes the pages stale until the gate is run again', () => {
  const p = project();
  try {
    p.run();
    p.write('site/data/numbers/one.json', { 'demo.count': num(350, '350', 'demo-check'), 'demo.share': num(0.5, '50 %') });
    const stale = p.check().errors;
    assert.ok(stale.some((e) => e.startsWith('site/data/numbers.json: differs')));
    assert.ok(stale.some((e) => e.includes('reads "342" on the page and "350" in numbers.json')));
    assert.deepEqual(p.run().wrote.sort(), ['site/data/numbers.json', 'site/index.html']);
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
});

test('a page that is not filled yet fails the check', () => {
  const p = project();
  try {
    const errors = p.check().errors;
    assert.ok(errors.includes('site/index.html: number "demo.count" reads "" on the page and "342" in numbers.json'));
    assert.ok(errors.some((e) => e.startsWith('site/data/numbers.json: is missing')));
    assert.ok(errors.some((e) => e.startsWith('REFERENCES.md: is missing')));
  } finally { p.done(); }
});

test('a key that is not in numbers.json fails the run and the check', () => {
  const p = project({ 'site/index.html': PAGE.replace('demo.share', 'demo.absent') });
  try {
    const want = 'site/index.html: number "demo.absent" is not in numbers.json';
    assert.ok(p.run().errors.includes(want));
    assert.ok(p.read('site/index.html').includes('<span data-n="demo.count">342</span>'), 'the other numbers are still filled');
    assert.ok(p.check().errors.includes(want));
  } finally { p.done(); }
});

test('a key defined by two producers fails, and nothing is merged', () => {
  const p = project({ 'site/data/numbers/two.json': { 'demo.count': num(1, '1'), 'demo.other': num(2, '2') } });
  try {
    const { errors, wrote } = p.run();
    assert.ok(errors.includes('number "demo.count" is defined twice: in site/data/numbers/one.json and in site/data/numbers/two.json'));
    assert.ok(!wrote.includes('site/data/numbers.json') && !existsSync(path.join(p.root, 'site/data/numbers.json')));
    assert.ok(p.check().errors.some((e) => e.includes('is defined twice')));
  } finally { p.done(); }
});

test('a key written twice in one file fails', () => {
  const twice = '{\n "demo.count": {"value": 1, "err": null, "unit": null, "text": "1", "check": null},\n "demo.share": {"value": 2, "err": null, "unit": null, "text": "2", "check": null},\n "demo.count": {"value": 3, "err": null, "unit": null, "text": "3", "check": null}\n}\n';
  const p = project({ 'site/data/numbers/one.json': twice });
  try {
    assert.ok(p.run().errors.includes('site/data/numbers/one.json: number "demo.count" is defined twice in this file'));
  } finally { p.done(); }
  assert.deepEqual(repeatedKeys(twice), ['demo.count']);
  assert.deepEqual(repeatedKeys('{"a": {"a": 1, "b": {"a": 2}}, "b": ["a", {"a": 1}], "c": "a\\": 1, \\"a"}'), []);
});

test('a Checks row defined by two producers fails', () => {
  const p = project({ 'site/data/checks/rows/two.json': [row('other'), row('demo-check')] });
  try {
    const { errors, wrote } = p.run();
    assert.ok(errors.includes('Checks row "demo-check" is defined twice: in site/data/checks/rows/one.json and in site/data/checks/rows/two.json'));
    assert.ok(!wrote.includes('site/data/checks/checks.json'));
  } finally { p.done(); }
});

test('a PASS row needs a reviewer and a date', () => {
  const bad = project({ 'site/data/checks/rows/one.json': [row('demo-check', { status: 'PASS' })] });
  try {
    assert.ok(bad.run().errors.some((e) => e.includes('a PASS row needs reviewer_role and reviewed_on')));
  } finally { bad.done(); }
  const good = project({ 'site/data/checks/rows/one.json': [row('demo-check', { status: 'PASS', reviewer_role: 'physicist', reviewed_on: '2026-11-15' })] });
  try {
    assert.deepEqual(good.run().errors, []);
  } finally { good.done(); }
});

test('a number that names a check that does not exist fails', () => {
  const p = project({ 'site/data/checks/rows/one.json': [row('another-check')] });
  try {
    assert.ok(p.run().errors.includes('number "demo.count": there is no Checks row "demo-check"'));
  } finally { p.done(); }
});

test('a merged file edited by hand fails the check', () => {
  const p = project();
  try {
    p.run();
    p.write('site/data/numbers.json', { 'demo.count': num(999, '999') });
    assert.ok(p.check().errors.some((e) => e.startsWith('site/data/numbers.json: differs')));
    p.run();
    p.write('site/data/checks/checks.json', []);
    assert.ok(p.check().errors.some((e) => e.startsWith('site/data/checks/checks.json: differs')));
    p.run();
    p.write('REFERENCES.md', `${p.read('REFERENCES.md')}\n- one more line\n`);
    assert.ok(p.check().errors.some((e) => e.startsWith('REFERENCES.md: differs')));
  } finally { p.done(); }
});

test('a number outside a span, or a span with markup inside, cannot be filled', () => {
  const inDiv = project({ 'site/index.html': PAGE.replace('<span data-n="demo.count"></span>', '<b data-n="demo.count"></b>') });
  try {
    assert.ok(inDiv.run().errors.some((e) => e.includes('sits in <b>')));
  } finally { inDiv.done(); }
  const nested = project({ 'site/index.html': PAGE.replace('<span data-n="demo.count"></span>', '<span data-n="demo.count"><b>342</b></span>') });
  try {
    assert.ok(nested.run().errors.some((e) => e.includes('cannot be filled')));
  } finally { nested.done(); }
});

test('the name of the site comes from site.json alone', () => {
  const p = project();
  try {
    p.run();
    p.write('site/data/site.json', { name: 'Another Name' });
    const errors = p.check().errors;
    assert.ok(errors.includes('site/index.html: the name reads "A &amp; B" on the page and "Another Name" in site.json'));
    assert.ok(errors.includes('site/index.html: the title reads "Counts · A &amp; B" and should read "Counts · Another Name"'));
    p.run();
    assert.ok(p.read('site/index.html').includes('<title data-page="Counts">Counts · Another Name</title>'));
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
  const home = project({ 'site/index.html': PAGE.replace('data-page="Counts"', 'data-page=""') });
  try {
    home.run();
    assert.ok(home.read('site/index.html').includes('<title data-page="">A &amp; B</title>'));
  } finally { home.done(); }
  const none = project({ 'site/data/site.json': {} });
  try {
    assert.ok(none.run().errors.includes('site/data/site.json: must be a JSON object with a "name"'));
  } finally { none.done(); }
});

test('files written with a byte-order mark or with Windows line endings are read all the same', () => {
  const bom = '﻿';
  const p = project({
    'site/data/numbers/one.json': `${bom}{\r\n "demo.count": {"value": 342, "err": null, "unit": null, "text": "342", "check": null},\r\n "demo.share": {"value": 0.5, "err": null, "unit": null, "text": "50 %", "check": null}\r\n}\r\n`,
    'site/data/site.json': `${bom}{"name": "A & B"}`,
    'references/one.md': `${bom}## Libraries\r\n\r\n- Alpha | https://example.org/alpha | MIT | reading files\r\n`,
    'site/index.html': PAGE.replaceAll('\n', '\r\n'),
  });
  try {
    assert.deepEqual(p.run().errors, []);
    const html = p.read('site/index.html');
    assert.ok(html.includes('<span data-n="demo.count">342</span>') && html.includes('\r\n</body>'), 'the page keeps its line endings');
    assert.deepEqual(p.check().errors, []);
  } finally { p.done(); }
});

test('a {{key}} in content/ must be a number that exists', () => {
  const p = project({ 'content/page.md': 'We counted {{demo.count}} and {{ demo.absent }}.\n' });
  try {
    assert.deepEqual(p.run().errors, ['content/page.md: number "demo.absent" is not in numbers.json']);
  } finally { p.done(); }
});

test('references: one list under fixed headings, whoever added the entries', () => {
  const p = project({
    'references/one.md': '## Libraries\n- Zeta | https://example.org/zeta | MIT | tests\n- Alpha | https://example.org/alpha | MIT | reading files\n\n## Datasets\n- Sky | https://example.org/sky | public domain | the images\n',
    'references/two.md': '## Libraries\n- Alpha | https://example.org/alpha | MIT | plots\n- Alpha | https://example.org/alpha | MIT | reading files\n## Text sources\n- A paper | https://example.org/paper | CC BY 4.0 | the method\n',
  });
  try {
    assert.deepEqual(p.run().errors, []);
    const lines = p.read('REFERENCES.md').split('\n').filter((l) => l.startsWith('## ') || l.startsWith('| ') && !l.startsWith('| Name'));
    assert.deepEqual(lines, [
      '## Datasets',
      '| Sky | <https://example.org/sky> | public domain | the images |',
      '## Libraries',
      '| Alpha | <https://example.org/alpha> | MIT | reading files; plots |',
      '| Zeta | <https://example.org/zeta> | MIT | tests |',
      '## Text sources',
      '| A paper | <https://example.org/paper> | CC BY 4.0 | the method |',
    ]);
    assert.deepEqual(REFERENCE_HEADINGS, ['Datasets', 'Libraries', 'Tools and services', 'Images and fonts', 'Text sources']);
  } finally { p.done(); }
});

test('references: a wrong heading, a wrong line and two licences for one address all fail', () => {
  const cases = {
    '## Software\n- Alpha | https://example.org/alpha | MIT | x\n': /"Software" is not one of the headings/,
    '- Alpha | https://example.org/alpha | MIT | x\n': /an entry needs a heading above it/,
    '## Libraries\n- Alpha | https://example.org/alpha | MIT\n': /an entry has four parts/,
    '## Libraries\n- Alpha | https://example.org/alpha |  | x\n': /an entry has four parts/,
    '## Libraries\n- Alpha | example.org/alpha | MIT | x\n': /is not an address/,
    '## Libraries\nAlpha, https://example.org/alpha, MIT, x\n': /a line is a heading/,
    '## Libraries\n- Alpha | https://example.org/alpha | MIT | x\n- Alpha | https://example.org/alpha | BSD | y\n': /with another name or licence/,
  };
  for (const [text, message] of Object.entries(cases)) {
    const p = project({ 'references/one.md': text });
    try {
      const { errors, wrote } = p.run();
      assert.ok(errors.some((e) => message.test(e)), `${JSON.stringify(text)} gave ${JSON.stringify(errors)}`);
      assert.ok(!wrote.includes('REFERENCES.md'));
    } finally { p.done(); }
  }
});
