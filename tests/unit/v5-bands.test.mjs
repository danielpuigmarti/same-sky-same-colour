// V5: the marked bands of water, methane, carbon dioxide and carbon monoxide, against the stored spectra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BANDS, DIP_BANDS, bandContrast, pointsOfFile, binned, scaleToObject } from '../../site/js/ui/bands.js';

const file = (id) => JSON.parse(readFileSync(new URL(`../../site/data/spectra/${id}.json`, import.meta.url), 'utf8'));
const STEADY = ['gaia-6412593435166417536', 'gaia-6412594259800093568', 'gaia-6412596458823395328'];

test('the four gases are marked, with edges inside the range SPHEREx covers', () => {
  assert.deepEqual([...new Set(BANDS.map((b) => b.gas))].sort(), ['carbon dioxide', 'carbon monoxide', 'methane', 'water']);
  for (const b of BANDS) assert.ok(b.from >= 0.75 && b.to <= 5 && b.to > b.from, b.id);
  assert.ok(DIP_BANDS.length >= 3 && DIP_BANDS.every((b) => b.gas === 'water' || b.gas === 'methane'));
});

test('in Epsilon Indi B the median brightness inside each water or methane band is under 0.6 of that just outside it', () => {
  const points = pointsOfFile(file('eps-indi-b'));
  assert.ok(points.length > 200);
  for (const b of DIP_BANDS) {
    const c = bandContrast(points, b);
    assert.ok(c < 0.6, `${b.id}: ${c.toFixed(2)}`);
  }
});

test('in the three stored steady stars it is not, for any marked band', () => {
  for (const id of STEADY) {
    const points = pointsOfFile(file(id));
    for (const b of BANDS) {
      const c = bandContrast(points, b);
      assert.ok(c >= 0.6, `${id} ${b.id}: ${c.toFixed(2)}`);
    }
  }
});

test('a reference is scaled to the object at one colour and keeps its shape', () => {
  const ref = binned(pointsOfFile(file('eps-indi-b')));
  const object = [{ lam: 1.2, flux: 4 }, { lam: 1.3, flux: 5 }, { lam: 1.4, flux: 4.5 }];
  const s = scaleToObject(ref, object);
  assert.ok(s);
  assert.equal(s.at, 1.3);
  const ratios = ref.map((p, i) => s.line[i].flux / p.flux).filter(Number.isFinite);
  assert.ok(ratios.every((r) => Math.abs(r - ratios[0]) < 1e-9), 'one factor for every colour');
  assert.equal(scaleToObject(ref, [{ lam: 1.3, flux: -1 }]), null, 'an object not above zero cannot be scaled to');
});
