// A showcase (CT-8) becomes stamps (CT-4): site/js/lib/showcase.js on the fixture tests/fixtures/showcase/barnard-d5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MANIFEST_FILE, STAMPS_FILE, FLAGS_FILE } from '../../site/js/contracts.js';
import { showcaseFolder, decodeShowcase, manifestProblems, showcaseVisits, pairsBetween, defaultVisits, loadShowcase } from '../../site/js/lib/showcase.js';
import { readJson, readBytes, readFloat32, readInt32, fixturePath } from '../helpers/fixtures.mjs';

const ID = 'barnard-d5';
const manifest = readJson('showcase', ID, MANIFEST_FILE);
const stampsBytes = readBytes('showcase', ID, STAMPS_FILE), flagsBytes = readBytes('showcase', ID, FLAGS_FILE);
const wantData = readFloat32('showcase', ID, STAMPS_FILE), wantFlags = readInt32('showcase', ID, FLAGS_FILE);
const N = manifest.w * manifest.h;

/** The bits of float32 values, so that NaN compares too. @param {Float32Array} a */
const bits = (a) => new Uint32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));

/** The fields of a stamp (CT-4), in order. */
const STAMP_FIELDS = ['key', 'det', 'mjd', 'w', 'h', 'x0', 'y0', 'tx', 'ty', 'lam', 'bw', 'data', 'flags'];

test('the stamps of the fixture have the fields of CT-4 and the values of the files, bit for bit', () => {
  const stamps = decodeShowcase(manifest, stampsBytes, flagsBytes);
  assert.equal(stamps.length, manifest.frames.length);
  for (const [i, s] of stamps.entries()) {
    const f = manifest.frames[i];
    assert.deepEqual(Object.keys(s), STAMP_FIELDS);
    assert.deepEqual(
      [s.key, s.det, s.mjd, s.w, s.h, s.x0, s.y0, s.tx, s.ty, s.lam, s.bw],
      [f.key, manifest.det, f.mjd, manifest.w, manifest.h, f.x0, f.y0, f.tx, f.ty, f.lam, f.bw],
    );
    assert.ok(s.data instanceof Float32Array && s.flags instanceof Int32Array);
    assert.equal(s.data.length, N);
    assert.deepEqual(bits(s.data), bits(wantData.subarray(i * N, (i + 1) * N)), `image of frame ${i}`);
    assert.deepEqual(s.flags, wantFlags.subarray(i * N, (i + 1) * N), `flags of frame ${i}`);
  }
  // first row at the lowest y: the brightest pixel of each stamp is Barnard's Star, near the target
  for (const s of stamps) {
    let best = 0;
    for (let k = 1; k < N; k++) if (s.data[k] > s.data[best] || !Number.isFinite(s.data[best])) best = k;
    const x = best % s.w, y = Math.floor(best / s.w);
    assert.ok(Math.hypot(x - s.tx, y - s.ty) < 3, `brightest pixel at ${x}, ${y}; target at ${s.tx}, ${s.ty}`);
  }
});

test('bytes handed over in any form give the same stamps', () => {
  const plain = decodeShowcase(manifest, stampsBytes, flagsBytes);
  const asBuffers = decodeShowcase(manifest, stampsBytes.buffer.slice(stampsBytes.byteOffset, stampsBytes.byteOffset + stampsBytes.byteLength), flagsBytes.buffer.slice(flagsBytes.byteOffset, flagsBytes.byteOffset + flagsBytes.byteLength));
  const shifted = new Uint8Array(stampsBytes.length + 3);
  shifted.set(stampsBytes, 3); // a view that does not start on a multiple of four bytes
  const odd = decodeShowcase(manifest, shifted.subarray(3), flagsBytes);
  for (const [i, s] of plain.entries()) {
    assert.deepEqual(bits(asBuffers[i].data), bits(s.data));
    assert.deepEqual(bits(odd[i].data), bits(s.data));
    assert.deepEqual(asBuffers[i].flags, s.flags);
  }
  const before = stampsBytes.slice();
  plain[0].data[0] = 12345;
  assert.deepEqual(stampsBytes, before, 'the bytes that were handed in are not written to');
});

test('a showcase without flags gives stamps with flags null', () => {
  const noFlags = { ...manifest, flags: null };
  const stamps = decodeShowcase(noFlags, stampsBytes, null);
  assert.ok(stamps.every((s) => s.flags === null));
  assert.deepEqual(bits(stamps[3].data), bits(wantData.subarray(3 * N)));
  assert.deepEqual(decodeShowcase(noFlags, stampsBytes).map((s) => s.flags), [null, null, null, null]);
});

test('files of the wrong size, and a manifest that lacks a part, are refused with the reason', () => {
  assert.throws(() => decodeShowcase(manifest, stampsBytes.subarray(4), flagsBytes), /stamps\.bin has 65532 bytes, expected 65536/);
  assert.throws(() => decodeShowcase(manifest, stampsBytes, flagsBytes.subarray(0, 100)), /flags\.bin has 100 bytes, expected 65536/);
  assert.throws(() => decodeShowcase(manifest, stampsBytes, null), /names flags\.bin and none was given/);
  assert.deepEqual(manifestProblems(manifest), []);
  const cases = [
    [null, /not an object/], [[], /not an object/], ['text', /not an object/],
    [{ ...manifest, w: 0 }, /w and h/], [{ ...manifest, h: 2.5 }, /w and h/],
    [{ ...manifest, det: 7 }, /det/], [{ ...manifest, stamps: 'other.bin' }, /stamps/], [{ ...manifest, flags: 'f.bin' }, /flags/],
    [{ ...manifest, frames: [] }, /frames/], [{ ...manifest, frames: [{ ...manifest.frames[0], lam: 'red' }] }, /frames\[0\]/],
    [{ ...manifest, pairs: [[0, 9]] }, /pairs\[0\]/], [{ ...manifest, pairs: [[1, 1]] }, /pairs\[0\]/], [{ ...manifest, pairs: 'none' }, /pairs/],
    [{ ...manifest, ra: 'x' }, /ra and dec/], [{ ...manifest, name: 5 }, /id and name/],
  ];
  for (const [bad, why] of cases) {
    const problems = manifestProblems(bad);
    assert.ok(problems.some((p) => /** @type {RegExp} */ (why).test(p)), `${JSON.stringify(bad)?.slice(0, 60)}: ${problems.join('; ')}`);
    assert.throws(() => decodeShowcase(/** @type {any} */ (bad), stampsBytes, flagsBytes), /showcase:/);
  }
});

test('the visits of the fixture, the pairs between them and the two it opens with', () => {
  const visits = showcaseVisits(manifest);
  assert.deepEqual(visits.map((v) => [v.visit, v.frames]), [[0, [0, 1]], [1, [2, 3]]]);
  assert.deepEqual(visits.map((v) => [v.mjd, v.mjdLast]), [[manifest.frames[0].mjd, manifest.frames[1].mjd], [manifest.frames[2].mjd, manifest.frames[3].mjd]]);
  assert.deepEqual(pairsBetween(manifest, 0, 1), [[0, 2], [1, 3]]);
  assert.deepEqual(pairsBetween(manifest, 1, 0), []);
  assert.deepEqual(pairsBetween(manifest, 0, 0), []);
  assert.deepEqual(defaultVisits(manifest), [0, 1]);

  // three visits from the same frames: the last frame as a visit of its own
  const three = { ...manifest, frames: manifest.frames.map((/** @type {any} */ f, /** @type {number} */ i) => ({ ...f, visit: i === 3 ? 2 : f.visit })) };
  assert.deepEqual(showcaseVisits(three).map((v) => v.frames), [[0, 1], [2], [3]]);
  assert.deepEqual(pairsBetween(three, 0, 1), [[0, 2]]);
  assert.deepEqual(pairsBetween(three, 0, 2), [[1, 3]]);
  assert.deepEqual(pairsBetween(three, 1, 2), []);
  assert.deepEqual(defaultVisits(three), [0, 2], 'one pair each: the two visits farthest apart');
  assert.equal(defaultVisits({ ...manifest, pairs: [] }), null);
});

test('the folder of a target', () => {
  assert.equal(showcaseFolder('barnard-d5'), 'data/targets/barnard-d5/');
  assert.equal(showcaseFolder('falsepos/ghost-1'), 'data/falsepos/ghost-1/');
  for (const bad of ['', '../x', 'a/b/c', 'Barnard', 'x y', /** @type {any} */ (null), /** @type {any} */ (5)]) assert.equal(showcaseFolder(bad), null);
});

/** A stand-in for fetch that serves the fixture folder. @param {{missing?: string[], broken?: string[], status?: number}} [how] */
function fixtureFetch({ missing = [], broken = [], status = 404 } = {}) {
  /** @type {string[]} */
  const asked = [];
  /** @param {string | URL | Request} url */
  const fetchFn = async (url) => {
    const name = String(url).split('/').pop() ?? '';
    asked.push(String(url));
    if (broken.includes(name)) throw new TypeError('network error');
    if (missing.includes(name)) return new Response('Not found', { status });
    return new Response(readFileSync(fixturePath('showcase', ID, name)));
  };
  return { fetchFn: /** @type {typeof fetch} */ (fetchFn), asked };
}

test('loadShowcase fetches the three files of a folder and gives the stamps', async () => {
  const { fetchFn, asked } = fixtureFetch();
  const got = await loadShowcase('data/targets/barnard-d5/', fetchFn);
  assert.ok(got.ok);
  assert.deepEqual(asked.sort(), ['data/targets/barnard-d5/flags.bin', 'data/targets/barnard-d5/manifest.json', 'data/targets/barnard-d5/stamps.bin']);
  assert.deepEqual(got.manifest, manifest);
  assert.equal(got.stamps.length, 4);
  assert.deepEqual(bits(got.stamps[2].data), bits(wantData.subarray(2 * N, 3 * N)));
  assert.deepEqual(got.stamps[2].flags, wantFlags.subarray(2 * N, 3 * N));
});

test('loadShowcase never throws: a failure is a result that says which kind', async () => {
  const noManifest = await loadShowcase('x/', fixtureFetch({ missing: ['manifest.json'] }).fetchFn);
  assert.deepEqual([noManifest.ok, !noManifest.ok && noManifest.reason], [false, 'missing']);
  const serverDown = await loadShowcase('x/', fixtureFetch({ missing: ['manifest.json'], status: 503 }).fetchFn);
  assert.deepEqual([serverDown.ok, !serverDown.ok && serverDown.reason], [false, 'unreachable']);
  const offline = await loadShowcase('x/', fixtureFetch({ broken: ['manifest.json'] }).fetchFn);
  assert.deepEqual([offline.ok, !offline.ok && offline.reason], [false, 'unreachable']);
  const noStamps = await loadShowcase('x/', fixtureFetch({ missing: ['stamps.bin'] }).fetchFn);
  assert.deepEqual([noStamps.ok, !noStamps.ok && noStamps.reason], [false, 'invalid']);
  const flagsOffline = await loadShowcase('x/', fixtureFetch({ broken: ['flags.bin'] }).fetchFn);
  assert.deepEqual([flagsOffline.ok, !flagsOffline.ok && flagsOffline.reason], [false, 'unreachable']);
  const notJson = await loadShowcase('x/', /** @type {typeof fetch} */ (async () => new Response('<html>')));
  assert.deepEqual([notJson.ok, !notJson.ok && notJson.reason], [false, 'invalid']);
  const wrongShape = await loadShowcase('x/', /** @type {typeof fetch} */ (async () => new Response('{"id": "x"}')));
  assert.deepEqual([wrongShape.ok, !wrongShape.ok && wrongShape.reason], [false, 'invalid']);
  const short = await loadShowcase('x/', /** @type {typeof fetch} */ (async (/** @type {any} */ url) => (String(url).endsWith('.json') ? new Response(JSON.stringify(manifest)) : new Response(new Uint8Array(8)))));
  assert.deepEqual([short.ok, !short.ok && short.reason], [false, 'invalid']);
});
