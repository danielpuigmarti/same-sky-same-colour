// "Is it real?": four plain answers about a blip, from the photos that are loaded, before anyone thinks it is real.
//
//   flagged       is the pixel flagged in either photo of the pair that shows it most? (the tiers "saturation" and
//                 "defect" of lib/flags.js; SOURCE alone is not a flag)
//   more than one is it there, with the same sign and at 3 times the noise or more, within one pixel of the same place,
//   pair          in at least two pairs of photos?
//   catalogue     is a catalogued source within 2 pixels? Two things are looked at: the archive's own mask of known
//                 sources (the SOURCE flag, counted when the source is bright in both photos) and the bright stars of
//                 data/gaia/fast.json. No other catalogue is in the page.
//   ring          is a fast star predicted within 2 pixels on the date of either photo? (rings.js)
//
// Nothing is stored and nothing is sent. The first half of this file has no need of a page; createIsItReal builds
// the panel in one.

/** @import { Stamp, Det } from '../contracts.js' */
/** @import { LocalSky } from './stage.js' */
/** @import { Ring, FastStar } from './rings.js' */
import { MATCH_MAX_PAIRS } from '../contracts.js';
import { flagRows, SATURATION_MASK, DEFECT_MASK, SOURCE_MASK } from '../lib/flags.js';
import { matchPairs } from '../lib/match.js';
import { stampStats } from '../lib/stack.js';
import { formatSky } from './hover.js';
import { formatDate } from './stage.js';
import { ringsFor, skyToPixel } from './rings.js';

/** A residual counts as showing in a pair at this many times the noise of the pair. */
export const RESIDUAL_UNITS = 3;
/** A marked source counts as a bright star when it stands this many times the noise above the sky in both photos. */
export const BRIGHT_UNITS = 10;
/** How far a catalogued star or a ring may be from the blip, pixels. */
export const NEAR_PX = 2;
/** How far from the same place a residual may be in another pair, pixels. */
export const SAME_PLACE_PX = 1;

export const BACKYARD_WORLDS_URL = 'https://www.backyardworlds.org/';
export const MPC_URL = 'https://www.minorplanetcenter.net/';

/** The line that always closes the answers. */
export const CAUTION = 'Most blips that pass these checks are still artefacts or known objects.';
/** The line for a blip that none of the checks explains. */
export const NOT_KNOWN = 'Not a known star; asteroids are not checked here.';

/**
 * A stamp as the panels get it: the shared form on the display grid, with `sky`.
 * @typedef {Stamp & {sky?: LocalSky | null}} Picture
 */

/**
 * One loaded photo, with what the panels need to know about it.
 * @typedef {Object} Item
 * @property {number} index  Position in the list of stamps given.
 * @property {Picture} stamp
 * @property {string} key
 * @property {number} mjd
 * @property {number} visit  The visit it belongs to, counted up in time.
 */

/** @type {WeakMap<object, {background: number, noise: number, n: number}>} */
const statsCache = new WeakMap();

/**
 * Background and noise of a stamp (CT-7), measured once.
 * @param {Picture} stamp
 * @returns {{background: number, noise: number, n: number}}
 */
export function statsOf(stamp) {
  let s = statsCache.get(stamp);
  if (!s) {
    const { background, noise, n } = stampStats(stamp.data, stamp.flags);
    s = { background, noise, n };
    statsCache.set(stamp, s);
  }
  return s;
}

/**
 * The visit of each stamp: the number the frames list gives, else a new visit after a gap of more than 10 days.
 * @param {Picture[]} stamps
 * @param {{key: string, visit?: number}[]} frames
 * @returns {Item[]}
 */
export function itemsOf(stamps, frames) {
  const visitOf = new Map(frames.map((f) => [f.key, f.visit]));
  const order = stamps.map((s, i) => i).sort((p, q) => stamps[p].mjd - stamps[q].mjd);
  /** @type {Map<number, number>} */
  const guess = new Map();
  let v = 0, last = NaN;
  for (const i of order) {
    if (Number.isFinite(last) && stamps[i].mjd - last > 10) v++;
    guess.set(i, v);
    last = stamps[i].mjd;
  }
  return stamps.map((stamp, index) => {
    const known = visitOf.get(stamp.key);
    return { index, stamp, key: stamp.key, mjd: stamp.mjd, visit: Number.isFinite(known) ? /** @type {number} */ (known) : /** @type {number} */ (guess.get(index)) };
  });
}

/**
 * The two visits compared and their matched pairs (CT-6). When the photos selected for blinking lie in two or more
 * visits, the first and the last of those; otherwise the two visits with the most matched pairs between them and, among
 * equals, the two farthest apart.
 * @param {Item[]} items
 * @param {string[]} [selection]  Keys of the photos on the stage.
 * @returns {{a: number, b: number, pairs: [Item, Item][]} | null}
 */
export function choosePairs(items, selection = []) {
  const picked = new Set(selection);
  const chosen = [...new Set(items.filter((it) => picked.has(it.key)).map((it) => it.visit))].sort((p, q) => p - q);
  const all = [...new Set(items.map((it) => it.visit))].sort((p, q) => p - q);
  /** @type {[number, number][]} */
  const combos = [];
  if (chosen.length >= 2) combos.push([chosen[0], chosen[chosen.length - 1]]);
  else for (const [i, a] of all.entries()) for (const b of all.slice(i + 1)) combos.push([a, b]);
  /** @type {{a: number, b: number, pairs: [Item, Item][], gap: number} | null} */
  let best = null;
  for (const [a, b] of combos) {
    const A = items.filter((it) => it.visit === a), B = items.filter((it) => it.visit === b);
    const got = matchPairs(A.map(matchable), B.map(matchable)).slice(0, MATCH_MAX_PAIRS);
    if (!got.length) continue;
    const gap = Math.abs(Math.min(...B.map((it) => it.mjd)) - Math.min(...A.map((it) => it.mjd)));
    if (best === null || got.length > best.pairs.length || (got.length === best.pairs.length && gap > best.gap)) {
      best = { a, b, gap, pairs: got.map(([i, j]) => /** @type {[Item, Item]} */ ([A[i], B[j]])) };
    }
  }
  return best ? { a: best.a, b: best.b, pairs: best.pairs } : null;
}

/** @param {Item} it */
const matchable = (it) => ({ det: /** @type {Det} */ (it.stamp.det), lam: it.stamp.lam, bw: it.stamp.bw });

/**
 * Where the clicked place is on the grid of the pictures: the pixel the page gives, else the pixel of the sky position.
 * @param {{ra?: number, dec?: number, x?: number, y?: number}} pick
 * @param {Picture[]} stamps
 * @returns {[number, number] | null}
 */
export function placeOf(pick, stamps) {
  if (Number.isFinite(pick.x) && Number.isFinite(pick.y)) return [/** @type {number} */ (pick.x), /** @type {number} */ (pick.y)];
  const s = stamps.find((p) => p.sky);
  if (s?.sky && Number.isFinite(pick.ra) && Number.isFinite(pick.dec)) {
    const [x, y] = skyToPixel(s.sky, s.tx, s.ty, /** @type {number} */ (pick.ra), /** @type {number} */ (pick.dec));
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  return null;
}

/**
 * The pixels of a stamp whose centres lie within `r` of (x, y).
 * @param {Picture} s @param {number} x @param {number} y @param {number} r
 * @returns {number[]}  Indices into s.data.
 */
export function disc(s, x, y, r) {
  /** @type {number[]} */
  const out = [];
  const x0 = Math.max(0, Math.ceil(x - r)), x1 = Math.min(s.w - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.ceil(y - r)), y1 = Math.min(s.h - 1, Math.floor(y + r));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (Math.hypot(i - x, j - y) <= r + 1e-9) out.push(j * s.w + i);
  return out;
}

/**
 * How far above its sky a place stands in one photo: the largest (value - background) / noise within `r` pixels.
 * NaN when the photo has no background or no pixel there.
 * @param {Picture} s @param {number} x @param {number} y @param {number} [r]
 * @returns {number}
 */
export function excessAt(s, x, y, r = SAME_PLACE_PX) {
  const { background, noise } = statsOf(s);
  if (!(noise > 0)) return NaN;
  let best = NaN;
  for (const i of disc(s, x, y, r)) {
    const v = s.data[i];
    if (!Number.isFinite(v)) continue;
    const u = (v - background) / noise;
    if (!(u <= best)) best = u;
  }
  return best;
}

/**
 * The residual of a pair at a place: later minus earlier, each with its own background taken off, in units of the two
 * noises added in quadrature; the pixel within `r` of the place where it is largest in size.
 * @param {Picture} a @param {Picture} b @param {number} x @param {number} y @param {number} [r]
 * @returns {{units: number, x: number, y: number} | null}  Null when the two do not share a grid or have no pixel there.
 */
export function residualAt(a, b, x, y, r = SAME_PLACE_PX) {
  if (a.w !== b.w || a.h !== b.h) return null;
  const sa = statsOf(a), sb = statsOf(b);
  const sigma = Math.hypot(sa.noise, sb.noise);
  if (!(sigma > 0)) return null;
  /** @type {{units: number, x: number, y: number} | null} */
  let best = null;
  for (const i of disc(a, x, y, r)) {
    const u = (b.data[i] - sb.background - (a.data[i] - sa.background)) / sigma;
    if (Number.isFinite(u) && (best === null || Math.abs(u) > Math.abs(best.units))) best = { units: u, x: i % a.w, y: Math.floor(i / a.w) };
  }
  return best;
}

/**
 * One of the four answers. `answer` is null when the loaded photos cannot tell.
 * @typedef {Object} Answer
 * @property {boolean | null} answer
 * @property {string} text  One plain sentence.
 */

/**
 * What the panel says about one place.
 * @typedef {Object} Assessment
 * @property {boolean} ready  False when there are not two matched photos to look at; `why` says what is missing.
 * @property {string} why
 * @property {number} ra  Degrees of the place; NaN when the pictures have no sky.
 * @property {number} dec
 * @property {Answer} flagged
 * @property {string[]} flagNames  The flags found, in either photo of the pair.
 * @property {Answer} pairs
 * @property {number} pairsShowing
 * @property {number} pairsTotal
 * @property {Answer} catalogue
 * @property {Answer} ring
 * @property {Ring[]} rings  The rings found within NEAR_PX.
 * @property {string} verdict
 * @property {string} caution
 * @property {string} photos  The two photos of the pair that shows it most: dates and file names, for the summary.
 */

/**
 * An assessment that says why it cannot be made.
 * @param {string} why
 * @returns {Assessment}
 */
export const notReady = (why) => ({
  ready: false, why, ra: NaN, dec: NaN, flagged: { answer: null, text: '' }, flagNames: [], pairs: { answer: null, text: '' }, pairsShowing: 0, pairsTotal: 0,
  catalogue: { answer: null, text: '' }, ring: { answer: null, text: '' }, rings: [], verdict: '', caution: CAUTION, photos: '',
});

/** @param {number} word */
const flaggedNames = (word) => flagRows(word & (SATURATION_MASK | DEFECT_MASK)).map((r) => r.name);

/**
 * Answer the four questions for a place.
 * @param {Object} q
 * @param {{ra?: number, dec?: number, x?: number, y?: number}} q.pick
 * @param {Picture[]} q.stamps  The photos loaded, on the display grid.
 * @param {{key: string, visit?: number}[]} [q.frames]
 * @param {string[]} [q.selection]  Keys of the photos on the stage.
 * @param {FastStar[]} [q.stars]  The fast stars; default the stars in use (rings.js).
 * @returns {Assessment}
 */
export function assess({ pick, stamps, frames = [], selection = [], stars }) {
  const place = placeOf(pick, stamps);
  if (!place) return notReady('Click a place in the picture.');
  const chosen = choosePairs(itemsOf(stamps, frames), selection);
  if (!chosen) return notReady('Two visits at the same colour have to be loaded first.');
  const [x, y] = place;

  // the pair that shows the place most, and the sign of what it shows
  const found = chosen.pairs.map(([a, b]) => ({ a, b, r: residualAt(a.stamp, b.stamp, x, y) }));
  const usable = found.filter((f) => f.r !== null);
  if (!usable.length) return notReady('The photos around this place cannot be compared: they have no pixels there.');
  const main = usable.reduce((p, q) => (Math.abs(/** @type {{units: number}} */ (q.r).units) > Math.abs(/** @type {{units: number}} */ (p.r).units) ? q : p));
  const sign = Math.sign(/** @type {{units: number}} */ (main.r).units) || 1;
  const rx = /** @type {{x: number}} */ (main.r).x, ry = /** @type {{y: number}} */ (main.r).y;
  const photos = [main.a, main.b];

  // 1. flagged
  const word = photos.reduce((acc, it) => {
    const s = it.stamp;
    return acc | (s.flags && rx >= 0 && rx < s.w && ry >= 0 && ry < s.h ? s.flags[ry * s.w + rx] : 0);
  }, 0);
  const haveFlags = photos.some((it) => it.stamp.flags);
  const names = flaggedNames(word);
  /** @type {Answer} */
  const flagged = !haveFlags
    ? { answer: null, text: 'The flags of these photos are not loaded, so this cannot be told.' }
    : names.length
      ? { answer: true, text: `Yes: the pixel is flagged ${names.join(', ')}. A flagged pixel is a defect of the detector or an echo, not the sky.` }
      : { answer: false, text: 'No: none of the pixel flags that mark a defect is set in either photo.' };

  // 2. more than one pair
  const showing = usable.filter((f) => /** @type {{units: number}} */ (f.r).units * sign >= RESIDUAL_UNITS && Math.hypot(/** @type {{x: number}} */ (f.r).x - rx, /** @type {{y: number}} */ (f.r).y - ry) <= SAME_PLACE_PX + 0.01).length;
  /** @type {Answer} */
  const pairs = usable.length < 2
    ? { answer: null, text: 'Only one pair of photos is loaded, so this cannot be told. More colours would add pairs.' }
    : showing >= 2
      ? { answer: true, text: `Yes: it shows at ${RESIDUAL_UNITS} times the noise or more in ${showing} of ${usable.length} pairs.` }
      : { answer: false, text: `No: it shows in ${showing} of ${usable.length} pairs. A change in the sky should show in every pair at the same colour.` };

  // 3 and 4. a catalogued source, a ring
  const [rra, rdec] = main.a.stamp.sky ? skyAtPixel(main.a.stamp, rx, ry) : [NaN, NaN];
  /** @type {Ring[]} */
  const rings = [];
  let skyChecked = false;
  for (const it of photos) {
    const s = it.stamp;
    if (!s.sky) continue;
    skyChecked = true;
    for (const r of ringsFor({ sky: s.sky, mjd: s.mjd, size: { w: s.w, h: s.h }, tx: s.tx, ty: s.ty, margin: NEAR_PX + 1, stars })) {
      if (Math.hypot(r.x - rx, r.y - ry) <= NEAR_PX && !rings.some((q) => q.id === r.id)) rings.push(r);
    }
  }
  // the archive marks catalogued sources in its flags; one that is bright in both photos is a steady star, not a blip
  const onSource = photos.every((it) => {
    const s = it.stamp, { background, noise } = statsOf(s);
    return Boolean(s.flags) && noise > 0 && disc(s, rx, ry, NEAR_PX).some((i) => /** @type {Int32Array} */ (s.flags)[i] & SOURCE_MASK && (s.data[i] - background) / noise >= BRIGHT_UNITS);
  });
  const brightFast = rings.filter((r) => r.g !== null && r.g <= 14);
  const limit = 'Only the archive\'s own mask of known sources and the list of fast stars are checked; no other star catalogue is loaded here.';
  /** @type {Answer} */
  const catalogue = onSource || brightFast.length
    ? { answer: true, text: `Yes: ${[onSource ? 'the archive marks a known source (SOURCE) within 2 pixels and it is bright in both photos' : '', brightFast.length ? `the fast star ${brightFast[0].name} (G ${brightFast[0].g}) is within 2 pixels` : ''].filter(Boolean).join('; ')}.` }
    : { answer: false, text: `No catalogued source within 2 pixels. ${limit}` };
  /** @type {Answer} */
  const ring = rings.length
    ? { answer: true, text: `Yes: ${rings[0].name} is predicted within 2 pixels on the date of the photos${rings.length > 1 ? `, and ${rings.length - 1} more` : ''}. It moves ${rings[0].arcsecPerYear.toFixed(1)} arcsec a year.` }
    : skyChecked
      ? { answer: false, text: 'No: none of the fast stars in the list is predicted within 2 pixels.' }
      : { answer: null, text: 'The pictures have no sky position, so the fast stars cannot be placed.' };

  const known = catalogue.answer === true || ring.answer === true;
  const blip = Math.abs(/** @type {{units: number}} */ (main.r).units) >= RESIDUAL_UNITS;
  const verdict = known ? 'This is probably a known star.' : !blip ? 'Nothing stands out here.' : flagged.answer === true ? 'This is probably an artefact of the detector.' : NOT_KNOWN;
  const dated = (/** @type {Item} */ it) => `${formatDate(it.mjd)} (${it.key.split('/').pop()?.replace(/^level2_/, '').replace(/_spx_.*$/, '') ?? ''})`;
  return {
    ready: true, why: '', ra: rra, dec: rdec, flagged, flagNames: names, pairs, pairsShowing: showing, pairsTotal: usable.length, catalogue, ring, rings,
    verdict, caution: CAUTION, photos: `${dated(main.a)} and ${dated(main.b)}`,
  };
}

/**
 * The sky position of a pixel of a picture.
 * @param {Picture} s @param {number} x @param {number} y
 * @returns {[number, number]}
 */
function skyAtPixel(s, x, y) {
  const sky = /** @type {LocalSky} */ (s.sky), D = Math.PI / 180;
  const dx = x - s.tx, dy = y - s.ty;
  const east = (sky.cd[0] * dx + sky.cd[1] * dy) * D, north = (sky.cd[2] * dx + sky.cd[3] * dy) * D;
  const d0 = sky.dec * D, across = Math.cos(d0) - north * Math.sin(d0);
  return [(((sky.ra + Math.atan2(east, across) / D) % 360) + 360) % 360, Math.atan2(Math.sin(d0) + north * Math.cos(d0), Math.hypot(across, east)) / D];
}

/**
 * The summary the visitor can copy: plain lines, nothing else.
 * @param {Assessment} a
 * @returns {string}
 */
export function summaryText(a) {
  if (!a.ready) return a.why;
  const yes = (/** @type {Answer} */ r) => (r.answer === null ? 'cannot tell' : r.answer ? 'yes' : 'no');
  return [
    `Blip at ${Number.isFinite(a.ra) ? formatSky(a.ra, a.dec) : 'a place with no sky position'}`,
    `Photos: ${a.photos}`,
    `Flagged pixel: ${yes(a.flagged)}${a.flagNames.length ? ` (${a.flagNames.join(', ')})` : ''}`,
    `In more than one pair: ${yes(a.pairs)}${a.pairsTotal ? ` (${a.pairsShowing} of ${a.pairsTotal} pairs)` : ''}`,
    `Catalogued source within 2 pixels: ${yes(a.catalogue)}`,
    `On the ring of a known fast star: ${yes(a.ring)}${a.rings.length ? ` (${a.rings.map((r) => r.name).join(', ')})` : ''}`,
    a.verdict,
    a.caution,
    'Worked out in the browser from the loaded photos; nothing was stored or sent.',
  ].join('\n');
}

/**
 * Build the panel in `root`.
 * @param {HTMLElement} root
 * @param {{copy?: (text: string) => Promise<void> | void}} [options]
 * @returns {{show: (a: Assessment | null) => void, current: () => Assessment | null}}
 */
export function createIsItReal(root, { copy } = {}) {
  root.classList.add('isreal');
  const title = document.createElement('h2');
  title.className = 'panel-title';
  title.textContent = 'IS IT REAL?';
  const hint = document.createElement('p');
  hint.className = 'panel-hint';
  hint.textContent = 'Click a blip in the picture. Four checks run on the photos that are loaded.';
  const list = document.createElement('ol');
  list.className = 'rows isreal-list';
  /** @type {Record<string, HTMLElement>} */
  const rows = {};
  for (const [id, label] of [['flagged', 'Is the pixel flagged?'], ['pairs', 'Is it there in more than one pair?'], ['catalogue', 'Is a catalogued star within 2 pixels?'], ['ring', 'Is it on a known fast star\'s ring?']]) {
    const li = document.createElement('li');
    li.className = 'isreal-row';
    const q = document.createElement('p');
    q.className = 'isreal-q';
    q.textContent = label;
    const a = document.createElement('p');
    a.className = 'isreal-a';
    a.dataset.part = id;
    li.append(q, a);
    list.append(li);
    rows[id] = a;
  }
  const verdict = document.createElement('p');
  verdict.className = 'isreal-verdict';
  const caution = document.createElement('p');
  caution.className = 'isreal-caution';
  const actions = document.createElement('p');
  actions.className = 'isreal-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn';
  copyBtn.textContent = 'Copy summary';
  const status = document.createElement('span');
  status.className = 'isreal-status';
  status.setAttribute('role', 'status');
  const talk = document.createElement('a');
  talk.href = BACKYARD_WORLDS_URL;
  talk.target = '_blank';
  talk.rel = 'noopener';
  talk.textContent = 'Backyard Worlds Talk';
  const mpc = document.createElement('a');
  mpc.href = MPC_URL;
  mpc.target = '_blank';
  mpc.rel = 'noopener';
  mpc.textContent = 'Minor Planet Center';
  const links = document.createElement('p');
  links.className = 'isreal-links';
  links.append('Ask at ', talk, ' or the ', mpc, '.');
  actions.append(copyBtn, status);
  root.replaceChildren(title, hint, list, verdict, caution, actions, links);

  /** @type {Assessment | null} */
  let now = null;
  copyBtn.addEventListener('click', async () => {
    if (!now) return;
    const text = summaryText(now);
    try {
      if (copy) await copy(text);
      else await navigator.clipboard.writeText(text);
      status.textContent = 'Copied.';
    } catch {
      status.textContent = 'Could not copy: select the text and copy it by hand.';
    }
  });

  /** @param {Assessment | null} a */
  function show(a) {
    now = a;
    const on = a !== null && a.ready;
    list.hidden = verdict.hidden = caution.hidden = actions.hidden = links.hidden = !on;
    root.dataset.ready = String(on);
    status.textContent = '';
    if (!a) { hint.textContent = 'Click a blip in the picture. Four checks run on the photos that are loaded.'; return; }
    hint.textContent = on ? 'For the place you clicked.' : a.why;
    if (!on) return;
    for (const id of ['flagged', 'pairs', 'catalogue', 'ring']) {
      const r = /** @type {Answer} */ (/** @type {any} */ (a)[id]);
      rows[id].textContent = r.text;
      rows[id].dataset.answer = r.answer === null ? 'unknown' : String(r.answer);
    }
    verdict.textContent = a.verdict;
    caution.textContent = a.caution;
  }
  show(null);
  return { show, current: () => now };
}
