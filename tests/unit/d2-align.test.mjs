// Alignment (E4): real stamps shifted by a known fraction of a pixel (cubic spline, scipy; tests/fixtures/d2/align)
// must give the shift back to within 0.05 pixel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignShift, ALIGN_WARN_PX } from '../../site/js/lib/align.js';
import { stampStats, validMask } from '../../site/js/lib/stack.js';
import { readJson, readFloat32, readInt32 } from '../helpers/fixtures.mjs';

const meta = readJson('d2', 'align', 'shifted.json');
const blob = readFloat32('d2', 'align', 'shifted.bin');
const len = meta.w * meta.h;

/** The source stamp of an item, background subtracted, not-valid pixels NaN. @param {string} source */
function sourceStamp(source) {
  const [folder, idx] = source.split('#');
  const data = idx === undefined ? readFloat32(folder, 'image.f32') : readFloat32(folder, 'stamps.bin').subarray(+idx * len, (+idx + 1) * len);
  const flags = idx === undefined ? readInt32(folder, 'flags.i32') : readInt32(folder, 'flags.bin').subarray(+idx * len, (+idx + 1) * len);
  const bg = stampStats(data, flags).background, valid = validMask(data, flags);
  return { data: Float32Array.from(data, (v, i) => (valid[i] ? v - bg : NaN)), valid };
}

test('shifts of 0.1 to 0.7 pixel of real stamps are recovered within 0.05 pixel', () => {
  assert.equal(meta.items.length, 20);
  let worst = 0;
  meta.items.forEach((/** @type {{source: string, dx: number, dy: number}} */ it, /** @type {number} */ k) => {
    const a = sourceStamp(it.source);
    const b = blob.subarray(k * len, (k + 1) * len);
    const r = alignShift({ w: 64, h: 64, ...a }, { w: 64, h: 64, data: b, valid: Uint8Array.from(b, (v) => (Number.isFinite(v) ? 1 : 0)) });
    assert.ok(r.n >= 1 && r.dx !== null && r.dy !== null, `${it.source}: no star`);
    const err = Math.hypot(/** @type {number} */ (r.dx) - it.dx, /** @type {number} */ (r.dy) - it.dy);
    worst = Math.max(worst, err);
    assert.ok(err < 0.05, `${it.source} ${it.dx},${it.dy}: ${r.dx},${r.dy}`);
    assert.equal(r.warn, Math.hypot(it.dx, it.dy) > ALIGN_WARN_PX || Math.hypot(/** @type {number} */ (r.dx), /** @type {number} */ (r.dy)) > ALIGN_WARN_PX);
  });
  assert.ok(worst < 0.05);
});

test('identical images give no shift; a field with no star gives no answer and no warning', () => {
  const a = sourceStamp('showcase/barnard-d5#0');
  const same = alignShift({ w: 64, h: 64, ...a }, { w: 64, h: 64, ...a });
  assert.ok(same.n >= 1 && same.dx === 0 && same.dy === 0 && !same.warn);
  const flat = { w: 64, h: 64, data: new Float32Array(4096).map((_, i) => ((i * 7919) % 13) / 100), valid: new Uint8Array(4096).fill(1) };
  const none = alignShift(flat, flat);
  assert.deepEqual([none.dx, none.dy, none.n, none.warn], [null, null, 0, false]);
});

test('a shift above 0.3 pixel is a warning', () => {
  const a = sourceStamp('showcase/barnard-d5#0');
  const k = meta.items.findIndex((/** @type {{source: string, dx: number}} */ it) => it.source === 'showcase/barnard-d5#0' && it.dx === -0.7);
  const b = blob.subarray(k * len, (k + 1) * len);
  const r = alignShift({ w: 64, h: 64, ...a }, { w: 64, h: 64, data: b, valid: Uint8Array.from(b, (v) => (Number.isFinite(v) ? 1 : 0)) });
  assert.equal(r.warn, true);
});
