// The sky coordinates of a frame: gnomonic (TAN) projection with the SIP distortion polynomials, read from a header.
// Pixels are 0-based with whole numbers at pixel centres. world2pix is the counterpart of astropy's all_world2pix:
// it inverts the distortion exactly (Newton iteration on the A and B polynomials), so the AP and BP polynomials only
// give the starting point.

/** @import { Header } from './fitsio.js' */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** @typedef {[number, number, number][]} Poly  Terms [p, q, coefficient] of a polynomial in u^p v^q. */

/** @param {Header} h @param {string} pre @returns {Poly | null} */
function sipCoeffs(h, pre) {
  const order = h[pre + '_ORDER'];
  if (order === undefined) return null;
  /** @type {Poly} */
  const c = [];
  for (let p = 0; p <= order; p++) {
    for (let q = 0; p + q <= order; q++) {
      const v = h[`${pre}_${p}_${q}`];
      if (v) c.push([p, q, v]);
    }
  }
  return c;
}

/** @param {Poly} c @param {number} u @param {number} v */
function poly(c, u, v) {
  let s = 0;
  for (const [p, q, a] of c) s += a * u ** p * v ** q;
  return s;
}

/** Derivatives with respect to u and v. @param {Poly} c @param {number} u @param {number} v @returns {[number, number]} */
function dpoly(c, u, v) {
  let du = 0, dv = 0;
  for (const [p, q, a] of c) {
    if (p) du += a * p * u ** (p - 1) * v ** q;
    if (q) dv += a * q * u ** p * v ** (q - 1);
  }
  return [du, dv];
}

/**
 * @typedef {Object} Wcs
 * @property {(ra: number, dec: number) => [number, number]} world2pix  Sky position (degrees) to pixel [x, y], not rounded; [NaN, NaN] on the far side of the sky.
 * @property {(x: number, y: number) => [number, number]} pix2world  Pixel to [ra, dec] in degrees.
 */

/**
 * @param {Header} h  The IMAGE header of a frame.
 * @returns {Wcs}
 */
export function makeWcs(h) {
  if (!/^RA---TAN(-SIP)?$/.test(h.CTYPE1) || !/^DEC--TAN(-SIP)?$/.test(h.CTYPE2)) throw new Error('not an RA/Dec TAN header: ' + h.CTYPE1);
  /** @type {number[]} */
  let cd;
  if (h.CD1_1 !== undefined) cd = [h.CD1_1 || 0, h.CD1_2 || 0, h.CD2_1 || 0, h.CD2_2 || 0];
  else {
    const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
    cd = [c1 * (h.PC1_1 ?? 1), c1 * (h.PC1_2 ?? 0), c2 * (h.PC2_1 ?? 0), c2 * (h.PC2_2 ?? 1)];
  }
  const det = cd[0] * cd[3] - cd[1] * cd[2];
  const icd = [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det];
  const A = sipCoeffs(h, 'A') || [], B = sipCoeffs(h, 'B') || [], AP = sipCoeffs(h, 'AP'), BP = sipCoeffs(h, 'BP');
  const crpix = [h.CRPIX1, h.CRPIX2], a0 = h.CRVAL1 * D2R, d0 = h.CRVAL2 * D2R;
  const phip = (h.LONPOLE ?? (h.CRVAL2 >= 90 ? 0 : 180)) * D2R;
  const sd0 = Math.sin(d0), cd0 = Math.cos(d0);

  /** @type {Wcs['world2pix']} */
  function world2pix(ra, dec) {
    const a = ra * D2R, d = dec * D2R, da = a - a0;
    const sd = Math.sin(d), cdd = Math.cos(d);
    const Y = -cdd * Math.sin(da), X = sd * cd0 - cdd * sd0 * Math.cos(da);
    const phi = phip + Math.atan2(Y, X);
    const sth = sd * sd0 + cdd * cd0 * Math.cos(da), cth = Math.hypot(X, Y);
    if (sth <= 0) return [NaN, NaN];
    const r = R2D * cth / sth;
    const x = r * Math.sin(phi), y = -r * Math.cos(phi);
    const U = icd[0] * x + icd[1] * y, V = icd[2] * x + icd[3] * y; // u + f(u, v) and v + g(u, v)
    let u = AP ? U + poly(AP, U, V) : U, v = BP ? V + poly(BP, U, V) : V;
    for (let it = 0; it < 20; it++) {
      const fu = u + poly(A, u, v) - U, fv = v + poly(B, u, v) - V;
      const [a1, a2] = dpoly(A, u, v), [b1, b2] = dpoly(B, u, v);
      const j11 = 1 + a1, j12 = a2, j21 = b1, j22 = 1 + b2, jd = j11 * j22 - j12 * j21;
      const du = (fu * j22 - fv * j12) / jd, dv = (fv * j11 - fu * j21) / jd;
      u -= du; v -= dv;
      if (Math.abs(du) < 1e-12 && Math.abs(dv) < 1e-12) break;
    }
    return [u + crpix[0] - 1, v + crpix[1] - 1];
  }

  /** @type {Wcs['pix2world']} */
  function pix2world(px, py) {
    const u = px + 1 - crpix[0], v = py + 1 - crpix[1];
    const U = u + poly(A, u, v), V = v + poly(B, u, v);
    const x = cd[0] * U + cd[1] * V, y = cd[2] * U + cd[3] * V;
    const r = Math.hypot(x, y), phi = Math.atan2(x, -y), th = Math.atan2(R2D, r);
    const st = Math.sin(th), ct = Math.cos(th), dp = phi - phip;
    let a = a0 + Math.atan2(-ct * Math.sin(dp), st * cd0 - ct * sd0 * Math.cos(dp));
    const d = Math.asin(st * sd0 + ct * cd0 * Math.cos(dp));
    a = ((a * R2D) % 360 + 360) % 360;
    return [a, d * R2D];
  }

  return { world2pix, pix2world };
}
