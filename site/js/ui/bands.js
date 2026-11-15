// Where four gases take light out of a spectrum (or, in hot gas, add it), and a stored spectrum to hold a clicked
// object's against. The band edges are rounded and are listed, with their source, in references/v5.md.
//
// The comparison is of shape only: every spectrum on this page is relative, not corrected for the light outside its
// aperture, so a reference is scaled to the clicked object at one colour and nothing is said of its brightness.

/**
 * @typedef {Object} Band
 * @property {string} id
 * @property {'water' | 'methane' | 'carbon dioxide' | 'carbon monoxide'} gas
 * @property {string} short  What the chart prints over the band.
 * @property {number} from  µm.
 * @property {number} to
 */

/** The marked bands, in colour order. The first three are the ones the check of the stored spectra covers. @type {readonly Band[]} */
export const BANDS = Object.freeze([
  { id: 'h2o-1.4', gas: 'water', short: 'H2O', from: 1.33, to: 1.50 },
  { id: 'h2o-1.9', gas: 'water', short: 'H2O', from: 1.80, to: 2.05 },
  { id: 'ch4-3.3', gas: 'methane', short: 'CH4', from: 3.20, to: 3.50 },
  { id: 'co2-4.3', gas: 'carbon dioxide', short: 'CO2', from: 4.20, to: 4.35 },
  { id: 'co-4.6', gas: 'carbon monoxide', short: 'CO', from: 4.50, to: 5.00 },
]);

/** The bands of water and methane: where a brown dwarf is dim and a steady star is not. */
export const DIP_BANDS = Object.freeze(BANDS.filter((b) => b.gas === 'water' || b.gas === 'methane'));

/** @param {number} v @param {number} n  The number as the page writes a colour: two decimals. */
const fixed = (v, n = 2) => v.toFixed(n);

/** @param {Band} b @returns {string}  "water 1.33–1.50 µm", with a no-break space before the unit. */
export function bandText(b) {
  return `${b.gas} ${fixed(b.from)}–${fixed(b.to)} µm`;
}

/** @param {number[]} values @returns {number} */
export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN;
}

/**
 * How bright a spectrum is inside a band against just outside it: the median brightness of the points in the band
 * over the median of the points in the two strips next to it, each as wide as the band. Under 1, the band is a dip.
 * @param {{lam: number, flux: number}[]} points
 * @param {{from: number, to: number}} band
 * @returns {number}  NaN when there is no point inside or outside.
 */
export function bandContrast(points, band) {
  const w = band.to - band.from;
  const inside = points.filter((p) => p.lam >= band.from && p.lam <= band.to).map((p) => p.flux);
  const outside = points.filter((p) => (p.lam >= band.from - w && p.lam < band.from) || (p.lam > band.to && p.lam <= band.to + w)).map((p) => p.flux);
  return median(inside) / median(outside);
}

/**
 * The points of a stored spectrum, all its visits together, without the photos that carry a flag of the file's mask.
 * @param {any} doc  A file of data/spectra/.
 * @returns {{lam: number, flux: number}[]}
 */
export function pointsOfFile(doc) {
  const mask = Number.isFinite(doc?.mask) ? doc.mask : 0;
  /** @type {{lam: number, flux: number}[]} */
  const out = [];
  for (const v of Array.isArray(doc?.visits) ? doc.visits : []) {
    for (let i = 0; i < (v.lam?.length ?? 0); i++) {
      if (v.flags && (v.flags[i] & mask)) continue;
      if (Number.isFinite(v.lam[i]) && Number.isFinite(v.flux[i])) out.push({ lam: v.lam[i], flux: v.flux[i] });
    }
  }
  return out;
}

/**
 * A stored spectrum as a line: the median brightness in bins of colour.
 * @param {{lam: number, flux: number}[]} points @param {number} [bin]  µm.
 * @returns {{lam: number, flux: number}[]}
 */
export function binned(points, bin = 0.05) {
  /** @type {Map<number, {lam: number[], flux: number[]}>} */
  const bins = new Map();
  for (const p of points) {
    const k = Math.floor(p.lam / bin);
    const b = bins.get(k) ?? { lam: [], flux: [] };
    b.lam.push(p.lam);
    b.flux.push(p.flux);
    bins.set(k, b);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => ({ lam: median(b.lam), flux: median(b.flux) }));
}

/**
 * Scale a reference line to the clicked object at one colour: the colour in the middle of the object's range, where
 * both have points within 0.05 µm. Shape only.
 * @param {{lam: number, flux: number}[]} reference  A binned line.
 * @param {{lam: number, flux: number}[]} object  The points of the clicked object.
 * @returns {{line: {lam: number, flux: number}[], at: number} | null}  Null when the two have nothing in common at that colour, or the object is not above zero there.
 */
export function scaleToObject(reference, object) {
  if (!reference.length || !object.length) return null;
  const at = median(object.map((p) => p.lam)), near = 0.05;
  const o = median(object.filter((p) => Math.abs(p.lam - at) <= near).map((p) => p.flux));
  const r = median(reference.filter((p) => Math.abs(p.lam - at) <= near).map((p) => p.flux));
  if (!(o > 0) || !(r > 0)) return null;
  return { line: reference.map((p) => ({ lam: p.lam, flux: p.flux * (o / r) })), at };
}

/** The stored spectra the comparison offers: the brown dwarf, and one steady star. */
export const REFERENCES = Object.freeze([
  { id: 'brown-dwarf', file: 'data/spectra/eps-indi-b.json', label: 'Epsilon Indi B (a brown dwarf)' },
  { id: 'steady-star', file: 'data/spectra/gaia-6412593435166417536.json', label: 'a steady star' },
]);
