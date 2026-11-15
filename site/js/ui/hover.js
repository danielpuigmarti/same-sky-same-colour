// The readout under the pointer: where on the sky the pixel is, its colour, its value, its flags, and the photo
// it comes from. Every part is read from the picture itself; a part the picture cannot give is left empty.
//
// The first half of this file has no need of a page; createHover builds the readout in a page.

/** @import { Det, Wavelength } from '../contracts.js' */
/** @import { LocalSky, Picture, StagePoint } from './stage.js' */
import { KEY_REGEX } from '../contracts.js';
import { flagNames, FLAG_TABLE, SATURATION_MASK } from '../lib/flags.js';
import { formatDate } from './stage.js';
import { formatColour } from './ruler.js';
import { bucketUrl, copyText } from './share.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Decimals of a position in degrees: the flat approximation of a picture is good to a few hundredths of an arcsec. */
export const SKY_DECIMALS = 4;

/**
 * How far east and north a sky position lies from another, in degrees on the plane that touches the sky at
 * (ra0, dec0) (the gnomonic projection).
 * @param {number} ra0 @param {number} dec0 @param {number} ra @param {number} dec  Degrees.
 * @returns {[number, number]}  [east, north], degrees.
 */
export function tangentOffset(ra0, dec0, ra, dec) {
  const da = (ra - ra0) * D2R, d = dec * D2R, d0 = dec0 * D2R;
  const depth = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(da);
  return [
    R2D * Math.cos(d) * Math.sin(da) / depth,
    R2D * (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(da)) / depth,
  ];
}

/**
 * The sky position of a pixel of a picture.
 * @param {LocalSky} sky
 * @param {number} tx  The target's x in the picture. @param {number} ty
 * @param {number} x  The pixel. @param {number} y
 * @returns {[number, number]}  [ra, dec] in degrees, ra from 0 to 360.
 */
export function skyAt(sky, tx, ty, x, y) {
  const dx = x - tx, dy = y - ty;
  const east = (sky.cd[0] * dx + sky.cd[1] * dy) * D2R, north = (sky.cd[2] * dx + sky.cd[3] * dy) * D2R;
  const d0 = sky.dec * D2R, across = Math.cos(d0) - north * Math.sin(d0);
  const ra = sky.ra + R2D * Math.atan2(east, across);
  const dec = R2D * Math.atan2(Math.sin(d0) + north * Math.cos(d0), Math.hypot(across, east));
  return [((ra % 360) + 360) % 360, dec];
}

/**
 * The flat approximation of a picture's sky, from the transform of its frame: the position of the target pixel and
 * what one pixel to the right and one pixel up do, measured half a pixel to each side of the target.
 * @param {(x: number, y: number) => [number, number]} pix2world  Full-frame pixel (0-based) to [ra, dec] in degrees, distortion included.
 * @param {{x0: number, y0: number, tx: number, ty: number}} picture
 * @returns {LocalSky | null}  Null when the transform gives no position there.
 */
export function localSky(pix2world, picture) {
  const X = picture.x0 + picture.tx, Y = picture.y0 + picture.ty, s = 0.5;
  const [ra, dec] = pix2world(X, Y);
  /** @param {number} x @param {number} y */
  const off = (x, y) => { const p = pix2world(x, y); return tangentOffset(ra, dec, p[0], p[1]); };
  const right = off(X + s, Y), left = off(X - s, Y), up = off(X, Y + s), down = off(X, Y - s);
  /** @type {[number, number, number, number]} */
  const cd = [(right[0] - left[0]) / (2 * s), (up[0] - down[0]) / (2 * s), (right[1] - left[1]) / (2 * s), (up[1] - down[1]) / (2 * s)];
  return [ra, dec, ...cd].every(Number.isFinite) ? { ra, dec, cd } : null;
}

/**
 * The short name of the file of a photo: the observation and the detector, "2026W11_2A_0501_1D2". Empty for a key
 * that is not the key of a frame.
 * @param {string} key  Bucket key.
 * @returns {string}
 */
export function fileId(key) {
  const m = KEY_REGEX.exec(key ?? '');
  return m ? `${m[1]}_${m[4]}_${m[5]}D${m[3]}` : '';
}

/**
 * What the readout says about one pixel.
 * @typedef {Object} Readout
 * @property {'a' | 'b' | 'diff'} kind  Which picture.
 * @property {number} x  Column of the pixel in the picture.
 * @property {number} y  Row, counted from the lowest.
 * @property {number | null} ra  Degrees; null when the picture has no sky transform.
 * @property {number | null} dec
 * @property {number | null} lam  Colour of this pixel, µm; null when it cannot be known.
 * @property {number | null} bw  Bandwidth there, µm.
 * @property {number | null} value  The value of the pixel; null when it has none.
 * @property {'MJy/sr' | 'noise'} unit  What the value is counted in.
 * @property {number | null} word  The flag word; null when the picture has no flags.
 * @property {string[]} flags  The names of the flags that are set, all but FULLSAMPLE.
 * @property {number | null} mjd  When the photo was taken, MJD (UTC).
 * @property {string} id  Short name of the file; empty when the picture is not one photo.
 * @property {string[]} keys  Bucket keys of the photos behind the pixel: the photo itself, or the photos added up; empty when none is known.
 * @property {number} photos  How many photos the picture is made of.
 */

/**
 * Read one pixel of a picture.
 * @param {StagePoint} point
 * @param {{wavelengthAt?: ((det: Det, x: number, y: number) => Wavelength) | null}} [using]  CT-3, for the colour of the pixel.
 * @returns {Readout}
 */
export function readout(point, using = {}) {
  const { kind, x, y } = point;
  const p = point.picture, i = y * p.w + x;
  const raw = p.data[i];
  /** @type {Readout} */
  const out = {
    kind, x, y, ra: null, dec: null, lam: null, bw: null,
    value: Number.isFinite(raw) ? raw : null,
    unit: kind === 'diff' ? 'noise' : 'MJy/sr',
    word: null, flags: [], mjd: null, id: '', keys: [], photos: 1,
  };
  if (p.sky) [out.ra, out.dec] = skyAt(p.sky, p.tx, p.ty, x, y);
  if (kind === 'diff') return out;
  const picture = /** @type {Picture} */ (p);
  if (picture.flags) {
    out.word = picture.flags[i];
    out.flags = flagNames(picture.flags[i]);
  }
  out.photos = picture.photos ?? 1;
  if (Number.isFinite(picture.mjd)) out.mjd = picture.mjd;
  out.id = fileId(picture.key);
  out.keys = (picture.members?.length ? picture.members.map((m) => m.key) : [picture.key]).filter((k) => KEY_REGEX.test(k ?? ''));
  if (using.wavelengthAt && Number.isFinite(picture.x0) && Number.isFinite(picture.y0)) {
    const c = using.wavelengthAt(picture.det, picture.x0 + x, picture.y0 + y);
    if (Number.isFinite(c.lam)) { out.lam = c.lam; out.bw = c.bw; }
  }
  return out;
}

/**
 * A value as text, with as many decimals as its size calls for.
 * @param {number} v
 * @returns {string}
 */
export function formatValue(v) {
  const size = Math.abs(v);
  return v.toFixed(size >= 1000 ? 0 : size >= 100 ? 1 : size >= 10 ? 2 : 3);
}

/**
 * A sky position as text: "RA 269.4464°, Dec +4.7671°".
 * @param {number} ra @param {number} dec  Degrees.
 * @returns {string}
 */
export function formatSky(ra, dec) {
  return `RA ${ra.toFixed(SKY_DECIMALS)}°, Dec ${dec < 0 ? '-' : '+'}${Math.abs(dec).toFixed(SKY_DECIMALS)}°`;
}

/**
 * What the readout says about a pixel, in words, part by part: the readout shows it and the receipt copies it.
 * @param {Readout} r
 * @returns {{sky: string, colour: string, value: string, flags: string[], flagsEmpty: string, photo: string}}
 */
export function readoutWords(r) {
  const tooBright = r.word !== null && (r.word & SATURATION_MASK) !== 0;
  return {
    sky: r.ra !== null && r.dec !== null ? formatSky(r.ra, r.dec) : 'not known for this picture',
    colour: r.lam !== null ? formatColour(r.lam) : r.kind === 'diff' ? 'the colour of the two visits' : 'not known for this pixel',
    value: r.value === null ? (tooBright ? 'none: too bright to be measured' : 'no value')
      : r.unit === 'noise' ? `${r.value > 0 ? '+' : r.value < 0 ? '-' : ''}${formatValue(Math.abs(r.value))} times the noise` : `${formatValue(r.value)} MJy/sr`,
    // each flag by its name in the photo's header, and what it means in plain words
    flags: r.flags.map((flag) => { const row = FLAG_TABLE.find((f) => f.name === flag); return row ? `${flag}: ${row.label}` : flag; }),
    flagsEmpty: r.word === null ? (r.kind === 'diff' ? 'see the two visits' : 'not loaded') : 'none',
    photo: r.kind === 'diff' ? 'later visit minus earlier visit'
      : [r.mjd !== null ? formatDate(r.mjd, true) : '', r.id, r.photos > 1 ? `${r.photos} photos added up` : ''].filter(Boolean).join(' · ') || '—',
  };
}

/** The most photos of a stack that a receipt lists one by one. */
export const RECEIPT_PHOTOS = 10;

/**
 * A plain-text receipt for one pixel: where it is, its colour, its brightness (or why there is none), its flags in
 * words, the photo and its time, and the address of the photo in the public archive.
 * @param {Readout} r
 * @param {string} [link]  The address of the view, when there is one.
 * @returns {string}
 */
export function readingText(r, link = '') {
  const w = readoutWords(r);
  const lines = [
    `One pixel of a SPHEREx photo, read on Same Sky, Same Colour (${r.kind === 'diff' ? 'difference of the two visits' : 'one visit'})`,
    `Sky position: ${w.sky}${r.ra !== null ? ' (ICRS)' : ''}`,
    `Colour: ${w.colour}`,
    `Brightness: ${w.value}`,
    `Flags: ${r.flags.length ? w.flags.join('; ') : w.flagsEmpty}`,
  ];
  if (r.kind === 'diff') {
    lines.push('Photos: later visit minus earlier visit; the photos of each visit are listed under "Share this view"');
  } else {
    lines.push(`Photo taken: ${r.mjd !== null ? formatDate(r.mjd, true) : 'time not known'}`);
    if (r.photos > 1) lines.push(`Photos: ${r.photos} added up; this pixel is their mean`);
    const shown = r.keys.slice(0, RECEIPT_PHOTOS);
    if (shown.length === 1 && r.photos === 1) lines.push(`Photo: ${r.id}`, `Archive: ${bucketUrl(shown[0])}`);
    else if (shown.length) {
      lines.push(...shown.map((k) => `Archive: ${bucketUrl(k)}`));
      if (r.keys.length > shown.length) lines.push(`and ${r.keys.length - shown.length} more: see "Photos used" under "Share this view"`);
    } else lines.push('Archive: no single photo to point to; see "Photos used" under "Share this view"');
  }
  if (link) lines.push(`View: ${link}`);
  return lines.join('\n');
}

/**
 * Build the readout in `root`.
 * @param {HTMLElement} root
 * @param {{link?: () => string, copy?: (text: string) => Promise<boolean> | boolean}} [options]  `link` gives the address of the view for the receipt; `copy` replaces the clipboard, for tests.
 * @returns {{show: (r: Readout | null, name?: string) => void, current: () => Readout | null}}
 */
export function createHover(root, options = {}) {
  const REST = 'Click a point on the photo to read its position, colour and brightness.';
  root.classList.add('hover');
  const hint = document.createElement('p');
  hint.className = 'hover-hint';
  hint.textContent = REST;
  // a column of ruled cells in fixed slots: each fills in place when a pixel is pointed at
  const list = document.createElement('dl');
  list.className = 'cells hover-list';
  /** @type {Record<string, HTMLElement>} */
  const cells = {};
  for (const [name, label] of [['sky', 'Position'], ['colour', 'Colour'], ['value', 'Brightness'], ['flags', 'Flags'], ['photo', 'Photo']]) {
    const row = document.createElement('div');
    row.className = 'cell hover-row';
    const dt = document.createElement('dt');
    dt.className = 'cell-label';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.dataset.part = name;
    cells[name] = dd;
    row.append(dt, dd);
    list.append(row);
  }
  const copyRow = document.createElement('p');
  copyRow.className = 'hover-copy';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'hover-copy-button';
  copyButton.textContent = 'Copy this reading';
  copyButton.disabled = true;
  const copyState = document.createElement('span');
  copyState.className = 'hover-copy-state';
  copyState.setAttribute('role', 'status');
  copyRow.append(copyButton, copyState);
  root.replaceChildren(hint, list, copyRow);
  /** @type {Readout | null} */
  let now = null;
  /** @type {any} */
  let told = 0;
  let flagsOpen = false;
  copyButton.addEventListener('click', async () => {
    if (!now) return;
    const text = readingText(now, options.link?.() ?? '');
    const ok = await (options.copy ? options.copy(text) : copyText(text));
    copyState.textContent = ok === false ? 'Could not copy' : 'Copied';
    clearTimeout(told);
    told = setTimeout(() => { copyState.textContent = ''; }, 2500);
  });

  /** @param {Readout | null} r @param {string} [name]  What is read: the pixel under the pointer, unless told otherwise. */
  function show(r, name = 'Pixel under the pointer') {
    now = r;
    hint.textContent = r === null ? REST : name;
    root.dataset.empty = String(r === null);
    for (const name of ['kind', 'x', 'y', 'ra', 'dec', 'lam', 'value', 'unit', 'word', 'flags', 'mjd', 'id']) delete root.dataset[name];
    if (r === null) {
      for (const dd of Object.values(cells)) dd.textContent = '—';
      copyButton.disabled = true;
      return;
    }
    Object.assign(root.dataset, {
      kind: r.kind, x: String(r.x), y: String(r.y), unit: r.unit, flags: r.flags.join(' '), id: r.id,
      ...(r.ra !== null && r.dec !== null ? { ra: String(r.ra), dec: String(r.dec) } : {}),
      ...(r.lam !== null ? { lam: String(r.lam) } : {}),
      ...(r.value !== null ? { value: String(r.value) } : {}),
      ...(r.word !== null ? { word: String(r.word) } : {}),
      ...(r.mjd !== null ? { mjd: String(r.mjd) } : {}),
    });
    // a value that is a reading stays in typewriter; one that says in words why there is none is set as words
    cells.sky.classList.toggle('is-words', r.ra === null || r.dec === null);
    cells.colour.classList.toggle('is-words', r.lam === null);
    cells.value.classList.toggle('is-words', r.value === null);
    cells.photo.classList.toggle('is-words', r.kind === 'diff');
    const w = readoutWords(r);
    cells.sky.textContent = w.sky;
    cells.colour.textContent = w.colour;
    cells.value.textContent = w.value;
    // the flag words are kept in a detail: the line says how many are set, and the words say what each means
    if (r.flags.length) {
      const details = document.createElement('details');
      details.className = 'hover-flags';
      details.open = flagsOpen;
      details.addEventListener('toggle', () => { flagsOpen = details.open; });
      const summary = document.createElement('summary');
      summary.textContent = `${r.flags.length} ${r.flags.length === 1 ? 'flag' : 'flags'} set: what they mean`;
      const words = document.createElement('div');
      words.className = 'hover-flags-words';
      words.textContent = w.flags.join('\n');
      details.append(summary, words);
      cells.flags.replaceChildren(details);
    } else cells.flags.textContent = w.flagsEmpty;
    cells.photo.textContent = w.photo;
    copyButton.disabled = false;
  }
  show(null);
  return { show, current: () => now };
}
