// The page's side of the worker (CT-12).
//
//   import { client } from './client.js';
//   const plan = await client.plan(ra, dec, det);          // a plan, or {state}
//   const stamps = await client.load(plan, onProgress);    // stamps, or {state}
//   client.cancel();                                       // whatever is running ends with {state: 'cancelled'}
//
// Failures are states, never exceptions: 'no-coverage', 'one-visit', 'not-indexed', 'slow', 'unreachable', 'too-bright',
// 'too-faint', 'quiet' (CT-12). A call that was cancelled gives {state: 'cancelled'}. `stamps` come in pair order:
// stamps[2k] and stamps[2k + 1] are the two frames of pair k of the plan; only complete pairs are returned.

/** @import { Plan, Failure, Stamp, Det, Client } from '../contracts.js' */
/** @import { LivePlan, LivePart, LoadOptions, Progress } from './livepath.js' */
/** @import { Config } from './worker.js' */

/** @typedef {Failure | {state: 'cancelled'}} NoResult */

/**
 * @typedef {Object} ClientOptions
 * @property {Config} [config]  What the worker uses; see worker.js. Default: the files of this site.
 * @property {string | URL} [workerUrl]  Default: worker.js beside this file.
 * @property {{postMessage: (message: any) => void, onmessage: ((e: {data: any}) => void) | null, terminate?: () => void} | null} [worker]  A worker-like object, for tests.
 * @property {boolean} [inline]  Run the worker's logic in this thread: for a browser without module workers, and for tests.
 * @property {Partial<Omit<import('./worker.js').HandlerOptions, 'post'>>} [handler]  With `inline`: what the handler is given (fetch, cache, importer).
 */

/**
 * @param {ClientOptions} [options]
 * @returns {{plan: (ra: number, dec: number, det: number, opts?: {visitPair?: [number, number], n?: number, slow?: boolean}) => Promise<LivePlan | NoResult>,
 *   load: (plan: LivePart, onProgress?: (p: Progress) => void, opts?: {flags?: boolean}) => Promise<Stamp[] | NoResult>,
 *   cancel: () => void, terminate: () => void}}
 */
export function createClient({ config, workerUrl, worker, inline = false, handler } = {}) {
  /** @type {typeof worker} */
  let w = worker ?? null;
  /** @type {Promise<void> | null} */
  let starting = null;
  let nextId = 1;
  /** @type {Map<number, {resolve: (v: any) => void, onProgress?: (p: Progress) => void}>} */
  const pending = new Map();

  /** Everything waiting is told the same thing. @param {NoResult} result */
  function settleAll(result) {
    for (const p of pending.values()) p.resolve(result);
    pending.clear();
  }

  /** @param {{data: any}} e */
  function onMessage(e) {
    const m = e.data;
    if (!m) return;
    if (m.type === 'log') { console.warn('worker:', m.message, m.error ?? ''); return; }
    const p = pending.get(m.id);
    if (!p) return; // a call that was cancelled
    if (m.type === 'progress') { try { p.onProgress?.(m.progress); } catch (err) { console.error(err); } return; }
    if (m.type === 'result') { pending.delete(m.id); p.resolve(m.result); }
  }

  function start() {
    starting ??= (async () => {
      if (!w) {
        if (inline || typeof Worker === 'undefined') {
          const { createHandler } = await import('./worker.js');
          /** @type {{postMessage: (m: any) => void, onmessage: ((e: {data: any}) => void) | null}} */
          const channel = { onmessage: null, postMessage: (m) => { h.handle(structuredClone(m)); } };
          const h = createHandler({ ...handler, post: (m) => { const c = structuredClone(m); queueMicrotask(() => channel.onmessage?.({ data: c })); } });
          w = channel;
        } else {
          const real = new Worker(workerUrl ?? new URL('./worker.js', import.meta.url), { type: 'module' });
          real.onerror = (e) => { console.error('worker failed', e.message); settleAll({ state: 'unreachable' }); };
          w = /** @type {any} */ (real);
        }
      }
      /** @type {any} */ (w).onmessage = onMessage;
      if (config) w?.postMessage({ op: 'init', config });
    })();
    return starting;
  }

  /** @param {Record<string, unknown>} message @param {(p: Progress) => void} [onProgress] @returns {Promise<any>} */
  function call(message, onProgress) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve, onProgress }); // at once, so that a cancel() right after the call reaches it
      start().then(() => {
        if (!pending.has(id)) return; // cancelled while the worker was starting
        try {
          /** @type {NonNullable<typeof w>} */ (w).postMessage({ ...message, id });
        } catch (err) {
          console.error(err);
          pending.delete(id);
          resolve({ state: 'unreachable' });
        }
      }, (err) => {
        console.error(err);
        pending.delete(id);
        resolve({ state: 'unreachable' });
      });
    });
  }

  return {
    plan: (ra, dec, det, opts) => call({ op: 'plan', ra, dec, det, opts }),
    load: (plan, onProgress, opts) => call({ op: 'load', plan, flags: opts?.flags }, onProgress),
    cancel() {
      w?.postMessage({ op: 'cancel' });
      settleAll({ state: 'cancelled' });
    },
    terminate() {
      settleAll({ state: 'cancelled' });
      w?.terminate?.();
      w = null;
      starting = null;
    },
  };
}

/** @type {ReturnType<typeof createClient> | null} */
let shared = null;
const one = () => (shared ??= createClient());

/** The client of this page: its worker starts with the first call. */
export const client = {
  /** @type {ReturnType<typeof createClient>['plan']} */
  plan: (ra, dec, det, opts) => one().plan(ra, dec, det, opts),
  /** @type {ReturnType<typeof createClient>['load']} */
  load: (plan, onProgress, opts) => one().load(plan, onProgress, opts),
  cancel: () => shared?.cancel(),
};

/**
 * Start the shared client with other settings (before the first call).
 * @param {ClientOptions} options
 */
export function configureClient(options) {
  shared?.terminate();
  shared = createClient(options);
}
