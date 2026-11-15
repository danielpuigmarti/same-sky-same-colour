// The texts that go to the competition page and the video: what is in content/, filled from the numbers of the site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderContent, renderPage, parseCaptions, pitchStats, fill, countChars, countWords, referenceLines, seconds, FIELDS, BANNED } from '../../tools/render-content.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const numbers = JSON.parse(read('site/data/numbers.json'));
const rows = JSON.parse(read('site/data/checks/checks.json'));
const references = existsSync(path.join(ROOT, 'REFERENCES.md')) ? read('REFERENCES.md') : '';
const site = JSON.parse(read('site/data/site.json'));

/** What the gate writes for the whole tree. */
const rendered = renderContent({ root: ROOT, numbers, rows, references });

/** The text of a file of content/ with its numbers filled and nothing else checked. @param {string} name */
const challenge = JSON.parse(read('site/data/challenge.json'));
const filled = (name) => fill(read(`content/${name}`), name, { numbers, site, references, challenge }).text;

/** A text with the {{keys}} taken out, and the few names that carry a digit. @param {string} raw */
const withoutNumbers = (raw) => raw.replace(/\{\{[^}]*\}\}/g, '').replace(/Data Release [13]|Level 2|WISE 0855|Apache-2\.0|spherex_dr1/g, '');

test('the texts of content/ fill without a missing number', () => {
  assert.deepEqual(rendered.errors, []);
  for (const name of ['page.md', 'captions.txt', 'pitch.md']) assert.ok(rendered.files[`content/out/${name}`], name);
});

test('the files on disk are what the run writes', () => {
  for (const [rel, text] of Object.entries(rendered.files)) {
    assert.ok(existsSync(path.join(ROOT, rel)), `${rel} is missing: run "npm run gate"`);
    assert.equal(read(rel), text, `${rel} is stale: run "npm run gate"`);
  }
});

test('no number is typed into a text: digits come only from {{keys}}', () => {
  const captionWords = read('content/captions.txt').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).map((l) => l.split(' | ')[1]).join('\n');
  for (const [name, raw] of [['page.md', read('content/page.md')], ['captions.txt', captionWords], ['pitch.md', read('content/pitch.md')]]) {
    const digits = withoutNumbers(raw).match(/\S*\d\S*/g) ?? [];
    assert.deepEqual(digits, [], `${name} has numbers typed in: ${digits.join(' ')}`);
  }
});

test('page.md: the fields of the project page, each under its own heading, each the right length', () => {
  const out = rendered.files['content/out/page.md'];
  const headings = [...out.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, FIELDS.map((f) => f.heading));
  const page = renderPage(filled('page.md'), 'page.md');
  assert.deepEqual(page.errors, []);
  for (const f of page.fields) {
    const rule = FIELDS.find((x) => x.heading === f.heading);
    assert.ok(rule && f.chars >= rule.min && (rule.max === null || f.chars <= rule.max), `${f.heading}: ${f.chars}`);
    assert.equal(f.chars, countChars(f.body));
    assert.ok(out.includes(`Length: ${String(f.chars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} characters`), `${f.heading}: the count is written under the heading`);
  }
  const by = Object.fromEntries(page.fields.map((f) => [f.heading, f.chars]));
  assert.ok(by['High-level summary'] >= 600 && by['High-level summary'] <= 1400, `summary: ${by['High-level summary']}`);
  assert.ok(by['Detailed description'] >= 2400 && by['Detailed description'] <= 4000, `description: ${by['Detailed description']}`);
});

test('page.md: the challenge is answered line by line, with the status of challenge.json, inside the description field', () => {
  const out = rendered.files['content/out/page.md'];
  const description = out.slice(out.indexOf('## Detailed description'), out.indexOf('## NASA data'));
  assert.equal(challenge.items.length, 17);
  for (const i of challenge.items) {
    const words = { built: 'built', partial: 'partly built', 'not built': 'not built' }[/** @type {'built' | 'partial' | 'not built'} */ (i.status)];
    assert.ok(description.includes(`- ${i.short}: ${words}.`), `${i.id}: ${i.short}: ${words}`);
  }
  assert.ok(!description.includes('{{'), 'no key is left open');
});

test('page.md: each field is also written as a text to paste, and the count is of that text', () => {
  for (const f of renderPage(filled('page.md'), 'page.md').fields) {
    const slug = f.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    assert.equal(rendered.files[`content/out/fields/${slug}.txt`], `${f.body}\n`);
  }
});

test('page.md: the one sentence, the exact NASA products, and the references', () => {
  const page = filled('page.md');
  const sentence = 'Type any sky position and blink NASA SPHEREx images taken months apart at the same infrared colour, so a change of colour cannot pass for a change in the sky, such as comet Lemmon\'s carbon-dioxide glow.';
  assert.ok(page.includes(sentence));
  const nasa = page.slice(page.indexOf('## NASA data'), page.indexOf('## Space agency'));
  for (const part of ['Level 2 spectral images', 'nasa-irsa-spherex', 'NASA/IPAC Infrared Science Archive', 'WCS-WAVE', 'Simple Image Access (SIA)', 'JPL Horizons', 'AllWISE Atlas']) assert.ok(nasa.includes(part), part);
  const partner = page.slice(page.indexOf('## Space agency'));
  assert.match(partner, /Gaia Data Release 3/);
  assert.ok(referenceLines(references).length > 5);
  for (const line of referenceLines(references).slice(0, 5)) assert.ok(partner.includes(line), line);
});

test('page.md and the other texts never say what must not be said', () => {
  for (const name of ['page.md', 'captions.txt', 'pitch.md']) {
    const text = filled(name).replace(/\u0001[^\u0002]*\u0002/g, '');
    const list = text.includes('## Space agency') ? text.slice(0, text.indexOf('The full list')) : text;
    for (const [pattern, why] of BANNED) assert.doesNotMatch(list, pattern, `${name}: ${why}`);
  }
  const page = filled('page.md').slice(0, filled('page.md').indexOf('The full list'));
  assert.doesNotMatch(page, /3I|ATLAS/);
  assert.match(filled('page.md'), /lower limits?/);
});

test('captions.txt: shot by shot, in time, at most twelve words on screen, and the outline of the video', () => {
  const { errors, captions, busiest } = parseCaptions(filled('captions.txt'), 'captions.txt');
  assert.deepEqual(errors, []);
  assert.ok(busiest <= 12 && busiest > 0);
  assert.ok(captions.length >= 8);
  assert.equal(captions[0].start, 0);
  assert.ok(Math.max(...captions.map((c) => c.end)) <= 30);
  for (let i = 1; i < captions.length; i++) assert.ok(captions[i].start >= captions[i - 1].end, `caption ${i + 1} starts before the one above ends`);
  // the official outline: name and team at 0:00, the challenge at 0:02, the title and the tagline by 0:05, how it works
  // and how NASA data made it possible from 0:10, what it could become from 0:20
  assert.ok(captions[0].text.includes(site.name) && /team/i.test(captions[0].text));
  assert.ok(captions.some((c) => c.start === 2 && /SPHEREx/.test(c.text) && /Planet X/.test(c.text)));
  assert.ok(captions.some((c) => c.start <= 5 && c.end > 5 && c.text.includes(numbers['lie.swing.matched'].text) && /matched in colour/.test(c.text)));
  assert.ok(captions.some((c) => c.start <= 5 && c.text.includes(site.name)));
  assert.doesNotMatch(captions.map((c) => c.text).join(' '), /only real change|is real\b/);
  assert.ok(captions.some((c) => c.start <= 10 && c.end > 10 && /NASA/.test(c.text)));
  assert.ok(captions.some((c) => c.start >= 20 && c.end <= 30) && captions.filter((c) => c.start >= 20).length >= 2);
  // the shots of the specification: the flicker, the same colour, the comet, August, a typed star, the address
  const shots = captions.map((c) => c.shot).join('\n');
  for (const part of [/flicker/i, /same colour/i, /Comet Lemmon/, /August/, /Epsilon Indi B/, /address/i]) assert.match(shots, part);
  // the comet is the hero of the first screen: its three panels, in the words of its numbers
  const text = captions.map((c) => c.text).join('\n');
  assert.ok(text.includes(numbers['lemmon.contrast.feb26'].text));
  assert.doesNotMatch(text, /confirm|first|discover/i);
});

test('captions.txt: a line that breaks a rule is reported', () => {
  assert.match(parseCaptions('0:00-0:02 | one two three four five six seven eight nine ten eleven twelve thirteen | shot\n', 'c').errors[0], /13 words are on screen at 0:00/);
  assert.match(parseCaptions('0:00-0:02 | a | s\n0:01-0:03 | b c d e f g h i j k l m | s\n', 'c').errors[0], /13 words are on screen at 0:01/);
  assert.deepEqual(parseCaptions('0:00-0:02 | a | s\n0:02-0:04 | b c d e f g h i j k l m | s\n', 'c').errors, []);
  assert.match(parseCaptions('0:28-0:31 | a | s\n', 'c').errors[0], /after the 30 seconds/);
  assert.match(parseCaptions('0:05-0:03 | a | s\n', 'c').errors[0], /ends before it starts/);
  assert.match(parseCaptions('no times here\n', 'c').errors[0], /a line is/);
  assert.equal(seconds('1:05'), 65);
});

test('pitch.md: a script of three minutes at most, and five one-line answers', () => {
  const text = filled('pitch.md');
  const { errors, words, minutes } = pitchStats(text, 'pitch.md');
  assert.deepEqual(errors, []);
  assert.ok(words >= 330 && minutes <= 3, `${words} words, ${minutes.toFixed(2)} minutes`);
  const questions = text.slice(text.indexOf('## Questions')).split(/^### /m).slice(1);
  assert.equal(questions.length, 5);
  const heads = questions.map((q) => q.split('\n')[0].trim());
  for (const topic of [/new here/i, /absolute flux/i, /IRSA/, /cost/i, /failed/i]) assert.ok(heads.some((h) => topic.test(h)), String(topic));
  for (const q of questions) {
    const body = q.split('\n').slice(1).join('\n').trim();
    assert.ok(!body.includes('\n'), `an answer is one paragraph: ${q.split('\n')[0]}`);
    assert.ok(countWords(body) <= 45 && /[.]$/.test(body), `${q.split('\n')[0]}: ${countWords(body)} words`);
  }
});

test('the comet is described with lower limits and with what is measured', () => {
  assert.equal(numbers['lemmon.contrast.feb26'].check, 'K2');
  const page = filled('page.md');
  assert.ok(page.includes(numbers['lemmon.aperture.arcsec'].text) && page.includes(numbers['lemmon.contrast.feb26'].text));
  assert.doesNotMatch(page, /absolute flux of|moved next day/i);
});

test('five numbers of the text equal the numbers of the Checks rows they name', () => {
  const k2 = rows.find((/** @type {{id: string}} */ r) => r.id === 'K2');
  const k1 = rows.find((/** @type {{id: string}} */ r) => r.id === 'K1');
  assert.ok(k2 && k1);
  const text = filled('page.md') + filled('pitch.md') + filled('captions.txt');
  for (const key of ['lemmon.contrast.feb26', 'lemmon.contrast.feb25', 'lines.pab.fit', 'lines.bra.fit', 'lie.swing.matched']) {
    assert.ok(text.includes(numbers[key].text), key);
    assert.ok(numbers[key].check === null || rows.some((/** @type {{id: string}} */ r) => r.id === numbers[key].check), `${key} names a row that exists`);
  }
  assert.equal(numbers['lemmon.contrast.feb26.exact'].check, k2.id);
  assert.equal(numbers['lines.pab.fit'].check, k1.id);
});

test('fill: numbers, the name, a missing number, a missing team; and the counts', () => {
  const src = { numbers: { 'a.b': { value: 1, err: null, unit: null, text: '1.5', check: null } }, site: { name: 'N' }, references: null };
  assert.equal(fill('{{a.b}} and {{ site.name }}', 'f', src).text, '1.5 and N');
  assert.deepEqual(fill('{{a.c}}', 'f', src).errors, ['f: number "a.c" is not in numbers.json']);
  const team = fill('{{site.team}}', 'f', src);
  assert.deepEqual([team.text, team.open, team.errors], ['[team]', ['site.team'], []]);
  assert.equal(fill('{{@references}}', 'f', src).errors.length, 1);
  assert.equal(countChars('a😀b'), 3);
  assert.equal(countWords(' one  two\nthree '), 3);
  assert.equal(pitchStats('## Script\n\nOne two [skip this] three.\n\n## Questions\n\nMany more words here.\n', 'p').words, 3);
});

test('renderPage: a field that is too short or too long is reported with its count', () => {
  const short = renderPage('## High-level summary\n\nToo short.\n', 'p');
  assert.deepEqual(short.errors, ['p: "High-level summary" has 10 characters; at least 600']);
  const long = renderPage(`## High-level summary\n\n${'x'.repeat(1401)}\n`, 'p');
  assert.deepEqual(long.errors, ['p: "High-level summary" has 1401 characters; at most 1400']);
  assert.match(long.text, /Length: 1,401 characters \(600 to 1,400\)/);
});

test('the review of the final text: a name, a team or an address that is missing, and numbers nobody reviewed, are reported', () => {
  const draft = renderContent({ root: ROOT, numbers, rows, references });
  assert.ok(draft.notes.some((n) => n.includes('site.team') || n.includes('nobody has reviewed')) || draft.notes.length === 0);
  const final = renderContent({ root: ROOT, numbers, rows, references, final: true });
  assert.deepEqual(final.errors, draft.notes, 'with final, what is not yet right is an error');
});
