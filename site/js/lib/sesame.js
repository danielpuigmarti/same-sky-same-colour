// Names that are not in this site's own list (data/names.json): the name resolver Sesame of the Centre de Données
// astronomiques de Strasbourg (CDS) turns a name into a position by asking SIMBAD and, for what SIMBAD does not
// know, NED. A page may call it: its answers carry the header that lets another site read them.
//
// Only the addresses listed here are asked, and a redirect to any other address is refused, so the visitor's
// browser never talks to a host this file does not name. What is sent is the name that was typed, nothing else.
// When no address answers, the caller says so and asks for coordinates: the page never depends on this service.
//
// SIMBAD gives the position of a star for the year 2000, with its motion. A star that moves is moved to the epoch
// of the site's own list (gaia.js), so that a fast star is found where it is in these photos.

/** @import { CatalogueStar } from './gaia.js' */
import { epochToMjd, propagate, separationDeg } from './gaia.js';

/**
 * The addresses of the resolver, tried in this order; the name is appended, percent-encoded. "-o" asks for the plain
 * answer, "SN" for SIMBAD, then NED.
 */
export const SESAME_URLS = Object.freeze([
  'https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-o/SN?',
  'https://cds.unistra.fr/cgi-bin/nph-sesame/-o/SN?',
]);

/** How long one address may take to answer, ms. */
export const SESAME_TIMEOUT_MS = 6000;
/** The longest name that is sent. */
export const SESAME_MAX_NAME = 80;
/** The year the positions of the resolver are given for. */
export const SESAME_EPOCH = 2000;

/**
 * What an answer of the resolver says.
 * @typedef {Object} SesameAnswer
 * @property {number} ra  Degrees (ICRS), for the year 2000.
 * @property {number} dec
 * @property {number | null} pmra  Motion in RA times cos(dec), mas/yr; null when the answer has none.
 * @property {number | null} pmdec
 * @property {number | null} parallax  mas.
 * @property {number | null} rv  km/s.
 * @property {string} by  Which catalogue answered: "Simbad" or "NED"; empty when the answer does not say.
 */

/**
 * @typedef {{ok: true, name: string, ra: number, dec: number, by: string, movedArcsec: number, epoch: number}
 *   | {ok: false, reason: 'not-found' | 'unreachable' | 'not-a-name'}} Resolved
 * `ra`, `dec`: where the object is at `epoch`. `movedArcsec`: how far that is from its position in 2000.
 */

/**
 * Read the plain answer of the resolver. Null when it holds no position (the name is not known).
 * @param {string} text
 * @returns {SesameAnswer | null}
 */
export function parseSesame(text) {
  /** @type {SesameAnswer | null} */
  let out = null;
  let by = '';
  for (const line of String(text).split(/\r?\n/)) {
    const who = /^#=\w*=?\s*(Simbad|NED|VizieR)/i.exec(line);
    if (who && !out) by = who[1];
    if (out && /^#=/.test(line)) break; // the next catalogue: the first one that answered is the answer
    const pos = /^%J\s+([+-]?\d+(?:\.\d*)?)\s+([+-]?\d+(?:\.\d*)?)/.exec(line);
    if (pos && !out) {
      const ra = Number(pos[1]), dec = Number(pos[2]);
      if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) out = { ra, dec, pmra: null, pmdec: null, parallax: null, rv: null, by };
      continue;
    }
    if (!out) continue;
    const pm = /^%P\s+([+-]?\d+(?:\.\d*)?)\s+([+-]?\d+(?:\.\d*)?)/.exec(line);
    if (pm) { out.pmra = Number(pm[1]); out.pmdec = Number(pm[2]); }
    const plx = /^%X\s+([+-]?\d+(?:\.\d*)?)/.exec(line);
    if (plx) out.parallax = Number(plx[1]);
    const rv = /^%V\s+v\s+([+-]?\d+(?:\.\d*)?)/.exec(line);
    if (rv) out.rv = Number(rv[1]);
  }
  return out;
}

/**
 * Where the object of an answer is at an epoch: its position of 2000 moved by its motion. Without a motion it
 * stays where it is.
 * @param {SesameAnswer} answer
 * @param {number} epoch  Julian year.
 * @returns {{ra: number, dec: number, movedArcsec: number}}
 */
export function positionAt(answer, epoch) {
  if (answer.pmra === null || answer.pmdec === null || !Number.isFinite(answer.pmra) || !Number.isFinite(answer.pmdec)) {
    return { ra: answer.ra, dec: answer.dec, movedArcsec: 0 };
  }
  /** @type {CatalogueStar} */
  const star = {
    ra: answer.ra, dec: answer.dec, epoch: SESAME_EPOCH, pmra: answer.pmra, pmdec: answer.pmdec,
    // an object without a measured distance is far away: its motion on the sky is all there is
    parallax: answer.parallax !== null && answer.parallax > 0 ? answer.parallax : 1e-3,
    rv: answer.rv,
  };
  const [ra, dec] = propagate(star, epochToMjd(epoch), { parallax: false });
  return { ra, dec, movedArcsec: separationDeg(answer.ra, answer.dec, ra, dec) * 3600 };
}

/**
 * True for text that can be sent as a name: not empty, not too long, with a letter in it, and not an attempt at a
 * position. A position that cannot be read (an hour above 24, a part missing) is still a position: its only letters
 * are the words "ra", "dec" and "deg", an exponent, or two or more of h, m, s and d after a number. The reader of
 * positions has a plain answer for those, and nothing is sent.
 * @param {string} text
 */
export function looksLikeName(text) {
  const t = String(text ?? '').trim();
  if (t.length === 0 || t.length > SESAME_MAX_NAME || !/\p{L}/u.test(t)) return false;
  let units = 0;
  const rest = t
    .replace(/\b(?:ra|dec|deg)\b/giu, ' ')
    .replace(/(\d)e(?=[+-]?\d)/giu, '$1')
    .replace(/(\d)\s*[hmsd](?!\p{L})/giu, (_, digit) => { units++; return digit; });
  return /\p{L}/u.test(rest) || units === 1;
}

/**
 * Ask the resolver for a name. A failure is a result, never an exception.
 * @param {string} name
 * @param {{fetch?: typeof fetch, urls?: readonly string[], timeoutMs?: number, epoch?: number}} [options]
 *   `epoch`: the year the position is wanted for (default 2026, the epoch of data/names.json).
 * @returns {Promise<Resolved>}
 */
export async function resolveName(name, { fetch: fetchFn = globalThis.fetch, urls = SESAME_URLS, timeoutMs = SESAME_TIMEOUT_MS, epoch = 2026 } = {}) {
  const text = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!looksLikeName(text)) return { ok: false, reason: 'not-a-name' };
  let answered = false;
  for (const url of urls) {
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), timeoutMs);
    try {
      // a redirect is refused: the answer comes from the address that was asked, or not at all
      const r = await fetchFn(url + encodeURIComponent(text), { redirect: 'error', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: stop.signal });
      if (!r.ok) continue;
      const body = await r.text();
      if (!/^#/.test(body)) continue; // not an answer of the resolver
      answered = true;
      const answer = parseSesame(body);
      if (!answer) return { ok: false, reason: 'not-found' };
      return { ok: true, name: text, by: answer.by, epoch, ...positionAt(answer, epoch) };
    } catch {
      // this address cannot be reached: the next one is tried
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: answered ? 'not-found' : 'unreachable' };
}
