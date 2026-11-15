// The address of a view (CT-11): view.html?ra=&dec=&det=&mode=&a=&b=&fov=&t=&embed=1&pitch=1&q=
//
// parseAddress reads an address into a ViewAddress, formatAddress writes one back, and the two undo each other:
// parseAddress(formatAddress(x)) has the same fields with the same values as x, for every x that parseAddress
// can give. A part that is missing or makes no sense is left out; nothing here throws.
//
// `a` and `b` name the two visits that are compared. The viewer writes a visit as the UTC date of its first
// photo, YYYY-MM-DD (see visitId in ui/visitstrip.js); here they are only text, kept as written.
// `t` names a prepared target: "barnard" is the folder data/targets/barnard/, and "group/id" the folder
// data/group/id/ (see showcaseFolder in lib/showcase.js).
// `q` is what was typed in the box, as written: a name or a position that the viewer still has to read.
//
// One choice of the viewer is kept in the address beside CT-11: `smooth=1`, for "Smooth pixels". It changes how the
// pictures are enlarged on the screen and nothing else, and it is written last, after the parts of CT-11.
// Three more choices of how the pictures are drawn are kept the same way, in this order after `smooth`: `white=1` to
// `white=3` (the step of the white point; 0, the default, is left out), `speed=slow` or `speed=fast` (normal is left
// out) and `invert=1`.

/** @import { ViewAddress, ViewMode, Det } from '../contracts.js' */

/**
 * An address as this file reads and writes it: the parts of CT-11, and "Smooth pixels".
 * @typedef {ViewAddress & {smooth?: boolean, white?: number, speed?: 'slow' | 'fast', invert?: boolean}} Address
 */
import { VIEW_PAGE, VIEW_PARAMS, VIEW_MODES } from '../contracts.js';

/** What `t` may look like: a folder name, or two folder names with a slash between them. */
export const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)?$/;

/** The highest step of the white point that an address may name (the steps are WHITE_STEPS of ui/stage.js). */
const WHITE_MAX = 3;

/** The longest `a` or `b` that is kept. */
const SIDE_MAX = 64;

/** The longest `q` that is kept. */
export const TYPED_MAX = 200;

/** @param {string | null} text @returns {number | undefined} a finite number, or nothing */
function number(text) {
  if (text === null || text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read an address.
 * @param {string | URL | URLSearchParams} address  A whole address, its part from "?" on, or its parameters.
 * @returns {Address}
 */
export function parseAddress(address) {
  /** @type {URLSearchParams} */
  let q;
  if (address instanceof URLSearchParams) q = address;
  else if (address instanceof URL) q = address.searchParams;
  else {
    const noHash = address.split('#')[0];
    const at = noHash.indexOf('?');
    q = new URLSearchParams(at >= 0 ? noHash.slice(at + 1) : noHash.includes('=') ? noHash : '');
  }
  /** @type {Address} */
  const out = {};

  const ra = number(q.get('ra'));
  // any angle is a right ascension: 370 is 10; a value already from 0 up to 360 is kept to its last digit
  if (ra !== undefined) out.ra = ra >= 0 && ra < 360 ? ra + 0 : ((ra % 360) + 360) % 360;
  const dec = number(q.get('dec'));
  if (dec !== undefined && dec >= -90 && dec <= 90) out.dec = dec + 0; // "+ 0" turns -0 into 0, which is how it is written back
  const det = number(q.get('det'));
  if (det !== undefined && Number.isInteger(det) && det >= 1 && det <= 6) out.det = /** @type {Det} */ (det);
  const mode = q.get('mode');
  if (mode !== null && VIEW_MODES.includes(mode)) out.mode = /** @type {ViewMode} */ (mode);
  for (const side of /** @type {const} */ (['a', 'b'])) {
    const v = q.get(side);
    if (v !== null && v !== '' && v.length <= SIDE_MAX) out[side] = v;
  }
  const fov = number(q.get('fov'));
  if (fov !== undefined && fov > 0 && fov <= 180) out.fov = fov;
  const t = q.get('t');
  if (t !== null && TARGET_PATTERN.test(t)) out.t = t;
  if (q.get('embed') === '1') out.embed = true;
  if (q.get('pitch') === '1') out.pitch = true;
  const typed = q.get('q');
  if (typed !== null && typed.trim() !== '' && typed.length <= TYPED_MAX) out.q = typed;
  if (q.get('smooth') === '1') out.smooth = true;
  const white = number(q.get('white'));
  if (white !== undefined && Number.isInteger(white) && white >= 1 && white <= WHITE_MAX) out.white = white;
  const speed = q.get('speed');
  if (speed === 'slow' || speed === 'fast') out.speed = speed;
  if (q.get('invert') === '1') out.invert = true;
  return out;
}

/**
 * Write an address as the text that follows "?": the parts in the order of CT-11, absent parts left out.
 * Numbers are written so that reading them back gives the same number.
 * @param {Address} address
 * @returns {string}
 */
export function formatAddress(address) {
  const q = new URLSearchParams();
  for (const name of VIEW_PARAMS) {
    const v = /** @type {Record<string, unknown>} */ (address)[name];
    if (v === undefined || v === null || v === false || v === '') continue;
    q.set(name, v === true ? '1' : String(v));
  }
  if (address.smooth === true) q.set('smooth', '1');
  if (address.white !== undefined && Number.isInteger(address.white) && address.white >= 1 && address.white <= WHITE_MAX) q.set('white', String(address.white));
  if (address.speed === 'slow' || address.speed === 'fast') q.set('speed', address.speed);
  if (address.invert === true) q.set('invert', '1');
  // "/" in a target is safe in this part of an address and reads better as it is
  return q.toString().replace(/%2F/gi, '/');
}

/**
 * The address of the viewer for a view, relative to the folder of the site.
 * @param {Address} address
 * @param {string} [page]
 * @returns {string}
 */
export function viewUrl(address, page = VIEW_PAGE) {
  const q = formatAddress(address);
  return q ? `${page}?${q}` : page;
}
