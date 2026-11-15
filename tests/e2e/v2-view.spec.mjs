// The viewer page in a real browser: a showcase given by ?t=<id> from the fixtures, the visit strip and the
// address, the plan and the progress of a typed position through a stand-in client, every state of CT-12 from an
// injected state, the embed, the keys and a window 360 px wide.
import { test, expect } from '@playwright/test';
import { BUCKET_HOSTS, FAILURE_STATES } from '../../site/js/contracts.js';
import { STATE_TEXT } from '../../site/js/ui/states.js';
import { fixturePath, readJson, readFloat32, readInt32 } from '../helpers/fixtures.mjs';

const ID = 'barnard-d5';
const manifest = readJson('showcase', ID, 'manifest.json');
const W = manifest.w, H = manifest.h, N = W * H;
const fileData = readFloat32('showcase', ID, 'stamps.bin'), fileFlags = readInt32('showcase', ID, 'flags.bin');
const display = readJson('v2', 'display.json'), sky = readJson('v2', 'sky.json').frames;
const NONE = [59, 53, 33]; // --color-line, the colour of a pixel without a value

/** The bits of the values of frame i in the file. @param {number} i */
const fileBits = (i) => Array.from(new Uint32Array(fileData.buffer, fileData.byteOffset + i * N * 4, N));

/** The bytes a canvas must hold for side `k` of pair `p`, from numpy's greys, the top row first. @param {number} p @param {number} k */
function wantRgba(p, k) {
  const i = display.pairs[p].frames[k], grey = Buffer.from(display.pairs[p].grey[k], 'base64');
  const out = new Array(N * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = ((H - 1 - y) * W + x) * 4, g = grey[y * W + x], c = Number.isFinite(fileData[i * N + y * W + x]) ? [g, g, g] : NONE;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Serve the showcase of the fixtures as a target of the site, under `id`, with the manifest changed if wished.
 * @param {import('@playwright/test').Page} page @param {string} [id] @param {(m: any) => any} [change]
 */
async function serveShowcase(page, id = ID, change) {
  await page.route(`**/data/targets/${id}/*`, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    if (name === 'card.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id, name: manifest.name ?? "Barnard's Star", kind: 'mover' }) });
    if (name === 'manifest.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(change ? change(structuredClone(manifest)) : { ...manifest, id }) });
    return route.fulfill({ path: fixturePath('showcase', ID, name) });
  });
}

/** What goes wrong on a page: console errors, page errors, failed requests, requests to other hosts. @param {import('@playwright/test').Page} page @param {string | undefined} baseURL */
function watch(page, baseURL) {
  const origin = new URL(/** @type {string} */ (baseURL)).origin;
  /** @type {string[]} */
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()}`));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.origin !== origin && !BUCKET_HOSTS.includes(u.host) && u.protocol !== 'data:') problems.push(`request to another host: ${r.url()}`); });
  return problems;
}

/** What the stage of the page shows now. @param {import('@playwright/test').Page} page @returns {Promise<any>} */
function read(page) {
  return page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const parts = m.viewParts(), rb = parts.stage.readback();
    const bits = (/** @type {Float32Array} */ v) => Array.from(new Uint32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    return {
      mode: rb.mode, side: rb.side, playing: rb.playing, flips: rb.flips, limits: rb.limits, address: parts.address, chosen: parts.chosen,
      pairs: parts.pairs.length, choices: parts.choices.length,
      panels: rb.panels.map((/** @type {any} */ p) => ({ kind: p.kind, rgba: Array.from(p.rgba), bits: bits(p.values), cssWidth: p.cssWidth, caption: p.caption })),
    };
  });
}

/** Run something with the module of the page. @param {import('@playwright/test').Page} page @param {string} body  The body of an async function of (m, arg). @param {unknown} [arg] */
function withView(page, body, arg) {
  return page.evaluate(async ({ body: text, arg: value }) => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    return new (Object.getPrototypeOf(async () => {}).constructor)('m', 'arg', text)(m, value);
  }, { body, arg });
}

/** Wait until the page has handled the pointer: the readout names the pixel. @param {import('@playwright/test').Page} page @param {number} x @param {number} y */
async function pointed(page, x, y) {
  await expect(page.locator('#stage .hover')).toHaveAttribute('data-x', String(x));
  await expect(page.locator('#stage .hover')).toHaveAttribute('data-y', String(y));
}

/** Stop the blink of the page on the earlier visit, however far it has played. @param {import('@playwright/test').Page} page */
async function holdEarlier(page) {
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await withView(page, 'm.viewParts().stage.step("a")');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  expect((await read(page)).playing).toBe(false);
}

test('view.html?t=<id> shows the showcase: its name, its two visits, one colour at a time, the values of the files', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^barnard.s star$/i);
  await expect(page).toHaveTitle(/^Barnard.s Star · Viewer · /);
  await expect(page.locator('#lookup [data-where="centre"]')).toContainText('269.4464° +4.7671°');
  await expect(page.locator('#view-where')).toContainText('3.80–4.44');
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);

  // it opens in Blink, playing, with the first matched pair: frames 0 and 2 of the showcase
  let now = await read(page);
  expect([now.mode, now.playing, now.pairs, now.choices, now.chosen]).toEqual(['blink', true, 2, 2, 0]);
  await page.locator('#stage .stage-play').click(); // pause, to look at one side at a time
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  now = await read(page);
  expect(now.panels[0].bits, 'the earlier visit is frame 0 of the file, bit for bit').toEqual(fileBits(0));
  expect(now.panels[0].rgba, 'drawn with the greys numpy gives').toEqual(wantRgba(0, 0));
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).side).toBe('b');
  now = await read(page);
  expect(now.panels[0].bits).toEqual(fileBits(2));
  expect(now.panels[0].rgba).toEqual(wantRgba(0, 1));
  await expect(page.locator('#stage .stage-caption')).toContainText('Later visit');
  await expect(page.locator('#stage .stage-caption')).toContainText('15 Mar 2026, 00:51 UTC');
  await expect(page.locator('#stage .stage-match')).toHaveText(/^Same colour: the two pictures are 0\.0006 µm apart/);

  // the visit strip: one tile for each visit, with its date and the colours of its photos
  const tiles = page.locator('#visits .visit-tile');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0).locator('.visit-date')).toHaveText('25 Aug 2025');
  await expect(tiles.nth(1).locator('.visit-date')).toHaveText('15 Mar 2026');
  await expect(tiles.nth(0).locator('.visit-role')).toHaveText('Earlier visit');
  await expect(tiles.nth(1).locator('.visit-role')).toHaveText('Later visit');
  await expect(tiles.nth(0)).toHaveAttribute('aria-pressed', 'true');
  expect(await tiles.nth(0).locator('.colour-chip').allTextContents()).toEqual(['4.296 µm', '4.370 µm']);
  expect(await tiles.nth(1).locator('.colour-chip').allTextContents()).toEqual(['4.296 µm', '4.370 µm']);
  await expect(tiles.nth(0).locator('.visit-photos')).toHaveText('2 photos');
  await expect(tiles.nth(0)).toHaveAttribute('data-short', 'false');

  // the other colour: frames 1 and 3, with their own black and white points
  const choices = page.locator('#colours .view-choice');
  await expect(choices).toHaveCount(2);
  expect(await choices.allTextContents()).toEqual(['4.296 µm', '4.370 µm']);
  await expect(choices.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await choices.nth(1).click();
  await expect(choices.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#stage .stage-play'), 'a blink the visitor stopped stays stopped when the picture changes').toHaveText('PLAY');
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  now = await read(page);
  expect(now.panels[0].bits).toEqual(fileBits(1));
  expect(now.panels[0].rgba).toEqual(wantRgba(1, 0));
  expect(now.limits.lo).toBeCloseTo(display.pairs[1].lo, 9);
  expect(now.limits.hi).toBeCloseTo(display.pairs[1].hi, 9);

  // the colour ruler: six spans from the tables of the site, and the two colours of the pair marked on it
  const ruler = page.locator('#colours .ruler');
  await expect(ruler.locator('.ruler-span')).toHaveCount(6);
  const tables = await (await page.request.get('data/wave/tables.json')).json();
  const spans = await ruler.locator('.ruler-span').evaluateAll((list) => list.map((e) => [Number(/** @type {HTMLElement} */ (e).dataset.det), Number(/** @type {HTMLElement} */ (e).dataset.min), Number(/** @type {HTMLElement} */ (e).dataset.max)]));
  expect(spans).toEqual([1, 2, 3, 4, 5, 6].map((d) => [d, Math.min(...tables[d].lam.flat()), Math.max(...tables[d].lam.flat())]));
  expect(await ruler.locator('.ruler-mark').evaluateAll((list) => list.map((e) => Number(/** @type {HTMLElement} */ (e).dataset.lam)))).toEqual([manifest.frames[1].lam, manifest.frames[3].lam]);
  expect(await ruler.locator('.ruler-tick').allTextContents()).toEqual(['0.75', '2', '3', '4', '5 µm']);
  // a chip has the colour of its detector's span: the ruler is its key
  const colours = await page.evaluate(() => [getComputedStyle(/** @type {Element} */ (document.querySelector('#colours .ruler-span[data-det="5"]'))).backgroundColor, getComputedStyle(/** @type {Element} */ (document.querySelector('#stage .colour-chip-swatch'))).backgroundColor]);
  expect(colours).toEqual(['rgb(245, 154, 74)', 'rgb(245, 154, 74)']);
  // each span lies on the bar where its wavelengths are
  const geometry = await ruler.evaluate((r) => {
    const bar = /** @type {Element} */ (r.querySelector('.ruler-bar')).getBoundingClientRect();
    return [...r.querySelectorAll('.ruler-span')].map((s) => { const b = s.getBoundingClientRect(); return [(b.left - bar.left) / bar.width, (b.right - bar.left) / bar.width]; });
  });
  const lo = Math.min(0.75, spans[0][1]), hi = Math.max(5, spans[5][2]);
  for (const [i, [left, right]] of geometry.entries()) {
    expect(left).toBeCloseTo((spans[i][1] - lo) / (hi - lo), 3);
    expect(right).toBeCloseTo((spans[i][2] - lo) / (hi - lo), 3);
  }
  expect(problems).toEqual([]);
});

test('the readout on the page: value, flags, date, file and colour of the pixel under the pointer', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await page.locator('#stage .stage-play').click();
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  const canvas = page.locator('#stage .stage-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const ref = sky[manifest.frames[0].key];
  for (const p of ref.points) {
    const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
    await page.mouse.move(box.x + (p.x + 0.5) * box.width / W, box.y + (H - 1 - p.y + 0.5) * box.height / H);
    await pointed(page, p.x, p.y);
    const out = await page.locator('#stage .hover').evaluate((e) => ({ .../** @type {HTMLElement} */ (e).dataset, text: e.textContent }));
    const i = p.y * W + p.x;
    expect([out.kind, out.x, out.y]).toEqual(['a', String(p.x), String(p.y)]);
    expect(Number(out.value)).toBe(fileData[i]);
    expect(Number(out.word)).toBe(fileFlags[i]);
    expect(Number(out.mjd)).toBe(manifest.frames[0].mjd);
    expect(out.id).toBe('2025W35_1A_0146_1D5');
    expect(Math.abs(Number(out.lam) - p.lam)).toBeLessThan(1e-12);
    expect(out.text).toContain('25 Aug 2025, 17:09 UTC · 2025W35_1A_0146_1D5');
    // a showcase carries no sky transform: the readout says so instead of guessing
    expect(out.ra).toBeUndefined();
    expect(out.text).toContain('not known for this picture');
  }
  await expect(page.locator('#stage .stage-compass')).toHaveCount(0);
  await expect(page.locator('#stage .stage-scale-label')).toHaveText('60 arcsec');
});

test('what is handed in with the client reaches the stage: the sky of each frame, co-adds, a difference, the mask', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await expect(page.locator('#stage .stage-compass')).toHaveCount(0);
  // the sky transform of each frame (astropy, from its header), handed in after the showcase is already on the stage
  await page.evaluate(async (skyOf) => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const never = async () => ({ state: /** @type {const} */ ('cancelled') });
    m.connectClient({ plan: never, load: never }, { skyOf: (/** @type {{key: string}} */ stamp) => skyOf[stamp.key]?.sky ?? null });
    m.viewParts().stage.pause();
  }, sky);
  const compass = page.locator('#stage .stage-compass');
  await expect(compass).toHaveCount(1);
  await expect(compass, 'north points down in the earlier visit').toHaveAttribute('data-north', '181');
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowRight');
  await expect(compass, 'and up in the later one: the two visits are turned half a circle').toHaveAttribute('data-north', '1');
  // the readout now knows where on the sky the pointer is, as astropy computes it
  const canvas = page.locator('#stage .stage-canvas');
  await canvas.scrollIntoViewIfNeeded();
  for (const p of sky[manifest.frames[2].key].points) {
    const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
    await page.mouse.move(box.x + (p.x + 0.5) * box.width / W, box.y + (H - 1 - p.y + 0.5) * box.height / H);
    await pointed(page, p.x, p.y);
    const out = await page.locator('#stage .hover').evaluate((e) => ({ .../** @type {HTMLElement} */ (e).dataset }));
    expect([out.kind, out.x, out.y]).toEqual(['b', String(p.x), String(p.y)]);
    expect(3600 * Math.hypot((Number(out.ra) - p.ra) * Math.cos(p.dec * Math.PI / 180), Number(out.dec) - p.dec)).toBeLessThan(0.1);
    expect(Number(out.value)).toBe(fileData[2 * N + p.y * W + p.x]);
  }

  // all pairs as one view: what `compose` returns is what the stage draws, array for array
  const made = await page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const t = /** @type {any} */ (window).__made = {};
    const never = async () => ({ state: /** @type {const} */ ('cancelled') });
    m.connectClient({ plan: never, load: never }, {
      compose: (/** @type {any[][]} */ pairs) => {
        const [a, b] = pairs[0], n = a.w * a.h;
        t.a = { ...a, data: Float32Array.from(a.data, (v) => v - 0.25), flags: null, photos: pairs.length, key: '', x0: NaN, y0: NaN };
        t.b = { ...b, data: Float32Array.from(b.data, (v) => v - 0.4), flags: null, photos: pairs.length, key: '', x0: NaN, y0: NaN };
        t.matched = Uint8Array.from({ length: n }, (_, i) => (Math.floor(i / a.w) < 50 ? 1 : 0));
        t.diff = { w: a.w, h: a.h, data: Float32Array.from({ length: n }, (_, i) => ((i % 9) - 4) * 1.5), tx: a.tx, ty: a.ty, matched: t.matched };
        return { a: t.a, b: t.b, diff: t.diff, note: 'A note from whoever made the view.' };
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const parts = m.viewParts();
    parts.stage.setMode('diff');
    const rb = parts.stage.readback();
    return { choices: parts.choices.length, chosen: parts.chosen, kind: rb.panels[0].kind, isDiff: rb.panels[0].values === t.diff.data, veiled: rb.panels[0].veiled?.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + v, 0) };
  });
  expect(made).toEqual({ choices: 3, chosen: 0, kind: 'diff', isDiff: true, veiled: 14 * 64 });
  await expect(page.locator('#stage .stage-resampled')).toHaveText('resampled');
  await expect(page.locator('#stage .stage-note')).toHaveText('A note from whoever made the view.');
  await expect(page.locator('#stage .stage-legend')).toContainText('colours differ here');
  expect(await page.locator('#colours .view-choice').allTextContents()).toEqual(['All colours together 4.296 µm4.370 µm', '4.296 µm', '4.370 µm']);
  expect(new URL(page.url()).search).toBe(`?mode=diff&t=${ID}`);
  // back in Blink the co-adds are on the stage, and say how many photos they are made of
  await page.keyboard.press('d');
  const blink = await page.evaluate(async () => {
    const m = await import(new URL('js/pages/view.js', document.baseURI).href);
    const p = m.viewParts().stage.readback().panels[0], t = /** @type {any} */ (window).__made;
    return [p.kind, p.values === t.a.data || p.values === t.b.data, p.caption];
  });
  expect(blink.slice(0, 2)).toEqual([expect.stringMatching(/^[ab]$/), true]);
  expect(blink[2]).toContain('2 photos added up');
  // a single pair can still be looked at as it is
  await page.locator('#colours .view-choice').nth(1).click();
  await expect.poll(async () => { const r = await read(page); return r.panels[0].bits.length && (JSON.stringify(r.panels[0].bits) === JSON.stringify(fileBits(0)) || JSON.stringify(r.panels[0].bits) === JSON.stringify(fileBits(2))); }).toBe(true);
});

test('choosing two visits changes the address, and the address opens the same two visits', async ({ page }) => {
  // three visits from the frames of the fixture: the last frame as a visit of its own, 6.5 hours later is not one,
  // so it is moved a month on
  const three = (/** @type {any} */ m) => {
    m.id = 'three';
    m.frames[3].visit = 2;
    m.frames[3].mjd += 30;
    return m;
  };
  await serveShowcase(page, 'three', three);
  await page.goto('view.html?t=three');
  const tiles = page.locator('#visits .visit-tile');
  await expect(tiles).toHaveCount(3);
  expect(await tiles.locator('.visit-date').allTextContents()).toEqual(['25 Aug 2025', '15 Mar 2026', '14 Apr 2026']);
  await expect(page.locator('#visits .visits-hint')).toContainText('Choose two visits to compare');
  // it opens with the two visits farthest apart that share a colour: the first and the last
  expect(await tiles.evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['earlier', '', 'later']);
  expect(new URL(page.url()).search).toBe('?t=three');
  await expect.poll(async () => (await read(page)).pairs).toBe(1);
  await holdEarlier(page);
  expect((await read(page)).panels[0].bits).toEqual(fileBits(1));

  // choose the middle visit: it takes the place of the visit chosen longest ago
  await tiles.nth(1).click();
  expect(await tiles.evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['', 'earlier', 'later']);
  expect(new URL(page.url()).search).toBe('?a=2026-03-15&b=2026-04-14&t=three');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-pairs');
  await expect(page.locator('#plan .state')).toContainText('These two visits have no photos at the same colour.');
  await expect(page.locator('#stage')).toBeHidden();

  // then the first again: the first and the middle visit share the colour of frames 0 and 2
  await tiles.nth(0).click();
  expect(await tiles.evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['earlier', 'later', '']);
  expect(new URL(page.url()).search).toBe('?a=2025-08-25&b=2026-03-15&t=three');
  await expect(page.locator('#plan .state')).toBeHidden();
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expect((await read(page)).panels[0].bits).toEqual(fileBits(0));
  expect(await page.locator('#colours .view-choice').allTextContents()).toEqual(['4.296 µm']);

  // the address alone brings the same two visits back
  await page.goto('view.html?a=2025-08-25&b=2026-03-15&t=three');
  await expect(page.locator('#visits .visit-tile')).toHaveCount(3);
  expect(await page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['earlier', 'later', '']);
  await holdEarlier(page);
  expect((await read(page)).panels[0].bits).toEqual(fileBits(0));
  // names that fit no visit fall back to the two the showcase opens with
  await page.goto('view.html?a=1999-01-01&b=nonsense&t=three');
  await expect(page.locator('#visits .visit-tile')).toHaveCount(3);
  expect(await page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['earlier', '', 'later']);
});

test('the view is part of the address: it opens in the view named, and changing the view rewrites it', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}&mode=side`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(2);
  expect((await read(page)).mode).toBe('side');
  await expect(page.locator('#stage').getByRole('button', { name: 'Side by side', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#stage').getByRole('button', { name: 'Curtain', exact: true }).click();
  expect(new URL(page.url()).search).toBe(`?mode=curtain&t=${ID}`);
  await page.locator('#stage').getByRole('button', { name: 'Blink', exact: true }).click();
  expect(new URL(page.url()).search).toBe(`?mode=blink&t=${ID}`);
  // a view the stage does not have (the flipbook) opens as Blink, and the address is left as it was written
  await page.goto(`view.html?t=${ID}&mode=flip&pitch=1`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expect((await read(page)).mode).toBe('blink');
  expect(new URL(page.url()).search).toBe(`?t=${ID}&mode=flip&pitch=1`);
  await page.locator('#stage').getByRole('button', { name: 'Difference', exact: true }).click();
  expect(new URL(page.url()).search, 'what the address carried is kept').toBe(`?mode=diff&t=${ID}&pitch=1`);
});

test('the keys work on the page without touching the stage first', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expect((await read(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  expect((await read(page)).playing).toBe(false);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).side).toBe('b');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  // there is no difference picture for this view: D does nothing
  await page.keyboard.press('d');
  expect((await read(page)).mode).toBe('blink');
  // a key pressed in a link of the page belongs to the link
  await page.locator('.masthead-nav a').first().focus();
  await page.keyboard.press('d');
  expect((await read(page)).mode).toBe('blink');
});

test('?embed=1 shows the stage only, with a link back to the full viewer', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}&mode=side&embed=1`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(2);
  for (const hidden of ['.masthead', '.colophon', '#visits', '#colours', '#reading', '#view-where']) await expect(page.locator(hidden)).toBeHidden();
  await expect(page.locator('#stage .hover'), 'the readout is part of the stage').toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^barnard.s star$/i);
  const back = page.locator('#view-back');
  await expect(back).toBeVisible();
  await expect(back).toHaveText('Open in the viewer');
  await expect(back).toHaveAttribute('href', `view.html?mode=side&t=${ID}`);
  // the link follows what is shown
  await page.locator('#stage').getByRole('button', { name: 'Blink', exact: true }).click();
  await expect(back).toHaveAttribute('href', `view.html?mode=blink&t=${ID}`);
  expect(new URL(page.url()).search).toBe(`?mode=blink&t=${ID}&embed=1`);
  // without embed the link is not there
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await expect(page.locator('#view-back')).toBeHidden();
  await expect(page.locator('.masthead')).toBeVisible();
});

test('nothing chosen, a target that does not exist, a typed position before the client is connected: each says what to do', async ({ page }) => {
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-empty');
  await expect(page.locator('#plan .state a')).toHaveText(['Prepared targets', 'Type a position']);
  await expect(page.locator('#plan .state a').first()).toHaveAttribute('href', 'targets.html');
  for (const hidden of ['#stage', '#stage .hover', '#colours', '#visits']) await expect(page.locator(hidden)).toBeHidden();

  await page.goto('view.html?t=no-such-target');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-target');
  await expect(page.locator('#plan .state')).toContainText('There is no prepared target called “no-such-target”.');
  await expect(page.locator('#plan .state a')).toHaveText(['Prepared targets']);
  await expect(page.locator('#stage')).toBeHidden();

  await page.route('**/data/targets/broken/*', (route) => route.fulfill({ contentType: 'application/json', body: '{"id": "broken"}' }));
  await page.goto('view.html?t=broken');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-bad-target');

  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-not-connected');
  await expect(page.locator('#plan .state')).toContainText('The prepared targets work.');
  await expect(page.locator('#lookup [data-where="centre"]')).toContainText('269.4464° +4.7671°');
});

/**
 * Connect a stand-in client to the page: its plan and its stamps are the showcase of the fixtures, as if read live.
 * `planState` and `loadState` make it fail with a state; `hold` makes every load after the first wait for release();
 * `more` makes the plan hold its second pair back, as on a slow link; `three` gives the position three visits, the
 * middle one short, and lets the page name the two it wants: the first and the middle visit share no colour, which
 * the client says as the state "no-coverage" ('state', as the reader of this site does) or as a plan without pairs
 * ('empty'); `throws` makes the plan throw.
 * @param {import('@playwright/test').Page} page
 * @param {{planState?: string, loadState?: string, loadStateAt?: number, hold?: boolean, more?: boolean, three?: 'state' | 'empty', throws?: boolean}} [how]
 */
async function connectStandIn(page, how = {}) {
  await serveShowcase(page);
  await page.evaluate(async (opts) => {
    const base = document.baseURI;
    const [view, showcase] = await Promise.all([import(new URL('js/pages/view.js', base).href), import(new URL('js/lib/showcase.js', base).href)]);
    const got = await showcase.loadShowcase('data/targets/barnard-d5/');
    const s = got.stamps;
    const frame = (/** @type {any} */ st, /** @type {number} */ dt = 0, /** @type {string} */ key = dt ? `${st.key}#${dt}` : st.key) => ({ key, det: st.det, tmid: st.mjd + dt, corners: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    const visits = opts.three
      ? [
        { frames: [frame(s[0]), frame(s[1]), frame(s[1], 0.01)], short: false },
        { frames: [frame(s[2])], short: true },
        { frames: [frame(s[3], 30, s[3].key), frame(s[3], 30.01), frame(s[3], 30.02)], short: false },
      ]
      : [
        { frames: [frame(s[0]), frame(s[1]), frame(s[1], 0.01)], short: false },
        { frames: [frame(s[2]), frame(s[3]), frame(s[3], 0.01)], short: false },
      ];
    const t = /** @type {any} */ (window).__c = { calls: /** @type {any[]} */ ([]), loads: 0, release: () => {}, plans: 0, cancels: 0 };
    const gate = new Promise((resolve) => { t.release = resolve; });
    const whole = { visits, pairs: [[visits[0].frames[0], visits[1].frames[0]], [visits[0].frames[1], visits[1].frames[1]]], bytes: 2.4e6, seconds: 3 };
    /** With three visits: the pairs of the two visits asked for. @param {number[]} vp */
    const pairsOf = (vp) => (vp[0] === 0 && vp[1] === 2 ? [[visits[0].frames[1], visits[2].frames[0]]] : vp[0] === 1 && vp[1] === 2 ? [[visits[1].frames[0], visits[2].frames[0]]] : []);
    const client = {
      cancel() { t.cancels++; },
      /** @param {number} ra @param {number} dec @param {number} det @param {any} [o] */
      async plan(ra, dec, det, o) {
        t.plans++;
        t.calls.push(['plan', ra, dec, det, o ?? null]);
        if (opts.throws) throw new Error('a client that throws');
        if (opts.planState) return { state: opts.planState };
        if (opts.three) {
          const found = pairsOf(o?.visitPair ?? [0, 2]);
          return found.length || opts.three === 'empty' ? { visits, pairs: found, bytes: found.length * 1.2e6, seconds: 2 } : { state: 'no-coverage' };
        }
        return opts.more ? { ...whole, pairs: whole.pairs.slice(0, 1), bytes: 1.2e6, seconds: 9, more: { ...whole, pairs: whole.pairs.slice(1), bytes: 1.2e6, seconds: 9 } } : whole;
      },
      /** @param {any} plan @param {(p: unknown) => void} [onProgress] */
      async load(plan, onProgress) {
        const turn = t.loads++;
        t.calls.push(['load', plan.pairs.length, plan.bytes]);
        if (opts.hold && turn > 0) await gate;
        if (opts.loadState && turn === (opts.loadStateAt ?? 0)) return { state: opts.loadState };
        const out = [];
        let done = 0;
        for (const [fa, fb] of plan.pairs) {
          for (const f of [fa, fb]) {
            done++;
            onProgress?.({ type: 'stamp', done, total: plan.pairs.length * 2, bytes: done * 0.6e6, ms: 10 * done, key: f.key, cached: false, pair: done % 2 === 0 ? done / 2 - 1 : null });
            out.push(s.find((/** @type {any} */ st) => st.key === f.key));
            await new Promise((r) => setTimeout(r, 5));
          }
        }
        return out;
      },
    };
    view.connectClient(client);
  }, how);
}

test('a typed position: the plan, the progress, the first pair as soon as it arrives, then the rest', async ({ page, baseURL }) => {
  const problems = watch(page, baseURL);
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-not-connected');
  await connectStandIn(page, { hold: true });

  // the plan before loading: visits, photos, MB, seconds
  await expect(page.locator('#plan .plan-summary')).toHaveText('2 visits · 4 photos · 2.4 MB · about 3 seconds');
  await expect(page.locator('#plan .state')).toBeHidden();
  // the first pair is on the stage while the second is still on its way
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await expect(page.locator('#plan .plan-progress-text')).toHaveText('photo 2 of 4 · 1.2 of 2.4 MB');
  let now = await read(page);
  expect([now.pairs, now.choices]).toEqual([1, 1]);
  await page.locator('#stage .stage-play').click();
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  expect((await read(page)).panels[0].bits, 'the first pair, as the client gave it').toEqual(fileBits(0));
  expect((await read(page)).panels[0].rgba).toEqual(wantRgba(0, 0));
  expect(await page.evaluate(() => /** @type {any} */ (window).__c.calls)).toEqual([
    ['plan', 269.44636, 4.76706, 5, null], ['load', 1, 1200000], ['load', 1, 1200000],
  ]);
  const meter = page.locator('#plan .plan-meter');
  expect(await meter.evaluate((m) => [/** @type {HTMLProgressElement} */ (m).value, /** @type {HTMLProgressElement} */ (m).max])).toEqual([2, 4]);
  // a plan does not say at which colours a visit was photographed: each tile shows the colours read so far
  const chips = () => page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => [...b.querySelectorAll('.colour-chip')].map((c) => c.textContent)));
  expect(await chips()).toEqual([['4.296 µm'], ['4.296 µm']]);

  // the rest arrives: the picture on the stage is not disturbed, and the second colour can be chosen
  const flipsBefore = (await read(page)).flips;
  await page.evaluate(() => /** @type {any} */ (window).__c.release());
  await expect(page.locator('#colours .view-choice')).toHaveCount(2);
  await expect(page.locator('#plan .plan-progress')).toBeHidden();
  await expect(page.locator('#plan .plan-summary')).toHaveText('2 visits · 4 photos · 2.4 MB · about 3 seconds');
  now = await read(page);
  expect([now.pairs, now.choices, now.chosen, now.side, now.flips]).toEqual([2, 2, 0, 'a', flipsBefore]);
  expect(now.panels[0].bits).toEqual(fileBits(0));
  await page.locator('#colours .view-choice').nth(1).click();
  await expect.poll(async () => (await read(page)).panels[0].bits).toEqual(fileBits(1));

  // the visit strip of a plan: one tile for each visit, the two compared marked
  const tiles = page.locator('#visits .visit-tile');
  expect(await tiles.locator('.visit-date').allTextContents()).toEqual(['25 Aug 2025', '15 Mar 2026']);
  expect(await tiles.locator('.visit-photos').allTextContents()).toEqual(['3 photos', '3 photos']);
  expect(await tiles.evaluateAll((list) => list.map((b) => b.getAttribute('data-role')))).toEqual(['earlier', 'later']);
  expect(await chips()).toEqual([['4.296 µm', '4.370 µm'], ['4.296 µm', '4.370 µm']]);
  expect(problems).toEqual([]);
});

for (const answer of /** @type {const} */ (['state', 'empty'])) {
  test(`a typed position with three visits: a short visit is greyed, and choosing two visits plans them and changes the address (two visits without a common colour: ${answer})`, async ({ page }) => {
    const roles = () => page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => b.getAttribute('data-role')));
    const lastPlan = () => page.evaluate(() => /** @type {any} */ (window).__c.calls.filter((/** @type {any[]} */ c) => c[0] === 'plan').at(-1));
    await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
    await connectStandIn(page, { three: answer, hold: true });
    const tiles = page.locator('#visits .visit-tile');
    await expect(tiles).toHaveCount(3);
    expect(await tiles.locator('.visit-date').allTextContents()).toEqual(['25 Aug 2025', '15 Mar 2026', '14 Apr 2026']);
    expect(await roles()).toEqual(['earlier', '', 'later']);
    // the visit with one photo is short: greyed, dashed, and it says why
    await expect(tiles.nth(1)).toHaveAttribute('data-short', 'true');
    await expect(tiles.nth(1).locator('.visit-photos')).toHaveText('1 photo · few photos');
    await expect(tiles.nth(0).locator('.visit-photos')).toHaveText('3 photos');
    const looks = await tiles.evaluateAll((list) => list.map((b) => [getComputedStyle(b).color, getComputedStyle(b).borderTopStyle]));
    // the visits that are compared are marked by a rule on top and the ink of the text, not by a fill
    expect(looks).toEqual([['rgb(241, 234, 214)', 'solid'], ['rgb(168, 159, 130)', 'dashed'], ['rgb(241, 234, 214)', 'solid']]);
    // the plan compared the first and the last visit: frame 1 with frame 3
    await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
    await page.locator('#stage .stage-play').click();
    await page.locator('#stage .stage-pictures').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await read(page)).side).toBe('a');
    expect((await read(page)).panels[0].bits).toEqual(fileBits(1));
    expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5');

    // choosing the middle visit: it takes the place of the visit chosen longest ago, and the address names the two
    const top = () => page.locator('#visits .visit-tile').nth(1).evaluate((b) => b.getBoundingClientRect().top + window.scrollY); // on the page
    const before = await top();
    await tiles.nth(1).click();
    await expect.poll(lastPlan).toEqual(['plan', 269.44636, 4.76706, 5, { visitPair: [1, 2] }]);
    expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5&a=2026-03-15&b=2026-04-14');
    await expect(page.locator('#plan .plan-summary')).toHaveText('3 visits · 2 photos · 1.2 MB · about 2 seconds');
    expect(await roles()).toEqual(['', 'earlier', 'later']);
    // while their photos are on their way the stage keeps its room and shows nothing: the tile stays under the pointer
    await expect(page.locator('#stage')).toHaveClass(/is-waiting/);
    expect(await page.locator('#stage .stage-pictures').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    expect(Math.abs(await top() - before)).toBeLessThan(1);
    await page.evaluate(() => /** @type {any} */ (window).__c.release());
    await expect(page.locator('#stage')).not.toHaveClass(/is-waiting/);
    await expect.poll(async () => (await read(page)).panels[0]?.bits).toEqual(fileBits(2));
    expect(await page.locator('#stage .stage-pictures').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    // each tile carries the colours of its photos that have been read, also those of a visit no longer compared
    expect(await page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => [...b.querySelectorAll('.colour-chip')].map((c) => c.textContent)))).toEqual([['4.370 µm'], ['4.296 µm'], ['4.370 µm']]);

    // then the first visit: it is compared with the middle one, and the two share no colour. The stage leaves the
    // page, and the message that says why is brought into view: on a long page, in a browser that does not hold
    // the scroll position to what is on screen, it would be left above the window
    await page.addStyleTag({ content: '* { overflow-anchor: none !important; } #reading { margin-block-end: 3000px; }' });
    await page.locator('#visits .visit-tile').nth(0).click();
    await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-pairs');
    await expect(page.locator('#plan .state-next')).toHaveText('Choose two other visits below.');
    await expect(page.locator('#plan .state')).toBeInViewport({ ratio: 1 });
    expect(await lastPlan()).toEqual(['plan', 269.44636, 4.76706, 5, { visitPair: [0, 1] }]);
    expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5&a=2025-08-25&b=2026-03-15');
    await expect(page.locator('#stage')).toBeHidden();
    await expect(page.locator('#stage')).not.toHaveClass(/is-waiting/);
    expect(await roles(), 'the two visits that were chosen stay marked').toEqual(['earlier', 'later', '']);
    // and the last visit again, in place of the middle one: the first with the last, as at the start
    await page.locator('#visits .visit-tile').nth(2).click();
    await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
    await expect(page.locator('#plan .state')).toBeHidden();
    expect(await lastPlan()).toEqual(['plan', 269.44636, 4.76706, 5, { visitPair: [0, 2] }]);
    expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5&a=2025-08-25&b=2026-04-14');
    expect(await roles()).toEqual(['earlier', '', 'later']);
    await expect.poll(async () => (await read(page)).panels[0]?.bits).toEqual(fileBits(1));

    // the address alone: the page plans, sees that the address names two other visits, and plans those
    await page.goto('view.html?ra=269.44636&dec=4.76706&det=5&a=2026-03-15&b=2026-04-14');
    await connectStandIn(page, { three: answer });
    await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
    expect(await page.evaluate(() => /** @type {any} */ (window).__c.calls.filter((/** @type {any[]} */ c) => c[0] === 'plan').map((/** @type {any[]} */ c) => c[4]))).toEqual([null, { visitPair: [1, 2] }]);
    expect(await roles()).toEqual(['', 'earlier', 'later']);
    // an address that names two visits without a common colour says so, and shows which two it means
    await page.goto('view.html?ra=269.44636&dec=4.76706&det=5&a=2025-08-25&b=2026-03-15');
    await connectStandIn(page, { three: answer });
    await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-pairs');
    await expect(page.locator('#stage')).toBeHidden();
    expect(await roles()).toEqual(['earlier', 'later', '']);
    expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5&a=2025-08-25&b=2026-03-15');
  });
}

test('a call for two other visits that someone else withdraws leaves the stage as it was', async ({ page }) => {
  const roles = () => page.locator('#visits .visit-tile').evaluateAll((list) => list.map((b) => b.getAttribute('data-role')));
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { three: 'state', loadState: 'cancelled', loadStateAt: 1 });
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await page.locator('#stage .stage-play').click();
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  const before = await read(page);
  expect(before.panels[0].bits).toEqual(fileBits(1));

  // the middle visit is chosen, and the load of its photos comes back as cancelled
  await page.locator('#visits .visit-tile').nth(1).click();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__c.loads)).toBe(2);
  await expect(page.locator('#stage')).not.toHaveClass(/is-waiting/);
  // no message; the stage, the visits and the address are back at the two visits that are on the stage
  await expect(page.locator('#plan .state')).toBeHidden();
  expect(await roles()).toEqual(['earlier', '', 'later']);
  expect(new URL(page.url()).search).toBe('?ra=269.44636&dec=4.76706&det=5&a=2025-08-25&b=2026-04-14');
  const after = await read(page);
  expect([after.pairs, after.choices, after.side, after.flips]).toEqual([1, 1, 'a', before.flips]);
  expect(after.panels[0].bits).toEqual(fileBits(1));
  expect(after.panels[0].rgba).toEqual(before.panels[0].rgba);
  await expect(page.locator('#stage .stage-pictures')).toBeVisible();
  await expect(page.locator('#colours .view-choice')).toHaveCount(1);
  await expect(page.locator('#plan .plan-summary')).toHaveText('3 visits · 2 photos · 1.2 MB · about 2 seconds');
  // and the visit can be chosen again
  await page.locator('#visits .visit-tile').nth(1).click();
  await expect.poll(async () => (await read(page)).panels[0]?.bits).toEqual(fileBits(2));
  expect(await roles()).toEqual(['', 'earlier', 'later']);
});

test('a request that is overtaken is withdrawn, and a client that throws is treated as out of reach', async ({ page }) => {
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { hold: true });
  // the first pair is on the stage and the second is on its way
  await expect(page.locator('#plan .plan-progress-text')).toHaveText('photo 2 of 4 · 1.2 of 2.4 MB');
  expect(await page.evaluate(() => /** @type {any} */ (window).__c.cancels)).toBe(0);
  // another client takes over while it loads: the one that was loading is told to stop, the new one is not
  await withView(page, 'm.connectClient({ plan: async () => ({ state: "one-visit" }), load: async () => [], cancel() { window.__cancelled = (window.__cancelled ?? 0) + 1; } })');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'one-visit');
  expect(await page.evaluate(() => [/** @type {any} */ (window).__c.cancels, /** @type {any} */ (window).__cancelled ?? 0])).toEqual([1, 0]);
  await expect(page.locator('#visits .visit-tile')).toHaveCount(0);
  // the answer of the overtaken request arrives late, and changes nothing
  await page.evaluate(() => /** @type {any} */ (window).__c.release());
  await page.waitForTimeout(150);
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'one-visit');
  await expect(page.locator('#stage')).toBeHidden();

  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { throws: true });
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'unreachable');
  await expect(page.locator('#stage')).toBeHidden();
});

test('on a slow link the plan holds pairs back, and "Load more (N MB)" brings them', async ({ page }) => {
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { more: true });
  await expect(page.locator('#plan .plan-summary')).toHaveText('2 visits · 2 photos · 1.2 MB · about 9 seconds');
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  const more = page.locator('#plan .plan-button');
  await expect(more).toHaveText('Load more (1.2 MB)');
  expect((await read(page)).pairs).toBe(1);
  await more.click();
  await expect(page.locator('#colours .view-choice')).toHaveCount(2);
  await expect(more).toBeHidden();
  expect((await read(page)).pairs).toBe(2);
});

test('every state of CT-12 renders from an injected state, with one plain message and a next step', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  const shown = FAILURE_STATES.filter((s) => s !== 'cancelled');
  expect(shown.length).toBe(8);
  for (const state of shown) {
    const text = STATE_TEXT[/** @type {keyof typeof STATE_TEXT} */ (state)];
    await withView(page, 'm.showState(arg)', state);
    const box = page.locator('#plan .state');
    await expect(box, state).toBeVisible();
    await expect(box).toHaveAttribute('data-state', state);
    await expect(box).toHaveAttribute('role', 'status');
    await expect(box.locator('.state-title')).toHaveText(text.title);
    await expect(box.locator('.state-next')).toHaveText(text.next);
    // the next step can be taken: a button to try again, or links that lead somewhere
    const steps = await box.locator('.state-actions > *').evaluateAll((list) => list.map((e) => (e.tagName === 'BUTTON' ? 'retry' : /** @type {HTMLElement} */ (e).dataset.action)));
    expect(steps, state).toEqual(text.actions);
    expect(steps.length).toBe(text.actions.length);
    for (const a of await box.locator('a').all()) expect(['targets.html', 'lemmon.html', './']).toContain(await a.getAttribute('href'));
    // what is on the stage stays when the state says so, and leaves otherwise
    if (text.keeps) await expect(page.locator('#stage .stage-panel'), state).toHaveCount(1);
    else await expect(page.locator('#stage'), state).toBeHidden();
    // "try again", or opening the target again, brings the pictures back and takes the message away
    if (text.actions.includes('retry')) {
      await box.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('#plan .plan'), 'the target has been read again').toHaveAttribute('data-phase', 'idle');
    } else await page.goto(`view.html?t=${ID}`);
    await expect(page.locator('#stage .stage-panel'), state).toHaveCount(1);
    await expect(page.locator('#plan .state')).toBeHidden();
  }
  // "nothing changed" points to things that do change
  await withView(page, 'm.showState(arg)', 'quiet');
  await expect(page.locator('#plan .state a')).toHaveText(['Prepared targets', 'Comet Lemmon']);

  // cancelled is the page's own doing: no message, and what was shown stays
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  await withView(page, 'm.showState(arg)', 'cancelled');
  await expect(page.locator('#plan .state')).toBeHidden();
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  // a state the page does not know shows nothing either
  await withView(page, 'm.showState(arg)', 'something-new');
  await expect(page.locator('#plan .state')).toBeHidden();
});

test('a client that answers with a state: the message replaces the plan, or joins what has arrived', async ({ page }) => {
  // while planning: nothing to show but the message
  for (const state of ['no-coverage', 'one-visit', 'not-indexed', 'unreachable']) {
    await page.goto('view.html?ra=10&dec=20');
    await connectStandIn(page, { planState: state });
    await expect(page.locator('#plan .state')).toHaveAttribute('data-state', state);
    await expect(page.locator('#plan .state .state-title')).toHaveText(STATE_TEXT[/** @type {keyof typeof STATE_TEXT} */ (state)].title);
    await expect(page.locator('#stage')).toBeHidden();
    await expect(page.locator('#plan .plan')).toBeHidden();
  }
  // a typed position without a detector opens in detector 2
  expect(await page.evaluate(() => /** @type {any} */ (window).__c.calls[0])).toEqual(['plan', 10, 20, 2, null]);

  // "try again" asks the client again
  await page.locator('#plan .state').getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__c.plans)).toBe(2);

  // while loading the second pair the archive turns slow: the first pair stays, with the message beside it
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { loadState: 'slow', loadStateAt: 1 });
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'slow');
  await expect(page.locator('#plan .state')).toContainText('What has arrived is shown.');
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expect((await read(page)).pairs).toBe(1);
  await expect(page.locator('#plan .plan-summary')).toBeVisible();

  // a plan the page withdrew: no message
  await page.goto('view.html?ra=269.44636&dec=4.76706&det=5');
  await connectStandIn(page, { planState: 'cancelled' });
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__c.plans)).toBe(1);
  await expect(page.locator('#plan .state')).toBeHidden();
});

test('the page fits a window 360 px wide with a showcase open, in every view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await serveShowcase(page);
  for (const mode of ['blink', 'diff', 'curtain', 'side']) {
    await page.goto(`view.html?t=${ID}&mode=${mode}`);
    await expect(page.locator('#visits .visit-tile')).toHaveCount(2);
    await expect(page.locator('#colours .ruler-span')).toHaveCount(6);
    const fit = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
      over: [...document.querySelectorAll('main *')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0 && (e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 || e.getBoundingClientRect().left < -0.5)).map((e) => `${e.tagName}.${e.className}`),
    }));
    expect(fit.scroll, mode).toBeLessThanOrEqual(fit.client);
    expect(fit.over, mode).toEqual([]);
  }
  // in Blink the picture is as large as the window allows: five screen pixels to a pixel
  await page.goto(`view.html?t=${ID}`);
  await expect(page.locator('#stage .stage-panel')).toHaveCount(1);
  expect((await read(page)).panels[0].cssWidth).toBe(320);
  // the "how the pictures are drawn" note quotes the numbers of the stage
  await page.locator('#reading summary').click();
  await expect(page.locator('#reading')).toContainText('6.15 arcsec across');
  await expect(page.locator('#reading')).toContainText('at most 2 times a second');
});

test('a clicked place holds the readout while the mouse moves; Escape lets go', async ({ page }) => {
  await serveShowcase(page);
  await page.goto(`view.html?t=${ID}`);
  await page.locator('#stage .stage-play').click();
  await page.locator('#stage .stage-pictures').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  const canvas = page.locator('#stage .stage-canvas'), hover = page.locator('#stage .hover');
  await canvas.scrollIntoViewIfNeeded();
  const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
  /** @param {number} x @param {number} y */
  const at = (x, y) => [box.x + (x + 0.5) * box.width / W, box.y + (H - 1 - y + 0.5) * box.height / H];
  const [cx, cy] = at(10, 12);
  await page.mouse.click(cx, cy);
  await expect(page.locator('#stage .hover-hint')).toHaveText('Place clicked');
  const clicked = await hover.evaluate((e) => ({ ...(/** @type {HTMLElement} */ (e).dataset), text: e.textContent }));
  expect([clicked.x, clicked.y]).toEqual(['10', '12']);
  const [mx, my] = at(40, 30);
  await page.mouse.move(mx, my);
  await page.mouse.move(mx + 3, my + 3);
  await expect(page.locator('#stage .hover-hint')).toHaveText('Place clicked');
  expect(await hover.evaluate((e) => ({ ...(/** @type {HTMLElement} */ (e).dataset), text: e.textContent }))).toEqual(clicked);
  await page.keyboard.press('Escape');
  await page.mouse.move(mx, my);
  await pointed(page, 40, 30);
  await expect(page.locator('#stage .hover-hint')).not.toHaveText('Place clicked');
});
