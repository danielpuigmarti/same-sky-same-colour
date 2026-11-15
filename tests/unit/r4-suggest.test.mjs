// What the box suggests while a visitor types (site/js/ui/suggest.js): which row comes first for a typed text, in
// what order the rows stand, and where each row leads. The table of typed texts was written before the ranking.
// The rows are made from the two lists of the site as they are on disk: data/names.json and data/places.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { buildIndex, suggest, plain, MAX_ROWS } from '../../site/js/ui/suggest.js';
import { parseAddress } from '../../site/js/lib/urlstate.js';
import { separationDeg } from '../../site/js/lib/gaia.js';

const read = (/** @type {string} */ file) => JSON.parse(readFileSync(new URL(`../../site/data/${file}`, import.meta.url), 'utf8'));
const names = read('names.json'), places = read('places.json'), firstPlaces = read('first-places.json');
const index = buildIndex(names, places, firstPlaces);

/** The first row for a typed text, as [kind of row, what it names]. @param {string} text */
const first = (text) => {
  const row = suggest(text, index)[0];
  return row ? [row.type, row.type === 'target' || row.type === 'place' ? row.name : row.label] : null;
};

/**
 * Typed text, and the first suggestion it must give: a target of the site's own list, a place of the long list,
 * a position, the plain row for an object that moves, or the offer to look the text up.
 * @type {[string, 'target' | 'place' | 'position' | 'lookup' | 'moving', string][]}
 */
const TABLE = [
  // the start of a name: the site's own targets
  ['b', 'target', "Barnard's Star"],
  ['bar', 'target', "Barnard's Star"],
  ['barnards star', 'target', "Barnard's Star"],
  ["Barnard's Star", 'target', "Barnard's Star"],
  ['BARNARD', 'target', "Barnard's Star"],
  ['eps indi', 'target', 'Epsilon Indi B'],
  ['epsilon indi b', 'target', 'Epsilon Indi B'],
  ['ε Indi B', 'target', 'Epsilon Indi B'],
  ['wise 0855', 'target', 'WISE 0855-0714'],
  ['wise0855-0714', 'target', 'WISE 0855-0714'],
  ['rw aur', 'target', 'RW Aurigae'],
  ['r dra', 'target', 'R Draconis'],
  ['lemmon', 'target', 'Comet C/2025 A6 (Lemmon)'],
  ['comet', 'target', 'Comet C/2025 A6 (Lemmon)'],
  ['plu', 'target', 'Pluto'],
  // the start of a name: the long list
  ['veg', 'place', 'Vega'],
  ['Vega', 'place', 'Vega'],
  ['sirius', 'place', 'Sirius'],
  ['betel', 'place', 'Betelgeuse'],
  ['androm', 'place', 'Andromeda Galaxy'],
  ['orion neb', 'place', 'Orion Nebula'],
  ['ring neb', 'place', 'Ring Nebula'],
  ['crab', 'place', 'Crab Nebula'],
  ['polaris', 'place', 'Polaris'],
  ['proxima', 'place', 'Proxima Centauri'],
  ['large mag', 'place', 'Large Magellanic Cloud'],
  ['pleiades', 'place', 'Pleiades'],
  ['helix', 'place', 'Helix Nebula'],
  // other names: catalogue numbers, designations written out or abbreviated, with or without spaces
  ['m 57', 'place', 'Ring Nebula'],
  ['M57', 'place', 'Ring Nebula'],
  ['m31', 'place', 'Andromeda Galaxy'],
  ['m 1', 'place', 'Crab Nebula'],
  ['ngc7293', 'place', 'Helix Nebula'],
  ['NGC 7293', 'place', 'Helix Nebula'],
  ['gj 699', 'target', "Barnard's Star"],
  ['alpha lyrae', 'place', 'Vega'],
  ['alf lyr', 'place', 'Vega'],
  ['α Lyr', 'place', 'Vega'],
  ['alpha cma', 'place', 'Sirius'],
  ['hd 172167', 'place', 'Vega'],
  ['omega cen', 'place', 'Omega Centauri'],
  ['47 tuc', 'place', '47 Tucanae'],
  ['cyg x-1', 'place', 'Cyg X-1'],
  ['lmc', 'place', 'Large Magellanic Cloud'],
  ['sgr a*', 'place', 'Sagittarius A*'],
  ['tau cet', 'place', 'Tau Ceti'],
  ['r leo', 'place', 'R Leonis'],
  ['r leonis', 'place', 'R Leonis'],
  ['eps eri', 'place', 'Epsilon Eridani'],
  ['ran', 'place', 'Epsilon Eridani'],
  ['61 cyg', 'place', '61 Cygni A'],
  // a word of a name, and a part of one
  ['magellanic', 'place', 'Large Magellanic Cloud'],
  ['galaxy', 'place', 'Andromeda Galaxy'],
  ['star', 'target', "Barnard's Star"],
  ['0855', 'target', 'WISE 0855-0714'],
  ['elgeu', 'place', 'Betelgeuse'],
  ['ndromed', 'place', 'Andromeda Galaxy'],
  // typing mistakes: one in a short text, two in a longer one, a swap of neighbours counting as one
  ["Bernard's star", 'target', "Barnard's Star"],
  ['barnrd', 'target', "Barnard's Star"],
  ['betelguese', 'place', 'Betelgeuse'],
  ['andromdea', 'place', 'Andromeda Galaxy'],
  ['sirus', 'place', 'Sirius'],
  ['vgea', 'place', 'Vega'],
  ['pleides', 'place', 'Pleiades'],
  ['aldebran', 'place', 'Aldebaran'],
  ['orion nebla', 'place', 'Orion Nebula'],
  ['polarsi', 'place', 'Polaris'],
  ['proxma centuri', 'place', 'Proxima Centauri'],
  ['whrilpool', 'place', 'Whirlpool Galaxy'],
  ['61 cygin', 'place', '61 Cygni A'],
  // positions, in the forms the reader of positions takes
  ['330.84 -56.79', 'position', 'Go to RA 330.8400°, Dec −56.7900°'],
  ['08h55m10.83s -07d14m42.5s', 'position', 'Go to RA 133.7951°, Dec −7.2451°'],
  ['17:57:48.5 +04:41:36', 'position', 'Go to RA 269.4521°, Dec +4.6933°'],
  ['10 20', 'position', 'Go to RA 10.0000°, Dec +20.0000°'],
  ['RA 10.5 Dec -3', 'position', 'Go to RA 10.5000°, Dec −3.0000°'],
  // the Sun, the Moon, a planet, Pluto: one plain row, no look-up
  ['moon', 'moving', 'The Moon moves across the sky from day to day; this tool shows fixed places.'],
  ['The Moon', 'moving', 'The Moon moves across the sky from day to day; this tool shows fixed places.'],
  ['sun', 'moving', 'The Sun moves through the stars over the year; this tool shows fixed places.'],
  ['MARS', 'moving', 'Mars wanders among the stars from night to night; this tool shows fixed places.'],
  ['Jupiter', 'moving', 'Jupiter wanders among the stars from night to night; this tool shows fixed places.'],
  ['pluto', 'moving', 'Pluto wanders among the stars from night to night; this tool shows fixed places.'],
  ['134340 Pluto', 'moving', 'Pluto wanders among the stars from night to night; this tool shows fixed places.'],
  // nothing in either list: the offer to look the text up, as it was typed
  ['qwertyuiop', 'lookup', 'Look up “qwertyuiop”'],
  ['zzz', 'lookup', 'Look up “zzz”'],
  ['TRAPPIST-1', 'lookup', 'Look up “TRAPPIST-1”'],
  ['ngc 4151', 'lookup', 'Look up “ngc 4151”'],
  ['Kepler-22 b', 'lookup', 'Look up “Kepler-22 b”'],
];

test(`the first suggestion for each of ${TABLE.length} typed texts`, () => {
  assert.ok(TABLE.length >= 40);
  /** @type {string[]} */
  const wrong = [];
  for (const [text, type, name] of TABLE) {
    const got = first(text);
    if (!got || got[0] !== type || got[1] !== name) wrong.push(`"${text}": wanted ${type} "${name}", got ${got ? `${got[0]} "${got[1]}"` : 'no row'}`);
  }
  assert.deepEqual(wrong, []);
});

test('nothing is suggested for an empty box, or for the start of a position that cannot be a name', () => {
  for (const text of ['', '   ', '12h30m', '08h55m', '25h00m00s +10d00m00s', '-', '+12.5', '330.84 -']) assert.deepEqual(suggest(text, index), [], `"${text}"`);
});

test('there are never more than eight rows, and no place is listed twice', () => {
  assert.equal(MAX_ROWS, 8);
  for (const text of ['a', 'm', 'al', 'ngc', 'm 1', 'alpha', 'nebula', 'star', 'c', '1', 'e', 'or', 'xqz', 'beta']) {
    const rows = suggest(text, index);
    assert.ok(rows.length <= 8, `"${text}" gives ${rows.length} rows`);
    assert.ok(rows.length > 0, `"${text}" gives a row`);
    const named = rows.filter((r) => r.type === 'target' || r.type === 'place').map((r) => r.name);
    assert.equal(new Set(named).size, named.length, `"${text}": ${named.join(', ')}`);
    assert.equal(suggest(text, index, 3).length, Math.min(3, rows.length));
  }
});

test('the rows stand in order: own targets, the whole name, its start, the start of a word, a part, a typing mistake', () => {
  // the whole name before a longer name that starts with it; then the more cited
  const m1 = suggest('m 1', index);
  assert.deepEqual([m1[0].name, m1[0].label, m1[0].match], ['Crab Nebula', 'M 1', 'whole']);
  assert.ok(m1.slice(1).every((r) => r.match === 'start' && /^M 1\d/.test(r.label)), m1.map((r) => r.label).join(', '));
  const order = m1.slice(1).map((r) => places.places.findIndex((/** @type {any} */ p) => p.name === r.name));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the more cited first');

  // a target of the site's own list comes first however it matches; then the places, by how well they match
  const star = suggest('star', index);
  assert.deepEqual([star[0].type, star[0].name, star[0].match], ['target', "Barnard's Star", 'word']);
  const kinds = { whole: 0, start: 1, word: 2, part: 3, near: 4 };
  for (const text of ['star', 'bar', 'cen', 'ori', 'vir', 'lac']) {
    const rows = suggest(text, index).filter((r) => r.type === 'place');
    const ranks = rows.map((r) => kinds[/** @type {keyof typeof kinds} */ (r.match)]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `"${text}": ${rows.map((r) => `${r.label} (${r.match})`).join(', ')}`);
  }
  // a part of a name counts from three letters on
  assert.ok(suggest('elg', index).some((r) => r.name === 'Betelgeuse' && r.match === 'part'));
  assert.ok(!suggest('lg', index).some((r) => r.match === 'part'));

  // a typing mistake is forgiven only when nothing matches as typed, and then the offer to look the text up stays
  assert.ok(suggest('vega', index).every((r) => r.match !== 'near'));
  const near = suggest('betelguese', index);
  assert.deepEqual([near[0].name, near[0].match, near[near.length - 1].type], ['Betelgeuse', 'near', 'lookup']);
  // one mistake in a text of five letters or fewer, two in a longer one; never in a digit
  assert.equal(first('vxga')?.[1], 'Vega');
  assert.equal(first('vxgx')?.[0], 'lookup');
  assert.equal(first('betxlgxuse')?.[1], 'Betelgeuse');
  assert.equal(first('bxtxlgxuse')?.[0], 'lookup');
  assert.equal(first('ncg 7293')?.[1], 'Helix Nebula', 'two letters swapped');
  assert.equal(first('ngc 7239')?.[0], 'lookup', 'two digits swapped are another number of the catalogue, not a typing mistake');
});

test('a row says the name that matched, then the name of the place and what it is', () => {
  /** @param {string} text */
  const say = (text) => { const r = suggest(text, index)[0]; return [r.label, r.note]; };
  assert.deepEqual(say('veg'), ['Vega', 'Alpha Lyrae · star · very bright: SPHEREx saturates']);
  assert.deepEqual(say('alpha lyr'), ['Alpha Lyrae', 'Vega · star · very bright: SPHEREx saturates']);
  assert.deepEqual(say('m 57'), ['M 57', 'Ring Nebula · planetary nebula']);
  assert.deepEqual(say('ring neb'), ['Ring Nebula', 'M 57 · planetary nebula']);
  assert.deepEqual(say('ngc7293'), ['NGC 7293', 'Helix Nebula · planetary nebula']);
  assert.deepEqual(say('barn'), ["Barnard's Star", 'star']);
  assert.deepEqual(say('gj 699'), ['GJ 699', "Barnard's Star · star"]);
  assert.deepEqual(say('lemmon'), ['Lemmon', 'Comet C/2025 A6 (Lemmon) · comet']);
  assert.deepEqual(say('330.84 -56.79'), ['Go to RA 330.8400°, Dec −56.7900°', 'a position']);
  assert.deepEqual(say('zzz'), ['Look up “zzz”', 'asks the name service of the CDS']);
});

test('a row leads where the form leads: a prepared target, a position, or the name with its position', () => {
  /** @param {string} text */
  const href = (text) => suggest(text, index)[0].href;
  assert.equal(href('barnard'), 'view.html?t=barnard');
  assert.equal(href('eps indi'), 'view.html?t=eps-indi-b');
  assert.equal(href('rw aur'), 'view.html?t=rw-aur');
  // the comet has no prepared view of its own name: the viewer reads the name from the site's list; a text that names Pluto leads to the comet's page
  assert.equal(href('plu'), 'view.html?q=Pluto');
  assert.equal(href('pluto'), 'lemmon.html');
  assert.equal(href('lemmon'), 'view.html?q=Comet+C/2025+A6+%28Lemmon%29');
  assert.equal(href('330.84 -56.79'), 'view.html?ra=330.84&dec=-56.79');
  assert.equal(href('08h55m10.831s -7d14m42.53s'), 'view.html?ra=133.795129&dec=-7.245147');
  // a place of the long list: its position, so that no name service is asked, and its name
  const vega = places.places.find((/** @type {any} */ p) => p.name === 'Vega');
  assert.equal(href('vega'), `view.html?ra=${vega.ra}&dec=${vega.dec}&q=Vega`);
  assert.deepEqual(parseAddress(/** @type {string} */ (href('m 57'))), { ra: 283.396251, dec: 33.029152, q: 'Ring Nebula' });
  // the offer to look a text up has no address: the text goes to the form as it was typed
  assert.equal(href('zzz'), null);
  // a place that lies where a fast target of the site used to be is opened as it stands
  const a = suggest('epsilon indi', index).find((r) => r.name === 'Epsilon Indi');
  assert.match(/** @type {string} */ (a?.href), /^view\.html\?ra=330\.892564&dec=-56\.80429&q=Epsilon\+Indi#as-typed$/);
});

test('a place that is one of the site\'s own targets is listed once, as the target', () => {
  for (const [text, id] of [['barnard', 'barnard'], ['epsilon indi b', 'eps-indi-b'], ['wise 0855', 'wise0855'], ['rw aurigae', 'rw-aur']]) {
    const rows = suggest(text, index);
    assert.equal(rows[0].id, id);
    const entry = names.entries.find((/** @type {any} */ e) => e.id === id);
    const twins = rows.filter((r) => r.type === 'place' && separationDeg(r.ra ?? 0, r.dec ?? 0, entry.ra, entry.dec) * 3600 < 5);
    assert.deepEqual(twins.map((r) => r.name), [], text);
  }
  // the star that Epsilon Indi B goes round is another place
  assert.deepEqual(suggest('eps indi', index).slice(0, 2).map((r) => [r.type, r.name]), [['target', 'Epsilon Indi B'], ['place', 'Epsilon Indi']]);
});

test('case, spaces, hyphens, apostrophes and accents do not count; Greek letters are read', () => {
  assert.equal(plain("Barnard's  Star"), 'barnardsstar');
  assert.equal(plain('BARNARDS-STAR'), 'barnardsstar');
  assert.equal(plain('Boötis'), 'bootis');
  assert.equal(plain('α Lyr'), 'alphalyr');
  assert.equal(plain('  M 57 '), 'm57');
  for (const [a, b] of [['barnards star', "Barnard's Star"], ['m 57', 'M57'], ['ngc7293', 'NGC 7293'], ['alpha bootis', 'Alpha Boötis'], ['sgr a*', 'SGR A'], ['OMEGA  CENTAURI', 'omega-centauri']]) {
    assert.deepEqual(suggest(a, index).map((r) => r.name), suggest(b, index).map((r) => r.name), `${a} / ${b}`);
  }
  // a designation is found however it is abbreviated
  for (const text of ['alpha lyrae', 'alf lyr', 'alpha lyr', 'alf lyrae', 'α lyrae', 'Alpha Lyr']) assert.equal(first(text)?.[1], 'Vega', text);
  for (const text of ['alpha canis majoris', 'alf cma', 'alpha cma']) assert.equal(first(text)?.[1], 'Sirius', text);
  for (const text of ['epsilon eridani', 'eps eri', 'ε eri', 'eps eridani']) assert.equal(first(text)?.[1], 'Epsilon Eridani', text);
});

test('without the long list the box still suggests the site\'s own targets, positions and the look-up', () => {
  for (const idx of [buildIndex(names, null), buildIndex(null, null)]) {
    assert.equal(suggest('330.84 -56.79', idx)[0].type, 'position');
    assert.equal(suggest('vega', idx)[0].type, 'lookup');
  }
  assert.equal(suggest('barn', buildIndex(names, null))[0].id, 'barnard');
  assert.equal(suggest('veg', buildIndex(null, places))[0].name, 'Vega');
});

test('the long list is the file the pipeline wrote: at least 800 places, under 200 kB, each with what a row needs', () => {
  assert.ok(places.places.length >= 800 && places.count === places.places.length);
  assert.ok(statSync(new URL('../../site/data/places.json', import.meta.url)).size < 200_000);
  for (const p of places.places) {
    assert.ok(typeof p.name === 'string' && p.name !== '' && Array.isArray(p.aliases) && typeof p.kind === 'string' && p.kind !== '', p.name);
    assert.ok(p.ra >= 0 && p.ra < 360 && Math.abs(p.dec) <= 90, p.name);
    if (p.fast) assert.ok(p.catalogue.epoch === 2000 && Math.hypot(p.catalogue.pmra, p.catalogue.pmdec) > 500 && p.catalogue.parallax > 0, p.name);
  }
  const all = new Set(places.places.flatMap((/** @type {any} */ p) => [p.name, ...p.aliases]));
  for (let m = 1; m <= 110; m++) assert.ok(all.has(`M ${m}`), `M ${m}`);
});

test('a suggestion comes in well under the time of a keystroke', () => {
  const texts = ['a', 'al', 'alp', 'alph', 'alpha', 'alpha c', 'betelguese', 'qwertyuiop', 'ngc 7', 'm', 'proxma centuri', 'the great nebula in'];
  const t = performance.now();
  for (let k = 0; k < 5; k++) for (const text of texts) suggest(text, index);
  const each = (performance.now() - t) / (5 * texts.length);
  assert.ok(each < 20, `${each.toFixed(1)} ms for one suggestion`);
});

test('a text that names a moving object gives one row and nothing else, and is never offered to the name service', () => {
  for (const text of ['sun', 'Moon', 'the moon', 'venus', 'Saturn', 'NEPTUNE', 'pluto']) {
    const rows = suggest(text, index);
    assert.deepEqual(rows.map((r) => [r.type, r.href]), [['moving', 'lemmon.html']], text);
    assert.match(rows[0].label, /; this tool shows fixed places\.$/);
  }
  // a name that only starts like one is a name
  assert.notEqual(first('moonlight')?.[0], 'moving');
  assert.notEqual(first('marsh')?.[0], 'moving');
});

test('a star brighter than magnitude 4 says that SPHEREx saturates; a fainter one does not', () => {
  const note = (/** @type {string} */ text) => suggest(text, index)[0].note;
  for (const text of ['sirius', 'vega', 'betelgeuse', 'polaris', 'tau ceti']) assert.match(note(text), /very bright: SPHEREx saturates$/, text);
  for (const text of ['m 57', 'andromeda', 'barnard']) assert.doesNotMatch(note(text), /saturates/, text);
  for (const p of places.places) if (p.vmag !== undefined) assert.ok(typeof p.vmag === 'number' && p.vmag < 5, p.name);
  assert.match(note('epsilon eridani'), /saturates/, 'magnitude 3.73');
  assert.doesNotMatch(note('61 cygni'), /saturates/, 'magnitude 5 and fainter');
});

test('the good first places: the five prepared targets, then places that show something at a glance', () => {
  assert.ok(Array.isArray(firstPlaces) && firstPlaces.length >= 8 && firstPlaces.length <= 8);
  for (const f of firstPlaces) {
    assert.deepEqual(Object.keys(f).sort(), ['href', 'label', 'line']);
    assert.ok(f.label && f.line && /^view\.html\?/.test(f.href), f.label);
    assert.ok(!/\d/.test(f.line), `no number typed into a line: ${f.line}`);
  }
  const ids = names.entries.filter((/** @type {any} */ e) => e.kind === 'star').map((/** @type {any} */ e) => e.id).sort();
  assert.deepEqual(firstPlaces.slice(0, 5).map((f) => /** @type {string} */ (parseAddress(f.href).t)).sort(), ids);
  for (const f of firstPlaces.slice(5)) {
    const a = parseAddress(f.href);
    assert.ok(a.ra !== undefined && a.dec !== undefined && a.q === f.label, f.label);
    const p = places.places.find((/** @type {any} */ x) => x.name === f.label);
    assert.ok(p && p.ra === a.ra && p.dec === a.dec, f.label);
  }
  assert.ok(firstPlaces.some((f) => f.label === 'Ring Nebula'));
  assert.deepEqual(index.first.map((r) => [r.type, r.label, r.note, r.href]), firstPlaces.map((f) => ['first', f.label, f.line, f.href]));
  assert.deepEqual(buildIndex(names, places).first, []);
});

test('movingBody names a moving object and the sentence for it, and nothing else', async () => {
  const { movingBody } = await import('../../site/js/ui/suggest.js');
  assert.deepEqual(movingBody('The Moon'), { name: 'The Moon', said: 'The Moon moves across the sky from day to day; this tool shows fixed places.' });
  assert.equal(movingBody('  JUPITER ')?.name, 'Jupiter');
  assert.equal(movingBody('134340 Pluto')?.name, 'Pluto');
  assert.equal(movingBody('marsh'), null);
  assert.equal(movingBody(''), null);
});
