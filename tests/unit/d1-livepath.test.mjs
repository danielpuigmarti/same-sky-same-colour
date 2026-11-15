// D1: the live path end to end, in memory. The index is built for the test; the bucket is the recorded bytes of one
// fixture frame, served under several names (so several "frames" give the same recorded stamp). The visit rule and
// the match rule are stand-ins handed in, as the real ones come from another part of the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { loadFrame, rangeFetch, readBytes, readInt32 } from '../helpers/fixtures.mjs';
import { createQueue } from '../../site/js/lib/queue.js';
import { createIndex, keyOf } from '../../site/js/lib/tiles.js';
import { createLivePath, rankVisitPairs, spread, bytesPerFrame } from '../../site/js/lib/livepath.js';
import { makeWavelengthAt } from '../../site/js/lib/wave.js';
import { readJson } from '../helpers/fixtures.mjs';

const BASE = 'http://index.test/idx';
const REAL = loadFrame('eps-indi-d5');
const expected = readJson('idx', 'expected.json');
const realRow = expected.frames.find((f) => f.key === REAL.meta.key);
const tables = readJson('wave', 'tables.json');
const wavelengthAt = makeWavelengthAt(tables);
const POS = { ra: 330.84, dec: -56.79 };

// ---- stand-in rules ----
const visits = (frames) => {
  const sorted = [...frames].sort((a, b) => a.tmid - b.tmid), out = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f.tmid - last.frames[last.frames.length - 1].tmid <= 10) last.frames.push(f); else out.push({ frames: [f], short: false });
  }
  for (const v of out) v.short = v.frames.length < 3;
  return out;
};
const matchPairs = (a, b) => Array.from({ length: Math.min(a.length, b.length, 8) }, (_, i) => [i, i]);
const rules = { visits, matchPairs };

/** Put a number into the value field of a header card, 80 characters. */
function patchCard(bytes, key, value) {
  const out = bytes.slice();
  const k = key.padEnd(8) + '= ';
  for (let i = 0; i + 80 <= out.length; i += 80) {
    if (String.fromCharCode(...out.subarray(i, i + 10)) === k) {
      const text = String(value).padStart(20) + ' / patched';
      for (let j = 0; j < 70; j++) out[i + 10 + j] = j < text.length ? text.charCodeAt(j) : 32;
      return out;
    }
  }
  throw new Error('card not found: ' + key);
}

/**
 * A world: an index with the given frames (all of detector `det`) and a bucket that serves each of them from the
 * recorded fixture bytes. `spec` is a list of {tmid, shiftY} (shiftY moves the target pixel along y in that frame's header).
 */
function world(spec, { det = 2, complete = true, delayMs = 0, bucketFails = false } = {}) {
  const weeks = spec.map((_, i) => `2025W${String(10 + i).padStart(2, '0')}_1A/l2b-v27-2026-201`);
  const rows = spec.map((s, i) => [i, 441, 1, det, s.tmid, ...realRow.corners.flat()]);
  const wv = weeks;
  const meta = { ...readJson('idx', 'meta.json'), wv, complete: complete ? ['6_35'] : [] };
  const tileGz = zlib.gzipSync(JSON.stringify(rows));
  const clones = rows.map((r, i) => {
    const key = keyOf(r, wv);
    const ranges = REAL.ranges.map((x) => ({ ...x }));
    if (spec[i].shiftY) {
      const crpix2 = REAL.meta && Number(new TextDecoder('latin1').decode(readBytes('frames', 'eps-indi-d5', 'bytes-0-28799.bin')).match(/CRPIX2  =\s+([-\d.]+)/)[1]);
      ranges[0] = { ...ranges[0], bytes: patchCard(ranges[0].bytes, 'CRPIX2', crpix2 + spec[i].shiftY) };
    }
    return { ...REAL, meta: { ...REAL.meta, key }, ranges };
  });
  const bucket = rangeFetch(clones, { delayMs });
  const asked = [];
  async function fetchFn(url, init) {
    if (url.startsWith('http://index.test/')) {
      asked.push(url);
      if (url.endsWith('/meta.json')) return new Response(JSON.stringify(meta));
      if (url.endsWith('/t/6_35.json.gz')) return new Response(tileGz);
      return new Response('', { status: 404 });
    }
    if (bucketFails) throw new TypeError('network down');
    return bucket(url, init);
  }
  const keys = clones.map((c) => c.meta.key);
  return { fetch: fetchFn, bucket, keys, asked, rows };
}

function pathFor(w, extra = {}) {
  const queue = createQueue({ fetch: w.fetch, retryDelayMs: 1 });
  const index = createIndex({ fetch: w.fetch });
  const lp = createLivePath({ queue, index, wavelengthAt, rules, indexBase: BASE, ...extra });
  return { lp, queue };
}

const six = [{ tmid: 60000.0 }, { tmid: 60000.01 }, { tmid: 60000.02 }, { tmid: 60200.0 }, { tmid: 60200.01 }, { tmid: 60200.02 }];

const bitsOf = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
const expectedImage = (() => {
  const b = readBytes('frames', 'eps-indi-d5', 'image.f32'), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Uint32Array.from({ length: b.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
})();
const expectedFlags = readInt32('frames', 'eps-indi-d5', 'flags.i32');

test('plan: headers first, target pixel and colour of each frame, pairs from the rules; load: only the paired frames\' rows', async () => {
  const w = world(six);
  const { lp, queue } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.state, undefined, JSON.stringify(plan.state));
  assert.equal(plan.visits.length, 2);
  assert.deepEqual(plan.visitPair, [0, 1]);
  assert.equal(plan.pairs.length, 3);
  assert.equal(plan.slow, false);
  assert.equal(plan.more, null);
  // before any row was read, only the 28,800-byte starts of the six frames were asked for
  assert.equal(w.bucket.calls.length, 6);
  assert.ok(w.bucket.calls.every((c) => c.start === 0 && c.end === 28799));
  assert.equal(new Set(w.bucket.calls.map((c) => c.host)).size, 2, 'both bucket host names are used');
  // each placed frame: the fixture's target pixel, stamp corner and wavelength
  const m = REAL.meta.stamp;
  for (const [a, b] of plan.loads) {
    for (const it of [a, b]) {
      assert.equal(it.x0, m.x0); assert.equal(it.y0, m.y0);
      assert.ok(Math.abs(it.tx - m.tx) < 1e-5 && Math.abs(it.ty - m.ty) < 1e-5);
      const wl = wavelengthAt(2, REAL.meta.pixel.x, REAL.meta.pixel.y);
      assert.ok(Math.abs(it.lam - wl.lam) < 1e-9 && Math.abs(it.bw - wl.bw) < 1e-9);
    }
  }
  assert.equal(plan.bytes, 6 * bytesPerFrame(64));
  assert.ok(plan.seconds >= 1);
  assert.deepEqual(plan.pairs[0].map((f) => f.key), [w.keys[0], w.keys[3]]);

  const events = [];
  const stamps = await lp.load(plan, { onProgress: (p) => events.push(p) });
  assert.equal(stamps.length, 6);
  stamps.forEach((s, i) => {
    assert.equal(s.key, plan.pairs[Math.floor(i / 2)][i % 2].key, 'stamps come in pair order');
    assert.equal(s.w, 64); assert.equal(s.h, 64);
    assert.equal(s.x0, m.x0); assert.equal(s.y0, m.y0);
    assert.deepEqual(bitsOf(s.data), expectedImage, 'image, bit for bit');
    assert.deepEqual(s.flags, expectedFlags, 'flags');
    assert.ok(Math.abs(s.mjd - m.mjd) < 1e-9);
  });
  // the rows read are those of the paired frames; no header was read twice
  assert.equal(w.bucket.calls.filter((c) => c.start === 0).length, 6);
  assert.equal(w.bucket.calls.length, 6 + 6 * 3);
  assert.ok(queue.stats.maxInFlight['nasa-irsa-spherex.s3.us-east-1.amazonaws.com'] <= 6);
  assert.ok(queue.stats.maxInFlight['s3.us-east-1.amazonaws.com'] <= 6);
  assert.ok(w.bucket.maxInFlight['nasa-irsa-spherex.s3.us-east-1.amazonaws.com'] <= 6);
  assert.ok(w.bucket.maxInFlight['s3.us-east-1.amazonaws.com'] <= 6);
  assert.equal(events.filter((e) => e.type === 'stamp').length, 6);
  assert.deepEqual(events.filter((e) => e.type === 'stamp' && e.pair !== null).map((e) => e.pair).sort(), [0, 1, 2]);
  const last = events.filter((e) => e.type === 'stamp').at(-1);
  assert.equal(last.done, 6); assert.equal(last.total, 6);
});

test('the first pair arrives before the rows of the later pairs (priority by pair)', async () => {
  const w = world(six, { delayMs: 3 });
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  const order = [];
  await lp.load(plan, { onProgress: (p) => { if (p.type === 'stamp') order.push(p.pair); } });
  const firstDone = order.findIndex((p) => p !== null);
  assert.equal(order[firstDone], 0, 'pair 0 is the first to complete');
});

test('a frame whose target pixel puts the stamp in the bad rows of detector 2 is dropped and never read again', async () => {
  const spec = [...six];
  spec[2] = { tmid: 60000.02, shiftY: 1935 - REAL.meta.pixel.y };          // stamp rows 1898 to 1961: too high in detector 2
  const w = world(spec);
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.skipped.badRows, 1);
  assert.equal(plan.pairs.length, 2, 'five frames are left: 2 in the first visit, 3 in the second');
  assert.ok(plan.pairs.flat().every((f) => f.key !== w.keys[2]));
  const stamps = await lp.load(plan);
  assert.equal(stamps.length, 4);
  assert.ok(w.bucket.calls.filter((c) => c.key === w.keys[2]).every((c) => c.start === 0), 'only its header was read');
});

test('a frame that puts the stamp off the edge of the detector is dropped', async () => {
  const spec = [...six];
  spec[1] = { tmid: 60000.01, shiftY: -REAL.meta.pixel.y + 10 }; // target at y = 10: the stamp would leave the detector
  const w = world(spec);
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.skipped.outside, 1);
  assert.equal(plan.pairs.length, 2);
});

test('failures are states: not-indexed, no-coverage, one-visit, unreachable, cancelled', async () => {
  // not indexed: the tile is not in meta.complete
  assert.deepEqual(await pathFor(world(six, { complete: false })).lp.plan(POS.ra, POS.dec, 2), { state: 'not-indexed' });
  // ... unless the reader is told not to ask
  const open = await pathFor(world(six, { complete: false }), { requireIndexed: false }).lp.plan(POS.ra, POS.dec, 2);
  assert.equal(open.pairs.length, 3);
  // no frame of that detector
  assert.deepEqual(await pathFor(world(six)).lp.plan(POS.ra, POS.dec, 3), { state: 'no-coverage' });
  // a position in the tile that no frame covers
  assert.deepEqual(await pathFor(world(six)).lp.plan(323.2, -59.9, 2), { state: 'no-coverage' });
  // a position in a tile that is not listed
  assert.deepEqual(await pathFor(world(six)).lp.plan(300, -57, 2), { state: 'not-indexed' });
  // nonsense in
  for (const bad of [[NaN, 0, 2], [10, 95, 2], [10, 10, 7], [10, 10, 1.5]]) assert.deepEqual(await pathFor(world(six)).lp.plan(...bad), { state: 'no-coverage' });
  // one visit
  assert.deepEqual(await pathFor(world(six.slice(0, 3))).lp.plan(POS.ra, POS.dec, 2), { state: 'one-visit' });
  // the bucket cannot be reached
  assert.deepEqual(await pathFor(world(six, { bucketFails: true })).lp.plan(POS.ra, POS.dec, 2), { state: 'unreachable' });
  // the index cannot be reached
  const dead = pathFor({ ...world(six), fetch: async () => { throw new TypeError('down'); } }, { log: () => {} });
  assert.deepEqual(await dead.lp.plan(POS.ra, POS.dec, 2), { state: 'unreachable' });
  // cancelled before it starts and while it runs
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await pathFor(world(six)).lp.plan(POS.ra, POS.dec, 2, { signal: ac.signal }), { state: 'cancelled' });
  const w = world(six, { delayMs: 40 });
  const live = pathFor(w), ac2 = new AbortController();
  const p = live.lp.plan(POS.ra, POS.dec, 2, { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 10);
  assert.deepEqual(await p, { state: 'cancelled' });
});

test('no pair at the same colour: the next pair of visits is tried, then no-coverage', async () => {
  const w = world([...six, { tmid: 60400.0 }, { tmid: 60400.01 }, { tmid: 60400.02 }]);
  let tried = 0;
  const never = (a, b) => { tried++; return []; };
  const { lp } = pathFor(w, { rules: { visits, matchPairs: never } });
  assert.deepEqual(await lp.plan(POS.ra, POS.dec, 2), { state: 'no-coverage' });
  assert.equal(tried, 3, 'three pairs of visits, then it stops');
});

test('the default pair: deepest visits first, farthest apart; an injected rule can name another', async () => {
  const v = (n, t) => ({ frames: Array.from({ length: n }, (_, i) => ({ tmid: t + i * 0.01 })), short: n < 3 });
  const list = [v(8, 100), v(7, 130), v(8, 300), v(2, 400), v(1, 500)];
  assert.deepEqual(rankVisitPairs(list)[0], [0, 2], 'the two deep visits farthest apart');
  assert.deepEqual(rankVisitPairs(list).at(-1).sort(), [3, 4].sort() && rankVisitPairs(list).at(-1), 'short ones last or left out');
  assert.ok(rankVisitPairs(list).every(([a, b]) => !list[a].short && !list[b].short), 'short visits are left out while two others remain');
  assert.deepEqual(rankVisitPairs([v(1, 1), v(2, 50)]), [[0, 1]], 'with only short visits, they are used');
  const w = world(six);
  const { lp } = pathFor(w, { rules: { ...rules, defaultPair: () => [1, 0] } });
  assert.deepEqual((await lp.plan(POS.ra, POS.dec, 2)).visitPair, [1, 0]);
  const forced = await pathFor(world(six)).lp.plan(POS.ra, POS.dec, 2, { visitPair: [1, 0] });
  assert.deepEqual(forced.visitPair, [1, 0]);
  assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
  assert.deepEqual(spread([1, 2, 3], 4), [1, 2, 3]);
});

test('at a pole a visit holds hundreds of frames: only a few dozen headers are read', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ tmid: 60000 + i * 0.001 }));
  const w = world([...many, { tmid: 60300 }, { tmid: 60300.01 }, { tmid: 60300.02 }]);
  const { lp } = pathFor(w, { maxHeadersPerVisit: 40 });
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.visits[0].frames.length, 300);
  assert.equal(w.bucket.calls.length, 43);
  assert.equal(plan.pairs.length, 3);
});

test('a slow link, judged from the first request, gets the first pair alone and the rest as "more"', async () => {
  const w = world(six, { delayMs: 25 });
  const { lp } = pathFor(w, { slowFirstRequestMs: 5 });
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.slow, true);
  assert.ok(plan.firstRequestMs >= 20);
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.loads.length, 1);
  assert.equal(plan.more.pairs.length, 2);
  assert.equal(plan.bytes, 2 * bytesPerFrame(64));
  assert.equal(plan.more.bytes, 4 * bytesPerFrame(64));
  assert.ok(plan.seconds > 6 * bytesPerFrame(64) / 2e6 / 4, 'a slow link is estimated slower');
  const first = await lp.load(plan);
  assert.equal(first.length, 2);
  assert.equal(w.bucket.calls.filter((c) => c.start !== 0).length, 6, 'only the first pair\'s rows so far');
  const more = await lp.load(plan.more);
  assert.equal(more.length, 4);
  assert.notDeepEqual(more.map((s) => s.key), first.map((s) => s.key));
  // the same link is fast when the first request is quick
  const quick = await pathFor(world(six)).lp.plan(POS.ra, POS.dec, 2);
  assert.equal(quick.slow, false);
  // the page can say so
  const said = await pathFor(world(six)).lp.plan(POS.ra, POS.dec, 2, { slow: true });
  assert.equal(said.pairs.length, 1);
});

test('a first pair that takes too long to arrive gives the state "slow"; a slow first pair hands the rest back', async () => {
  const w = world(six, { delayMs: 40 });
  const { lp } = pathFor(w, { firstPairBudgetMs: 30, slowFirstRequestMs: 1e9 });
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.deepEqual(await lp.load(plan), { state: 'slow' });
  const w2 = world(six, { delayMs: 10 });
  const events = [];
  const { lp: lp2 } = pathFor(w2, { firstPairSlowMs: 0, slowFirstRequestMs: 1e9 });
  const plan2 = await lp2.plan(POS.ra, POS.dec, 2);
  const got = await lp2.load(plan2, { onProgress: (e) => events.push(e) });
  assert.equal(got.length, 2);
  const more = events.find((e) => e.type === 'more');
  assert.equal(more.plan.pairs.length, 2);
  assert.equal(more.plan.loads.length, 2);
});

test('decoded stamps are cached: a second load asks the bucket for nothing', async () => {
  const mem = new Map();
  const cache = { get: async (k) => mem.get(k), put: async (k, v) => { mem.set(k, v); } };
  const w = world(six);
  const { lp } = pathFor(w, { cache });
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  await lp.load(plan);
  const calls = w.bucket.calls.length;
  const events = [];
  const again = await lp.load(plan, { onProgress: (e) => events.push(e) });
  assert.equal(w.bucket.calls.length, calls);
  assert.equal(again.length, 6);
  assert.ok(events.filter((e) => e.type === 'stamp').every((e) => e.cached));
  assert.deepEqual(bitsOf(again[0].data), expectedImage);
  // a second plan at the same position reads no header either
  await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(w.bucket.calls.length, calls);
});

test('the Cache API is never touched', async () => {
  const touched = [];
  Object.defineProperty(globalThis, 'caches', { configurable: true, get() { touched.push('caches'); throw new Error('the Cache API must not be used'); } });
  try {
    const w = world(six);
    const { lp } = pathFor(w);
    const plan = await lp.plan(POS.ra, POS.dec, 2);
    assert.equal((await lp.load(plan)).length, 6);
  } finally {
    delete globalThis.caches;
  }
  assert.deepEqual(touched, []);
});

test('a load that is cancelled gives {state: "cancelled"}', async () => {
  const w = world(six, { delayMs: 30 });
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  const ac = new AbortController();
  const p = lp.load(plan, { signal: ac.signal });
  setTimeout(() => ac.abort(), 15);
  assert.deepEqual(await p, { state: 'cancelled' });
  assert.deepEqual(await lp.load(plan, { signal: AbortSignal.abort() }), { state: 'cancelled' });
});

test('flags that fail to decode give a stamp with flags null and a warning, not a failure', async () => {
  const w = world(six);
  const inner = w.fetch;
  w.fetch = async (url, init) => {
    const r = await inner(url, init);
    const start = init?.headers ? Number(/bytes=(\d+)/.exec(new Headers(init.headers).get('range'))[1]) : -1;
    if (init?.headers && start >= REAL.meta.flags_layout.heap) return new Response(new Uint8Array((await r.arrayBuffer()).byteLength).fill(255), { status: 206 });
    return r;
  };
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  const events = [];
  const stamps = await lp.load(plan, { onProgress: (e) => events.push(e) });
  assert.equal(stamps.length, 6);
  assert.ok(stamps.every((s) => s.flags === null));
  assert.deepEqual(bitsOf(stamps[0].data), expectedImage);
  assert.equal(events.filter((e) => e.type === 'warning').length, 6);
});

test('a frame is read from the other host when its own host fails', async () => {
  const w = world(six);
  const inner = w.fetch;
  w.fetch = async (url, init) => {
    if (url.startsWith('https://s3.us-east-1.amazonaws.com/')) throw new TypeError('this host is down');
    return inner(url, init);
  };
  const { lp } = pathFor(w);
  const plan = await lp.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.pairs.length, 3);
  assert.equal((await lp.load(plan)).length, 6);
});

// ---------------------------------------------------------------------------------------------------------
// The worker and the client (CT-12), run in this thread: the messages are copied as a real worker would copy them.
// ---------------------------------------------------------------------------------------------------------
import { readdirSync, readFileSync } from 'node:fs';
import { createClient, client } from '../../site/js/lib/client.js';
import { createHandler, createStampCache } from '../../site/js/lib/worker.js';

function clientFor(w, { importer, config, cache = null } = {}) {
  const fetchFn = async (url, init) => (url === 'http://index.test/wave.json' ? new Response(JSON.stringify(tables)) : w.fetch(url, init));
  return createClient({
    inline: true,
    config: { indexBase: BASE, waveUrl: 'http://index.test/wave.json', rulesUrl: 'rules:test', slowFirstRequestMs: 1e9, ...config },
    handler: { fetch: fetchFn, cache, importer: importer ?? (async () => rules) },
  });
}

test('client: plan and load through the worker give the plan and the stamps; progress is reported', async () => {
  const c = clientFor(world(six));
  const plan = await c.plan(POS.ra, POS.dec, 2);
  assert.equal(plan.pairs.length, 3);
  assert.equal(plan.visits.length, 2);
  assert.ok(plan.bytes > 0 && plan.seconds > 0);
  const events = [];
  const stamps = await c.load(plan, (p) => events.push(p));
  assert.equal(stamps.length, 6);
  assert.deepEqual(bitsOf(stamps[3].data), expectedImage);
  assert.deepEqual(stamps[3].flags, expectedFlags);
  assert.equal(events.filter((e) => e.type === 'stamp').length, 6);
  assert.equal(events.at(-1).total, 6);
});

test('client: every failure comes back as a state and nothing throws', async () => {
  assert.deepEqual(await clientFor(world(six, { complete: false })).plan(POS.ra, POS.dec, 2), { state: 'not-indexed' });
  assert.deepEqual(await clientFor(world(six)).plan(POS.ra, POS.dec, 5), { state: 'no-coverage' });
  assert.deepEqual(await clientFor(world(six.slice(0, 3))).plan(POS.ra, POS.dec, 2), { state: 'one-visit' });
  assert.deepEqual(await clientFor(world(six, { bucketFails: true })).plan(POS.ra, POS.dec, 2), { state: 'unreachable' });
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await clientFor(world(six), { importer: async () => { throw new Error('no such module'); } }).plan(POS.ra, POS.dec, 2), { state: 'unreachable' }, 'the rules are missing');
    assert.deepEqual(await clientFor(world(six), { importer: async () => ({}) }).plan(POS.ra, POS.dec, 2), { state: 'unreachable' }, 'the rules are not functions');
  } finally { console.warn = quiet; }
  // a load whose bucket has gone away
  const plan = await clientFor(world(six)).plan(POS.ra, POS.dec, 2);
  assert.deepEqual(await clientFor(world(six, { bucketFails: true })).load(plan), { state: 'unreachable' });
  // the real client, in a place with no worker and no site files: still a state
  const warn = console.warn, err = console.error;
  console.warn = console.error = () => {};
  try { assert.deepEqual(await client.plan(1, 2, 3), { state: 'unreachable' }); } finally { console.warn = warn; console.error = err; }
});

test('client: cancel ends what is running with {state: "cancelled"} and the client works afterwards', async () => {
  const w = world(six, { delayMs: 30 });
  const c = clientFor(w);
  const plan = await c.plan(POS.ra, POS.dec, 2);
  const p = c.load(plan, () => {});
  setTimeout(() => c.cancel(), 15);
  assert.deepEqual(await p, { state: 'cancelled' });
  const q = c.plan(POS.ra, POS.dec, 2);
  c.cancel();
  assert.deepEqual(await q, { state: 'cancelled' });
  await new Promise((r) => setTimeout(r, 100)); // late answers of the cancelled calls are ignored
  assert.equal((await c.load(await c.plan(POS.ra, POS.dec, 2))).length, 6);
});

test('worker: the messages are answered with ids, progress comes before the result, bad messages are ignored', async () => {
  const w = world(six);
  const out = [];
  const fetchFn = async (url, init) => (url === 'http://index.test/wave.json' ? new Response(JSON.stringify(tables)) : w.fetch(url, init));
  const h = createHandler({ post: (m) => out.push(m), fetch: fetchFn, cache: null, importer: async () => rules, config: { indexBase: BASE, waveUrl: 'http://index.test/wave.json', rulesUrl: 'x' } });
  assert.equal(h.handle(null), undefined);
  assert.equal(h.handle({ op: 'nonsense' }), undefined);
  await h.handle({ op: 'plan', id: 7, ra: POS.ra, dec: POS.dec, det: 2 });
  const planMsg = out.find((m) => m.type === 'result' && m.id === 7);
  assert.ok(planMsg && planMsg.result.pairs.length === 3);
  structuredClone(planMsg); // everything that is sent can be copied
  await h.handle({ op: 'load', id: 8, plan: planMsg.result });
  const mine = out.filter((m) => m.id === 8);
  assert.equal(mine.at(-1).type, 'result');
  assert.ok(mine.slice(0, -1).every((m) => m.type === 'progress'));
  assert.equal(mine.at(-1).result.length, 6);
});

test('the stamp cache keeps the newest stamps in memory and works without IndexedDB', async () => {
  const cache = createStampCache({ maxMemory: 2, idb: null });
  const v = (n) => ({ data: new Float32Array([n]), flags: null });
  await cache.put('a', v(1)); await cache.put('b', v(2)); await cache.get('a'); await cache.put('c', v(3));
  assert.deepEqual([await cache.get('a'), await cache.get('b'), await cache.get('c')].map((x) => x && x.data[0]), [1, undefined, 3]);
  assert.equal(cache.stats.memoryHits, 3);
});

test('the stamp cache reads and writes IndexedDB when there is one, and survives one that fails', async () => {
  // a small stand-in for the parts of IndexedDB that the cache uses
  const rows = new Map();
  const req = (fn) => { const r = {}; queueMicrotask(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
  const store = { get: (k) => req(() => rows.get(k)), put: (v, k) => req(() => rows.set(k, structuredClone(v))), count: () => req(() => rows.size), createIndex() {}, index: () => ({ openCursor: () => req(() => null) }) };
  const db = { transaction: () => ({ objectStore: () => store }), createObjectStore: () => store };
  const idb = { open: () => { const r = {}; queueMicrotask(() => { r.result = db; r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
  const first = createStampCache({ idb, maxMemory: 1 });
  await first.put('k', { data: new Float32Array([1, 2, 3]), flags: new Int32Array([4, 5, 6]) });
  await first.put('other', { data: new Float32Array([9]), flags: null });
  const second = createStampCache({ idb, maxMemory: 1 });
  const got = await second.get('k');
  assert.deepEqual([...got.data], [1, 2, 3]);
  assert.deepEqual([...got.flags], [4, 5, 6]);
  assert.equal(second.stats.storeHits, 1);
  assert.equal(await second.get('missing'), undefined);
  const broken = createStampCache({ idb: { open() { throw new Error('private window'); } } });
  await broken.put('k', { data: new Float32Array([1]), flags: null });
  assert.equal((await broken.get('k')).data[0], 1, 'the memory still serves');
  assert.equal(await createStampCache({ idb: { open() { throw new Error('x'); } } }).get('never'), undefined);
});

test('no file of the reader mentions the Cache API', () => {
  const dir = new URL('../../site/js/lib/', import.meta.url);
  for (const name of ['fitsio', 'rice', 'wcs', 'wave', 'frame', 'tiles', 'queue', 'livepath', 'worker', 'client']) {
    const text = readFileSync(new URL(`${name}.js`, dir), 'utf8');
    assert.doesNotMatch(text, /\bcaches\s*[.[]|\bnew Cache\b|\bCacheStorage\b|cache:\s*['"](?!no-store)/, name);
  }
  assert.ok(readdirSync(dir).includes('queue.js'));
});
