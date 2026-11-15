// Reading a sky position that a person typed (C1). No names here (see names.js), no network, no DOM.
//
// Accepted, with RA first and Dec second:
//   330.84 -56.79                     decimal degrees, separated by a space, a comma or a semicolon ("330,84 -56,79" too)
//   08h55m10.831s -7d14m42.53s        letters (also ° ′ ″, "deg"); hours for RA with h, degrees with d
//   08:55:10.831 -07:14:42.53         colons: RA in hours, Dec in degrees
//   08 55 10.831 -07 14 42.53         spaces: the same, 6 numbers (or 4: hours and minutes, degrees and minutes)
// "RA" and "Dec" in front of a number are ignored. Two plain numbers are degrees.

const SIGNS = /[−–—‒]/g;

/**
 * @typedef {Object} ParsedPosition
 * @property {true} ok
 * @property {number} ra  Degrees, 0 to 360.
 * @property {number} dec  Degrees, -90 to 90.
 * @property {'degrees' | 'sexagesimal'} form  How it was written.
 */

/**
 * @typedef {Object} ParseFailure
 * @property {false} ok
 * @property {string} message  Plain words, for the person who typed.
 */

const EXAMPLE = 'Try 330.84 -56.79 (degrees) or 08h55m10.83s -07d14m42.5s.';

/** @param {string} message @returns {ParseFailure} */
const fail = (message) => ({ ok: false, message });

/**
 * @typedef {Object} Token
 * @property {number} value
 * @property {string} unit  'h', 'd', 'm', 's' or ''.
 * @property {boolean} signed  A + or - stands in front.
 * @property {boolean} negative
 * @property {boolean} fraction  The number has a decimal point.
 */

/**
 * Read the text as a list of numbers with their signs and unit letters; null when something else is in it.
 * @param {string} s
 * @returns {Token[] | null}
 */
function tokenize(s) {
  const re = /\s*([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)(?![\d.])\s*([hdms]?)/y;
  /** @type {Token[]} */
  const out = [];
  let pos = 0;
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    out.push({ value: Number(m[2]), unit: m[3], signed: m[1] !== '', negative: m[1] === '-', fraction: m[2].includes('.') });
    pos = re.lastIndex;
  }
  return out;
}

/**
 * Split the tokens into the group of the right ascension and the group of the declination; null when it cannot be told.
 * @param {Token[]} t
 * @returns {[Token[], Token[]] | null}
 */
function split(t) {
  if (t.some((x) => x.unit !== '')) {
    // letters: a group starts at an h or a d; m and s continue it; a number with no letter continues it too,
    // unless it has a sign
    /** @type {Token[][]} */
    const groups = [];
    for (const x of t) {
      const last = groups[groups.length - 1];
      if (x.unit === 'h' || x.unit === 'd' || !last || (x.unit === '' && x.signed)) groups.push([x]);
      else last.push(x);
    }
    return groups.length === 2 ? [groups[0], groups[1]] : null;
  }
  const at = t.findIndex((x, i) => i > 0 && x.signed);
  if (at > 0) return [t.slice(0, at), t.slice(at)];
  if (t.length === 2 || t.length === 4 || t.length === 6) return [t.slice(0, t.length / 2), t.slice(t.length / 2)];
  return null;
}

/**
 * The value of one group in its own unit (hours or degrees), or a message when it is not a valid number of fields.
 * @param {Token[]} g @param {string} what
 * @returns {number | string}
 */
function groupValue(g, what) {
  if (g.length > 3) return `The ${what} has too many numbers.`;
  const order = ['hd', 'm', 's'];
  for (let i = 0; i < g.length; i++) {
    const u = g[i].unit;
    if (u !== '' && !order[i].includes(u)) return `The ${what} has its numbers in the wrong order (hours or degrees, then minutes, then seconds).`;
    if (i < g.length - 1 && g[i].fraction) return `The ${what} has a decimal point before its last number.`;
    if (i > 0 && g[i].signed) return `The ${what} has a sign in the middle.`;
    if (i > 0 && g[i].value >= 60) return `The minutes and seconds of the ${what} must be below 60.`;
  }
  return g[0].value + (g[1] ? g[1].value / 60 : 0) + (g[2] ? g[2].value / 3600 : 0);
}

/**
 * Read a typed position.
 * @param {string} text
 * @returns {ParsedPosition | ParseFailure}
 */
export function parseCoords(text) {
  if (typeof text !== 'string' || text.trim() === '') return fail(`Type a sky position. ${EXAMPLE}`);
  let s = text.replace(/[°º˚]/g, 'd').replace(/′′|″|''|’’|”|"/g, 's').replace(/[′’'`]/g, 'm');
  s = s.normalize('NFKC').toLowerCase().replace(SIGNS, '-');
  s = s.replace(/[()[\]]/g, ' ').replace(/(?:right ascension|declination|\bra\b|\bdec\b)\s*[:=]?/g, ' ');
  // decimal commas: "330,84 -56,79"
  if (/^\s*[+-]?\d+,\d+\s+[+-]?\d+,\d+\s*$/.test(s)) s = s.replace(/,/g, '.');
  s = s.replace(/degrees?|deg/g, 'd');
  s = s.replace(/[,;:]/g, ' ');
  const tokens = tokenize(s);
  if (!tokens || tokens.length === 0) return fail(`That does not read as a sky position. ${EXAMPLE}`);
  const parts = split(tokens);
  if (!parts) {
    return fail(tokens.length === 1 ? `Only one number: a position needs two, right ascension and declination. ${EXAMPLE}`
      : `Could not tell where the right ascension ends and the declination begins. Put a + or - in front of the declination, or use letters (08h55m10.8s -07d14m42s).`);
  }
  const [rg, dg] = parts;
  const rv = groupValue(rg, 'right ascension');
  if (typeof rv === 'string') return fail(rv);
  const dv = groupValue(dg, 'declination');
  if (typeof dv === 'string') return fail(dv);
  if (rg[0].negative) return fail('Right ascension runs from 0 to 360 degrees (0 to 24 hours), without a minus sign.');
  const hours = rg[0].unit === 'h' || (rg[0].unit === '' && rg.length > 1);
  const ra = hours ? rv * 15 : rv;
  if (!(ra >= 0 && ra < 360)) {
    return fail(hours ? 'Right ascension in hours must be from 0 up to 24.' : 'Right ascension in degrees must be from 0 up to 360. Declination goes with it as the second number.');
  }
  const dec = (dg[0].negative ? -1 : 1) * dv;
  if (!(Math.abs(dec) <= 90)) return fail('Declination must be between -90 and +90 degrees.');
  return { ok: true, ra, dec, form: tokens.some((x) => x.unit !== '') || tokens.length > 2 ? 'sexagesimal' : 'degrees' };
}

/**
 * A position as decimal degrees, "330.84000 -56.79000".
 * @param {number} ra @param {number} dec @param {number} [digits]
 */
export function formatDegrees(ra, dec, digits = 5) {
  return `${ra.toFixed(digits)} ${dec.toFixed(digits)}`;
}

/**
 * A position as hours and degrees with letters, "08h55m10.831s -07d14m42.53s".
 * @param {number} ra @param {number} dec @param {number} [digits]  Decimals of the seconds of RA; Dec gets one fewer.
 */
export function formatSexagesimal(ra, dec, digits = 2) {
  const h = (((ra % 360) + 360) % 360) / 15;
  const rs = Math.round(h * 3600 * 10 ** digits) / 10 ** digits;
  const rh = Math.floor(rs / 3600) % 24, rm = Math.floor((rs % 3600) / 60), rsec = rs - rh * 3600 - rm * 60;
  const ds = Math.round(Math.abs(dec) * 3600 * 10 ** (digits - 1)) / 10 ** (digits - 1);
  const dd = Math.floor(ds / 3600), dm = Math.floor((ds % 3600) / 60), dsec = ds - dd * 3600 - dm * 60;
  const two = (/** @type {number} */ x) => String(x).padStart(2, '0');
  const sec = (/** @type {number} */ x, /** @type {number} */ k) => (x < 10 ? '0' : '') + x.toFixed(k);
  return `${two(rh)}h${two(rm)}m${sec(rsec, digits)}s ${dec < 0 ? '-' : '+'}${two(dd)}d${two(dm)}m${sec(dsec, Math.max(digits - 1, 0))}s`;
}
