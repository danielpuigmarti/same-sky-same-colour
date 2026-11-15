// V5: "Look it up elsewhere". The coordinates in every link are the place's, to 0.001 degree; the card figures of
// the targets whose stored pictures are too bright to measure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupLinks, positionOfLink, formatPlace } from '../../site/js/ui/lookup.js';
import { figureOf, measuredRange, fillCard } from '../../site/js/ui/figure.js';

const PLACES = [[133.786245, -7.244372], [331.0967, -56.8007], [0.0004, 89.9], [270, 66.56], [359.9996, 0]];

test('for each place, the coordinates in all five links equal the place to 0.001 degree', () => {
  for (const [ra, dec] of PLACES) {
    const links = lookupLinks(ra, dec);
    assert.deepEqual(links.map((l) => l.id), ['simbad', 'vizier', 'wiseview', 'legacy', 'aladin']);
    for (const l of links) {
      const at = positionOfLink(l.href);
      assert.ok(at, `${l.id} names a position`);
      assert.ok(Math.abs(at.ra - ra) < 0.001 && Math.abs(at.dec - dec) < 0.001, `${l.id}: ${at.ra} ${at.dec} for ${ra} ${dec}`);
      assert.match(l.href, /^https?:\/\//);
    }
  }
});

test('SIMBAD and VizieR ask for 2 arcmin around the place, nearest first; the readout writes the same place', () => {
  const [simbad, vizier] = lookupLinks(133.786245, -7.244372);
  assert.match(simbad.href, /Radius=2&Radius\.unit=arcmin/);
  assert.match(vizier.href, /-c\.rs=2&-c\.u=arcmin/);
  assert.match(vizier.href, /-sort=_r/);
  assert.equal(formatPlace(133.7598, -7.2422), '133.7598° −7.2422°');
  assert.deepEqual(lookupLinks(NaN, 1), []);
  assert.deepEqual(lookupLinks(10, 95), []);
});

const numbers = JSON.parse(readFileSync(new URL('../../site/data/numbers.json', import.meta.url), 'utf8'));
const card = (id) => JSON.parse(readFileSync(new URL(`../../site/data/targets/${id}/card.json`, import.meta.url), 'utf8'));

test('RW Aurigae and R Draconis say what their cards say; the stored range of RW Aurigae is not the measured one', () => {
  assert.equal(measuredRange(card('rw-aur'), 1), 2, 'its card measures detector 2 first');
  assert.equal(measuredRange(card('rw-aur'), 2), null);
  assert.equal(measuredRange(card('r-dra'), 2), null);
  const rw = figureOf(card('rw-aur'), numbers);
  assert.match(rw, /\+36\.0\u00a0% at 1\.13 to 1\.62\u00a0µm/);
  assert.match(rw, /too bright to measure reliably/);
  const dra = figureOf(card('r-dra'), numbers);
  assert.match(dra, /Saturated in 412 of the 412 photos checked: no brightness is given\./);
  assert.equal(figureOf(card('barnard'), numbers), '');
  assert.equal(figureOf(card('rw-aur'), {}), '', 'a figure that is missing is not shown');
  assert.equal(fillCard('x {{nope}}', numbers), '');
});
