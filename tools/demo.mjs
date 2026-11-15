#!/usr/bin/env node
// The thirty seconds of video. The site is filmed in a real browser, beat by beat as content/captions.txt says,
// with each caption burned in. One run writes the film, reads it back to check it, and writes a contact sheet.
//
//   node tools/demo.mjs --url <address of the site> --team "<team name>" --address "<public address>"
//
//   --url <address>      where the site is served: the public address for the film that is handed in, or a server
//                        on this computer for a rehearsal (node tools/serve.mjs --port 9000, then
//                        --url http://127.0.0.1:9000/). Without it the tool serves site/ itself while it runs.
//   --team "<name>"      the name of the team: {{site.team}} of the storyboard
//   --address "<text>"   the public address as the last card shows it: {{site.url}} of the storyboard
//   --position "<text>"  what is typed in the box for the view of a typed position
//   --out <file>         the film (default: content/out/video/demo.webm)
//   --sheet <file>       the contact sheet (default: review/video/sheet.png)
//   --frames <folder>    also keep the frame from the middle of each beat, full size
//   --part <beat>        film only the part that holds this beat (1 to 9), keep its frames in --frames and write
//                        no film: for trying a change
//
// Everything that says what is filmed is in the two tables below: ON names the elements of the pages, BEATS holds
// the beats with their steps. When the pages change, these two tables are what has to change.
//
// How it films:
//   - The browser is started with a window of 1280 by 720 and a scale of 150 %, as on a screen set so, and the film
//     is that window: 1920 by 1080, and still readable on a phone. Nothing of the site is changed for it.
//   - Thirty times a second a picture of the page is asked for, by the clock. The film therefore runs at the speed
//     of the page. Where the storyboard goes from one view to another, and where a page has to load, the clock
//     stops and starts again (a cut); nothing is ever played faster than it happened.
//   - The mouse and the keys are real. The pointer in the film is drawn where the mouse is, and a ring shows a press.
//   - The caption, the two cards and the line with the address are drawn over the page by this tool, in the
//     typeface and the colours of the site (css/tokens.css). A caption is the text that tools/render-content.mjs
//     makes of its line of the storyboard, with the name of the team and the address from the command.
//   - While a part is filmed the tool asks the page what it shows (the "expect" steps). A take that does not show
//     what its line of the storyboard says is filmed again, and after three takes the run fails.
//   - The frames are put together by the ffmpeg that comes with the test runner (VP9 in WebM, no sound). The film
//     is then read back with the same ffmpeg: its length, its size, and that the caption of each beat is on screen
//     from the start of its time slot to its end.
//
// The film stops 0.2 seconds before the thirty of the storyboard, so that no player counts it as longer.
//
// Needs the browser and the ffmpeg of the test runner (npx playwright install chromium ffmpeg) and, for the view of
// a typed position, the network: that view is read from the archive while it is filmed.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, renameSync, copyFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { fill, parseCaptions } from './render-content.mjs';

/** The star that is typed in the box; its card on the targets page has its name as its address. */
const STAR = 'Epsilon Indi B';
/** What is typed for the view of a typed position, unless the command says otherwise: the Ring Nebula, which shows as a small ring. */
const POSITION = '18 53 35.1 +33 01 45';

/**
 * The elements the film touches or reads, each by its role, its visible text or a data- attribute (the selectors of
 * the test runner: "role=", "text=", and ">>" for "inside").
 */
export const ON = Object.freeze({
  // the first page: "A plain blink lies"
  lie: '[data-lie]',
  lieStage: '[data-lie-stage]',
  liePhoto: '[data-lie-stage] >> role=img',
  liePause: '[data-lie-stage] >> role=button[name=/^pause$/i]',
  lieAll: '[data-lie] >> role=radio[name=/^All photos of one visit/]',
  lieSame: '[data-lie] >> role=radio[name=/^Same colour/]',
  lieSameMeter: '[data-stop="matched"] >> [data-n="lie.swing.matched"]',
  lieSameName: '[data-stop="matched"] >> text=/^Same colour$/',
  // the first page: "One night, four colours"
  night: '[data-night-ruler]',
  chip: '[data-night-ruler] >> role=slider',
  nightWords: '[data-night-readout]',
  nightData: '[data-night-photo] >> [data-n] >> nth=1',
  // the first page: the lead photo that flips by itself, between August and February
  flip: '[data-flip]',
  flipControl: '[data-flip-control]',
  flipPlate: '[data-flip] >> [data-state="after"] >> [data-plate] >> nth=0',
  flipVerdict: '[data-flip] >> [data-state="after"] >> [data-plate] >> nth=1',
  flipEmpty: '[data-flip] >> [data-state="before"] >> [data-plate] >> nth=1',
  // the first page: the box
  box: '[data-position] >> role=combobox',
  go: '[data-position] >> role=button[name=/^blink it$/i]',
  // the viewer
  viewTitle: 'role=heading[level=1]',
  viewPicture: 'role=group[name=/^Pictures/] >> css=canvas >> nth=0',
  // the card of the star on the targets page: its two pictures flip in place
  starName: '#eps-indi-b >> role=heading[name=/^epsilon indi b$/i]',
  starPlate: '#eps-indi-b >> [data-jump] >> [data-plate] >> nth=0',
  starVerdict: '#eps-indi-b >> [data-jump] >> [data-verdict]',
  marks: '#eps-indi-b >> role=button[name=/^marks$/i]',
});

/**
 * The beats of the film. `slot`, `caption` and `shot` are the line of content/captions.txt, word for word: the tool
 * stops when the two differ, so that a change of the storyboard is a change here too. `from` says where the picture
 * comes from: a card of this tool, files prepared in the site, or the archive read while filming.
 *
 * A step with a number in front is filmed: it starts at that second of the beat. A step without one is done off
 * the film, with the clock stopped (a cut); a beat that starts with such steps starts with a cut, and a beat
 * without them goes on from the beat before in one take. The steps:
 *   open <page>                      go to a page of the site
 *   frame <first> <last>             scroll so that the page from one element to the other is in the window
 *   wait <element | question> [how]  until the element is there (with {label: /.../}: until its words match), or
 *                                    until the question answers yes
 *   bar                              show the line with the address of the page
 *   cut                              nothing by itself: the steps off the film that follow start at its second
 *   pointer <place> [offset]         put the mouse there, and show the pointer when filmed
 *   move <place> <ms> [offset]       take the mouse there in that time
 *   press, release, tap              the button of the mouse
 *   drag <place> <place>             press on the one, pull to the other, let go
 *   type <text> <ms a key>           the keys
 *   zoom <factor>                    enlarge the page by this factor (the same layout, as a visitor who zooms), off the film;
 *                                    every later "open" of the part keeps it
 *   trim <selector>                  take these elements of the page off the picture (display none), off the film, so that the frame does not
 *                                    end in the middle of what follows them; the figures of the beat stay
 *   style <css>                      add this style to the page, off the film (a line of the beat set larger)
 *   hide                             take the pointer away
 *   note <name> <question>           keep an answer of the page under a name
 *   expect <words> <question>        the take is used only if the page answers yes
 *   clear <element>                  the take is used only if neither the band nor the line of the address covers it
 * A place is an element (its middle, plus an offset in pixels of the page) or a question that answers with a point.
 */
export const BEATS = Object.freeze([
  {
    slot: '0:00-0:02', caption: '{{site.name}}. Team {{site.team}}. Pluto was found by blinking.',
    shot: 'Title card: the name of the project, of the team and the hook, from the glossary of the site',
    from: 'card', card: true, steps: [],
  },
  {
    slot: '0:02-0:05', caption: 'Planet X and SPHEREx: across one visit, steady stars swing {{lie.swing.all}} times.',
    shot: 'RW Aurigae\'s field zoomed in: all photos of one visit in time order, steady stars flicker, the bar of the swing beside them',
    from: 'prepared',
    steps: [
      ['open', ''],
      ['zoom', 1.25],
      // the stage of "A plain blink lies" is built when the section comes near the window
      ['reach', ON.lie],
      ['wait', ON.lieSame],
      ['trim', '#plain-blink-title, .lie-head, .lie-def, .lie-moral, .lie-body ~ *, section:has(.lie-body) > .record'],
      ['frame', ON.lieStage, ON.lieSameMeter],
      // the loop of the page starts at the first photo of the visit when it comes into the window; the film
      // starts a few photos on, at a change of photo, where the visit goes back and forth between far colours
      ['wait', ON.liePhoto, { label: /Photo 6 of / }],
      [0.1, 'note', 'first', photoOn],
      [1.5, 'expect', 'all photos of one visit of RW Aurigae are playing', async (c) => await checked(c, ON.lieAll) && await seen(c, ON.liePause) && /RW Aurigae/.test((await photoOn(c)).words)],
      [1.5, 'clear', ON.liePhoto],
      [2.85, 'expect', 'three photos or more were shown', async (c) => (await photoOn(c)).n >= c.notes.first.n + 2],
    ],
  },
  {
    slot: '0:05-0:10', caption: 'Two photos matched in colour: steady stars differ by {{lie.swing.matched}} times.',
    shot: 'The choice moves to "Same colour", zoomed in: its bar is the shortest and the stars hold still',
    from: 'prepared',
    steps: [
      [0.1, 'pointer', ON.lieSameName, [150, -70]],
      [0.1, 'move', ON.lieSameName, 750],
      [1.05, 'tap'],
      [1.7, 'move', ON.lieSameName, 350, [90, 34]],
      [2.5, 'expect', '"Same colour" is chosen and its two photos are playing', async (c) => await checked(c, ON.lieSame) && await seen(c, ON.liePause) && (await photoOn(c)).of === 2],
      [4.85, 'expect', 'the choice stayed on "Same colour"', (c) => checked(c, ON.lieSame)],
    ],
  },
  {
    slot: '0:10-0:13', caption: 'Real NASA SPHEREx photos. Same night, four colours.',
    shot: 'Comet Lemmon, 26 February: the chip is dragged along the ruler across the four photos taken minutes apart',
    from: 'prepared',
    steps: [
      ['open', ''],
      ['zoom', 1.15],
      ['reach', ON.night],
      ['wait', ON.chip],
      ['trim', '#night-title, .night-head, .night-head ~ .record'],
      ['frame', ON.night, ON.nightData],
      // the page opens with the chip on the colour of carbon dioxide; off the film it stays there
      ['note', 'home', chipValue],
      [0.15, 'pointer', chipNow, [60, 40]],
      [0.15, 'move', chipNow, 350],
      [0.55, 'note', 'photoA', chipSays],
      [0.6, 'press'],
      [0.65, 'move', chipFarLeft, 700],
      [1.35, 'note', 'photoB', chipSays],
      [1.45, 'move', chipFarRight, 1000],
      [2.5, 'move', chipHome, 400],
      [2.95, 'release'],
      [2.95, 'expect', 'the chip went from photo to photo of the night', async (c) => {
        const all = [c.notes.photoA, c.notes.photoB, await chipSays(c)];
        return new Set(all).size >= 2 && all.every((said) => /photo \d of 4/.test(said));
      }],
    ],
  },
  {
    slot: '0:13-0:17', caption: 'Comet Lemmon: {{lemmon.contrast.feb26}} brighter at carbon dioxide\'s colour.',
    shot: 'The chip rests on the glow photo at the colour of carbon dioxide, beside the faint photo',
    from: 'prepared',
    steps: [
      [0.4, 'hide'],
      [2.0, 'expect', 'the chip is on the photo at the colour of carbon dioxide, and its words say so', async (c) => await value(c, ON.chip) === c.notes.home && /COLOUR 4\.266/.test(await words(c, ON.nightWords)) && /WHERE CARBON DIOXIDE GLOWS/.test(await words(c, ON.nightWords))],
      [2.0, 'clear', ON.chip],
      [2.0, 'clear', ON.nightData],
    ],
  },
  {
    slot: '0:17-0:20', caption: 'Same colour, six months earlier: empty sky.',
    shot: 'Tap: the same colour on August, the panel is empty',
    from: 'prepared',
    steps: [
      ['open', ''],
      ['zoom', 0.85],
      ['trim', '.masthead-cells, .position-try, .terms, [data-flip] figcaption, [data-flip] .flip-note'],
      ['wait', ON.flipControl],
      // off the film the lead photo is stopped on February; on the film a tap flips it to August, and a second tap
      // stops it there, as a visitor would to look at it
      ['wait', stoppedOnFebruary],
      ['frame', '#title', ON.flipControl],
      [0.15, 'pointer', ON.flipControl, [140, 150]],
      [0.2, 'move', ON.flipControl, 450, [34, 5]],
      [0.7, 'tap'],
      [1.4, 'expect', 'the lead photo shows August: nothing at the marked place', async (c) => await attribute(c, ON.flip, 'data-shows') === 'before' && /NOTHING HERE/.test(await words(c, ON.flipEmpty))],
      [1.45, 'move', ON.flipControl, 100, [34, 3]],
      [1.55, 'tap'],
      [2.0, 'move', ON.flipControl, 500, [150, 120]],
      [2.6, 'expect', 'it stays on August', async (c) => await attribute(c, ON.flip, 'data-shows') === 'before' && /^play/i.test(await words(c, ON.flipControl))],
      [2.6, 'clear', ON.flipVerdict],
    ],
  },
  {
    slot: '0:20-0:26', caption: 'Epsilon Indi B: moved {{targets.eps-indi-b.shift.measured}} arcsec in {{targets.eps-indi-b.shift.years}} years; Gaia predicts {{targets.eps-indi-b.shift.catalogue}}.',
    shot: '"Epsilon Indi B" typed in the box; then its card zoomed in: the 2010 picture, then SPHEREx, the measured and the predicted shift beside them',
    from: 'prepared',
    steps: [
      ['open', ''],
      ['zoom', 1.3],
      ['frame', ON.box, ON.go],
      // the name is typed in the box of the first page
      [0.1, 'pointer', ON.box, [-75, -62]],
      [0.1, 'move', ON.box, 300, [-200, 0]],
      [0.48, 'tap'],
      [0.62, 'type', STAR, 60],
      [1.5, 'expect', 'the box holds the name', async (c) => await value(c, ON.box) === STAR],
      [1.52, 'move', ON.go, 300],
      [1.88, 'press'],
      // a cut: the button is let go, and the film goes on when the viewer that it opens shows its pictures
      [2.0, 'cut'],
      ['release'],
      ['wait', viewerHasPictures],
      ['zoom', 0.6],
      ['trim', '.view-search, #lookup, #plan, #places, #frame-map, #spectrum, #is-it-real, #reading'],
      ['frame', ON.viewTitle, ON.viewPicture],
      [2.45, 'expect', 'the viewer shows the star by its name', async (c) => { const v = await view(c); return v.title.toLowerCase() === STAR.toLowerCase() && v.pairs > 0; }],
      [2.45, 'clear', ON.viewPicture],
      // a cut: to the card of the star on the targets page, the two pictures bare ("Marks" switched off)
      [2.9, 'cut'],
      ['open', 'targets.html'],
      ['zoom', 0.8],
      ['wait', ON.marks],
      ['trim', '#eps-indi-b .tcard-cells, #eps-indi-b .tcard-blink, #eps-indi-b figcaption, #eps-indi-b .tcard-motion, #eps-indi-b .tcard-open, #eps-indi-b .tcard-values'],
      ['style', '#eps-indi-b .tcard-verdict { font-size: 2.6rem; line-height: 1.2; }'],
      ['frame', ON.starName, ON.marks],
      ['pointer', ON.marks],
      ['tap'],
      ['pointer', ON.starPlate, [-30, 70]],
      [3.0, 'expect', 'the picture of 2010 and the picture of SPHEREx flip in place, bare', async (c) => await attribute(c, ON.marks, 'aria-pressed') === 'false' && /2010|SPHEREX/.test(await words(c, ON.starVerdict))],
      [3.05, 'pointer', ON.starPlate, [-30, 70]],
      [3.05, 'move', ON.starPlate, 650, [-30, 200]],
      [3.9, 'move', ON.marks, 500],
      [4.5, 'tap'],
      [4.9, 'move', ON.marks, 350, [90, -26]],
      [5.7, 'expect', 'the rings of the catalogue are drawn', async (c) => await attribute(c, ON.marks, 'aria-pressed') === 'true'],
      [5.7, 'clear', ON.starVerdict],
    ],
  },
  {
    slot: '0:26-0:28', caption: 'Any star or position, from NASA\'s archive.',
    shot: 'The address bar with the page open on a typed position',
    from: 'live',
    steps: [
      // off the film: a position is typed in the box of the first page, and the film goes on when the archive has sent its pictures
      ['open', ''],
      ['frame', ON.box, ON.go],
      ['pointer', ON.box, [-200, 0]],
      ['tap'],
      ['type', (/** @type {Asked} */ c) => c.position, 15],
      ['pointer', ON.go],
      ['tap'],
      ['wait', viewerHasPictures, { seconds: 120 }],
      ['zoom', 0.6],
      ['trim', '.view-search, #lookup, #plan, #places, #frame-map, #spectrum, #is-it-real, #reading'],
      ['bar'],
      ['frame', ON.viewTitle, ON.viewPicture],
      [1.0, 'expect', 'the page is open on a position, with pictures read through the reader of the archive', async (c) => { const v = await view(c); return v.live && v.done && v.pairs > 0 && /[?&]ra=/.test(v.search) && /[?&]dec=/.test(v.search); }],
      [1.0, 'clear', ON.viewPicture],
    ],
  },
  {
    slot: '0:28-0:30', caption: 'Next: every new release. {{site.url}}',
    shot: 'The address on a plain card',
    from: 'card', card: true, steps: [],
  },
]);

// ---------------------------------------------------------------------------------------------
// The questions the steps ask the page
// ---------------------------------------------------------------------------------------------

/**
 * What a question is asked with.
 * @typedef {Object} Asked
 * @property {import('@playwright/test').Page} page
 * @property {Record<string, any>} notes  What the "note" steps of the part have kept.
 * @property {string} position  What is typed for the view of a typed position.
 */

/** @param {Asked} c @param {string} selector */
const first = (c, selector) => c.page.locator(selector).first();
/** Is it there to be seen? @param {Asked} c @param {string} selector */
function seen(c, selector) { return first(c, selector).isVisible(); }
/** @param {Asked} c @param {string} selector */
function checked(c, selector) { return first(c, selector).isChecked(); }
/** @param {Asked} c @param {string} selector @param {string} name */
function attribute(c, selector, name) { return first(c, selector).getAttribute(name); }
/** What a field holds. @param {Asked} c @param {string} selector */
function value(c, selector) { return first(c, selector).inputValue(); }
/** The words that can be read in it. @param {Asked} c @param {string} selector */
function words(c, selector) { return first(c, selector).innerText(); }

/** The photo that is on in "Why a plain blink lies": its number, how many there are, and the words of the picture. @param {Asked} c */
async function photoOn(c) {
  const said = await attribute(c, ON.liePhoto, 'aria-label') ?? '', m = /Photo (\d+) of (\d+)/.exec(said);
  return { words: said, n: m ? Number(m[1]) : 0, of: m ? Number(m[2]) : 0 };
}

/** Where the chip of the comet stands on its ruler, as the field holds it. @param {Asked} c */
function chipValue(c) { return value(c, ON.chip); }
/** The photo under the chip, in the words of the ruler. @param {Asked} c */
async function chipSays(c) { return await attribute(c, ON.chip, 'aria-valuetext') ?? ''; }

/**
 * A point on the ruler of the comet: where a value lies between its two ends.
 * @param {Asked} c @param {(now: number, low: number, high: number) => number} pick
 */
async function chipPoint(c, pick) {
  const chip = first(c, ON.chip), at = await chip.boundingBox();
  if (!at) throw new Error('the ruler of the comet is not in the window');
  const [now, low, high] = await chip.evaluate((e) => { const i = /** @type {HTMLInputElement} */ (e); return [Number(i.value), Number(i.min || 0), Number(i.max || 100)]; });
  const share = (pick(now, low, high) - low) / (high - low);
  return { x: Math.min(at.x + at.width - 5, Math.max(at.x + 5, at.x + at.width * share)), y: at.y + at.height / 2 };
}
/** Where the chip is now. @param {Asked} c */
function chipNow(c) { return chipPoint(c, (now) => now); }
/** The first photo of the night, at the low end of the ruler. @param {Asked} c */
function chipFarLeft(c) { return chipPoint(c, (_, low) => low); }
/** The last photo of the night, at the high end of the ruler. @param {Asked} c */
function chipFarRight(c) { return chipPoint(c, (_, __, high) => high); }
/** Where the chip stood when the page opened: the colour of carbon dioxide. @param {Asked} c */
function chipHome(c) { return chipPoint(c, () => Number(c.notes.home)); }

/**
 * Yes once the lead photo of the first page has been stopped on February, by the control under it: the control is
 * pressed at the moment the photo shows February, and only when the photo is playing by itself. @param {Asked} c
 */
function stoppedOnFebruary(c) {
  return c.page.evaluate(() => {
    const flip = document.querySelector('[data-flip]'), control = flip?.querySelector('[data-flip-control]');
    if (!(flip instanceof HTMLElement) || !(control instanceof HTMLElement) || !/^pause/i.test(control.textContent ?? '') || flip.dataset.shows !== 'after') return false;
    control.click();
    return /^play/i.test(control.textContent ?? '');
  });
}

/** What the viewer page shows, asked of the page's own script. @param {Asked} c */
function view(c) {
  return c.page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const p = m.viewParts(), message = document.querySelector('[data-state]:not([hidden])');
    return {
      title: document.querySelector('h1')?.textContent ?? '', search: location.search, pairs: p.pairs.length, pictures: Boolean(p.view),
      live: p.timing.opened > 0, done: Boolean(p.timing.done), state: p.timing.state, bytes: p.timing.bytes, message: message?.textContent ?? null,
    };
  });
}

/** Yes when the viewer shows its pictures; it stops the take when the viewer has finished and shows none. @param {Asked} c */
async function viewerHasPictures(c) {
  if (!/\/view\.html/.test(c.page.url())) return false;
  const v = await view(c).catch(() => null);
  if (!v) return false;
  // a prepared view is ready when its pictures are there; a position read from the archive when the page says it has finished
  if (v.pictures && v.pairs > 0 && (!v.live || v.done)) return true;
  if (v.live && v.done && !v.pictures) throw new Error(`the viewer shows no pictures: ${v.message ?? v.state}`);
  return false;
}

// ---------------------------------------------------------------------------------------------
// The film, the command, the storyboard and the plan of the frames
// ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORYBOARD = 'content/captions.txt';

/** The film: its size in pixels, its frames a second, the length it must not pass, and how far below that it stops. */
export const FILM = Object.freeze({ width: 1920, height: 1080, fps: 30, limit: 30, spare: 0.2 });
/** The window of the browser, in pixels of the page, and how many pixels of the film one of them takes. */
export const PAGE = Object.freeze({ width: 1280, height: 720, scale: 1.5 });
/** The band of the caption at the foot of the picture, and the line of the address at its head: heights in pixels of the page. */
export const BAND = 112;
export const BAR = 56;
/** How far from the edge of its time slot a caption is looked for in the finished film, seconds. */
export const EDGE_S = 0.3;
/** A part is filmed at most this many times. */
const TAKES = 3;
/** The quality of the pictures taken of the page (JPEG, 0 to 100), and how many may be on their way at once. */
const QUALITY = 95;
const ON_THEIR_WAY = 3;
/** The action may come this late to a step before the take is thrown away, seconds. */
const LATE_S = 0.25;
/** How long a "wait" step waits unless it says otherwise, seconds. */
const WAIT_S = 30;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const soon = () => new Promise((r) => setImmediate(r));
/** Wait until a moment of performance.now(), to the millisecond: the timers of the system alone are too coarse. @param {number} t */
async function until(t) {
  for (;;) {
    const wait = t - performance.now();
    if (wait <= 0) return;
    await (wait > 20 ? sleep(wait - 18) : soon());
  }
}
/** @param {number} s @returns {string} "0:03.5" */
const clockText = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? (process.env.DEMO_DEBUG ? e.message : e.message.split('\n')[0]) : String(e));

/**
 * @param {string[]} argv
 * @returns {{options: {url: string | null, team: string | null, address: string | null, position: string, out: string, sheet: string, frames: string | null, part: number | null}, errors: string[]}}
 */
export function parseArgs(argv) {
  /** @type {any} */
  const options = { url: null, team: null, address: null, position: POSITION, out: 'content/out/video/demo.webm', sheet: 'review/video/sheet.png', frames: null, part: null };
  /** @type {string[]} */
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const key = /^--(url|team|address|position|out|sheet|frames|part)$/.exec(argv[i])?.[1];
    if (!key) { errors.push(`"${argv[i]}" is not an option of this tool`); continue; }
    const given = argv[++i];
    if (given === undefined || given.trim() === '') { errors.push(`--${key} needs a value`); continue; }
    options[key] = given.trim();
  }
  if (options.url && !/^https?:\/\/\S+$/.test(options.url)) errors.push(`--url "${options.url}" is not an address`);
  if (options.url && !options.url.endsWith('/')) options.url += '/';
  if (!options.out.endsWith('.webm')) errors.push('--out is a .webm file');
  if (options.part !== null) {
    options.part = Number(options.part);
    if (!Number.isInteger(options.part) || options.part < 1 || options.part > BEATS.length) errors.push(`--part is the number of a beat, 1 to ${BEATS.length}`);
    if (!options.frames) errors.push('--part keeps frames and no film: say where with --frames');
  }
  return { options, errors };
}

/**
 * @typedef {Object} Beat
 * @property {number} n      1 for the first line of the storyboard
 * @property {number} start  seconds
 * @property {number} end
 * @property {string} text   the caption, as tools/render-content.mjs renders it
 * @property {string} shot   what is on screen, in the words of the storyboard
 * @property {number} words
 */

/**
 * The storyboard, filled as the renderer fills it, and held against the table of beats. The team and the address
 * of the command stand for {{site.team}} and {{site.url}}; every other key is a number of the site.
 * @param {{root?: string, team?: string | null, address?: string | null}} [options]
 * @returns {{beats: Beat[], errors: string[], site: Record<string, any>}}
 */
export function readStoryboard({ root = ROOT, team = null, address = null } = {}) {
  const read = (/** @type {string} */ rel) => readFileSync(path.join(root, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const numbers = JSON.parse(read('site/data/numbers.json'));
  /** @type {Record<string, any>} */
  const site = { ...JSON.parse(read('site/data/site.json')), ...(team ? { team } : {}), ...(address ? { url: address } : {}) };
  const written = read(STORYBOARD), lines = parseCaptions(written, STORYBOARD).captions;
  const filled = fill(written, STORYBOARD, { numbers, site, references: null });
  const parsed = parseCaptions(filled.text, STORYBOARD);
  const errors = [...filled.errors, ...filled.open.map((key) => `${STORYBOARD}: {{${key}}} has no value: say ${key === 'site.team' ? '--team "<team name>"' : key === 'site.url' ? '--address "<public address>"' : `what ${key} is`}`), ...parsed.errors];
  const beats = parsed.captions.map((c, i) => ({ n: i + 1, start: c.start, end: c.end, text: c.text, shot: c.shot, words: c.words }));
  if (lines.length !== BEATS.length) errors.push(`${STORYBOARD}: ${lines.length} lines, and the table of tools/demo.mjs has ${BEATS.length} beats`);
  const slot = (/** @type {{start: number, end: number}} */ c) => `${Math.floor(c.start / 60)}:${String(c.start % 60).padStart(2, '0')}-${Math.floor(c.end / 60)}:${String(c.end % 60).padStart(2, '0')}`;
  for (const [i, line] of lines.entries()) {
    const row = BEATS[i];
    if (!row) break;
    for (const [what, here, there] of [['time slot', row.slot, slot(line)], ['caption', row.caption, line.text], ['picture', row.shot, line.shot]]) {
      if (here !== there) errors.push(`${STORYBOARD}: the ${what} of line ${i + 1} is "${there}", and beat ${i + 1} of the table of tools/demo.mjs has "${here}": change the beat with the storyboard`);
    }
    if (line.start !== (i ? lines[i - 1].end : 0)) errors.push(`${STORYBOARD}: line ${i + 1} does not start where the line above ends`);
  }
  return { beats, errors, site };
}

/**
 * The frames of each beat: `from` is its first frame, `to` the first frame after it. The film ends `spare`
 * seconds before the limit, and never later than the storyboard.
 * @param {{start: number, end: number}[]} beats
 * @returns {{from: number, to: number}[]}
 */
export function planFrames(beats, { fps = FILM.fps, limit = FILM.limit, spare = FILM.spare } = {}) {
  const end = Math.min(beats[beats.length - 1].end, limit - spare);
  return beats.map((b) => ({ from: Math.round(Math.min(b.start, end) * fps), to: Math.round(Math.min(b.end, end) * fps) }));
}

/**
 * The beats that are filmed in one take: a card, or a beat that starts off the film, starts a new part.
 * @param {readonly {card?: boolean, steps: readonly any[]}[]} [rows]
 * @returns {number[][]} the beats of each part, counted from 0
 */
export function partsOf(rows = BEATS) {
  /** @type {number[][]} */
  const parts = [];
  for (const [i, row] of rows.entries()) {
    const fresh = i === 0 || row.card || rows[i - 1].card || typeof row.steps[0]?.[0] !== 'number';
    if (fresh) parts.push([i]);
    else parts[parts.length - 1].push(i);
  }
  return parts;
}

/**
 * A caption as a card shows it: one line for each sentence, and the line that holds one of the `large` texts (the
 * name of the project, the address) set large. The lines joined by a space are the caption, letter for letter.
 * @param {string} text
 * @param {(string | null | undefined)[]} large
 * @returns {{text: string, large: boolean}[]}
 */
export function cardLines(text, large) {
  const lines = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const use = lines.join(' ') === text ? lines : [text];
  return use.map((line) => ({ text: line, large: large.some((l) => Boolean(l) && line.includes(/** @type {string} */ (l))) }));
}

// ---------------------------------------------------------------------------------------------
// The ffmpeg of the test runner, and reading a film back
// ---------------------------------------------------------------------------------------------

/** Where the test runner keeps its browsers and its ffmpeg. */
function browsersHome() {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (set && set !== '0') return set;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** @returns {string | null} the ffmpeg that comes with the test runner: the newest that is installed */
export function findFfmpeg() {
  const home = browsersHome();
  if (!existsSync(home)) return null;
  const folders = readdirSync(home).filter((n) => /^ffmpeg-\d+$/.test(n)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
  for (const folder of folders) {
    const exe = readdirSync(path.join(home, folder)).find((n) => /^ffmpeg-(win64\.exe|linux|mac)$/.test(n));
    if (exe) return path.join(home, folder, exe);
  }
  return null;
}

/** @param {string} ffmpeg @param {string[]} args @returns {{status: number | null, text: string}} what it wrote to its error stream */
function run(ffmpeg, args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 1 << 26, windowsHide: true });
  return { status: r.status, text: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

/**
 * What ffmpeg says of a film when it is given the film and nothing to do.
 * @param {string} text  Its error stream.
 * @returns {{duration: number, codec: string, width: number, height: number, fps: number | null} | null}
 */
export function readProbe(text) {
  const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  const v = /Stream #\d+:\d+[^\n]*?: Video: (\w+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b([^\n]*)/.exec(text);
  if (!d || !v) return null;
  const fps = /([\d.]+) fps/.exec(v[4]);
  return { duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), codec: v[1], width: Number(v[2]), height: Number(v[3]), fps: fps ? Number(fps[1]) : null };
}

/** @param {string} text  The error stream of ffmpeg after it has gone through a film. @returns {number | null} the frames it counted */
export function readFrameCount(text) {
  const all = [...text.matchAll(/frame=\s*(\d+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/**
 * A PNG as rows of pixels. Reads what ffmpeg and the browser write: 8 bits a channel, not interlaced.
 * @param {Uint8Array} file
 * @returns {{width: number, height: number, channels: number, data: Uint8Array}}
 */
export function readPng(file) {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8, width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  /** @type {Buffer[]} */
  const parts = [];
  while (at + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(at), name = bytes.toString('latin1', at + 4, at + 8);
    if (name === 'IHDR') { width = bytes.readUInt32BE(at + 8); height = bytes.readUInt32BE(at + 12); depth = bytes[at + 16]; type = bytes[at + 17]; interlace = bytes[at + 20]; }
    else if (name === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + size));
    else if (name === 'IEND') break;
    at += 12 + size;
  }
  const channels = /** @type {Record<number, number>} */ ({ 0: 1, 2: 3, 4: 2, 6: 4 })[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`a PNG of this kind is not read here: ${depth} bits, colour type ${type}${interlace ? ', interlaced' : ''}`);
  const raw = inflateSync(Buffer.concat(parts)), stride = width * channels, data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], from = y * (stride + 1) + 1, to = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[to + x - channels] : 0, b = y ? data[to + x - stride] : 0, c = x >= channels && y ? data[to + x - stride - channels] : 0;
      let v = raw[from + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      data[to + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/**
 * The share of the pixels of a rectangle that differ clearly between two pictures of the same size (by more than
 * 48 of 255 in some channel). The same caption gives next to none; another caption gives several in a hundred.
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} a
 * @param {{width: number, height: number, channels: number, data: Uint8Array}} b
 * @param {{x: number, y: number, width: number, height: number}} box
 */
export function shareChanged(a, b, box) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('the two pictures are not the same size');
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y)), x1 = Math.min(a.width, Math.ceil(box.x + box.width)), y1 = Math.min(a.height, Math.ceil(box.y + box.height));
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * a.channels, j = (y * b.width + x) * b.channels;
      for (let c = 0; c < 3; c++) if (Math.abs(a.data[i + Math.min(c, a.channels - 1)] - b.data[j + Math.min(c, b.channels - 1)]) > 48) { changed++; break; }
    }
  }
  const n = (x1 - x0) * (y1 - y0);
  return n > 0 ? changed / n : 0;
}

/** The same caption is on screen when fewer pixels than this differ; another one when more than `OTHER` do. */
const SAME = 0.004;
const OTHER = 0.012;

/**
 * Put the pictures of the page together into the film.
 * @param {string} ffmpeg @param {string} raw  The pictures, one JPEG after the other in one file. @param {string} out
 */
function encode(ffmpeg, raw, out) {
  const r = run(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FILM.fps), '-i', raw, '-an',
    // the pictures of the browser use the whole range of values and the colour matrix of JPEG; a film for the web uses the narrow range and BT.709
    '-vf', 'scale=in_range=full:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p',
    '-c:v', 'libvpx-vp9', '-crf', '20', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-tile-columns', '2', '-threads', String(Math.min(8, os.availableParallelism())),
    '-g', String(FILM.fps), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-f', 'webm', out]);
  if (r.status !== 0 || !existsSync(out)) throw new Error(`ffmpeg did not write the film:\n${r.text.trim()}`);
}

/**
 * One frame of a film as a PNG file: the first frame at or after a time.
 * @param {string} ffmpeg @param {string} film @param {number} seconds @param {string} out
 */
function grab(ffmpeg, film, seconds, out) {
  const r = run(ffmpeg, ['-loglevel', 'error', '-ss', seconds.toFixed(3), '-i', film, '-frames:v', '1', '-update', '1', '-y', out]);
  if (r.status !== 0 || !existsSync(out)) throw new Error(`ffmpeg gave no frame at ${clockText(seconds)}:\n${r.text.trim()}`);
}

/**
 * Read a film back with ffmpeg and check it against the storyboard: its length and its size, and that the caption
 * of each beat is on screen at the start of its slot, in its middle and at its end.
 * @param {string} ffmpeg @param {string} film @param {string} folder  Where the frames it reads are put.
 * @param {Beat[]} beats @param {{from: number, to: number}[]} plan
 * @param {({x: number, y: number, width: number, height: number} | null)[]} captions  Where each caption was drawn, in pixels of the page.
 * @returns {{problems: string[], said: string[], middles: string[], probe: ReturnType<typeof readProbe>, frames: number | null}}
 */
export function readBack(ffmpeg, film, folder, beats, plan, captions) {
  /** @type {string[]} */
  const problems = [], said = [];
  const probe = readProbe(run(ffmpeg, ['-i', film]).text);
  // every frame is decoded once, into a small picture that is thrown away: the count is of what a player gets
  const frames = readFrameCount(run(ffmpeg, ['-i', film, '-vf', 'scale=64:36', '-update', '1', '-y', path.join(folder, 'count.png')]).text);
  if (!probe) return { problems: ['ffmpeg cannot read the film'], said, middles: [], probe, frames };
  const total = plan[plan.length - 1].to, end = total / FILM.fps;
  said.push(`${probe.duration.toFixed(2)} s, ${probe.width} by ${probe.height}, ${probe.codec}, ${frames ?? '?'} frames`);
  if (probe.duration > FILM.limit) problems.push(`the film lasts ${probe.duration.toFixed(2)} s: more than ${FILM.limit}`);
  if (probe.duration < FILM.limit - 1) problems.push(`the film lasts ${probe.duration.toFixed(2)} s: less than ${FILM.limit - 1}`);
  if (probe.width !== FILM.width || probe.height !== FILM.height) problems.push(`the film is ${probe.width} by ${probe.height}, not ${FILM.width} by ${FILM.height}`);
  if (frames !== total) problems.push(`the film has ${frames} frames, and ${total} were filmed`);
  if (frames !== null && Math.abs(frames / FILM.fps - probe.duration) > 0.05) problems.push(`its ${frames} frames make ${(frames / FILM.fps).toFixed(2)} s, and its length is given as ${probe.duration.toFixed(2)} s`);

  const times = beats.map((b, i) => {
    const from = plan[i].from / FILM.fps, to = plan[i].to / FILM.fps;
    return { first: Math.max(from, b.start + EDGE_S), middle: (from + to) / 2, last: Math.min(to - 1 / FILM.fps, Math.min(b.end, end) - EDGE_S) };
  });
  /** @param {number} i @param {'first' | 'middle' | 'last'} which */
  const frame = (i, which) => {
    const file = path.join(folder, `beat-${i + 1}-${which}.png`);
    grab(ffmpeg, film, times[i][which], file);
    return file;
  };
  const middles = beats.map((_, i) => frame(i, 'middle'));
  const pictures = middles.map((file) => readPng(readFileSync(file)));
  for (const [i, b] of beats.entries()) {
    const at = captions[i];
    if (!at) { problems.push(`beat ${b.n}: where its caption was drawn is not known`); continue; }
    const area = { x: (at.x - 6) * PAGE.scale, y: (at.y - 6) * PAGE.scale, width: (at.width + 12) * PAGE.scale, height: (at.height + 12) * PAGE.scale };
    const early = shareChanged(pictures[i], readPng(readFileSync(frame(i, 'first'))), area), late = shareChanged(pictures[i], readPng(readFileSync(frame(i, 'last'))), area);
    const next = i + 1 < beats.length ? shareChanged(pictures[i], pictures[i + 1], area) : null;
    if (early > SAME || late > SAME) problems.push(`beat ${b.n}: its caption is not on screen from ${clockText(times[i].first)} to ${clockText(times[i].last)} (pixels of the caption that differ from the middle of the beat: ${(100 * early).toFixed(2)} % and ${(100 * late).toFixed(2)} %)`);
    if (next !== null && next < OTHER) problems.push(`beat ${b.n}: the caption of the next beat looks the same (${(100 * next).toFixed(2)} % of its pixels differ)`);
    said.push(`beat ${b.n}, ${clockText(b.start)} to ${clockText(Math.min(b.end, end))}: its caption is on screen at ${clockText(times[i].first)}, ${clockText(times[i].middle)} and ${clockText(times[i].last)}${next === null ? '' : `, and the next beat has another (${(100 * next).toFixed(1)} % of the pixels differ)`}`);
  }
  return { problems, said, middles, probe, frames };
}

// ---------------------------------------------------------------------------------------------
// What is drawn over the page
// ---------------------------------------------------------------------------------------------

/**
 * Runs in every page before its own scripts. It lays one element over the page that takes no clicks and holds the
 * band of the caption, the card, the line of the address and the pointer. The element takes its typeface and its
 * colours from the tokens of the page under it. The pointer follows the real mouse.
 * @param {{band: number, bar: number}} sizes
 */
function overlay(sizes) {
  const w = /** @type {any} */ (window);
  if (window.top !== window || w.__demo) return;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
[hidden] { display: none !important; }
.all { position: absolute; inset: 0; overflow: hidden; font-family: var(--font-sans); color: var(--color-text); -webkit-font-smoothing: antialiased; }
.caption { margin: 0; }
.band { position: absolute; inset: auto 0 0 0; box-sizing: border-box; height: ${sizes.band}px; display: flex; align-items: center; justify-content: center; padding: 0 var(--space-6); background: var(--color-surface); border-top: var(--border-strong); }
.band .caption { max-width: 100%; font-size: 2.375rem; font-weight: var(--weight-medium); line-height: 1.2; text-align: center; text-wrap: balance; }
.card { position: absolute; inset: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; padding: var(--space-8); background: var(--color-bg); }
.card .caption { display: flex; flex-direction: column; align-items: center; gap: var(--space-5); max-width: 100%; text-align: center; }
.card .line { display: block; max-width: 100%; white-space: nowrap; font-size: 2.75rem; line-height: var(--leading-snug); color: var(--color-text-muted); }
.card .line.large { font-size: 5.25rem; font-weight: var(--weight-bold); line-height: var(--leading-tight); letter-spacing: -0.01em; color: var(--color-text); }
.card .line.address { color: var(--color-accent); }
.bar { position: absolute; inset: 0 0 auto 0; box-sizing: border-box; height: ${sizes.bar}px; display: flex; align-items: center; padding: 0 var(--space-5); background: var(--color-surface-raised); border-bottom: var(--border-strong); }
.bar span { flex: 1; min-width: 0; padding: 0 var(--space-4); border: var(--border-strong); border-radius: var(--radius-pill); background: var(--color-bg); font-size: 1.3125rem; line-height: 2.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pointer { position: absolute; left: 0; top: 0; width: 34px; height: 34px; opacity: 0; transition: opacity 120ms linear; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.6)); }
.pointer.on { opacity: 1; }
.pointer path { fill: var(--color-text); stroke: var(--color-bg); stroke-width: 1.3; stroke-linejoin: round; }
.ring { position: absolute; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; box-sizing: border-box; border: 3px solid var(--color-focus); border-radius: 50%; opacity: 0; }
.ring.held { opacity: 0.9; transform: scale(0.5); transition: transform 120ms var(--ease-out); }
.ring.let-go { animation: let-go 420ms var(--ease-out) forwards; }
@keyframes let-go { from { opacity: 0.9; transform: scale(0.5); } to { opacity: 0; transform: scale(1.5); } }
</style><div class="all"><div class="card" hidden></div><div class="bar" hidden><span></span></div><div class="band" hidden></div><div class="ring"></div><svg class="pointer" viewBox="0 0 20 20"><path d="M3 1.5v14.6l3.9-3.5 2.6 5.8 2.7-1.2-2.6-5.7 5.3-.3z"/></svg></div>`;
  const pick = (/** @type {string} */ s) => /** @type {HTMLElement} */ (root.querySelector(s));
  const all = pick('.all'), card = pick('.card'), bar = pick('.bar'), band = pick('.band'), ring = pick('.ring'), pointer = pick('.pointer'), address = pick('.bar span');
  const caption = document.createElement('p');
  caption.className = 'caption';
  /** @type {'band' | 'card' | null} */
  let as = null;
  let shown = false;

  const place = (/** @type {number} */ x, /** @type {number} */ y) => {
    // the tip of the arrow is at 3, 1.5 of its 20 by 20 drawing
    pointer.style.transform = `translate(${x - 34 * 3 / 20}px, ${y - 34 * 1.5 / 20}px)`;
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
  };
  window.addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
  window.addEventListener('mousedown', (e) => {
    place(e.clientX, e.clientY);
    ring.className = shown ? 'ring held' : 'ring';
  }, true);
  window.addEventListener('mouseup', () => { if (ring.classList.contains('held')) ring.className = 'ring let-go'; }, true);
  setInterval(() => { if (!bar.hidden && address.textContent !== location.href) address.textContent = location.href; }, 50);

  w.__demo = {
    /** @param {{caption?: {text: string, lines?: {text: string, large: boolean, address?: boolean}[]} | null, as?: 'band' | 'card' | null, bar?: boolean}} scene */
    set(scene) {
      as = scene.caption && scene.as ? scene.as : null;
      caption.replaceChildren();
      if (scene.caption && as === 'card' && scene.caption.lines) {
        for (const [i, line] of scene.caption.lines.entries()) {
          const span = document.createElement('span');
          span.className = `line${line.large ? ' large' : ''}${line.address ? ' address' : ''}`;
          span.textContent = line.text;
          if (i) caption.append(' ');
          caption.append(span);
        }
      } else if (scene.caption) caption.textContent = scene.caption.text;
      card.hidden = as !== 'card';
      band.hidden = as !== 'band';
      if (as) (as === 'card' ? card : band).replaceChildren(caption);
      bar.hidden = !scene.bar;
      address.textContent = scene.bar ? location.href : '';
      // a line of a card that is wider than the card is set smaller until it fits
      for (const line of caption.querySelectorAll('.line')) {
        const e = /** @type {HTMLElement} */ (line);
        for (let size = parseFloat(getComputedStyle(e).fontSize); e.scrollWidth > e.clientWidth && size > 24; size -= 2) e.style.fontSize = `${size - 2}px`;
      }
    },
    /** Show or hide the pointer; with a place, put it there. @param {boolean} on @param {number} [x] @param {number} [y] */
    pointer(on, x, y) {
      if (x !== undefined && y !== undefined) place(x, y);
      shown = on;
      pointer.classList.toggle('on', on);
      if (!on) ring.className = 'ring';
    },
    /** What is drawn now. */
    read() {
      const r = as ? caption.getBoundingClientRect() : null, frame = as ? (as === 'card' ? card : band).getBoundingClientRect() : null;
      return {
        caption: as ? caption.textContent : null, as, bar: bar.hidden ? null : address.textContent, href: location.href, pointer: shown,
        box: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        fits: Boolean(r && frame && r.left >= frame.left && r.right <= frame.right && r.top >= frame.top && r.bottom <= frame.bottom) && [...caption.querySelectorAll('.line')].every((l) => l.scrollWidth <= l.clientWidth),
        lines: as === 'band' && r ? Math.round(r.height / parseFloat(getComputedStyle(caption).lineHeight)) : null,
        tokens: getComputedStyle(all).fontFamily !== '' && getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() !== '',
      };
    },
  };
  const mount = () => { if (document.documentElement && host.parentNode !== document.documentElement) document.documentElement.append(host); };
  mount();
  new MutationObserver(mount).observe(document, { childList: true });
}

// ---------------------------------------------------------------------------------------------
// The camera and the hand
// ---------------------------------------------------------------------------------------------

/**
 * The clock of a film while it is made.
 * @typedef {Object} Clock
 * @property {() => number} now  Seconds of film so far.
 * @property {(s: number) => Promise<void>} at  Wait for a second of the film.
 * @property {(s: number, job: () => Promise<unknown>) => void} before  Do a job just before the frame of that second is taken.
 * @property {(job: () => Promise<unknown>) => Promise<void>} cut  Stop the film, do a job, and go on filming where the film stopped.
 */

/** @param {Uint8Array} jpeg @returns {[number, number]} its width and height, read from its header; 0 by 0 when it has none */
export function jpegSize(jpeg) {
  const b = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  for (let i = 2; i + 9 < b.length && b[i] === 0xff;) {
    const mark = b[i + 1];
    if (mark >= 0xc0 && mark <= 0xcf && mark !== 0xc4 && mark !== 0xc8 && mark !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + b.readUInt16BE(i + 2);
  }
  return [0, 0];
}

/** Takes pictures of the page on a clock. */
class Camera {
  /** @param {import('@playwright/test').CDPSession} session */
  constructor(session) {
    this.session = session;
    /** @type {Set<Promise<Buffer | null>>} */
    this.onTheirWay = new Set();
  }

  /**
   * One picture of the window as it is, without a clip and without a scale of its own: a picture that asks for
   * either makes the browser change its scale for a moment, and a picture taken in that moment comes out wrong.
   * @returns {Promise<Buffer | null>} a JPEG; null when the browser gave none
   */
  shoot() {
    /** @type {Promise<Buffer | null>} */
    const shot = this.session.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY, optimizeForSpeed: true }).then((r) => Buffer.from(r.data, 'base64'), () => null);
    this.onTheirWay.add(shot);
    shot.then(() => this.onTheirWay.delete(shot));
    return shot;
  }

  /**
   * Film a number of frames while an action runs. The action is given the clock of the film.
   * @param {number} frames
   * @param {(clock: Clock) => Promise<void>} act
   * @returns {Promise<{frames: Buffer[], problems: string[]}>}
   */
  async film(frames, act) {
    const step = 1000 / FILM.fps;
    /** @type {(Promise<Buffer | null> | null)[]} */
    const shots = [];
    /** @type {{k: number, job: () => Promise<unknown>}[]} */
    const jobs = [];
    /** @type {string[]} */
    const problems = [];
    let zero = performance.now() + 60;
    /** @type {number | null} */
    let stopped = null;
    /** @type {{job: () => Promise<unknown>, done: () => void, fail: (e: unknown) => void} | null} */
    let cut = null;
    /** @type {unknown} */
    let failed = null;
    let over = false;
    /** @type {Clock} */
    const clock = {
      now: () => stopped ?? (performance.now() - zero) / 1000,
      at: async (s) => {
        for (;;) {
          const left = (s - clock.now()) * 1000;
          if (left <= 0) return;
          await (stopped !== null ? sleep(10) : left > 20 ? sleep(Math.min(left - 18, 40)) : soon());
        }
      },
      before: (s, job) => { jobs.push({ k: Math.round(s * FILM.fps), job }); },
      cut: (job) => new Promise((done, fail) => { cut = { job, done, fail }; }),
    };
    const serve = async () => {
      const asked = /** @type {NonNullable<typeof cut>} */ (cut);
      cut = null;
      const began = performance.now();
      stopped = (began - zero) / 1000;
      await Promise.all(this.onTheirWay); // the pictures on their way are of the view that is left
      try {
        await asked.job();
        zero += performance.now() - began;
        stopped = null;
        asked.done();
      } catch (e) {
        stopped = null;
        asked.fail(e);
      }
    };
    const acting = Promise.resolve().then(() => act(clock)).then(() => { over = true; }, (e) => { failed = e ?? new Error('the action failed'); over = true; });
    for (let k = 0; k < frames && !failed; k++) {
      for (;;) {
        if (cut) { await serve(); continue; }
        const wait = zero + k * step - performance.now();
        if (wait <= 0 || failed) break;
        await (wait > 20 ? sleep(Math.min(wait - 18, 40)) : soon());
      }
      if (failed) break;
      for (const j of jobs) if (j.k === k) await j.job();
      shots.push(this.onTheirWay.size >= ON_THEIR_WAY ? null : this.shoot());
    }
    // an action that runs past the end of the film is waited for; a cut it still asks for is made
    while (!over) {
      if (cut) await serve();
      else await sleep(5);
    }
    await acting;
    const got = await Promise.all(shots);
    if (failed) throw failed;
    if (clock.now() > frames / FILM.fps + LATE_S) problems.push(`the action ran ${(clock.now() - frames / FILM.fps).toFixed(2)} s past the end of the part`);
    const missed = got.filter((g) => g === null).length;
    if (missed > frames * 0.05) problems.push(`${missed} of ${frames} pictures of the page did not come in time`);
    const odd = got.filter((g) => g !== null && jpegSize(g).join(' by ') !== `${FILM.width} by ${FILM.height}`).length;
    if (odd) problems.push(`${odd} pictures of the page are not ${FILM.width} by ${FILM.height}`);
    /** @type {Buffer[]} */
    const out = [];
    for (let k = 0; k < got.length; k++) {
      const frame = got[k] ?? out[k - 1] ?? got.find((g) => g !== null);
      if (!frame) throw new Error('the browser gave no picture of the page');
      out.push(frame);
    }
    return { frames: out, problems };
  }
}

/** The mouse and the keys. The pointer of the film is drawn where this hand is. */
class Hand {
  /** @param {import('@playwright/test').Page} page */
  constructor(page) {
    this.page = page;
    this.x = 0;
    this.y = 0;
  }

  /** Put the mouse somewhere without a path, with or without its pointer. @param {number} x @param {number} y @param {boolean} seen */
  async appear(x, y, seen) {
    await this.page.mouse.move(x, y);
    this.x = x;
    this.y = y;
    await this.page.evaluate(([on, px, py]) => /** @type {any} */ (window).__demo?.pointer(on, px, py), /** @type {[boolean, number, number]} */ ([seen, x, y]));
  }

  async vanish() {
    await this.page.evaluate(() => /** @type {any} */ (window).__demo?.pointer(false));
  }

  /** Go to a place in a time, slowly at both ends. @param {number} x @param {number} y @param {number} ms */
  async move(x, y, ms) {
    const x0 = this.x, y0 = this.y, steps = Math.max(1, Math.round(ms / 16)), began = performance.now();
    for (let i = 1; i <= steps; i++) {
      await until(began + i * ms / steps);
      const t = i / steps, e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    }
    this.x = x;
    this.y = y;
  }

  down() { return this.page.mouse.down(); }

  up() { return this.page.mouse.up(); }

  /** Type a text, a key every `per` ms. @param {string} text @param {number} per */
  async type(text, per) {
    const began = performance.now();
    let i = 0;
    for (const key of text) {
      await this.page.keyboard.type(key);
      await until(began + ++i * per);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Filming a part: the steps of its beats
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Studio  What a part is filmed with.
 * @property {import('@playwright/test').Page} page
 * @property {Camera} camera
 * @property {Hand} hand
 * @property {Beat[]} beats
 * @property {{from: number, to: number}[]} plan
 * @property {string} url
 * @property {string} position
 * @property {Record<string, any>} site
 * @property {({x: number, y: number, width: number, height: number} | null)[]} captions  Where the caption of each beat was drawn, once it is filmed.
 */

/**
 * Film one part: the beats that make one take.
 * @param {Studio} studio @param {number[]} part  Its beats, counted from 0.
 * @returns {Promise<{frames: Buffer[], problems: string[], said: string[]}>}
 */
async function filmPart(studio, part) {
  const { page, camera, hand, beats, plan } = studio;
  /** @type {string[]} */
  const problems = [], said = [];
  /** @type {Asked} */
  const asked = { page, notes: {}, position: studio.position };
  const zero = plan[part[0]].from;
  let bar = false, beat = beats[part[0]], zoom = 1;
  /** The page of the film, enlarged: its body only, so that what is drawn over it keeps its size. */
  const applyZoom = () => page.evaluate((z) => { document.body.style.zoom = z === 1 ? '' : String(z); }, zoom);

  const draw = async () => {
    await page.waitForFunction(() => Boolean(/** @type {any} */ (window).__demo));
    const row = BEATS[beat.n - 1], as = row.card ? 'card' : 'band';
    const lines = row.card ? cardLines(beat.text, [studio.site.name, studio.site.url]).map((l) => ({ ...l, address: Boolean(studio.site.url) && l.text.includes(studio.site.url) })) : undefined;
    await page.evaluate((scene) => /** @type {any} */ (window).__demo.set(scene), { caption: { text: beat.text, lines }, as, bar });
  };
  /** The point a step names: an element (its middle, plus an offset) or a question that answers with a point. @param {any} place @param {[number, number]} [offset] */
  const point = async (place, offset = [0, 0]) => {
    let p;
    if (typeof place === 'function') p = await place(asked);
    else {
      const found = page.locator(place).first();
      await found.waitFor({ state: 'visible', timeout: 5000 });
      const at = await found.boundingBox();
      if (!at) throw new Error(`"${place}" has no place on the page`);
      p = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    }
    const head = bar ? BAR : 0, foot = PAGE.height - BAND;
    if (p.x < 0 || p.x > PAGE.width || p.y < head || p.y > foot) throw new Error(`${typeof place === 'function' ? place.name : `"${place}"`} is not in the part of the window that is filmed: frame it first`);
    // an offset never takes the pointer out of the part of the window that is filmed
    return { x: Math.min(PAGE.width - 6, Math.max(6, p.x + offset[0])), y: Math.min(foot - 6, Math.max(head + 6, p.y + offset[1])) };
  };
  /** Scroll, in one step, so that the page from the top of one element to the bottom of another is between the head of the window (or the line of the address) and the band. @param {string} top @param {string} bottom */
  const frame = async (top, bottom) => {
    const a = page.locator(top).first(), b = page.locator(bottom).first();
    await a.waitFor({ state: 'visible', timeout: 20000 });
    await b.waitFor({ state: 'visible', timeout: 20000 });
    await settle(studio);
    const [first, last, scrolled] = [await a.boundingBox(), await b.boundingBox(), await page.evaluate(() => scrollY)];
    if (!first || !last) throw new Error(`"${top}" or "${bottom}" has no place on the page`);
    const head = bar ? BAR : 0, room = PAGE.height - BAND - head, tall = last.y + last.height - first.y;
    // in the middle of the room when it fits; its end when it does not
    const y = tall <= room ? first.y + scrolled - head - (room - tall) / 2 : last.y + last.height + scrolled + 8 - (PAGE.height - BAND);
    await page.evaluate((to) => window.scrollTo({ top: to, behavior: 'instant' }), y < 48 ? 0 : Math.round(y));
    await settle(studio);
  };
  /** @param {any[]} step  A step without its second. @param {boolean} filmed */
  const perform = async (step, filmed) => {
    const [verb, a, b, c] = step;
    if (verb === 'open') {
      await page.goto(studio.url + a);
      await draw();
      await applyZoom();
      await settle(studio);
    } else if (verb === 'zoom') { zoom = a; await applyZoom(); await settle(studio); } else if (verb === 'frame') await frame(a, b);
    else if (verb === 'reach') { await page.locator(a).first().evaluate((e) => e.scrollIntoView({ block: 'start', behavior: 'instant' })); await settle(studio); }
    else if (verb === 'wait') {
      const limit = performance.now() + 1000 * (b?.seconds ?? WAIT_S);
      if (typeof a === 'function') {
        while (!(await a(asked))) {
          if (performance.now() > limit) throw new Error(`the page did not get there in ${b?.seconds ?? WAIT_S} seconds (${a.name})`);
          await sleep(100);
        }
      } else if (b?.label) {
        while (!b.label.test(await page.locator(a).first().getAttribute('aria-label') ?? '')) {
          if (performance.now() > limit) throw new Error(`"${a}" did not come to say ${b.label} in ${b?.seconds ?? WAIT_S} seconds`);
          await sleep(10);
        }
      } else await page.locator(a).first().waitFor({ state: 'visible', timeout: limit - performance.now() });
      await draw();
      await settle(studio);
    } else if (verb === 'bar') { bar = true; await draw(); }
    else if (verb === 'style') await page.addStyleTag({ content: a });
    else if (verb === 'trim') await page.addStyleTag({ content: `${a} { display: none !important; }` });
    else if (verb === 'cut') { /* the steps off the film that follow start here */ }
    else if (verb === 'pointer') { const p = await point(a, b); await hand.appear(p.x, p.y, filmed); }
    else if (verb === 'move') { const p = await point(a, c); await hand.move(p.x, p.y, filmed ? b : Math.min(b, 120)); }
    else if (verb === 'press') await hand.down();
    else if (verb === 'release') await hand.up();
    else if (verb === 'tap') { await hand.down(); await sleep(filmed ? 110 : 60); await hand.up(); }
    else if (verb === 'drag') { const from = await point(a), to = await point(b); await hand.appear(from.x, from.y, false); await hand.down(); await hand.move(to.x, to.y, 250); await hand.up(); }
    else if (verb === 'type') await hand.type(typeof a === 'function' ? a(asked) : a, b);
    else if (verb === 'hide') await hand.vanish();
    else if (verb === 'note') asked.notes[a] = await b(asked);
    else if (verb === 'expect') { if (!(await b(asked))) problems.push(`beat ${beat.n}: not on screen: ${a}`); }
    else if (verb === 'clear') {
      const at = await page.locator(a).first().boundingBox();
      if (!at || at.y < (bar ? BAR : 0) || at.y + at.height > PAGE.height - BAND) problems.push(`beat ${beat.n}: the band or the line of the address covers "${a}" (${at ? `it lies from ${Math.round(at.y)} to ${Math.round(at.y + at.height)} of the window, and the room is from ${bar ? BAR : 0} to ${PAGE.height - BAND}` : 'it has no place on the page'})`);
    } else throw new Error(`the table of beats has a step "${verb}" that this tool does not know`);
  };
  /** The caption of a beat, read in the middle of the beat as the film has it. @param {Beat} b */
  const readCaption = async (b) => {
    const s = await page.evaluate(() => /** @type {any} */ (window).__demo?.read() ?? null).catch(() => null), as = BEATS[b.n - 1].card ? 'card' : 'band';
    if (!s) { problems.push(`beat ${b.n}: what is drawn over the page could not be read`); return; }
    if (s.as !== as) problems.push(`beat ${b.n}: the caption is not on the ${as}`);
    if (s.caption !== b.text) problems.push(`beat ${b.n}: the caption on screen reads "${s.caption}", and the storyboard gives "${b.text}"`);
    if (!s.fits || (s.lines ?? 1) > 2) problems.push(`beat ${b.n}: the caption does not fit the ${as}`);
    if (!s.tokens) problems.push(`beat ${b.n}: the page under the caption has no tokens to draw it with`);
    if (s.bar !== null && s.bar !== s.href) problems.push(`beat ${b.n}: the line of the address reads "${s.bar}", and the page is at "${s.href}"`);
    if (BEATS[b.n - 1].steps.some((step) => step.includes('bar')) && s.bar === null) problems.push(`beat ${b.n}: the line of the address is not shown`);
    studio.captions[b.n - 1] = s.box;
  };

  // what comes before the first frame of the part is done off the film
  const lead = BEATS[part[0]].steps.findIndex((s) => typeof s[0] === 'number');
  const before = BEATS[part[0]].steps.slice(0, lead < 0 ? undefined : lead);
  if (page.url() === 'about:blank' && before[0]?.[0] !== 'open') await page.goto(studio.url);
  await hand.vanish().catch(() => {});
  for (const step of before) await perform(/** @type {any[]} */ (step), false);
  await draw();
  await settle(studio);

  const film = await camera.film(plan[part[part.length - 1]].to - zero, async (clock) => {
    /** @type {Promise<void>[]} */
    const readings = [];
    for (const i of part) {
      const from = (plan[i].from - zero) / FILM.fps, length = (plan[i].to - plan[i].from) / FILM.fps;
      // the caption of a beat that goes on from the one before changes exactly on its first frame
      if (i !== part[0]) clock.before(from, async () => { beat = beats[i]; await draw(); });
      readings.push(clock.at(from + length / 2).then(() => readCaption(beats[i])));
    }
    for (const i of part) {
      const from = (plan[i].from - zero) / FILM.fps, row = BEATS[i];
      const steps = /** @type {any[][]} */ (i === part[0] ? row.steps.slice(before.length) : row.steps);
      for (let k = 0; k < steps.length; k++) {
        if (typeof steps[k][0] === 'number') {
          const late = clock.now() - (from + steps[k][0]);
          if (late > LATE_S) problems.push(`beat ${beats[i].n}: the action came ${late.toFixed(2)} s late to its step at second ${steps[k][0]}`);
          await clock.at(from + steps[k][0]);
          await perform(steps[k].slice(1), true);
          continue;
        }
        // the steps without a second, one after the other, are one cut
        let last = k;
        while (last + 1 < steps.length && typeof steps[last + 1][0] !== 'number') last++;
        await clock.cut(async () => {
          await hand.vanish().catch(() => {});
          for (let j = k; j <= last; j++) await perform(steps[j], false);
          await draw();
          await settle(studio);
        });
        k = last;
      }
    }
    await Promise.all(readings);
  });
  const now = part.some((i) => BEATS[i].from === 'live') ? await view(asked).catch(() => null) : null;
  if (now?.live) said.push(`${now.pairs} ${now.pairs === 1 ? 'pair' : 'pairs'} of photos read from the archive (${(now.bytes / 1e6).toFixed(1)} MB) at ${now.search}`);
  return { frames: film.frames, problems: [...film.problems, ...problems], said };
}

/**
 * Wait until a page is still: its typefaces are loaded, and it has neither scrolled nor grown for a fifth of a
 * second.
 * @param {Studio} studio
 */
async function settle(studio) {
  await studio.page.evaluate(async () => {
    await document.fonts.ready;
    const began = performance.now();
    for (let last = '', same = 0; same < 12 && performance.now() - began < 3000;) {
      await new Promise((r) => requestAnimationFrame(r));
      const now = `${scrollY} ${document.documentElement.scrollHeight}`;
      same = now === last ? same + 1 : 0;
      last = now;
    }
  });
}

/** @param {string} s */
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Why a run is a rehearsal and not the film to hand in: the team is not named, or the address is not the public one.
 * Empty when the film can be handed in.
 * @param {{team?: string | null, address?: string | null}} given
 * @returns {string[]}
 */
export function rehearsalReasons({ team = null, address = null } = {}) {
  /** @type {string[]} */
  const reasons = [];
  if (!team?.trim() || /^(team( name)?|name|your team|tbd|todo|xxx|test|\[team\])$/i.test(team.trim())) reasons.push(team ? `the team is called "${team}", which is a placeholder and not a name` : 'the team is not named');
  if (!address || /example\.(org|com|net)|\[url\]|^\s*(https?:\/\/)?(localhost|127\.0\.0\.1)/i.test(address)) reasons.push(address ? `the address "${address}" is a placeholder and not the public address` : 'the public address is not given');
  return reasons;
}

/**
 * The contact sheet as a page: one frame from the middle of each beat, with its time slot, its caption and what the
 * storyboard says is on screen. A rehearsal says so at the head of the sheet.
 * @param {string} url  The site, for its tokens.
 * @param {{title: string, about: string, beats: Beat[], plan: {from: number, to: number}[], middles: string[], rehearsal?: string[]}} sheet
 */
export function sheetHtml(url, { title, about, beats, plan, middles, rehearsal = [] }) {
  const end = plan[plan.length - 1].to / FILM.fps;
  const cells = beats.map((b, i) => `<li><img alt="" src="data:image/png;base64,${readFileSync(middles[i]).toString('base64')}">
<p class="slot">${clockText(b.start)} to ${clockText(Math.min(b.end, end))} · frame at ${clockText((plan[i].from + plan[i].to) / 2 / FILM.fps)}</p>
<p class="caption">${escapeHtml(b.text)}</p>
<p class="shot">${escapeHtml(b.shot)}</p></li>`);
  const banner = rehearsal.length ? `<p class="rehearsal"><strong>REHEARSAL, NOT THE FILM TO HAND IN</strong>: ${escapeHtml(rehearsal.join('; '))}.</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${rehearsal.length ? 'REHEARSAL: ' : ''}${escapeHtml(title)}</title><link rel="stylesheet" href="${escapeHtml(url)}css/tokens.css"><style>
body { margin: 0; padding: var(--space-6); background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); }
h1 { margin: 0; font-size: var(--text-2xl); line-height: var(--leading-tight); }
.about { margin: var(--space-2) 0 var(--space-6); color: var(--color-text-muted); }
ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-6) var(--space-5); }
img { display: block; width: 100%; border: var(--border-strong); }
p { margin: 0; }
.rehearsal { margin: 0 0 var(--space-5); padding: var(--space-4) var(--space-5); border: 4px solid var(--color-accent); color: var(--color-accent); font-size: var(--text-xl); line-height: var(--leading-snug); }
.rehearsal strong { font-weight: var(--weight-bold); }
.slot { margin-top: var(--space-3); font-family: var(--font-mono); font-size: var(--text-sm); color: var(--color-text-muted); }
.caption { margin-top: var(--space-1); font-size: var(--text-lg); font-weight: var(--weight-medium); line-height: var(--leading-snug); }
.shot { margin-top: var(--space-1); font-size: var(--text-sm); line-height: var(--leading-snug); color: var(--color-text-faint); }
</style></head><body>${banner}<h1>${escapeHtml(title)}</h1><p class="about">${escapeHtml(about)}</p><ol>${cells.join('\n')}</ol></body></html>`;
}

/**
 * The contact sheet, as a picture.
 * @param {import('@playwright/test').Browser} browser @param {string} url
 * @param {Parameters<typeof sheetHtml>[1] & {out: string}} sheet
 */
async function writeSheet(browser, url, sheet) {
  const { out } = sheet, html = sheetHtml(url, sheet);
  const page = await browser.newPage({ viewport: { width: FILM.width, height: FILM.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------------------------

/** @param {string[]} argv @returns {Promise<number>} the exit code */
export async function main(argv) {
  const { options, errors } = parseArgs(argv);
  const { beats, errors: wrong, site } = readStoryboard({ team: options.team, address: options.address });
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) errors.push('the ffmpeg of the test runner is not installed: npx playwright install ffmpeg');
  for (const e of [...errors, ...wrong]) console.error(`demo: ${e}`);
  if (errors.length || wrong.length || !ffmpeg) return 1;

  const rehearsal = rehearsalReasons(options);
  if (rehearsal.length) console.log(`demo: REHEARSAL: ${rehearsal.join('; ')}: the contact sheet says so`);
  const plan = planFrames(beats), total = plan[plan.length - 1].to;
  const parts = partsOf().filter((p) => options.part === null || p.includes(options.part - 1));
  const rel = (/** @type {string} */ file) => path.relative(ROOT, file).split(path.sep).join('/');
  const out = path.resolve(ROOT, options.out), sheet = path.resolve(ROOT, options.sheet), keep = options.frames ? path.resolve(ROOT, options.frames) : null;
  const work = mkdtempSync(path.join(os.tmpdir(), 'demo-'));
  const raw = path.join(work, 'frames.mjpeg');
  /** @type {import('node:http').Server | null} */
  let server = null;
  /** @type {import('@playwright/test').Browser | null} */
  let browser = null;
  try {
    let url = options.url;
    if (!url) {
      const { startServer } = await import('./serve.mjs');
      const own = await startServer({ root: path.join(ROOT, 'site'), port: 0 });
      server = own.server;
      url = own.url;
      console.log(`demo: no --url: the site is served from this computer at ${url} while the film is made`);
    }
    const { chromium } = await import('@playwright/test');
    // the window and its scale are the browser's own: where the test runner sets them for a page, every picture of
    // the page makes the browser change its scale and back
    browser = await chromium.launch({ args: [`--force-device-scale-factor=${PAGE.scale}`, `--window-size=${PAGE.width},${PAGE.height}`] });
    const context = await browser.newContext({ viewport: null });
    await context.addInitScript(overlay, { band: BAND, bar: BAR });
    const page = await context.newPage();
    const window = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio].join(' '));
    if (window !== `${PAGE.width} ${PAGE.height} ${PAGE.scale}`) throw new Error(`the window of the browser is ${window}, not ${PAGE.width} ${PAGE.height} ${PAGE.scale}`);
    /** @type {Studio} */
    const studio = { page, camera: new Camera(await context.newCDPSession(page)), hand: new Hand(page), beats, plan, url, position: options.position, site, captions: beats.map(() => null) };
    console.log(`demo: ${beats.length} beats, ${(total / FILM.fps).toFixed(1)} s, ${total} frames at ${FILM.fps} a second, from ${url}`);

    for (const part of parts) {
      const wanted = plan[part[part.length - 1]].to - plan[part[0]].from, name = `beat${part.length > 1 ? 's' : ''} ${part.map((i) => i + 1).join(', ')}`;
      /** @type {{frames: Buffer[], problems: string[], said: string[]} | null} */
      let take = null;
      for (let n = 1; n <= TAKES; n++) {
        take = await filmPart(studio, part).catch((e) => ({ frames: [], problems: [messageOf(e)], said: [] }));
        await page.mouse.up().catch(() => {});
        if (!take.problems.length && take.frames.length !== wanted) take.problems.push(`${take.frames.length} frames were filmed, and the part has ${wanted}`);
        if (!take.problems.length) break;
        console.log(`demo: ${name}, take ${n} is not used: ${take.problems.join('; ')}`);
      }
      if (!take || take.problems.length) throw new Error(`${name} could not be filmed as the storyboard says, in ${TAKES} takes`);
      for (const i of part) console.log(`demo: beat ${beats[i].n}, ${clockText(beats[i].start)} to ${clockText(plan[i].to / FILM.fps)}, ${BEATS[i].from === 'live' ? 'read from the archive' : BEATS[i].from === 'card' ? 'a card' : 'prepared files of the site'}: "${beats[i].text}"`);
      for (const line of take.said) console.log(`demo:   ${line}`);
      if (options.part !== null && keep) {
        mkdirSync(keep, { recursive: true });
        for (const [k, frame] of take.frames.entries()) writeFileSync(path.join(keep, `part-${String(k).padStart(4, '0')}.jpg`), frame);
        console.log(`demo: the ${take.frames.length} frames of ${name} are in ${rel(keep)}; no film is written`);
        return 0;
      }
      appendFileSync(raw, Buffer.concat(take.frames));
    }
    await context.close();

    // the film is made beside its place and moved there once it has been read back and found right
    const made = path.join(work, 'demo.webm');
    console.log('demo: putting the frames together…');
    encode(ffmpeg, raw, made);
    const back = readBack(ffmpeg, made, work, beats, plan, studio.captions);
    for (const line of back.said) console.log(`demo: read back: ${line}`);
    for (const p of back.problems) console.error(`demo: ${p}`);
    if (back.problems.length) throw new Error('the film is not as the storyboard says; nothing is written');
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(made, `${out}.part`);
    renameSync(`${out}.part`, out);
    console.log(`demo: wrote ${rel(out)} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
    await writeSheet(browser, url, {
      title: `${site.name}: the film, beat by beat`,
      about: `${rel(out)} · ${back.probe?.duration.toFixed(2)} s · ${back.probe?.width} by ${back.probe?.height} · ${back.frames} frames · filmed from ${url} · one frame from the middle of each beat, read from the finished film`,
      beats, plan, middles: back.middles, out: sheet, rehearsal,
    });
    console.log(`demo: wrote ${rel(sheet)}`);
    if (keep) {
      mkdirSync(keep, { recursive: true });
      for (const [i, file] of back.middles.entries()) copyFileSync(file, path.join(keep, `beat-${i + 1}.png`));
      console.log(`demo: the frame from the middle of each beat is in ${rel(keep)}`);
    }
    return 0;
  } catch (e) {
    console.error(`demo: ${messageOf(e)}`);
    return 1;
  } finally {
    await browser?.close().catch(() => {});
    if (server) await new Promise((r) => /** @type {import('node:http').Server} */ (server).close(r));
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
