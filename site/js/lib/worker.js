// The Web Worker of CT-12: it runs the live path off the main thread. The page talks to it through client.js.
//
// Messages to the worker:
//   {op: 'init', config}                          set what the worker uses (see Config); optional, before the first call
//   {op: 'plan', id, ra, dec, det, opts}          answered by {id, type: 'result', result}
//   {op: 'load', id, plan, flags}                 {id, type: 'progress', progress} while it runs, then {id, type: 'result', result}
//   {op: 'cancel'}                                stops every call that is running; each ends with {state: 'cancelled'}
// Every result is a plan, stamps, or {state}: a failure is never an exception. Nothing here uses the Cache API:
// range answers are not stored; decoded stamps are, in memory and in IndexedDB.
import { createQueue } from './queue.js';
import { createIndex } from './tiles.js';
import { makeWavelengthAt, loadWaveTables } from './wave.js';
import { createLivePath } from './livepath.js';

/** @import { StampCache, Rules } from './livepath.js' */

/**
 * @typedef {Object} Config  Everything is optional; the defaults are the files of this site.
 * @property {string} [indexBase]  Address of the index folder (meta.json and t/). Default: idx/ of the site.
 * @property {string} [waveUrl]  Address of the wavelength tables. Default: data/wave/tables.json of the site.
 * @property {string} [rulesUrl]  A module that exports `visits`, `matchPairs` and perhaps `defaultPair`. Default: visits.js and match.js beside this file.
 * @property {boolean} [requireIndexed]  Default true.
 * @property {number} [slowFirstRequestMs] @property {number} [firstPairBudgetMs] @property {number} [maxHeadersPerVisit]
 */

/**
 * Decoded stamps, kept in memory and, where the browser has it, in IndexedDB. Nothing here throws: a store that fails is dropped.
 * @param {{maxMemory?: number, maxStored?: number, name?: string, idb?: IDBFactory | null}} [options]
 * @returns {StampCache & {stats: {memoryHits: number, storeHits: number, puts: number}}}
 */
export function createStampCache({ maxMemory = 256, maxStored = 1500, name = 'ssc-stamps', idb = globalThis.indexedDB ?? null } = {}) {
  /** @typedef {{data: Float32Array, flags: Int32Array | null}} Value */
  /** @type {Map<string, Value>} */
  const memory = new Map();
  const stats = { memoryHits: 0, storeHits: 0, puts: 0 };
  /** @type {Promise<IDBDatabase | null> | null} */
  let opening = null;

  function open() {
    if (!idb) return Promise.resolve(null);
    opening ??= new Promise((resolve) => {
      try {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore('stamps').createIndex('at', 'at'); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return opening;
  }

  /** @template T @param {IDBRequest<T>} r @returns {Promise<T | undefined>} */
  const wait = (r) => new Promise((resolve) => { r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); });

  /** @param {string} key @param {Value} value */
  function remember(key, value) {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > maxMemory) memory.delete(/** @type {string} */ (memory.keys().next().value));
  }

  /** @type {StampCache['get']} */
  async function get(key) {
    const hit = memory.get(key);
    if (hit) { stats.memoryHits++; remember(key, hit); return hit; }
    try {
      const db = await open();
      if (!db) return undefined;
      const row = await wait(db.transaction('stamps').objectStore('stamps').get(key));
      if (!row || !(row.data instanceof Float32Array)) return undefined;
      /** @type {Value} */
      const value = { data: row.data, flags: row.flags instanceof Int32Array ? row.flags : null };
      stats.storeHits++;
      remember(key, value);
      return value;
    } catch { return undefined; }
  }

  /** @type {StampCache['put']} */
  async function put(key, value) {
    remember(key, value);
    stats.puts++;
    try {
      const db = await open();
      if (!db) return;
      const store = db.transaction('stamps', 'readwrite').objectStore('stamps');
      store.put({ data: value.data, flags: value.flags, at: Date.now() }, key);
      if (stats.puts % 50 === 0) {
        const count = await wait(db.transaction('stamps').objectStore('stamps').count());
        if (count && count > maxStored) {
          const trim = db.transaction('stamps', 'readwrite').objectStore('stamps');
          let drop = count - maxStored;
          const cursor = trim.index('at').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (c && drop-- > 0) { c.delete(); c.continue(); }
          };
        }
      }
    } catch { /* a store that fails is dropped; the memory still serves */ }
  }

  return { get, put, stats };
}

/**
 * @typedef {Object} HandlerOptions
 * @property {(message: unknown) => void} post  Sends a message to the page.
 * @property {typeof fetch} [fetch]
 * @property {Config} [config]
 * @property {StampCache | null} [cache]  Default: a new `createStampCache()`.
 * @property {(url: string) => Promise<any>} [importer]  Loads a module; default dynamic import. Tests pass their own.
 */

/** @param {unknown} e */
const isAbort = (e) => /** @type {any} */ (e)?.name === 'AbortError';

/**
 * The worker's logic, with its inputs handed in so it can run anywhere.
 * @param {HandlerOptions} o
 */
export function createHandler(o) {
  const { post } = o;
  /** @type {Config} */
  let config = o.config ?? {};
  const fetchFn = o.fetch ?? ((/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.fetch)(...a));
  const importer = o.importer ?? ((/** @type {string} */ url) => import(url));
  const cache = o.cache === undefined ? createStampCache() : o.cache;
  const queue = createQueue({ fetch: fetchFn });
  const index = createIndex({ fetch: fetchFn });
  /** @type {Promise<ReturnType<typeof createLivePath>> | null} */
  let ready = null;
  /** @type {Map<number, AbortController>} */
  const running = new Map();

  /** @returns {Promise<Rules>} */
  async function loadRules() {
    if (config.rulesUrl) {
      const m = await importer(config.rulesUrl);
      return { visits: m.visits, matchPairs: m.matchPairs, defaultPair: m.defaultPair };
    }
    const [v, m] = await Promise.all([importer(new URL('./visits.js', import.meta.url).href), importer(new URL('./match.js', import.meta.url).href)]);
    return { visits: v.visits, matchPairs: m.matchPairs, defaultPair: v.defaultPair };
  }

  function livepath() {
    ready ??= (async () => {
      const waveUrl = config.waveUrl ?? new URL('../../data/wave/tables.json', import.meta.url).href;
      const [tables, rules] = await Promise.all([loadWaveTables(waveUrl, fetchFn), loadRules()]);
      if (typeof rules.visits !== 'function' || typeof rules.matchPairs !== 'function') throw new Error('the rules module must export visits and matchPairs');
      return createLivePath({
        queue, index, rules, cache,
        wavelengthAt: makeWavelengthAt(tables),
        indexBase: config.indexBase ?? new URL('../../idx/', import.meta.url).href,
        requireIndexed: config.requireIndexed,
        slowFirstRequestMs: config.slowFirstRequestMs,
        firstPairBudgetMs: config.firstPairBudgetMs,
        maxHeadersPerVisit: config.maxHeadersPerVisit,
        log: (message, error) => post({ type: 'log', message, error: String(/** @type {any} */ (error)?.stack ?? error) }),
      });
    })();
    ready.catch(() => { ready = null; }); // try again on the next call
    return ready;
  }

  /** @param {number} id @param {(signal: AbortSignal) => Promise<unknown>} run */
  async function answer(id, run) {
    const ac = new AbortController();
    running.set(id, ac);
    let result;
    try {
      result = await run(ac.signal);
    } catch (e) {
      post({ type: 'log', message: 'the worker could not start the live path', error: String(/** @type {any} */ (e)?.stack ?? e) });
      result = { state: isAbort(e) ? 'cancelled' : 'unreachable' };
    } finally {
      running.delete(id);
    }
    post({ id, type: 'result', result });
  }

  /** @param {any} msg */
  function handle(msg) {
    if (!msg || typeof msg !== 'object') return undefined;
    switch (msg.op) {
      case 'init':
        config = { ...config, ...msg.config };
        ready = null;
        return undefined;
      case 'plan':
        return answer(msg.id, async (signal) => (await livepath()).plan(msg.ra, msg.dec, msg.det, { ...msg.opts, signal }));
      case 'load':
        return answer(msg.id, async (signal) => (await livepath()).load(msg.plan, {
          signal, flags: msg.flags, onProgress: (progress) => post({ id: msg.id, type: 'progress', progress }),
        }));
      case 'cancel':
        for (const ac of running.values()) ac.abort();
        return undefined;
      default:
        return undefined;
    }
  }

  return { handle, queue, cache };
}

// When this file runs as a worker, answer the page.
const scope = /** @type {any} */ (globalThis);
if (typeof scope.WorkerGlobalScope !== 'undefined' && scope instanceof scope.WorkerGlobalScope) {
  const handler = createHandler({ post: (m) => scope.postMessage(m) });
  scope.onmessage = (/** @type {MessageEvent} */ e) => { handler.handle(e.data); };
}
