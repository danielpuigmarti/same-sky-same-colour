// D1: a frame read from recorded byte ranges gives the stamp, the flags, the target pixel and the wavelength of the fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_IDS, loadFrame, rangeFetch, readBytes, readJson } from '../helpers/fixtures.mjs';
import { createQueue } from '../../site/js/lib/queue.js';
import { readHead, place, readStamp, reachesBadRows } from '../../site/js/lib/frame.js';
import { makeWcs } from '../../site/js/lib/wcs.js';
import { makeWavelengthAt } from '../../site/js/lib/wave.js';
import { parseHeader, parseFileStart } from '../../site/js/lib/fitsio.js';
import { BUCKET_URLS } from '../../site/js/contracts.js';

const tables = readJson('wave', 'tables.json');
const wavelengthAt = makeWavelengthAt(tables);

/** The bits of a little-endian float32 or int32 file, as the file holds them. @param {string} id @param {string} file */
function rawWords(id, file) {
  const b = readBytes('frames', id, file), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Uint32Array.from({ length: b.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
}

for (const id of FRAME_IDS) {
  test(`${id}: header, target pixel, wavelength, image and flags equal the fixture`, async () => {
    const f = loadFrame(id), m = f.meta;
    const fetchFn = rangeFetch([f]);
    const queue = createQueue({ fetch: fetchFn });
    const get = (start, end, kind, prio) => queue.get(BUCKET_URLS[0] + m.key, start, end, { kind, prio });

    const head = await readHead(get);
    assert.equal(head.nx, 2040);
    assert.equal(head.ny, 2040);
    assert.equal(head.doff, m.hdus[1].datLoc, 'start of the IMAGE data');
    assert.equal(head.next, m.hdus[2].hdrLoc, 'start of the FLAGS part');
    assert.ok(Math.abs(head.mjd - m.stamp.mjd) < 1e-9, 'MJD-AVG');

    const at = place(makeWcs(head.h), head.nx, head.ny, m.target.ra, m.target.dec);
    assert.ok(Math.abs(at.x - m.pixel.x) < 1e-5, `x ${at.x} against ${m.pixel.x}`);
    assert.ok(Math.abs(at.y - m.pixel.y) < 1e-5, `y ${at.y} against ${m.pixel.y}`);
    assert.equal(at.x0, m.stamp.x0);
    assert.equal(at.y0, m.stamp.y0);
    assert.ok(Math.abs(at.tx - m.stamp.tx) < 1e-5 && Math.abs(at.ty - m.stamp.ty) < 1e-5);
    assert.ok(at.inside);

    const w = wavelengthAt(m.stamp.det, at.x, at.y);
    assert.ok(Math.abs(w.lam - m.stamp.lam) < 1e-5, `lam ${w.lam} against ${m.stamp.lam}`);
    assert.ok(Math.abs(w.bw - m.stamp.bw) < 1e-5, `bw ${w.bw} against ${m.stamp.bw}`);

    const s = await readStamp(get, head, at);
    assert.equal(s.data.length, 4096);
    assert.deepEqual(new Uint32Array(s.data.buffer), rawWords(id, m.expected.data), 'image, bit for bit (missing values included)');
    assert.equal(s.data.filter((v) => !Number.isFinite(v)).length, m.counts.nonfinite);
    assert.equal(s.flagsError, null);
    assert.deepEqual(new Int32Array(/** @type {Int32Array} */ (s.flags).buffer), new Int32Array(rawWords(id, m.expected.flags).buffer), 'flags');
    assert.equal(s.flags.filter((v) => v !== 0).length, m.counts.flags_nonzero);

    // the four requests of a frame, all of them among the recorded ranges (rangeFetch throws for any other)
    assert.equal(fetchFn.calls.length, 4);
    assert.deepEqual(fetchFn.calls.map((c) => [c.start, c.end]).filter(([a]) => a === 0), [[0, 28799]]);
  });
}

test('a stamp without flags reads the image only', async () => {
  const f = loadFrame('eps-indi-d5'), m = f.meta;
  const fetchFn = rangeFetch([f]);
  const queue = createQueue({ fetch: fetchFn });
  const get = (a, b, kind, prio) => queue.get(BUCKET_URLS[1] + m.key, a, b, { kind, prio });
  const head = await readHead(get);
  const at = place(makeWcs(head.h), head.nx, head.ny, m.target.ra, m.target.dec);
  const s = await readStamp(get, head, at, { flags: false });
  assert.equal(s.flags, null);
  assert.equal(fetchFn.calls.length, 2);
  assert.deepEqual(new Uint32Array(s.data.buffer), rawWords('eps-indi-d5', m.expected.data));
});

test('flags that cannot be decoded give a stamp with flags null and say why', async () => {
  const f = loadFrame('eps-indi-d4'), m = f.meta;
  const queue = createQueue({ fetch: rangeFetch([f]) });
  const get = (a, b, kind, prio) => queue.get(BUCKET_URLS[0] + m.key, a, b, { kind, prio });
  const head = await readHead(get);
  const at = place(makeWcs(head.h), head.nx, head.ny, m.target.ra, m.target.dec);
  // damage the heap rows: the Rice decoder must run past the end of a tile
  const broken = (a, b, kind, prio) => get(a, b, kind, prio).then((bytes) => (a >= m.flags_layout.heap ? bytes.map(() => 0xff) : bytes));
  const s = await readStamp(broken, head, at);
  assert.equal(s.flags, null);
  assert.match(String(s.flagsError), /./);
  assert.deepEqual(new Uint32Array(s.data.buffer), rawWords('eps-indi-d4', m.expected.data), 'the image is still good');
});

test('a header with a byte above 127 is read as Latin-1; END ends it; the data start where the headers say', () => {
  // a synthetic header: a comment holds the byte 0xB5 (a micro sign in Latin-1) and a string value holds a quote
  const cards = ["SIMPLE  =                    T / file does conform to FITS standard", "BUNIT   = 'MJy/sr  '           / unit in µm", "OBJECT  = 'it''s'", "NAXIS   =                    0", "END"];
  const buf = new Uint8Array(2880).fill(32);
  cards.forEach((c, i) => { for (let k = 0; k < c.length; k++) buf[i * 80 + k] = c.charCodeAt(k); });
  assert.ok(buf.some((v) => v > 127));
  const p = parseHeader(buf);
  assert.ok(p);
  assert.equal(p.len, 2880);
  assert.equal(p.h.BUNIT, 'MJy/sr');
  assert.equal(p.h.OBJECT, "it's");
  assert.equal(p.h.NAXIS, 0);
  const real = parseFileStart(readBytes('frames', 'barnard-d2', 'bytes-0-28799.bin'));
  assert.ok(real);
  assert.equal(real.image.h.EXTNAME, 'IMAGE');
  assert.equal(real.image.doff, 28800, 'detector 2: the IMAGE data start at 28,800');
  const d4 = parseFileStart(readBytes('frames', 'eps-indi-d4', 'bytes-0-28799.bin'));
  assert.equal(d4.image.doff, 25920, 'detector 4: the IMAGE data start at 25,920');
  assert.equal(parseHeader(readBytes('frames', 'barnard-d2', 'bytes-0-28799.bin').subarray(0, real.primary.next + 1000), real.primary.next), null, 'a header cut before END is not a header');
});

test('stamp placement: the stamp starts at floor(pixel + 0.5) - 32 and is inside only when it fits', () => {
  const wcs = { world2pix: () => [100.4, 31.5], pix2world: () => [0, 0] };
  const at = place(wcs, 2040, 2040, 0, 0);
  assert.deepEqual([at.x0, at.y0], [68, 0]);
  assert.ok(Math.abs(at.tx - 32.4) < 1e-12 && Math.abs(at.ty - 31.5) < 1e-12);
  assert.ok(at.inside);
  assert.equal(place({ ...wcs, world2pix: () => [100, 31.4] }, 2040, 2040, 0, 0).inside, false);
  assert.equal(place({ ...wcs, world2pix: () => [2010, 500] }, 2040, 2040, 0, 0).inside, false);
});

test('a stamp that reaches detector 1 rows below 150 or detector 2 rows above 1960 is never used', () => {
  assert.equal(reachesBadRows(1, 149), true);
  assert.equal(reachesBadRows(1, 150), false);
  assert.equal(reachesBadRows(2, 1897), false, 'last row 1960');
  assert.equal(reachesBadRows(2, 1898), true, 'last row 1961');
  assert.equal(reachesBadRows(1, 1900), false);
  assert.equal(reachesBadRows(2, 10), false);
  for (const det of [3, 4, 5, 6]) assert.equal(reachesBadRows(det, 0), false);
});
