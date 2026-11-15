// Helpers for tests that use the files under tests/fixtures/.
// See tests/fixtures/README.md for what each fixture is and where it came from.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** The two address forms of the archive bucket. A frame's URL is one of these followed by its key. */
const HOSTS = [
  'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
  'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
];

/** @param {...string} parts */
export const fixturePath = (...parts) => path.join(FIXTURES, ...parts);

/** @param {...string} parts */
export const readJson = (...parts) => JSON.parse(readFileSync(fixturePath(...parts), 'utf8'));

/** @param {...string} parts */
export const readBytes = (...parts) => new Uint8Array(readFileSync(fixturePath(...parts)));

/** A little-endian float32 file as a Float32Array. @param {...string} parts */
export function readFloat32(...parts) {
  const b = readBytes(...parts), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = v.getFloat32(i * 4, true);
  return out;
}

/** A little-endian int32 file as an Int32Array. @param {...string} parts */
export function readInt32(...parts) {
  const b = readBytes(...parts), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Int32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt32(i * 4, true);
  return out;
}

/** The ids of the frame fixtures (folder names under tests/fixtures/frames/). */
export const FRAME_IDS = ['barnard-d2', 'eps-indi-d4', 'eps-indi-d5'];

/**
 * One frame fixture: its description (frame.json), the expected stamp arrays and the recorded byte ranges.
 * `data` and `flags` are the expected CT-4 arrays (row-major, first row at the lowest y).
 * @param {string} id
 */
export function loadFrame(id) {
  const meta = readJson('frames', id, 'frame.json');
  return {
    id,
    meta,
    data: readFloat32('frames', id, meta.expected.data),
    flags: readInt32('frames', id, meta.expected.flags),
    ranges: meta.ranges.map((/** @type {{start: number, end: number, file: string}} */ r) => ({
      start: r.start, end: r.end, bytes: readBytes('frames', id, r.file),
    })),
  };
}

/**
 * A stand-in for `fetch` that answers byte-range requests for the fixture frames from the recorded bytes, and
 * nothing else. Both address forms of the bucket are accepted. A request without a Range header, for another
 * address, or for bytes that were not recorded throws, so a test notices at once.
 *
 * The returned function carries what it saw:
 *   .calls        [{url, host, key, start, end}] in request order
 *   .bytes        total bytes served
 *   .maxInFlight  {host: the largest number of requests that were open at the same time}
 *
 * @param {ReturnType<typeof loadFrame>[]} frames
 * @param {{delayMs?: number}} [options] delayMs: how long each answer is held back (default 0, one timer tick)
 */
export function rangeFetch(frames, { delayMs = 0 } = {}) {
  const byKey = new Map(frames.map((f) => [f.meta.key, f]));
  /** @type {Record<string, number>} */
  const open = {};

  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  async function fetchRange(input, init = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const base = HOSTS.find((h) => url.startsWith(h));
    if (!base) throw new Error(`rangeFetch: not a bucket address: ${url}`);
    const key = url.slice(base.length), host = new URL(url).host;
    const frame = byKey.get(key);
    if (!frame) throw new Error(`rangeFetch: no fixture for ${key}`);
    const headers = new Headers(init.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
    const m = /^bytes=(\d+)-(\d+)$/.exec(headers.get('range') ?? '');
    if (!m) throw new Error(`rangeFetch: a request needs "Range: bytes=a-b" (got ${headers.get('range')}) for ${key}`);
    const start = Number(m[1]), end = Number(m[2]);
    const r = frame.ranges.find((x) => x.start <= start && end <= x.end);
    if (!r || end < start) {
      const have = frame.ranges.map((x) => `${x.start}-${x.end}`).join(', ');
      throw new Error(`rangeFetch: bytes ${start}-${end} of ${frame.id} were not recorded (recorded: ${have})`);
    }
    fetchRange.calls.push({ url, host, key, start, end });
    open[host] = (open[host] ?? 0) + 1;
    fetchRange.maxInFlight[host] = Math.max(fetchRange.maxInFlight[host] ?? 0, open[host]);
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const body = r.bytes.slice(start - r.start, end - r.start + 1);
      fetchRange.bytes += body.length;
      return new Response(body, {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': String(body.length),
          'content-range': `bytes ${start}-${end}/${frame.meta.size}`,
          'content-type': 'binary/octet-stream',
        },
      });
    } finally {
      open[host] -= 1;
    }
  }
  /** @type {{url: string, host: string, key: string, start: number, end: number}[]} */
  fetchRange.calls = [];
  fetchRange.bytes = 0;
  /** @type {Record<string, number>} */
  fetchRange.maxInFlight = {};
  return fetchRange;
}
