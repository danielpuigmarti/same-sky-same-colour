// A showcase (CT-8) as stamps (CT-4): manifest.json with stamps.bin and flags.bin beside it becomes the same
// list of stamps that a live position gives, so one stage shows both.
//
// The binary files are little-endian, the frames in the order of the manifest, each frame w*h values row by row
// with the first row at the lowest y: float32 for the image (MJy/sr), int32 for the flag words.

/** @import { Manifest, Stamp, Pair, LocalSky } from '../contracts.js' */
import { MANIFEST_FILE, STAMPS_FILE, FLAGS_FILE } from '../contracts.js';
import { TARGET_PATTERN } from './urlstate.js';

/** The group of a target that names none: data/targets/<id>/. */
export const DEFAULT_GROUP = 'targets';

/**
 * The folder of a showcase inside the site, for the `t` of an address: "barnard" is data/targets/barnard/,
 * "falsepos/ghost" is data/falsepos/ghost/. Null when `t` cannot be a target.
 * @param {string} t
 * @returns {string | null}
 */
export function showcaseFolder(t) {
  if (typeof t !== 'string' || !TARGET_PATTERN.test(t)) return null;
  return `data/${t.includes('/') ? t : `${DEFAULT_GROUP}/${t}`}/`;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Four-byte values of a little-endian file.
 * @template {Float32Array | Int32Array} T
 * @param {ArrayBuffer | Uint8Array} bytes
 * @param {new (buffer: ArrayBuffer) => T} Type
 * @param {(view: DataView, at: number) => number} read
 * @returns {T}
 */
function fourByteValues(bytes, Type, read) {
  // a copy that starts at byte 0 of its own buffer, whatever was handed in
  const own = bytes instanceof Uint8Array
    ? /** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    : bytes.slice(0);
  const out = new Type(own);
  if (!LITTLE_ENDIAN) {
    const view = new DataView(own.slice(0));
    for (let i = 0; i < out.length; i++) out[i] = read(view, i * 4);
  }
  return out;
}

/**
 * What is wrong with a manifest, in words; an empty list when it can be used. This is the part of CT-8 that the
 * page depends on, not the whole schema.
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestProblems(manifest) {
  const m = /** @type {any} */ (manifest);
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return ['the manifest is not an object'];
  /** @type {string[]} */
  const out = [];
  const whole = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) > 0;
  if (typeof m.id !== 'string' || typeof m.name !== 'string') out.push('id and name must be text');
  if (!Number.isFinite(m.ra) || !Number.isFinite(m.dec)) out.push('ra and dec must be numbers');
  if (!Number.isInteger(m.det) || m.det < 1 || m.det > 6) out.push('det must be 1 to 6');
  if (!whole(m.w) || !whole(m.h)) out.push('w and h must be whole numbers above 0');
  if (m.stamps !== STAMPS_FILE) out.push(`stamps must be "${STAMPS_FILE}"`);
  if (m.flags !== null && m.flags !== FLAGS_FILE) out.push(`flags must be "${FLAGS_FILE}" or null`);
  if (!Array.isArray(m.frames) || m.frames.length === 0) out.push('frames must be a list with at least one frame');
  else {
    for (const [i, f] of m.frames.entries()) {
      const ok = f && typeof f === 'object' && typeof f.key === 'string'
        && ['mjd', 'lam', 'bw', 'x0', 'y0', 'tx', 'ty'].every((k) => Number.isFinite(f[k]))
        && Number.isInteger(f.visit) && f.visit >= 0;
      if (!ok) out.push(`frames[${i}] lacks a field`);
    }
  }
  if (!Array.isArray(m.pairs)) out.push('pairs must be a list');
  else if (Array.isArray(m.frames)) {
    for (const [k, p] of m.pairs.entries()) {
      const ok = Array.isArray(p) && p.length === 2 && p.every((i) => Number.isInteger(i) && i >= 0 && i < m.frames.length) && p[0] !== p[1];
      if (!ok) out.push(`pairs[${k}] does not name two frames`);
    }
  }
  return out;
}

/**
 * The sky of a frame of a manifest, when it has one that can be used: a position and four numbers.
 * @param {unknown} sky
 * @returns {LocalSky | null}
 */
function frameSky(sky) {
  const s = /** @type {{ra?: unknown, dec?: unknown, cd?: unknown} | null} */ (sky);
  if (s === null || typeof s !== 'object' || !Number.isFinite(s.ra) || !Number.isFinite(s.dec)) return null;
  if (!Array.isArray(s.cd) || s.cd.length !== 4 || !s.cd.every(Number.isFinite)) return null;
  return { ra: /** @type {number} */ (s.ra), dec: /** @type {number} */ (s.dec), cd: [s.cd[0], s.cd[1], s.cd[2], s.cd[3]] };
}

/**
 * The stamps of a showcase, in the order of its frames. The arrays of the stamps are parts of one array each for
 * image and flags: nothing is copied per stamp, and no value is changed. A frame that carries `sky` hands it to
 * its stamp; a stamp of a frame without one has no `sky`.
 * @param {Manifest} manifest
 * @param {ArrayBuffer | Uint8Array} stampsBytes  The bytes of stamps.bin.
 * @param {ArrayBuffer | Uint8Array | null} [flagsBytes]  The bytes of flags.bin, or null when the manifest names none.
 * @returns {Stamp[]}
 */
export function decodeShowcase(manifest, stampsBytes, flagsBytes = null) {
  const problems = manifestProblems(manifest);
  if (problems.length) throw new Error(`showcase: ${problems.join('; ')}`);
  const n = manifest.w * manifest.h, want = manifest.frames.length * n * 4;
  if (stampsBytes.byteLength !== want) throw new Error(`showcase: ${STAMPS_FILE} has ${stampsBytes.byteLength} bytes, expected ${want}`);
  if (manifest.flags !== null) {
    if (!flagsBytes) throw new Error(`showcase: the manifest names ${FLAGS_FILE} and none was given`);
    if (flagsBytes.byteLength !== want) throw new Error(`showcase: ${FLAGS_FILE} has ${flagsBytes.byteLength} bytes, expected ${want}`);
  }
  const data = fourByteValues(stampsBytes, Float32Array, (v, at) => v.getFloat32(at, true));
  const flags = manifest.flags !== null && flagsBytes ? fourByteValues(flagsBytes, Int32Array, (v, at) => v.getInt32(at, true)) : null;
  return manifest.frames.map((f, i) => {
    const sky = frameSky(f.sky);
    return {
      key: f.key,
      det: manifest.det,
      mjd: f.mjd,
      w: manifest.w,
      h: manifest.h,
      x0: f.x0,
      y0: f.y0,
      tx: f.tx,
      ty: f.ty,
      lam: f.lam,
      bw: f.bw,
      data: data.subarray(i * n, (i + 1) * n),
      flags: flags ? flags.subarray(i * n, (i + 1) * n) : null,
      ...(sky ? { sky } : {}),
    };
  });
}

/**
 * The visits of a showcase, earliest first.
 * @typedef {Object} ShowcaseVisit
 * @property {number} visit  The number the manifest gives it: 0 for the earliest.
 * @property {number[]} frames  Positions in `manifest.frames`, in time order.
 * @property {number} mjd  Mid-exposure time of its first frame, MJD (UTC).
 * @property {number} mjdLast  Mid-exposure time of its last frame.
 */

/**
 * @param {Manifest} manifest
 * @returns {ShowcaseVisit[]}
 */
export function showcaseVisits(manifest) {
  /** @type {Map<number, ShowcaseVisit>} */
  const byVisit = new Map();
  for (const [i, f] of manifest.frames.entries()) {
    const v = byVisit.get(f.visit);
    if (v) {
      v.frames.push(i);
      v.mjd = Math.min(v.mjd, f.mjd);
      v.mjdLast = Math.max(v.mjdLast, f.mjd);
    } else byVisit.set(f.visit, { visit: f.visit, frames: [i], mjd: f.mjd, mjdLast: f.mjd });
  }
  return [...byVisit.values()].sort((p, q) => p.visit - q.visit);
}

/**
 * The matched pairs of a showcase whose first frame is in visit `a` and whose second is in visit `b`.
 * @param {Manifest} manifest
 * @param {number} a  Visit number of the earlier side.
 * @param {number} b  Visit number of the later side.
 * @returns {Pair[]}
 */
export function pairsBetween(manifest, a, b) {
  return manifest.pairs.filter(([i, j]) => manifest.frames[i].visit === a && manifest.frames[j].visit === b);
}

/**
 * The two visits a showcase opens with: the two with the most matched pairs between them and, among equals, the
 * two farthest apart in time. Null when no pair of visits has a matched pair.
 * @param {Manifest} manifest
 * @returns {[number, number] | null}  Visit numbers, the earlier first.
 */
export function defaultVisits(manifest) {
  const visits = showcaseVisits(manifest);
  /** @type {{pair: [number, number], n: number, gap: number} | null} */
  let best = null;
  for (const a of visits) {
    for (const b of visits) {
      if (!(a.visit < b.visit)) continue;
      const n = pairsBetween(manifest, a.visit, b.visit).length, gap = b.mjd - a.mjd;
      if (n > 0 && (best === null || n > best.n || (n === best.n && gap > best.gap))) best = { pair: [a.visit, b.visit], n, gap };
    }
  }
  return best ? best.pair : null;
}

/**
 * What loading a showcase gives. `missing`: there is no such showcase. `unreachable`: the files could not be
 * fetched. `invalid`: the files are there and cannot be used; `detail` says why.
 * @typedef {{ok: true, manifest: Manifest, stamps: Stamp[]}
 *   | {ok: false, reason: 'missing' | 'unreachable' | 'invalid', detail: string}} ShowcaseResult
 */

/**
 * Fetch a showcase and decode it. A failure is a result, never an exception.
 * @param {string | URL} folder  Address of the showcase folder, ending in "/".
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<ShowcaseResult>}
 */
export async function loadShowcase(folder, fetchFn = globalThis.fetch) {
  const base = String(folder);
  /** @param {string} name @returns {Promise<Response | 'missing' | 'unreachable'>} */
  const get = async (name) => {
    try {
      const r = await fetchFn(base + name);
      if (r.status === 404 || r.status === 410) return 'missing';
      return r.ok ? r : 'unreachable';
    } catch {
      return 'unreachable';
    }
  };
  /** @param {'missing' | 'unreachable' | 'invalid'} reason @param {string} detail @returns {ShowcaseResult} */
  const fail = (reason, detail) => ({ ok: false, reason, detail });

  const first = await get(MANIFEST_FILE);
  if (typeof first === 'string') return fail(first, `${MANIFEST_FILE}: ${first}`);
  /** @type {Manifest} */
  let manifest;
  try {
    manifest = await first.json();
  } catch {
    return fail('invalid', `${MANIFEST_FILE} is not JSON`);
  }
  const problems = manifestProblems(manifest);
  if (problems.length) return fail('invalid', problems.join('; '));

  const [stampsFile, flagsFile] = await Promise.all([get(STAMPS_FILE), manifest.flags === null ? null : get(FLAGS_FILE)]);
  if (typeof stampsFile === 'string') return fail(stampsFile === 'missing' ? 'invalid' : 'unreachable', `${STAMPS_FILE}: ${stampsFile}`);
  if (typeof flagsFile === 'string') return fail(flagsFile === 'missing' ? 'invalid' : 'unreachable', `${FLAGS_FILE}: ${flagsFile}`);
  try {
    const [stampsBytes, flagsBytes] = await Promise.all([stampsFile.arrayBuffer(), flagsFile ? flagsFile.arrayBuffer() : null]);
    return { ok: true, manifest, stamps: decodeShowcase(manifest, stampsBytes, flagsBytes) };
  } catch (e) {
    return fail('invalid', e instanceof Error ? e.message : String(e));
  }
}
