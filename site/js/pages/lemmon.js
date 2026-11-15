// The comet page: where comet Lemmon was photographed on two nights, the photos of both nights colour by colour,
// and why we read its glow as carbon dioxide. It is the long item of the bulletin: every photo and every
// drawing stands on a plate with its cells joined under it, and every table is a ledger.
//
// The page is made from the data files and stored as plain HTML (see the top of ui/cards.js): buildComet makes the
// parts that tests/unit/v4-pages.test.mjs writes into lemmon.html. With scripts on, the photos are drawn from the
// showcases: the two places blink between August and February, and a chip steps along a ruler from which the
// photos of both nights hang at their colours. Without, the page shows the pictures the pipeline drew and reads
// the same.

/** @import { NumberEntry } from '../contracts.js' */
/** @import { Build } from '../ui/cards.js' */
/** @import { Photo } from '../ui/hero.js' */
import { fill, tagLink, picture, esc, attr, markDates, dateWords, numberSpan, cellRow, mountBlink } from '../ui/cards.js';
import { loadShowcase, displayRule, viewSize, lineUp, paintPhoto, el, formatDay, formatTime, formatColour } from '../ui/hero.js';

/**
 * What the page is made from. A file that is not there is null, and its parts stay empty.
 * @typedef {Object} CometData
 * @property {any} track  lemmon/track.json.
 * @property {any} spectrum  lemmon/spectrum.json.
 * @property {any} strip  lemmon/strip/manifest.json.
 * @property {any} templates  lemmon/templates/manifest.json.
 * @property {any} [wide]  lemmon/wide/manifest.json: the wide pictures of the comet's field.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/** @param {number} mjd */
const dateOf = (mjd) => new Date(Math.round((mjd - 40587) * 86400000));

/** "26 February 2026" as a date of the page. @param {number} mjd */
function dayOf(mjd) {
  const d = dateOf(mjd);
  return `<time datetime="${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}">${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}</time>`;
}

/**
 * "26 February 2026, 20:43 UTC" as a date of the page.
 * @param {number} mjd
 * @param {boolean} [capitals]  Written in capitals, for a date that heads an item.
 */
function momentOf(mjd, capitals = false) {
  const d = dateOf(mjd);
  const iso = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}Z`;
  const words = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  return `<time datetime="${iso}">${capitals ? words.toUpperCase() : words}</time>`;
}

/** "26 Feb", for a drawing. @param {number} mjd */
function shortDay(mjd) {
  const d = dateOf(mjd);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

/** A number of a drawing, with two decimals at most. @param {number} v */
const r2 = (v) => String(Math.round(v * 100) / 100);

/**
 * The photos of spectrum.json that can be used: each with its id, its night, its colour and its time.
 * @param {any} spectrum
 * @returns {any[]}
 */
function photosOf(spectrum) {
  return Array.isArray(spectrum?.photos)
    ? spectrum.photos.filter((/** @type {any} */ p) => typeof p?.id === 'string' && typeof p.night === 'string' && Number.isFinite(p.lam) && Number.isFinite(p.mjd))
    : [];
}

/** The nights of the photos, in the order of time. @param {any[]} photos @returns {string[]} */
function nightsOf(photos) {
  /** @type {Map<string, number>} */
  const began = new Map();
  for (const p of photos) began.set(p.night, Math.min(began.get(p.night) ?? Infinity, p.mjd));
  return [...began.keys()].sort((a, b) => /** @type {number} */ (began.get(a)) - /** @type {number} */ (began.get(b)));
}

/** The day of a night, from its photos. @param {any[]} photos @param {string} night */
const dayOfNight = (photos, night) => dayOf(Math.min(...photos.filter((p) => p.night === night).map((p) => p.mjd)));

/**
 * The contrast with one photo left out, as text: one decimal, as the page writes every contrast.
 * @param {number} v
 */
const contrastText = (v) => v.toFixed(1);

/**
 * The numbers this page adds to numbers.json: the contrast of each night with each photo left out in turn, which
 * spectrum.json holds and no job wrote as numbers, how many of those photos change nothing, and how wide the
 * field of the wide pictures is, which their manifest gives.
 * @param {CometData} data
 * @returns {Record<string, NumberEntry>}
 */
export function cometNumbers(data) {
  /** @type {Record<string, NumberEntry>} */
  const out = {};
  const rows = leftOutRows(data);
  for (const r of rows) {
    for (const night of r.nights) out[`v4.leftout.${r.id}.${night.name}`] = { value: night.value, err: null, unit: 'times', text: contrastText(night.value), check: 'K2' };
  }
  const same = rows.filter((r) => !r.changes).length;
  if (rows.length) out['v4.leftout.same'] = { value: same, err: null, unit: null, text: String(same), check: 'K2' };
  const field = data.wide?.field_arcmin;
  if (typeof field === 'number' && Number.isFinite(field)) out['v4.wide.arcmin'] = { value: field, err: null, unit: 'arcmin', text: field.toFixed(1), check: null };
  return out;
}

/**
 * The rows of the leave-one-out table: for each photo left out, the contrast of each night, and whether leaving it
 * out changes either of them.
 * @param {CometData} data
 * @returns {{id: string, lam: number, mjd: number, night: string, role: string, changes: boolean, nights: {name: string, value: number}[]}[]}
 */
function leftOutRows(data) {
  const photos = photosOf(data.spectrum), nights = nightsOf(photos);
  const list = Array.isArray(data.spectrum?.leave_one_out) ? data.spectrum.leave_one_out : [];
  const out = [];
  for (const r of list) {
    const photo = photos.find((p) => p.obs === r.left_out);
    if (!photo || !nights.every((n) => Number.isFinite(r[n]))) continue;
    const values = nights.map((n) => ({ name: n, value: /** @type {number} */ (r[n]) }));
    const changes = values.some((v) => contrastText(v.value) !== contrastText(data.spectrum?.contrast?.[v.name]?.contrast));
    out.push({ id: photo.id, lam: photo.lam, mjd: photo.mjd, night: photo.night, role: String(r.role ?? 'other'), changes, nights: values });
  }
  return out.sort((p, q) => p.lam - q.lam);
}

/**
 * The picture of the comet at the head of the page, when the site has it: the middle of the wide picture of the
 * brightest photo of the later night, enlarged as the home page enlarges it, on a plate, with the date and the colour
 * of that photo, the width of what is shown and of the wide picture cut from the photo under it. The picture is the wide one itself,
 * cut by the plate: each of its squares is one pixel of the camera, and is never smoothed.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function widePlate(b, data) {
  const pictures = Array.isArray(data.wide?.pictures) ? data.wide.pictures : [];
  const photos = photosOf(data.spectrum), nights = nightsOf(photos);
  const peak = photos.find((p) => p.obs === data.spectrum?.contrast?.[nights[nights.length - 1]]?.peak);
  const shot = peak ? pictures.find((/** @type {any} */ s) => s?.key === peak.key && typeof s.file === 'string' && Number.isFinite(s.mjd)) : undefined;
  const size = Number(data.wide?.size), shown = Number(b.numbers['r1.flip.shown_px']?.value);
  const [cx, cy] = Array.isArray(shot?.comet_px) ? shot.comet_px.map(Number) : [NaN, NaN];
  if (!shot || !Object.hasOwn(b.numbers, `lemmon.frame.${peak.id}.lam`) || ![size, shown, cx, cy].every(Number.isFinite) || shown <= 0 || shown > size) return '';
  if (!Object.hasOwn(b.numbers, 'r1.flip.field_arcmin')) {
    b.left.push('number r1.flip.field_arcmin');
    return '';
  }
  const img = picture(b, `data/lemmon/wide/${shot.file}`, 'The comet in the middle of a patch of sky: a round glow, far wider than any of the stars around it. The photo is drawn as it was taken, one square for each pixel of the camera.');
  if (!img) return '';
  // the plate shows `shown` pixels of the `size` that the picture has, round the comet
  const zoom = size / shown, at = (/** @type {number} */ c) => r2(-(c / size * zoom - 0.5) * 100);
  // the plate at the top of the page is fetched at once, not when it comes near the window
  const cut = img.replace('<img', `<img style="width:${r2(zoom * 100)}%;height:${r2(zoom * 100)}%;margin:${at(cy)}% 0 0 ${at(cx)}%"`).replace(' loading="lazy"', ' fetchpriority="high"');
  const north = data.wide.grid === 'north-up' ? ', north up' : '';
  return `<div class="plate-frame">
<div class="plate plate-crop" data-plate>${cut}</div>
${cellRow([
    ['Taken', momentOf(shot.mjd)],
    ['Colour', `${numberSpan(b, `lemmon.frame.${peak.id}.lam`)} µm, inside the band of carbon dioxide`],
  ], { cols: 2 })}
</div>
${cellRow([
    ['Field', `${numberSpan(b, 'r1.flip.field_arcmin')} arcminutes across${north}`],
    ['Wide picture', Object.hasOwn(b.numbers, 'v4.wide.arcmin') ? `${numberSpan(b, 'v4.wide.arcmin')} arcminutes wide, cut from the photo` : ''],
    ['Each square', 'One pixel of the camera'],
    ['Photo', 'SPHEREx Level <span translate="no">2</span>, NASA/IPAC Infrared Science Archive'],
  ], { cls: 'lead-cells', cols: 4 })}`;
}

/**
 * The map of the comet's path over the two nights, on a plate: the path JPL Horizons gives, a dot for each photo,
 * a ring at each of the two places that are shown, and a compass and a scale bar inside it. East is to the left
 * and north is up; distances are in arcminutes. The cells joined under it say what its marks are.
 * @param {CometData} data
 * @returns {string}
 */
function trackMap(data) {
  const ok = (/** @type {any} */ p) => Number.isFinite(p?.east) && Number.isFinite(p?.north);
  const path = Array.isArray(data.track?.path) ? data.track.path.filter(ok) : [];
  const places = Array.isArray(data.track?.places) ? data.track.places.filter(ok) : [];
  if (path.length < 2 || !places.length) return '';
  const photos = Array.isArray(data.track.photos) ? data.track.photos.filter(ok) : [];
  const xs = path.map((/** @type {any} */ p) => -p.east), ys = path.map((/** @type {any} */ p) => -p.north);
  const pad = 7, x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
  const dots = photos.map((/** @type {any} */ p) => `<circle class="track-dot" data-inside="${p.inside === true}" cx="${r2(-p.east)}" cy="${r2(-p.north)}" r="0.55"/>`).join('');
  const rings = places.map((/** @type {any} */ p) => {
    // the name of a place stands on the side of the path that has room: right of the path in its upper half, left in its lower
    const right = -p.north < y0 + h / 2;
    return `<circle class="track-ring" cx="${r2(-p.east)}" cy="${r2(-p.north)}" r="2.4"/><text class="track-name" x="${r2(-p.east + (right ? 4 : -4))}" y="${r2(-p.north + 0.9)}" text-anchor="${right ? 'start' : 'end'}">${esc(shortDay(p.mjd))}</text>`;
  }).join('');
  const cx = x0 + w - 6, cy = y0 + h - 4;
  // the scale bar: ten units of the drawing, which are ten arcminutes of sky
  const bx = x0 + 4, by = y0 + h - 4, bar = 10;
  return `<div class="plate-frame">
<div class="plate track-plate" data-plate>
<svg class="track-map" viewBox="${r2(x0)} ${r2(y0)} ${r2(w)} ${r2(h)}" role="img" aria-labelledby="track-map-title">
<title id="track-map-title">The comet's path across the sky over the two nights, running from the upper left to the lower right, with a ring at each of the two places where it is shown.</title>
<polyline class="track-path" points="${path.map((/** @type {any} */ p) => `${r2(-p.east)},${r2(-p.north)}`).join(' ')}"/>
${dots}
${rings}
<g class="track-compass" aria-hidden="true"><path d="M${r2(cx)} ${r2(cy)}V${r2(cy - 5)}M${r2(cx)} ${r2(cy)}H${r2(cx - 5)}"/><text x="${r2(cx)}" y="${r2(cy - 5.8)}" text-anchor="middle">N</text><text x="${r2(cx - 5.8)}" y="${r2(cy + 0.8)}" text-anchor="end">E</text></g>
<g class="track-scale" aria-hidden="true"><path d="M${r2(bx)} ${r2(by - 1)}V${r2(by)}H${r2(bx + bar)}V${r2(by - 1)}"/><text x="${r2(bx + bar / 2)}" y="${r2(by - 1.6)}" text-anchor="middle">${bar} arcmin</text></g>
</svg>
</div>
${cellRow([
    ['Line', 'The path JPL Horizons predicts, as seen from SPHEREx'],
    ['Dots', 'One for each photo; the bright ones are inside the band'],
    ['Rings', 'The two places shown here'],
  ], { cols: 3 })}
</div>`;
}

/**
 * The two places, each an item headed by its moment: a plate on which the photo of February and the photo of
 * August at the same colour blink, and under it, joined to it, the cells of what was measured there.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function placeList(b, data) {
  const places = Array.isArray(data.track?.places) ? data.track.places : [];
  const frames = Array.isArray(data.templates?.frames) ? data.templates.frames : [];
  const items = [];
  for (const p of places) {
    const flux = typeof p.flux === 'string' ? p.flux : '', lam = flux.replace(/\.flux$/, '.lam');
    const early = frames[p.pair?.early], late = frames[p.pair?.late];
    // a place is shown whole or not at all: every figure of its cells is a number that exists
    const augLam = String(p.august_flux).replace(/\.flux$/, '.lam');
    const keys = [lam, flux, String(p.august_flux), `lemmon.track.offset.${p.night}`, augLam];
    if (!keys.every((k) => Object.hasOwn(b.numbers, k))) {
      for (const k of keys) if (!Object.hasOwn(b.numbers, k)) b.left.push(`number ${k}`);
      continue;
    }
    if (!Number.isFinite(p.mjd)) continue;
    const [colour, feb, aug, off, augColour] = keys.map((k) => numberSpan(b, k));
    const live = p.pair?.showcase === 'templates' && early && late
      ? `<figure class="place-blink" data-blink data-manifest="data/lemmon/templates/manifest.json" data-pair="${attr(`${p.pair.early},${p.pair.late}`)}"><div class="plate blink-box" data-box data-plate></div></figure>` : '';
    items.push(`<li class="place" data-night="${attr(p.night)}">
<h3 class="object-name place-when">${momentOf(p.mjd, true)}</h3>
<div class="plate-frame">
${live}
${live ? '<p class="plate-verdict" data-verdict data-plate aria-hidden="true"></p>' : ''}
${cellRow([
    ['August photo', early && Number.isFinite(early.mjd) ? dayOf(early.mjd) : '', ' data-visit="early"'],
    ['February photo', dayOf(p.mjd), ' data-visit="late"'],
    ['Colour, the closest match', `February ${colour} µm, August ${augColour} µm`],
    ['Brightness, February', `${feb} mJy`],
    ['Brightness, August', `${aug} mJy`],
    ['Place', `${off} of a pixel from where JPL Horizons predicts`],
  ], { cols: 2 })}
</div>
</li>`.replace(/\n{2,}/g, '\n'));
  }
  return items.length ? `<ol class="places">\n${items.join('\n')}\n</ol>` : '';
}

/**
 * The picture of the photos of both nights, colour by colour, on a plate, and the place where the live photos go.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function stripPart(b, data) {
  const frames = Array.isArray(data.strip?.frames) ? data.strip.frames : [];
  const band = Array.isArray(data.spectrum?.band) && data.spectrum.band.every(Number.isFinite) ? data.spectrum.band : null;
  const still = frames.length ? picture(b, 'data/lemmon/strip/strip.png',
    'Photos of the comet in two rows, one row for each night, in the order of their colour. In each row the comet is a faint smudge at the colours outside the band of carbon dioxide and a wide, bright glow at the colours inside it. One photo also holds a star beside the comet.') : '';
  if (!still) return '';
  return `<div class="strip" data-live data-strip data-manifest="data/lemmon/strip/manifest.json"${band ? ` data-band-from="${attr(band[0])}" data-band-to="${attr(band[1])}"` : ''}>
<div class="plate still" data-still data-plate>${still}</div>
</div>`;
}

/**
 * The chart of brightness against colour for both nights, as a drawing on a plate: a point for each photo, the two
 * neighbours ringed, the band of carbon dioxide shaded, and the same places in August in grey. Its key stands on
 * the plate with it, and the cells joined under it say what its two axes and its shaded strip are.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function chart(b, data) {
  const photos = photosOf(data.spectrum).filter((p) => Number.isFinite(p.flux)), nights = nightsOf(photos);
  if (photos.length < 4 || nights.length === 0) return '';
  const templates = (Array.isArray(data.spectrum.templates) ? data.spectrum.templates : []).filter((/** @type {any} */ t) => Number.isFinite(t?.template_lam) && Number.isFinite(t.template_flux));
  const band = Array.isArray(data.spectrum.band) && data.spectrum.band.every(Number.isFinite) ? data.spectrum.band : null;
  const neighbours = new Set(Object.values(data.spectrum.contrast ?? {}).flatMap((/** @type {any} */ c) => [c?.below, c?.above]));

  const W = 480, H = 336, left = 44, right = 10, top = 14, bottom = 44;
  const lams = photos.map((p) => p.lam), lo = Math.floor((Math.min(...lams) - 0.02) * 10) / 10, hi = Math.ceil((Math.max(...lams) + 0.02) * 10) / 10;
  const errs = (/** @type {any} */ v) => (Number.isFinite(v) ? v : 0);
  const peak = Math.max(...photos.map((p) => p.flux + errs(p.err)));
  const floor = Math.min(0, ...templates.map((/** @type {any} */ t) => t.template_flux - errs(t.template_err)));
  const step = peak > 200 ? 50 : peak > 80 ? 20 : 10;
  const yHi = Math.ceil(peak / step) * step, yLo = Math.floor(floor / step) * step;
  const x = (/** @type {number} */ v) => left + (v - lo) / (hi - lo) * (W - left - right);
  const y = (/** @type {number} */ v) => top + (yHi - v) / (yHi - yLo) * (H - top - bottom);

  const parts = [];
  if (band) {
    parts.push(`<rect class="chart-band" x="${r2(x(band[0]))}" y="${top}" width="${r2(x(band[1]) - x(band[0]))}" height="${H - top - bottom}"/>`);
    // the name of the band stands in two lines, so that it stays inside the strip it names
    const mid = r2((x(band[0]) + x(band[1])) / 2);
    parts.push(`<text class="chart-band-name" x="${mid}" y="${top + 13}" text-anchor="middle"><tspan x="${mid}">CARBON</tspan><tspan x="${mid}" dy="1.15em">DIOXIDE</tspan></text>`);
  }
  for (let v = yLo; v <= yHi + 1e-9; v += step) {
    parts.push(`<line class="${v === 0 ? 'chart-zero' : 'chart-grid'}" x1="${left}" x2="${W - right}" y1="${r2(y(v))}" y2="${r2(y(v))}"/><text class="chart-tick" x="${left - 6}" y="${r2(y(v) + 4)}" text-anchor="end">${v}</text>`);
  }
  for (let k = Math.round(lo * 10); k <= Math.round(hi * 10); k++) {
    const v = k / 10;
    parts.push(`<line class="chart-grid" x1="${r2(x(v))}" x2="${r2(x(v))}" y1="${H - bottom}" y2="${H - bottom + 4}"/><text class="chart-tick" x="${r2(x(v))}" y="${H - bottom + 17}" text-anchor="middle">${v.toFixed(1)}</text>`);
  }
  parts.push(`<text class="chart-axis" x="${r2((left + W - right) / 2)}" y="${H - 8}" text-anchor="middle">colour: wavelength in micrometres</text>`);
  parts.push(`<text class="chart-axis" transform="translate(12 ${r2((top + H - bottom) / 2)}) rotate(-90)" text-anchor="middle">brightness, millijanskys</text>`);

  for (const t of templates) {
    const cx = x(t.template_lam), cy = y(t.template_flux), e = errs(t.template_err);
    parts.push(`<g class="chart-august"><line x1="${r2(cx)}" x2="${r2(cx)}" y1="${r2(y(t.template_flux - e))}" y2="${r2(y(t.template_flux + e))}"/><path d="M${r2(cx)} ${r2(cy - 3.5)}L${r2(cx + 3.5)} ${r2(cy)}L${r2(cx)} ${r2(cy + 3.5)}L${r2(cx - 3.5)} ${r2(cy)}Z"/></g>`);
  }
  for (const [i, night] of nights.entries()) {
    const own = photos.filter((p) => p.night === night).sort((p, q) => p.lam - q.lam);
    parts.push(`<polyline class="chart-line" data-series="${i}" points="${own.map((p) => `${r2(x(p.lam))},${r2(y(p.flux))}`).join(' ')}"/>`);
  }
  for (const p of photos.slice().sort((a, b) => a.lam - b.lam)) {
    const cx = x(p.lam), cy = y(p.flux), e = errs(p.err), series = nights.indexOf(p.night);
    const mark = series === nights.length - 1
      ? `<rect class="chart-mark" x="${r2(cx - 3.4)}" y="${r2(cy - 3.4)}" width="6.8" height="6.8"/>`
      : `<circle class="chart-mark" cx="${r2(cx)}" cy="${r2(cy)}" r="3.6"/>`;
    const d = dateOf(p.mjd);
    const title = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC: colour ${p.lam.toFixed(3)}${p.star_in_aperture === true ? '; a star of the catalogue lies in the circle and adds to the brightness' : ''}`;
    parts.push(`<g class="chart-point" data-photo="${attr(p.id)}" data-series="${series}"><title>${esc(title)}</title>${e > 0 ? `<line class="chart-error" x1="${r2(cx)}" x2="${r2(cx)}" y1="${r2(y(p.flux - e))}" y2="${r2(y(p.flux + e))}"/>` : ''}${neighbours.has(p.obs) ? `<circle class="chart-neighbour" cx="${r2(cx)}" cy="${r2(cy)}" r="8"/>` : ''}${p.star_in_aperture === true ? `<path class="chart-star" d="M${r2(cx)} ${r2(cy - 8)}L${r2(cx + 8)} ${r2(cy)}L${r2(cx)} ${r2(cy + 8)}L${r2(cx - 8)} ${r2(cy)}Z"/>` : ''}${mark}</g>`);
  }
  const key = [
    ...nights.map((night, i) => `<li><svg class="chart-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g class="chart-point" data-series="${i}">${i === nights.length - 1 ? '<rect class="chart-mark" x="4.6" y="4.6" width="6.8" height="6.8"/>' : '<circle class="chart-mark" cx="8" cy="8" r="3.6"/>'}</g></svg>${dayOfNight(photos, night)}</li>`),
    templates.length ? '<li><svg class="chart-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g class="chart-august"><path d="M8 4.5L11.5 8L8 11.5L4.5 8Z"/></g></svg>the same sky at the same colour in August: no comet</li>' : '',
    neighbours.size ? '<li><svg class="chart-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle class="chart-neighbour" cx="8" cy="8" r="6"/></svg>the two neighbours, the nearest photos on either side of the band</li>' : '',
    photos.some((p) => p.star_in_aperture === true) ? '<li><svg class="chart-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path class="chart-star" d="M8 1L15 8L8 15L1 8Z"/></svg>a star of the catalogue lies in the circle and adds to the brightness</li>' : '',
  ].filter(Boolean);
  const shaded = band && Object.hasOwn(b.numbers, 'lemmon.band.from') && Object.hasOwn(b.numbers, 'lemmon.band.to')
    ? `The band of carbon dioxide, ${numberSpan(b, 'lemmon.band.from')} to ${numberSpan(b, 'lemmon.band.to')} µm` : '';
  return `<figure class="chart">
<div class="plate-frame">
<div class="plate chart-plate" data-plate>
<svg class="chart-plot" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="chart-title chart-desc">
<title id="chart-title">Brightness of the comet against colour, on both nights</title>
<desc id="chart-desc">On both nights the comet is many times brighter at the colours inside the band of carbon dioxide than at the colours on either side of it. In August, at the same places and colours, the brightness is close to zero. The table below gives every point.</desc>
${parts.join('\n')}
</svg>
<ul class="chart-key">
${key.join('\n')}
</ul>
</div>
${cellRow([
    ['Across', 'Colour: a wavelength, in micrometres (µm)'],
    ['Up', 'Brightness in millijanskys (mJy), a lower limit'],
    ['Shaded', shaded],
  ], { cols: 3 })}
</div>
</figure>`;
}

/**
 * The table behind the chart: every photo, with its time, its colour and its brightness.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function photoTable(b, data) {
  const photos = photosOf(data.spectrum).sort((p, q) => p.lam - q.lam);
  const contrast = data.spectrum?.contrast ?? {};
  const below = new Set(Object.values(contrast).map((/** @type {any} */ c) => c?.below)), above = new Set(Object.values(contrast).map((/** @type {any} */ c) => c?.above));
  const peaks = new Set(Object.values(contrast).map((/** @type {any} */ c) => c?.peak));
  const rows = [];
  let unmeasured = 0;
  for (const p of photos) {
    // a photo that could not be measured has no brightness and is not among the numbers: it is counted, not listed
    if (!Number.isFinite(p.flux) || !Object.hasOwn(b.numbers, `lemmon.frame.${p.id}.lam`)) {
      unmeasured++;
      continue;
    }
    const lam = numberSpan(b, `lemmon.frame.${p.id}.lam`), flux = numberSpan(b, `lemmon.frame.${p.id}.flux`);
    if (!lam || !flux) continue;
    const notes = [
      p.inside === true ? 'inside the band' : '',
      peaks.has(p.obs) ? 'the brightest of its night' : '',
      below.has(p.obs) ? 'the neighbour below the band' : '',
      above.has(p.obs) ? 'the neighbour above the band' : '',
      p.star_in_aperture === true ? 'a star of the catalogue lies in the circle and adds to this' : '',
    ].filter(Boolean).join('; ');
    rows.push(`<tr data-photo="${attr(p.id)}" data-key="${attr(p.key ?? '')}" data-night="${attr(p.night)}" data-inside="${p.inside === true}"><td>${momentOf(p.mjd)}</td><td>${lam}</td><td data-flux>${flux}</td><td>${esc(notes)}</td></tr>`);
  }
  if (!rows.length) return '';
  const measured = fill(b, 'The {{lemmon.photos.measured}} photos that could be measured, in the order of their colour.');
  const caption = measured && b.numbers['lemmon.photos.measured'].value === rows.length
    ? `${measured}${unmeasured === 1 ? ' One more photo has too many faulty pixels inside the circle and gives no brightness.' : ''}`
    : 'The photos that could be measured, in the order of their colour.';
  return `<div class="table-scroll" tabindex="0" role="group" aria-label="Table of the photos">
<table class="ledger photos">
<caption>${caption}</caption>
<thead>
<tr><th scope="col">Taken</th><th scope="col">Colour, in micrometres</th><th scope="col">Brightness, in millijanskys</th><th scope="col">Notes</th></tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>`;
}

/**
 * Which photos the brightest photo of each night is compared with, and from which night each of them comes: a
 * ledger with a line for each night.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function neighbourWords(b, data) {
  const photos = photosOf(data.spectrum), nights = nightsOf(photos).reverse();
  const out = [];
  for (const night of nights) {
    const c = data.spectrum?.contrast?.[night];
    const find = (/** @type {unknown} */ obs) => photos.find((p) => p.obs === obs);
    const peak = find(c?.peak), below = find(c?.below), above = find(c?.above);
    if (!peak || !below || !above) continue;
    /** A photo as a cell: its colour and its brightness, and the night it was taken on when that is the other one. @param {any} p */
    const cell = (p) => {
      const words = fill(b, `colour {{lemmon.frame.${p.id}.lam}}, brightness {{lemmon.frame.${p.id}.flux}}`);
      return words === '' ? '' : `${words}${p.night === night ? '' : `; photographed on the other night, ${dayOfNight(photos, p.night)}`}`;
    };
    const cells = [cell(peak), cell(below), cell(above), fill(b, `{{lemmon.contrast.${night}.exact}} times, give or take {{lemmon.contrast.${night}.err}}`)];
    if (cells.some((html) => html === '')) continue;
    out.push(`<tr data-night="${attr(night)}"><th scope="row">${dayOfNight(photos, night)}</th>${cells.map((html) => `<td>${html}</td>`).join('')}</tr>`);
  }
  if (!out.length) return '';
  return `<div class="table-scroll" tabindex="0" role="group" aria-label="Table of the brightest photo of each night and its two neighbours">
<table class="ledger photos neighbours">
<caption>The brightest photo inside the band is set against the mean of its two neighbours: the nearest photos on either side of the band. Colours are in micrometres, brightness in millijanskys.</caption>
<thead>
<tr><th scope="col">Night</th><th scope="col">Brightest photo inside the band</th><th scope="col">Nearest photo below the band</th><th scope="col">Nearest photo above the band</th><th scope="col">Brighter by</th></tr>
</thead>
<tbody>
${out.join('\n')}
</tbody>
</table>
</div>`;
}

/**
 * The same sky without the comet: for each photo inside the band, the photo of August at the same colour.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function sameSky(b, data) {
  const photos = photosOf(data.spectrum);
  const list = Array.isArray(data.spectrum?.templates) ? data.spectrum.templates : [];
  const rows = [];
  for (const t of list) {
    const p = photos.find((x) => x.obs === t.obs);
    if (!p || !Number.isFinite(t.template_mjd)) continue;
    const cells = [`lemmon.frame.${p.id}.lam`, `lemmon.frame.${p.id}.flux`, `lemmon.template.${p.id}.flux`, `lemmon.template.${p.id}.apart`].map((k) => numberSpan(b, k));
    if (cells.some((c) => c === '')) continue;
    rows.push(`<tr data-photo="${attr(p.id)}"><td>${cells[0]}</td><td>${dayOf(p.mjd)}</td><td>${cells[1]}</td><td>${dayOf(t.template_mjd)}</td><td>${cells[2]}</td><td>${cells[3]}</td></tr>`);
  }
  const still = rows.length ? picture(b, 'data/lemmon/templates/templates.png',
    'Rows of three pictures, one row for each photo of the comet inside the band. Left: the comet in February, a wide glow. Middle: the same patch of sky at the same colour in August, with stars and no comet. Right: the February photo minus the August photo, where the glow remains.') : '';
  if (!still) return '';
  return `<figure class="same-sky">
<div class="plate-frame">
<div class="plate still" data-plate>${still}</div>
${cellRow([
    ['Left', 'The comet in February'],
    ['Middle', 'The same patch of sky at the same colour in August'],
    ['Right', 'February minus August, in units of the noise: black is darker than in August, white brighter'],
  ], { cols: 3 })}
</div>
<figcaption>Each row is one photo of the comet inside the band. Dark violet marks a pixel that has no value in one of the two photos.</figcaption>
</figure>
<div class="table-scroll" tabindex="0" role="group" aria-label="Table of the photos of February and of August at the same colour">
<table class="ledger photos">
<caption>The comet's photos inside the band, and the same sky in August</caption>
<thead>
<tr><th scope="col">Colour, in micrometres</th><th scope="col">Comet photo</th><th scope="col">Brightness, in millijanskys</th><th scope="col">August photo</th><th scope="col">Brightness there</th><th scope="col">Their colours differ by, in nanometres</th></tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>`;
}

/**
 * The contrast with one photo left out, as it was measured: a row for each photo whose absence changes a figure,
 * and one row for all the photos whose absence changes nothing.
 * @param {Build} b @param {CometData} data
 * @returns {string}
 */
function leftOut(b, data) {
  const rows = leftOutRows(data), photos = photosOf(data.spectrum), nights = nightsOf(photos);
  if (!rows.length || !nights.length) return '';
  const ROLE = /** @type {Record<string, string>} */ ({ peak: 'the brightest photo of its night', neighbour: 'one of the two neighbours' });
  const lines = [];
  for (const r of rows.filter((x) => x.changes)) {
    const cells = [numberSpan(b, `lemmon.frame.${r.id}.lam`), ...r.nights.map((n) => numberSpan(b, `v4.leftout.${r.id}.${n.name}`))];
    if (cells.some((c) => c === '')) continue;
    lines.push(`<tr data-photo="${attr(r.id)}" data-role="${attr(r.role)}"><th scope="row">Colour ${cells[0]}, ${dayOf(r.mjd)}${ROLE[r.role] ? `: ${ROLE[r.role]}` : ''}</th>${cells.slice(1).map((c) => `<td>${c}</td>`).join('')}</tr>`);
  }
  const same = rows.filter((x) => !x.changes).length;
  if (same > 0) {
    const cells = [numberSpan(b, 'v4.leftout.same'), ...nights.map((n) => numberSpan(b, `lemmon.contrast.${n}.exact`))];
    if (cells.every((c) => c !== '')) lines.push(`<tr data-role="other"><th scope="row">Any one of the other ${cells[0]} photos</th>${cells.slice(1).map((c) => `<td>${c}</td>`).join('')}</tr>`);
  }
  if (!lines.length) return '';
  return `<div class="table-scroll" tabindex="0" role="group" aria-label="Table of the contrast with one photo left out">
<table class="ledger photos leftout">
<caption>The contrast when one photo is left out</caption>
<thead>
<tr><th scope="col">Photo left out</th>${nights.map((n) => `<th scope="col">Contrast on ${dayOfNight(photos, n)}</th>`).join('')}</tr>
</thead>
<tbody>
${lines.join('\n')}
</tbody>
</table>
</div>`;
}

/**
 * What is known in the literature, from the row that holds the search: what the search found and its date once it
 * is written there, and until then the plain statement that it is not.
 * @param {Build} b
 * @returns {string}
 */
function literature(b) {
  const row = b.rows.find((r) => r.id === 'K14');
  if (!row) return '';
  const found = typeof row.value === 'string' && row.value !== '' ? row.value : '';
  const tag = tagLink(b, 'K14');
  if (found && row.reviewed_on) return `<p>${markDates(esc(found))} Searched by hand; the date of the search is ${dateWords(row.reviewed_on)}. ${tag}</p>`;
  if (found) return `<p>Our search of what others have published, by hand: ${markDates(esc(found))}. That is not proof that nobody has measured it. The entry of the check lists the sources searched and still waits for a person to sign it. ${tag}</p>`;
  return `<p>Whether this gas has been measured in this comet before has not been searched yet. The search is done by hand, and its result and its date will stand in the entry of that check. ${tag}</p>`;
}

/**
 * The parts of the page, by the name of the element that holds each. A part whose data is not there is empty.
 * @param {Build} b @param {CometData} data
 * @returns {Record<string, string>}
 */
export function buildComet(b, data) {
  const still = data.track ? picture(b, 'data/lemmon/track.png', 'A map of the path of the comet over the two nights, with a ring at each of the two places where it was photographed inside the band of carbon dioxide, and beside it four small pictures: each place in August, with stars and no comet, and in February, with the comet as a wide glow.') : '';
  return {
    wide: widePlate(b, data),
    'track-map': trackMap(data),
    'track-still': still ? `<div class="plate still" data-plate>${still}</div>` : '',
    places: placeList(b, data),
    strip: stripPart(b, data),
    chart: chart(b, data),
    photos: photoTable(b, data),
    neighbours: neighbourWords(b, data),
    'same-sky': sameSky(b, data),
    leftout: leftOut(b, data),
    literature: literature(b),
  };
}

// ---------------------------------------------------------------------------------------------
// In the page
// ---------------------------------------------------------------------------------------------

/**
 * The live photos of both nights. One photo stands large on a plate, with its date, its colour and its brightness
 * in the cells joined to it; whether it lies inside the band of carbon dioxide is said on the plate itself. Under
 * it runs one ruler of colour with the band marked on it, and a chip that steps through the photos in the order
 * of their colour; the small photos of each night hang from that ruler, each at its colour, and each is a button.
 * The picture the page holds stays when the showcase cannot be had.
 * @param {HTMLElement} root  The element marked `data-strip`; it names its showcase in `data-manifest`.
 * @returns {Promise<boolean>}  True when the live photos are in place.
 */
export async function mountStrip(root) {
  const address = root.dataset.manifest;
  if (!address) return false;
  const showcase = await loadShowcase(new URL(address, document.baseURI));
  if (!showcase) return false;
  const north = /** @type {{grid?: string}} */ (showcase.manifest).grid === 'north-up';
  const ref = showcase.photos[showcase.photos.length - 1];
  const photos = showcase.photos.filter((p) => {
    if (north) p.turn = 0;
    return north || lineUp(ref, p);
  }).sort((p, q) => p.lam - q.lam);
  const rule = displayRule(photos);
  if (photos.length < 2 || !rule) return false;
  const size = viewSize(photos);

  // what the page already says about each photo: its row in the table of photos, found by the name of its file
  /** @param {Photo} p */
  const rowOf = (p) => [...document.querySelectorAll('tr[data-key]')].find((tr) => /** @type {HTMLElement} */ (tr).dataset.key === p.key);
  /** @param {Photo} p */
  const nightOf = (p) => /** @type {HTMLElement | undefined} */ (rowOf(p))?.dataset.night ?? formatDay(p.mjd);
  /** @param {Photo} p */
  const fluxOf = (p) => rowOf(p)?.querySelector('[data-flux]')?.textContent?.trim() ?? '';
  const from = Number(root.dataset.bandFrom), to = Number(root.dataset.bandTo);
  /** @param {Photo} p */
  const inside = (p) => Number.isFinite(from) && Number.isFinite(to) && p.lam >= from && p.lam <= to;

  // capitals are written as capitals: what stands on the plate and what the form prints on the ruler
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  // the verdict stands on a black band under the plate, inside its frame
  const verdict = el('p', { class: 'plate-verdict', 'data-plate': '', 'aria-hidden': 'true' });
  const plate = el('div', { class: 'plate strip-plate', 'data-plate': '' }, [canvas, el('span', { class: 'plate-mark', 'aria-hidden': 'true' })]);
  // three cells in fixed slots; what they say changes in place
  const cell = (/** @type {string} */ label, /** @type {boolean} */ words = false) => {
    const value = el('span', { class: words ? 'cell-value is-prose' : 'cell-value' });
    return { value, cell: el('span', { class: 'cell' }, [el('span', { class: 'cell-label', text: label }), value]) };
  };
  const taken = cell('Taken'), colour = cell('Colour', true), brightness = cell('Brightness', true);
  const readout = el('p', { class: 'cells strip-readout', role: 'status' }, [taken.cell, colour.cell, brightness.cell]);

  const lo = photos[0].lam, hi = photos[photos.length - 1].lam, pad = Math.max((hi - lo) * 0.06, 1e-6);
  /** Where a colour lies on the ruler, 0 to 1000. @param {number} lam */
  const at = (lam) => Math.round(1000 * (lam - lo + pad) / (hi - lo + 2 * pad));
  const input = el('input', { type: 'range', class: 'scale-input', id: 'strip-colour', min: '0', max: '1000', step: '1' });
  const ticks = el('ol', { class: 'scale-ticks', 'aria-hidden': 'true' }, photos.map((p, i) => {
    const tick = el('li', { class: `scale-tick${i === 0 || i === photos.length - 1 ? '' : ' scale-tick-quiet'}`, style: `--at: ${at(p.lam) / 10}%` }, [el('span', { class: 'scale-tick-value', text: formatColour(p.lam) })]);
    if (inside(p)) tick.dataset.det = String(p.det);
    return tick;
  }));
  const bandMark = Number.isFinite(from) && Number.isFinite(to)
    ? el('span', { class: 'scale-band', style: `--from: ${at(from) / 10}%; --to: ${at(to) / 10}%` }, [el('span', { class: 'scale-band-name', text: 'CARBON DIOXIDE' })])
    : null;
  const scale = el('div', { class: 'scale', 'data-det': String(photos[0].det) }, [
    el('label', { class: 'scale-label', for: 'strip-colour' }, ['Colour of the photo', el('span', { class: 'scale-unit', text: ', in micrometres' })]),
    el('div', { class: 'scale-track' }, [...(bandMark ? [el('div', { class: 'scale-under', 'aria-hidden': 'true' }, [bandMark])] : []), input, ticks]),
  ]);

  // a row of small photos for each night: each hangs from the ruler at its colour
  /** @type {Map<string, Photo[]>} */
  const nights = new Map();
  for (const p of photos) nights.set(nightOf(p), [...(nights.get(nightOf(p)) ?? []), p]);
  /** @type {Map<Photo, HTMLButtonElement>} */
  const thumbs = new Map();
  const rows = [...nights.values()].sort((a, b) => a[0].mjd - b[0].mjd).map((list) => {
    const buttons = list.map((p) => {
      const small = el('canvas', { 'aria-hidden': 'true' });
      paintPhoto(small, p, rule, size);
      const button = el('button', { type: 'button', class: 'strip-thumb', 'aria-pressed': 'false', 'aria-label': `${formatDay(p.mjd)}, ${formatTime(p.mjd)}, colour ${formatColour(p.lam)}` }, [
        el('span', { class: 'strip-thumb-photo' }, [small]), el('span', { class: 'strip-thumb-colour', text: formatColour(p.lam) }),
      ]);
      if (inside(p)) button.dataset.inside = 'true';
      button.addEventListener('click', () => go(photos.indexOf(p)));
      thumbs.set(p, button);
      return el('li', { style: `--at: ${at(p.lam) / 10}%` }, [button]);
    });
    return el('div', { class: 'strip-night' }, [el('p', { class: 'label', text: formatDay(list[0].mjd).toUpperCase() }), el('ul', { class: 'strip-row' }, buttons)]);
  });

  let now = photos.findIndex(inside);
  if (now < 0) now = 0;
  // start on the brightest photo: the one with the highest value at the mark
  let best = -Infinity;
  for (const [i, p] of photos.entries()) {
    const v = p.shown[Math.round(p.ty) * p.w + Math.round(p.tx)] - p.sky;
    if (inside(p) && v > best) { best = v; now = i; }
  }

  const render = () => {
    const p = photos[now];
    paintPhoto(canvas, p, rule, size);
    verdict.textContent = inside(p) ? 'IN THE BAND' : 'OUTSIDE THE BAND';
    plate.dataset.inside = String(inside(p));
    const flux = fluxOf(p);
    taken.value.textContent = `${formatDay(p.mjd)}, ${formatTime(p.mjd)}`;
    colour.value.textContent = `${formatColour(p.lam)} µm, ${inside(p) ? 'inside the band of carbon dioxide' : 'outside the band'}`;
    // a photo that could not be measured leaves its slot empty: the stylesheet draws a dash there
    brightness.value.textContent = flux ? `${flux} millijanskys, a lower limit` : '';
    input.value = String(at(p.lam));
    input.setAttribute('aria-valuetext', `${formatColour(p.lam)} micrometres: photo ${now + 1} of ${photos.length}, ${formatDay(p.mjd)}, ${formatTime(p.mjd)}`);
    for (const [i, tick] of [...ticks.children].entries()) tick.classList.toggle('is-current', i === now);
    for (const [photo, button] of thumbs) button.setAttribute('aria-pressed', String(photo === p));
    const id = /** @type {HTMLElement | undefined} */ (rowOf(p))?.dataset.photo;
    for (const point of document.querySelectorAll('.chart-point[data-photo]')) point.classList.toggle('is-current', /** @type {SVGElement} */ (point).dataset.photo === id);
  };
  /** @param {number} to */
  function go(to) {
    now = Math.max(0, Math.min(photos.length - 1, to));
    render();
  }
  input.addEventListener('input', () => {
    const want = Number(input.value);
    let nearest = 0;
    for (const [i, p] of photos.entries()) if (Math.abs(at(p.lam) - want) < Math.abs(at(photos[nearest].lam) - want)) nearest = i;
    go(nearest);
  });
  input.addEventListener('keydown', (event) => {
    const step = /** @type {Record<string, number>} */ ({ ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1 })[event.key];
    if (step !== undefined) go(now + step);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(photos.length - 1);
    else return;
    event.preventDefault();
  });

  const still = root.querySelector('[data-still]');
  if (still instanceof HTMLElement) still.hidden = true;
  root.append(el('div', { class: 'strip-live' }, [
    el('div', { class: 'plate-frame strip-stage' }, [plate, verdict, readout]),
    // the ruler and what hangs from it are a drawing made of data: they stand on a plate
    el('div', { class: 'strip-ruler', 'data-plate': '' }, [scale, ...rows]),
  ]));
  root.classList.add('is-live');
  render();
  return true;
}

function start() {
  // the two places and the strip are drawn at once, so that no plate of the page stands empty; a blink plays
  // while it is in view and has not been paused
  for (const figure of document.querySelectorAll('.place [data-blink]')) {
    if (!(figure instanceof HTMLElement)) continue;
    mountBlink(figure).then((blink) => { if (!blink) figure.hidden = true; }, () => { figure.hidden = true; });
  }
  const strip = document.querySelector('[data-strip]');
  if (strip instanceof HTMLElement) {
    mountStrip(strip).then((live) => { if (!live) strip.classList.add('is-still'); }, () => strip.classList.add('is-still'));
  }
}

if (typeof document !== 'undefined') start();
