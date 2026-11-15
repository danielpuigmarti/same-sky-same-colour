// The viewer page: one sky position, two visits, one colour.
//
//   view.html?t=<id>          a prepared target: a showcase (CT-8) read from the files of this site
//   view.html?ra=&dec=&det=   a position, read live from the archive through a client (CT-12)
//   view.html?q=<text>        what was typed in the box: a position in any form, a name of this site's own list
//                             (data/names.json), or another name, for which the name resolver of the CDS is asked.
//                             The address is then rewritten to ra and dec.
//
// A place that was clicked is kept in the address as `at=<ra>,<dec>` (lib/skypick.js), beside the parts of CT-11: the
// link then opens with the same place marked and the same answers beside the picture. An old address has none.
//
// A position typed from an old catalogue may be where a fast star used to be. The view then moves to where the star
// is now, says so, and links back to the position as it was typed: the same address with "#as-typed", which is
// taken as it stands.
//
// The page connects the reader of this site (lib/client.js) when it starts. Its stamps get the sky of their frames
// (lib/display.js), are put on the display grid and are added up for each visit (lib/compose.js). A page that sets
// `window.viewerOptions = {live: false}` before this script runs gets no reader: whoever made the page hands one in
// with connectClient, with what else it wants connected. Tests do.

/** @import { Client, Det, Failure, FailureState, Frame, Manifest, Plan, Stamp, ViewAddress, Wavelength } from '../contracts.js' */
/** @import { LocalSky, Mark, Picture, StageMode, StagePoint, StageView } from '../ui/stage.js' */
/** @import { VisitTile } from '../ui/visitstrip.js' */
/** @import { Composed } from '../lib/compose.js' */
/** @import { NamesFile, NameEntry } from '../lib/names.js' */
/** @import { UsedPhoto } from '../ui/share.js' */
/** @import { Readout } from '../ui/hover.js' */
/** @import { Address } from '../lib/urlstate.js' */
import { VIEW_PAGE, INDEX_DIR, MANIFEST_FILE } from '../contracts.js';
import { parseAddress, viewUrl } from '../lib/urlstate.js';
import { showcaseFolder, loadShowcase, showcaseVisits, pairsBetween, defaultVisits } from '../lib/showcase.js';
import { createStage, STAGE_MODES, formatDate } from '../ui/stage.js';
import { createHover, readout, skyAt, SKY_DECIMALS } from '../ui/hover.js';
import { centreSaturated, saturationNote } from '../ui/saturation.js';
import { createVisitStrip, visitId, tilesOfVisits, findVisit } from '../ui/visitstrip.js';
import { createRuler, loadTables, colourLookup, colourChip } from '../ui/ruler.js';
import { createPlan, formatMB, formatSeconds, progressOf, progressText } from '../ui/plan.js';
import { renderState, clearState, isFailure, STATE_LINKS } from '../ui/states.js';
import { createShare } from '../ui/share.js';
import { createLookup, formatPlace } from '../ui/lookup.js';
import { separationDeg } from '../lib/gaia.js';
import { mountSpot } from '../ui/spot.js';
import { figureOf, measuredRange, loadCard, loadNumbers } from '../ui/figure.js';
import { client as siteReader } from '../lib/client.js';
import { MAX_HEADERS_PER_VISIT, FIRST_PAIR_SLOW_MS } from '../lib/livepath.js';
import { compose } from '../lib/compose.js';
import { DISPLAY_SIZE, toDisplayGrid, isOnGrid, detectorPixel, createSkyReader } from '../lib/display.js';
import { NAMES_FILE, resolveInput, snapSuggestion } from '../lib/names.js';
import { parseCoords } from '../lib/coords.js';
import { parseAt, formatAt, skyToPixel } from '../lib/skypick.js';
import { movingBody, plain } from '../ui/suggest.js';
import { looksLikeName, resolveName } from '../lib/sesame.js';
import { framesCovering } from '../lib/tiles.js';
import { visits as visitRule } from '../lib/visits.js';
import { SATURATION_MASK, DEFECT_MASK } from '../lib/flags.js';

/** The detector a typed position opens in when the address names none. */
export const DEFAULT_DET = 2;

/** The part of an address that says: show this position as it was typed, do not move to a star that was here. */
export const AS_TYPED = '#as-typed';

/** Why the Difference view is switched off at a typed position, and where the check behind that is. */
export const DIFFERENCE_OFF = Object.freeze({
  why: 'At this pixel size a steady star leaves a dark and bright pair in a difference, so the difference is shown only on the checked examples.',
  href: 'checks.html#K8',
  label: 'How this was checked',
});

/** Why the Difference view is switched off at a prepared target that is read from the archive at the colours its card measures. */
const DIFFERENCE_OFF_TARGET = Object.freeze({
  why: 'No difference picture is prepared at these colours: at this pixel size a steady star leaves a dark and bright pair in a difference. The stored pictures of this target have one.',
  href: 'checks.html#K8',
  label: 'How this was checked',
});

/** The five prepared targets, for a message that sends the visitor to one. */
const FIVE_TARGETS = Object.freeze([['barnard', 'Barnard’s Star'], ['eps-indi-b', 'Epsilon Indi B'], ['wise0855', 'WISE 0855−0714'], ['rw-aur', 'RW Aurigae'], ['r-dra', 'R Draconis']]);

/** A position with more photos than this in the range of colours shown is a deep field: the other ranges are not listed. */
const DEEP_FIELD_PHOTOS = 1500;

/** Named targets whose prepared view is not in the folder of the targets: where it is. Its detector is the one a name opens in. */
const PREPARED = Object.freeze(/** @type {Record<string, string>} */ ({ lemmon: 'lemmon/hero' }));

/**
 * What can be handed in with the client.
 * @typedef {Object} Connections
 * @property {(pairs: [Picture, Picture][]) => StageView | null | Promise<StageView | null>} [compose]
 *   All loaded pairs of the two visits as one view, in place of what this page makes of them itself.
 * @property {(det: Det, x: number, y: number) => Wavelength} [wavelengthAt]  CT-3. Default: the tables of this site.
 * @property {(stamp: Stamp, frame: Frame | null) => LocalSky | null} [skyOf]
 *   The sky transform of a stamp that carries none; `frame` is its entry in the plan, null for a showcase.
 */

/** @typedef {VisitTile & {index: number}} Tile  A tile that knows which visit of the plan or of the showcase it is. */
/** @typedef {{label: string, colours: {lam: number, det: number}[], view: StageView}} Choice  One thing the stage can show. */
/** @typedef {{key: string, det: number, mjd: number, lam: number, bw: number, visit: number, loaded: boolean, flagged: boolean}} PanelFrame */
/** @typedef {{ra?: number, dec?: number, x?: number, y?: number, values?: unknown}} PanelPick  A place the visitor clicked: its pixel on the display grid, and what each loaded photo has there. */
/** @typedef {{setFrames: (frames: PanelFrame[]) => void, setPictures: (stamps: Picture[]) => void, setSelection: (keys: string[]) => void, pointAt: (pick: PanelPick | null) => void, destroy: () => void}} Panels */

/** @type {Address} */
let address = {};
/** True when the address ends in AS_TYPED. */
let asTyped = false;
/** @type {[number, number] | null} The place that was clicked, as the address carries it. */
let pickedSky = null;
/** @type {[number, number] | null} A place from the address that waits for pictures to mark it on. */
let pendingPick = null;
/** @type {StagePoint | null} The last place that was clicked, to tell the panels again when they come after the click. */
let lastPick = null;
/** @type {[number, number] | null} The position as it was typed, where the view moved to a fast star: the title says it. */
let titleAt = null;
/** True when the view is a prepared target that is read from the archive, at the colours its card measures. */
let targetLive = false;
/** @type {HTMLInputElement | null} The box in the masthead. */
let searchBox = null;
/** @type {Client | null} */
let client = null;
/** @type {Connections} */
let connections = {};
/** Counts openings: an answer that belongs to an earlier opening is dropped. */
let run = 0;
/** @type {Set<{from: Client}>} The calls to a client that are waiting for their answer. */
const calls = new Set();
/** @type {[Picture, Picture][]} The pairs of the two visits that are loaded. */
let pairs = [];
/** @type {Choice[]} What the stage can show: all pairs together, and the pairs one by one. */
let choices = [];
let chosen = 0;
/** @type {StageView | null} What the stage was last given. */
let shown = null;
/** True while the stage keeps its room for two other visits that are on their way. */
let waiting = false;
/** @type {{plan: Plan, pairs: [Picture, Picture][], choices: Choice[], chosen: number} | null} What is on the stage while it waits, to go back to. */
let kept = null;
/** @type {((det: Det, x: number, y: number) => Wavelength) | null} */
let tableColours = null;
/** @type {{plan: Plan, tiles: Tile[]} | null} What a typed position has planned, to choose other visits from. */
let live = null;
/** @type {{manifest: Manifest, stamps: Stamp[], tiles: Tile[], at: [number, number]} | null} A showcase, and the two of its tiles that are compared. */
let showcase = null;
/** @type {Composed | null} What this page made of the pairs on the stage; null when someone else did, or nobody. */
let made = null;
/** @type {Set<string>} The photos the panels asked to blink alone; empty for all. */
let selection = new Set();
/** @type {{view: StageView | null, playing: boolean} | null} What the stage showed before one photo was looked at on its own. */
let peeked = null;
/** @type {Map<number, Stamp[]>} Photos of the other ranges of colour, loaded for the spectrum. */
let others = new Map();
/** @type {{key: string, det: number, tmid: number, visit: number, corners: Frame['corners']}[] | null} Every photo of the position, in all ranges of colour. */
let field = null;
/** @type {{title: string, line: string, link?: {href: string, text: string}} | null} What is known about the place by name. */
let named = null;
/** @type {Panels | null} */
let panels = null;
let panelsAsked = false;
/** @type {{ringsFor: (q: {sky: LocalSky, mjd: number, size: {w: number, h: number}, tx: number, ty: number}) => {x: number, y: number, name: string}[]} | null} */
let rings = null;
let ringsAsked = false;
/** @type {Promise<NamesFile | null> | null} */
let namesAsked = null;
/** What the card of the target says about its numbers, said in the sentence above the pictures; '' for none. */
let figure = '';

/**
 * How an opening of a typed position went, for whoever measures it: milliseconds from the opening.
 * @type {{opened: number, planMs: number | null, firstPairMs: number | null, fullMs: number | null, bytes: number, photos: number, state: string | null, held: boolean, askedAgain: boolean, done: boolean}}
 */
let timing = { opened: 0, planMs: null, firstPairMs: null, fullMs: null, bytes: 0, photos: 0, state: null, held: false, askedAgain: false, done: false };

/** @param {number} v  A coordinate as the address carries it: a millionth of a degree. */
const micro = (v) => Number(v.toFixed(6));

/** @param {string} id @returns {HTMLElement} the part of the page with this id; made if the page has none */
function section(id) {
  const found = document.getElementById(id);
  if (found) return found;
  const made = document.createElement('section');
  made.id = id;
  (document.querySelector('main') ?? document.body).append(made);
  return made;
}

/** @param {string} tag @param {string} className @param {string} [text] */
function make(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function build() {
  const planBox = document.createElement('div'), stateBox = document.createElement('div');
  stateBox.hidden = true;
  // what the plan left out, in words, under the plan
  const capNote = make('p', 'plan-cap');
  capNote.hidden = true;
  section('plan').replaceChildren(planBox, capNote, stateBox);
  const plan = createPlan(planBox);
  plan.clear();

  // what is known about the place by name, under its name
  let namedLine = document.getElementById('view-named');
  if (!namedLine) {
    namedLine = make('p', 'view-named');
    namedLine.id = 'view-named';
    (document.querySelector('main h1') ?? section('plan')).after(namedLine);
  }
  namedLine.hidden = true;

  // the six ranges of colour, to choose the one a typed position is shown in: they stand in the cell that says
  // which range is shown, and are on the page only while there is something to choose
  const ranges = make('div', 'choice view-ranges');
  ranges.id = 'view-ranges';
  ranges.setAttribute('role', 'group');
  ranges.setAttribute('aria-label', 'Range of colours');

  section('stage').hidden = true;
  /** @type {ReturnType<typeof createHover> | null} */
  let readoutBox = null;
  let pointing = false;
  /** @type {StagePoint | null} */
  let lastPoint = null; // the pixel under the mouse; while a place is clicked the readout holds that place
  const stage = createStage(section('stage'), {
    mode: stageMode(address.mode),
    onMode: (mode) => setAddress({ mode }),
    smooth: address.smooth === true,
    onSmooth: (on) => setAddress({ smooth: on || undefined }),
    white: address.white,
    onWhite: (step) => setAddress({ white: step || undefined }),
    speed: address.speed,
    onSpeed: (speed) => setAddress({ speed: speed === 'normal' ? undefined : speed }),
    invert: address.invert === true,
    onInvert: (on) => setAddress({ invert: on || undefined }),
    onPoint: (point) => {
      pointing = point !== null; lastPoint = point;
      if (!point) showRest();
      else if (!(parts().stage.picked && !point.touch)) readoutBox?.show(readoutOf(point));
    },
    // while the blink plays by itself the resting readout holds still (it would change, and the column under it
    // move, every second); a step or a pause shows the photo then in view
    onSide: () => { if (!pointing && !parts().stage.playing) showRest(); },
    onPick: (point) => pick(point),
    onUnpick: () => { lastPick = null; pendingPick = null; setPicked(null); panels?.pointAt(null); showAnswer(null); ui?.lookup.setClicked(null, null); if (lastPoint && pointing && !lastPoint.touch) readoutBox?.show(readoutOf(lastPoint)); else if (!pointing) showRest(); },
  });
  // beside the pictures, where it can be seen while pointing: what there is to see, the readout of the pointer, and
  // the short answers for the place that was clicked
  const seeBox = make('p', 'view-see');
  seeBox.hidden = true;
  const hoverBox = make('div', 'view-readout');
  const satBox = make('p', 'view-see view-saturated');
  satBox.hidden = true;
  const hover = readoutBox = createHover(hoverBox, { link: viewLink });
  const answerBox = buildAnswer();
  stage.slot.replaceChildren(seeBox, satBox, hoverBox, answerBox);

  const colours = section('colours');
  const heading = document.createElement('h2');
  heading.textContent = 'COLOUR';
  const picker = document.createElement('div');
  picker.className = 'choice view-choices';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Colour to compare');
  // the ruler is a drawing made of data: it stands on a plate
  const rulerBox = document.createElement('div');
  rulerBox.className = 'view-ruler';
  rulerBox.setAttribute('data-plate', '');
  const words = document.createElement('p');
  words.className = 'view-colours-note';
  words.textContent = 'SPHEREx takes each photo through a filter whose colour changes across the picture, so two photos of one star are rarely at the same colour. Only photos at the same colour are compared here.';
  colours.replaceChildren(heading, picker, rulerBox, words);
  colours.hidden = true;

  const lookup = createLookup(section('lookup'), { decimals: SKY_DECIMALS });

  const strip = createVisitStrip(section('visits'), { onChoose: chooseVisits });

  const shareRoot = document.getElementById('share');
  const share = shareRoot ? createShare(shareRoot, { link: viewLink, formatDate: (mjd) => formatDate(mjd, true) }) : null;
  if (shareRoot) shareRoot.hidden = true;

  return {
    plan, stateBox, capNote, namedLine, ranges, hover, seeBox, satBox, lookup, answerBox, stage, colours, picker, rulerBox, strip, share, shareRoot,
    ruler: /** @type {ReturnType<typeof createRuler> | null} */ (null),
  };
}

/**
 * The short answers for the place that was clicked, in fixed slots beside the picture: each says its answer and leads
 * to its full part further down.
 */
function buildAnswer() {
  const box = make('dl', 'cells view-answer');
  box.setAttribute('aria-live', 'polite');
  for (const [name, label, href, link] of [['real', 'Is it real?', '#is-it-real', 'The four checks'], ['spectrum', 'Spectrum', '#spectrum', 'The spectrum']]) {
    const row = make('div', 'cell view-answer-row');
    row.dataset.answer = name;
    const dt = make('dt', 'cell-label', label);
    const dd = make('dd', 'view-answer-text', '—');
    const a = /** @type {HTMLAnchorElement} */ (make('a', 'view-answer-link', link));
    a.href = href;
    a.hidden = true;
    row.append(dt, dd, a);
    box.append(row);
  }
  return box;
}

/** @param {import('../ui/panels.js').Answer | null} answer  What the panels say about the clicked place; null for none. */
function showAnswer(answer) {
  const { answerBox } = parts();
  for (const row of answerBox.querySelectorAll('.view-answer-row')) {
    if (!(row instanceof HTMLElement)) continue;
    const real = row.dataset.answer === 'real';
    const text = row.querySelector('.view-answer-text'), link = row.querySelector('.view-answer-link');
    const ready = answer ? (real ? answer.realReady : answer.spectrumReady) : false;
    if (text) text.textContent = answer ? (real ? answer.real : answer.spectrum) : '—';
    if (link instanceof HTMLElement) link.hidden = !answer || !ready;
    row.dataset.ready = String(ready);
  }
  answerBox.dataset.empty = String(!answer);
}

/** @type {ReturnType<typeof build> | null} */
let ui = null;

/** The parts of the page, made the first time they are needed. */
function parts() {
  ui ??= build();
  return ui;
}

/**
 * The view of the stage for the `mode` of an address. The flipbook is not a view of the stage: it opens as Blink.
 * @param {ViewAddress['mode']} mode
 * @returns {StageMode}
 */
function stageMode(mode) {
  return STAGE_MODES.find((m) => m === mode) ?? 'blink';
}

/**
 * An address of this page as text: the parts of the address, the place that was clicked, and "as typed".
 * @param {Address} a
 * @returns {string}
 */
function urlOf(a) {
  const base = viewUrl(a, VIEW_PAGE);
  return base + (pickedSky ? `${base.includes('?') ? '&' : '?'}at=${formatAt(pickedSky[0], pickedSky[1])}` : '') + (asTyped ? AS_TYPED : '');
}

/** Change parts of the address of the page, without loading the page again. @param {Partial<Address>} changes */
function setAddress(changes) {
  address = { ...address, ...changes };
  writeAddress();
}

/** Write the address of the page as it stands into the address bar and into the link back from an embedded view. */
function writeAddress() {
  try {
    history.replaceState(history.state, '', urlOf(address));
  } catch { /* an address that cannot be rewritten stays as it is */ }
  const back = document.getElementById('view-back');
  if (back instanceof HTMLAnchorElement) back.href = urlOf({ ...address, embed: undefined });
}

/** The tiles of the two visits that are compared, or null. @returns {[Tile, Tile] | null} */
function comparedTiles() {
  const tiles = showcase?.tiles ?? live?.tiles ?? [];
  const at = showcase ? showcase.at : live ? (comparedVisits(live.plan) ?? [-1, -1]).map((v) => tiles.findIndex((t) => t.index === v)) : [-1, -1];
  return at[0] >= 0 && at[1] >= 0 && tiles[at[0]] && tiles[at[1]] ? [tiles[at[0]], tiles[at[1]]] : null;
}

/**
 * The whole address of what is shown: the address of the page, with the two visits that are compared named in it.
 * @returns {string}
 */
function viewLink() {
  /** @type {Address} */
  const a = { ...address, embed: undefined, q: undefined };
  const tiles = showcase?.tiles ?? live?.tiles ?? [];
  const at = showcase ? showcase.at : live ? (comparedVisits(live.plan) ?? [-1, -1]).map((v) => tiles.findIndex((t) => t.index === v)) : [-1, -1];
  if (at[0] >= 0 && at[1] >= 0 && tiles[at[0]] && tiles[at[1]]) {
    a.a = tiles[at[0]].id;
    a.b = tiles[at[1]].id;
  }
  return new URL(urlOf(a), location.href).href;
}

/**
 * A name as the form prints it: in capitals, written as capitals. Greek letters and the micro sign are left as they
 * are, because their capitals read as other letters.
 * @param {string} text
 * @returns {string}
 */
export function inCapitals(text) {
  return text.replace(/[^Ͱ-Ͽµ]+/g, (run) => run.toUpperCase());
}

/** @param {string} name  The name of what is shown, or '' for none. */
function setTitle(name) {
  const h1 = document.querySelector('main h1');
  // a place without a name is still a place, and the one that was typed, where the view moved to a star
  const place = titleAt ?? (address.ra !== undefined && address.dec !== undefined ? [address.ra, address.dec] : null);
  if (h1) {
    // a place without a name is still a place; a page with no place says what the page is for
    h1.textContent = name ? inCapitals(name).replace(/'/g, '’') : place ? formatPlace(place[0], place[1], SKY_DECIMALS) : 'BLINK A PLACE';
    if (name) h1.setAttribute('aria-label', name);
    else h1.removeAttribute('aria-label');
  }
  const root = document.documentElement;
  root.dataset.title ??= document.title;
  const said = name ? name.replace(/'/g, '’') : place ? formatPlace(place[0], place[1], SKY_DECIMALS) : '';
  document.title = said ? `${said} · ${root.dataset.title}` : root.dataset.title;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** A day as it is written in a sentence: "15 August 2025". @param {number} mjd */
function longDate(mjd) {
  const d = new Date(Math.round((mjd - 40587) * 86400000));
  return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The line of a place whose own line promises a visible jump. @type {Record<string, string>} */
const PLACE_LINES = {
  'view.html?t=eps-indi-b': 'Two brown dwarfs drifting across the sky: the pair moves by about a pixel between two visits.',
  'view.html?t=barnard': 'The fastest-moving star in the sky: it moves by about a pixel between two visits.',
};

/** The kind of the card of the prepared target on the page; '' for a typed place. */
let seeKind = '';
const SATURATED_ALIGN = 'The alignment of the two visits cannot be checked around a saturated star.';
const NO_PAIR = 'No pair of SPHEREx photos of this place is on the page.';
const EMPTY_LEDE = 'Type a star’s name or a sky position. The viewer flips between SPHEREx photos of that place taken months apart, matched in colour.';

/** The one plain sentence above the pictures. @param {string} text */
function setLede(text) {
  const line = document.getElementById('view-lede');
  if (line && line.textContent !== text) line.textContent = text;
}

/** Say again the sentence for the visits of the position, after a sentence about the read in progress. */
function restoreLede() {
  if (!live) return;
  const c = comparedVisits(live.plan), t = live.tiles;
  const a = c ? t.findIndex((x) => x.index === c[0]) : -1, b = c ? t.findIndex((x) => x.index === c[1]) : -1;
  setLede(ledeFor(t, a >= 0 && b >= 0 ? [t[a], t[b]] : null));
}

/**
 * The sentence for the visits that are loaded: how many passes, which two are compared, how they are shown.
 * @param {{mjd: number}[]} tiles  Every visit known for the place.
 * @param {[{mjd: number}, {mjd: number}] | null} compared  The two that are compared, or null.
 * @returns {string}
 */
function ledeFor(tiles, compared) {
  const said = ledeOf(tiles, compared);
  return figure && tiles.length ? `${said} ${figure}` : said;
}

/** @param {{mjd: number}[]} tiles @param {[{mjd: number}, {mjd: number}] | null} compared @returns {string} */
function ledeOf(tiles, compared) {
  if (!tiles.length) return NO_PAIR;
  if (tiles.length === 1) return `One pass of SPHEREx over this place, ${longDate(tiles[0].mjd)}. There is no second visit to flip it against yet.`;
  const count = COUNT_WORDS[tiles.length] ?? String(tiles.length);
  if (!compared) return `${count} passes of SPHEREx over this place, but no two of them have photos at the same colour. Choose two visits below.`;
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const how = calm ? 'to step between by hand' : 'flipping about once a second';
  const when = `${longDate(compared[0].mjd)} and ${longDate(compared[1].mjd)}`;
  return `${tiles.length === 2 ? `${count} passes of SPHEREx over this place, ${when}` : `${count} passes of SPHEREx over this place; the two compared are ${when}`}, ${how}.`;
}

/**
 * What there is to see at a prepared target, from its card.
 * @param {{kind?: string, name?: string}} card
 * @returns {string}
 */
function seeText(card) {
  const name = (card.name ?? 'This target').replace(/'/g, '’');
  if (card.kind === 'mover') return `${name} moved about a pixel between these two dates. The Difference view shows an orange patch where it arrived beside a blue one where it left.`;
  if (card.kind === 'saturated') return `${name} is too bright to measure: its centre is saturated, which is why it is hatched.`;
  if (card.kind === 'variable') return `${name} changes by a different amount in each colour, and nothing in the picture shifts. Click the star and read its spectrum.`;
  return '';
}

/** Say what there is to see at a prepared target, from its card; nothing when the card cannot be read. @param {import('../ui/figure.js').Card | null} card */
function showSee(card) {
  const { seeBox } = parts();
  seeKind = card?.kind ?? '';
  const text = card ? seeText(card) : '';
  seeBox.textContent = text;
  seeBox.hidden = text === '';
}

/** What kind of change a card says a prepared target shows, in a few words. @type {Record<string, string>} */
const CHANGE_WORDS = { mover: 'Moves', saturated: 'Too bright to measure', variable: 'Changes brightness' };
/** The target whose two photos blink on the plate of the empty viewer. */
const SPOT = { t: 'barnard', name: 'Barnard’s Star' };

/**
 * The places to try, for a page with nothing chosen: one row each with its name, what to look for and the kind of
 * change. The blinking plate of one of them stands beside the headline, and the search form stands under it.
 */
async function showPlaces() {
  const box = document.getElementById('places');
  if (!box) return;
  /** @type {{label: string, line?: string, href: string}[]} */
  let list = [];
  try {
    const r = await fetch('data/first-places.json');
    if (r.ok) list = await r.json();
  } catch { /* the five prepared targets stand in */ }
  if (!Array.isArray(list) || !list.length) {
    list = [['barnard', 'Barnard’s Star'], ['eps-indi-b', 'Epsilon Indi B'], ['wise0855', 'WISE 0855−0714'], ['rw-aur', 'RW Aurigae'], ['r-dra', 'R Draconis']].map(([t, label]) => ({ label, href: `view.html?t=${t}` }));
  }
  if (address.t !== undefined || address.q !== undefined || address.ra !== undefined) return;
  // the kind of change of a prepared target is on its card; a place that is not one is a shape that stays
  const kinds = await Promise.all(list.map(async (p) => {
    const t = /[?&]t=([^&]+)/.exec(p.href)?.[1];
    if (!t) return 'Steady shape';
    const card = await loadCard(`data/targets/${t}/`);
    return CHANGE_WORDS[card?.kind ?? ''] ?? '';
  }));
  const heading = make('h2', '', 'PLACES TO TRY');
  const ul = make('ul', 'view-places');
  for (const [i, p] of list.entries()) {
    const li = make('li', 'view-place');
    const a = /** @type {HTMLAnchorElement} */ (make('a', 'view-place-link', String(p.label).replace(/'/g, '’')));
    a.href = p.href;
    li.append(a);
    // what moves here moves by a pixel or less: a line that promises a visible jump says that instead
    const line = p.line && /\b(jump|shift)/i.test(p.line) ? (PLACE_LINES[p.href] ?? '') : (p.line ?? '');
    if (line) li.append(make('span', 'view-place-line', line.replace(/'/g, '’')));
    if (kinds[i]) li.append(make('span', 'view-place-kind', kinds[i]));
    ul.append(li);
  }
  box.replaceChildren(heading, ul);
  box.hidden = false;
  fillHead();
}

/** The empty viewer's head: the search form moves under the headline, and a plate blinks beside it. */
function fillHead() {
  const head = document.querySelector('.view-head'), form = document.querySelector('.view-search'), joined = form?.querySelector('.joined');
  if (!head || !form || !joined) return;
  joined.classList.add('joined-lg');
  head.querySelector('.view-title')?.after(form);
  const spot = make('div', 'view-spot');
  spot.hidden = true;
  head.append(spot);
  mountSpot(spot, { folder: `data/targets/${SPOT.t}/`, name: SPOT.name, href: `view.html?t=${SPOT.t}` }).then((ok) => { spot.hidden = !ok; }).catch(() => {});
}

/** @typedef {'colours' | 'visits' | 'photos' | 'source'} Fact  A slot of the row of cells under the name. */

/**
 * Write what is known about the place into its slot of the row of cells; '' leaves the slot blank, with its dash.
 * @param {Fact} name @param {string} text
 */
function fact(name, text) {
  const cell = document.querySelector(`#view-where [data-cell="${name}"]`);
  if (cell && cell.textContent !== text) cell.textContent = text;
}

/** Blank the slots that a new opening has to find out again. @param {Fact[]} names */
function forget(names) {
  for (const name of names) if (!(name === 'colours' && parts().ranges.isConnected)) fact(name, '');
}

/** How many photos of a position read live are on the page, of how many SPHEREx took in this range of colours. */
function countPhotos() {
  if (!live) return;
  const total = live.plan.visits.reduce((n, v) => n + v.frames.length, 0);
  fact('photos', `${(pairs.length * 2).toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`);
}

/** The cells that say where on the sky the place is, and in which range of colours. @param {number} ra @param {number} dec @param {number} det */
function describe(ra, dec, det) {
  parts().lookup.setCentre(ra, dec);
  const { ruler, ranges } = parts();
  if (ranges.isConnected) return; // the six ranges stand in the cell, with the one that is shown filled
  const span = ruler?.spans.find((s) => s.det === det);
  fact('colours', span ? `${span.min.toFixed(2)}–${span.max.toFixed(2)} µm` : '');
}

/** Show what is known about the place by name, or take the line away. */
function showNamed() {
  const { namedLine } = parts();
  namedLine.replaceChildren();
  namedLine.hidden = !named || !named.line;
  if (!named || !named.line) return;
  namedLine.append(named.line);
  if (named.link) {
    const a = document.createElement('a');
    a.href = named.link.href;
    a.textContent = named.link.text;
    namedLine.append(' ', a);
  }
}

/**
 * The six ranges of colour as one choice, for a typed position; the one that is shown is filled.
 * @param {boolean} on  False to take them away.
 */
function showRanges(on) {
  const { ranges, ruler } = parts();
  const cell = document.querySelector('#view-where [data-cell="colours"]');
  ranges.replaceChildren();
  if (!on || !ruler || !cell) {
    if (ranges.isConnected) {
      ranges.remove();
      if (cell) cell.textContent = '';
    }
    return;
  }
  const now = address.det ?? DEFAULT_DET;
  for (const s of ruler.spans) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'view-range';
    b.dataset.det = String(s.det);
    b.setAttribute('aria-pressed', String(s.det === now));
    b.setAttribute('aria-label', `${s.min.toFixed(2)} to ${s.max.toFixed(2)} µm`);
    b.textContent = `${s.min.toFixed(2)}–${s.max.toFixed(2)}`;
    b.addEventListener('click', () => {
      if (s.det === (address.det ?? DEFAULT_DET)) return;
      setAddress({ det: s.det, a: undefined, b: undefined });
      openPosition();
    });
    ranges.append(b);
  }
  // the six ends are written without their unit: it stands once, after the last of them, and wraps with it (each
  // button says its unit to a screen reader)
  const unit = make('span', 'view-ranges-unit', 'µm');
  unit.setAttribute('aria-hidden', 'true');
  ranges.append(unit);
  cell.replaceChildren(ranges);
}

/**
 * A message of the page itself (not a state of CT-12), where the state messages go.
 * @param {string} kind @param {string} title @param {string} next
 * @param {('targets' | 'home' | {href: string, text: string})[]} [links]
 */
function notice(kind, title, next, links = []) {
  const { stateBox } = parts();
  clearState(stateBox);
  stateBox.hidden = false;
  stateBox.dataset.state = `page-${kind}`;
  stateBox.classList.add('state');
  stateBox.setAttribute('role', 'status');
  const first = document.createElement('p');
  first.className = 'state-title';
  first.textContent = title;
  const second = document.createElement('p');
  second.className = 'state-next';
  second.textContent = next;
  const actions = document.createElement('p');
  actions.className = 'state-actions';
  for (const link of links) {
    const a = document.createElement('a');
    a.className = 'state-link';
    a.href = typeof link === 'string' ? STATE_LINKS[link] : link.href;
    a.textContent = typeof link === 'string' ? (link === 'targets' ? 'Prepared targets' : 'Type a position') : link.text;
    actions.append(a);
  }
  stateBox.append(first, second, actions);
  // the answer to what was typed or to an address is brought into view: on a small screen it stands below the first one
  if (kind !== 'no-pairs' && kind !== 'empty' && kind !== 'not-connected') stateBox.scrollIntoView({ block: 'nearest' });
  timing.state = `page-${kind}`;
  timing.done = true;
  if (kind !== 'no-pairs' && kind !== 'empty') setLede(NO_PAIR);
}

/**
 * While two other visits of the position on the stage are fetched, the stage keeps its room and shows nothing, so
 * that the visits under it stay where they were pressed.
 * @param {boolean} on
 */
function setWaiting(on) {
  waiting = on;
  if (!on) kept = null;
  for (const id of ['stage', 'colours']) {
    const part = section(id);
    // the room it has now is held while it waits, whatever its parts do in the meantime
    part.style.minHeight = on ? `${part.getBoundingClientRect().height}px` : '';
    part.classList.toggle('is-waiting', on);
    part.setAttribute('aria-busy', String(on));
  }
}

/**
 * The call for two other visits was withdrawn, and not by this page: the stage shows again what it showed, and the
 * visits and the address name it again.
 */
function goBack() {
  if (!waiting || !kept) return;
  const was = kept;
  ({ pairs, choices, chosen } = was);
  setWaiting(false);
  const { plan: box, strip, colours } = parts();
  const tiles = tilesOf(was.plan), compared = comparedVisits(was.plan);
  const a = compared ? tiles.findIndex((t) => t.index === compared[0]) : -1, b = compared ? tiles.findIndex((t) => t.index === compared[1]) : -1;
  live = { plan: was.plan, tiles };
  strip.show(tiles, a >= 0 && b >= 0 ? [a, b] : null);
  if (a >= 0 && b >= 0) setAddress({ a: tiles[a].id, b: tiles[b].id });
  colours.hidden = choices.length === 0;
  setLede(ledeFor(tiles, a >= 0 && b >= 0 ? [tiles[a], tiles[b]] : null));
  box.showPlan(was.plan);
  box.finish();
  countPhotos();
  fact('source', `NASA archive · ${formatMB(was.plan.bytes)} MB`);
}

/** Give the stage a view, or nothing; without a view the stage leaves the page. @param {StageView | null} view */
function put(view) {
  const left = waiting && !view;
  setWaiting(false);
  shown = view;
  peeked = null;
  const { stage, hover, colours, ruler, stateBox, share, shareRoot, lookup } = parts();
  section('stage').hidden = !view;
  if (!view) { panels?.pointAt(null); showAnswer(null); lookup.setClicked(null, null); }
  stage.show(view);
  // pictures that cannot show the place that was clicked take it out of the address
  if (!pendingPick && !stage.picked && (pickedSky || lastPick)) {
    lastPick = null;
    setPicked(null);
    panels?.pointAt(null);
    showAnswer(null);
    lookup.setClicked(null, null);
  }
  dock(Boolean(view));
  showRest();
  colours.hidden = choices.length === 0;
  ruler?.setMarks(view ? [{ lam: view.a.lam, label: 'earlier visit' }, { lam: view.b.lam, label: 'later visit' }] : []);
  if (view && timing.firstPairMs === null && timing.opened) timing.firstPairMs = performance.now() - timing.opened;
  if (shareRoot) shareRoot.hidden = !view;
  share?.setPhotos(view ? photosOf(view) : []);
  if (!view) share?.close();
  if (view) panels?.setSelection(photosOf(view).map((p) => p.key));
  // a wait that ends without pictures takes the stage away from above the visits that were just pressed: the
  // message that says why is brought into view
  if (left) stateBox.scrollIntoView({ block: 'nearest' });
}

/**
 * The photos a view is made of, for the list of the menu and for the panels: the earlier visit first, each visit in
 * the order its photos were taken.
 * @param {StageView} view
 * @returns {UsedPhoto[]}
 */
function photosOf(view) {
  /** @param {Picture} p @param {'earlier' | 'later'} side @returns {UsedPhoto[]} */
  const side = (p, side) => (p.members && p.members.length ? p.members : [p]).filter((m) => m.key).map((m) => ({ key: m.key, mjd: m.mjd, lam: m.lam, side })).sort((x, y) => x.mjd - y.mjd);
  return [...side(view.a, 'earlier'), ...side(view.b, 'later')];
}

/**
 * Show the message of a state (CT-12). A state that keeps what is on the stage leaves it there; another clears
 * the stage. `cancelled` shows no message: the call was withdrawn, and the stage shows what it showed before.
 * @param {FailureState | string} state
 */
export function showState(state) {
  if (state === 'cancelled') {
    goBack();
    return;
  }
  const text = renderState(parts().stateBox, state, { onRetry: open });
  if (text) {
    timing.state = state;
    timing.done = true;
    // the line under the title says what happened, not that the page is still looking
    if (!shown) setLede(text.title);
  }
  // a state that keeps the stage keeps what the visitor sees there: a stage that was waiting for other visits has nothing to keep
  if (text && (!text.keeps || waiting)) {
    choices = [];
    put(null);
    setLede(text.title);
  }
}

// ---------------------------------------------------------------------------------------------
// What the stage shows
// ---------------------------------------------------------------------------------------------

/**
 * What was handed in may fail; the page then goes on without it, and says so where a developer looks.
 * @template T
 * @param {() => T} run @param {string} what
 * @returns {T | null}
 */
function attempt(run, what) {
  try {
    return run();
  } catch (e) {
    console.error(`viewer: ${what} failed`, e);
    return null;
  }
}

/** @type {WeakSet<object>} The stamps that came with their own sky: from the reader of this site, or from a showcase on the display grid. */
const withOwnSky = new WeakSet();

/** @param {Stamp} stamp @param {Frame | null} frame @returns {Picture} */
function pictureOf(stamp, frame) {
  if (stamp.sky) {
    withOwnSky.add(stamp);
    return stamp;
  }
  return { ...stamp, sky: attempt(() => connections.skyOf?.(stamp, frame) ?? null, 'the sky transform of a stamp') };
}

/**
 * What the readout says about a pixel. The colour of a pixel of the display grid is the colour of the detector
 * pixel behind it; where photos were added up, the mean over them. A picture that does not know the detector pixels
 * behind it (a showcase on the grid) gives no colour.
 * @param {StagePoint} point
 * @returns {Readout}
 */
function readoutOf(point) {
  const wl = connections.wavelengthAt ?? tableColours;
  const r = readout(point, { wavelengthAt: wl });
  if (point.kind === 'diff' || !wl) return r;
  const p = /** @type {Picture} */ (point.picture);
  const behind = p.members && p.members.length ? p.members : [p];
  if (!behind.every(isOnGrid)) return r;
  let lam = 0, bw = 0, n = 0;
  for (const m of behind) {
    const at = detectorPixel(m, point.x, point.y);
    const c = at ? wl(m.det, at.x, at.y) : null;
    if (!c || !Number.isFinite(c.lam)) continue;
    lam += c.lam;
    bw += c.bw;
    n++;
  }
  r.lam = n ? lam / n : null;
  r.bw = n ? bw / n : null;
  return r;
}

/**
 * The pairs as this page puts them together: on the display grid, added up for each visit. Null when the stamps
 * did not come with their own sky: they are then shown as they are, in the orientation of the detector.
 * @param {[Picture, Picture][]} use
 * @returns {Composed | null}
 */
function composeOwn(use) {
  if (!use.every(([a, b]) => withOwnSky.has(a) && withOwnSky.has(b))) return null;
  // a showcase is on the grid already and is a checked example: it gets a difference. Its pictures are cut to the
  // part that every photo covers whichever way the detector was turned, as those of a typed position are
  if (showcase) return compose(use, { size: Math.min(showcase.manifest.w, DISPLAY_SIZE), difference: true });
  return compose(use, { wavelengthAt: connections.wavelengthAt ?? tableColours, size: DISPLAY_SIZE });
}

/** What a view of a typed position carries beyond its pictures: the Difference view is switched off there. @param {StageView} view @returns {StageView} */
function dressed(view) {
  return showcase ? view : { ...view, diff: null, diffOff: targetLive ? DIFFERENCE_OFF_TARGET : DIFFERENCE_OFF };
}

/** Mark, in every picture that can be shown, where the known fast stars should be on its date. */
function markRings() {
  if (!rings) return;
  for (const c of choices) {
    for (const p of [c.view.a, c.view.b]) {
      if (!p.sky || !Number.isFinite(p.mjd)) continue;
      const found = attempt(() => /** @type {NonNullable<typeof rings>} */ (rings).ringsFor({ sky: /** @type {LocalSky} */ (p.sky), mjd: p.mjd, size: { w: p.w, h: p.h }, tx: p.tx, ty: p.ty }), 'placing the known fast stars');
      /** @type {Mark[]} */
      const marks = (found ?? []).map((r) => ({ x: r.x, y: r.y, name: r.name }));
      p.marks = marks;
    }
  }
}

/** Load what places the known fast stars, once; the pictures on the stage are marked when it has arrived. */
function askRings() {
  if (ringsAsked) return;
  ringsAsked = true;
  import('../ui/rings.js').then(async (m) => {
    await m.loadFast('');
    rings = m;
    markRings();
    parts().stage.redraw();
  }).catch(() => { /* without the list of fast stars nothing is marked */ });
}

/** Make the list of what can be shown from the loaded pairs, and show the one that is chosen. */
async function refresh() {
  const my = run;
  // the panels may have asked for some photos alone: the pairs they belong to
  const picked = selection.size ? pairs.filter(([a, b]) => selection.has(a.key) || selection.has(b.key)) : [];
  const use = picked.length ? picked : pairs;
  /** @type {Choice[]} */
  const next = [];
  /** @type {StageView | null} */
  let all = null;
  /** @type {Composed | null} */
  let own = null;
  if (use.length) {
    if (connections.compose) {
      try {
        all = await connections.compose(use);
      } catch (e) {
        console.error('viewer: putting the pairs together failed', e);
      }
      if (my !== run) return;
    } else {
      own = attempt(() => composeOwn(use), 'putting the pairs together');
      // around a star that fills its pixels the line-up cannot be read: the line under the pictures says that, not
      // that no star is bright enough, which the message above it would contradict
      if (own && own.signs.tooBright && /^No star in this patch/.test(own.view.note ?? '')) own.view = { ...own.view, note: SATURATED_ALIGN };
      if (own) all = dressed(own.view);
      // an added-up picture carries the date of its visit, the one the list of visits and the sentence above say
      const dated = comparedTiles();
      // a photo shown alone carries its own time and says which visit it belongs to: the one the sentence above names
      if (own && dated) {
        /** @type {any} */ (own.view.a).visitMjd = dated[0].mjd;
        /** @type {any} */ (own.view.b).visitMjd = dated[1].mjd;
        for (const [a, b] of own.singles) {
          /** @type {any} */ (a).visitMjd = dated[0].mjd;
          /** @type {any} */ (b).visitMjd = dated[1].mjd;
        }
      }
    }
  }
  made = own;
  const colours = use.map(([a]) => ({ lam: a.lam, det: a.det }));
  if (all) next.push({ label: use.length > 1 ? 'All colours together' : own ? '' : 'Added up', colours, view: all });
  // the pairs one by one; a single pair that this page put on the grid is the view above already
  if (!(own && use.length === 1)) {
    for (const [k, [a, b]] of use.entries()) {
      const view = own ? dressed({ a: own.singles[k][0], b: own.singles[k][1], diffNote: 'The difference is drawn for all colours together.' }) : { a, b };
      next.push({ label: '', colours: [{ lam: a.lam, det: a.det }], view });
    }
  }
  choices = next;
  chosen = Math.min(chosen, Math.max(0, choices.length - 1));
  if (own) {
    askRings();
    markRings();
    askPanels();
  }

  const { picker } = parts();
  picker.replaceChildren();
  for (const [i, c] of choices.entries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stage-button view-choice';
    b.setAttribute('aria-pressed', String(i === chosen));
    if (c.label) b.append(c.label, ' ');
    // one chip for one colour; a choice that holds many says how many, so that the chosen cell stays small
    if (c.colours.length > 3) b.append(`${c.colours.length} colours`);
    else for (const colour of c.colours) b.append(colourChip(colour.lam, colour.det));
    b.addEventListener('click', () => { chosen = i; refresh(); });
    picker.append(b);
  }
  const now = choices[chosen]?.view ?? null;
  // a view made of the same pictures as the one on the stage is not shown again: the blink goes on undisturbed
  const same = now !== null && shown !== null && now.a === shown.a && now.b === shown.b && (now.diff ?? null) === (shown.diff ?? null) && now.note === shown.note;
  if (!same) put(now);
  else parts().colours.hidden = false;
  tellPanels();
  restorePick();
}

// ---------------------------------------------------------------------------------------------
// The panels beside the stage, and the place the visitor clicks
// ---------------------------------------------------------------------------------------------

/** True when the target pixel of a stamp is flagged as saturated or damaged, or has no value. @param {Stamp} s */
function flaggedAtTarget(s) {
  const k = Math.floor(s.ty + 0.5) * s.w + Math.floor(s.tx + 0.5);
  return !Number.isFinite(s.data[k]) || (s.flags !== null && (s.flags[k] & (SATURATION_MASK | DEFECT_MASK)) !== 0);
}

/**
 * Where a sky position falls on a frame, from the four corners the index has for it: good to a few pixels, which
 * is enough to say at which colour a photo that was not read saw the position.
 * @param {Frame['corners']} c  The corners of pixel (0, 0), (nx, 0), (nx, ny) and (0, ny), in that order.
 * @param {number} ra @param {number} dec
 * @returns {{x: number, y: number}}  Full-frame pixel, 0-based.
 */
export function pixelFromCorners(c, ra, dec) {
  const D = Math.PI / 180, cosd = Math.cos(dec * D);
  // a flat map of the frame around the position: degrees east and north of it
  const p = c.map(([r, d]) => [(((r - ra + 540) % 360) - 180) * cosd, d - dec]);
  let u = 0.5, v = 0.5;
  for (let it = 0; it < 12; it++) {
    const fx = (1 - u) * (1 - v) * p[0][0] + u * (1 - v) * p[1][0] + u * v * p[2][0] + (1 - u) * v * p[3][0];
    const fy = (1 - u) * (1 - v) * p[0][1] + u * (1 - v) * p[1][1] + u * v * p[2][1] + (1 - u) * v * p[3][1];
    const xu = (1 - v) * (p[1][0] - p[0][0]) + v * (p[2][0] - p[3][0]), xv = (1 - u) * (p[3][0] - p[0][0]) + u * (p[2][0] - p[1][0]);
    const yu = (1 - v) * (p[1][1] - p[0][1]) + v * (p[2][1] - p[3][1]), yv = (1 - u) * (p[3][1] - p[0][1]) + u * (p[2][1] - p[1][1]);
    const det = xu * yv - xv * yu;
    if (!det) break;
    u -= (fx * yv - fy * xv) / det;
    v -= (fy * xu - fx * yu) / det;
  }
  return { x: u * 2040 - 0.5, y: v * 2040 - 0.5 };
}

/** The photos that are loaded, on the display grid: those on the stage and those of the other ranges of colour. @returns {Picture[]} */
function loadedPhotos() {
  /** @type {Picture[]} */
  const out = made ? [...made.photos] : [];
  const size = made?.size ?? DISPLAY_SIZE;
  for (const stamps of others.values()) for (const s of stamps) if (s.sky) out.push(toDisplayGrid(s, size));
  return out;
}

/** Every photo of the position, as the panels want it. @returns {PanelFrame[]} */
function panelFrames() {
  const photos = loadedPhotos(), byKey = new Map(photos.map((p) => [p.key, p]));
  if (showcase) {
    const { manifest, stamps } = showcase;
    return manifest.frames.map((f, i) => ({ key: f.key, det: manifest.det, mjd: f.mjd, lam: f.lam, bw: f.bw, visit: f.visit, loaded: true, flagged: flaggedAtTarget(stamps[i]) }));
  }
  if (!live) return [];
  const ra = address.ra ?? 0, dec = address.dec ?? 0, wl = connections.wavelengthAt ?? tableColours;
  const list = field ?? live.plan.visits.flatMap((v, visit) => v.frames.map((f) => ({ key: f.key, det: f.det, tmid: f.tmid, visit, corners: f.corners })));
  return list.map((f) => {
    const got = byKey.get(f.key);
    if (got) return { key: f.key, det: f.det, mjd: got.mjd, lam: got.lam, bw: got.bw, visit: f.visit, loaded: true, flagged: Boolean(got.members ? false : flaggedOnGrid(got)) };
    // a photo that was not read: its colour at the position, from where the position falls inside its outline
    const at = pixelFromCorners(f.corners, ra, dec), c = wl ? wl(/** @type {Det} */ (f.det), at.x, at.y) : { lam: NaN, bw: NaN };
    return { key: f.key, det: f.det, mjd: f.tmid, lam: c.lam, bw: c.bw, visit: f.visit, loaded: false, flagged: false };
  });
}

/** True when the target pixel of a photo on the grid is flagged or has no value. @param {Picture} p */
function flaggedOnGrid(p) {
  const k = p.ty * p.w + p.tx;
  return !Number.isFinite(p.data[k]) || (p.flags !== null && (p.flags[k] & (SATURATION_MASK | DEFECT_MASK)) !== 0);
}

/** Tell the panels what is loaded and what is on the stage. */
function tellPanels() {
  if (!panels) return;
  const to = panels;
  attempt(() => {
    to.setPictures(loadedPhotos());
    to.setFrames(panelFrames());
    to.setSelection(shown ? photosOf(shown).map((p) => p.key) : []);
  }, 'telling the panels beside the stage');
}

/** Mount the panels beside the stage, once, when there are pictures on the display grid to show them. */
function askPanels() {
  if (panelsAsked || address.embed) return;
  panelsAsked = true;
  import('../ui/panels.js').then((m) => {
    panels = m.mountPanels(
      { frameMap: section('frame-map'), spectrum: section('spectrum'), isItReal: section('is-it-real') },
      { showFrame, selectFrames, loadAllColours },
      { fast: false, onAnswer: showAnswer }, // the list of fast stars is loaded by this page, for the ticks on the stage: see askRings
    );
    tellPanels();
    if (lastPick && parts().stage.picked) pick(lastPick); // a click that came before the panels did
  }).catch(() => { /* without the panels the page works as it is */ });
}

/**
 * One photo on the stage, for as long as the panels point at it; null to go back to what was shown.
 * @param {string | null} key
 */
function showFrame(key) {
  const { stage } = parts();
  if (key === null) {
    if (!peeked) return;
    const was = peeked;
    peeked = null;
    stage.show(was.view);
    if (was.playing) stage.play();
    else stage.pause();
    return;
  }
  const at = made ? made.singles.findIndex(([a, b]) => a.key === key || b.key === key) : -1;
  if (!made || at < 0) return;
  peeked ??= { view: shown, playing: stage.playing };
  const [a, b] = made.singles[at];
  stage.show(dressed({ a, b }), a.key === key ? 'a' : 'b');
  stage.pause();
}

/** Blink only the photos named; none for all. @param {string[]} keys */
function selectFrames(keys) {
  selection = new Set(keys);
  chosen = 0;
  refresh();
}

/**
 * What the readout says when nothing is pointed at: the place that was clicked, else the centre of the view, so that
 * the panel starts full; null when the picture has no place to read.
 * @returns {{read: Readout, name: string} | null}
 */
function resting() {
  const { stage } = parts();
  if (!shown) return null;
  const clicked = stage.picked, kind = stage.side === 'b' ? 'b' : 'a';
  const picture = kind === 'b' ? shown.b : shown.a;
  const x = clicked ? clicked.x : Math.round(picture.tx), y = clicked ? clicked.y : Math.round(picture.ty);
  if (!(x >= 0 && y >= 0 && x < picture.w && y < picture.h) || (!clicked && !picture.sky)) return null;
  return { read: readoutOf({ kind, picture, x, y }), name: clicked ? 'Place clicked' : 'Centre of the view' };
}

function showRest() {
  const r = resting();
  parts().hover.show(r ? r.read : null, r?.name);
  const { satBox } = parts();
  const text = shown && seeKind !== 'saturated' && (centreSaturated(shown.a) || centreSaturated(shown.b)) ? saturationNote({ moves: seeKind === 'mover', prepared: seeKind !== '' }) : '';
  satBox.textContent = text;
  satBox.hidden = text === '';
}

/**
 * The sentence about what is shown, what is known about the place and the links to look it up elsewhere stand in the desk beside the plate
 * while there is a plate, and under the name when there is none.
 * @param {boolean} on
 */
function dock(on) {
  const lede = document.getElementById('view-lede'), facts = document.getElementById('view-where'), look = document.getElementById('lookup'), head = document.querySelector('.view-head');
  if (!lede || !facts || !look || !head) return;
  const { stage } = parts();
  if (on) {
    stage.slot.prepend(lede);
    stage.slot.append(facts, look);
  } else {
    head.append(lede);
    head.after(facts);
    document.getElementById('stage')?.after(document.getElementById('plan') ?? look, look);
  }
}

/** Keep the place that was clicked in the address, or take it out. @param {[number, number] | null} sky */
function setPicked(sky) {
  const same = sky === pickedSky || (sky && pickedSky && formatAt(sky[0], sky[1]) === formatAt(pickedSky[0], pickedSky[1]));
  pickedSky = sky;
  if (!same) writeAddress();
}

/**
 * Mark the place that the address carries on the first picture that can show it, as if it had been clicked. A place
 * that is not on the picture is left out of the address. Done once.
 */
function restorePick() {
  if (!pendingPick || !shown) return;
  const [ra, dec] = pendingPick, p = shown.a;
  pendingPick = null;
  const at = p.sky ? skyToPixel(p.sky, p.tx, p.ty, ra, dec) : null;
  const { stage } = parts();
  if (!at || !stage.pickAt(at.x, at.y, 'b')) setPicked(null);
}

/** The visitor clicked a pixel of a picture: the panels are told where, and what each loaded photo has there. @param {StagePoint} point */
function pick(point) {
  if (!point.touch) showRest();
  lastPick = point;
  const sky = point.picture.sky ? skyAt(point.picture.sky, point.picture.tx, point.picture.ty, point.x, point.y) : null;
  setPicked(sky && Number.isFinite(sky[0]) && Number.isFinite(sky[1]) ? sky : null);
  if (!panels) return;
  const p = point.picture, photos = loadedPhotos();
  if (!photos.length || photos[0].w !== p.w || photos[0].h !== p.h) return;
  const [ra, dec] = p.sky ? skyAt(p.sky, p.tx, p.ty, point.x, point.y) : [NaN, NaN];
  parts().lookup.setClicked(ra, dec);
  const k = point.y * p.w + point.x;
  const to = panels;
  attempt(() => to.pointAt({ ra, dec, x: point.x, y: point.y, values: photos.map((s) => ({ key: s.key, value: s.data[k] })) }), 'telling the panels where the visitor clicked');
}

// ---------------------------------------------------------------------------------------------
// A prepared target
// ---------------------------------------------------------------------------------------------

/** @param {string} t */
async function openShowcase(t) {
  withdraw();
  const my = ++run;
  const { plan, stateBox, strip, capNote } = parts();
  clearState(stateBox);
  capNote.hidden = true;
  named = null;
  titleAt = null;
  targetLive = false;
  figure = '';
  showSee(null);
  showNamed();
  showRanges(false);
  forget(['colours', 'visits', 'photos', 'source']);
  timing = { ...timing, opened: 0, done: false, state: null };
  const folder = showcaseFolder(t);
  const pickOne = `Pick one of the five: ${FIVE_TARGETS.map(([, label]) => label).join(', ')}. Or type a place in the box above.`;
  if (!folder) {
    notice('no-target', 'This address does not name a prepared target.', pickOne, ['targets']);
    return;
  }
  plan.busy('Loading the pictures of this target…');
  setLede('Loading the pictures of this target.');
  const got = await loadShowcase(folder);
  if (my !== run) return;
  plan.clear();
  if (!got.ok) {
    if (got.reason === 'missing') notice('no-target', `There is no prepared target called “${t}”.`, pickOne, ['targets']);
    else if (got.reason === 'unreachable') showState('unreachable');
    else notice('bad-target', 'The files of this target cannot be read.', 'Pick another one from the list of targets.', ['targets']);
    return;
  }
  const { manifest } = got;
  const [card, numbers] = await Promise.all([loadCard(folder), loadNumbers()]);
  if (my !== run) return;
  figure = figureOf(card, numbers);
  // a target whose stored pictures are at a colour its card calls too bright to measure opens, where the page can
  // read the archive, at the colour the card measures; an address that names the detector asks for the stored pictures
  const measured = client && address.det === undefined && address.a === undefined && address.b === undefined ? measuredRange(card, manifest.det) : null;
  if (measured !== null) {
    named = {
      title: manifest.name, line: 'Opened at the colours its card measures, read from the archive.',
      link: { href: viewUrl({ t, det: manifest.det }), text: 'Open the stored pictures, where it is too bright to measure' },
    };
    setAddress({ t: undefined, ra: micro(manifest.ra), dec: micro(manifest.dec), det: /** @type {Det} */ (measured) });
    targetLive = true;
    openPosition();
    return;
  }
  // the pixels of a showcase on the display grid are not pixels of the detector: where its stamp was cut says
  // nothing about the pixel behind a pixel of the picture
  const stamps = manifest.grid === 'north-up' ? got.stamps.map((s) => ({ ...s, x0: NaN, y0: NaN })) : got.stamps;
  /** @type {Tile[]} */
  const tiles = showcaseVisits(manifest).map((v) => ({
    id: visitId(v.mjd), mjd: v.mjd, photos: v.frames.length, short: false, index: v.visit,
    colours: v.frames.map((i) => ({ lam: manifest.frames[i].lam, det: manifest.det })),
  }));
  showcase = { manifest, stamps, tiles, at: [-1, -1] };
  live = null;
  field = null;
  others = new Map();
  selection = new Set();
  setTitle(manifest.name);
  describe(manifest.ra, manifest.dec, manifest.det);
  // a prepared target is whole on this site: every one of its photos is here
  fact('visits', String(tiles.length));
  fact('photos', String(manifest.frames.length));
  fact('source', 'Files of this site');

  let a = findVisit(tiles, address.a), b = findVisit(tiles, address.b);
  if (a < 0 || b < 0 || a === b) {
    const first = defaultVisits(manifest);
    a = first ? tiles.findIndex((x) => x.index === first[0]) : -1;
    b = first ? tiles.findIndex((x) => x.index === first[1]) : -1;
  }
  if (a > b) [a, b] = [b, a];
  strip.show(tiles, a >= 0 && b >= 0 ? [a, b] : null);
  showSee(card);
  showShowcasePairs(a, b);
}

/** @param {number} a @param {number} b  Positions in the tiles of the showcase; -1 for none. */
function showShowcasePairs(a, b) {
  if (!showcase) return;
  const { manifest, stamps, tiles } = showcase;
  showcase.at = [a, b];
  setLede(ledeFor(tiles, a >= 0 && b >= 0 ? [tiles[a], tiles[b]] : null));
  clearState(parts().stateBox);
  const found = a >= 0 && b >= 0 ? pairsBetween(manifest, tiles[a].index, tiles[b].index) : [];
  // each photo knows the visit it belongs to (the same object, so that it is still the one the page put on the grid)
  /** @param {Stamp} stamp @param {number} mjd @returns {Picture} */
  const ofVisit = (stamp, mjd) => Object.assign(pictureOf(stamp, null), { visitMjd: mjd });
  pairs = found.map(([i, j]) => [ofVisit(stamps[i], tiles[a].mjd), ofVisit(stamps[j], tiles[b].mjd)]);
  chosen = 0;
  selection = new Set();
  if (!pairs.length) notice('no-pairs', 'These two visits have no photos at the same colour.', 'Choose two other visits below.');
  refresh();
}

// ---------------------------------------------------------------------------------------------
// What was typed: a position, a name
// ---------------------------------------------------------------------------------------------

/** The list of names of this site; null when it cannot be had. @returns {Promise<NamesFile | null>} */
function loadNames() {
  namesAsked ??= fetch(NAMES_FILE).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return namesAsked;
}

/**
 * The detector a named target opens in: the one of its prepared view, or, when its card calls that range too bright
 * to measure, the one the card measures. Null when it has no prepared view.
 * @param {NameEntry} entry
 * @returns {Promise<{det: Det, t: string, stored: Det, figure: string} | null>}
 */
async function preparedFor(entry) {
  const t = PREPARED[entry.id] ?? (entry.kind === 'star' ? entry.id : null);
  const folder = t ? showcaseFolder(t) : null;
  if (!t || !folder) return null;
  try {
    const r = await fetch(folder + MANIFEST_FILE);
    if (!r.ok) return null;
    const stored = (await r.json()).det;
    if (!(Number.isInteger(stored) && stored >= 1 && stored <= 6)) return null;
    // the comet has no card: its folder is asked for none
    const [card, numbers] = await Promise.all([entry.kind === 'comet' ? null : loadCard(folder), loadNumbers()]);
    const measured = measuredRange(card, stored);
    return { det: /** @type {Det} */ (measured ?? stored), t, stored, figure: figureOf(card, numbers) };
  } catch {
    return null;
  }
}

/** The link to the stored pictures of a prepared target. @param {{det: Det, t: string, stored: Det}} prepared */
function preparedLink(prepared) {
  return prepared.det === prepared.stored
    ? { href: viewUrl({ t: prepared.t }), text: 'Open the prepared view of this target' }
    : { href: viewUrl({ t: prepared.t, det: prepared.stored }), text: 'Open the stored pictures, where it is too bright to measure' };
}

/**
 * The text of the box: read it, say what it was taken for, rewrite the address to a position and open it.
 * @param {string} text
 */
async function openQuery(text) {
  withdraw();
  const my = ++run;
  const { plan: box, stateBox, strip, capNote } = parts();
  showcase = null;
  live = null;
  named = null;
  titleAt = null;
  targetLive = false;
  figure = '';
  showSee(null);
  showNamed();
  showRanges(false);
  forget(['colours', 'visits', 'photos', 'source']);
  capNote.hidden = true;
  strip.show([]);
  pairs = [];
  choices = [];
  put(null);
  clearState(stateBox);
  setTitle('');
  timing = { opened: performance.now(), planMs: null, firstPairMs: null, fullMs: null, bytes: 0, photos: 0, state: null, held: false, askedAgain: false, done: false };
  box.busy('Reading what was typed…');
  setLede('Looking for SPHEREx photos of this place.');
  // a moving object: it stays here, with the words for it, and the comet's page as a link
  const moving = movingBody(text);
  if (moving && moving.name !== 'Pluto') {
    setTitle(moving.name);
    box.clear();
    notice('moving', moving.said.charAt(0).toUpperCase() + moving.said.slice(1), 'Between two visits months apart it is not at the same place among the stars, so two photos of one patch of sky would not show it. The page of the comet shows how a moving object is followed.', [{ href: 'lemmon.html', text: 'The page of the comet' }, 'targets']);
    setLede('No pictures are shown for this name.');
    return;
  }
  const list = await loadNames();
  if (my !== run) return;
  const typed = parseCoords(text);
  const found = list ? resolveInput(text, list) : typed.ok ? { kind: /** @type {const} */ ('position'), ra: typed.ra, dec: typed.dec, snap: null } : { kind: /** @type {const} */ ('none'), message: typed.message, suggestions: [] };

  if (found.kind === 'position') {
    setAddress({ ra: micro(found.ra), dec: micro(found.dec), q: undefined });
    openTyped(found.snap);
    return;
  }
  if (found.kind === 'name' && found.entry.kind === 'planet') {
    // a planet moves too far between the visits to be found by this method, and both checks of Pluto failed their rules, so no
    // pictures are shown under its name
    setTitle(found.entry.name);
    box.clear();
    notice('not-shown', `${found.entry.name} is not shown here.`, 'Its two checks, photo by photo, did not meet the rules written before they were run, so pictures of its place would suggest something that was not verified.', [{ href: 'checks.html#K-pluto-blink', text: 'How this was checked' }, 'targets']);
    setLede('No pictures are shown for this name.');
    return;
  }
  if (found.kind === 'name') {
    const entry = found.entry, prepared = await preparedFor(entry);
    if (my !== run) return;
    figure = prepared?.figure ?? '';
    named = {
      title: entry.name, line: entry.note ?? '',
      ...(entry.kind === 'comet' ? { link: { href: 'lemmon.html', text: 'The page of the comet' } } : prepared ? { link: preparedLink(prepared) } : {}),
    };
    setAddress({ ra: micro(entry.ra), dec: micro(entry.dec), det: address.det ?? prepared?.det, q: undefined });
    openPosition();
    return;
  }
  // not a position and not a name of this site: the name resolver of the CDS may know it
  /** @type {('targets' | 'home' | {href: string, text: string})[]} */
  const links = [...found.suggestions.map((s) => ({ href: viewUrl({ q: s.name }), text: s.name })), 'home', 'targets'];
  const coordinates = 'Type its coordinates instead: right ascension, then declination, in degrees or in hours, minutes and seconds.';
  if (!looksLikeName(text)) {
    box.clear();
    notice('no-position', 'That does not read as a sky position or as a name.', found.message, links);
    return;
  }
  box.busy(`Asking the name service of the CDS for “${text}”…`);
  const got = await resolveName(text, { epoch: list?.epoch ?? 2026 });
  if (my !== run) return;
  if (!got.ok) {
    box.clear();
    if (got.reason === 'not-found') notice('no-name', `The name “${text}” is not in this site's own list, and the name service of the CDS does not know it either.`, coordinates, links);
    else notice('no-name', `The name “${text}” is not in this site's own list, and the name service that knows other names cannot be reached right now.`, coordinates, links);
    return;
  }
  const moved = got.movedArcsec >= 3
    ? ` It gives where the star was in 2000. The star has moved ${got.movedArcsec >= 90 ? `${(got.movedArcsec / 60).toFixed(1)} arcmin` : `${Math.round(got.movedArcsec)} arcsec`} since, and the view is centred on where it is now.`
    : '';
  named = { title: got.name, line: `Position from the name service of the CDS${got.by ? ` (${got.by === 'Simbad' ? 'SIMBAD' : got.by})` : ''}.${moved}` };
  setAddress({ ra: micro(got.ra), dec: micro(got.dec), q: undefined });
  openPosition();
}

/**
 * A position of the address. Unless the address says "as typed", a position where a fast star of this site's list
 * used to be moves to where the star is now, with a line that says so and a link back.
 * @param {import('../lib/names.js').Snap | null} [known]  The star, when it has been looked for already.
 */
async function openTyped(known) {
  withdraw();
  const my = ++run;
  const ra = address.ra ?? 0, dec = address.dec ?? 0;
  named = null;
  titleAt = null;
  targetLive = false;
  figure = '';
  if (address.q !== undefined) {
    // a name in the address is taken on trust only where it fits: an edited or outdated address shows its coordinates
    const fits = await labelFits(address.q);
    if (my !== run) return;
    if (!fits) {
      setAddress({ q: undefined });
      if (searchBox) searchBox.value = boxText();
    }
  }
  let snap = known ?? null;
  if (known === undefined) {
    parts().plan.busy('Looking for photos of this position…');
    const list = await loadNames();
    if (my !== run) return;
    snap = list ? attempt(() => snapSuggestion(ra, dec, list), 'looking for a fast star near the position') : null;
  }
  if (snap && !asTyped) {
    const prepared = await preparedFor(snap.entry);
    if (my !== run) return;
    figure = prepared?.figure ?? '';
    // the title says the position that was typed; what the star is stands in the line under it
    titleAt = [ra, dec];
    named = {
      title: '', line: `${snap.text} The view is centred on where the star is now.`,
      link: { href: viewUrl({ ra: micro(ra), dec: micro(dec), det: address.det }) + AS_TYPED, text: 'Show the position as typed' },
    };
    setAddress({ ra: micro(snap.ra), dec: micro(snap.dec), det: address.det ?? prepared?.det });
  } else if (snap) {
    named = {
      title: '', line: `This is the position as typed. ${snap.entry.name} was near here in the past and is now ${snap.distanceArcmin.toFixed(1)} arcmin away.`,
      link: { href: viewUrl({ ra: micro(snap.ra), dec: micro(snap.dec), det: address.det }), text: `Go to ${snap.entry.name}` },
    };
  }
  openPosition();
}

// ---------------------------------------------------------------------------------------------
// A position, read live
// ---------------------------------------------------------------------------------------------

/**
 * A part of a plan: the pairs from `from` up to `to`, with their share of the cost. A reader that keeps a list of
 * its own beside the pairs (`loads`, one entry for each pair) has it cut the same way.
 * @param {Plan} plan @param {number} from @param {number} [to]
 * @returns {Plan}
 */
export function cutPlan(plan, from, to) {
  const n = plan.pairs.length, cut = plan.pairs.slice(from, to), share = n ? cut.length / n : 0;
  /** @type {Plan & {loads?: unknown}} */
  const part = { ...plan, pairs: cut, bytes: Math.round(plan.bytes * share), seconds: Math.max(1, Math.round(plan.seconds * share)) };
  const loads = /** @type {{loads?: unknown}} */ (plan).loads;
  if (Array.isArray(loads) && loads.length === n) part.loads = loads.slice(from, to);
  return part;
}

/**
 * The two visits a plan compares, as positions in `plan.visits`: the visits that hold the frames of its first pair.
 * @param {Plan} plan
 * @returns {[number, number] | null}
 */
function comparedVisits(plan) {
  if (!plan.pairs.length) return null;
  /** @param {Frame} frame */
  const holder = (frame) => plan.visits.findIndex((v) => v.frames.some((f) => f.key === frame.key));
  const i = holder(plan.pairs[0][0]), j = holder(plan.pairs[0][1]);
  return i >= 0 && j >= 0 ? [i, j] : null;
}

/**
 * The tiles of the visits of a plan. A plan does not say at which colours a visit was photographed; what earlier
 * loads of this position have brought to light is kept.
 * @param {Plan} plan
 * @returns {Tile[]}
 */
function tilesOf(plan) {
  const before = live?.tiles ?? [];
  return tilesOfVisits(plan.visits).map((t) => ({ ...t, colours: before.find((old) => old.index === t.index && old.id === t.id)?.colours }));
}

/**
 * The tiles of the two visits that are compared get the colours of their photos that have been read.
 * @param {Plan} plan  The plan the loaded pairs belong to.
 */
function noteColours(plan) {
  const compared = comparedVisits(plan);
  if (!live || !compared) return;
  for (const [k, visit] of compared.entries()) {
    const i = live.tiles.findIndex((t) => t.index === visit);
    if (i < 0) continue;
    const known = new Map((live.tiles[i].colours ?? []).map((c) => [`${c.det} ${c.lam.toFixed(4)}`, c]));
    for (const pair of pairs) known.set(`${pair[k].det} ${pair[k].lam.toFixed(4)}`, { lam: pair[k].lam, det: pair[k].det });
    const colours = [...known.values()].sort((p, q) => p.lam - q.lam);
    live.tiles[i].colours = colours;
    parts().strip.setColours(i, colours);
  }
}

/**
 * What a plan left out, in words: at a position that SPHEREx photographed thousands of times, only some photos of
 * each visit are looked at for pairs.
 * @param {Plan} plan
 * @returns {string}
 */
export function capText(plan) {
  const compared = comparedVisits(plan);
  if (!compared) return '';
  const counts = compared.map((v) => plan.visits[v].frames.length);
  if (!counts.some((n) => n > MAX_HEADERS_PER_VISIT)) return '';
  const total = plan.visits.reduce((n, v) => n + v.frames.length, 0);
  return `SPHEREx photographed this position ${total.toLocaleString('en-GB')} times in this range of colours: the two visits compared have ${counts[0].toLocaleString('en-GB')} and ${counts[1].toLocaleString('en-GB')} photos. `
    + `To keep the wait short the plan is capped: ${MAX_HEADERS_PER_VISIT} photos of each visit, spread over it, were looked at for pairs at the same colour.`;
}

/**
 * True for an answer of the client that is a plan: not a failure, and with its visits and its pairs.
 * @param {unknown} answer
 * @returns {answer is Plan}
 */
function isPlan(answer) {
  const p = /** @type {{visits?: unknown, pairs?: unknown} | null} */ (answer);
  return p !== null && typeof p === 'object' && !isFailure(p) && Array.isArray(p.visits) && Array.isArray(p.pairs);
}

/**
 * Ask the client for a plan. A client that can plan a named pair of visits takes it as a fourth argument (the
 * reader of this site does); another one ignores it.
 * @param {Client} from @param {number} ra @param {number} dec @param {Det} det
 * @param {[number, number] | null} visitPair  Positions in the visits of an earlier plan, or null.
 * @returns {Promise<Plan | Failure>}
 */
async function askPlan(from, ra, dec, det, visitPair) {
  const reader = /** @type {{plan: (ra: number, dec: number, det: Det, opts?: {visitPair: [number, number]}) => Promise<Plan | Failure>}} */ (from);
  const call = { from };
  calls.add(call);
  try {
    return await (visitPair ? reader.plan(ra, dec, det, { visitPair }) : reader.plan(ra, dec, det));
  } catch (e) {
    // a client gives states, not exceptions; one that throws all the same is treated as out of reach
    console.error('viewer: the client threw while planning', e);
    return { state: 'unreachable' };
  } finally {
    calls.delete(call);
  }
}

/** Withdraw the calls that are still waiting, from each client that can do that; their answers are dropped anyway. */
function withdraw() {
  const busy = new Set([...calls].map((c) => c.from));
  calls.clear();
  for (const from of busy) attempt(() => /** @type {{cancel?: () => void}} */ (from).cancel?.(), 'withdrawing a request');
}

/** A place of the long list within this many arcmin of a typed position is named under its title: about the half of a picture. */
const NEAR_ARCMIN = 3;
/** @type {Promise<{places?: {name: string, ra: number, dec: number}[]} | null> | null} */
let placesAsked = null;

/** A label in an address agrees with the coordinates in it when it names a place that lies within this many arcmin of them. */
const LABEL_FITS_ARCMIN = 1.5;
/** A position typed as a label agrees with the coordinates of the address that far away: a fast star's view is centred on where it is now. */
const TYPED_FITS_ARCMIN = 10;

/**
 * Whether the label of an address (`q`) may stand beside its coordinates. A name of this site's lists that lies
 * elsewhere than the coordinates is stale; a label that no list knows is taken as it is.
 * @param {string} q
 * @returns {Promise<boolean>}
 */
async function labelFits(q) {
  const ra = address.ra ?? 0, dec = address.dec ?? 0;
  const typed = parseCoords(q);
  if (typed.ok) return separationDeg(typed.ra, typed.dec, ra, dec) * 60 <= TYPED_FITS_ARCMIN;
  placesAsked ??= fetch('data/places.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [list, file] = await Promise.all([loadNames(), placesAsked]);
  const key = plain(q);
  /** @type {{ra: number, dec: number}[]} */
  const hits = [];
  for (const e of list?.entries ?? []) if (!e.fast && [e.name, ...(e.aliases ?? [])].some((n) => plain(n) === key)) hits.push(e);
  for (const p of /** @type {{name: string, aliases?: string[], ra: number, dec: number}[]} */ (file?.places ?? [])) {
    if ([p.name, ...(p.aliases ?? [])].some((n) => plain(n) === key)) hits.push(p);
  }
  return hits.length === 0 || hits.some((h) => separationDeg(h.ra, h.dec, ra, dec) * 60 <= LABEL_FITS_ARCMIN);
}

/** What the box holds for an address: what was typed, else the position, written so that it can be typed again. @returns {string} */
function boxText() {
  if (address.q !== undefined) return address.q;
  if (address.t === undefined && address.ra !== undefined && address.dec !== undefined) return `${Number(address.ra.toFixed(4))} ${Number(address.dec.toFixed(4))}`;
  return '';
}

/**
 * The raw text of a position in an address that cannot be read, for the box; null when the address gives no position part.
 * @param {string} search
 * @returns {string | null}
 */
function unreadablePosition(search) {
  const q = new URLSearchParams(search);
  if (!q.has('ra') && !q.has('dec')) return null;
  return address.ra !== undefined && address.dec !== undefined ? null : [q.get('ra'), q.get('dec')].filter((v) => v !== null && v !== '').join(' ');
}

/**
 * Under the title of a position that has no name: the nearest place of the list that lies in the picture, with its distance.
 * @param {number} ra @param {number} dec @param {number} my  The opening this belongs to.
 */
async function nearPlace(ra, dec, my) {
  if (named) return;
  placesAsked ??= fetch('data/places.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const file = await placesAsked;
  if (!file?.places || my !== run || named) return;
  /** @type {{name: string, arcmin: number} | null} */
  let best = null;
  for (const p of file.places) {
    const arcmin = separationDeg(p.ra, p.dec, ra, dec) * 60;
    if (arcmin <= NEAR_ARCMIN && (!best || arcmin < best.arcmin)) best = { name: p.name, arcmin };
  }
  if (!best) return;
  const { namedLine } = parts();
  const place = best.name.replace(/'/g, '’');
  namedLine.textContent = best.arcmin < 0.1 ? `The position of ${place}.` : `Near ${place}, ${best.arcmin.toFixed(1)}′ away`;
  namedLine.hidden = false;
}

/** @param {[number, number] | null} [visitPair]  The two visits the visitor chose, as positions in the visits of the last plan. */
async function openPosition(visitPair = null) {
  withdraw(); // what an earlier opening still has on its way
  const my = ++run;
  const { plan: box, stateBox, strip, capNote } = parts();
  const ra = address.ra ?? 0, dec = address.dec ?? 0, det = address.det ?? DEFAULT_DET;
  showcase = null;
  setTitle(named?.title || address.q || '');
  describe(ra, dec, det);
  showNamed();
  nearPlace(ra, dec, my);
  showRanges(true);
  if (!visitPair) forget(['visits', 'photos', 'source']);
  clearState(stateBox);
  capNote.hidden = true;
  if (!client) {
    box.clear();
    notice('not-connected', 'Reading a typed position straight from the archive is not switched on yet.', 'The prepared targets work.', ['targets']);
    return;
  }
  const reader = client;
  if (visitPair && shown && live) {
    // the visitor chose two other visits of what is on the stage: the stage waits for them
    kept ??= { plan: live.plan, pairs, choices, chosen };
    setWaiting(true);
  } else put(null);
  pairs = [];
  choices = [];
  chosen = 0;
  selection = new Set();
  others = new Map();
  if (!visitPair) field = null;
  timing = { opened: performance.now(), planMs: null, firstPairMs: null, fullMs: null, bytes: 0, photos: 0, state: null, held: false, askedAgain: false, done: false };
  box.busy('Looking for photos of this position…');
  setLede('Looking for SPHEREx photos of this place.');

  /** The plan whose visits the strip shows: the one the visitor chose two visits from, or the first of this opening. */
  let base = visitPair ? live?.plan ?? null : null;
  /** @type {[number, number] | null} The two visits that were asked for by name, as positions in the visits of that plan. */
  let asked = visitPair;
  let answer = await askPlan(reader, ra, dec, det, visitPair);
  if (my !== run) return;
  if (!visitPair && isPlan(answer)) {
    base = answer;
    // the address may name two visits: plan again for them when they are not the two the plan chose
    const first = tilesOfVisits(answer.visits);
    const a = findVisit(first, address.a), b = findVisit(first, address.b), now = comparedVisits(answer);
    if (a >= 0 && b >= 0 && a !== b) {
      /** @type {[number, number]} */
      const named = [first[Math.min(a, b)].index, first[Math.max(a, b)].index];
      if (!now || now[0] !== named[0] || now[1] !== named[1]) {
        asked = named;
        answer = await askPlan(reader, ra, dec, det, named);
        if (my !== run) return;
      }
    }
  }
  timing.planMs = performance.now() - timing.opened;
  const plan = isPlan(answer) ? answer : null, known = plan ?? base;
  if (!known) {
    // nothing is known about this position
    live = null;
    strip.show([]);
    box.clear();
    showState(isFailure(answer) ? answer.state : 'unreachable');
    return;
  }
  const tiles = tilesOf(known);
  const compared = (plan ? comparedVisits(plan) : null) ?? asked;
  const a = compared ? tiles.findIndex((t) => t.index === compared[0]) : -1, b = compared ? tiles.findIndex((t) => t.index === compared[1]) : -1;
  live = { plan: known, tiles };
  strip.show(tiles, a >= 0 && b >= 0 ? [a, b] : null);
  setLede(ledeFor(tiles, a >= 0 && b >= 0 ? [tiles[a], tiles[b]] : null));
  fact('visits', String(tiles.length));
  countPhotos();
  fact('source', plan && plan.pairs.length ? `NASA archive · ${formatMB(plan.bytes)} MB` : 'NASA archive');
  if (!plan || !plan.pairs.length) {
    box.clear();
    // the visits are known, so a plan without pairs, or "no coverage" for two named visits, says one thing:
    // these two visits have no photos that can be compared
    const state = plan ? 'no-coverage' : isFailure(answer) ? answer.state : 'unreachable';
    if (state !== 'no-coverage') {
      showState(state);
      return;
    }
    if (tiles.length > 2) notice('no-pairs', 'These two visits have no photos at the same colour.', 'Choose two other visits below.');
    else notice('no-pairs', 'These two visits have no photos at the same colour.', 'A later release of the data may bring photos that match.', ['targets']);
    put(null);
    return;
  }
  box.showPlan(plan);
  setLede(`Reading ${formatMB(plan.bytes)} MB from the NASA archive, ${formatSeconds(plan.seconds)}.`);
  const cap = capText(plan);
  capNote.textContent = cap;
  capNote.hidden = cap === '';
  // the first pair is loaded alone, so that it can be shown the moment it arrives
  await loadParts(my, plan, plan.pairs.length > 1 ? [cutPlan(plan, 0, 1), cutPlan(plan, 1)] : [plan], 0);
}

/**
 * Load parts of a plan one after the other; the pairs of each part are shown as soon as it has arrived. When the
 * first pair was slow to arrive, the rest is not loaded: it waits behind "Load more", as it does when the reader
 * itself holds pairs back.
 * @param {number} my  The opening this belongs to.
 * @param {Plan} whole  The plan the parts were cut from.
 * @param {Plan[]} list
 * @param {number} doneBefore  Photos that earlier loads of the same view brought.
 * @param {boolean} [again]  This call asks once more for what the reader held back: it is not done a second time.
 */
async function loadParts(my, whole, list, doneBefore, again = false) {
  const reader = client;
  if (!reader) return;
  const { plan: box } = parts();
  const before = { done: doneBefore, total: doneBefore + list.reduce((n, p) => n + p.pairs.length * 2, 0), bytes: 0 };
  // a reader that holds pairs back on a slow link says so in the plan (`more`) or while it loads
  /** @type {Plan | null} */
  let held = /** @type {{more?: Plan | null}} */ (whole).more ?? null;
  /** What the reader held back while it loaded a part after the first, and how long the first pair took alone, ms. */
  const late = { plan: /** @type {Plan | null} */ (null), firstMs: /** @type {number | null} */ (null) };
  timing.done = false;
  // what the pictures said so far (too bright, too faint) is said again once the new photos are in
  if (timing.state === 'too-bright' || timing.state === 'too-faint') {
    clearState(parts().stateBox);
    timing.state = null;
  }
  for (const [i, part] of list.entries()) {
    const began = performance.now();
    let bytes = 0;
    /** @type {Stamp[] | Failure} */
    let got;
    const call = { from: reader };
    calls.add(call);
    try {
      got = await reader.load(part, (report) => {
        if (my !== run) return;
        const r = /** @type {{type?: unknown, plan?: Plan} | null} */ (report);
        if (r && typeof r === 'object' && r.type === 'more' && r.plan) {
          held = r.plan;
          if (i > 0) late.plan = r.plan;
        }
        bytes = progressOf(report)?.bytes ?? bytes;
        box.progress(report, before);
        const got = progressOf(report);
        if (got && !pairs.length) setLede(`Reading the photos from the NASA archive: ${progressText({ done: got.done + before.done, total: before.total, bytes: got.bytes === null ? null : got.bytes + before.bytes }, whole.bytes)}.`);
      });
    } catch (e) {
      console.error('viewer: the client threw while loading', e);
      got = { state: 'unreachable' };
    } finally {
      calls.delete(call);
    }
    if (my !== run) return;
    if (isFailure(got) || !Array.isArray(got)) {
      box.finish();
      restoreLede();
      showState(isFailure(got) ? got.state : 'unreachable');
      return;
    }
    let arrived = 0;
    for (const [fa, fb] of part.pairs) {
      const a = got.find((s) => s.key === fa.key), b = got.find((s) => s.key === fb.key);
      if (!a || !b) continue;
      pairs.push([pictureOf(a, fa), pictureOf(b, fb)]);
      arrived++;
    }
    countPhotos();
    noteColours(whole);
    restoreLede();
    await refresh();
    if (my !== run) return;
    before.done += arrived * 2;
    before.bytes += bytes;
    timing.bytes += bytes;
    if (i === 0 && list.length === 2) {
      late.firstMs = performance.now() - began;
      // the link is slow: the first pair took long, so the rest is offered and not loaded
      if (!held && late.firstMs > FIRST_PAIR_SLOW_MS) {
        held = list[1];
        break;
      }
    }
  }
  // The reader holds pairs back when the first pair of a call is slow to arrive. In a call for many pairs at once
  // that pair can be among the last to arrive on a link that is not slow. The page has timed the first pair of the
  // position itself, loaded alone: when that one was quick, what was held back is asked for at once, one time.
  if (late.plan && held === late.plan && !again && late.firstMs !== null && late.firstMs <= FIRST_PAIR_SLOW_MS) {
    timing.askedAgain = true;
    await loadParts(my, late.plan, [late.plan], before.done, true);
    return;
  }
  box.finish();
  restoreLede();
  timing.photos = pairs.length * 2;
  timing.fullMs = performance.now() - timing.opened;
  const rest = held;
  timing.held = Boolean(rest && Array.isArray(rest.pairs) && rest.pairs.length);
  if (rest && Array.isArray(rest.pairs) && rest.pairs.length) {
    box.offer(`Load more (${formatMB(rest.bytes)} MB)`, () => { loadParts(my, rest, [rest], before.done); });
  }
  sayWhatThePicturesSay();
  if (!timing.state) timing.state = pairs.length ? 'ok' : 'empty';
  timing.done = true;
  if (!field) listField(my);
}

/** After the photos are in: a star that fills its pixels, or a place where nothing stands out, gets its plain message. */
function sayWhatThePicturesSay() {
  if (!made || showcase || !parts().stateBox.hidden) return;
  if (made.signs.tooBright) showState('too-bright');
  else if (made.signs.tooFaint) showState('too-faint');
}

/**
 * Every photo of the position, in all six ranges of colour, for the panels: read from the index once the pictures
 * are on the stage. A deep field, where the list is very long, keeps the photos of the range that is shown.
 * @param {number} my
 */
async function listField(my) {
  if (!live || !panelsAsked) return;
  if (live.plan.visits.reduce((n, v) => n + v.frames.length, 0) > DEEP_FIELD_PHOTOS) return;
  try {
    const frames = await framesCovering(address.ra ?? 0, address.dec ?? 0, new URL(INDEX_DIR, document.baseURI).href);
    if (my !== run || !frames.length) return;
    /** @type {Map<string, number>} */
    const visitOf = new Map();
    for (const [i, v] of visitRule(frames).entries()) for (const f of v.frames) visitOf.set(f.key, i);
    field = frames.map((f) => ({ key: f.key, det: f.det, tmid: f.tmid, visit: visitOf.get(f.key) ?? 0, corners: f.corners }));
    tellPanels();
  } catch { /* the panels keep the photos of the range of colours that is shown */ }
}

/**
 * Load the other five ranges of colour at this position, for the spectrum of a place. Nothing changes on the stage.
 * @returns {Promise<void>}
 */
async function loadAllColours() {
  if (!client || !live || showcase) return;
  const my = run, reader = client, ra = address.ra ?? 0, dec = address.dec ?? 0, own = address.det ?? DEFAULT_DET;
  const { capNote } = parts();
  const todo = [1, 2, 3, 4, 5, 6].filter((d) => d !== own && !others.has(d));
  for (const [i, det] of todo.entries()) {
    capNote.textContent = `Loading the other ranges of colour for the spectrum: ${i + 1} of ${todo.length}.`;
    capNote.hidden = false;
    const plan = await askPlan(reader, ra, dec, /** @type {Det} */ (det), null);
    if (my !== run) return;
    if (!isPlan(plan) || !plan.pairs.length) {
      if (isFailure(plan) && (plan.state === 'unreachable' || plan.state === 'slow')) { showState(plan.state); break; }
      others.set(det, []);
      continue;
    }
    /** @type {Stamp[] | Failure} */
    let got;
    const call = { from: reader };
    calls.add(call);
    try {
      got = await reader.load(plan);
    } catch {
      got = { state: 'unreachable' };
    } finally {
      calls.delete(call);
    }
    if (my !== run) return;
    if (!Array.isArray(got)) {
      if (isFailure(got) && got.state !== 'cancelled') showState(got.state);
      break;
    }
    others.set(det, got);
    tellPanels();
  }
  if (my !== run) return;
  const cap = capText(live.plan);
  capNote.textContent = cap;
  capNote.hidden = cap === '';
}

/** Two visits were chosen in the strip. @param {VisitTile} earlier @param {VisitTile} later */
function chooseVisits(earlier, later) {
  setAddress({ a: earlier.id, b: later.id });
  if (showcase) {
    showShowcasePairs(showcase.tiles.findIndex((t) => t.id === earlier.id), showcase.tiles.findIndex((t) => t.id === later.id));
  } else if (live) {
    const a = live.tiles.find((t) => t.id === earlier.id), b = live.tiles.find((t) => t.id === later.id);
    if (a && b) openPosition([a.index, b.index]);
  }
}

// ---------------------------------------------------------------------------------------------
// The reader of this site
// ---------------------------------------------------------------------------------------------

/**
 * The reader of this site as a client whose stamps carry their sky: while the stamps of a plan load, the headers
 * of their frames are read again for the transform (the reader itself hands on no transform).
 * @returns {Client & {cancel: () => void}}
 */
export function siteClient() {
  const skies = createSkyReader();
  return {
    plan: (ra, dec, det, ...more) => /** @type {Promise<Plan | Failure>} */ (/** @type {any} */ (siteReader.plan)(ra, dec, det, ...more)),
    async load(plan, onProgress) {
      const items = /** @type {{key: string, x0: number, y0: number, tx: number, ty: number}[]} */ ((/** @type {{loads?: unknown[][]}} */ (plan).loads ?? []).flat());
      const asked = Promise.all(items.map((it) => skies.skyOf(it.key, it)));
      const got = await /** @type {Promise<Stamp[] | Failure>} */ (/** @type {any} */ (siteReader.load)(plan, onProgress));
      if (!Array.isArray(got)) return got;
      const found = await asked, byKey = new Map(items.map((it, i) => [it.key, found[i]]));
      /** @type {Stamp[]} */
      const out = [];
      for (const s of got) {
        const sky = byKey.get(s.key);
        if (!sky) return { state: 'unreachable' }; // the photo is here and where it lies on the sky is not: nothing can be lined up
        out.push({ ...s, sky });
      }
      return out;
    },
    cancel() {
      siteReader.cancel();
      skies.cancel();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/** Open what the address names. */
function open() {
  const main = document.querySelector('main');
  const unreadable = address.t === undefined && address.q === undefined ? unreadablePosition(location.search) : null;
  // the start page has its own look; an address that cannot be read keeps the page of a message, so that it is seen
  if (main) main.dataset.empty = String(address.t === undefined && address.q === undefined && address.ra === undefined && unreadable === null);
  if (address.t !== undefined) openShowcase(address.t);
  else if (address.ra !== undefined && address.dec !== undefined) openTyped();
  else if (address.q !== undefined) openQuery(address.q);
  else if (unreadable !== null) {
    // an address with a position that makes no sense says so, as the box does, and keeps the text for the box
    withdraw();
    run++;
    titleAt = null;
    setTitle('');
    showRanges(false);
    forget(['colours', 'visits', 'photos', 'source']);
    parts().lookup.setCentre(null, null);
    if (searchBox) searchBox.value = unreadable;
    const q = new URLSearchParams(location.search);
    const given = q.has('ra') && q.has('dec');
    notice('bad-address', given ? 'The position in this address is not valid.' : 'This address does not give a sky position.', 'Right ascension is an angle from 0 to 360 degrees, and declination a number from −90 to 90. Type a place or a position in the box above, or open a prepared target.', ['targets', 'home']);
    setLede(EMPTY_LEDE);
  } else {
    withdraw();
    run++;
    setTitle('');
    showRanges(false);
    forget(['colours', 'visits', 'photos', 'source']);
    parts().lookup.setCentre(null, null);
    setLede(EMPTY_LEDE);
    showPlaces();
    notice('empty', 'Nothing is chosen yet.', 'Type a star\'s name or a sky position in the box above, or open a prepared target to see it at two visits.', ['targets', 'home']);
  }
}

/**
 * The hook for live positions: hand in the client (CT-12) and, with it, what else is connected. If the address
 * names a position, it is opened at once.
 * @param {Client} next
 * @param {Connections} [more]
 */
export function connectClient(next, more = {}) {
  client = next;
  connections = { ...connections, ...more };
  if (address.t === undefined && address.ra !== undefined && address.dec !== undefined) openPosition();
  else if (address.t === undefined && address.q !== undefined) openQuery(address.q);
  else if (showcase) showShowcasePairs(showcase.at[0], showcase.at[1]); // a showcase on the stage is made again with what is now connected
}

/** The parts of the page and what it shows now, for whoever connects more to it and for the tests. */
export function viewParts() {
  const p = parts();
  return {
    stage: p.stage, hover: p.hover, strip: p.strip, plan: p.plan, address: { ...address }, pairs: [...pairs], choices: [...choices], chosen,
    view: shown, made, timing: { ...timing }, link: viewLink(),
    // how many photos each visit of a position read live holds, in the range of colours that is shown
    visits: live && !showcase ? live.plan.visits.map((v) => v.frames.length) : [],
  };
}

async function start() {
  address = parseAddress(location.search);
  asTyped = location.hash === AS_TYPED;
  pendingPick = pickedSky = parseAt(location.search);
  if (address.embed) {
    document.documentElement.classList.add('is-embed');
    const back = document.getElementById('view-back');
    if (back instanceof HTMLAnchorElement) {
      back.href = viewUrl({ ...address, embed: undefined }, VIEW_PAGE) + (asTyped ? AS_TYPED : '');
      back.hidden = false;
    }
  }
  const p = parts();
  // the box in the masthead: another place can be typed from here. It shows what was typed to get here, and an
  // empty box sends nowhere
  const box = document.querySelector('form[data-position]'), typed = box?.querySelector('input[name="q"]');
  if (box instanceof HTMLFormElement && typed instanceof HTMLInputElement) {
    import('../ui/suggest.js').then((m) => m.mountSuggest(box)).catch(() => { /* the box works without its suggestions */ });
    searchBox = typed;
    // the box shows what was typed: the text of the address, or the position that it gives; when the address gives
    // nothing, what the visitor typed before this script ran is kept
    const given = boxText();
    if (given || !typed.value) typed.value = given;
    box.addEventListener('submit', (e) => {
      if (typed.value.trim() !== '') return;
      e.preventDefault();
      typed.focus();
    });
  }
  document.addEventListener('keydown', (e) => {
    // the keys of the stage work from anywhere on the page, as long as nothing else has the focus
    if (waiting || e.defaultPrevented || (e.target !== document.body && e.target !== document.documentElement)) return;
    if (p.stage.key(e)) e.preventDefault();
  });
  // the reader of this site, unless the page asked for none
  const options = /** @type {{viewerOptions?: {live?: boolean}}} */ (globalThis).viewerOptions;
  if (options?.live !== false) client = siteClient();
  open();

  // the colour ruler, the colour of every pixel in the readout and the veil come from the tables of this site
  const tables = await loadTables();
  if (!tables) return;
  tableColours = colourLookup(tables);
  p.ruler = createRuler(p.rulerBox, tables);
  if (shown) p.ruler.setMarks([{ lam: shown.a.lam, label: 'earlier visit' }, { lam: shown.b.lam, label: 'later visit' }]);
  if (showcase) describe(showcase.manifest.ra, showcase.manifest.dec, showcase.manifest.det);
  else if (address.t === undefined && address.ra !== undefined && address.dec !== undefined) {
    describe(address.ra, address.dec, address.det ?? DEFAULT_DET);
    showRanges(true);
    // photos that arrived before the tables are put together again, now with the veil
    if (made && pairs.length) refresh();
  }
}

start();
