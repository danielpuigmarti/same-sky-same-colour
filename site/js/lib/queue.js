// The one place that talks to the archive bucket: byte-range reads through a queue.
//   - at most `limit` (6) requests in flight per host, because the bucket's two host names are limited apart;
//   - header requests go before row requests, then lower `prio` first, then in the order asked;
//   - a request is checked: the status must be 206 and the body exactly the length asked, or it counts as failed;
//   - a failed request is tried again twice, after a pause that doubles; a request that takes too long is cut off;
//   - `cancel()` stops everything that is running or waiting.
// A range request with "bytes=a-b" needs no preflight, and the server's Content-Range is not readable from a page,
// so the length of the body is the proof. Responses are asked for with cache "no-store": nothing here puts a range
// answer into any cache.

export const HOST_LIMIT = 6;
export const RETRIES = 2;
export const HEADER_TIMEOUT_MS = 15000;
export const ROW_TIMEOUT_MS = 40000;

/** @typedef {'header' | 'row'} RequestKind */
/** @typedef {'timeout' | 'network' | 'http' | 'ignored-range' | 'length' | 'aborted'} FetchCode */

/** What went wrong with a request. `retryable` says whether trying again can help. */
export class FetchError extends Error {
  /** @param {FetchCode} code @param {string} message @param {{status?: number, retryable?: boolean}} [more] */
  constructor(code, message, { status, retryable = false } = {}) {
    super(message);
    this.name = code === 'aborted' ? 'AbortError' : 'FetchError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * @typedef {Object} Job
 * @property {string} url @property {string} host @property {number} start @property {number} end
 * @property {number} rank  0 for a header, 1 for rows. @property {number} prio @property {number} seq @property {number} timeoutMs
 * @property {AbortSignal | undefined} signal  The caller's own signal. @property {AbortController} epoch  The queue's signal when the job was asked for.
 * @property {(v: Uint8Array) => void} resolve @property {(e: unknown) => void} reject
 */

/**
 * @typedef {Object} QueueOptions
 * @property {typeof fetch} [fetch]  Default: the global fetch.
 * @property {number} [limit]  Requests in flight per host (default 6).
 * @property {number} [retries]  Extra tries after a failure (default 2).
 * @property {number} [retryDelayMs]  Pause before the first new try; it doubles (default 250).
 */

/**
 * @typedef {Object} GetOptions
 * @property {RequestKind} [kind]  'header' goes before 'row' (default 'row').
 * @property {number} [prio]  Lower goes first within a kind (default 0).
 * @property {AbortSignal} [signal]  Stops this request.
 * @property {number} [timeoutMs]  Per try.
 */

/**
 * @typedef {Object} Queue
 * @property {(url: string, start: number, end: number, options?: GetOptions) => Promise<Uint8Array>} get  The bytes start to end, both included.
 * @property {() => void} cancel  Stop everything running or waiting; the queue works again afterwards.
 * @property {{requests: number, retries: number, bytes: number, failures: number, byStatus: Record<string, number>, maxInFlight: Record<string, number>}} stats
 * @property {() => Record<string, number>} inFlight  Requests open now, by host.
 */

/** @param {number} ms @param {AbortSignal[]} signals */
function sleep(ms, signals) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(t); reject(new FetchError('aborted', 'aborted')); };
    const t = setTimeout(() => { for (const s of signals) s.removeEventListener('abort', abort); resolve(undefined); }, ms);
    for (const s of signals) {
      if (s.aborted) return abort();
      s.addEventListener('abort', abort, { once: true });
    }
    return undefined;
  });
}

/** @param {QueueOptions} [options] @returns {Queue} */
export function createQueue({ fetch: fetchFn, limit = HOST_LIMIT, retries = RETRIES, retryDelayMs = 250 } = {}) {
  const doFetch = fetchFn ?? ((/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.fetch)(...a));
  let epoch = new AbortController();
  /** @type {Job[]} */
  let waiting = [];
  /** @type {Record<string, number>} */
  const open = {};
  let seq = 0, scheduled = false;
  /** @type {Queue['stats']} */
  const stats = { requests: 0, retries: 0, bytes: 0, failures: 0, byStatus: {}, maxInFlight: {} };

  /** @param {Job} a @param {Job} b */
  const before = (a, b) => a.rank - b.rank || a.prio - b.prio || a.seq - b.seq;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; pump(); }); // a burst of requests is sorted as a whole before the first one starts
  }

  function pump() {
    for (let i = 0; i < waiting.length;) {
      const job = waiting[i];
      if ((open[job.host] ?? 0) >= limit) { i++; continue; }
      waiting.splice(i, 1);
      start(job);
    }
  }

  /** @param {Job} job */
  function start(job) {
    open[job.host] = (open[job.host] ?? 0) + 1;
    stats.maxInFlight[job.host] = Math.max(stats.maxInFlight[job.host] ?? 0, open[job.host]);
    run(job).then(job.resolve, (e) => { stats.failures++; job.reject(e); }).finally(() => { open[job.host] -= 1; pump(); });
  }

  /** @param {Job} job */
  async function run(job) {
    for (let attempt = 0; ; attempt++) {
      if (job.epoch.signal.aborted || job.signal?.aborted) throw new FetchError('aborted', 'aborted');
      try {
        return await once(job);
      } catch (e) {
        const err = /** @type {FetchError} */ (e);
        if (err.code === 'aborted' || !err.retryable || attempt >= retries) throw err;
        stats.retries++;
        await sleep(retryDelayMs * 2 ** attempt, job.signal ? [job.epoch.signal, job.signal] : [job.epoch.signal]);
      }
    }
  }

  /** @param {Job} job @returns {Promise<Uint8Array>} */
  async function once(job) {
    const ac = new AbortController();
    let timedOut = false;
    const stop = () => ac.abort();
    const outer = job.signal ? [job.epoch.signal, job.signal] : [job.epoch.signal];
    for (const s of outer) s.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, job.timeoutMs);
    try {
      let res;
      try {
        res = await doFetch(job.url, { headers: { Range: `bytes=${job.start}-${job.end}` }, cache: 'no-store', signal: ac.signal });
        stats.byStatus[res.status] = (stats.byStatus[res.status] ?? 0) + 1;
        if (res.status === 206) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length !== job.end - job.start + 1) {
            throw new FetchError('length', `${buf.length} bytes came back for ${job.end - job.start + 1} asked`, { retryable: true });
          }
          stats.requests++;
          stats.bytes += buf.length;
          return buf;
        }
      } catch (e) {
        if (e instanceof FetchError) throw e;
        if (timedOut) throw new FetchError('timeout', `no answer in ${job.timeoutMs} ms`, { retryable: true });
        if (outer.some((s) => s.aborted)) throw new FetchError('aborted', 'aborted');
        throw new FetchError('network', String(e), { retryable: true });
      }
      ac.abort(); // the body is not wanted: a server that ignores Range would send the whole file
      if (res.status === 200) throw new FetchError('ignored-range', 'the server ignored the Range header', { status: 200 });
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      throw new FetchError('http', `status ${res.status}`, { status: res.status, retryable });
    } finally {
      clearTimeout(timer);
      for (const s of outer) s.removeEventListener('abort', stop);
    }
  }

  /** @type {Queue['get']} */
  function get(url, start, end, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) return reject(new FetchError('aborted', 'aborted'));
      const kind = options.kind ?? 'row';
      /** @type {Job} */
      const job = {
        url, host: new URL(url).host, start, end, rank: kind === 'header' ? 0 : 1, prio: options.prio ?? 0, seq: seq++,
        timeoutMs: options.timeoutMs ?? (kind === 'header' ? HEADER_TIMEOUT_MS : ROW_TIMEOUT_MS),
        signal: options.signal, epoch, resolve, reject,
      };
      let i = waiting.length;
      while (i > 0 && before(job, waiting[i - 1]) < 0) i--;
      waiting.splice(i, 0, job);
      options.signal?.addEventListener('abort', () => {
        const at = waiting.indexOf(job);
        if (at >= 0) { waiting.splice(at, 1); reject(new FetchError('aborted', 'aborted')); }
      }, { once: true });
      schedule();
      return undefined;
    });
  }

  function cancel() {
    const dropped = waiting;
    waiting = [];
    epoch.abort();
    epoch = new AbortController();
    for (const job of dropped) job.reject(new FetchError('aborted', 'aborted'));
  }

  return { get, cancel, stats, inFlight: () => ({ ...open }) };
}
