#!/usr/bin/env node
// How long the viewer takes at real positions, measured through a real browser against the real archive, and
// whether what is typed and what goes wrong are answered as they should be.
//
// The site is served from this computer. A browser opens the viewer page, one position after the other, each in a
// window of its own with nothing kept from the one before:
//   - the five test targets, by name;
//   - both ecliptic poles, where SPHEREx has thousands of photos;
//   - random positions over the whole sky (the same ones for the same seed).
// For each position the tool notes what the page timed itself (the plan, the first pair of pictures, the full set),
// what the archive sent (megabytes, counted from its answers), how the opening ended (pictures, or a state with its
// message) and every error the browser reported. Beside that:
//   - the number of photos of the plan is compared with the number the index gives, read here from the files;
//   - at the targets, the place of the star's light in every photo is compared with the place its catalogue motion
//     gives for the date of the photo;
//   - one target is opened again over a link slowed to 400 kbit/s and to 1.6 Mbit/s (every answer of the archive is
//     held back for as long as such a link would take);
//   - every typed position of tests/vectors/coords.json is opened through the page and compared with the answer of
//     astropy written there, the two old catalogue positions must move to their star, and what is not a position
//     must get a plain message;
//   - the browser tests of the faults (tests/e2e/i1-live.spec.mjs, with a stand-in archive) are run and counted.
//
//   node tools/timing.mjs                             everything; writes site/data/checks/live.json, the Checks rows
//                                                     K11 and K12 (site/data/checks/rows/i1.json) and the numbers
//                                                     (site/data/numbers/i1.json)
//   node tools/timing.mjs --only targets,poles        some parts only (targets, poles, random, slow, inputs, faults);
//                                                     prints what it finds and writes nothing
//   node tools/timing.mjs --seed 7 --random 20        other random positions
//   node tools/timing.mjs --browser chromium          the browser that comes with the test runner, where Chrome is
//                                                     not installed
//   node tools/timing.mjs --reviewed "<role>" <YYYY-MM-DD>
//                                                     after a person has read live.json: nothing is measured again;
//                                                     the two rows become PASS or FAIL by their rules
//   node tools/timing.mjs --rows                      the rows and the numbers again from live.json, not reviewed
//
// Needs the network: the bucket of the archive is read as a visitor's browser reads it.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { startServer } from './serve.mjs';
import { checkChecks, checkNumbers } from './contracts.mjs';
import { BUCKET_HOSTS } from '../site/js/contracts.js';
import { propagate } from '../site/js/lib/gaia.js';
import { createIndex } from '../site/js/lib/tiles.js';
import { MARGIN_DEG, MAX_HEADERS_PER_VISIT } from '../site/js/lib/livepath.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const LIVE_FILE = path.join(SITE, 'data', 'checks', 'live.json');
const ROWS_FILE = path.join(SITE, 'data', 'checks', 'rows', 'i1.json');
const NUMBERS_FILE = path.join(SITE, 'data', 'numbers', 'i1.json');
const FAULT_TESTS = 'tests/e2e/i1-live.spec.mjs';

/** The five test targets, as the list of names of this site calls them. */
const TARGETS = ['barnard', 'eps-indi-b', 'wise0855', 'rw-aur', 'r-dra'];
/** The poles of the ecliptic: 90 degrees less the tilt of the Earth's axis from the pole of the sky, at 18 h and at 6 h. */
const POLE_DEC = 90 - 23.4392911;
const POLES = [{ name: 'North ecliptic pole', ra: 270, dec: POLE_DEC }, { name: 'South ecliptic pole', ra: 90, dec: -POLE_DEC }];
const SEED = 20261114;
const RANDOM_POSITIONS = 20;
/** The range of colours a typed position opens in. */
const DEFAULT_DET = 2;
/** The display grid: north up, east to the left, this many arcsec to a pixel. */
const PIXEL_DEG = 6.15 / 3600;
/** A position gets this long before the tool gives up on it, ms. */
const GIVE_UP_MS = 240000;
/** The two slowed links: bytes a second, and how long a request waits before its first byte, ms. */
const SLOW_LINKS = [
  { name: '400 kbit/s', kbit: 400, bytesPerSecond: 50000, latencyMs: 400 },
  { name: '1.6 Mbit/s', kbit: 1600, bytesPerSecond: 200000, latencyMs: 150 },
];

// The rules of the two rows, written before the first run.
const RULES = {
  /** The median time to the first pair on the link of a desktop computer stays under this, seconds. */
  firstPairMedianS: 4,
  /** A star's light lies within this of where its catalogue motion puts it, pixels. */
  starPx: 1,
  /** A typed position is within this of the answer of astropy, arcsec. */
  typedArcsec: 0.1,
};

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const round = (/** @type {number} */ v, digits = 1) => Number(v.toFixed(digits));
/** @param {number[]} values */
function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
/** @param {number[]} values */
const worst = (values) => (values.filter(Number.isFinite).length ? Math.max(...values.filter(Number.isFinite)) : null);

/** Numbers between 0 and 1, the same for the same seed. @param {number} seed */
function randomNumbers(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positions spread evenly over the sphere. @param {number} n @param {number} seed */
function randomPositions(n, seed) {
  const next = randomNumbers(seed), out = [];
  for (let i = 0; i < n; i++) {
    const ra = 360 * next(), dec = Math.asin(2 * next() - 1) * 180 / Math.PI;
    out.push({ name: `Random position ${i + 1}`, ra: round(ra, 5), dec: round(dec, 5) });
  }
  return out;
}

/** The distance between two positions, arcsec. @param {number} ra1 @param {number} dec1 @param {number} ra2 @param {number} dec2 */
function separationArcsec(ra1, dec1, ra2, dec2) {
  const r = Math.PI / 180, d1 = dec1 * r, d2 = dec2 * r, da = (ra2 - ra1) * r;
  const h = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(da / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / r * 3600;
}

/**
 * The pixel of the display grid that holds a position: the grid is flat, touches the sky at the target, has north
 * up and east to the left, and the target lies on the middle of pixel (size / 2, size / 2), counted from 0 and
 * rounded down. Written here from that definition, apart from the code of the page.
 * @param {number} ra0 @param {number} dec0  The target. @param {number} ra @param {number} dec @param {number} size
 * @returns {[number, number]}
 */
function gridPixel(ra0, dec0, ra, dec, size) {
  const r = Math.PI / 180, a = (ra - ra0) * r, d = dec * r, d0 = dec0 * r;
  const front = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  const east = Math.cos(d) * Math.sin(a) / front / r, north = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / front / r;
  const c = Math.floor(size / 2);
  return [c - east / PIXEL_DEG, c + north / PIXEL_DEG];
}

/**
 * Where the light of a star is in a photo: the centre of the light within 4 pixels of a place, when something
 * stands out there (its brightest pixel at least 5 times the scatter of the photo above the photo's middle value).
 * @param {{w: number, h: number, data: number[]}} photo @param {number} x @param {number} y
 * @returns {[number, number] | null}
 */
function lightCentre(photo, x, y) {
  const all = photo.data.filter(Number.isFinite), mid = median(all);
  if (mid === null) return null;
  const scatter = 1.4826 * /** @type {number} */ (median(all.map((v) => Math.abs(v - mid))));
  /** @type {[number, number, number][]} */
  const near = [];
  for (let j = 0; j < photo.h; j++) {
    for (let i = 0; i < photo.w; i++) {
      const v = photo.data[j * photo.w + i];
      if (Math.hypot(i - x, j - y) <= 4 && Number.isFinite(v)) near.push([i, j, v]);
    }
  }
  if (near.length < 9 || !(Math.max(...near.map((p) => p[2])) > mid + 5 * scatter)) return null;
  const floor = Math.min(...near.map((p) => p[2]));
  let sum = 0, sx = 0, sy = 0;
  for (const [i, j, v] of near) { sum += v - floor; sx += (v - floor) * i; sy += (v - floor) * j; }
  return sum > 0 ? [sx / sum, sy / sum] : null;
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/**
 * What the viewer page shows now. Runs inside the page.
 * @param {boolean} withPhotos  Also hand back the values of every photo on the stage.
 */
async function readPage(withPhotos) {
  const m = await import(new URL('js/pages/view.js', document.baseURI).href);
  const p = m.viewParts(), made = p.made;
  const shown = (/** @type {Element | null} */ e) => e instanceof HTMLElement && !e.hidden && e.getClientRects().length > 0;
  const text = (/** @type {string} */ selector) => { const e = document.querySelector(selector); return shown(e) ? (e?.textContent ?? '').trim() : ''; };
  const box = document.querySelector('#plan .state');
  return {
    timing: p.timing, address: p.address, href: location.href, title: document.querySelector('h1')?.textContent ?? '',
    named: text('#view-named'), plan: text('#plan .plan-summary'), cap: text('#plan .plan-cap'), more: text('#plan .plan-button'),
    note: text('#stage .stage-note'),
    message: shown(box) ? {
      state: /** @type {HTMLElement} */ (box).dataset.state ?? '', title: box?.querySelector('.state-title')?.textContent ?? '',
      next: box?.querySelector('.state-next')?.textContent ?? '', steps: [...(box?.querySelectorAll('.state-actions > *') ?? [])].map((s) => s.textContent ?? ''),
    } : null,
    pictures: shown(document.querySelector('#stage')) && document.querySelectorAll('#stage .stage-panel').length > 0,
    pairs: p.pairs.length, visits: p.visits,
    made: made ? { pairs: made.pairs, size: made.size, signs: made.signs, align: made.align ? { dx: made.align.dx, dy: made.align.dy, n: made.align.n, warn: made.align.warn } : null } : null,
    photos: withPhotos && made ? made.singles.map((/** @type {any[]} */ pair) => pair.map((s) => ({ key: s.key, mjd: s.mjd, w: s.w, h: s.h, data: Array.from(s.data) }))) : null,
    problems: /** @type {any} */ (window).problemsSeen ?? [],
  };
}

/**
 * Open the viewer at an address in a window of its own and wait until the page has finished with it.
 * @param {import('@playwright/test').Browser} browser @param {string} base  The address of the site.
 * @param {string} address  What follows "view.html".
 * @param {{photos?: boolean, link?: {bytesPerSecond: number, latencyMs: number} | null, reader?: boolean, noNameService?: boolean}} [how]
 */
async function openView(browser, base, address, { photos = false, link = null, reader = true, noNameService = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  /** @type {string[]} */
  const uncaught = [];
  /** @type {string[]} */
  const consoleErrors = [];
  const archive = { requests: 0, bytes: 0, refused: 0 };
  try {
    await context.addInitScript((/** @type {boolean} */ live) => {
      const w = /** @type {any} */ (window);
      w.problemsSeen = [];
      if (!live) w.viewerOptions = { live: false };
      window.addEventListener('error', (e) => w.problemsSeen.push(`error: ${e.message}`));
      window.addEventListener('unhandledrejection', (e) => w.problemsSeen.push(`promise nobody caught: ${String(e.reason?.message ?? e.reason)}`));
    }, reader);
    const page = await context.newPage();
    page.on('pageerror', (e) => uncaught.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${m.text()}${m.location().url ? ` (${m.location().url})` : ''}`); });
    page.on('response', (r) => {
      if (!BUCKET_HOSTS.includes(new URL(r.url()).host)) return;
      archive.requests++;
      if (r.status() >= 400) archive.refused++;
      const n = Number(r.headers()['content-length']);
      if (Number.isFinite(n)) archive.bytes += n;
    });
    if (noNameService) await page.route((url) => /nph-sesame/.test(url.pathname), (route) => route.abort('failed'));
    if (link) {
      // a slow link: one answer at a time passes through it at its speed, after its delay
      let line = Promise.resolve();
      await page.route((url) => BUCKET_HOSTS.includes(url.host), async (route) => {
        try {
          const response = await route.fetch(), body = await response.body();
          const turn = line.then(() => sleep(1000 * body.length / link.bytesPerSecond));
          line = turn;
          await Promise.all([turn, sleep(link.latencyMs)]);
          await route.fulfill({ response, body });
        } catch {
          await route.abort('failed').catch(() => {});
        }
      });
    }
    const started = Date.now();
    await page.goto(`${base}view.html${address}`);
    /** @type {Awaited<ReturnType<typeof readPage>> | null} */
    let seen = null;
    let gaveUp = false;
    for (;;) {
      seen = await page.evaluate(readPage, false).catch(() => null);
      if (seen?.timing.done) break;
      if (Date.now() - started > GIVE_UP_MS) { gaveUp = true; break; }
      await sleep(200);
    }
    if (seen?.timing.done) {
      await sleep(300); // what follows the pictures (the list of all photos of the place, the message of the pictures) settles
      seen = await page.evaluate(readPage, photos);
    }
    return { seen, gaveUp, uncaught: [...uncaught, ...(seen?.problems ?? [])], consoleErrors, archive, wallMs: Date.now() - started };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The parts of the measurement
// ---------------------------------------------------------------------------------------------

const index = createIndex({
  fetch: /** @type {any} */ (async (/** @type {string} */ url) => {
    const file = fileURLToPath(url);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response('', { status: 404 });
  }),
  gunzip: (bytes) => gunzipSync(bytes),
  tilesKept: 2,
});
const INDEX_BASE = `${pathToFileURL(path.join(SITE, 'idx')).href}/`;

/** How many photos the index lists for a position in one range of colours, read here from the files. @param {number} ra @param {number} dec @param {number} det */
async function indexCount(ra, dec, det) {
  const frames = await index.framesCovering(ra, dec, INDEX_BASE, { margin: MARGIN_DEG });
  return frames.filter((f) => f.det === det).length;
}

/**
 * One position: open it and write down what happened.
 * @param {import('@playwright/test').Browser} browser @param {string} base
 * @param {{kind: string, name: string, address: string, entry?: any}} what
 * @param {{link?: {name: string, kbit: number, bytesPerSecond: number, latencyMs: number} | null}} [how]
 */
async function measure(browser, base, what, { link = null } = {}) {
  const got = await openView(browser, base, what.address, { photos: Boolean(what.entry?.catalogue), link });
  const s = got.seen, t = s?.timing;
  const ra = s?.address.ra ?? null, dec = s?.address.dec ?? null, det = s?.address.det ?? DEFAULT_DET;
  const opened = t?.opened ?? 0, at = (/** @type {number | null | undefined} */ ms) => (ms === null || ms === undefined ? null : round((opened + ms) / 1000));
  const pictures = Boolean(s?.pictures && s.pairs > 0), message = s?.message ?? null;
  const visits = s?.visits ?? [];
  const listed = ra !== null && dec !== null ? await indexCount(ra, dec, det) : null;
  const planned = /^(\d+) visits? · (\d+) photos? · ([\d.]+) MB/.exec(s?.plan ?? '');
  const row = {
    kind: what.kind, name: what.name, asked: what.address, ra, dec, det,
    ended: got.gaveUp || !t?.done ? 'gave up' : pictures ? 'pictures' : message ? 'message' : 'nothing',
    state: t?.state ?? null,
    message: message ? message.title : null, next_steps: message ? message.steps : [],
    visits: visits.length, photos_listed: visits.reduce((n, v) => n + v, 0), photos_in_index: listed,
    capped: Boolean(s?.cap), cap_says: s?.cap || null,
    pairs: s?.pairs ?? 0, photos_loaded: t?.photos ?? 0,
    plan_s: at(t?.planMs), first_pair_s: pictures ? at(t?.firstPairMs) : null, full_set_s: pictures && !t?.held ? at(t?.fullMs) : null,
    megabytes: round(got.archive.bytes / 1e6), megabytes_planned: planned ? Number(planned[3]) : null, megabytes_of_pictures: round((t?.bytes ?? 0) / 1e6),
    requests: got.archive.requests, refused: got.archive.refused,
    held_back: Boolean(t?.held), offer: s?.more || null, asked_again: Boolean(t?.askedAgain),
    aligned_px: s?.made?.align && s.made.align.dx !== null && s.made.align.dy !== null ? round(Math.hypot(s.made.align.dx, s.made.align.dy), 2) : null,
    aligned_on: s?.made?.align?.n ?? null, lined_up_says: s?.note || null,
    uncaught: got.uncaught, console_errors: got.consoleErrors,
    ...(link ? { link: link.name } : {}),
  };
  /** @type {any} */
  let star = null;
  if (what.entry?.catalogue && s?.photos && ra !== null && dec !== null) {
    /** @type {{side: string, mjd: number, off: number | null}[]} */
    const photos = [];
    /** @type {[number, number][][]} */
    const wanted = [[], []];
    for (const pair of s.photos) {
      for (const [side, photo] of pair.entries()) {
        const [sra, sdec] = propagate(what.entry.catalogue, photo.mjd);
        const want = gridPixel(ra, dec, sra, sdec, photo.w), have = lightCentre(photo, want[0], want[1]);
        wanted[side].push(want);
        photos.push({ side: side ? 'later' : 'earlier', mjd: photo.mjd, off: have ? Math.hypot(have[0] - want[0], have[1] - want[1]) : null });
      }
    }
    const offs = (/** @type {string} */ side) => photos.filter((p) => p.side === side && p.off !== null).map((p) => /** @type {number} */ (p.off));
    const found = photos.filter((p) => p.off !== null);
    const mean = (/** @type {[number, number][]} */ list, /** @type {0 | 1} */ k) => list.reduce((n, v) => n + v[k], 0) / list.length;
    star = {
      name: what.name, det, state: row.state, photos: photos.length, seen_in: found.length,
      earlier: { photos: offs('earlier').length, median_px: offs('earlier').length ? round(/** @type {number} */ (median(offs('earlier'))), 2) : null, worst_px: offs('earlier').length ? round(/** @type {number} */ (worst(offs('earlier'))), 2) : null },
      later: { photos: offs('later').length, median_px: offs('later').length ? round(/** @type {number} */ (median(offs('later'))), 2) : null, worst_px: offs('later').length ? round(/** @type {number} */ (worst(offs('later'))), 2) : null },
      worst_px: found.length ? round(/** @type {number} */ (worst(found.map((p) => /** @type {number} */ (p.off)))), 2) : null,
      // how far the catalogue moves the star between the two visits, on the grid
      catalogue_moved_px: wanted[0].length && wanted[1].length ? round(Math.hypot(mean(wanted[1], 0) - mean(wanted[0], 0), mean(wanted[1], 1) - mean(wanted[0], 1)), 2) : null,
      within_rule: found.length === photos.length && photos.length > 0 && offs('earlier').length > 0 && offs('later').length > 0 && found.every((p) => /** @type {number} */ (p.off) < RULES.starPx),
    };
  }
  return { row, star };
}

/** @param {any} r */
function say(r) {
  const time = r.first_pair_s === null ? '' : `, first pair ${r.first_pair_s} s${r.full_set_s === null ? '' : `, full set ${r.full_set_s} s`}`;
  const cost = `${r.megabytes} MB in ${r.requests} requests`;
  const end = r.ended === 'pictures' ? `${r.pairs} ${r.pairs === 1 ? 'pair' : 'pairs'}${r.state && r.state !== 'ok' ? ` (${r.state})` : ''}` : r.ended === 'message' ? `message: ${r.state}` : r.ended;
  console.log(`  ${r.name}${r.link ? ` at ${r.link}` : ''}: ${end}, plan ${r.plan_s ?? '?'} s${time}, ${cost}${r.capped ? ', plan capped' : ''}${r.held_back ? `, "${r.offer}"` : ''}${r.uncaught.length ? `, UNCAUGHT: ${r.uncaught.join(' | ')}` : ''}`);
}

/**
 * What is typed, through the page itself: no archive is read, and the name service is not asked.
 * @param {import('@playwright/test').Browser} browser @param {string} base @param {any} names
 */
async function measureInputs(browser, base, names) {
  const vectors = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'vectors', 'coords.json'), 'utf8'));
  const quiet = { reader: false, noNameService: true };
  const positions = [];
  for (const c of vectors.cases) {
    // "as typed": a position where a fast star used to be is not moved to the star
    const got = await openView(browser, base, `?q=${encodeURIComponent(c.text)}#as-typed`, quiet);
    const a = got.seen?.address ?? {};
    const off = Number.isFinite(a.ra) && Number.isFinite(a.dec) ? separationArcsec(a.ra, a.dec, c.ra, c.dec) : null;
    positions.push({ text: c.text, off_arcsec: off === null ? null : round(off, 4), ok: off !== null && off <= RULES.typedArcsec && got.uncaught.length === 0 });
  }
  // the two positions of old catalogues: the challenge statement's own for WISE 0855-0714, and Barnard's Star in 2000
  const moved = [];
  for (const [text, id] of [['08h55m10.831s -7d14m42.53s', 'wise0855'], ['17h57m48.5s +04d41m36s', 'barnard']]) {
    const entry = names.entries.find((/** @type {any} */ e) => e.id === id);
    const typed = vectors.cases.find((/** @type {any} */ c) => c.text === text);
    const got = await openView(browser, base, `?q=${encodeURIComponent(text)}`, quiet);
    const a = got.seen?.address ?? {};
    const off = Number.isFinite(a.ra) && Number.isFinite(a.dec) ? separationArcsec(a.ra, a.dec, entry.ra, entry.dec) : null;
    moved.push({
      text, star: entry.name, typed_from_star_arcmin: round(separationArcsec(typed.ra, typed.dec, entry.ra, entry.dec) / 60, 2),
      off_arcsec: off === null ? null : round(off, 3), says: got.seen?.named ?? '',
      ok: off !== null && off < PIXEL_DEG * 3600 && (got.seen?.named ?? '').includes(`This looks like ${entry.name}`) && got.seen?.title === entry.name && got.uncaught.length === 0,
    });
  }
  // what is not a position: a name of this site's list opens; anything else gets a message with a next step
  const refused = [];
  for (const text of vectors.reject) {
    const got = await openView(browser, base, `?q=${encodeURIComponent(text)}`, quiet);
    const m = got.seen?.message ?? null, state = got.seen?.timing.state ?? null;
    const isName = state === 'page-not-connected'; // the page went on to open a position: the text was a name of the list
    refused.push({ text, state, message: m?.title ?? null, ok: got.uncaught.length === 0 && !got.gaveUp && Boolean(m && m.title && (isName || m.steps.length > 0)) && ['page-no-position', 'page-no-name', 'page-empty', 'page-not-connected'].includes(state ?? '') });
  }
  return { positions, moved, refused };
}

/** The browser tests of the faults, run as they are and counted: the tests tagged @fault and @input. */
function runFaultTests() {
  const cli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const run = spawnSync(process.execPath, [cli, 'test', FAULT_TESTS, '--reporter=json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  /** @type {{title: string, tags: string[], ok: boolean}[]} */
  const cases = [];
  let report;
  try { report = JSON.parse(run.stdout); } catch { throw new Error(`the browser tests gave no report:\n${(run.stderr || run.stdout || '').slice(0, 2000)}`); }
  /** @param {any} suite */
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) cases.push({ title: spec.title, tags: (spec.tags ?? []).map((/** @type {string} */ t) => t.replace(/^@/, '')), ok: Boolean(spec.ok) });
    for (const inner of suite.suites ?? []) walk(inner);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return cases.filter((c) => c.tags.includes('fault') || c.tags.includes('input')).map((c) => ({ case: c.title, kind: c.tags.includes('fault') ? 'fault' : 'input', ok: c.ok }));
}

// ---------------------------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------------------------

/** @param {any} live */
function summarise(live) {
  const all = live.positions, withPictures = all.filter((/** @type {any} */ r) => r.ended === 'pictures');
  const handled = all.filter((/** @type {any} */ r) => r.ended === 'pictures' || r.ended === 'message');
  const pick = (/** @type {string} */ key) => withPictures.map((/** @type {any} */ r) => r[key]).filter((/** @type {any} */ v) => v !== null);
  const both = (/** @type {number[]} */ v) => ({ median: v.length ? round(/** @type {number} */ (median(v))) : null, worst: v.length ? round(/** @type {number} */ (worst(v))) : null, positions: v.length });
  /** @type {Record<string, number>} */
  const states = {};
  for (const r of all) states[r.state ?? r.ended] = (states[r.state ?? r.ended] ?? 0) + 1;
  return {
    positions: all.length, ended_in_pictures: withPictures.length, ended_in_a_message: handled.length - withPictures.length, not_handled: all.length - handled.length,
    uncaught_errors: all.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.uncaught.length, 0),
    // what the browser wrote to its console as an error and the page had caught: a request for a file that is not there
    console_errors: all.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + r.console_errors.length, 0),
    // positions where pairs waited behind "Load more", and where the page asked again for what the reader held back
    held_back: all.filter((/** @type {any} */ r) => r.held_back).length,
    asked_again: all.filter((/** @type {any} */ r) => r.asked_again).length,
    states,
    first_pair_s: both(pick('first_pair_s')), full_set_s: both(pick('full_set_s')), megabytes: both(pick('megabytes')),
    plan_matches_index: all.filter((/** @type {any} */ r) => r.photos_in_index !== null && r.visits > 0).every((/** @type {any} */ r) => r.photos_listed === r.photos_in_index),
    plans_compared_with_index: all.filter((/** @type {any} */ r) => r.photos_in_index !== null && r.visits > 0).length,
  };
}

/**
 * The two rows and the numbers, from what was measured.
 * @param {any} live @param {[string, string] | null} reviewer
 */
function rowsOf(live, reviewer) {
  const s = live.summary, n = s.positions;
  const poles = live.positions.filter((/** @type {any} */ r) => r.kind === 'pole');
  const stars = (live.stars ?? []).filter((/** @type {any} */ x) => x.within_rule);
  const barnard = (live.stars ?? []).find((/** @type {any} */ x) => x.name === "Barnard's Star");
  const k11ok = s.not_handled === 0 && s.uncaught_errors === 0 && s.first_pair_s.median !== null && s.first_pair_s.median < RULES.firstPairMedianS
    && poles.length === 2 && poles.every((/** @type {any} */ r) => r.capped) && Boolean(barnard?.within_rule) && stars.length >= 2;
  const inputs = live.inputs, faults = (live.faults ?? []).filter((/** @type {any} */ c) => c.kind === 'fault'), named = (live.faults ?? []).filter((/** @type {any} */ c) => c.kind === 'input');
  const count = (/** @type {any[]} */ list) => `${list.filter((c) => c.ok).length} of ${list.length}`;
  /** A measured time or size as it is written: one decimal. @param {number | null} v */
  const one = (v) => (v === null ? 'none' : v.toFixed(1));
  const typedWorst = inputs ? worst(inputs.positions.map((/** @type {any} */ p) => p.off_arcsec ?? Infinity)) : null;
  const k12ok = Boolean(inputs) && [inputs.positions, inputs.moved, inputs.refused, faults, named].every((list) => list.length > 0 && list.every((/** @type {any} */ c) => c.ok));
  const status = (/** @type {boolean} */ ok) => (reviewer ? (ok ? 'PASS' : 'FAIL') : 'UNVERIFIED');
  const common = { rule_commit: null, image: null, image_sha256: null, reviewer_role: reviewer ? reviewer[0] : null, reviewed_on: reviewer ? reviewer[1] : null };
  const slow = (live.slow ?? []).map((/** @type {any} */ r) => `${r.link}: ${r.ended === 'pictures' ? `first pair after ${r.first_pair_s} s${r.held_back ? `, the rest offered as "${r.offer}"` : ''}` : `message "${r.state}"`}`).join('; ');
  const rows = [
    {
      id: 'K11',
      title: 'A typed position, read straight from the archive: how long it takes and how it ends',
      claim: 'Any position on the sky gives two visits at one colour within seconds on a desktop link, or a plain message, and no error is left uncaught.',
      test: `${live.browser} opened the viewer at ${n} positions against the real archive, one after the other, each in a fresh window: the five test targets by name, both ecliptic poles and ${live.positions.filter((/** @type {any} */ r) => r.kind === 'random').length} random positions (seed ${live.seed}). Times count from opening the page; megabytes are counted from the answers of the archive. The photos of each plan are counted against the index, and the stars of the targets are compared with their catalogue motion in every photo.${slow ? ` One target was opened again over slowed links (${slow}).` : ''}`,
      pass_rule: `Every position ends in pictures or in a message with a next step; the browser reports no uncaught error; the median time to the first pair is under ${RULES.firstPairMedianS} seconds; both poles say that their plan is capped; Barnard's Star and one more target lie within ${RULES.starPx} pixel of their catalogue motion in every photo of both visits.`,
      ...common,
      status: status(k11ok),
      plain: `timed at ${n} real positions`,
      value: `${s.ended_in_pictures + s.ended_in_a_message} of ${n} positions end in pictures (${s.ended_in_pictures}) or a message (${s.ended_in_a_message}); ${s.uncaught_errors} uncaught errors${s.console_errors ? ` (${s.console_errors} failed requests for a file that is not there, caught by the page)` : ''}; first pair: median ${one(s.first_pair_s.median)} s, worst ${one(s.first_pair_s.worst)} s; full set: median ${one(s.full_set_s.median)} s, worst ${one(s.full_set_s.worst)} s; median ${one(s.megabytes.median)} MB, most ${one(s.megabytes.worst)} MB; ${stars.length} targets within ${RULES.starPx} px of their catalogue motion${barnard ? ` (Barnard's Star: worst ${barnard.worst_px} px)` : ''}${s.held_back ? `; at ${s.held_back} ${s.held_back === 1 ? 'position' : 'positions'} some pairs waited behind "Load more"` : ''}${s.asked_again ? `; at ${s.asked_again} ${s.asked_again === 1 ? 'position' : 'positions'} the page asked a second time for pairs the reader had held back` : ''}`,
      unit: null,
      reference: `${n} of ${n} positions, 0 errors, median first pair under ${RULES.firstPairMedianS} s, 2 targets within ${RULES.starPx} px`,
      tolerance: 'none',
      rerun: 'node tools/timing.mjs',
    },
    {
      id: 'K12',
      title: 'What is typed is read, and what goes wrong is said',
      claim: 'A position typed in any usual form opens where astropy puts it, an old catalogue position of a fast star moves to the star, and every way the archive can fail has its own message with a next step.',
      test: `Through the viewer page in ${live.browser}: ${inputs ? inputs.positions.length : 0} typed positions compared with astropy; the challenge statement's position for WISE 0855-0714 and Barnard's Star's position in 2000; ${inputs ? inputs.refused.length : 0} texts that are not positions. With a stand-in archive behind the page (${FAULT_TESTS}): the bucket blocked, HTTP 503, HTTP 403, offline, a failure in the middle of loading, a link of 400 kbit/s, a link that turns slow while the first pair loads, one pair that stalls on a quick link, a position with no photos, a part of the sky that is not listed, one visit only, a saturated star, an empty patch; and the names (this site's list, the name service, a name nobody knows).`,
      pass_rule: `Every typed position within ${RULES.typedArcsec} arcsec of astropy; both old positions move to their star and say so; every text that is not a position gets a message; every fault shows its own message and a next step.`,
      ...common,
      status: status(k12ok),
      plain: 'every fault shows its message',
      value: inputs ? `${count(inputs.positions)} typed positions (worst ${typedWorst === null || !Number.isFinite(typedWorst) ? 'not read' : `${typedWorst} arcsec`}); ${count(inputs.moved)} old positions moved to their star; ${count(inputs.refused)} other texts answered; ${count(faults)} faults and ${count(named)} name tests show their message` : 'not measured',
      unit: null,
      reference: 'all of them',
      tolerance: `${RULES.typedArcsec} arcsec for a typed position`,
      rerun: 'node tools/timing.mjs --only inputs,faults',
    },
  ];
  /** @param {number} value @param {string | null} unit @param {string} [text] */
  const entry = (value, unit, text) => ({ value, err: null, unit, text: text ?? String(value), check: 'K11' });
  /** @type {Record<string, any>} */
  const numbers = { 'live.positions': entry(n, null), 'live.first_pair.budget_s': entry(RULES.firstPairMedianS, 's') };
  if (s.first_pair_s.median !== null) { numbers['live.first_pair.median_s'] = entry(s.first_pair_s.median, 's', one(s.first_pair_s.median)); numbers['live.first_pair.worst_s'] = entry(s.first_pair_s.worst, 's', one(s.first_pair_s.worst)); }
  if (s.full_set_s.median !== null) { numbers['live.full_set.median_s'] = entry(s.full_set_s.median, 's', one(s.full_set_s.median)); numbers['live.full_set.worst_s'] = entry(s.full_set_s.worst, 's', one(s.full_set_s.worst)); }
  if (s.megabytes.median !== null) { numbers['live.megabytes.median'] = entry(s.megabytes.median, 'MB', one(s.megabytes.median)); numbers['live.megabytes.most'] = entry(s.megabytes.worst, 'MB', one(s.megabytes.worst)); }
  numbers['live.plan.photos_per_visit'] = entry(MAX_HEADERS_PER_VISIT, null);
  return { rows, numbers };
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, file).split(path.sep).join('/')}`);
}

/** @param {any} live @param {[string, string] | null} reviewer */
function writeRows(live, reviewer) {
  const { rows, numbers } = rowsOf(live, reviewer);
  const bad = [...checkChecks(rows), ...checkNumbers(numbers)];
  if (bad.length) throw new Error(`the rows or the numbers do not fit their contract:\n${bad.join('\n')}`);
  writeJson(ROWS_FILE, rows);
  writeJson(NUMBERS_FILE, numbers);
  for (const r of rows) console.log(`${r.id} ${r.status}: ${r.value}`);
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  /** @param {string} name @param {string} fallback */
  const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

  if (args.includes('--reviewed')) {
    const i = args.indexOf('--reviewed'), role = args[i + 1], day = args[i + 2];
    if (!role || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error('usage: node tools/timing.mjs --reviewed "<role>" <YYYY-MM-DD>');
    if (!existsSync(LIVE_FILE)) throw new Error('there is nothing to review yet: run node tools/timing.mjs first');
    writeRows(JSON.parse(readFileSync(LIVE_FILE, 'utf8')), [role, day]);
    return;
  }
  if (args.includes('--rows')) {
    if (!existsSync(LIVE_FILE)) throw new Error('there is nothing measured yet: run node tools/timing.mjs first');
    writeRows(JSON.parse(readFileSync(LIVE_FILE, 'utf8')), null);
    return;
  }

  const only = args.includes('--only') ? option('--only', '').split(',').map((s) => s.trim()).filter(Boolean) : null;
  const wants = (/** @type {string} */ part) => !only || only.includes(part);
  const seed = Number(option('--seed', String(SEED))), nRandom = Number(option('--random', String(RANDOM_POSITIONS)));
  const names = JSON.parse(readFileSync(path.join(SITE, 'data', 'names.json'), 'utf8'));

  const { server, url: base } = await startServer({ root: SITE, port: 0 });
  const channel = option('--browser', 'chrome');
  const browser = await chromium.launch({ ...(channel === 'chromium' ? {} : { channel }), headless: !args.includes('--headed') });
  /** @type {any} */
  const live = {
    about: 'How long the viewer takes at real positions, and how what is typed and what goes wrong are answered. Measured through a browser against the real archive by tools/timing.mjs.',
    measured_on: new Date().toISOString().slice(0, 10),
    browser: `${channel === 'chromium' ? 'Chromium' : 'Chrome'} ${browser.version()}`,
    link: 'the link of the computer that ran it, as it is',
    seed,
    rules: { first_pair_median_s: RULES.firstPairMedianS, star_px: RULES.starPx, typed_arcsec: RULES.typedArcsec },
    positions: [], stars: [], slow: [],
  };
  try {
    /** @type {{kind: string, name: string, address: string, entry?: any}[]} */
    const list = [];
    if (wants('targets')) for (const id of TARGETS) { const entry = names.entries.find((/** @type {any} */ e) => e.id === id); list.push({ kind: 'target', name: entry.name, address: `?q=${encodeURIComponent(entry.name)}`, entry }); }
    if (wants('poles')) for (const p of POLES) list.push({ kind: 'pole', name: p.name, address: `?ra=${round(p.ra, 5)}&dec=${round(p.dec, 5)}` });
    if (wants('random')) for (const p of randomPositions(nRandom, seed)) list.push({ kind: 'random', name: p.name, address: `?ra=${p.ra}&dec=${p.dec}` });
    if (list.length) console.log(`${list.length} positions, ${live.browser}`);
    for (const what of list) {
      const { row, star } = await measure(browser, base, what);
      live.positions.push(row);
      if (star) live.stars.push(star);
      say(row);
    }
    if (wants('slow')) {
      const entry = names.entries.find((/** @type {any} */ e) => e.id === option('--slow-target', 'rw-aur'));
      console.log(`slowed links, at ${entry.name}`);
      for (const link of SLOW_LINKS) {
        const { row } = await measure(browser, base, { kind: 'slow', name: entry.name, address: `?q=${encodeURIComponent(entry.name)}` }, { link });
        live.slow.push({ ...row, kbit_per_s: link.kbit, waits_ms: link.latencyMs });
        say(row);
      }
    }
    if (wants('inputs')) {
      live.inputs = await measureInputs(browser, base, names);
      const { positions, moved, refused } = live.inputs;
      console.log(`typed: ${positions.filter((/** @type {any} */ p) => p.ok).length} of ${positions.length} positions within ${RULES.typedArcsec} arcsec, ${moved.filter((/** @type {any} */ p) => p.ok).length} of ${moved.length} old positions moved to their star, ${refused.filter((/** @type {any} */ p) => p.ok).length} of ${refused.length} other texts answered`);
      for (const p of [...positions, ...moved, ...refused].filter((/** @type {any} */ q) => !q.ok)) console.log(`  NOT AS IT SHOULD BE: ${JSON.stringify(p)}`);
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
  if (wants('faults')) {
    live.faults = runFaultTests();
    console.log(`faults: ${live.faults.filter((/** @type {any} */ c) => c.ok).length} of ${live.faults.length} browser tests pass`);
    for (const c of live.faults.filter((/** @type {any} */ q) => !q.ok)) console.log(`  FAILED: ${c.case}`);
  }
  live.summary = summarise(live);
  console.log(JSON.stringify(live.summary, null, 1));
  for (const star of live.stars) console.log(`  ${star.name}: ${star.seen_in} of ${star.photos} photos, earlier visit ${star.earlier.median_px} px (worst ${star.earlier.worst_px}), later visit ${star.later.median_px} px (worst ${star.later.worst_px}), catalogue moved it ${star.catalogue_moved_px} px${star.within_rule ? '' : ': NOT within the rule'}`);
  if (only) {
    console.log('a part only: nothing written');
    if (args.includes('--out')) writeJson(path.resolve(option('--out', '')), live);
    return;
  }
  writeJson(LIVE_FILE, live);
  writeRows(live, null);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
