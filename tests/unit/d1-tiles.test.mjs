// D1: the frame index. A real tile (gzip) gives the frames the fixture lists; a tile not in meta.json is "not indexed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readBytes, readJson } from '../helpers/fixtures.mjs';
import { createIndex, tileOf, inside, gunzip, keyOf } from '../../site/js/lib/tiles.js';
import { KEY_REGEX } from '../../site/js/contracts.js';

const BASE = 'http://index.test/idx';
const meta = readJson('idx', 'meta.json');
const expected = readJson('idx', 'expected.json');
const tileGz = readBytes('idx', 't', '6_35.json.gz');

/** A fetch that serves the fixture folder, and records what was asked. */
function served(extra = {}) {
  const asked = [];
  const f = async (url) => {
    asked.push(url);
    if (url === `${BASE}/meta.json`) return new Response(JSON.stringify(meta));
    if (url === `${BASE}/t/6_35.json.gz`) return new Response(tileGz, { headers: { 'content-type': 'application/gzip' } });
    if (extra[url]) return extra[url]();
    return new Response('nope', { status: 404 });
  };
  f.asked = asked;
  return f;
}

for (const [name, unzip] of [['zlib', (b) => zlib.gunzipSync(b)], ['DecompressionStream', undefined]]) {
  test(`the tile of the fixture position gives exactly the frames the fixture lists (gzip unpacked with ${name})`, async () => {
    const index = createIndex({ fetch: served(), gunzip: unzip });
    const got = await index.framesCovering(expected.ra, expected.dec, BASE);
    assert.equal(got.length, 342);
    assert.deepEqual(got, expected.frames);
    for (const f of got) assert.match(f.key, KEY_REGEX);
  });
}

test('the tile name, the meta file and the tile are each fetched once however often they are asked', async () => {
  const f = served();
  const index = createIndex({ fetch: f });
  await Promise.all([index.framesCovering(expected.ra, expected.dec, BASE), index.framesCovering(330.9, -56.8, BASE + '/'), index.isIndexed(1, 2, BASE)]);
  assert.equal(f.asked.filter((u) => u.endsWith('meta.json')).length, 1);
  assert.equal(f.asked.filter((u) => u.endsWith('.json.gz')).length, 1);
  assert.equal(tileOf(expected.ra, expected.dec, meta), expected.tile);
});

test('isIndexed is false for a tile that meta.json does not list, true for one it lists', async () => {
  const index = createIndex({ fetch: served() });
  for (const p of expected.indexed) assert.equal(await index.isIndexed(p.ra, p.dec, BASE), p.indexed, `${p.ra}, ${p.dec} (tile ${p.tile})`);
  assert.equal(await index.isIndexed(330.84, -56.79, BASE), false);
  assert.equal(await index.isIndexed(60, -88, BASE), true);
  assert.equal(tileOf(60, -88, meta), '0_0');
  assert.equal(tileOf(10, 10, meta), '20_1');
});

test('a tile that is not there has no frames; a host that fails is an error', async () => {
  const index = createIndex({ fetch: served({ [`${BASE}/t/20_1.json.gz`]: () => new Response('', { status: 404 }), [`${BASE}/t/0_0.json.gz`]: () => new Response('', { status: 503 }) }) });
  assert.deepEqual(await index.framesCovering(10, 10, BASE), []);
  await assert.rejects(index.framesCovering(60, -88, BASE), /503/);
});

test('a tile already unpacked by the host is read too', async () => {
  const plain = zlib.gunzipSync(tileGz);
  const index = createIndex({ fetch: served({ [`${BASE}/t/6_35.json.gz`]: () => new Response(plain) }) });
  assert.equal((await index.framesCovering(expected.ra, expected.dec, BASE)).length, 342);
});

test('with a margin, only frames that hold the position well inside their outline are listed', async () => {
  const index = createIndex({ fetch: served() });
  const all = await index.framesCovering(expected.ra, expected.dec, BASE, { margin: 0 });
  const safe = await index.framesCovering(expected.ra, expected.dec, BASE, { margin: 0.5 });
  assert.equal(all.length, 342);
  assert.ok(safe.length > 0 && safe.length < all.length, `${safe.length} of ${all.length}`);
  const keys = new Set(all.map((f) => f.key));
  assert.ok(safe.every((f) => keys.has(f.key)));
  // a frame of the safe list: the position is at least 0.5 degrees from each side; one of the others is closer than that to one side
  const p = [expected.ra, expected.dec];
  const unit = (ra, dec) => [Math.cos(dec * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.cos(dec * Math.PI / 180) * Math.sin(ra * Math.PI / 180), Math.sin(dec * Math.PI / 180)];
  assert.ok(safe.every((f) => inside(unit(...p), f.corners, 0.5)));
  const dropped = all.find((f) => !safe.includes(f));
  assert.equal(inside(unit(...p), dropped.corners, 0.5), false);
  assert.equal(inside(unit(...p), dropped.corners, 0), true);
});

test('the point test: inside, outside, and the far side of the sky', () => {
  const square = [[10, -1], [12, -1], [12, 1], [10, 1]];
  const u = (ra, dec) => [Math.cos(dec * Math.PI / 180) * Math.cos(ra * Math.PI / 180), Math.cos(dec * Math.PI / 180) * Math.sin(ra * Math.PI / 180), Math.sin(dec * Math.PI / 180)];
  assert.equal(inside(u(11, 0), square), true);
  assert.equal(inside(u(13, 0), square), false);
  assert.equal(inside(u(191, 0), square), false, 'the antipode');
  assert.equal(inside(u(11, 0), square, 0.9), true);
  assert.equal(inside(u(11, 0), square, 1.1), false);
});

test('a row becomes a bucket key', () => {
  assert.equal(keyOf([0, 17, 1, 2, 60789.8, 0, 0, 0, 0, 0, 0, 0, 0], ['2025W33_1B/l2b-v27-2026-227']), 'dr1/level2/2025W33_1B/l2b-v27-2026-227/2/level2_2025W33_1B_0017_1D2_spx_l2b-v27-2026-227.fits');
});

test('gunzip with DecompressionStream returns what zlib returns', async () => {
  const text = Buffer.from('[[1,2,3],[4,5,6]]');
  assert.deepEqual(Buffer.from(await gunzip(new Uint8Array(zlib.gzipSync(text)))), text);
});
