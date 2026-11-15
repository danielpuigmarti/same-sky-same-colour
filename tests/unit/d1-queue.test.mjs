// D1: the request queue, with a fake fetch. At most 6 requests in flight per host, headers before rows, a retry
// twice, a time limit per request, every range answer checked, and cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, FetchError, HOST_LIMIT, RETRIES } from '../../site/js/lib/queue.js';

const A = 'https://a.test/', B = 'https://b.test/';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch that answers every range request with the right bytes after `delayMs`, unless `behave` decides otherwise.
 * It counts what is open per host and notes the order in which requests started.
 */
function fake({ delayMs = 5, behave } = {}) {
  const open = {}, peak = {}, started = [], log = [];
  async function f(url, init) {
    const host = new URL(url).host;
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    assert.ok(m, 'a Range header "bytes=a-b"');
    assert.equal(init.cache, 'no-store');
    const [start, end] = [Number(m[1]), Number(m[2])];
    const call = { url, start, end, n: log.filter((c) => c.url === url && c.start === start).length };
    log.push(call);
    started.push(`${host}${new URL(url).pathname}@${start}`);
    open[host] = (open[host] ?? 0) + 1;
    peak[host] = Math.max(peak[host] ?? 0, open[host]);
    try {
      const custom = behave?.(call, init);
      if (custom) return await custom;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
      return new Response(new Uint8Array(end - start + 1).fill(7), { status: 206 });
    } finally {
      open[host] -= 1;
    }
  }
  return Object.assign(f, { peak, started, log, open });
}

test('never more than 6 requests in flight per host; the second host has its own 6', async () => {
  const f = fake({ delayMs: 15 });
  const q = createQueue({ fetch: f });
  const all = [];
  for (let i = 0; i < 60; i++) all.push(q.get((i % 2 ? A : B) + 'f.fits', i * 10, i * 10 + 9));
  const out = await Promise.all(all);
  assert.equal(out.length, 60);
  assert.equal(f.peak['a.test'], HOST_LIMIT);
  assert.equal(f.peak['b.test'], HOST_LIMIT);
  assert.deepEqual(q.stats.maxInFlight, { 'a.test': 6, 'b.test': 6 });
  assert.equal(q.stats.requests, 60);
  assert.equal(HOST_LIMIT, 6);
});

test('header requests are served before row requests, even when asked later; then lower prio; then in order', async () => {
  const f = fake();
  const q = createQueue({ fetch: f, limit: 1 });
  const done = [];
  const ask = (label, start, opt) => q.get(A + 'x', start, start + 3, opt).then(() => done.push(label));
  await Promise.all([
    ask('row p2', 0, { kind: 'row', prio: 2 }),
    ask('row p0', 10, { kind: 'row', prio: 0 }),
    ask('row p0 later', 20, { kind: 'row', prio: 0 }),
    ask('header p5', 30, { kind: 'header', prio: 5 }),
    ask('header p1', 40, { kind: 'header', prio: 1 }),
  ]);
  assert.deepEqual(done, ['header p1', 'header p5', 'row p0', 'row p0 later', 'row p2']);
});

test('a failed request is tried again twice: two failures then success gives the bytes', async () => {
  const f = fake({ behave: (c) => (c.n < 2 ? Promise.reject(new TypeError('network down')) : undefined) });
  const q = createQueue({ fetch: f, retryDelayMs: 1 });
  const bytes = await q.get(A + 'x', 100, 199);
  assert.equal(bytes.length, 100);
  assert.equal(f.log.length, 3);
  assert.equal(q.stats.retries, 2);
  assert.equal(RETRIES, 2);
});

test('three failures in a row end in an error, after exactly three tries', async () => {
  const f = fake({ behave: () => Promise.reject(new TypeError('network down')) });
  const q = createQueue({ fetch: f, retryDelayMs: 1 });
  await assert.rejects(q.get(A + 'x', 0, 9), (e) => e instanceof FetchError && e.code === 'network');
  assert.equal(f.log.length, 3);
});

test('a server error is tried again, a missing file is not', async () => {
  const f503 = fake({ behave: (c) => (c.n < 1 ? new Response('', { status: 503 }) : undefined) });
  assert.equal((await createQueue({ fetch: f503, retryDelayMs: 1 }).get(A + 'x', 0, 9)).length, 10);
  const f404 = fake({ behave: () => new Response('', { status: 404 }) });
  await assert.rejects(createQueue({ fetch: f404, retryDelayMs: 1 }).get(A + 'x', 0, 9), (e) => e.code === 'http' && e.status === 404);
  assert.equal(f404.log.length, 1);
});

test('a request that takes too long is cut off and tried again, then fails with "timeout"', async () => {
  const f = fake({ delayMs: 10_000 });
  const q = createQueue({ fetch: f, retryDelayMs: 1 });
  const t0 = Date.now();
  await assert.rejects(q.get(A + 'x', 0, 9, { timeoutMs: 20 }), (e) => e.code === 'timeout');
  assert.equal(f.log.length, 3);
  assert.ok(Date.now() - t0 < 1000);
});

test('the time limit also covers reading the body', async () => {
  const f = fake({
    behave: (c, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError'))); },
    }), { status: 206 })),
  });
  await assert.rejects(createQueue({ fetch: f, retryDelayMs: 1 }).get(A + 'x', 0, 9, { timeoutMs: 20 }), (e) => e.code === 'timeout');
});

test('a 200 answer (Range ignored) fails at once, without reading the body and without a retry', async () => {
  let answer;
  const f = fake({ behave: () => (answer = new Response(new Uint8Array(1000), { status: 200 })) });
  await assert.rejects(createQueue({ fetch: f, retryDelayMs: 1 }).get(A + 'x', 0, 9), (e) => e.code === 'ignored-range');
  assert.equal(f.log.length, 1);
  assert.equal(answer.bodyUsed, false);
});

test('a 206 answer of the wrong length is a failure, tried again, then an error', async () => {
  const f = fake({ behave: (c) => new Response(new Uint8Array(c.end - c.start), { status: 206 }) }); // one byte short
  const q = createQueue({ fetch: f, retryDelayMs: 1 });
  await assert.rejects(q.get(A + 'x', 0, 99), (e) => e.code === 'length');
  assert.equal(f.log.length, 3);
  const g = fake({ behave: (c) => (c.n === 0 ? new Response(new Uint8Array(5), { status: 206 }) : undefined) });
  assert.equal((await createQueue({ fetch: g, retryDelayMs: 1 }).get(A + 'x', 0, 99)).length, 100);
});

test('cancel stops what runs and what waits; the queue works again afterwards', async () => {
  const f = fake({ delayMs: 50 });
  const q = createQueue({ fetch: f, limit: 2 });
  const results = Array.from({ length: 6 }, (_, i) => q.get(A + 'x', i * 10, i * 10 + 9).then(() => 'ok', (e) => e.name));
  await tick(5);
  q.cancel();
  assert.deepEqual(await Promise.all(results), Array(6).fill('AbortError'));
  assert.equal(f.log.length, 2, 'only the two that had started');
  assert.deepEqual(q.inFlight(), { 'a.test': 0 });
  assert.equal((await q.get(A + 'x', 0, 9)).length, 10);
});

test('one request can be stopped by its own signal, waiting or running', async () => {
  const f = fake({ delayMs: 30 });
  const q = createQueue({ fetch: f, limit: 1 });
  const ac = new AbortController(), ac2 = new AbortController();
  const running = q.get(A + 'x', 0, 9, { signal: ac.signal }).then(() => 'ok', (e) => e.name);
  const waiting = q.get(A + 'x', 10, 19, { signal: ac2.signal }).then(() => 'ok', (e) => e.name);
  const other = q.get(A + 'x', 20, 29).then((b) => b.length);
  await tick(5);
  ac.abort(); ac2.abort();
  assert.equal(await running, 'AbortError');
  assert.equal(await waiting, 'AbortError');
  assert.equal(await other, 10);
  assert.equal(await q.get(A + 'x', 0, 9, { signal: AbortSignal.abort() }).then(() => 'ok', (e) => e.name), 'AbortError');
});

test('a cancel during the pause before a new try ends the request', async () => {
  const f = fake({ behave: () => Promise.reject(new TypeError('down')) });
  const q = createQueue({ fetch: f, retryDelayMs: 10_000 });
  const p = q.get(A + 'x', 0, 9).then(() => 'ok', (e) => e.name);
  await tick(10);
  q.cancel();
  assert.equal(await p, 'AbortError');
});
