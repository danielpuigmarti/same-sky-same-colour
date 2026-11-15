// Where a star with a known catalogue position is on a given date: proper motion, radial velocity and annual
// parallax. Needed for the stars that move fast enough to leave their catalogue position behind (Barnard's
// Star, Epsilon Indi B, WISE 0855-0714) and for the rings the viewer draws around catalogue stars.
//
// The star moves in a straight line through space, at constant speed, from its catalogue epoch. Its direction as
// seen from the Earth is that of the star's position minus the Earth's position, both measured from the centre of
// the solar system. The Earth's position comes from the Sun's low-precision formula (the Sun's own offset from
// the barycentre, up to 0.01 AU, is left out); for a star at 0.55 arcsec parallax that is 0.006 arcsec at most.
// SPHEREx is 7,000 km from the Earth's centre, which moves a star at 1 parsec by 0.0001 arcsec: also left out.
//
// Angles are degrees, proper motion mas/yr, parallax mas, time MJD (the scale is not told apart: 69 seconds is
// 0.0000002 years).

const DEG = Math.PI / 180;
const MJD_J2000 = 51544.5;
const AU_KM = 149597870.7;
const YEAR_DAYS = 365.25;
const PC_AU = 648000 / Math.PI;
/** 1 km/s in AU per Julian year. */
const KMS_TO_AU_YR = (YEAR_DAYS * 86400) / AU_KM;
const OBLIQUITY_J2000 = 23.439291111 * DEG;

/**
 * A catalogue position with its motion.
 * @typedef {Object} CatalogueStar
 * @property {number} ra  Degrees (ICRS) at `epoch`.
 * @property {number} dec
 * @property {number} epoch  Julian year of the position, e.g. 2016.0 for Gaia DR3.
 * @property {number} pmra  Proper motion in RA times cos(dec), mas/yr.
 * @property {number} pmdec  Proper motion in Dec, mas/yr.
 * @property {number} parallax  mas.
 * @property {number | null} [rv]  Radial velocity, km/s; missing counts as 0.
 */

/** MJD of a Julian year. @param {number} epoch */
export const epochToMjd = (epoch) => MJD_J2000 + (epoch - 2000) * YEAR_DAYS;

/**
 * The Earth's position seen from the solar-system barycentre, AU, in the ICRS axes. Good to about 0.01 AU.
 * @param {number} mjd
 * @returns {[number, number, number]}
 */
export function earthBarycentric(mjd) {
  const T = (mjd - MJD_J2000) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
  const e = 0.016708634 - 0.000042037 * T;
  const C = ((1.914602 - 0.004817 * T) * Math.sin(M) + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M)) * DEG;
  const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(M + C));
  // longitude of the Sun on the ecliptic of J2000: from the equinox of the date, take off the precession
  const lon = (L0 * DEG + C) - (1.396971 * T * DEG);
  const xs = R * Math.cos(lon), ys = R * Math.sin(lon);
  const x = -xs, y = -ys * Math.cos(OBLIQUITY_J2000), z = -ys * Math.sin(OBLIQUITY_J2000);
  return [x, y, z];
}

/**
 * The position of a catalogue star on a date, as seen from the Earth.
 * @param {CatalogueStar} star
 * @param {number} mjd  Date of the observation.
 * @param {{parallax?: boolean}} [options]  `parallax: false` gives the position seen from the barycentre.
 * @returns {[number, number]}  RA in [0, 360) and Dec, degrees.
 */
export function propagate(star, mjd, { parallax = true } = {}) {
  const a = star.ra * DEG, d = star.dec * DEG;
  const cd = Math.cos(d), sd = Math.sin(d), ca = Math.cos(a), sa = Math.sin(a);
  const u = [cd * ca, cd * sa, sd];
  const east = [-sa, ca, 0];
  const north = [-sd * ca, -sd * sa, cd];
  const dist = PC_AU * 1000 / star.parallax;
  const mas = DEG / 3600000;
  const rv = (star.rv ?? 0) * KMS_TO_AU_YR;
  const dt = (mjd - epochToMjd(star.epoch)) / YEAR_DAYS;
  const earth = parallax ? earthBarycentric(mjd) : [0, 0, 0];
  /** @type {number[]} */
  const v = [];
  for (let k = 0; k < 3; k++) {
    const speed = dist * mas * (star.pmra * east[k] + star.pmdec * north[k]) + rv * u[k];
    v.push(dist * u[k] + speed * dt - earth[k]);
  }
  const r = Math.hypot(v[0], v[1], v[2]);
  let ra = Math.atan2(v[1], v[0]) / DEG;
  if (ra < 0) ra += 360;
  return [ra, Math.asin(v[2] / r) / DEG];
}

/**
 * Offset of point 2 from point 1 on the sky, arcsec: [east, north], small angles.
 * @param {number} ra1 @param {number} dec1 @param {number} ra2 @param {number} dec2
 * @returns {[number, number]}
 */
export function offsetArcsec(ra1, dec1, ra2, dec2) {
  const dra = ((ra2 - ra1 + 540) % 360) - 180;
  return [dra * Math.cos(dec1 * DEG) * 3600, (dec2 - dec1) * 3600];
}

/**
 * Angular distance between two positions, degrees (haversine).
 * @param {number} ra1 @param {number} dec1 @param {number} ra2 @param {number} dec2
 */
export function separationDeg(ra1, dec1, ra2, dec2) {
  const s1 = Math.sin(((dec2 - dec1) * DEG) / 2), s2 = Math.sin(((ra2 - ra1) * DEG) / 2);
  const h = s1 * s1 + Math.cos(dec1 * DEG) * Math.cos(dec2 * DEG) * s2 * s2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / DEG;
}
