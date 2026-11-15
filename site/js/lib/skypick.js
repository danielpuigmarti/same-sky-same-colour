// The clicked place in the address of the viewer: `at=<ra>,<dec>`, in degrees. It is a place on the sky and not a
// pixel, because the pixels of the display grid change with the pair of visits that is shown.
//
// skyToPixel undoes skyAt of ui/hover.js: the pixel of a picture that lies at a sky position.

/** How many decimals the address keeps: 0.00001 degree is 0.036 arcsec, a fraction of a pixel (6 arcsec). */
const AT_DECIMALS = 5;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * Read the `at` part of an address.
 * @param {string} search  The part of an address from "?" on.
 * @returns {[number, number] | null}  [ra, dec] in degrees, or null when there is none or it makes no sense.
 */
export function parseAt(search) {
  const text = new URLSearchParams(search).get('at');
  const m = text === null ? null : /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(text);
  if (!m) return null;
  const ra = Number(m[1]), dec = Number(m[2]);
  return Number.isFinite(ra) && Number.isFinite(dec) && ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? [ra, dec] : null;
}

/**
 * Write a place for the address.
 * @param {number} ra @param {number} dec
 * @returns {string}  "283.39625,33.02915"
 */
export function formatAt(ra, dec) {
  return `${Number(ra.toFixed(AT_DECIMALS)) + 0},${Number(dec.toFixed(AT_DECIMALS)) + 0}`;
}

/**
 * The pixel of a picture that lies at a sky position.
 * @param {{ra: number, dec: number, cd: [number, number, number, number]}} sky  The flat sky of the picture (LocalSky).
 * @param {number} tx  The target's x in the picture. @param {number} ty
 * @param {number} ra @param {number} dec  The position, degrees.
 * @returns {{x: number, y: number} | null}  The pixel, whole numbers; null when the position is not on the same side of the sky or the transform has no inverse.
 */
export function skyToPixel(sky, tx, ty, ra, dec) {
  const d0 = sky.dec * D2R, d = dec * D2R, dra = (ra - sky.ra) * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(dra);
  if (!(cosc > 1e-6)) return null;
  const east = Math.cos(d) * Math.sin(dra) / cosc * R2D;
  const north = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(dra)) / cosc * R2D;
  const [a, b, c, e] = sky.cd, det = a * e - b * c;
  if (!Number.isFinite(det) || det === 0) return null;
  const dx = (e * east - b * north) / det, dy = (-c * east + a * north) / det;
  const x = Math.round(tx + dx), y = Math.round(ty + dy);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
