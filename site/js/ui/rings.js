// The rings of known fast stars: where each star of data/gaia/fast.json, and each named fast target that Gaia does
// not hold, should be in a picture, on the date of that
// picture. A star that moves half an arcsec a year or more is not where its catalogue entry says, so a ring is drawn
// at the place the star has reached, and a blip that sits in a ring is that star.
//
// The positions come from propagate() in lib/gaia.js (proper motion, radial velocity, parallax). The picture is on the
// display grid: it carries `sky`, the position of its target pixel and what one pixel step does (see hover.js).
// This file has no need of a page.

/** @import { CatalogueStar } from '../lib/gaia.js' */
/** @import { LocalSky } from './stage.js' */
import { epochToMjd, propagate } from '../lib/gaia.js';
import { tangentOffset } from './hover.js';

export const FAST_FILE = 'data/gaia/fast.json';

/**
 * A star of the fast list.
 * @typedef {CatalogueStar & {id: string, name: string, g: number | null, arcsecPerYear: number}} FastStar
 */

/**
 * A ring: where a fast star is in the picture on the date asked.
 * @typedef {Object} Ring
 * @property {number} x  Pixel of the picture, whole numbers at pixel centres; may be a fraction.
 * @property {number} y
 * @property {number} ra  Degrees, on that date.
 * @property {number} dec
 * @property {string} id  Gaia DR3 source id, as text.
 * @property {string} name
 * @property {number | null} g  Gaia G magnitude.
 * @property {number} arcsecPerYear  How far it moves a year.
 */

/** Stars the rings are drawn from, set by loadFast / useStars. @type {FastStar[]} */
let catalogue = [];

/**
 * The stars of fast.json as a list. A row is [source_id, ra, dec, pmra, pmdec, parallax, g], the epoch is the file's.
 * Anything that is not that shape gives an empty list.
 * @param {any} doc
 * @returns {FastStar[]}
 */
export function parseFast(doc) {
  const rows = Array.isArray(doc?.stars) ? doc.stars : [];
  const epoch = Number.isFinite(doc?.epoch) ? doc.epoch : 2016;
  /** @type {FastStar[]} */
  const out = [];
  for (const r of rows) {
    const s = Array.isArray(r)
      ? { id: String(r[0]), ra: r[1], dec: r[2], pmra: r[3], pmdec: r[4], parallax: r[5], g: r[6] ?? null }
      : { id: String(r?.source_id ?? r?.id), ra: r?.ra, dec: r?.dec, pmra: r?.pmra, pmdec: r?.pmdec, parallax: r?.parallax, g: r?.g ?? null };
    if (![s.ra, s.dec, s.pmra, s.pmdec, s.parallax].every(Number.isFinite) || !(s.parallax > 0)) continue;
    out.push({ ...s, epoch, name: `Gaia DR3 ${s.id}`, arcsecPerYear: Math.hypot(s.pmra, s.pmdec) / 1000 });
  }
  return out;
}

/**
 * Give the stars the names of the named targets: an entry of names.json that carries a catalogue source "Gaia DR3 <id>"
 * lends its name to that star, and its radial velocity (fast.json has none).
 * @param {FastStar[]} stars
 * @param {{name?: string, catalogue?: {source?: string, rv?: number | null} | null}[]} entries  `entries` of names.json.
 * @returns {FastStar[]}
 */
export function nameStars(stars, entries) {
  /** @type {Map<string, {name: string, rv: number | null}>} */
  const known = new Map();
  for (const e of entries ?? []) {
    const m = /Gaia DR3 (\d+)/.exec(e?.catalogue?.source ?? '');
    if (m && e.name) known.set(m[1], { name: e.name, rv: Number.isFinite(e.catalogue?.rv) ? /** @type {number} */ (e.catalogue?.rv) : null });
  }
  return stars.map((s) => {
    const k = known.get(s.id);
    return k ? { ...s, name: k.name, rv: k.rv ?? s.rv } : s;
  });
}

/**
 * The named fast targets that carry their own catalogue astrometry and no Gaia id (WISE 0855 is not in Gaia): each
 * is a star of the list under its own name. A target with a Gaia source is named by nameStars instead.
 * @param {{id?: string, name?: string, fast?: boolean, catalogue?: {ra?: number, dec?: number, epoch?: number, pmra?: number, pmdec?: number, parallax?: number, rv?: number | null, source?: string} | null}[]} entries  `entries` of names.json.
 * @returns {FastStar[]}
 */
export function namedStars(entries) {
  /** @type {FastStar[]} */
  const out = [];
  for (const e of entries ?? []) {
    const c = e?.catalogue;
    if (!e?.fast || !e.id || !e.name || !c || /Gaia DR3 \d+/.test(c.source ?? '')) continue;
    const { ra, dec, epoch, pmra, pmdec, parallax } = c;
    if (ra === undefined || dec === undefined || epoch === undefined || pmra === undefined || pmdec === undefined || parallax === undefined) continue;
    if (![ra, dec, epoch, pmra, pmdec, parallax].every(Number.isFinite) || !(parallax > 0)) continue;
    out.push({ id: e.id, name: e.name, g: null, ra, dec, epoch, pmra, pmdec, parallax, rv: Number.isFinite(c.rv) ? c.rv : null, arcsecPerYear: Math.hypot(pmra, pmdec) / 1000 });
  }
  return out;
}

/**
 * Use these stars for every ringsFor call that is not given its own.
 * @param {FastStar[]} stars
 */
export function useStars(stars) {
  catalogue = stars;
}

/** The stars in use. */
export const currentStars = () => catalogue;

/**
 * Fetch fast.json (and names.json, for the names) and use what is in them. Empty when the file is not there: the
 * rings are then simply not drawn.
 * @param {string} [base]  Address of the site's top folder, ending in "/". @param {typeof fetch} [fetchFn]
 * @returns {Promise<FastStar[]>}
 */
export async function loadFast(base = '', fetchFn = globalThis.fetch) {
  try {
    const r = await fetchFn(base + FAST_FILE);
    if (!r.ok) return [];
    let stars = parseFast(await r.json());
    try {
      const n = await fetchFn(`${base}data/names.json`);
      if (n.ok) {
        const entries = (await n.json()).entries;
        stars = [...nameStars(stars, entries), ...namedStars(entries)];
      }
    } catch { /* the stars keep their Gaia names */ }
    useStars(stars);
    return stars;
  } catch {
    return [];
  }
}

/**
 * The pixel of a picture at a sky position: the inverse of skyAt in hover.js.
 * @param {LocalSky} sky
 * @param {number} tx  The target's x in the picture. @param {number} ty
 * @param {number} ra @param {number} dec  Degrees.
 * @returns {[number, number]}  [x, y]; NaN when the transform cannot be turned round.
 */
export function skyToPixel(sky, tx, ty, ra, dec) {
  const [east, north] = tangentOffset(sky.ra, sky.dec, ra, dec);
  const [a, b, c, d] = sky.cd, det = a * d - b * c;
  if (!(Math.abs(det) > 0)) return [NaN, NaN];
  return [tx + (d * east - b * north) / det, ty + (-c * east + a * north) / det];
}

/**
 * The fast stars that fall in a picture on a date, where they are on that date.
 * @param {Object} q
 * @param {LocalSky} q.sky  The sky of the picture.
 * @param {number} q.mjd  Date of the picture, MJD.
 * @param {number | {w: number, h: number}} q.size  Pixels along a side of a square picture, or its width and height.
 * @param {number} [q.tx]  Where the target is in the picture; default the middle of it (size / 2).
 * @param {number} [q.ty]
 * @param {number} [q.margin]  How far outside the picture a ring may be centred and still be wanted, pixels. Default 2.
 * @param {FastStar[]} [q.stars]  Default: the stars in use.
 * @returns {Ring[]}
 */
export function ringsFor({ sky, mjd, size, tx, ty, margin = 2, stars = catalogue }) {
  if (!sky || !Array.isArray(sky.cd) || !Number.isFinite(mjd)) return [];
  const w = typeof size === 'number' ? size : size.w, h = typeof size === 'number' ? size : size.h;
  const cx = tx ?? w / 2, cy = ty ?? h / 2;
  const [a, b, c, d] = sky.cd;
  // a quick cut: the picture's reach on the sky, in degrees, and a straight-line guess of each star
  const reach = Math.max(Math.hypot(a * w, c * w) + Math.hypot(b * h, d * h), 1e-4) + 0.02;
  const cosd = Math.cos((sky.dec * Math.PI) / 180);
  /** @type {Ring[]} */
  const out = [];
  for (const s of stars) {
    const dt = (mjd - epochToMjd(s.epoch)) / 365.25;
    const dec = s.dec + (s.pmdec / 3.6e6) * dt;
    if (Math.abs(dec - sky.dec) > reach) continue;
    const ra = s.ra + (s.pmra / 3.6e6 / Math.max(Math.cos((s.dec * Math.PI) / 180), 1e-6)) * dt;
    if (Math.abs((((ra - sky.ra + 540) % 360) - 180) * cosd) > reach) continue;
    const [pra, pdec] = propagate(s, mjd);
    const [x, y] = skyToPixel(sky, cx, cy, pra, pdec);
    if (!(x >= -margin && x <= w - 1 + margin && y >= -margin && y <= h - 1 + margin)) continue;
    out.push({ x, y, ra: pra, dec: pdec, id: s.id, name: s.name, g: s.g ?? null, arcsecPerYear: s.arcsecPerYear });
  }
  return out;
}
