// The one table of flags (site/js/lib/flags.js): the bits and names are the ones the frames declare in their own
// headers, every bit has a tier, and the masks are the tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_TABLE, SATURATION_MASK, DEFECT_MASK, SOURCE_MASK, flagRows, flagNames } from '../../site/js/lib/flags.js';
import { FRAME_IDS, loadFrame, readJson, readInt32 } from '../helpers/fixtures.mjs';

/** The flags a frame declares: the MSKN (name) and MSKM (value) cards of its FLAGS header. @param {string} id */
function declared(id) {
  const frame = loadFrame(id);
  const flagsHdu = frame.meta.hdus[2];
  const range = frame.ranges.find((r) => r.start === flagsHdu.hdrLoc);
  assert.ok(range, 'the FLAGS header is recorded');
  const text = new TextDecoder('latin1').decode(range.bytes.subarray(0, flagsHdu.datLoc - flagsHdu.hdrLoc));
  /** @type {Record<number, {name?: string, value?: number}>} */
  const planes = {};
  for (let i = 0; i < text.length; i += 80) {
    const card = text.slice(i, i + 80);
    const name = /^MSKN(\d{4})= '([^']*)'/.exec(card), value = /^MSKM(\d{4})=\s*(\d+)/.exec(card);
    if (name) (planes[Number(name[1])] ??= {}).name = name[2].trim();
    if (value) (planes[Number(value[1])] ??= {}).value = Number(value[2]);
  }
  return planes;
}

test('the table holds exactly the flags that the frames declare, bit for bit and name for name', () => {
  for (const id of FRAME_IDS) {
    const planes = declared(id);
    assert.deepEqual(Object.keys(planes).map(Number), FLAG_TABLE.map((r) => r.bit), `${id}: the same bits, in order`);
    for (const row of FLAG_TABLE) {
      assert.equal(planes[row.bit].name, row.name, `${id}: bit ${row.bit}`);
      assert.equal(planes[row.bit].value, 2 ** row.bit, `${id}: the value of bit ${row.bit}`);
    }
  }
  assert.equal(FLAG_TABLE.length, 22);
  assert.ok(Object.isFrozen(FLAG_TABLE) && FLAG_TABLE.every((r) => Object.isFrozen(r)));
});

test('every flag has one tier and plain words; the three masks are the tiers', () => {
  const tiers = { saturation: ['OVERFLOW', 'NONLINEAR', 'BLOOM'], source: ['SOURCE'], none: ['DICHROIC', 'FULLSAMPLE', 'PHANMISS'] };
  const defect = ['TRANSIENT', 'SUR_ERROR', 'NONFUNC', 'MISSING_DATA', 'HOT', 'COLD', 'PERSIST', 'OUTLIER', 'CROSSTALK', 'GHOST', 'GHOST_FPA', 'GHOST_EXT', 'STREAK', 'SNOWBALL', 'HALO'];
  /** @param {string} tier */
  const names = (tier) => FLAG_TABLE.filter((r) => r.tier === tier).map((r) => r.name);
  assert.deepEqual(names('saturation'), tiers.saturation);
  assert.deepEqual(names('source'), tiers.source);
  assert.deepEqual(names('none'), tiers.none);
  assert.deepEqual(names('defect'), defect);
  assert.equal(FLAG_TABLE.length, 3 + 1 + 3 + defect.length);
  for (const r of FLAG_TABLE) assert.ok(r.label.length > 5 && r.label === r.label.trim(), r.name);

  /** @param {string[]} list */
  const word = (list) => list.reduce((w, n) => w | (1 << /** @type {{bit: number}} */ (FLAG_TABLE.find((r) => r.name === n)).bit), 0);
  assert.equal(SATURATION_MASK, word(tiers.saturation));
  assert.equal(SATURATION_MASK, (1 << 1) | (1 << 15) | (1 << 26));
  assert.equal(DEFECT_MASK, word(defect));
  assert.equal(SOURCE_MASK, 1 << 21);
  assert.equal(SATURATION_MASK & DEFECT_MASK, 0);
  assert.equal((SATURATION_MASK | DEFECT_MASK) & SOURCE_MASK, 0);
  assert.equal((SATURATION_MASK | DEFECT_MASK | SOURCE_MASK) & word(tiers.none), 0);
});

test('the readout names every flag that is set, except FULLSAMPLE', () => {
  assert.deepEqual(flagNames(0), []);
  assert.deepEqual(flagNames(1 << 12), []);
  assert.deepEqual(flagNames((1 << 21) | (1 << 12)), ['SOURCE']);
  assert.deepEqual(flagNames((1 << 1) | (1 << 2) | (1 << 21) | (1 << 26)), ['OVERFLOW', 'SUR_ERROR', 'SOURCE', 'BLOOM']);
  assert.deepEqual(flagNames((1 << 7) | (1 << 14)), ['DICHROIC', 'PHANMISS'], 'flags that are never drawn are still named');
  assert.deepEqual(flagRows(1 << 12).map((r) => r.name), ['FULLSAMPLE']);
  // a bit the frames do not declare is named by its number, and belongs to no mask
  assert.deepEqual(flagNames((1 << 29) | 1), ['TRANSIENT', 'BIT_29']);
  assert.deepEqual(flagRows(1 << 31).map((r) => [r.bit, r.name, r.tier]), [[31, 'BIT_31', 'none']]);
  assert.deepEqual(flagRows(-1).length, 32);
});

test('in the fixtures no flag is set that the table does not hold', () => {
  const known = FLAG_TABLE.reduce((w, r) => w | (1 << r.bit), 0);
  const words = [...FRAME_IDS.map((id) => loadFrame(id).flags), readInt32('showcase', 'barnard-d5', readJson('showcase', 'barnard-d5', 'manifest.json').flags)];
  let seen = 0;
  for (const list of words) for (const w of list) { seen |= w; assert.equal(w & ~known, 0); }
  // the showcase is rich in flags: saturation, defects and sources all occur
  assert.ok(seen & SATURATION_MASK && seen & DEFECT_MASK && seen & SOURCE_MASK);
});
