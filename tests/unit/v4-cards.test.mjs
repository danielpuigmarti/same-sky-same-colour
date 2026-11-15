// The cards of the targets page and the parts of the comet page: what is made from the data, what is left out when
// the data lacks it, and what these two pages may say.
//
// The parts that are always shown are made here from the data files of the site. The parts that are shown only
// when their checks allow them (the gallery, "Can you spot it?", Pluto) are made from tests/fixtures/v4/optional.json,
// which is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  esc, attr, dateWords, markDates, numberSpan, fill, tagLink, fillTags, getBlock, setBlock, fillNumbers, targetCard, STATUS_STAMP,
} from '../../site/js/ui/cards.js';
import { buildTargets, TARGET_ORDER } from '../../site/js/pages/targets.js';
import { buildComet, cometNumbers } from '../../site/js/pages/lemmon.js';
import { ROOT, PAGES, loadSite, makePages, readPages, withOptional, wordsOf } from '../fixtures/v4/make.mjs';
import { setNumber } from '../../site/js/lib/setnumber.js';

const site = loadSite();
const made = makePages(site, readPages());
const optional = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/v4/optional.json'), 'utf8'));

/** What the makers are given, fresh, so that each test sees only what it left out itself. @param {any} [data] @param {any} [change] */
const build = (data = site, change = {}) => ({ numbers: { ...data.numbers, ...made.own }, rows: data.rows, size: data.size, left: /** @type {string[]} */ ([]), ...change });

/** @param {string} html @returns {string[]} The keys of the numbers a piece of HTML carries. */
const keysOf = (html) => [...html.matchAll(/\sdata-n="([^"]+)"/g)].map((m) => m[1]);

/** A row of the Checks page, valid, for a test. @param {string} id @param {string} status @param {string} plain */
const row = (id, status, plain) => ({
  id, title: `Title of ${id}`, claim: 'A claim.', test: 'A test.', pass_rule: 'A rule.', rule_commit: null, status, plain,
  value: null, unit: null, reference: null, tolerance: null, image: null, image_sha256: null,
  reviewer_role: status === 'PASS' ? 'a reviewer' : null, reviewed_on: status === 'PASS' ? '2026-11-15' : null, rerun: null,
});

/** @param {string} text */
const number = (text) => ({ value: Number(text), err: null, unit: null, text, check: null });

// ---- the small makers ----

test('text is escaped between tags and inside attributes', () => {
  assert.equal(esc('<a & "b">'), '&lt;a &amp; "b"&gt;');
  assert.equal(attr('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('a date is written in words and marked as a date; anything else stays as it is', () => {
  assert.equal(dateWords('2026-11-14'), '<time datetime="2026-11-14">14 November 2026</time>');
  assert.equal(dateWords('2026-02-05'), '<time datetime="2026-02-05">5 February 2026</time>');
  assert.equal(dateWords('soon <b>'), 'soon &lt;b&gt;');
  assert.equal(dateWords('2026-13-01'), '2026-13-01');
  assert.equal(dateWords(null), 'null');
});

test('the dates in a sentence are marked: a month, a day, a moment, a date in figures and a year alone', () => {
  assert.equal(markDates('From April 2025 to 26 February 2026.'), 'From <time datetime="2025-04">April 2025</time> to <time datetime="2026-02-26">26 February 2026</time>.');
  assert.equal(markDates('25 Feb 2026, 07:12 UTC'), '<time datetime="2026-02-25T07:12Z">25 Feb 2026, 07:12 UTC</time>');
  assert.equal(markDates('taken from 2010-04-28 on'), 'taken from <time datetime="2010-04-28">2010-04-28</time> on');
  assert.equal(markDates('WISE, 2010'), 'WISE, <time datetime="2010">2010</time>');
  assert.equal(markDates('It was seen in 2010.'), 'It was seen in <time datetime="2010">2010</time>.');
  // a year is a year only when it stands alone: not inside the number of a star, the name of a tile, an epoch or
  // a longer number
  for (const s of ['Gaia DR3 6412596012146801152', 'tile 3306m561_ac51', 'epoch J2016.0', '2010m561', 'went 2010.5 pixels', 'at 0.2010 of it', '1,2010,3']) {
    assert.equal(markDates(s), s);
  }
});

test('a number is carried as a span with its key and its text; one that does not exist is left out and said', () => {
  const b = build(undefined, { numbers: { 'a.b': number('1.50') } });
  assert.equal(numberSpan(b, 'a.b'), '<span data-n="a.b">1.50</span>');
  assert.equal(numberSpan(b, 'a.c'), '');
  assert.deepEqual(b.left, ['number a.c']);
});

test('a sentence is written whole or not at all', () => {
  const b = build(undefined, { numbers: { n: number('7'), m: number('3') } });
  assert.equal(fill(b, 'Moved {{n}} arcsec since 2010; {{ m }} < {{n}} & more.'),
    'Moved <span data-n="n">7</span> arcsec since <time datetime="2010">2010</time>; <span data-n="m">3</span> &lt; <span data-n="n">7</span> &amp; more.');
  assert.equal(fill(b, 'Has {{n}} and {{nowhere}}.'), '');
  assert.deepEqual(b.left, ['number nowhere']);
  for (const nothing of [undefined, null, '', 5, {}]) assert.equal(fill(b, nothing), '');
});

test('a tag is a quiet link to the entry of its check: the mark of the row, drawn by the stylesheet, and its id', () => {
  const b = build(undefined, { rows: [row('K1', 'PASS', 'checked against Gaia'), row('K3-corrected', 'CORRECTED', 'corrected, see why')] });
  const tag = tagLink(b, 'K1');
  assert.equal(tag, `<a class="check-link" data-check="K1" data-status="PASS" href="checks.html#K1" aria-label="Check K1: passed"><span class="status-mark" data-status="pass" aria-hidden="true"></span>K1</a>`);
  const own = tagLink(b, 'K3-corrected', 'an earlier figure');
  assert.ok(own.includes('href="checks.html#K3-corrected"') && own.includes('data-words="an earlier figure"') && own.includes('>K3-corrected<') && own.includes('data-status="CORRECTED"'), own);
  assert.equal(tagLink(b, 'K9'), '');
  assert.deepEqual(b.left, ['check K9']);
});

test('the tags a page holds in its own words are filled from the rows, and one without a row is left as it was', () => {
  const b = build(undefined, { rows: [row('K1', 'UNVERIFIED', 'the words of the row')] });
  const page = '<p>One <a class="tag" data-check="K1"></a>, two <a class="tag" data-check="K1" data-words="own words"></a>, three <a class="tag" data-check="K8" data-status="PASS" href="checks.html#K8">old</a>.</p>';
  const filled = fillTags(page, b);
  const mark = '<span class="status-mark" data-status="unverified" aria-hidden="true"></span>';
  assert.ok(filled.includes(`href="checks.html#K1" aria-label="Check K1: not reviewed by a person">${mark}K1</a>`), filled);
  assert.ok(filled.includes(`data-words="own words" data-status="UNVERIFIED" href="checks.html#K1" aria-label="Check K1: not reviewed by a person">${mark}K1</a>`), filled);
  assert.ok(filled.includes('<a class="tag" data-check="K8" data-status="PASS" href="checks.html#K8">old</a>'), filled);
  // filling twice changes nothing: the pages are made again and again
  assert.equal(fillTags(filled, build(undefined, { rows: b.rows })), filled);
});

test('a made part is found, replaced and emptied without touching what is around it', () => {
  const page = '<main>\n<section class="x" data-built="a">\nold\n</section>\n<div data-built="b"><div>in</div><div>ner</div></div>\n<p>after</p>\n</main>';
  assert.equal(getBlock(page, 'a'), 'old');
  assert.equal(getBlock(page, 'b'), '<div>in</div><div>ner</div>');
  assert.equal(getBlock(page, 'nowhere'), null);
  assert.equal(setBlock(page, 'a', 'new'), page.replace('\nold\n', '\nnew\n'));
  assert.equal(getBlock(setBlock(page, 'b', '<div>1</div>'), 'b'), '<div>1</div>');
  // an empty part leaves nothing inside its element, not even a line break: the stylesheet hides an empty section
  assert.ok(setBlock(page, 'a', '').includes('<section class="x" data-built="a"></section>'));
  assert.equal(setBlock(setBlock(page, 'a', ''), 'a', 'old'), page);
  assert.throws(() => setBlock(page, 'nowhere', 'x'), /data-built="nowhere"/);
});

test('the numbers of a page are filled as the gate fills them', () => {
  const numbers = { a: number('2'), 'b.c': number('3.0') };
  assert.equal(fillNumbers('<span class="k" data-n="a">old</span> <span data-n="b.c"></span> <span data-n="zz">kept</span>', numbers),
    '<span class="k" data-n="a">2</span> <span data-n="b.c">3.0</span> <span data-n="zz">kept</span>');
});

// ---- the five targets ----

const cardOf = (/** @type {string} */ id, b = build()) => {
  const t = site.targets.targets.find((x) => x.card.id === id);
  assert.ok(t, `the site has the target ${id}`);
  return { html: targetCard(b, t.card, t.manifest, { folder: `data/targets/${id}/`, viewer: id }), card: t.card, manifest: t.manifest, b };
};

test('the page holds one card for each of the five targets, in the order of the challenge', () => {
  const ids = [...(getBlock(made.pages['targets.html'], 'targets') ?? '').matchAll(/<article class="item tcard" id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['eps-indi-b', 'barnard', 'wise0855', 'rw-aur', 'r-dra']);
  assert.deepEqual(ids, [...TARGET_ORDER]);
});

for (const id of TARGET_ORDER) {
  test(`${id}: its card has the two visits, a verdict that opens its check, its reference and a way into the viewer`, () => {
    const { html, card, manifest, b } = cardOf(id);
    assert.deepEqual(b.left, [], 'nothing the card names is missing');
    assert.ok(html.startsWith(`<article class="item tcard" id="${id}" data-kind="${card.kind}" aria-labelledby="${id}-name">`));
    assert.ok(html.includes(`<h2 class="object-name tcard-name" id="${id}-name">${esc(card.name.toUpperCase())}</h2>`));
    // the blink: the picture of the first pair, and the showcase it is drawn from
    assert.ok(html.includes(`<figure class="tcard-blink" data-blink data-manifest="data/targets/${id}/manifest.json">`));
    assert.match(html, new RegExp(`<img class="blink-still" src="data/targets/${id}/pair\\.png" width="\\d+" height="\\d+" alt="Two photos of the patch of sky around `));
    assert.ok(keysOf(html).includes(`targets.${id}.pairs`), 'how many pairs match in colour');
    // the two months of the caption are those of the two photos of that pair
    const [i, j] = manifest.pairs[0];
    const month = (/** @type {number} */ mjd) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date((mjd - 40587) * 86400000));
    const [early, late] = [i, j].map((k) => manifest.frames[k].mjd).sort((p, q) => p - q).map(month);
    assert.ok(html.includes(`<div class="cell" data-visit="early"><dt class="cell-label">Earlier visit</dt><dd class="cell-value">${markDates(early)}</dd></div>`), 'the earlier month of the pair that is shown');
    assert.ok(html.includes(`<div class="cell" data-visit="late"><dt class="cell-label">Later visit</dt><dd class="cell-value">${markDates(late)}</dd></div>`), 'the later month');
    // its check is a quiet link that leads to a row that exists, with the plain words of the check beside it
    const tag = new RegExp(`<a class="check-link" data-check="${card.check}" data-words="${esc(card.plain)}" data-status="[A-Z]+" href="checks\.html#${card.check}" aria-label="[^"]*"><span class="status-mark" data-status="[a-z]+" aria-hidden="true"></span>${card.check}</a>`);
    assert.match(html, tag);
    assert.ok(site.rows.some((r) => r.id === card.check), `the row ${card.check} exists`);
    assert.ok(html.includes(`<cite>${esc(card.reference.text)}</cite>`), 'the reference');
    assert.ok(html.includes(`<a href="view.html?t=${id}">Blink it yourself<span class="visually-hidden">: ${esc(card.name)}</span></a>`));
    // an object that moves leads with the flip of the picture of long ago and SPHEREx's, and says that nothing moves between the visits
    if (card.kind === 'mover') {
      assert.ok(html.indexOf('class="tcard-jump"') < html.indexOf('class="tcard-blink"'), 'the flip comes first');
      assert.ok(html.includes('<figure class="tcard-jump" data-jump data-lead-flip>'));
      assert.ok(keysOf(html).includes(`v4.targets.${id}.visits_px`), 'how far it goes between the visits');
      assert.ok(html.includes('Between these two visits the star moves about'));
    } else {
      assert.ok(html.indexOf('class="tcard-blink"') < html.indexOf('class="tcard-text"'), 'the blink comes first');
      assert.ok(html.includes('It does not move'));
    }
    // every number of the card is a number of numbers.json, with its text
    for (const key of keysOf(html)) assert.ok(html.includes(`<span data-n="${key}">${esc(setNumber(b.numbers[key].text))}</span>`), key);
  });
}

test('the three movers show the image of 2010 beside SPHEREx, named as such, with what was measured, the reference, the difference and the tolerance', () => {
  for (const id of ['eps-indi-b', 'barnard', 'wise0855']) {
    const { html, card } = cardOf(id);
    assert.equal(card.kind, 'mover');
    assert.ok(html.includes('With a WISE image of <time datetime="2010">2010</time>, on the same grid'), id);
    for (const p of card.jump.panels) assert.ok(html.includes(`src="data/targets/${id}/${p.file}"`), `${id}: ${p.file}`);
    assert.equal((html.match(/<svg class="jump-marks"/g) ?? []).length, 2, `${id}: marks on both pictures`);
    assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['Measured', 'Reference', 'Gap between the two shifts', 'Tolerance', 'In SPHEREx alone'], id);
    for (const what of ['shift.measured', 'shift.catalogue', 'shift.diff', 'shift.tolerance', 'position.off_px', 'position.tolerance_px']) {
      assert.ok(keysOf(html).includes(`targets.${id}.${what}`), `${id}: ${what}`);
    }
  }
});

test('a mover seen to move within SPHEREx alone says so, with its own check', () => {
  const moving = site.targets.targets.filter((t) => t.card.motion?.build === true);
  for (const { card } of moving) {
    const { html } = cardOf(card.id);
    assert.match(html, new RegExp(`<p class="tcard-motion">[^\\n]*data-check="${card.motion.check}"`), card.id);
  }
  // and a card whose motion was not allowed says nothing about it
  const still = site.targets.targets.find((t) => t.card.kind === 'mover' && t.card.motion?.build !== true);
  if (still) assert.ok(!cardOf(still.card.id).html.includes('tcard-motion'));
  const b = build();
  const t = site.targets.targets.find((x) => x.card.id === 'eps-indi-b');
  const off = targetCard(b, { ...t?.card, motion: { ...t?.card.motion, build: false } }, t?.manifest, { folder: 'data/targets/eps-indi-b/', viewer: 'eps-indi-b' });
  assert.ok(!off.includes('tcard-motion'));
});

test('the variable star shows its change band by band, and the bands too close to saturation without a figure', () => {
  const { html, card } = cardOf('rw-aur');
  assert.equal(card.kind, 'variable');
  const shown = card.bands.filter((/** @type {any} */ band) => band.shown === true).length;
  assert.equal((html.match(/<li data-det="\d" data-shown="true">/g) ?? []).length, shown);
  assert.equal((html.match(/<li data-det="\d" data-shown="false">/g) ?? []).length, card.bands.length - shown);
  assert.ok(shown > 0 && shown < card.bands.length, 'some bands are shown and some are not');
  // a band that is not shown gives its colours and its reason, and no change
  for (const li of html.match(/<li data-det="\d" data-shown="false">.*<\/li>/g) ?? []) {
    assert.deepEqual(keysOf(li).map((k) => k.replace(/^rwaur\.d\d\./, '')), ['colour.from', 'colour.to'], li);
  }
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['Compared with', 'Tolerance', 'The star']);
  assert.ok(keysOf(html).includes('v4.tolerance.rw-aur'));
  assert.equal(made.own['v4.tolerance.rw-aur'].value, site.targets.tolerances['rw-aur'].comparison_median_pct);
  assert.ok(!html.includes('tcard-jump'), 'no jump for a star that stays put');
});

test('the saturated star gets no number of its own: how many photos are saturated, and nothing measured', () => {
  const { html, card } = cardOf('r-dra');
  assert.equal(card.kind, 'saturated');
  assert.deepEqual([...new Set(keysOf(html))].sort(), ['targets.r-dra.frames', 'targets.r-dra.pairs', 'targets.r-dra.saturated']);
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['The star']);
  for (const not of ['<dt>Measured', '<dt>Tolerance', '<dt>Gap between the two shifts', 'class="bands"', 'tcard-jump']) assert.ok(!html.includes(not), not);
  assert.ok(html.includes('<span class="tag-plain">too bright to measure</span>'), 'the status in plain words');
  assert.ok(html.includes('The middle of the star is left empty'), 'the caption says why the middle is empty');
});

test('a line whose number is missing is left out, and the rest of the card stays', () => {
  const numbers = { ...site.numbers, ...made.own };
  delete numbers['targets.eps-indi-b.shift.diff'];
  const b = build(undefined, { numbers });
  const { html } = cardOf('eps-indi-b', b);
  assert.deepEqual([...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ['Measured', 'Reference', 'Tolerance', 'In SPHEREx alone']);
  assert.deepEqual(b.left, ['number targets.eps-indi-b.shift.diff']);
  assert.ok(!/<span data-n="[^"]*">\s*<\/span>/.test(html), 'no empty number');

  delete numbers['targets.eps-indi-b.shift.measured'];
  const without = cardOf('eps-indi-b', build(undefined, { numbers })).html;
  assert.ok(!without.includes('<dt>Measured</dt>'));
  assert.ok(!without.includes('tcard-verdict'), 'the sentence of the verdict goes');
  assert.ok(without.includes('<a class="check-link" data-check="K5"'), 'its check stays');
});

test('a picture that is not there is left out and said, and its figure with it', () => {
  const b = build(undefined, { size: () => null });
  const { html } = cardOf('eps-indi-b', b);
  assert.ok(!html.includes('<img') && !html.includes('<figure'));
  assert.deepEqual(b.left.filter((w) => w.startsWith('picture ')).sort(), ['picture data/targets/eps-indi-b/pair.png', 'picture data/targets/eps-indi-b/spherex.png', 'picture data/targets/eps-indi-b/wise2010.png']);
  assert.ok(html.includes('<dt>Measured</dt>'), 'the words stay');
});

// ---- the parts that are shown only when their checks allow them ----

test('the site as it is: the decisions decide whether the gallery, "Can you spot it?" and Pluto are on the page', () => {
  const parts = buildTargets(build(), site.targets);
  const built = (/** @type {string} */ key) => site.targets.decisions?.[key]?.build === true;
  assert.equal(parts.gallery !== '', built('S4') && site.targets.gallery !== null && site.targets.gallery.cards.length > 0);
  assert.equal(parts['spot-it'] !== '', built('S4') && site.targets.spotit !== null);
  assert.equal(parts.pluto !== '', built('S5') && site.targets.pluto !== null);
  // an empty part leaves its section empty in the page, which the stylesheet hides
  for (const part of ['gallery', 'spot-it', 'pluto']) {
    if (parts[part] === '') assert.match(made.pages['targets.html'], new RegExp(`<section id="${part}" class="page-part" data-built="${part}"></section>`));
  }
});

test('with decisions that allow them, the gallery, "Can you spot it?" and Pluto are made; with decisions that do not, none is', () => {
  const on = withOptional(site, optional);
  const b = build(on);
  const parts = buildTargets(b, on.targets);
  assert.deepEqual(b.left, []);

  // the gallery: a card for each star, its two pictures with their rings, and a way into the viewer
  assert.match(parts.gallery, /<h2 id="gallery-title">/);
  assert.deepEqual([...parts.gallery.matchAll(/<article class="item tcard" id="([^"]+)" data-kind="gallery"/g)].map((m) => m[1]), ['g101', 'g202']);
  assert.ok(parts.gallery.includes('<h3 class="object-name tcard-name" id="g101-name">GAIA DR3 101</h3>'), 'a star is a heading under the heading of the gallery');
  assert.ok(parts.gallery.includes('<figure class="tcard-jump" data-jump data-spot>'), 'its two pictures can be blinked');
  assert.ok(parts.gallery.includes('With a WISE image of <time datetime="2010">2010</time>'));
  assert.ok(parts.gallery.includes('href="view.html?t=gallery/g101"'));
  assert.ok(parts.gallery.includes('href="checks.html#K-gallery"'));
  for (const key of ['gallery.g101.pm', 'gallery.g101.jump', 'gallery.g202.pm', 'gallery.g202.jump']) assert.ok(keysOf(parts.gallery).includes(key), key);
  assert.ok(!parts.gallery.includes('data-blink'), 'a star of the gallery has no picture of a pair');

  // "Can you spot it?": every pair with its answer closed; the rings are there for the pairs that hold a mover
  const spots = parts['spot-it'].split('<li class="spot" data-spot>').slice(1);
  assert.equal(spots.length, 3);
  assert.ok(keysOf(parts['spot-it']).includes('spotit.items'));
  for (const [i, li] of spots.entries()) {
    const item = optional.spotit.set.items[i], answer = optional.spotit.answers.answers[item.id];
    assert.ok(li.includes(`src="data/spotit/${item.a}"`) && li.includes(`src="data/spotit/${item.b}"`), item.id);
    assert.match(li, /<details class="about spot-answer">\n<summary>Show the answer<\/summary>/, 'the answer is closed');
    assert.equal((li.match(/<circle class="jump-ring"/g) ?? []).length, answer.mover ? 2 : 0, item.id);
    const [before, after] = li.split('<details class="about spot-answer">');
    assert.ok(!/moved|mover|nothing/i.test(wordsOf(before)), 'nothing before the answer gives it away');
    assert.ok(after.includes(answer.mover ? 'A star moved here.' : 'Nothing moved here.'));
  }
  assert.ok(parts['spot-it'].includes('Nothing you do here is kept or sent anywhere.'));

  // Pluto: its picture, its verdict with its numbers, and its check
  assert.match(parts.pluto, /<h2 id="pluto-title">/);
  assert.ok(parts.pluto.includes('src="data/pluto/flip.png"'));
  assert.deepEqual(keysOf(parts.pluto), ['pluto.found', 'pluto.difference_frames']);
  assert.ok(parts.pluto.includes('href="checks.html#K-pluto"'));

  // one decision at a time
  const only = (/** @type {Record<string, any>} */ decisions) => {
    const data = withOptional(site, optional, { decisions });
    return buildTargets(build(data), data.targets);
  };
  const none = only({ S4: { build: false }, S5: { build: false } });
  assert.deepEqual([none.gallery, none['spot-it'], none.pluto], ['', '', '']);
  const stars = only({ S4: { build: true }, S5: { build: false } });
  assert.ok(stars.gallery !== '' && stars['spot-it'] !== '' && stars.pluto === '');
  const planet = only({ S4: { build: false }, S5: { build: true } });
  assert.ok(planet.gallery === '' && planet['spot-it'] === '' && planet.pluto !== '');
  // a decision that is not there, or says anything but true, allows nothing
  const unsure = only({ S4: { build: 'yes' }, S5: {} });
  assert.deepEqual([unsure.gallery, unsure['spot-it'], unsure.pluto], ['', '', '']);
  // the five cards are the same whatever is decided
  assert.equal(none.targets, parts.targets);
});

test('a pair without an answer is left out of "Can you spot it?"', () => {
  const on = withOptional(site, optional);
  const { s02, ...answers } = optional.spotit.answers.answers;
  assert.ok(s02);
  const b = build(on);
  const parts = buildTargets(b, { ...on.targets, spotit: { set: optional.spotit.set, answers: { answers } } });
  assert.equal(parts['spot-it'].split('<li class="spot" data-spot>').length - 1, 2);
  assert.deepEqual(b.left, ['answer s02']);
});

test('"Can you spot it?" keeps nothing: its script reads and writes no store and sends nothing', () => {
  const source = readFileSync(path.join(ROOT, 'site/js/ui/spotit.js'), 'utf8');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB', 'cookie', 'fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'caches', 'history.', 'location']) {
    assert.ok(!source.includes(word), word);
  }
});

// ---- the comet ----

const comet = buildComet(build(), site.comet);

test('the map of the two nights marks every photo, and rings the two places with their days', () => {
  const map = comet['track-map'];
  assert.equal((map.match(/<circle class="track-dot"/g) ?? []).length, site.comet.track.photos.length);
  assert.equal((map.match(/<circle class="track-ring"/g) ?? []).length, 2);
  assert.deepEqual([...map.matchAll(/<text class="track-name"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]), ['25 Feb', '26 Feb']);
  assert.match(map, /role="img" aria-labelledby="track-map-title"/);
  // each place: its moment, the two photos that blink, and what was measured there and in August
  const places = comet.places.split('<li class="place"').slice(1);
  assert.equal(places.length, 2);
  for (const [i, li] of places.entries()) {
    const p = site.comet.track.places[i];
    assert.ok(li.includes(`data-night="${p.night}"`));
    assert.ok(li.includes(`data-blink data-manifest="data/lemmon/templates/manifest.json" data-pair="${p.pair.early},${p.pair.late}"`));
    for (const key of [p.flux, p.august_flux, `lemmon.track.offset.${p.night}`]) assert.ok(keysOf(li).includes(key), key);
    assert.ok(li.includes('where JPL Horizons predicts'));
  }
});

test('the chart has a point for every photo that was measured, the same photos as the table under it', () => {
  const points = [...comet.chart.matchAll(/<g class="chart-point" data-photo="([^"]+)"/g)].map((m) => m[1]);
  const rows = [...comet.photos.matchAll(/<tr data-photo="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(points.length, site.numbers['lemmon.photos.measured'].value);
  assert.deepEqual([...points].sort(), [...rows].sort());
  assert.equal(new Set(points).size, points.length);
  // both nights, the neighbours ringed, the same sky in August, and words for those who cannot see it
  assert.ok(comet.chart.includes('data-series="0"') && comet.chart.includes('data-series="1"'));
  const ringed = new Set(Object.values(site.comet.spectrum.contrast).flatMap((/** @type {any} */ c) => [c.below, c.above])).size;
  assert.equal((comet.chart.match(/<circle class="chart-neighbour" cx="[\d.]+" cy="[\d.]+" r="8"/g) ?? []).length, ringed);
  assert.equal((comet.chart.match(/<g class="chart-august">/g) ?? []).length, site.comet.spectrum.templates.length + 1, 'one for each August photo, and one in the key');
  assert.match(comet.chart, /<title id="chart-title">[^<]+<\/title>\n<desc id="chart-desc">[^<]+<\/desc>/);
  // every row of the table gives the colour and the brightness of its photo as numbers
  for (const id of rows) for (const what of ['lam', 'flux']) assert.ok(keysOf(comet.photos).includes(`lemmon.frame.${id}.${what}`), `${id} ${what}`);
});

test('the headline number is set against its neighbours, and says from which night each neighbour comes', () => {
  const lines = comet.neighbours.split('<tr data-night=').slice(1);
  assert.equal(lines.length, 2);
  for (const night of ['feb25', 'feb26']) {
    const c = site.comet.spectrum.contrast[night];
    const line = lines.find((l) => keysOf(l).includes(`lemmon.contrast.${night}.exact`));
    assert.ok(line, night);
    assert.ok(keysOf(line).includes(`lemmon.contrast.${night}.err`));
    const photo = (/** @type {string} */ obs) => site.comet.spectrum.photos.find((/** @type {any} */ p) => p.obs === obs);
    const borrowed = [c.below, c.above].filter((obs) => photo(obs).night !== night).length;
    assert.equal(/photographed on the other night/.test(line), borrowed > 0, night);
  }
});

test('the same sky in August: a row for every photo inside the band that has an August photo', () => {
  const rows = [...comet['same-sky'].matchAll(/<tr data-photo="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rows.length, site.comet.spectrum.templates.length);
  assert.ok(comet['same-sky'].includes('src="data/lemmon/templates/templates.png"'));
  for (const id of rows) for (const key of [`lemmon.template.${id}.flux`, `lemmon.template.${id}.apart`]) assert.ok(keysOf(comet['same-sky']).includes(key), key);
});

test('the table of one photo left out is what was measured, and agrees with the numbers of the pipeline', () => {
  const s = site.comet.spectrum, own = cometNumbers(site.comet);
  const nights = ['feb25', 'feb26'];
  // every photo that was left out has its two contrasts among the numbers of this page, with the count of those that change nothing and the width of the wide picture
  assert.equal(Object.keys(own).length, s.leave_one_out.length * nights.length + 2);
  for (const r of s.leave_one_out) {
    const photo = s.photos.find((/** @type {any} */ p) => p.obs === r.left_out);
    for (const night of nights) assert.equal(own[`v4.leftout.${photo.id}.${night}`].value, r[night]);
  }
  // against the numbers the pipeline wrote on its own: without the brightest photo of a night, and the lowest
  // contrast with any other photo left out
  for (const night of nights) {
    const peak = s.photos.find((/** @type {any} */ p) => p.obs === s.contrast[night].peak);
    assert.equal(own[`v4.leftout.${peak.id}.${night}`].text, site.numbers[`lemmon.contrast.${night}.nopeak`].text, night);
  }
  const peaks = new Set(nights.map((night) => s.contrast[night].peak));
  const lowest = Math.min(...s.leave_one_out.filter((/** @type {any} */ r) => !peaks.has(r.left_out)).flatMap((/** @type {any} */ r) => nights.map((night) => r[night])));
  assert.equal(lowest.toFixed(1), site.numbers['lemmon.contrast.lowest'].text);

  // the table: a line for each photo whose absence changes a figure, and one line for all the others
  const lines = comet.leftout.split('<tr data-').slice(1);
  const changing = s.leave_one_out.filter((/** @type {any} */ r) => nights.some((night) => r[night].toFixed(1) !== s.contrast[night].contrast.toFixed(1)));
  assert.equal(lines.length, changing.length + 1);
  assert.equal(own['v4.leftout.same'].value, s.leave_one_out.length - changing.length);
  assert.deepEqual(keysOf(lines[lines.length - 1]), ['v4.leftout.same', 'lemmon.contrast.feb25.exact', 'lemmon.contrast.feb26.exact']);
  assert.equal((comet.leftout.match(/data-role="peak"/g) ?? []).length, 2, 'the brightest photo of each night');
  assert.deepEqual(Object.keys(cometNumbers({ ...site.comet, spectrum: { ...s, leave_one_out: undefined } })), ['v4.wide.arcmin'], 'without the table, only the width of the wide picture is left');
});

test('the line about what others have published comes from the row of the search, with its date once it is there', () => {
  const k14 = site.rows.find((r) => r.id === 'K14');
  assert.ok(k14, 'the row of the search exists');
  const rows = (/** @type {any} */ change) => site.rows.map((r) => (r.id === 'K14' ? { ...r, ...change } : r));
  const before = buildComet(build(undefined, { rows: rows({ value: null, reviewed_on: null, reviewer_role: null, status: 'UNVERIFIED' }) }), site.comet).literature;
  assert.ok(before.includes('has not been searched yet') && before.includes('href="checks.html#K14"'), before);
  assert.ok(!before.includes('<time'), 'no date before the search');
  const after = buildComet(build(undefined, { rows: rows({ value: 'Found: one abstract of September 2026 reports this gas in this comet.', reviewed_on: '2026-11-15', reviewer_role: 'team member', status: 'PASS' }) }), site.comet).literature;
  assert.ok(after.includes('Found: one abstract of <time datetime="2026-09">September 2026</time> reports this gas in this comet.'), after);
  assert.ok(after.includes('the date of the search is <time datetime="2026-11-15">15 November 2026</time>') && after.includes('data-status="PASS" href="checks.html#K14"'), after);
  assert.equal(buildComet(build(undefined, { rows: site.rows.filter((r) => r.id !== 'K14') }), site.comet).literature, '');
  // as it is today: the line is there, with the tag of its row
  assert.ok(comet.literature.includes(`data-status="${k14.status}" href="checks.html#K14"`));
});

test('with no data the comet page has no made part, and says nothing in its place', () => {
  const b = build(undefined, { rows: [] });
  const parts = buildComet(b, { track: null, spectrum: null, strip: null, templates: null });
  assert.deepEqual(Object.values(parts).filter((p) => p !== ''), []);
});

// ---- what these pages may say ----

/**
 * The sentences of the content of a page (its <main>; the header and the footer are the same on every page) that
 * hold a digit outside the places where one may stand: a number of numbers.json, a date, a source, a command, a
 * heading, a name, a drawing, and a tag, whose words are those of its row.
 * @param {string} html @param {string[]} names
 */
function strayDigits(html, names) {
  let s = (/<main\b[\s\S]*<\/main\s*>/i.exec(html)?.[0] ?? html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<a class="check-link" [\s\S]*?<\/a>/g, ' ');
  for (const tag of ['script', 'style', 'svg', 'time', 'cite', 'code', 'h1', 'h2', 'h3']) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  s = s.replace(/<span\b[^>]*\sdata-n="[^"]*"[^>]*>[^<]*<\/span\s*>/g, ' ').replace(/<span translate="no">[^<]*<\/span>/g, ' ');
  let text = s.replace(/<[^>]*>/g, ' ');
  for (const name of names) text = text.split(name).join(' ');
  return [...text.matchAll(/[^.;:!?\n]*\d[^.;:!?\n]*/g)].map((m) => m[0].replace(/\s+/g, ' ').trim());
}

test('no number is typed into the targets page or the comet page: a digit stands in a number of numbers.json, a date, a source or a name', () => {
  const names = site.targets.targets.map((t) => String(t.card.name));
  for (const name of ['targets.html', 'lemmon.html']) {
    assert.deepEqual(strayDigits(made.pages[name], names), [], `${name}: a number goes through numbers.json and stands in <span data-n="key">`);
    // every number the page carries exists, and the page shows its text
    for (const m of made.pages[name].matchAll(/<span\b[^>]*\sdata-n="([^"]+)"[^>]*>([^<]*)<\/span>/g)) {
      assert.ok(Object.hasOwn(site.numbers, m[1]) || Object.hasOwn(made.own, m[1]), `${name}: ${m[1]}`);
      assert.equal(m[2], esc(setNumber((site.numbers[m[1]] ?? made.own[m[1]]).text)), `${name}: ${m[1]}`);
    }
  }
  // the test itself sees a digit where one is typed
  assert.deepEqual(strayDigits('<body><main><p>It went 12 pixels. <span data-n="a">3</span> of <time datetime="2026">2026</time>, WISE 0855-0714.</p></main><footer>Level 2</footer></body>', ['WISE 0855-0714']), ['It went 12 pixels']);
});

test('nothing about the comet says "only", "first", "discovery", "moved" or "swells"', () => {
  const words = wordsOf(made.pages['lemmon.html']);
  const barred = /\b(only|first|discover\w*|moved|swell\w*)\b/gi;
  assert.deepEqual(words.match(barred) ?? [], []);
  // what the script of the page says once it runs
  const script = readFileSync(path.join(ROOT, 'site/js/pages/lemmon.js'), 'utf8');
  assert.deepEqual(script.match(barred) ?? [], []);
  // and the check sees them where they stand
  assert.deepEqual(wordsOf('<p>It <b>moved</b>.</p><img alt="the first discovery">').match(barred), ['moved', 'first', 'discovery']);
});

test('the comet page calls a photo a photo, and gives the brightness as a lower limit', () => {
  const words = wordsOf(made.pages['lemmon.html']);
  assert.deepEqual(words.match(/\bframes?\b/gi) ?? [], []);
  assert.match(words, /Every brightness is a lower limit/);
  // the headline number comes with its circle and its ring
  for (const key of ['lemmon.contrast.feb26', 'lemmon.contrast.feb25', 'lemmon.aperture.px', 'lemmon.aperture.arcsec', 'lemmon.ring.inner.px', 'lemmon.ring.outer.px',
    'lemmon.contrast.lowest', 'lemmon.contrast.feb26.nopeak', 'lemmon.contrast.feb25.nopeak']) {
    assert.ok(keysOf(made.pages['lemmon.html']).includes(key), key);
  }
});

test('every tag of every page, and every address of a card in the scripts, names a row that exists', () => {
  const ids = new Set(site.rows.map((r) => r.id));
  const PARTS = new Set([...made.pages['checks.html'].matchAll(/<section id="([^"]+)" class="page-part"/g)].map((m) => m[1]));
  const dir = path.join(ROOT, 'site');
  let tags = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.html'))) {
    const html = PAGES.includes(name) ? made.pages[name] : readFileSync(path.join(dir, name), 'utf8');
    for (const m of html.matchAll(/<a\b[^>]*\sclass="(?:[^"]*\s)?check-link(?:\s[^"]*)?"[^>]*>/g)) {
      tags++;
      const href = /\shref="([^"]*)"/.exec(m[0])?.[1] ?? '';
      const id = /^checks\.html#(.+)$/.exec(href)?.[1];
      assert.ok(id && ids.has(decodeURIComponent(id)), `${name}: a tag leads to "${href}"`);
      // the three made pages carry the status of the row it leads to; a page written by hand (the home page) names its row
      assert.ok(m[0].includes(`data-check="${decodeURIComponent(id)}"`) && (!PAGES.includes(name) || name === 'index.html' || /\sdata-status="(PASS|FAIL|LIMIT|CORRECTED|UNVERIFIED)"/.test(m[0])), `${name}: ${m[0]}`);
    }
    // a row, or one of the parts of the Checks page itself
    for (const m of html.matchAll(/checks\.html#([A-Za-z0-9_.%-]+)/g)) assert.ok(ids.has(decodeURIComponent(m[1])) || PARTS.has(m[1]), `${name}: checks.html#${m[1]}`);
    // a tag that is not a link stands on the Checks page alone, inside the card it would lead to
    for (const m of html.matchAll(/<span\b[^>]*\sclass="(?:[^"]*\s)?tag(?:\s[^"]*)?"[^>]*>/g)) assert.equal(name, 'checks.html', `${name}: ${m[0]} is not a link`);
  }
  assert.ok(tags >= 10, `${tags} tags`);
  const scripts = /** @type {string[]} */ (readdirSync(path.join(dir, 'js'), { recursive: true })).filter((n) => n.endsWith('.js'));
  for (const name of scripts) {
    const source = readFileSync(path.join(dir, 'js', name), 'utf8');
    for (const m of source.matchAll(/checks\.html#([A-Za-z0-9_.-]+)/g)) assert.ok(ids.has(m[1]) || PARTS.has(m[1]), `js/${name}: checks.html#${m[1]}`);
  }
});
