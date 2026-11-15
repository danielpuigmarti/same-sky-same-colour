// Wavelength and bandwidth at a pixel, from the six small WCS-WAVE tables of data/wave/tables.json (CT-3).
// Between nodes the value is linear in x and in y inside each cell, as FITS paper III describes for a lookup table.
// The celestial distortion (SIP) plays no part: the pixel is a detector pixel.

/** @import { WaveTable, WaveTables, Wavelength, Det } from '../contracts.js' */

/**
 * Index of the cell and the position inside it, as one number: 3.25 is a quarter of the way through cell 3.
 * Outside the grid the last cell is extended.
 * @param {number[]} knots  Node positions, increasing. @param {number} p
 */
function fidx(knots, p) {
  let k = 0;
  while (k < knots.length - 2 && p >= knots[k + 1]) k++;
  return k + (p - knots[k]) / (knots[k + 1] - knots[k]);
}

/**
 * @param {WaveTable} t  @param {number} x  0-based pixel. @param {number} y  0-based pixel.
 * @returns {Wavelength}
 */
export function lookup(t, x, y) {
  const fi = fidx(t.Y, y + 1), fj = fidx(t.X, x + 1); // the tables count pixels from 1, as FITS does
  const i = Math.min(Math.max(Math.floor(fi), 0), t.Y.length - 2), j = Math.min(Math.max(Math.floor(fj), 0), t.X.length - 2);
  const a = fi - i, b = fj - j;
  /** @param {number[][]} g */
  const interp = (g) => (1 - a) * ((1 - b) * g[i][j] + b * g[i][j + 1]) + a * ((1 - b) * g[i + 1][j] + b * g[i + 1][j + 1]);
  return { lam: interp(t.lam), bw: interp(t.bw) };
}

/**
 * The function of CT-3 for a set of tables.
 * @param {WaveTables} tables
 * @returns {(det: Det, x: number, y: number) => Wavelength}
 */
export function makeWavelengthAt(tables) {
  return (det, x, y) => {
    const t = tables[String(det)];
    if (!t) throw new Error(`no wavelength table for detector ${det}`);
    return lookup(t, x, y);
  };
}

/**
 * Fetch and check the tables.
 * @param {string | URL} url  Address of tables.json.
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<WaveTables>}
 */
export async function loadWaveTables(url, fetchFn = globalThis.fetch) {
  const r = await fetchFn(String(url));
  if (!r.ok) throw new Error(`wavelength tables: ${r.status} ${url}`);
  const tables = /** @type {WaveTables} */ (await r.json());
  for (let d = 1; d <= 6; d++) if (!tables[String(d)]) throw new Error(`wavelength tables: detector ${d} is missing`);
  return tables;
}

/** @type {((det: Det, x: number, y: number) => Wavelength) | null} */
let current = null;

/** Make `wavelengthAt` work: give it the tables, or let it fetch them from `url`. @param {WaveTables | string | URL} source */
export async function initWave(source) {
  const tables = typeof source === 'string' || source instanceof URL ? await loadWaveTables(source) : source;
  current = makeWavelengthAt(tables);
}

/**
 * CT-3. Wavelength and bandwidth, µm, at a 0-based full-frame pixel. Call `initWave` first.
 * @param {Det} det @param {number} x @param {number} y
 * @returns {Wavelength}
 */
export function wavelengthAt(det, x, y) {
  if (!current) throw new Error('wavelengthAt: call initWave first');
  return current(det, x, y);
}
