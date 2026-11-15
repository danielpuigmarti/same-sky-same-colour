// The display grid on the side of the pipeline: localSky in the browser against local_sky in Python on the same
// frames (tests/vectors/display.json), and a showcase written with the grid against the contract and the decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadFrame, rangeFetch } from '../helpers/fixtures.mjs';
import { readHead } from '../../site/js/lib/frame.js';
import { makeWcs } from '../../site/js/lib/wcs.js';
import { localSky } from '../../site/js/ui/hover.js';
import { decodeShowcase } from '../../site/js/lib/showcase.js';
import { checkShowcase } from '../../tools/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vectors = JSON.parse(readFileSync(path.join(ROOT, 'tests/vectors/display.json'), 'utf8'));

/** @param {string} id */
async function wcsOf(id) {
  const frame = loadFrame(id);
  const f = rangeFetch([frame]);
  const get = async (/** @type {number} */ a, /** @type {number} */ b) => {
    const r = await f(`https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/${frame.meta.key}`, { headers: { Range: `bytes=${a}-${b}` } });
    return new Uint8Array(await r.arrayBuffer());
  };
  return makeWcs((await readHead(/** @type {any} */ (get))).h);
}

test('localSky in the browser agrees with local_sky in Python to 1e-9 degrees', async () => {
  /** @type {Record<string, Awaited<ReturnType<typeof wcsOf>>>} */
  const wcs = {};
  let worst = 0;
  for (const c of vectors.localSky) {
    wcs[c.frame] ??= await wcsOf(c.frame);
    const got = localSky(wcs[c.frame].pix2world, { x0: 0, y0: 0, tx: c.x, ty: c.y });
    assert.ok(got, `${c.frame} ${c.x} ${c.y}`);
    worst = Math.max(worst, Math.abs(got.ra - c.sky.ra), Math.abs(got.dec - c.sky.dec), ...got.cd.map((v, i) => Math.abs(v - c.sky.cd[i])));
  }
  assert.ok(vectors.localSky.length >= 9);
  assert.ok(worst < 1e-9, `largest difference ${worst}`);
});

test('a showcase written with the display grid validates and decodes', (t) => {
  const folder = path.join(ROOT, 'site/data/lemmon/hero');
  if (!existsSync(path.join(folder, 'manifest.json'))) return t.skip('no showcase on disk');
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.grid !== 'north-up') return t.skip('the showcase is not on the display grid yet');
  assert.deepEqual(checkShowcase(folder), []);
  const bytes = (/** @type {string} */ n) => new Uint8Array(readFileSync(path.join(folder, n)));
  const stamps = decodeShowcase(manifest, bytes('stamps.bin'), manifest.flags ? bytes('flags.bin') : null);
  assert.equal(stamps.length, manifest.frames.length);
  for (const f of manifest.frames) {
    assert.equal(f.tx, manifest.w >> 1);
    assert.equal(f.ty, manifest.h >> 1);
    assert.deepEqual(f.sky.cd, [-vectors.pixelDeg, 0, 0, vectors.pixelDeg]);
  }
});
