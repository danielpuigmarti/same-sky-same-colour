// The tool that films the thirty seconds of video (tools/demo.mjs): what it reads of the storyboard, how it plans
// its frames, and how it reads a film back. Nothing here opens a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BEATS, ON, FILM, PAGE, BAND, parseArgs, readStoryboard, planFrames, partsOf, cardLines, readProbe, readFrameCount, readPng, shareChanged, jpegSize, rehearsalReasons, sheetHtml } from '../../tools/demo.mjs';
import { fill, parseCaptions, countWords } from '../../tools/render-content.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');

const TEAM = 'Team name', ADDRESS = 'example.org';
const told = readStoryboard({ team: TEAM, address: ADDRESS });

test('the table of beats is the storyboard, line for line', () => {
  assert.deepEqual(told.errors, []);
  const lines = parseCaptions(read('content/captions.txt'), 'captions.txt').captions;
  assert.equal(BEATS.length, lines.length);
  for (const [i, line] of lines.entries()) {
    assert.equal(BEATS[i].caption, line.text, `the caption of beat ${i + 1}`);
    assert.equal(BEATS[i].shot, line.shot, `what beat ${i + 1} shows`);
    const [from, to] = BEATS[i].slot.split('-').map((t) => { const [m, s] = t.split(':').map(Number); return m * 60 + s; });
    assert.deepEqual([from, to], [line.start, line.end], `the time slot of beat ${i + 1}`);
  }
});

test('a caption is what the renderer makes of its line, with the team and the address of the command', () => {
  const numbers = JSON.parse(read('site/data/numbers.json')), site = JSON.parse(read('site/data/site.json'));
  const rendered = parseCaptions(fill(read('content/captions.txt'), 'captions.txt', { numbers, site: { ...site, team: TEAM, url: ADDRESS }, references: null }).text, 'captions.txt').captions;
  assert.deepEqual(told.beats.map((b) => b.text), rendered.map((c) => c.text));
  assert.equal(told.beats[0].text, `${site.name}. Team ${TEAM}. Pluto was found by blinking.`);
  assert.ok(told.beats[told.beats.length - 1].text.endsWith(ADDRESS));
  assert.ok(told.beats.some((b) => b.text.includes(numbers['lemmon.contrast.feb26'].text)));
  for (const b of told.beats) {
    assert.doesNotMatch(b.text, /\{\{|\[team\]|\[url\]/, b.text);
    assert.ok(countWords(b.text) <= 12, `${b.text}: ${countWords(b.text)} words`);
  }
});

test('without a team or an address the tool says which is missing', () => {
  const site = JSON.parse(read('site/data/site.json'));
  const bare = readStoryboard({});
  assert.equal(bare.errors.some((e) => /--team/.test(e)), !site.team);
  assert.equal(bare.errors.some((e) => /--address/.test(e)), !site.url);
});

test('the film stops 0.2 seconds before the thirty, and every beat starts on its second', () => {
  const plan = planFrames(told.beats);
  assert.equal(plan.length, told.beats.length);
  for (const [i, b] of told.beats.entries()) {
    assert.equal(plan[i].from, b.start * FILM.fps);
    if (i) assert.equal(plan[i].from, plan[i - 1].to);
    assert.ok(plan[i].to > plan[i].from);
  }
  const seconds = plan[plan.length - 1].to / FILM.fps;
  assert.ok(seconds <= FILM.limit - FILM.spare + 1e-9 && seconds >= FILM.limit - 1, `${seconds} s`);
  assert.equal(seconds, 29.8);
  // a storyboard that ends earlier is not stretched, and one that would run over is cut at the limit
  assert.equal(planFrames([{ start: 0, end: 2 }, { start: 2, end: 28 }]).at(-1)?.to, 28 * FILM.fps);
  assert.equal(planFrames([{ start: 0, end: 2 }, { start: 2, end: 31 }]).at(-1)?.to, 29.8 * FILM.fps);
});

test('the parts: a card, or a beat that starts off the film, starts a new take', () => {
  assert.deepEqual(partsOf(), [[0], [1, 2], [3, 4], [5], [6], [7], [8]]);
  assert.deepEqual(partsOf([{ card: true, steps: [] }, { steps: [[0.5, 'tap']] }, { steps: [['open', '']] }, { steps: [[1, 'tap']] }]), [[0], [1], [2, 3]]);
});

test('the steps of the table: known words, in the order of their seconds, inside their time slot', () => {
  const known = new Set(['open', 'reach', 'frame', 'wait', 'bar', 'cut', 'pointer', 'move', 'press', 'release', 'tap', 'drag', 'type', 'zoom', 'trim', 'style', 'hide', 'note', 'expect', 'clear']);
  for (const [i, beat] of BEATS.entries()) {
    const length = told.beats[i].end - told.beats[i].start;
    let last = 0;
    for (const step of beat.steps) {
      const timed = typeof step[0] === 'number', verb = timed ? step[1] : step[0];
      assert.ok(known.has(String(verb)), `beat ${i + 1}: "${verb}"`);
      if (!timed) continue;
      const at = Number(step[0]);
      assert.ok(at >= last && at < length, `beat ${i + 1}: the step at second ${at} is out of order or after the beat`);
      last = at;
    }
    assert.ok(['card', 'prepared', 'live'].includes(beat.from));
    assert.equal(Boolean(beat.card), beat.from === 'card');
  }
  // what the take must show is asked of the page in every beat that films the site
  for (const beat of BEATS) if (!beat.card) assert.ok(beat.steps.some((s) => s.includes('expect')), beat.shot);
});

test('the elements are named by role, by text or by a data- attribute, never by a class or a place', () => {
  for (const [name, selector] of Object.entries(ON)) {
    for (const part of selector.split('>>').map((p) => p.trim())) {
      assert.match(part, /^(role=\w+(\[[^\]]+\])?|text=.+|\[data-[\w-]+(="[^"]*")?\]|#[\w-]+|css=canvas|nth=\d+)$/, `${name}: "${part}"`);
    }
  }
});

test('the window, the band and the film fit together', () => {
  assert.equal(PAGE.width * PAGE.scale, FILM.width);
  assert.equal(PAGE.height * PAGE.scale, FILM.height);
  assert.ok(BAND > 0 && BAND < PAGE.height / 4);
});

test('a card: one line a sentence, the name and the address large, the caption kept letter for letter', () => {
  const title = cardLines('Same Sky, Same Colour. Team Team name.', ['Same Sky, Same Colour', 'a.example.org/x']);
  assert.deepEqual(title, [{ text: 'Same Sky, Same Colour.', large: true }, { text: 'Team Team name.', large: false }]);
  const last = cardLines('Next: every new release. a.example.org/x', ['Same Sky, Same Colour', 'a.example.org/x']);
  assert.deepEqual(last, [{ text: 'Next: every new release.', large: false }, { text: 'a.example.org/x', large: true }]);
  for (const text of ['Same Sky, Same Colour. Team Team name.', 'Next: every new release. a.example.org/x', 'One.  Two spaces.', 'No full stop']) {
    assert.equal(cardLines(text, []).map((l) => l.text).join(' '), text);
  }
});

test('the command: what it takes and what it refuses', () => {
  const ok = parseArgs(['--url', 'http://127.0.0.1:9000', '--team', 'A team', '--address', 'a.example.org']);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.options.url, ok.options.team, ok.options.address, ok.options.out, ok.options.sheet], ['http://127.0.0.1:9000/', 'A team', 'a.example.org', 'content/out/video/demo.webm', 'review/video/sheet.png']);
  assert.match(parseArgs(['--speed', '2']).errors[0], /not an option/);
  assert.match(parseArgs(['--team']).errors[0], /needs a value/);
  assert.match(parseArgs(['--url', 'the site']).errors[0], /not an address/);
  assert.match(parseArgs(['--out', 'demo.mp4']).errors[0], /\.webm/);
  assert.match(parseArgs(['--part', '4']).errors[0], /--frames/);
  assert.match(parseArgs(['--part', '12', '--frames', 'x']).errors[0], /1 to 9/);
  assert.deepEqual(parseArgs(['--part', '4', '--frames', 'x']).errors, []);
});

test('what ffmpeg says of a film is read: its length, its size, its frames', () => {
  const said = [
    'Input #0, matroska,webm, from \'demo.webm\':',
    '  Metadata:',
    '    ENCODER         : Lavf61.1.100',
    '  Duration: 00:00:29.80, start: 0.000000, bitrate: 1713 kb/s',
    '  Stream #0:0: Video: vp9 (libvpx-vp9) (Profile 0), yuv420p(tv, bt709, progressive), 1920x1080, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn',
    'At least one output file must be specified',
  ].join('\r\n');
  assert.deepEqual(readProbe(said), { duration: 29.8, codec: 'vp9', width: 1920, height: 1080, fps: 30 });
  assert.equal(readProbe('  Duration: 00:01:02.50, start: 0.0\n  Stream #0:0(eng): Video: vp9, yuv420p, 1280x720, 25 fps')?.duration, 62.5);
  assert.equal(readProbe('demo.webm: No such file or directory'), null);
  assert.equal(readFrameCount('frame=  349 fps=0.0 q=-0.0 size=N/A time=00:00:11.90\rframe=  894 fps=638 q=-0.0 Lsize=N/A time=00:00:29.80 bitrate=N/A speed=21.3x'), 894);
  assert.equal(readFrameCount('nothing was decoded'), null);
});

/**
 * A small PNG: rows of `channels` bytes a pixel, each row written with the filter the caller names.
 * @param {number} width @param {number[][]} rows @param {number} channels @param {number[]} filters
 */
function png(width, rows, channels, filters) {
  const chunk = (/** @type {string} */ name, /** @type {Buffer} */ data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(name, 4, 'latin1'); return Buffer.concat([head, data, Buffer.alloc(4)]); };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = { 1: 0, 3: 2, 4: 6 }[channels] ?? 2;
  const raw = [];
  for (const [y, row] of rows.entries()) {
    raw.push(filters[y]);
    for (let x = 0; x < row.length; x++) {
      const a = x >= channels ? row[x - channels] : 0, b = y ? rows[y - 1][x] : 0, c = x >= channels && y ? rows[y - 1][x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const guess = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filters[y]];
      raw.push((row[x] - guess) & 255);
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
}

test('a PNG is read back, whatever filter its rows were written with', () => {
  const rows = [[10, 20, 30, 40, 50, 60, 250, 0, 5], [11, 22, 33, 44, 55, 66, 0, 255, 6], [200, 100, 50, 25, 12, 6, 3, 1, 0], [9, 9, 9, 8, 8, 8, 7, 7, 7], [1, 2, 3, 4, 5, 6, 7, 8, 9]];
  const got = readPng(png(3, rows, 3, [0, 1, 2, 3, 4]));
  assert.deepEqual([got.width, got.height, got.channels], [3, 5, 3]);
  assert.deepEqual([...got.data], rows.flat());
  assert.throws(() => readPng(Buffer.from('not a picture')), /not a PNG/);
});

test('two pictures of one caption are told from pictures of two captions', () => {
  const blank = Array.from({ length: 8 }, () => new Array(8 * 3).fill(20));
  const lettered = blank.map((row, y) => row.map((v, x) => (y >= 2 && y < 4 && x >= 6 && x < 18 ? 230 : v)));
  const noisy = lettered.map((row) => row.map((v) => v + 9));
  const a = readPng(png(8, lettered, 3, new Array(8).fill(0))), b = readPng(png(8, noisy, 3, new Array(8).fill(1))), c = readPng(png(8, blank, 3, new Array(8).fill(2)));
  const all = { x: 0, y: 0, width: 8, height: 8 };
  assert.equal(shareChanged(a, b, all), 0);
  assert.equal(shareChanged(a, c, all), 8 / 64);
  assert.equal(shareChanged(a, c, { x: 2, y: 2, width: 4, height: 2 }), 1);
  assert.equal(shareChanged(a, c, { x: 0, y: 4, width: 8, height: 4 }), 0);
  assert.throws(() => shareChanged(a, readPng(png(4, blank.map((r) => r.slice(0, 12)), 3, new Array(8).fill(0))), all), /same size/);
});

test('the size of a JPEG is read from its header', () => {
  const start = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const frame = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  assert.deepEqual(jpegSize(Buffer.from([...start, ...frame])), [1920, 1080]);
  assert.deepEqual(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00])), [0, 0]);
});

test('the captions are honest: no figure of the blink is set beside one of another kind, and no "real" is promised', () => {
  const written = read('content/captions.txt');
  const lines = parseCaptions(written, 'captions.txt').captions.map((c) => c.text);
  assert.ok(lines.some((t) => t.includes('{{lie.swing.all}}') && /one visit/.test(t)), 'the 11.8 is said of one visit');
  assert.ok(lines.some((t) => t.includes('{{lie.swing.matched}}') && /two photos matched in colour/i.test(t)), 'the 1.02 is said of two photos matched in colour');
  assert.ok(!lines.some((t) => t.includes('{{lie.swing.all}}') && t.includes('{{lie.swing.matched}}')), 'the two figures are not in one caption');
  for (const t of lines) {
    assert.doesNotMatch(t, /when you blink|only real change|still changes is real|whatever .* is real/i, t);
    assert.doesNotMatch(t, /\d{4}/, `${t}: a year is a number of the page too: write it as one`);
  }
});

test('the storyboard holds no placeholder of a team or an address', () => {
  const written = read('content/captions.txt');
  assert.doesNotMatch(written, /\[team\]|\[url\]|Team name|example\.org/i);
  assert.match(written, /\{\{site\.team\}\}/);
  assert.match(written, /\{\{site\.url\}\}/);
});

test('a run without a real team name or public address is a rehearsal, and its sheet says so', () => {
  assert.deepEqual(rehearsalReasons({ team: 'A real team', address: 'danielpuigmarti.github.io/same-sky-same-colour/' }), []);
  assert.equal(rehearsalReasons({ team: 'Team name', address: 'danielpuigmarti.github.io/same-sky-same-colour/' }).length, 1);
  assert.match(rehearsalReasons({ team: 'Team name', address: 'danielpuigmarti.github.io/x/' })[0], /team/);
  assert.match(rehearsalReasons({ team: 'A real team', address: 'example.org' })[0], /address/);
  assert.match(rehearsalReasons({ team: 'A real team', address: 'http://127.0.0.1:9000/' })[0], /address/);
  assert.equal(rehearsalReasons({}).length, 2);
  assert.equal(rehearsalReasons({ team: '  ', address: null }).length, 2);
  const sheet = { title: 'The film', about: 'about', beats: told.beats, plan: planFrames(told.beats), middles: told.beats.map(() => path.join(ROOT, 'site/data/checks/img/k1-cwave.png')) };
  const one = sheetHtml('http://x/', { ...sheet, rehearsal: rehearsalReasons({ team: 'Team name', address: 'a.org' }) });
  const real = sheetHtml('http://x/', { ...sheet, rehearsal: [] });
  assert.ok(/REHEARSAL, NOT THE FILM TO HAND IN/.test(one) && /<title>REHEARSAL: /.test(one));
  assert.doesNotMatch(real, /REHEARSAL/);
});
