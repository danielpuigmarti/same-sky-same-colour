// The fixtures are what they were when they were recorded, and they agree with themselves.
// What each fixture is and where it came from: tests/fixtures/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { KEY_REGEX, BUCKET_URLS, INDEX_ROW } from '../../site/js/contracts.js';
import { FRAME_IDS, loadFrame, rangeFetch, readJson, readBytes, readFloat32, readInt32 } from '../helpers/fixtures.mjs';
import { computeChecksums, RECORDED } from '../helpers/checksums.mjs';

const NX = 2040; // pixels in a row of a frame
const text = (/** @type {Uint8Array} */ b) => new TextDecoder('latin1').decode(b);

// The folders in RECORDED hold the fixtures described in tests/fixtures/README.md. Other folders may hold others.
test('every recorded fixture file has its recorded size and SHA-256, and no file was added beside them', () => {
  const recorded = readJson('checksums.json'), now = computeChecksums();
  assert.equal(Object.keys(recorded).length, 31);
  assert.ok(Object.keys(recorded).every((rel) => RECORDED.some((f) => rel.startsWith(f))));
  for (const [rel, want] of Object.entries(recorded)) assert.deepEqual(now[rel], want, rel);
  const added = Object.keys(now).filter((rel) => RECORDED.some((f) => rel.startsWith(f)) && !(rel in recorded));
  assert.deepEqual(added, []);
});

test('the recorded fixtures stay under 8 MB', () => {
  const total = Object.values(readJson('checksums.json')).reduce((s, f) => s + f.bytes, 0);
  assert.ok(total < 8e6, `${total} bytes`);
});

for (const id of FRAME_IDS) {
  test(`frame ${id}: the description fits the recorded bytes`, () => {
    const { meta, data, flags, ranges } = loadFrame(id), s = meta.stamp;
    assert.equal(meta.id, id);
    assert.equal(s.key, meta.key);
    const m = KEY_REGEX.exec(meta.key);
    assert.ok(m);
    assert.equal(Number(m[3]), s.det);
    assert.deepEqual([s.w, s.h], [64, 64]);
    assert.ok(s.x0 >= 0 && s.y0 >= 0 && s.x0 + s.w <= NX && s.y0 + s.h <= NX, 'the stamp lies inside the frame');
    assert.ok(Math.abs(s.tx - (meta.pixel.x - s.x0)) < 1e-9 && Math.abs(s.ty - (meta.pixel.y - s.y0)) < 1e-9);
    assert.ok(s.tx >= 31.5 && s.tx < 32.5 && s.ty >= 31.5 && s.ty < 32.5, 'the target is in the middle pixel');
    assert.ok(s.lam > 0.7 && s.lam < 5.1 && s.bw > 0.01 && s.bw < 0.12);
    assert.equal(data.length, s.w * s.h);
    assert.equal(flags.length, s.w * s.h);
    assert.equal(data.reduce((n, v) => n + (Number.isFinite(v) ? 0 : 1), 0), meta.counts.nonfinite);
    assert.equal(flags.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0), meta.counts.flags_nonzero);
    for (const r of ranges) assert.equal(r.bytes.length, r.end - r.start + 1, `bytes ${r.start}-${r.end}`);
    assert.ok(ranges.every((r) => r.end < meta.size));
  });

  test(`frame ${id}: the recorded bytes are FITS, and the IMAGE rows hold the expected image bit for bit`, () => {
    const { meta, data, ranges } = loadFrame(id), s = meta.stamp;
    const [primary, image, flagsHdu] = meta.hdus;
    const head = ranges.find((r) => r.start === 0);
    assert.ok(head && head.end === 28799);
    assert.ok(text(head.bytes.subarray(0, 30)).startsWith('SIMPLE  =                    T'));
    assert.equal(primary.datLoc, 2880);
    assert.ok(text(head.bytes.subarray(image.hdrLoc, image.hdrLoc + 80)).startsWith("XTENSION= 'IMAGE   '"));
    assert.ok(text(head.bytes.subarray(image.hdrLoc, image.datLoc)).includes("EXTNAME = 'IMAGE   '"));
    assert.ok(image.datLoc <= 28800, 'the first 28,800 bytes hold both headers');

    const start = image.datLoc + s.y0 * NX * 4, end = image.datLoc + (s.y0 + s.h) * NX * 4 - 1;
    const rows = ranges.find((r) => r.start === start && r.end === end);
    assert.ok(rows, 'the IMAGE rows of the stamp are one recorded range');
    const view = new DataView(rows.bytes.buffer, rows.bytes.byteOffset, rows.bytes.byteLength);
    const want = new Uint32Array(data.buffer, data.byteOffset, data.length);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      assert.equal(view.getUint32((y * NX + s.x0 + x) * 4, false), want[y * s.w + x], `pixel ${x}, ${y}`);
    }

    const fh = ranges.find((r) => r.start === flagsHdu.hdrLoc);
    assert.ok(fh, 'the FLAGS header is recorded from its first byte');
    assert.ok(text(fh.bytes.subarray(0, 80)).startsWith("XTENSION= 'BINTABLE'"));
    assert.ok(text(fh.bytes.subarray(0, flagsHdu.datLoc - flagsHdu.hdrLoc)).includes("EXTNAME = 'FLAGS   '"));
    assert.ok(fh.end >= flagsHdu.datLoc + NX * 8 - 1, 'the pointer table of all rows is recorded');
    assert.equal(meta.flags_layout.heap, flagsHdu.datLoc + NX * 8);
    assert.ok(ranges.some((r) => r.start >= meta.flags_layout.heap), 'compressed rows are recorded');
  });
}

test('rangeFetch answers recorded ranges at both addresses of the bucket, and nothing else', async () => {
  const frame = loadFrame(FRAME_IDS[0]), fetch = rangeFetch([frame]);
  for (const base of BUCKET_URLS) {
    const res = await fetch(base + frame.meta.key, { headers: { Range: 'bytes=2880-2959' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), `bytes 2880-2959/${frame.meta.size}`);
    assert.ok(text(new Uint8Array(await res.arrayBuffer())).startsWith("XTENSION= 'IMAGE   '"));
  }
  assert.deepEqual(fetch.calls.map((c) => [c.start, c.end]), [[2880, 2959], [2880, 2959]]);
  assert.equal(fetch.bytes, 160);
  await assert.rejects(fetch(BUCKET_URLS[0] + frame.meta.key, { headers: { Range: 'bytes=28790-28810' } }), /were not recorded/);
  await assert.rejects(fetch(BUCKET_URLS[0] + frame.meta.key), /needs "Range/);
  await assert.rejects(fetch(`https://example.org/${frame.meta.key}`, { headers: { Range: 'bytes=0-9' } }), /not a bucket address/);
  await assert.rejects(fetch(`${BUCKET_URLS[0]}dr1/level2/other.fits`, { headers: { Range: 'bytes=0-9' } }), /no fixture/);
});

test('rangeFetch counts the requests that are open at the same time, per hostname', async () => {
  const frames = FRAME_IDS.map(loadFrame), fetch = rangeFetch(frames, { delayMs: 5 });
  const ask = (/** @type {number} */ i) => fetch(BUCKET_URLS[i % 2] + frames[i % 3].meta.key, { headers: { Range: 'bytes=0-79' } });
  await Promise.all([0, 1, 2, 3, 4, 5, 6].map(ask));
  assert.deepEqual(Object.values(fetch.maxInFlight).sort(), [3, 4]);
  await ask(0);
  assert.equal(fetch.calls.length, 8);
});

test('wavelength: six tables and 200 reference pixels for each', () => {
  const tables = readJson('wave', 'tables.json'), ref = readJson('wave', 'reference.json');
  assert.deepEqual(Object.keys(tables), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(Object.keys(ref), ['1', '2', '3', '4', '5', '6']);
  for (const det of Object.keys(tables)) {
    const t = tables[det], r = ref[det];
    for (const knots of [t.X, t.Y]) {
      assert.equal(knots[0], 1);
      assert.equal(knots.at(-1), NX);
      assert.ok(knots.every((/** @type {number} */ v, /** @type {number} */ i) => i === 0 || v > knots[i - 1]), 'nodes go up');
    }
    for (const plane of [t.lam, t.bw]) {
      assert.equal(plane.length, t.Y.length);
      assert.ok(plane.every((/** @type {number[]} */ row) => row.length === t.X.length && row.every((v) => Number.isFinite(v) && v > 0)));
    }
    assert.match(t.src, KEY_REGEX);
    assert.match(r.src, KEY_REGEX);
    assert.equal(KEY_REGEX.exec(r.src)?.[3], det);
    for (const list of [r.x, r.y, r.lam, r.bw]) assert.equal(list.length, 200);
    const lams = t.lam.flat(), bws = t.bw.flat();
    for (let i = 0; i < 200; i++) {
      assert.ok(r.x[i] >= 0 && r.x[i] <= NX - 1 && r.y[i] >= 0 && r.y[i] <= NX - 1);
      assert.ok(r.lam[i] >= Math.min(...lams) && r.lam[i] <= Math.max(...lams), 'a reference wavelength lies inside the table');
      assert.ok(r.bw[i] >= Math.min(...bws) && r.bw[i] <= Math.max(...bws));
    }
    // the first five reference pixels are the corners and the centre, where no interpolation is needed at the corners
    assert.deepEqual([r.x.slice(0, 5), r.y.slice(0, 5)], [[0, NX - 1, 0, NX - 1, 1020], [0, 0, NX - 1, NX - 1, 1020]]);
    assert.deepEqual(r.lam.slice(0, 4), [t.lam[0][0], t.lam[0].at(-1), t.lam.at(-1)[0], t.lam.at(-1).at(-1)]);
    assert.deepEqual(r.bw.slice(0, 4), [t.bw[0][0], t.bw[0].at(-1), t.bw.at(-1)[0], t.bw.at(-1).at(-1)]);
  }
});

test('index: the tile is a gzip file of rows, and the expected frames are rows of it', async () => {
  const exp = readJson('idx', 'expected.json'), meta = readJson('idx', 'meta.json');
  const gz = readBytes('idx', 't', `${exp.tile}.json.gz`);
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  assert.equal(raw.length, exp.tile_json_bytes);
  assert.equal(createHash('sha256').update(raw).digest('hex'), exp.tile_json_sha256);
  const rows = JSON.parse(new TextDecoder().decode(raw));
  assert.equal(rows.length, exp.tile_rows);
  assert.ok(rows.every((/** @type {number[]} */ r) => r.length === INDEX_ROW.length && r.every(Number.isFinite)));
  assert.ok(rows.every((/** @type {number[]} */ r, /** @type {number} */ i) => i === 0 || r[4] >= rows[i - 1][4]), 'rows are sorted by time');

  const rowOf = new Map(rows.map((/** @type {number[]} */ r) => {
    const [week, ver] = meta.wv[r[0]].split('/');
    return [`dr1/level2/${week}/${ver}/${r[3]}/level2_${week}_${String(r[1]).padStart(4, '0')}_${r[2]}D${r[3]}_spx_${ver}.fits`, r];
  }));
  assert.equal(rowOf.size, rows.length, 'no frame is listed twice');
  assert.equal(exp.frames.length, 342);
  for (const f of exp.frames) {
    const r = rowOf.get(f.key);
    assert.ok(r, f.key);
    assert.match(f.key, KEY_REGEX);
    assert.deepEqual([f.det, f.tmid, f.corners.flat()], [r[3], r[4], r.slice(5)]);
  }
  assert.equal(exp.sia.frames, exp.frames.length + exp.sia.only_in_sia.length);
  for (const key of exp.sia.only_in_sia) assert.ok(rowOf.has(key), 'a frame only the archive search lists is still a row of the tile');
  for (const c of exp.indexed) assert.equal(meta.complete.includes(c.tile), c.indexed, c.tile);
  assert.ok(exp.indexed.some((/** @type {{indexed: boolean}} */ c) => c.indexed) && exp.indexed.some((/** @type {{indexed: boolean}} */ c) => !c.indexed));

  // the two frame fixtures at this position are in the list, with the same time to a millionth of a day
  for (const id of FRAME_IDS) {
    const m = loadFrame(id).meta;
    if (m.target.ra !== exp.ra || m.target.dec !== exp.dec) continue;
    const f = exp.frames.find((/** @type {{key: string}} */ x) => x.key === m.key);
    assert.ok(f && Math.abs(f.tmid - m.stamp.mjd) < 1e-6, id);
  }
});

test('showcase: two visits, matched pairs, and binary files of the stated layout', () => {
  const m = readJson('showcase', 'barnard-d5', 'manifest.json');
  const stamps = readFloat32('showcase', 'barnard-d5', m.stamps), flags = readInt32('showcase', 'barnard-d5', m.flags);
  const n = m.w * m.h;
  assert.equal(stamps.length, m.frames.length * n);
  assert.equal(flags.length, m.frames.length * n);
  assert.deepEqual(m.frames.map((/** @type {{visit: number}} */ f) => f.visit), [0, 0, 1, 1]);
  for (const [i, j] of m.pairs) {
    const a = m.frames[i], b = m.frames[j];
    assert.ok(b.mjd - a.mjd > 100, 'months apart');
    assert.ok(Math.abs(a.lam - b.lam) <= 0.5 * Math.min(a.bw, b.bw), 'the same colour');
  }
  for (const [i, f] of m.frames.entries()) {
    assert.match(f.key, KEY_REGEX);
    assert.equal(Number(KEY_REGEX.exec(f.key)?.[3]), m.det);
    const one = stamps.subarray(i * n, (i + 1) * n);
    assert.ok(one.filter(Number.isFinite).length > n - 10, 'nearly every pixel has a value');
    assert.ok(Math.max(...one.filter(Number.isFinite)) > 1000, 'the star is in the stamp');
    assert.ok(flags.subarray(i * n, (i + 1) * n).some((v) => v !== 0));
  }
});
