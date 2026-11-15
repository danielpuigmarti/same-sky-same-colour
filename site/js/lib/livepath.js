// From a sky position to stamps in memory (CT-12), with no server of ours:
//   plan  the index tile -> frames of the detector that hold the position -> visits -> the two visits to compare ->
//         the first bytes (headers) of their frames -> target pixel and wavelength of each -> pairs at the same colour.
//   load  only the rows of the paired frames: IMAGE rows and FLAGS, decoded into stamps.
// The visit rule and the match rule belong to another part of the project; they are handed in as functions
// (`rules.visits`, `rules.matchPairs`, see CT-5 and CT-6). A failure is `{state}` in place of the result, never an
// exception; `{state: 'cancelled'}` is what a call gives when the caller stopped it.
import { BUCKET_URLS } from '../contracts.js';
import { readHead, place, reachesBadRows, readStamp, STAMP_SIZE } from './frame.js';
import { makeWcs } from './wcs.js';

/** @import { Frame, Visit, Visits, MatchPairs, Matchable, Plan, Failure, FailureState, Stamp, Det, Wavelength } from '../contracts.js' */
/** @import { Queue } from './queue.js' */
/** @import { FrameHead, Get } from './frame.js' */

/** A position counts as inside a frame only when it is this far (degrees) from the outline: room for the stamp and a little more. */
export const MARGIN_DEG = 0.06;
/** The most frames of one visit whose headers are read; at the ecliptic poles a visit holds many more. */
export const MAX_HEADERS_PER_VISIT = 40;
/** The most pairs of visits tried before giving up on colour pairs. */
export const MAX_VISIT_PAIRS_TRIED = 3;
/** The first pair has this long to arrive (30 s budget); after that the state is `slow`. */
export const FIRST_PAIR_BUDGET_MS = 30000;
/** A first header request slower than this marks the link slow: the first pair is loaded alone. */
export const SLOW_FIRST_REQUEST_MS = 1000;
/** After a first pair that took longer than this, the rest is held back as "load more". */
export const FIRST_PAIR_SLOW_MS = 8000;
/** Bytes per second measured in Chrome on a laptop link and on the "slow 4G" profile (probe V9); a first guess for the plan. */
export const FAST_BYTES_PER_S = 2.0e6;
export const SLOW_BYTES_PER_S = 0.14e6;

/** Bytes of one frame in a load: the IMAGE rows, the FLAGS header with its pointer table, and about this much FLAGS heap per row. */
const FLAGS_HEAP_PER_ROW = 5600;
/** @param {number} n Stamp side. */
export const bytesPerFrame = (n = STAMP_SIZE) => n * 2040 * 4 + 39360 + n * FLAGS_HEAP_PER_ROW;

/**
 * A frame placed on its detector: everything `load` needs to read its stamp without reading its headers again.
 * @typedef {Object} Item
 * @property {string} key @property {Det} det @property {number} mjd
 * @property {number} x0 @property {number} y0 @property {number} tx @property {number} ty @property {number} lam @property {number} bw
 * @property {number} nx @property {number} ny @property {number} doff @property {number} next
 */

/**
 * The visit rule and the match rule (and, if there is one, the rule that names the default pair), as functions.
 * @typedef {Object} Rules
 * @property {Visits} visits  CT-5.
 * @property {MatchPairs} matchPairs  CT-6.
 * @property {(visits: Visit[]) => [number, number] | null | undefined} [defaultPair]  Positions in `visits` of the pair to compare first.
 */

/**
 * What `plan` gives: CT-12's Plan and what `load` needs.
 * @typedef {Object} LivePart
 * @property {Visit[]} visits @property {[Frame, Frame][]} pairs @property {number} bytes @property {number} seconds
 * @property {Det} det @property {number} ra @property {number} dec @property {number} n  Stamp side.
 * @property {[Item, Item][]} loads  The placed frames of `pairs`, same order.
 */
/**
 * @typedef {LivePart & {visitPair: [number, number], slow: boolean, more: LivePart | null,
 *   firstRequestMs: number | null, skipped: {outside: number, badRows: number, failed: number}}} LivePlan
 * `visitPair`: positions in `visits` of the two visits compared. `slow`: the link is slow, `pairs` holds the first pair only and
 * `more` the rest, as a plan of its own for `load`. `skipped`: frames left out after their header was read.
 */

/**
 * @typedef {Object} LoadOptions
 * @property {(progress: Progress) => void} [onProgress]
 * @property {AbortSignal} [signal]  Stops the call; it then gives `{state: 'cancelled'}`.
 * @property {boolean} [flags]  Read the FLAGS too (default true).
 */

/**
 * What `onProgress` is given. `stamp`: one stamp is ready (done of total; bytes read so far; ms since the call; `pair` is the
 * position of the pair it completed, else null). `warning`: the FLAGS of a frame could not be read, its stamp has flags null.
 * `more`: the first pair was slow, `plan` holds the pairs not loaded.
 * @typedef {{type: 'stamp', done: number, total: number, bytes: number, ms: number, key: string, cached: boolean, pair: number | null}
 *   | {type: 'warning', key: string, what: string}
 *   | {type: 'more', plan: LivePart}} Progress
 */

/**
 * @typedef {Object} StampCache
 * @property {(key: string) => Promise<{data: Float32Array, flags: Int32Array | null} | undefined>} get
 * @property {(key: string, value: {data: Float32Array, flags: Int32Array | null}) => Promise<void>} put
 */

/** A failure that is a state. */
export class StateError extends Error {
  /** @param {FailureState | 'cancelled'} state */
  constructor(state) { super(state); this.state = state; }
}

/** @param {number} bytes @param {boolean} slow */
export const estimateSeconds = (bytes, slow) => Math.round(1 + bytes / (slow ? SLOW_BYTES_PER_S : FAST_BYTES_PER_S));

/** @param {number} nFrames @param {number} n @param {boolean} slow @returns {{bytes: number, seconds: number}} */
function cost(nFrames, n, slow) {
  const bytes = nFrames * bytesPerFrame(n);
  return { bytes, seconds: estimateSeconds(bytes, slow) };
}

/**
 * The pairs of visits to try, best first: visits that are not short and at least half as deep as the deepest, farthest apart
 * first; then the rest. Each pair is [earlier, later] as positions in `visits`.
 * @param {Visit[]} visits
 * @returns {[number, number][]}
 */
export function rankVisitPairs(visits) {
  const all = visits.map((v, i) => ({ i, n: v.frames.length, t: v.frames.length ? v.frames[0].tmid : NaN })).filter((x) => x.n > 0);
  const solid = all.filter((x) => !visits[x.i].short);
  const pool = solid.length >= 2 ? solid : all;
  const deepest = Math.max(0, ...pool.map((x) => x.n));
  const list = [];
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      const [e, l] = pool[a].t <= pool[b].t ? [pool[a], pool[b]] : [pool[b], pool[a]];
      list.push({ pair: /** @type {[number, number]} */ ([e.i, l.i]), deep: Math.min(e.n, l.n) * 2 >= deepest ? 0 : 1, gap: l.t - e.t, n: Math.min(e.n, l.n) });
    }
  }
  list.sort((p, q) => p.deep - q.deep || q.gap - p.gap || q.n - p.n);
  return list.map((p) => p.pair);
}

/** At most `cap` frames, spread evenly over the list. @template T @param {T[]} list @param {number} cap @returns {T[]} */
export function spread(list, cap) {
  if (list.length <= cap) return list;
  return Array.from({ length: cap }, (_, i) => list[Math.round(i * (list.length - 1) / (cap - 1))]);
}

/**
 * @typedef {Object} LivePathOptions
 * @property {Queue} queue  Where every request goes.
 * @property {{framesCovering: (ra: number, dec: number, base: string, opt?: {margin?: number}) => Promise<Frame[]>,
 *   isIndexed: (ra: number, dec: number, base: string) => Promise<boolean>}} index  The reader of the frame index (tiles.js).
 * @property {(det: Det, x: number, y: number) => Wavelength} wavelengthAt  CT-3.
 * @property {Rules} rules
 * @property {string} indexBase  Address of the index folder.
 * @property {boolean} [requireIndexed]  Give `not-indexed` for a tile the index does not list as finished (default true).
 * @property {readonly string[]} [hosts]  The address forms of the bucket (default: both); frames use them in turn.
 * @property {() => number} [now]  Milliseconds, default performance.now.
 * @property {number} [slowFirstRequestMs] @property {number} [firstPairBudgetMs] @property {number} [firstPairSlowMs]
 * @property {number} [margin] @property {number} [maxHeadersPerVisit]
 * @property {() => boolean} [dataSaver]  True when the browser says the link is slow or the user asked to save data.
 * @property {StampCache | null} [cache]  Decoded stamps, by file, box and flags.
 * @property {(message: string, error: unknown) => void} [log]  Told about errors that are not network failures.
 */

/** @param {unknown} e */
const isAbort = (e) => /** @type {any} */ (e)?.code === 'aborted';

/**
 * @param {LivePathOptions} o
 * @returns {{plan: (ra: number, dec: number, det: number, opts?: {visitPair?: [number, number], n?: number, slow?: boolean, signal?: AbortSignal}) => Promise<LivePlan | Failure | {state: 'cancelled'}>,
 *   load: (plan: LivePart, opts?: LoadOptions) => Promise<Stamp[] | Failure | {state: 'cancelled'}>}}
 */
export function createLivePath(o) {
  const { queue, index, wavelengthAt, rules, indexBase } = o;
  const requireIndexed = o.requireIndexed ?? true;
  const hosts = o.hosts ?? BUCKET_URLS;
  const now = o.now ?? (() => performance.now());
  const slowFirstMs = o.slowFirstRequestMs ?? SLOW_FIRST_REQUEST_MS;
  const budgetMs = o.firstPairBudgetMs ?? FIRST_PAIR_BUDGET_MS;
  const firstPairSlowMs = o.firstPairSlowMs ?? FIRST_PAIR_SLOW_MS;
  const margin = o.margin ?? MARGIN_DEG;
  const maxHeaders = o.maxHeadersPerVisit ?? MAX_HEADERS_PER_VISIT;
  const dataSaver = o.dataSaver ?? defaultDataSaver;
  const cache = o.cache ?? null;
  const log = o.log ?? ((m, e) => console.error(m, e));

  /** @type {Map<string, FrameHead>} Headers already read, by bucket key. */
  const heads = new Map();
  /** @type {number | null} How long the first header request took, the last time one was made. */
  let firstRequestMs = null;

  /**
   * The bytes of a frame, from the host it was given and, if that fails for good, from the other one.
   * @param {string} key @param {number} turn @param {AbortSignal | undefined} signal
   * @returns {Get}
   */
  function getter(key, turn, signal) {
    return async (start, end, kind, prio) => {
      let last;
      for (let k = 0; k < hosts.length; k++) {
        try {
          return await queue.get(hosts[(turn + k) % hosts.length] + key, start, end, { kind, prio, signal });
        } catch (e) {
          if (isAbort(e)) throw e;
          last = e;
        }
      }
      throw last;
    };
  }

  /** @param {unknown} e @returns {Failure | {state: 'cancelled'}} */
  function fail(e) {
    if (e instanceof StateError) return { state: /** @type {any} */ (e.state) };
    if (isAbort(e)) return { state: 'cancelled' };
    if (typeof /** @type {any} */ (e)?.code !== 'string') log('livepath: unexpected error', e);
    return { state: 'unreachable' };
  }

  /**
   * @param {number} ra @param {number} dec @param {number} det
   * @param {{visitPair?: [number, number], n?: number, slow?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<LivePlan | Failure | {state: 'cancelled'}>}
   */
  async function plan(ra, dec, det, opts = {}) {
    try {
      return await planInner(ra, dec, det, opts);
    } catch (e) {
      return fail(e);
    }
  }

  /**
   * @param {number} ra @param {number} dec @param {number} det
   * @param {{visitPair?: [number, number], n?: number, slow?: boolean, signal?: AbortSignal}} opts
   * @returns {Promise<LivePlan>}
   */
  async function planInner(ra, dec, det, opts) {
    const n = opts.n ?? STAMP_SIZE, signal = opts.signal;
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90 || !Number.isInteger(det) || det < 1 || det > 6) throw new StateError('no-coverage');
    if (ra < 0 || ra >= 360) ra = ((ra % 360) + 360) % 360;
    if (requireIndexed && !(await index.isIndexed(ra, dec, indexBase))) throw new StateError('not-indexed');
    const frames = (await index.framesCovering(ra, dec, indexBase, { margin })).filter((f) => f.det === det);
    if (!frames.length) throw new StateError('no-coverage');
    const visits = rules.visits(frames);
    if (visits.filter((v) => v.frames.length).length < 2) throw new StateError('one-visit');

    /** @type {[number, number][]} */
    let tries = opts.visitPair ? [opts.visitPair] : rankVisitPairs(visits);
    const named = !opts.visitPair && rules.defaultPair ? rules.defaultPair(visits) : null;
    if (named) tries = [named, ...tries.filter(([a, b]) => a !== named[0] || b !== named[1])];
    tries = tries.slice(0, MAX_VISIT_PAIRS_TRIED);

    const skipped = { outside: 0, badRows: 0, failed: 0 };
    /** @type {unknown} */
    let lastFailure = null;
    let turn = 0; // the headers alternate between the two hosts of the bucket
    /** @param {Frame} f @param {AbortSignal | undefined} sig  @returns {Promise<{frame: Frame, item: Item} | null>} */
    const readOne = async (f, sig) => {
      let head = heads.get(f.key);
      if (!head) {
        try {
          head = await readHead(getter(f.key, turn++, sig), 0);
        } catch (e) {
          if (isAbort(e)) throw e;
          skipped.failed++;
          lastFailure = e;
          return null;
        }
        heads.set(f.key, head);
        if (heads.size > 600) heads.delete(/** @type {string} */ (heads.keys().next().value));
      }
      const at = place(makeWcs(head.h), head.nx, head.ny, ra, dec, n);
      if (!at.inside) { skipped.outside++; return null; }
      if (reachesBadRows(det, at.y0, n)) { skipped.badRows++; return null; }
      const { lam, bw } = wavelengthAt(/** @type {Det} */ (det), at.x, at.y);
      return { frame: f, item: { key: f.key, det: /** @type {Det} */ (det), mjd: head.mjd, x0: at.x0, y0: at.y0, tx: at.tx, ty: at.ty, lam, bw, nx: head.nx, ny: head.ny, doff: head.doff, next: head.next } };
    };

    let firstDone = false;
    /** @param {Visit} v */
    const readVisit = async (v) => {
      if (!v.frames.length) return [];
      const pick = spread(v.frames, maxHeaders);
      /** @type {({frame: Frame, item: Item} | null)[]} */
      let got;
      if (!firstDone && !heads.has(pick[0].key)) {
        // the first request of all is made alone: how long it takes tells whether the link is slow
        const t0 = now();
        const first = await readOne(pick[0], signal);
        // a failed first request that is not an HTTP answer (a missing file, a refusal) means the archive cannot be reached
        if (first === null && skipped.failed && /** @type {any} */ (lastFailure)?.code !== 'http') throw new StateError('unreachable');
        if (first !== null || heads.size) firstRequestMs = now() - t0;
        firstDone = true;
        got = [first, ...(await Promise.all(pick.slice(1).map((f) => readOne(f, signal))))];
      } else {
        got = await Promise.all(pick.map((f) => readOne(f, signal)));
      }
      return /** @type {{frame: Frame, item: Item}[]} */ (got.filter(Boolean));
    };

    for (const [ia, ib] of tries) {
      const a = await readVisit(visits[ia]), b = await readVisit(visits[ib]);
      if (!a.length || !b.length) continue;
      /** @type {Matchable[]} */
      const ma = a.map((x) => ({ det: x.item.det, lam: x.item.lam, bw: x.item.bw }));
      /** @type {Matchable[]} */
      const mb = b.map((x) => ({ det: x.item.det, lam: x.item.lam, bw: x.item.bw }));
      const idx = rules.matchPairs(ma, mb).filter(([i, j]) => a[i] && b[j]);
      if (!idx.length) continue;
      /** @type {[Frame, Frame][]} */
      const pairs = idx.map(([i, j]) => [a[i].frame, b[j].frame]);
      /** @type {[Item, Item][]} */
      const loads = idx.map(([i, j]) => [a[i].item, b[j].item]);
      const slow = opts.slow ?? ((firstRequestMs ?? 0) > slowFirstMs || dataSaver());
      /** @type {LivePart} */
      const full = { visits, pairs, loads, det: /** @type {Det} */ (det), ra, dec, n, ...cost(pairs.length * 2, n, slow) };
      if (!slow || pairs.length < 2) return { ...full, visitPair: [ia, ib], slow, more: null, firstRequestMs, skipped };
      /** @type {LivePart} */
      const first = { ...full, pairs: pairs.slice(0, 1), loads: loads.slice(0, 1), ...cost(2, n, slow) };
      /** @type {LivePart} */
      const rest = { ...full, pairs: pairs.slice(1), loads: loads.slice(1), ...cost((pairs.length - 1) * 2, n, slow) };
      return { ...first, visitPair: [ia, ib], slow, more: rest, firstRequestMs, skipped };
    }
    throw new StateError(skipped.failed && !heads.size ? 'unreachable' : 'no-coverage');
  }

  /** @param {Item} it @param {number} n @param {boolean} withFlags */
  const cacheKey = (it, n, withFlags) => `${it.key}|${it.x0},${it.y0}|${n}|${withFlags ? 'f' : 'i'}`;

  /**
   * @param {LivePart} p
   * @param {LoadOptions} [opts]
   * @returns {Promise<Stamp[] | Failure | {state: 'cancelled'}>}
   */
  async function load(p, opts = {}) {
    try {
      return await loadInner(p, opts);
    } catch (e) {
      return fail(e);
    }
  }

  /** @param {LivePart} p @param {LoadOptions} opts @returns {Promise<Stamp[]>} */
  async function loadInner(p, opts) {
    const { onProgress, signal } = opts, withFlags = opts.flags ?? true, n = p.n;
    if (signal?.aborted) throw new StateError('cancelled');
    const t0 = now(), total = p.loads.length * 2;
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal?.addEventListener('abort', stop, { once: true });
    let done = 0, bytes = 0;
    /** @type {Set<number>} */
    const pairDone = new Set();
    /** @type {number[]} */
    const frameDone = p.loads.map(() => 0);

    /** @param {Item} it @param {number} turn @param {number} k  @returns {Promise<Stamp>} */
    async function one(it, turn, k) {
      const ck = cacheKey(it, n, withFlags);
      let cached = false, got;
      const hit = cache ? await cache.get(ck).catch(() => undefined) : undefined;
      if (hit) { got = hit; cached = true; }
      else {
        const r = await readStamp(getter(it.key, turn, ac.signal), it, { x: 0, y: 0, x0: it.x0, y0: it.y0, tx: it.tx, ty: it.ty, n, inside: true }, { flags: withFlags, prio: k });
        bytes += r.bytes;
        got = { data: r.data, flags: r.flags };
        if (r.flagsError) onProgress?.({ type: 'warning', key: it.key, what: `FLAGS not read: ${r.flagsError}` });
        else if (cache) cache.put(ck, got).catch(() => {});
      }
      done++;
      frameDone[k]++;
      const completed = frameDone[k] === 2 && !pairDone.has(k) ? (pairDone.add(k), k) : null;
      onProgress?.({ type: 'stamp', done, total, bytes, ms: now() - t0, key: it.key, cached, pair: completed });
      return { key: it.key, det: it.det, mjd: it.mjd, w: n, h: n, x0: it.x0, y0: it.y0, tx: it.tx, ty: it.ty, lam: it.lam, bw: it.bw, data: got.data, flags: got.flags };
    }

    const tasks = p.loads.map(([a, b], k) => Promise.allSettled([one(a, 2 * k, k), one(b, 2 * k + 1, k)]));
    try {
      if (!tasks.length) return [];
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), budgetMs); });
      const first = await Promise.race([tasks[0], late]);
      clearTimeout(timer);
      if (first === 'slow') throw new StateError('slow');
      if (signal?.aborted) throw new StateError('cancelled');
      const f0 = /** @type {PromiseSettledResult<Stamp>[]} */ (first);
      if (f0.some((r) => r.status === 'rejected')) {
        const why = /** @type {PromiseRejectedResult} */ (f0.find((r) => r.status === 'rejected')).reason;
        if (isAbort(why)) throw new StateError('cancelled');
        throw why;
      }
      /** @type {Stamp[]} */
      const out = f0.map((r) => /** @type {PromiseFulfilledResult<Stamp>} */ (r).value);
      if (tasks.length > 1 && now() - t0 > firstPairSlowMs) {
        ac.abort(); // the link is slow: keep the first pair and hand the rest back
        const rest = { ...p, loads: p.loads.slice(1), pairs: p.pairs.slice(1), ...cost((p.loads.length - 1) * 2, n, true) };
        onProgress?.({ type: 'more', plan: rest });
        return out;
      }
      const others = await Promise.all(tasks.slice(1));
      if (signal?.aborted) throw new StateError('cancelled');
      for (const r of others) {
        if (r.every((x) => x.status === 'fulfilled')) out.push(...r.map((x) => /** @type {PromiseFulfilledResult<Stamp>} */ (x).value));
        else {
          const bad = /** @type {PromiseRejectedResult | undefined} */ (r.find((x) => x.status === 'rejected'));
          onProgress?.({ type: 'warning', key: '', what: `a pair was not loaded: ${bad?.reason?.message ?? bad?.reason}` });
        }
      }
      return out;
    } finally {
      signal?.removeEventListener('abort', stop);
      if (!ac.signal.aborted) ac.abort(); // nothing is left running
    }
  }

  return { plan, load };
}

/** The browser's own hint that the link is slow or that the person asked to save data. */
function defaultDataSaver() {
  try {
    const c = /** @type {any} */ (globalThis.navigator)?.connection;
    return Boolean(c && (c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType)));
  } catch {
    return false;
  }
}
