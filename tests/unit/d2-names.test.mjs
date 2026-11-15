// Named targets (C1): site/data/names.json, name lookup, and the suggestion for an old catalogue position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findName, suggestNames, snapSuggestion, resolveInput } from '../../site/js/lib/names.js';
import { propagate, epochToMjd, separationDeg } from '../../site/js/lib/gaia.js';

/** @type {import('../../site/js/lib/names.js').NamesFile} */
const names = JSON.parse(readFileSync(new URL('../../site/data/names.json', import.meta.url), 'utf8'));
const entry = (/** @type {string} */ id) => /** @type {import('../../site/js/lib/names.js').NameEntry} */ (names.entries.find((e) => e.id === id));

test('the five targets, the comet and Pluto are there, with positions', () => {
  assert.deepEqual(names.entries.map((e) => e.id), ['barnard', 'eps-indi-b', 'wise0855', 'rw-aur', 'r-dra', 'lemmon', 'pluto']);
  for (const e of names.entries) assert.ok(e.ra >= 0 && e.ra < 360 && Math.abs(e.dec) <= 90 && e.note && (e.epoch === 2026 || e.when));
  assert.equal(entry('lemmon').when, '2026-02-26T20:41:00Z');
  for (const id of ['barnard', 'eps-indi-b', 'wise0855']) {
    const c = /** @type {NonNullable<ReturnType<typeof entry>['catalogue']>} */ (entry(id).catalogue);
    assert.ok(entry(id).fast && c.source.length > 20 && c.epoch > 1999 && c.parallax > 100);
  }
  assert.equal(entry('wise0855').catalogue?.unverified, true);
  assert.ok(/Kirkpatrick/.test(entry('wise0855').catalogue?.source ?? ''));
  assert.ok(/Gaia DR3/.test(entry('barnard').catalogue?.source ?? ''));
});

test('proper motions: Barnard 10.4, Epsilon Indi B 4.7, WISE 0855 8.1 arcsec a year', () => {
  for (const [id, v] of [['barnard', 10.4], ['eps-indi-b', 4.7], ['wise0855', 8.15]]) {
    assert.ok(Math.abs(/** @type {number} */ (entry(/** @type {string} */ (id)).catalogue?.speed_arcsec_per_year) - /** @type {number} */ (v)) < 0.06, String(id));
  }
});

test('the position at 2026.0 is the catalogue position moved there', () => {
  for (const id of ['barnard', 'eps-indi-b', 'wise0855', 'rw-aur', 'r-dra']) {
    const e = entry(id), c = /** @type {NonNullable<typeof e.catalogue>} */ (e.catalogue);
    const [ra, dec] = propagate(c, epochToMjd(2026), { parallax: false });
    assert.ok(separationDeg(ra, dec, e.ra, e.dec) * 3600 < 0.01, id);
  }
});

test('names, with and without apostrophes, accents and capitals', () => {
  for (const [t, id] of [["Barnard's Star", 'barnard'], ['barnards star', 'barnard'], ['GJ 699', 'barnard'], ['Epsilon Indi B', 'eps-indi-b'], ['ε Indi B', 'eps-indi-b'],
    ['WISE 0855-0714', 'wise0855'], ['wise j0855-0714', 'wise0855'], ['RW Aurigae', 'rw-aur'], ['R Draconis', 'r-dra'], ['C/2025 A6 (Lemmon)', 'lemmon'], ['comet lemmon', 'lemmon'], ['Pluto', 'pluto']]) {
    assert.equal(findName(t, names)?.id, id, t);
  }
  assert.equal(findName('Sirius', names), null);
  assert.deepEqual(suggestNames('Barnrd star', names).map((e) => e.id), ['barnard']);
  assert.deepEqual(suggestNames('plut', names).map((e) => e.id), ['pluto']);
});

test("Barnard's J2000 position gets a suggestion with the distance moved", () => {
  // Barnard's Star at J2000.0, from the catalogue motion; the typed text is the same position in letters
  const b = entry('barnard').catalogue;
  const [ra, dec] = propagate(/** @type {NonNullable<typeof b>} */ (b), epochToMjd(2000), { parallax: false });
  const s = snapSuggestion(ra, dec, names);
  assert.ok(s && s.entry.id === 'barnard');
  assert.ok(Math.abs(s.distanceArcmin - 4.5) < 0.2 && Math.abs(s.sinceArcmin - 4.5) < 0.2, `${s.distanceArcmin}`);
  assert.match(s.text, /^This looks like Barnard's Star, which has moved about 4\.\d arcmin since 2000\.$/);
  const typed = resolveInput('17h57m48.5s +04d41m36s', names);
  assert.ok(typed.kind === 'position' && typed.snap?.entry.id === 'barnard');
  const gaiaPos = resolveInput(`${b?.ra} ${b?.dec}`, names);
  assert.ok(gaiaPos.kind === 'position' && gaiaPos.snap?.entry.id === 'barnard');
});

test('no suggestion where the star is now, or far from every fast star', () => {
  const e = entry('barnard');
  assert.equal(snapSuggestion(e.ra, e.dec, names), null);
  assert.equal(snapSuggestion(e.ra + 0.0005, e.dec, names), null);
  assert.equal(snapSuggestion(330.84, -56.79, names)?.entry.id, 'eps-indi-b'); // Epsilon Indi A's field is within 10 arcmin of B's old track
  assert.equal(snapSuggestion(10, 10, names), null);
  const w = entry('wise0855').catalogue;
  assert.equal(snapSuggestion(/** @type {NonNullable<typeof w>} */ (w).ra, /** @type {NonNullable<typeof w>} */ (w).dec, names)?.entry.id, 'wise0855');
});

test('resolveInput: a position, a name, or a plain message that lists what can be typed', () => {
  const p = resolveInput('120.5 -30.25', names);
  assert.ok(p.kind === 'position' && p.snap === null);
  const n = resolveInput('Pluto', names);
  assert.ok(n.kind === 'name' && n.entry.id === 'pluto' && n.ra === entry('pluto').ra);
  const none = resolveInput('Andromeda', names);
  assert.ok(none.kind === 'none' && /Barnard's Star/.test(none.message) && /position/.test(none.message));
  const close = resolveInput('baranrd', names);
  assert.ok(close.kind === 'none' && close.suggestions[0]?.id === 'barnard' && /Did you mean Barnard's Star/.test(close.message));
});
