// A typed position, end to end, in a real browser: the page's own reader (worker, queue, index, FITS reader) runs
// as it is, and the archive it reads is made here. Requests to the bucket and to the index are intercepted and
// answered with frames made by hand: FITS files with a sky of known stars, turned by 12 degrees in one visit and by
// 159 in the other, as SPHEREx turns between visits. Nothing leaves the computer, and what the page must show is
// known beforehand. The same stand-in archive then fails in every way the page has a message for.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import { BUCKET_HOSTS, BUCKET_URLS } from '../../site/js/contracts.js';
import { tileOf, keyOf } from '../../site/js/lib/tiles.js';
import { skyAt } from '../../site/js/ui/hover.js';
import { STATE_TEXT } from '../../site/js/ui/states.js';
import { bytesPerFrame } from '../../site/js/lib/livepath.js';
import { visitId } from '../../site/js/ui/visitstrip.js';

const REAL_META = JSON.parse(readFileSync(new URL('../../site/idx/meta.json', import.meta.url), 'utf8'));
const NAMES = JSON.parse(readFileSync(new URL('../../site/data/names.json', import.meta.url), 'utf8'));
const P = 6.15 / 3600, NX = 2040, NY = 2040, BLOCK = 2880, DATA_AT = 2 * BLOCK, FLAGS_AT = DATA_AT + Math.ceil(NX * NY * 4 / BLOCK) * BLOCK;
const WV = '2025W30_1A/l2b-v1-2026-001';
/** When the two visits of the stand-in archive start, MJD: half a year apart. */
const FIRST_VISIT = 60900, SECOND_VISIT = 61080;
const VISIT_IDS = [visitId(FIRST_VISIT), visitId(SECOND_VISIT)];

/** The stars of the field: pixels of the grid east and north of the target, and their peak in MJy/sr. The last one is at the target itself. */
const STARS = [
  { east: 9, north: -6, peak: 60 }, { east: -11, north: 8, peak: 45 }, { east: 4, north: 13, peak: 80 },
  { east: -7, north: -12, peak: 50 }, { east: 14, north: 5, peak: 40 }, { east: 0, north: 0, peak: 30 },
];

/** @param {string} key @param {string | number | boolean} value */
function card(key, value) {
  const text = typeof value === 'string' ? `'${value.padEnd(8)}'` : typeof value === 'boolean' ? (value ? 'T' : 'F').padStart(20) : String(value).padStart(20);
  return `${key.padEnd(8)}= ${text}`.padEnd(80);
}

/** A FITS header: the cards, END, and blanks up to a whole block. @param {[string, string | number | boolean][]} cards */
function header(cards) {
  const text = cards.map(([k, v]) => card(k, v)).join('') + 'END'.padEnd(80);
  return Buffer.from(text.padEnd(Math.ceil(text.length / BLOCK) * BLOCK), 'latin1');
}

/** A number between 0 and 1 for a pixel of a frame, the same every time. @param {number} seed @param {number} x @param {number} y */
function noiseAt(seed, x, y) {
  let t = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(x + 1, 0x85ebca6b) ^ Math.imul(y + 1, 0xc2b2ae35)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * One frame of the stand-in archive: a detector turned by `turn` degrees whose pixel (x, y) sees the target.
 * @param {{ra: number, dec: number, turn: number, x: number, y: number, mjd: number, obs: number, det?: number, seed: number,
 *   background?: number, stars?: typeof STARS, saturated?: boolean}} o
 */
function makeFrame({ ra, dec, turn, x, y, mjd, obs, det = 2, seed, background = 0.4, stars = STARS, saturated = false }) {
  const t = turn * Math.PI / 180;
  const cd = /** @type {[number, number, number, number]} */ ([-P * Math.cos(t), P * Math.sin(t), P * Math.sin(t), P * Math.cos(t)]);
  const sky = { ra, dec, cd };
  /** @type {[number, number, number, number, number, number, number, number, number, number, number, number, number]} */
  const row = [0, obs, 1, det, mjd, ...[[-0.5, -0.5], [NX - 0.5, -0.5], [NX - 0.5, NY - 0.5], [-0.5, NY - 0.5]].flatMap(([px, py]) => skyAt(sky, x, y, px, py).map((v) => Number(v.toFixed(5))))];
  const head = Buffer.concat([
    header([['SIMPLE', true], ['BITPIX', 8], ['NAXIS', 0], ['EXTEND', true]]),
    header([
      ['XTENSION', 'IMAGE'], ['BITPIX', -32], ['NAXIS', 2], ['NAXIS1', NX], ['NAXIS2', NY], ['PCOUNT', 0], ['GCOUNT', 1], ['EXTNAME', 'IMAGE'],
      ['MJD-AVG', mjd], ['CTYPE1', 'RA---TAN'], ['CTYPE2', 'DEC--TAN'], ['CRVAL1', ra], ['CRVAL2', dec], ['CRPIX1', x + 1], ['CRPIX2', y + 1],
      ['CD1_1', cd[0]], ['CD1_2', cd[1]], ['CD2_1', cd[2]], ['CD2_2', cd[3]],
    ]),
  ]);
  // the part after the image is not a FLAGS image: the reader must go on without flags, and say so
  const noFlags = header([['XTENSION', 'IMAGE'], ['BITPIX', 8], ['NAXIS', 0], ['PCOUNT', 0], ['GCOUNT', 1], ['EXTNAME', 'NOFLAGS']]);

  /** The value of a pixel: sky background, noise, and the stars where the sky has them. @param {number} px @param {number} py */
  function value(px, py) {
    const dx = px - x, dy = py - y;
    if (Math.abs(dx) > 48 || Math.abs(dy) > 48) return 0;
    if (saturated && Math.hypot(dx, dy) < 1.6) return NaN;
    const east = (cd[0] * dx + cd[1] * dy) / P, north = (cd[2] * dx + cd[3] * dy) / P;
    let v = background + 0.04 * (noiseAt(seed, px, py) + noiseAt(seed + 7, px, py) + noiseAt(seed + 13, px, py) - 1.5);
    for (const s of stars) v += s.peak * Math.exp(-((east - s.east) ** 2 + (north - s.north) ** 2) / (2 * 0.9 * 0.9));
    if (saturated) v += 400 * Math.exp(-(east * east + north * north) / (2 * 1.2 * 1.2));
    return v;
  }

  /** The bytes of the file from `start` to `end`, both included. @param {number} start @param {number} end */
  function read(start, end) {
    const out = Buffer.alloc(end - start + 1);
    for (let at = start; at <= end;) {
      if (at < head.length) {
        const n = Math.min(end + 1, head.length) - at;
        head.copy(out, at - start, at, at + n);
        at += n;
      } else if (at >= DATA_AT && at < DATA_AT + NX * NY * 4) {
        // image values: big-endian float32, row by row
        const pixel = Math.floor((at - DATA_AT) / 4), px = pixel % NX, py = Math.floor(pixel / NX);
        if ((at - DATA_AT) % 4 === 0 && at + 3 <= end) {
          const v = value(px, py);
          if (v !== 0) out.writeFloatBE(v, at - start);
          at += 4;
        } else at += 1;
      } else if (at >= FLAGS_AT && at < FLAGS_AT + noFlags.length) {
        const n = Math.min(end + 1, FLAGS_AT + noFlags.length) - at;
        noFlags.copy(out, at - start, at - FLAGS_AT, at - FLAGS_AT + n);
        at += n;
      } else at += 1;
    }
    return out;
  }
  return { key: keyOf(row, [WV]), row, read, sky, x, y, mjd, turn };
}

/**
 * A field of the stand-in archive: `pairs` photos in each of two visits half a year apart, the n-th of one visit at
 * the colour of the n-th of the other.
 * @param {{ra?: number, dec?: number, det?: number, pairs?: number, visits?: 1 | 2, saturated?: boolean, stars?: typeof STARS}} [o]
 */
function makeField({ ra = 150, dec = 20, det = 2, pairs = 4, visits = 2, saturated = false, stars = STARS } = {}) {
  const frames = [];
  for (let k = 0; k < pairs; k++) {
    frames.push(makeFrame({ ra, dec, det, turn: 12 + k, x: 1000.3 - 7 * k, y: 500.4 + 300 * k, mjd: FIRST_VISIT + 0.01 * k, obs: 100 + k, seed: 10 + k, background: 0.4 + 0.05 * k, saturated, stars }));
    if (visits === 2) frames.push(makeFrame({ ra, dec, det, turn: 159 - k, x: 1100.6 + 5 * k, y: 502.1 + 300 * k, mjd: SECOND_VISIT + 0.01 * k, obs: 200 + k, seed: 50 + k, background: 0.7 + 0.03 * k, saturated, stars }));
  }
  const tile = tileOf(ra, dec, REAL_META);
  const meta = { ...REAL_META, wv: [WV], complete: [tile], n_frames: frames.length };
  return { ra, dec, frames, tile, meta, byKey: new Map(frames.map((f) => [f.key, f])) };
}

/**
 * Put a stand-in archive behind the page: its index and its bucket.
 * @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof makeField>} field
 * @param {{bucket?: (key: string, start: number) => 'ok' | 'blocked' | 'offline' | 503 | 403, indexed?: boolean,
 *   link?: {bytesPerSecond: number, latencyMs: number} | null | ((key: string, start: number) => {bytesPerSecond: number, latencyMs: number} | null)}} [how]
 *   `bucket` is asked at every request, with the photo and the first byte asked for. `link` makes the bucket answer as over a slow link: one request at a time
 *   goes through it at that speed, after that delay. As a function it is asked for every request, with the photo
 *   and the first byte asked for, and may let a request pass at once.
 */
async function serveArchive(page, field, how = {}) {
  /** @type {{url: string, start: number, end: number, status: number}[]} */
  const asked = [];
  let line = Promise.resolve();
  await page.route('**/idx/meta.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(how.indexed === false ? { ...field.meta, complete: [] } : field.meta) }));
  await page.route('**/idx/t/*.json.gz', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name !== `${field.tile}.json.gz`) return route.fulfill({ status: 404, body: 'Not found.' });
    return route.fulfill({ contentType: 'application/gzip', body: gzipSync(JSON.stringify(field.frames.map((f) => f.row))) });
  });
  await page.route((url) => BUCKET_HOSTS.includes(url.host), async (route) => {
    const url = route.request().url();
    const base = BUCKET_URLS.find((b) => url.startsWith(b)), frame = base ? field.byKey.get(url.slice(base.length)) : undefined;
    const m = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '');
    const mode = how.bucket ? how.bucket(frame?.key ?? '', m ? Number(m[1]) : -1) : 'ok';
    const note = (/** @type {number} */ status) => asked.push({ url, start: m ? Number(m[1]) : -1, end: m ? Number(m[2]) : -1, status });
    const cors = { 'access-control-allow-origin': '*' };
    if (mode === 'blocked') { note(0); return route.abort('blockedbyclient'); }
    if (mode === 'offline') { note(0); return route.abort('internetdisconnected'); }
    if (mode === 503 || mode === 403) { note(mode); return route.fulfill({ status: mode, headers: cors, body: mode === 503 ? 'Slow Down' : 'Access Denied' }); }
    if (!frame || !m) { note(404); return route.fulfill({ status: 404, headers: cors, body: 'NoSuchKey' }); }
    const body = frame.read(Number(m[1]), Number(m[2]));
    const link = typeof how.link === 'function' ? how.link(frame.key, Number(m[1])) : how.link;
    if (link) {
      const { bytesPerSecond, latencyMs } = link;
      const turn = line.then(() => new Promise((r) => setTimeout(r, 1000 * body.length / bytesPerSecond)));
      line = turn;
      await Promise.all([turn, new Promise((r) => setTimeout(r, latencyMs))]);
    }
    note(206);
    return route.fulfill({ status: 206, headers: { ...cors, 'content-type': 'binary/octet-stream', 'accept-ranges': 'bytes' }, body }).catch(() => {});
  });
  return asked;
}

/** What goes wrong on a page: errors nobody caught, console errors, requests to a host that is not the site or the bucket. @param {import('@playwright/test').Page} page @param {string | undefined} baseURL */
function watch(page, baseURL) {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  /** @type {string[]} */
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== origin && !BUCKET_HOSTS.includes(u.host) && u.protocol !== 'data:') problems.push(`request to another host: ${r.url()}`); });
  return problems;
}

/** What the page shows now. @param {import('@playwright/test').Page} page @returns {Promise<any>} */
function read(page) {
  return page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const p = m.viewParts(), rb = p.stage.readback();
    /** The pixel with the largest value within 2 pixels of a place. @param {any} pic @param {number} x @param {number} y */
    const brightest = (pic, x, y) => {
      let best = -Infinity, at = [NaN, NaN];
      for (let j = y - 2; j <= y + 2; j++) for (let i = x - 2; i <= x + 2; i++) { const v = pic.data[j * pic.w + i]; if (Number.isFinite(v) && v > best) { best = v; at = [i, j]; } }
      return at;
    };
    const picture = (/** @type {any} */ pic) => pic && ({ w: pic.w, h: pic.h, photos: pic.photos ?? 1, mjd: pic.mjd, key: pic.key, shown: Array.from(pic.data).filter(Number.isFinite).length, flags: pic.flags === null ? null : 'loaded', marks: pic.marks ?? [] });
    return {
      timing: p.timing, address: p.address, link: p.link, pairs: p.pairs.length, choices: p.choices.length, chosen: p.chosen,
      mode: rb.mode, side: rb.side, playing: rb.playing, panels: rb.panels.map((/** @type {any} */ q) => ({ kind: q.kind, w: q.w, h: q.h, caption: q.caption })),
      made: p.made && { pairs: p.made.pairs, shown: p.made.shown, size: p.made.size, signs: p.made.signs, align: p.made.align && { dx: p.made.align.dx, dy: p.made.align.dy, n: p.made.align.n, warn: p.made.align.warn } },
      a: picture(p.view?.a), b: picture(p.view?.b), diff: p.view?.diff ?? null,
      stars: p.view ? [[9, -6], [-11, 8], [4, 13], [-7, -12], [14, 5], [0, 0]].map(([e, n]) => [brightest(p.view.a, 22 - e, 22 + n), brightest(p.view.b, 22 - e, 22 + n)]) : [],
    };
  });
}

/** Wait until the page has finished with the position: pictures and no more loading, or a message. @param {import('@playwright/test').Page} page @param {number} [timeout] */
async function settled(page, timeout = 30000) {
  await expect.poll(async () => (await read(page)).timing.done, { timeout }).toBe(true);
  return read(page);
}

/** The message of the page: its state, its words and the next steps it offers. @param {import('@playwright/test').Page} page */
function message(page) {
  return page.locator('#plan .state').evaluate((e) => ({
    state: /** @type {HTMLElement} */ (e).dataset.state, hidden: /** @type {HTMLElement} */ (e).hidden, title: e.querySelector('.state-title')?.textContent ?? '',
    next: e.querySelector('.state-next')?.textContent ?? '', steps: [...e.querySelectorAll('.state-actions > *')].map((s) => s.textContent),
  }));
}

test('a typed position shows two visits at one colour, lined up, with a plan before and progress while it loads', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL), field = makeField(), asked = await serveArchive(page, field);
  await page.goto('view.html?q=10h00m00s%20%2B20d00m00s');
  // what was typed is read, and the address is rewritten to the position
  await expect(page).toHaveURL(/\/view\.html\?ra=150&dec=20$/);
  await expect(page.locator('#lookup [data-where="centre"]')).toContainText('150.0000° +20.0000°');
  // the plan: visits, photos, megabytes, seconds
  const mb = (8 * bytesPerFrame() / 1e6).toFixed(1).replace(/\.0$/, '');
  await expect(page.locator('#plan .plan-summary')).toHaveText(new RegExp(`^2 visits · 8 photos · ${mb} MB · about \\d+ seconds$`));
  const now = await settled(page);
  expect(now.timing.state).toBe('ok');
  expect([now.pairs, now.choices, now.made.pairs, now.made.size]).toEqual([4, 5, 4, 44]);
  await expect(page.locator('#plan .plan-progress')).toBeHidden();
  await expect(page.locator('#plan .state')).toBeHidden();

  // the two visits, each four photos added up, on one grid: north up, 44 pixels, every pixel shown
  expect(now.panels).toHaveLength(1);
  expect([now.panels[0].w, now.panels[0].h, now.a.photos, now.b.photos]).toEqual([44, 44, 4, 4]);
  expect(now.made.shown).toBe(44 * 44);
  await expect(page.locator('#stage .stage-caption')).toContainText('4 photos added up');
  await expect(page.locator('#stage .stage-compass')).toHaveAttribute('data-north', '0');
  // the detector was turned by 147 degrees between the visits, and every star is on the same pixel in both:
  // where the sky has it, east to the left and north up
  for (const [i, s] of STARS.entries()) {
    expect(now.stars[i][0], `earlier visit, star ${i}`).toEqual([22 - s.east, 22 + s.north]);
    expect(now.stars[i][1], `later visit, star ${i}`).toEqual([22 - s.east, 22 + s.north]);
  }
  // the page measured that itself, on the stars
  expect(Math.hypot(now.made.align.dx, now.made.align.dy)).toBeLessThan(0.15);
  expect(now.made.align.n).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#stage .stage-note')).toHaveText(/^Photos aligned to 0\.[01]\d px \([3-6] stars\)\.$/);

  // Blink plays; the Difference view is there, switched off, and says why, with the check behind it
  expect([now.mode, now.playing]).toEqual(['blink', true]);
  const difference = page.locator('#stage').getByRole('button', { name: 'Difference', exact: true });
  await expect(difference).toBeDisabled();
  await expect(page.locator('#stage .stage-diff-off')).toContainText('At this pixel size a steady star leaves a dark and bright pair in a difference, so the difference is shown only on the checked examples.');
  await expect(page.locator('#stage .stage-diff-off a')).toHaveAttribute('href', 'checks.html#K8');
  await page.keyboard.press('d');
  expect((await read(page)).mode).toBe('blink');
  expect(now.diff).toBeNull();

  // the pairs can be stepped through one by one: the photos as they are, on the same grid
  const choices = page.locator('#colours .view-choice');
  await expect(choices).toHaveCount(5);
  await expect(choices.first()).toContainText('All colours together');
  await choices.nth(1).click();
  const one = await read(page);
  expect([one.a.photos, one.a.w, one.b.photos, one.b.w]).toEqual([1, 44, 1, 44]);
  // one photo of the earlier visit and the photo of the later visit taken at its colour: the n-th of each
  const first = field.frames.findIndex((f) => f.key === one.a.key);
  expect(first % 2).toBe(0);
  expect(one.b.key).toBe(field.frames[first + 1].key);
  await expect(page.locator('#stage .stage-caption')).toContainText('UTC');
  await choices.first().click();

  // the reader asked the archive for nothing but byte ranges of the eight photos, and every answer was used
  expect(new Set(asked.map((r) => r.url.split('/').pop())).size).toBe(8);
  expect(asked.every((r) => r.status === 206)).toBe(true);
  // each photo's first bytes were read twice: once by the reader, once for the sky of its stamp
  expect(asked.filter((r) => r.start === 0).length).toBe(16);
  expect(problems).toEqual([]);
});

test('the menu: copy link carries the whole view, copy embed code shows the stage alone, and the photos used are listed with their bucket links', async ({ page, context, baseURL }) => {
  const field = makeField();
  await serveArchive(page, field);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('view.html?ra=150&dec=20&mode=side');
  await settled(page);
  const share = page.locator('#share');
  await expect(share.locator('.share-panel')).toBeHidden();
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.locator('.share-panel')).toBeVisible();

  await share.getByRole('button', { name: 'Copy link' }).click();
  await expect(share.locator('.share-status')).toContainText('Link copied');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(new URL(`view.html?ra=150&dec=20&mode=side&a=${VISIT_IDS[0]}&b=${VISIT_IDS[1]}`, baseURL).href);

  await share.getByRole('button', { name: 'Copy embed code' }).click();
  await expect(share.locator('.share-status')).toContainText('Embed code copied');
  const code = await page.evaluate(() => navigator.clipboard.readText());
  expect(code).toMatch(/^<iframe src="[^"]+" width="480" height="720" style="border:0;max-width:100%" loading="lazy" title="[^"]+"><\/iframe>$/);
  const src = /** @type {RegExpExecArray} */ (/src="([^"]+)"/.exec(code))[1].replace(/&amp;/g, '&');
  expect(src).toBe(`${link}&embed=1`);

  // the photos of the view: four of each visit, each a link into the bucket
  await share.locator('.share-photos summary').click();
  await expect(share.locator('.share-photos summary')).toHaveText('Photos used (8)');
  const photos = await share.locator('.share-photo-list li').evaluateAll((list) => list.map((li) => ({ side: /** @type {HTMLElement} */ (li).dataset.side, href: li.querySelector('a')?.getAttribute('href'), text: li.textContent })));
  expect(photos.map((p) => p.side)).toEqual(['earlier', 'earlier', 'earlier', 'earlier', 'later', 'later', 'later', 'later']);
  expect(photos.map((p) => p.href).sort()).toEqual(field.frames.map((f) => BUCKET_URLS[0] + f.key).sort());
  expect(photos[0].text).toMatch(/^Earlier visit, 1\d Aug 2025, 00:00 UTC, 1\.\d{3} µm level2_2025W30_1A_0100_1D2_spx_l2b-v1-2026-001\.fits$/);
  await page.keyboard.press('Escape');
  await expect(share.locator('.share-panel')).toBeHidden();

  // the link opens the same view; the embed address shows the stage alone, with a link back
  await page.goto(src);
  await settled(page);
  for (const hidden of ['.masthead', '.colophon', '#visits', '#colours', '#share', '#view-ranges', '#frame-map', '#reading']) await expect(page.locator(hidden)).toBeHidden();
  await expect(page.locator('#stage .stage-panel')).toHaveCount(2);
  await expect(page.locator('#view-back')).toBeVisible();
  await expect(page.locator('#view-back')).toHaveAttribute('href', `view.html?ra=150&dec=20&mode=side&a=${VISIT_IDS[0]}&b=${VISIT_IDS[1]}`);
});

test('names: this site\'s own list, a fast star\'s old position, the name service of the CDS, and what it says when a name is not known', { tag: '@input' }, async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  const barnard = NAMES.entries.find((/** @type {{id: string}} */ e) => e.id === 'barnard');
  // a named target opens in the detector of its prepared view: for this star, detector 6
  const field = makeField({ ra: Number(barnard.ra.toFixed(6)), dec: Number(barnard.dec.toFixed(6)), det: 6, pairs: 2 });
  await serveArchive(page, field);

  // a name of the list: the title, what the list says about it, the position and the detector in the address
  await page.goto("view.html?q=Barnard's%20Star");
  await expect(page).toHaveURL(new RegExp(`/view\\.html\\?ra=${barnard.ra.toFixed(6)}&dec=${barnard.dec.toFixed(6)}&det=6$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^barnard.s star$/i);
  await expect(page.locator('#view-named')).toContainText('The fastest star in the sky');
  await expect(page.locator('#view-named a')).toHaveAttribute('href', 'view.html?t=barnard');
  let now = await settled(page);
  expect(now.made.pairs).toBe(2);
  // the ticks are worked out once the catalogue of fast stars has been read, which can come a moment after the pictures
  await expect.poll(async () => (now = await settled(page)).a.marks.length, { message: 'the ticks of the star are drawn' }).toBeGreaterThan(0);
  // the ticks beside the star: where its catalogue motion puts it on the date of each picture, within a pixel of the middle
  expect(now.a.marks.map((/** @type {{name: string}} */ m) => m.name)).toEqual(["Barnard's Star"]);
  for (const m of [...now.a.marks, ...now.b.marks]) expect(Math.hypot(m.x - 22, m.y - 22)).toBeLessThan(1);
  expect(now.b.marks[0].y - now.a.marks[0].y, 'between the visits the star moved north by most of a pixel').toBeGreaterThan(0.5);
  await expect(page.locator('#stage .stage-legend')).toContainText("ticks: where Barnard's Star should be on the date of this picture");
  await expect(page.locator('#stage .stage-marks')).toHaveAttribute('d', /^M[\d.]+ [\d.]+H[\d.]+M[\d.]+ [\d.]+V[\d.]+$/);

  // the star's position in a catalogue of 2000: the view moves to where the star is now, says so, and links back
  await page.goto('view.html?q=17h57m48.5s%20%2B04d41m36s');
  await expect(page.locator('#view-named')).toContainText("This looks like Barnard's Star, which has moved about 4.5 arcmin since 2000. The view is centred on where the star is now.");
  await expect(page).toHaveURL(new RegExp(`/view\\.html\\?ra=${barnard.ra.toFixed(6)}&dec=${barnard.dec.toFixed(6)}&det=6$`));
  // the title keeps saying the position that was typed, and so does the box; the star is named in the line under it
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('269.4521° +4.6933°');
  await expect(page).toHaveTitle(/^269\.4521° \+4\.6933° · /);
  await expect(page.locator('#where')).toHaveValue('17h57m48.5s +04d41m36s');
  now = await settled(page);
  expect(now.made.pairs).toBe(2);
  const back = page.locator('#view-named a');
  await expect(back).toHaveText('Show the position as typed');
  await expect(back).toHaveAttribute('href', 'view.html?ra=269.452083&dec=4.693333#as-typed');
  // the position as typed is taken as it stands: it is not moved again
  await back.click();
  await expect(page).toHaveURL(/\/view\.html\?ra=269\.452083&dec=4\.693333#as-typed$/);
  await expect(page.locator('#view-named')).toContainText("This is the position as typed. Barnard's Star was near here in the past and is now 4.5 arcmin away.");
  await expect(page.locator('#view-named a')).toHaveText("Go to Barnard's Star");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('269.4521° +4.6933°');
  expect((await settled(page)).timing.state).toBe('no-coverage');
  // the same position in the address, without the mark, is moved to the star: this is how the first page sends it
  await page.goto('view.html?ra=269.452083&dec=4.693333');
  await expect(page).toHaveURL(new RegExp(`/view\\.html\\?ra=${barnard.ra.toFixed(6)}&dec=${barnard.dec.toFixed(6)}&det=6$`));

  // another name: the name service of the CDS is asked, by its own address, with the name and nothing else
  /** @type {string[]} */
  const sesame = [];
  let answer = "# Vega\t#Q1\n#=Sc=Simbad (CDS, via client/server):    1     0ms (from cache)\n%J 279.23473479 +38.78368896 = 18 36 56.336  +38 47 01.28 \n%P 200.94 286.23 [0.32 0.40 0] A 2007A&A...474..653V\n%X 130.23 [0.36] A 2007A&A...474..653V\n";
  await page.route((url) => /nph-sesame/.test(url.pathname), (route) => {
    sesame.push(route.request().url());
    if (answer === 'down') return route.abort('failed');
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }, body: answer });
  });
  const others = problems.length;
  await page.goto('view.html?q=Vega');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^vega$/i);
  await expect(page).toHaveURL(/\/view\.html\?ra=279\.236\d+&dec=38\.785\d+$/);
  await expect(page.locator('#view-named')).toHaveText('Position from the name service of the CDS (SIMBAD). It gives where the star was in 2000. The star has moved 9 arcsec since, and the view is centred on where it is now.');
  expect(sesame).toEqual(['https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-o/SN?Vega']);
  expect((await settled(page)).timing.state).toBe('not-indexed');

  // the service does not know the name: the page says so and asks for coordinates
  answer = '# Qwertyuiop\t#Q2\n#! *** Nothing found *** \n';
  await page.goto('view.html?q=Qwertyuiop');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-name');
  let said = await message(page);
  expect(said.title).toBe("The name “Qwertyuiop” is not in this site's own list, and the name service of the CDS does not know it either.");
  expect(said.next).toBe('Type its coordinates instead: right ascension, then declination, in degrees or in hours, minutes and seconds.');
  expect(said.steps).toEqual(['Type a position', 'Prepared targets']);
  // the service cannot be reached: the same, in its own words; a name close to one of the list is offered
  answer = 'down';
  await page.goto('view.html?q=Barnards%20Sta');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-name');
  said = await message(page);
  expect(said.title).toBe("The name “Barnards Sta” is not in this site's own list, and the name service that knows other names cannot be reached right now.");
  expect(said.steps).toEqual(["Barnard's Star", 'Type a position', 'Prepared targets']);
  await expect(page.locator('#plan .state a').first()).toHaveAttribute('href', 'view.html?q=Barnard%27s+Star');
  // text that is neither a position nor a name is not sent anywhere
  const sent = sesame.length;
  await page.goto('view.html?q=12%2034%2056');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-position');
  expect((await message(page)).title).toBe('That does not read as a sky position or as a name.');
  expect(sesame.length).toBe(sent);
  expect(problems.slice(others).filter((p) => !/nph-sesame/.test(p))).toEqual([]);
  expect(problems.slice(0, others)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// When it cannot: every failure has its message and a next step
// ---------------------------------------------------------------------------------------------

/** A message is complete when it says what happened, what to do, and offers a step that can be taken. @param {Awaited<ReturnType<typeof message>>} said @param {string} state */
function expectState(said, state) {
  const text = STATE_TEXT[/** @type {keyof typeof STATE_TEXT} */ (state)];
  expect(said.state).toBe(state);
  expect(said.hidden).toBe(false);
  expect(said.title).toBe(text.title);
  expect(said.next).toBe(text.next);
  expect(said.steps.length).toBe(text.actions.length);
}

for (const [name, mode] of /** @type {const} */ ([['the bucket is blocked', 'blocked'], ['the bucket answers 503', 503], ['the bucket answers 403', 403], ['the browser is offline', 'offline']])) {
  test(`${name}: the page says that the archive cannot be reached, and "Try again" works once it can`, { tag: '@fault' }, async ({ page, baseURL }) => {
    test.setTimeout(90000);
    const problems = watch(page, baseURL), field = makeField({ pairs: 2 });
    /** @type {'ok' | 'blocked' | 'offline' | 503 | 403} */
    let bucket = mode;
    const asked = await serveArchive(page, field, { bucket: () => bucket });
    await page.goto('view.html?ra=150&dec=20');
    const now = await settled(page, 60000);
    expect(now.timing.state).toBe('unreachable');
    expectState(await message(page), 'unreachable');
    expect((await message(page)).steps).toEqual(['Try again', 'Prepared targets']);
    await expect(page.locator('#stage')).toBeHidden();
    await expect(page.locator('#lookup [data-where="centre"]')).toContainText('150.0000° +20.0000°');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => r.status !== 206)).toBe(true);
    // the archive is back: the same page loads the pictures
    bucket = 'ok';
    await page.locator('#plan .state').getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('#stage .stage-panel')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#plan .state')).toBeHidden();
    expect((await settled(page)).made.pairs).toBe(2);
    expect(problems).toEqual([]);
  });
}

test('the archive fails in the middle of loading: what has arrived stays, with the message beside it', { tag: '@fault' }, async ({ page }) => {
  const field = makeField({ pairs: 3 });
  // the headers are answered, and so are the rows of the two photos asked for first: the first pair, which is
  // loaded alone. The rows of every other photo are refused
  /** @type {string[]} */
  const first = [];
  const asked = await serveArchive(page, field, { bucket: (key, start) => {
    if (start < DATA_AT) return 'ok';
    if (!first.includes(key) && first.length < 2) first.push(key);
    return first.includes(key) ? 'ok' : 503;
  } });
  await page.goto('view.html?ra=150&dec=20');
  const now = await settled(page, 60000);
  expect([now.timing.state, now.pairs]).toEqual(['unreachable', 1]);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expectState(await message(page), 'unreachable');
  expect((await message(page)).steps).toEqual(['Try again', 'Prepared targets']);
  expect(asked.some((r) => r.status === 503)).toBe(true);
  // the plan stays, with what it had promised
  await expect(page.locator('#plan .plan-summary')).toHaveText(/^2 visits · 6 photos · /);
});

test('a link of 400 kbit/s: the plan says so, the first pair shows alone, and the rest waits for "Load more (N MB)"', { tag: '@fault' }, async ({ page }) => {
  test.setTimeout(120000);
  const field = makeField({ pairs: 3 });
  // 400 kbit/s is 50 kB a second; a request on such a link waits about a second and a half before its first byte
  await serveArchive(page, field, { link: { bytesPerSecond: 50000, latencyMs: 1500 } });
  await page.goto('view.html?ra=150&dec=20');
  // judged slow from the first request: the plan is for the first pair only
  await expect(page.locator('#plan .plan-summary')).toHaveText(/^2 visits · 2 photos · 1\.8 MB · about \d+ seconds$/, { timeout: 60000 });
  const now = await settled(page, 100000);
  // the first pair came in time, or it did not and the page says that the archive is slow: either way it says what to do
  if (now.timing.state === 'slow') {
    expectState(await message(page), 'slow');
    expect((await message(page)).steps).toEqual(['Try again']);
  } else {
    expect([now.timing.state, now.pairs, now.timing.held]).toEqual(['ok', 1, true]);
    await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
    const more = page.locator('#plan .plan-button');
    await expect(more).toHaveText('Load more (3.7 MB)');
    expect(now.timing.firstPairMs).toBeLessThan(60000);
  }
});

test('a link that turns out slow while the first pair loads: the pair shows alone, and the rest loads when "Load more (N MB)" is pressed', { tag: '@fault' }, async ({ page }) => {
  test.setTimeout(120000);
  const field = makeField({ pairs: 3 });
  // 800 kbit/s with a short wait: the first request is quick, so the plan is for every pair; the first pair then takes more than 8 seconds
  const link = { bytesPerSecond: 100000, latencyMs: 100 };
  await serveArchive(page, field, { link });
  await page.goto('view.html?ra=150&dec=20');
  await expect(page.locator('#plan .plan-summary')).toHaveText(/^2 visits · 6 photos · 5\.5 MB · about \d+ seconds$/, { timeout: 30000 });
  const now = await settled(page, 90000);
  expect([now.timing.state, now.pairs, now.timing.held]).toEqual(['ok', 1, true]);
  expect(now.timing.firstPairMs).toBeGreaterThan(8000);
  const more = page.locator('#plan .plan-button');
  await expect(more).toHaveText('Load more (3.7 MB)');
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  // the link is quick again: the rest arrives when it is asked for
  link.bytesPerSecond = 1e9;
  link.latencyMs = 0;
  await more.click();
  await expect.poll(async () => (await read(page)).pairs, { timeout: 30000 }).toBe(3);
  const all = await settled(page);
  expect([all.timing.state, all.timing.held, all.made.pairs]).toEqual(['ok', false, 3]);
  await expect(more).toBeHidden();
});

test('one pair that stalls on a quick link: what the reader holds back is asked for again at once, and every pair arrives', { tag: '@fault' }, async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const problems = watch(page, baseURL), field = makeField({ pairs: 3 });
  // The first pair is loaded alone and arrives at once. Of the two pairs asked for together after it, the photos of
  // the first pass through a link of 800 kbit/s and take more than 8 seconds; the other pair arrives at once. The
  // reader then keeps its first pair and holds the other back, as it does on a slow link.
  /** @type {string[]} The photos in the order their rows were first asked for. */
  const order = [];
  await serveArchive(page, field, { link: (key, start) => {
    if (start < DATA_AT) return null; // a header
    if (!order.includes(key)) order.push(key);
    return order.indexOf(key) === 2 || order.indexOf(key) === 3 ? { bytesPerSecond: 100000, latencyMs: 0 } : null;
  } });
  await page.goto('view.html?ra=150&dec=20');
  await expect(page.locator('#plan .plan-summary')).toHaveText(/^2 visits · 6 photos · 5\.5 MB · about \d+ seconds$/);
  const now = await settled(page, 60000);
  // the page timed the first pair itself and found the link quick: nothing waits behind "Load more"
  expect(now.timing.firstPairMs).toBeLessThan(8000);
  expect([now.timing.state, now.pairs, now.made.pairs, now.timing.held, now.timing.askedAgain]).toEqual(['ok', 3, 3, false, true]);
  expect(now.timing.fullMs).toBeGreaterThan(8000);
  await expect(page.locator('#plan .plan-button')).toBeHidden();
  await expect(page.locator('#colours .view-choice')).toHaveCount(4);
  expect(problems).toEqual([]);
});

test('a position with no photos, and a part of the sky that is not listed: each has its message', { tag: '@fault' }, async ({ page, baseURL }) => {
  const problems = watch(page, baseURL), field = makeField({ pairs: 3 });
  await serveArchive(page, field);
  // a position some degrees away, in the same tile of the index: no photo holds it
  const away = [field.ra - 4, field.dec + 3.5];
  expect(tileOf(away[0], away[1], REAL_META)).toBe(field.tile);
  await page.goto(`view.html?ra=${away[0]}&dec=${away[1]}`);
  expect((await settled(page)).timing.state).toBe('no-coverage');
  expectState(await message(page), 'no-coverage');
  expect((await message(page)).steps).toEqual(['Type another position', 'Prepared targets']);
  await expect(page.locator('#stage')).toBeHidden();
  // the six ranges of colour stay: another range may have photos here
  await expect(page.locator('#view-ranges .view-range')).toHaveCount(6);
  await expect(page.locator('#view-ranges .view-range[aria-pressed="true"]')).toHaveAttribute('data-det', '2');
  await page.locator('#view-ranges .view-range[data-det="4"]').click();
  await expect(page).toHaveURL(/&det=4$/);
  expect((await settled(page)).timing.state).toBe('no-coverage');

  // a tile that the index does not list as finished
  await page.goto('view.html?ra=10&dec=-40');
  expect((await settled(page)).timing.state).toBe('not-indexed');
  expectState(await message(page), 'not-indexed');
  expect(problems).toEqual([]);
});

test('a position that SPHEREx has photographed during one visit only says so', { tag: '@fault' }, async ({ page }) => {
  await serveArchive(page, makeField({ pairs: 4, visits: 1 }));
  await page.goto('view.html?ra=150&dec=20');
  expect((await settled(page)).timing.state).toBe('one-visit');
  expectState(await message(page), 'one-visit');
  await expect(page.locator('#stage')).toBeHidden();
});

test('a saturated star: the pictures show where it is, hatched, and the page says that its brightness cannot be compared', { tag: '@fault' }, async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await serveArchive(page, makeField({ pairs: 3, saturated: true }));
  await page.goto('view.html?ra=150&dec=20');
  const now = await settled(page);
  expect(now.timing.state).toBe('too-bright');
  expect(now.made.signs.tooBright).toBe(true);
  expectState(await message(page), 'too-bright');
  // the pictures stay, and the heart of the star is hatched as too bright in both
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  const hatched = await page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const p = m.viewParts().stage.readback().panels[0];
    return { middle: p.saturated[22 * 44 + 22], count: p.saturated.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + v, 0) };
  });
  expect(hatched.middle).toBe(1);
  expect(hatched.count).toBeGreaterThanOrEqual(5);
  expect(hatched.count).toBeLessThan(40);
  await expect(page.locator('#stage .stage-legend')).toContainText('saturated: too bright to measure');
  expect(problems).toEqual([]);
});

test('an empty patch of sky: the pictures are shown, and the page says that nothing stands out there', { tag: '@fault' }, async ({ page }) => {
  await serveArchive(page, makeField({ pairs: 3, stars: [] }));
  await page.goto('view.html?ra=150&dec=20');
  const now = await settled(page);
  expect(now.timing.state).toBe('too-faint');
  expectState(await message(page), 'too-faint');
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await expect(page.locator('#stage .stage-note')).toHaveText('No star in this patch is bright enough to check how well the two visits line up.');
});

// ---------------------------------------------------------------------------------------------
// The parts beside the stage, a small window, and a page without a reader
// ---------------------------------------------------------------------------------------------

test('a click on the stage reaches the panels: the place, and what every loaded photo has there', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL), field = makeField({ pairs: 3 });
  await serveArchive(page, field);
  await page.goto('view.html?ra=150&dec=20');
  await settled(page);
  // the frame map lists the photos of the position, and the ones on the stage are loaded
  await expect(page.locator('#frame-map')).toContainText('6 photos cover this position');
  await expect(page.locator('#frame-map')).toContainText('6 loaded');
  // click the star 4 pixels east and 13 north of the target
  await page.evaluate(async () => { const m = await import(new URL('js/pages/view.js', document.baseURI).href); m.viewParts().stage.pause(); });
  const canvas = page.locator('#stage .stage-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
  const [x, y] = [22 - 4, 22 + 13];
  await page.mouse.click(box.x + (x + 0.5) * box.width / 44, box.y + (44 - 1 - y + 0.5) * box.height / 44);
  await expect(page.locator('#is-it-real')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#is-it-real')).toContainText('For the place you clicked.');
  // the readout names the same pixel, with its sky position and the colour of the photos behind it
  const out = await page.locator('#stage .hover').evaluate((e) => ({ .../** @type {HTMLElement} */ (e).dataset }));
  expect([out.x, out.y]).toEqual([String(x), String(y)]);
  expect(Math.abs(Number(out.dec) - (20 + 13 * P)) * 3600).toBeLessThan(0.5);
  expect(Math.abs((Number(out.ra) - 150) * Math.cos(20 * Math.PI / 180) - 4 * P) * 3600).toBeLessThan(0.5);
  expect(Number(out.lam)).toBeGreaterThan(1.09);
  expect(Number(out.lam)).toBeLessThan(1.67);
  expect(problems).toEqual([]);
});

test('the page fits a window 360 px wide with a typed position open', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await serveArchive(page, makeField({ pairs: 2 }));
  await page.goto('view.html?ra=150&dec=20');
  await settled(page);
  await page.locator('#share').getByRole('button', { name: 'Share' }).click();
  await page.locator('#share .share-photos summary').click();
  const fit = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
    over: [...document.querySelectorAll('main *')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0 && (e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 || e.getBoundingClientRect().left < -0.5)).map((e) => `${e.tagName}.${e.className}`),
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.over).toEqual([]);
  // seven screen pixels to a pixel of the picture
  expect((await read(page)).panels[0].w).toBe(44);
  expect(await page.locator('#stage .stage-canvas').evaluate((c) => c.getBoundingClientRect().width)).toBe(308);
});

test('a page that asks for no reader has none: a typed position says so, and a reader handed in later is used', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  /** @type {string[]} */
  const outside = [];
  page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(/** @type {string} */ (baseURL)).origin) outside.push(r.url()); });
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html?ra=150&dec=20');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-not-connected');
  await expect(page.locator('#plan .state')).toContainText('The prepared targets work.');
  await expect(page.locator('#lookup [data-where="centre"]')).toContainText('150.0000° +20.0000°');
  // a reader that answers with a state
  await page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    m.connectClient({ plan: async () => ({ state: 'one-visit' }), load: async () => [] });
  });
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'one-visit');
  expect(outside).toEqual([]);
  expect(problems).toEqual([]);
});
