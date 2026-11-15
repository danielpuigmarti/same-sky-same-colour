// The targets page, the comet page and the Checks page in a browser: every number they show is the number of
// numbers.json, every tag opens the card of its check, and each page works with scripts off, at 360 px, by keyboard
// alone and when the visitor asks for less motion.
//
// The pages are the ones of the site, drawn from its own data. The parts of the targets page that are shown only
// when their checks allow them are tried on a page made from tests/fixtures/v4/optional.json, which is made up.
import { typeset } from '../../site/js/ui/cards.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, loadSite, makePages, readPages, withOptional } from '../fixtures/v4/make.mjs';

const SITE = path.join(ROOT, 'site');
const NUMBERS = JSON.parse(readFileSync(path.join(SITE, 'data', 'numbers.json'), 'utf8'));
const ROWS = JSON.parse(readFileSync(path.join(SITE, 'data', 'checks', 'checks.json'), 'utf8'));
const MADE = ['targets.html', 'lemmon.html', 'checks.html'];
const ALL = ['', 'view.html', ...MADE];
const TARGETS = ['eps-indi-b', 'barnard', 'wise0855', 'rw-aur', 'r-dra'];

/**
 * Collect what goes wrong while a page is used: an error on the console, a failed request, an answer of 400 or
 * more, a request to another host or one that sends something.
 * @param {import('@playwright/test').Page} page @param {string} baseURL
 */
function watch(page, baseURL) {
  const origin = new URL(baseURL).origin;
  /** @type {string[]} */
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== origin) problems.push(`request to another host: ${r.url()}`);
    if (r.method() !== 'GET') problems.push(`${r.method()} ${r.url()}`);
  });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`); });
  return problems;
}

/** Go down the page a step at a time, so that what is made when it comes near is made, then back to the top. @param {import('@playwright/test').Page} page */
async function walk(page) {
  // what is far down a page is made when it comes within 600 px of the window, so a step of 1000 px misses nothing
  for (let y = 0; y < await page.evaluate(() => document.documentElement.scrollHeight); y += 1000) {
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y);
    await page.waitForTimeout(80);
  }
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

/**
 * Watch a canvas for a while and count how often the photo on it changed.
 * @param {import('@playwright/test').Page} page @param {string} selector @param {number} ms
 */
function flips(page, selector, ms) {
  return page.evaluate(async ([sel, wait]) => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector(/** @type {string} */ (sel)));
    let n = 0, last = canvas.dataset.photo;
    const seen = new MutationObserver(() => {
      if (canvas.dataset.photo === last) return;
      last = canvas.dataset.photo;
      n++;
    });
    seen.observe(canvas, { attributes: true, attributeFilter: ['data-photo'] });
    await new Promise((done) => setTimeout(done, /** @type {number} */ (wait)));
    seen.disconnect();
    return n;
  }, [selector, ms]);
}

/** How many blinks of the page are playing. @param {import('@playwright/test').Page} page */
const playing = (page) => page.locator('[data-play][aria-pressed="true"]').count();

/** Wait until the page has stopped scrolling: the site scrolls smoothly to the place an address names. @param {import('@playwright/test').Page} page */
async function settled(page) {
  let last = -1;
  await expect.poll(async () => {
    const y = await page.evaluate(() => Math.round(scrollY)), same = y === last;
    last = y;
    return same;
  }, { intervals: [200] }).toBe(true);
}

// ---- numbers and tags ----

/** A number as numbers.json writes it, whether or not the page has set it with a true minus, an en dash or a no-break space. */
const plain = (/** @type {unknown} */ t) => String(t).replace(/−/g, "-").replace(/–/g, "-").replace(/ /g, " ");

for (const file of MADE) {
  test(`${file}: every number on the page is the number of numbers.json`, async ({ page }) => {
    await page.goto(file);
    const shown = await page.locator('[data-n]').evaluateAll((list) => list.map((e) => [/** @type {HTMLElement} */ (e).dataset.n, e.textContent, e.tagName]));
    expect(shown.length).toBeGreaterThan(5);
    for (const [key, text, tag] of shown) {
      expect(tag, String(key)).toBe('SPAN');
      expect(NUMBERS[/** @type {string} */ (key)], `numbers.json has "${key}"`).toBeTruthy();
      expect(plain(text), String(key)).toBe(plain(NUMBERS[/** @type {string} */ (key)].text));
    }
  });
}

test('every card of the targets page carries numbers, and each is the number of numbers.json', async ({ page }) => {
  await page.goto('targets.html');
  await expect(page.locator('article.tcard')).toHaveCount(5);
  expect(await page.locator('article.tcard').evaluateAll((list) => list.map((e) => e.id))).toEqual(TARGETS);
  for (const id of TARGETS) {
    const shown = await page.locator(`#${id} [data-n]`).evaluateAll((list) => list.map((e) => [/** @type {HTMLElement} */ (e).dataset.n, e.textContent]));
    expect(shown.length, id).toBeGreaterThan(0);
    for (const [key, text] of shown) expect(plain(text), `${id}: ${key}`).toBe(plain(NUMBERS[/** @type {string} */ (key)].text));
  }
  // the saturated star has no measured value: only how many photos are saturated and how many pairs there are
  const keys = await page.locator('#r-dra [data-n]').evaluateAll((list) => list.map((e) => /** @type {HTMLElement} */ (e).dataset.n));
  expect([...new Set(keys)].sort()).toEqual(['targets.r-dra.frames', 'targets.r-dra.pairs', 'targets.r-dra.saturated']);
});

test('every tag on every page opens a row that exists on the Checks page', async ({ page }) => {
  /** @type {Map<string, string>} */
  const wanted = new Map();
  let tags = 0;
  for (const file of ALL) {
    await page.goto(file);
    const found = await page.locator('a.check-link, a[href*="checks.html#"]').evaluateAll((list) => list.map((e) => [e.getAttribute('href') ?? '', e.className, e.getAttribute('data-status') ?? '']));
    for (const [href, cls, status] of found) {
      const id = /^checks\.html#(.+)$/.exec(href)?.[1];
      expect(id, `${file || 'index.html'}: a tag leads to "${href}"`).toBeTruthy();
      // an address of a part of the Checks page (the challenge, the tried-by table) is not a row
      if (ROWS.some((/** @type {any} */ r) => r.id === decodeURIComponent(/** @type {string} */ (id)))) wanted.set(decodeURIComponent(/** @type {string} */ (id)), file || 'index.html');
      if (!cls.split(' ').includes('check-link')) continue;
      tags++;
      // the tag carries the status of its row
      expect(status, href).toBe(ROWS.find((/** @type {any} */ r) => r.id === decodeURIComponent(/** @type {string} */ (id)))?.status);
    }
  }
  expect(tags).toBeGreaterThanOrEqual(10);
  expect(wanted.size).toBeGreaterThanOrEqual(6);
  for (const [id, from] of wanted) {
    await page.goto(`checks.html#${encodeURIComponent(id)}`);
    const card = page.locator(`.ccard[id="${id}"]`);
    await expect(card, `${from}: row ${id}`).toHaveCount(1);
    await expect(card).toBeVisible();
    await settled(page);
    await expect(card).toBeInViewport();
    // the row that the address names opens by itself, and its line is what the reader lands on
    await expect(card.locator('.ccard-details')).toHaveAttribute('open', '');
    await expect(card.locator('.ccard-row')).toBeInViewport();
    expect(await card.evaluate((e) => e.matches(':target')), id).toBe(true);
  }
});

test('a tag of a target is followed to its row, and the row shows whatever the filter says', async ({ page }) => {
  await page.goto('targets.html');
  const tag = page.locator('#r-dra .tcard-cells a.check-link');
  await expect(tag).toHaveText('K6-rdra');
  await expect(tag).toHaveAttribute('aria-label', 'Check K6-rdra: not reviewed by a person');
  await expect(page.locator('#r-dra .tag-plain')).toHaveText('too bright to measure');
  const id = await tag.getAttribute('data-check');
  await tag.click();
  await expect(page).toHaveURL(new RegExp(`checks\\.html#${id}$`));
  const card = page.locator(`.ccard[id="${id}"]`);
  await expect(card).toBeInViewport();
  await expect(card.locator('.ccard-row')).toBeVisible();
  // choose a status the card does not have: the card that the address names stays
  const status = await card.getAttribute('data-status');
  const other = await page.locator('.cfilter input[name="show"]').evaluateAll((list, own) => list.map((e) => /** @type {HTMLInputElement} */ (e).value).find((v) => v !== 'all' && v !== own), status);
  await page.locator(`.cfilter-choice:has(input[value="${other}"])`).click();
  await expect(card).toBeVisible();
  await settled(page);
  // and coming to a card while another status is chosen puts the filter back on "All"
  const elsewhere = ROWS.find((/** @type {any} */ r) => r.status !== other && r.id !== id).id;
  await page.evaluate((to) => { location.hash = to; }, elsewhere);
  await expect(page.locator('.cfilter input[value="all"]')).toBeChecked();
  await settled(page);
  await expect(page.locator(`.ccard[id="${elsewhere}"]`)).toBeInViewport();
});

// ---- the Checks page ----

test('the Checks page opens on its words and a key to the marks, then a filter whose choices carry the counts and show the rows of one status', async ({ page }) => {
  await page.goto('checks.html');
  await expect(page.locator('.checks-intro-text > p')).toHaveCount(3);
  await expect(page.locator('.checks-intro-text > p').first()).toContainText('Nothing here is for you to do.');
  await expect(page.locator('.checks-intro-text > p').nth(2)).toContainText(`There are ${ROWS.length} checks,`);
  await expect(page.locator('.checks-intro-text > p').nth(1)).toContainText('In short: of ');
  const cards = page.locator('.ccard');
  await expect(cards).toHaveCount(ROWS.length);
  const by = (/** @type {string} */ status) => ROWS.filter((/** @type {any} */ r) => r.status === status).length;
  const statuses = await page.locator('.cfilter input[name="show"]').evaluateAll((list) => list.map((e) => /** @type {HTMLInputElement} */ (e).value).filter((v) => v !== 'all'));
  expect(statuses.length).toBeGreaterThan(1);
  for (const status of statuses) {
    await page.locator(`.cfilter-choice:has(input[value="${status}"])`).click();
    const visible = await cards.evaluateAll((list) => list.filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null).map((e) => /** @type {HTMLElement} */ (e).dataset.status));
    expect(visible.length, status).toBe(by(status));
    expect(new Set(visible), status).toEqual(new Set([status]));
    await expect(page.locator('[data-filter-status]')).toHaveText(new RegExp(`^Showing ${by(status)} of ${ROWS.length} checks: `));
    // the choice carries its count
    await expect(page.locator(`.cfilter-choice:has(input[value="${status}"]) .cfilter-count`)).toHaveText(String(by(status)));
  }
  await page.locator('.cfilter-choice:has(input[value="all"])').click();
  expect(await cards.evaluateAll((list) => list.filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null).length)).toBe(ROWS.length);
  await expect(page.locator('[data-filter-status]')).toHaveText(`Showing all ${ROWS.length} checks.`);
});

test('a row of the Checks page opens in place to its picture, its numbers, its rule, its status and its command', async ({ page }) => {
  await page.goto('checks.html');
  const row = ROWS.find((/** @type {any} */ r) => r.image && r.value !== null && r.rerun);
  const card = page.locator(`.ccard[id="${row.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.ccard-title')).toHaveText(typeset(row.title));
  await expect(card.locator('.ccard-status')).toHaveText(/^(Passed|Corrected|A limit|Not reviewed by a person|Failed)$/);
  // closed by default: only its line is in sight; a tap opens it where it stands
  await expect(card.locator('.ccard-details')).not.toHaveAttribute('open', '');
  await expect(card.locator('.ccard-claim')).toBeHidden();
  await card.locator('.ccard-row').click();
  await expect(card.locator('.ccard-details')).toHaveAttribute('open', '');
  await expect(card.locator('.ccard-claim')).toHaveText(row.claim);
  const picture = card.locator('.ccard-picture img');
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBeGreaterThan(0);
  await expect(card.locator('.ccard-picture a')).toHaveAttribute('href', `data/checks/${row.image}`);
  await expect(card.locator('.ccard-values')).toContainText(String(row.value));
  await expect(card.locator('.ccard-rule')).toContainText(row.pass_rule);
  await expect(card.locator('.stamp')).toHaveText(/^(PASSED|CORRECTED|A LIMIT|NOT REVIEWED BY A PERSON|FAILED)$/);
  await expect(card.locator('.ccard-facts code').last()).toHaveText(row.rerun);
  await expect(card.locator('.ccard-text')).toContainText(typeset(row.test));
  // a tap on its line closes it again
  await card.locator('.ccard-row').click();
  await expect(card.locator('.ccard-claim')).toBeHidden();
  // a row that an address names opens by itself
  const other = ROWS.find((/** @type {any} */ r) => r.id !== row.id && r.test);
  await page.evaluate((to) => { location.hash = to; }, other.id);
  await expect(page.locator(`.ccard[id="${other.id}"] .ccard-details`)).toHaveAttribute('open', '');
});

// ---- scripts off ----

test('with scripts off the three pages read whole: their words, their numbers and their pictures', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  /** Every picture of the page that is not hidden has loaded. */
  const pictures = async () => {
    const list = page.locator('main img');
    const n = await list.count();
    let seen = 0;
    for (let i = 0; i < n; i++) {
      const img = list.nth(i);
      if (!await img.evaluate((e) => /** @type {HTMLElement} */ (e).offsetParent !== null)) continue;
      await img.scrollIntoViewIfNeeded();
      await expect(img, await img.getAttribute('src') ?? '').toBeVisible();
      await expect.poll(() => img.evaluate((e) => /** @type {HTMLImageElement} */ (e).naturalWidth), { message: await img.getAttribute('src') ?? '' }).toBeGreaterThan(0);
      expect((await img.getAttribute('alt') ?? '').length, 'a picture says what it shows').toBeGreaterThan(20);
      seen++;
    }
    return seen;
  };

  await page.goto('targets.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^FIVE TARGETS./);
  await expect(page.locator('article.tcard')).toHaveCount(5);
  for (const id of TARGETS) {
    const card = page.locator(`#${id}`);
    await expect(card.locator('.tcard-verdict')).toBeVisible();
    await expect(card.locator('img.blink-still')).toBeVisible();   // the two photos side by side
    await expect(card.locator('.tcard-open a')).toHaveAttribute('href', `view.html?t=${id}`);
  }
  await expect(page.locator('#eps-indi-b .tcard-jump figcaption .jump-key')).toContainText('With a WISE image of 2010');
  expect(await page.locator('canvas').count()).toBe(0);
  expect(await pictures()).toBe(5 + 3 * 2);   // a pair for each target, and the two pictures of each of the three movers

  await page.goto('lemmon.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^COMET LEMMON./);
  await expect(page.locator('img[src="data/lemmon/track.png"]')).toBeVisible();
  await expect(page.locator('img[src="data/lemmon/strip/strip.png"]')).toBeVisible();
  await expect(page.locator('img[src="data/lemmon/templates/templates.png"]')).toBeVisible();
  await expect(page.locator('svg.chart-plot')).toBeVisible();
  await expect(page.locator('main')).toContainText(NUMBERS['lemmon.contrast.feb26'].text);
  await expect(page.locator('.places .place')).toHaveCount(2);
  await expect(page.locator('table.leftout tbody tr')).not.toHaveCount(0);
  await expect(page.locator('#not-claimed + ul > li')).toHaveCount(4);
  await expect(page.locator('#literature + div')).toContainText(/searched|Searched/);
  expect(await pictures()).toBe(4);   // the wide photo of the field, the track, the strip and the same sky without the comet

  await page.goto('checks.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^EVERY CLAIM HAS A CHECK./);
  await expect(page.locator('.checks-intro-text > p')).toHaveCount(3);
  await expect(page.locator('.checks-intro-text > p').first()).toContainText('Nothing here is for you to do.');
  await expect(page.locator('.checks-intro-text > p').nth(2)).toContainText(`There are ${ROWS.length} checks,`);
  await expect(page.locator('.checks-intro-text > p').nth(1)).toContainText('In short: of ');
  await expect(page.locator('.ccard')).toHaveCount(ROWS.length);
  // every row is open, so that the page reads whole
  await expect(page.locator('.ccard-details[open]')).toHaveCount(ROWS.length);
  expect(await pictures()).toBe(ROWS.filter((/** @type {any} */ r) => r.image).length);
  // the filter needs no script: the stylesheet acts on the choice
  const status = ROWS[0].status, some = ROWS.filter((/** @type {any} */ r) => r.status === status).length;
  await page.locator(`.cfilter-choice:has(input[value="${status}"])`).click();
  expect(await page.locator('.ccard').evaluateAll((list) => list.filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null).length)).toBe(some);
  await context.close();
});

// ---- 360 px ----

test('at 360 px the three pages fit the window once everything on them is drawn', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 740 });
  const problems = watch(page, /** @type {string} */ (baseURL));
  for (const file of MADE) {
    await page.goto(file);
    await walk(page);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll, file).toBeLessThanOrEqual(client);
    // nothing but a table is wider than the window, and a table scrolls inside its own frame
    const wide = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.table-scroll') && !e.closest('.visually-hidden') && !e.matches('.plate-crop > img')).map((e) => `${e.tagName}.${e.className}`));
    expect(wide, file).toEqual([]);
    // what is tapped is large enough to tap
    const small = await page.evaluate(() => [...document.querySelectorAll('main button, main .btn, main .cfilter-choice, main summary')]
      .filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null)
      .map((e) => [e, e.getBoundingClientRect(), getComputedStyle(e, '::after')])
      .filter(([, box, after]) => Math.max(/** @type {DOMRect} */ (box).height, parseFloat(/** @type {CSSStyleDeclaration} */ (after).height) || 0) < 40)
      .map(([e]) => `${/** @type {Element} */ (e).tagName}.${/** @type {Element} */ (e).className}`));
    expect(small, file).toEqual([]);
    expect(problems, file).toEqual([]);
  }
});

// ---- the blinks ----

test('targets: the blink in view plays, one at a time; out of view it waits; the visitor can stop it and step it', async ({ page, baseURL }) => {
  const problems = watch(page, /** @type {string} */ (baseURL));
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('targets.html');
  const first = '#eps-indi-b .plate-live canvas', second = '#barnard .plate-live canvas';
  await page.locator('#eps-indi-b .tcard-blink').scrollIntoViewIfNeeded();
  await expect(page.locator(first)).toBeVisible();
  await expect(page.locator('#eps-indi-b [data-play]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#eps-indi-b [data-play]')).toHaveText('PAUSE');
  // it changes the photo, and never more often than twice a second
  const n = await flips(page, first, 2600);
  expect(n).toBeGreaterThanOrEqual(2);
  expect(n).toBeLessThanOrEqual(5);
  expect(await playing(page)).toBe(1);
  // the plain picture of the pair stays for a screen reader, and the photo says which month it shows
  await expect(page.locator('#eps-indi-b img.blink-still')).toHaveClass(/visually-hidden/);
  await expect(page.locator('#eps-indi-b .tcard-blink .plate-verdict')).toHaveText(/^[A-Z]+ 20\d\d$/);
  // the month stands on a black band under the photo, not over its pixels
  const band = await page.locator('#eps-indi-b .tcard-blink .plate-verdict').boundingBox(), photo = await page.locator('#eps-indi-b .plate-live').boundingBox();
  expect(band && photo && band.y >= photo.y + photo.height - 1).toBe(true);

  // out of view it waits: nothing changes while its photo cannot be seen
  const top = await page.locator('#eps-indi-b .plate-live').evaluate((e) => e.getBoundingClientRect().bottom + scrollY);
  await page.evaluate((y) => window.scrollTo(0, y + 40), top);
  expect(await page.evaluate(() => [...document.querySelectorAll('.plate-live')].filter((e) => e.getBoundingClientRect().bottom > 0 && e.getBoundingClientRect().top < innerHeight).length)).toBe(0);
  await page.waitForTimeout(900);
  expect(await flips(page, first, 2000)).toBe(0);
  expect(await playing(page)).toBeLessThanOrEqual(1);

  // the next card comes into view: its blink plays, and the first is no longer playing
  await page.locator('#barnard .tcard-blink').scrollIntoViewIfNeeded();
  await expect(page.locator('#barnard [data-play]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#eps-indi-b [data-play]')).toHaveAttribute('aria-pressed', 'false');
  expect(await flips(page, second, 2000)).toBeGreaterThanOrEqual(1);
  expect(await playing(page)).toBe(1);

  // the visitor stops it: it stays still, also when it leaves and comes back
  await page.locator('#barnard [data-play]').click();
  await expect(page.locator('#barnard [data-play]')).toHaveText('BLINK');
  expect(await flips(page, second, 1800)).toBe(0);
  await page.evaluate(() => window.scrollBy(0, 900));
  await page.locator('#barnard .tcard-blink').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await expect(page.locator('#barnard [data-play]')).toHaveAttribute('aria-pressed', 'false');
  // a step: the other photo of the pair, said aloud
  const before = await page.locator('#barnard .plate-live').getAttribute('data-shows');
  await page.locator('#barnard [data-flip]').click();
  await expect(page.locator('#barnard .plate-live')).not.toHaveAttribute('data-shows', /** @type {string} */ (before));
  await expect(page.locator('#barnard .transport [role="status"]')).toHaveText(/^Showing [A-Z][a-z]+ 20\d\d\.$/);
  await expect(page.locator('#barnard [data-play]')).toHaveAttribute('aria-pressed', 'false');
  expect(await playing(page)).toBeLessThanOrEqual(1);
  expect(problems).toEqual([]);
});

test('targets: every card gets its blink, also the saturated star, and the marks of a jump can be hidden', async ({ page, baseURL }) => {
  const problems = watch(page, /** @type {string} */ (baseURL));
  await page.goto('targets.html');
  await walk(page);
  for (const id of TARGETS) {
    await expect(page.locator(`#${id} .blink-box.is-live canvas`), id).toHaveCount(1);
    // the photo is drawn: some of its pixels are lit
    const lit = await page.locator(`#${id} .plate-live canvas`).evaluate((c) => {
      const canvas = /** @type {HTMLCanvasElement} */ (c), data = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && data[i] > 60) n++;
      return [n, canvas.width];
    });
    expect(lit[1], id).toBeGreaterThan(20);
    expect(lit[0], id).toBeGreaterThan(5);
  }
  // the middle of the saturated star has no value: those pixels are left clear
  const clear = await page.locator('#r-dra .plate-live canvas').evaluate((c) => {
    const canvas = /** @type {HTMLCanvasElement} */ (c), data = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).getImageData(0, 0, canvas.width, canvas.height).data;
    const mid = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
    return data[mid + 3];
  });
  expect(clear).toBe(0);
  // the marks
  const jump = page.locator('#eps-indi-b .tcard-jump');
  const marks = jump.getByRole('button', { name: 'Marks' });
  await expect(marks).toHaveAttribute('aria-pressed', 'true');
  await expect(jump.locator('.jump-marks').first()).toBeVisible();
  await marks.click();
  await expect(marks).toHaveAttribute('aria-pressed', 'false');
  await expect(jump.locator('.jump-marks').first()).toBeHidden();
  // the parts that their checks did not allow are not on the page
  for (const part of ['gallery', 'spot-it', 'pluto']) {
    const built = await page.locator(`#${part}`).evaluate((e) => e.childElementCount > 0);
    if (!built) await expect(page.locator(`#${part}`)).toBeHidden();
  }
  expect(problems).toEqual([]);
});

test('targets: every blink has drawn its first photo before it is scrolled to, and the flip of the picture of long ago and SPHEREx stands in place with its years', async ({ page, baseURL }) => {
  const problems = watch(page, /** @type {string} */ (baseURL));
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto('targets.html');
  // none of the lower ones is in view: each is drawn all the same
  for (const id of TARGETS) await expect(page.locator('#' + id + ' .plate-live canvas'), id).toHaveCount(1);
  for (const night of ['feb25', 'feb26']) {
    await page.goto('lemmon.html');
    await expect(page.locator('.place[data-night="' + night + '"] .plate-live canvas')).toHaveCount(1);
    await expect(page.locator('[data-strip].is-live canvas').first()).toBeAttached();
  }
  // a window so low that only the flip is in view: of two plates in view, one plays at a time
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('targets.html');
  const jump = page.locator('#eps-indi-b .tcard-jump');
  await jump.scrollIntoViewIfNeeded();
  const pair = jump.locator('.plate.jump');
  await pair.scrollIntoViewIfNeeded();
  await expect(pair).toHaveClass(/is-stacked/);
  // the two years are in plain sight, in the cells under the plate and on the plate itself
  await expect(jump.locator('.cells [data-panel="0"]')).toContainText('WISE, 2010');
  await expect(jump.locator('.cells [data-panel="1"]')).toContainText('SPHEREx, April 2026');
  const seen = new Set();
  for (let i = 0; i < 14 && seen.size < 2; i++) {
    seen.add(await jump.locator('.plate-verdict').textContent());
    await page.waitForTimeout(450);
  }
  expect([...seen].sort()).toEqual(['SPHEREX, APRIL 2026', 'WISE, 2010']);
  // the plate keeps its size and does not slide: both pictures lie on one place
  const boxes = await jump.locator('.jump-panel').evaluateAll((list) => list.map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width)]; }));
  expect(boxes[0]).toEqual(boxes[1]);
  // pause: it stays on the picture it shows
  const stop = jump.locator('[data-spot-blink]');
  await expect(stop).toHaveText('PAUSE');
  // a click that does not move the window: scrolled down to the button, the plate would leave the view and the blink
  // under it would take over, so a click that came after that would start the flip again
  await stop.dispatchEvent('click');
  await expect(stop).toHaveAttribute('aria-pressed', 'false');
  const shows = await pair.getAttribute('data-shows');
  await page.waitForTimeout(1800);
  await expect(pair).toHaveAttribute('data-shows', /** @type {string} */ (shows));
  await jump.locator('[data-spot-flip]').click();
  await expect(pair).not.toHaveAttribute('data-shows', /** @type {string} */ (shows));
  expect(problems).toEqual([]);
});

test('targets: with less motion asked for, the flip of the picture of long ago and SPHEREx stands side by side and is stepped by hand', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', baseURL, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('targets.html');
  const jump = page.locator('#eps-indi-b .tcard-jump');
  await jump.scrollIntoViewIfNeeded();
  const pair = jump.locator('.plate.jump');
  await expect(pair).not.toHaveClass(/is-stacked/);
  await expect(jump.locator('.jump-panel img')).toHaveCount(2);
  await expect(jump.locator('[data-spot-blink]')).toBeHidden();
  await page.waitForTimeout(1500);
  await expect(pair).not.toHaveClass(/is-stacked/);
  await jump.locator('[data-spot-flip]').click();
  await expect(pair).toHaveClass(/is-stacked/);
  const shows = await pair.getAttribute('data-shows');
  await jump.locator('[data-spot-flip]').click();
  await expect(pair).not.toHaveAttribute('data-shows', /** @type {string} */ (shows));
  await context.close();
});

test('with less motion asked for, nothing plays by itself on the targets page or the comet page, and every change is a step', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', baseURL, viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  for (const [file, scope] of [['targets.html', '#eps-indi-b'], ['lemmon.html', '.place[data-night="feb26"]']]) {
    await page.goto(file);
    await page.locator(`${scope} [data-blink]`).scrollIntoViewIfNeeded();
    const plate = page.locator(`${scope} .plate-live`);
    await expect(plate).toBeVisible();
    await expect(page.locator(`${scope} [data-play]`)).toBeHidden();
    expect(await flips(page, `${scope} .plate-live canvas`, 2200), file).toBe(0);
    expect(await playing(page), file).toBe(0);
    const before = await plate.getAttribute('data-shows');
    await page.locator(`${scope} [data-flip]`).click();
    await expect(plate).not.toHaveAttribute('data-shows', /** @type {string} */ (before));
    await page.locator(`${scope} [data-flip]`).click();
    await expect(plate).toHaveAttribute('data-shows', /** @type {string} */ (before));
  }
  await context.close();
});

// ---- the comet ----

test('comet: the two places blink between August and February, one at a time, where the track says', async ({ page, baseURL }) => {
  const problems = watch(page, /** @type {string} */ (baseURL));
  await page.goto('lemmon.html');
  await expect(page.locator('svg.track-map .track-ring')).toHaveCount(2);
  const places = page.locator('.places .place');
  await expect(places).toHaveCount(2);
  await places.first().scrollIntoViewIfNeeded();
  for (const night of ['feb25', 'feb26']) await expect(page.locator(`.place[data-night="${night}"] .plate-live canvas`)).toBeVisible();
  await expect.poll(() => playing(page)).toBe(1);
  // the photo that blinks says its month: August 2025 or February 2026, and nothing else
  const months = new Set();
  for (let i = 0; i < 12 && months.size < 2; i++) {
    months.add(await page.locator('.place [data-play][aria-pressed="true"]').locator('xpath=ancestor::li').locator('.plate-verdict').textContent());
    await page.waitForTimeout(450);
  }
  expect([...months].sort()).toEqual(['AUGUST 2025', 'FEBRUARY 2026']);
  // start the other place: the one that played stops
  const idle = page.locator('.place [data-play][aria-pressed="false"]');
  await expect(idle).toHaveCount(1);
  await idle.click();
  await expect.poll(() => playing(page)).toBe(1);
  expect(problems).toEqual([]);
});

test('comet: a chip steps along the ruler through the photos of both nights, by pointer and by keyboard', async ({ page, baseURL }) => {
  const problems = watch(page, /** @type {string} */ (baseURL));
  await page.goto('lemmon.html');
  const strip = page.locator('[data-strip]');
  await strip.scrollIntoViewIfNeeded();
  await expect(strip).toHaveClass(/is-live/);
  await expect(strip.locator('[data-still]')).toBeHidden();
  const thumbs = strip.locator('.strip-thumb');
  const count = await thumbs.count();
  expect(count).toBeGreaterThanOrEqual(8);
  await expect(strip.locator('.strip-night')).toHaveCount(2);
  const input = strip.locator('input[type="range"]');
  const readout = strip.locator('.strip-readout');
  // it opens on a photo inside the band, and says so; the brightness is a lower limit
  await expect(readout).toContainText('inside the band of carbon dioxide');
  await expect(readout).toContainText('a lower limit');
  await expect(strip.locator('.scale-band-name')).toHaveText('CARBON DIOXIDE');
  await expect(strip.locator('.strip-thumb[aria-pressed="true"]')).toHaveCount(1);

  // by keyboard: the ends of the ruler, then one photo at a time, in the order of colour
  await input.focus();
  await page.keyboard.press('Home');
  const colours = [];
  for (let i = 0; i < count; i++) {
    const text = await input.getAttribute('aria-valuetext') ?? '';
    expect(text).toMatch(new RegExp(`^\\d\\.\\d{3} micrometres: photo ${i + 1} of ${count}, 2[56] February 2026, \\d\\d:\\d\\d UTC$`));
    colours.push(Number(text.slice(0, 5)));
    // the photo that is on is marked in the row of its night, and on the chart under it when it was measured
    await expect(strip.locator('.strip-thumb[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.chart-point.is-current')).toHaveCount((await readout.textContent() ?? '').includes('millijanskys') ? 1 : 0);
    await page.keyboard.press('ArrowRight');
  }
  expect(colours).toEqual([...colours].sort((a, b) => a - b));
  await page.keyboard.press('End');
  await expect(input).toHaveAttribute('aria-valuetext', new RegExp(`photo ${count} of ${count}`));
  await page.keyboard.press('ArrowRight');
  await expect(input).toHaveAttribute('aria-valuetext', new RegExp(`photo ${count} of ${count}`));
  // outside the band the readout no longer says "inside"
  await expect(readout).not.toContainText('inside the band');

  // by pointer: a small photo is a button
  const inBand = strip.locator('.strip-thumb[data-inside="true"]').first();
  await inBand.click();
  await expect(inBand).toHaveAttribute('aria-pressed', 'true');
  await expect(input).toHaveAttribute('aria-valuetext', new RegExp(`photo \\d+ of ${count}`));
  await expect(readout).toContainText('inside the band of carbon dioxide');
  // the brightness the readout gives is the number of the table
  const shown = await page.locator('.chart-point.is-current').getAttribute('data-photo');
  await expect(readout).toContainText(`${NUMBERS[`lemmon.frame.${shown}.flux`].text} millijanskys`);
  expect(problems).toEqual([]);
});

test('comet: the page says what it does not claim, and keeps to the words it may use', async ({ page }) => {
  await page.goto('lemmon.html');
  await walk(page);
  const words = await page.locator('main').innerText();
  for (const word of ['only', 'first', 'discovery', 'discovered', 'moved', 'swells', 'swell']) expect(words.toLowerCase().split(/[^a-z]+/), word).not.toContain(word);
  await expect(page.locator('#not-claimed + ul')).toContainText('How much carbon dioxide');
  await expect(page.locator('#leave-one-out + p')).toContainText(NUMBERS['lemmon.contrast.feb25.nopeak'].text);
  await expect(page.locator('table.leftout tr[data-role="peak"]')).toHaveCount(2);
});

// ---- by keyboard alone ----

test('by keyboard alone: every control of the three pages is reached with Tab, shows where focus is, and works with Enter or Space', async ({ page }) => {
  /** Tab through the page and name what takes focus. @param {number} most */
  const tabThrough = async (most) => {
    /** @type {string[]} */
    const seen = [];
    for (let i = 0; i < most; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const s = getComputedStyle(e), holder = e.closest('.cfilter-choice');
        const ring = holder ? getComputedStyle(holder) : s;
        return { what: `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${String(e.className).split(' ').filter(Boolean).join('.')}${[...e.attributes].filter((a) => a.name.startsWith('data-')).map((a) => `[${a.name}]`).join('')}`, ring: ring.outlineStyle !== 'none' && parseFloat(ring.outlineWidth) >= 2 };
      });
      if (!at) break;
      expect(at.ring, `focus can be seen on ${at.what}`).toBe(true);
      seen.push(at.what);
    }
    return seen;
  };

  await page.goto('targets.html');
  await walk(page);
  const targets = await tabThrough(110);
  for (const part of ['a.skip-link', 'a.check-link[data-check]', '[data-play]', '[data-flip]', 'button.btn.btn-toggle.jump-toggle', 'summary']) {
    expect(targets.some((what) => what.includes(part)), `targets.html: ${part} is reached (${targets.slice(0, 14).join(' ')})`).toBe(true);
  }
  await page.locator('#eps-indi-b [data-flip]').focus();
  const before = await page.locator('#eps-indi-b .plate-live').getAttribute('data-shows');
  await page.keyboard.press('Enter');
  await expect(page.locator('#eps-indi-b .plate-live')).not.toHaveAttribute('data-shows', /** @type {string} */ (before));
  await page.locator('#eps-indi-b .jump-toggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#eps-indi-b .tcard-jump')).toHaveClass(/is-bare/);
  await page.locator('#eps-indi-b .tcard-jump summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#eps-indi-b .tcard-jump details')).toHaveAttribute('open', '');

  await page.goto('lemmon.html');
  await walk(page);
  const comet = await tabThrough(60);
  for (const part of ['a.check-link[data-check]', '[data-play]', '[data-flip]', 'input#strip-colour.scale-input', 'button.strip-thumb', 'summary', 'div.table-scroll']) {
    expect(comet.some((what) => what.includes(part)), `lemmon.html: ${part} is reached (${comet.slice(0, 14).join(' ')})`).toBe(true);
  }
  await page.locator('.strip-thumb').nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.strip-thumb').nth(1)).toHaveAttribute('aria-pressed', 'true');

  await page.goto('checks.html');
  const checks = await tabThrough(40);
  for (const part of ['input', 'li>a', 'summary']) {
    const hit = part === 'li>a' ? checks.some((what) => what === 'a.') : checks.some((what) => what.startsWith(part));
    expect(hit, `checks.html: ${part} is reached (${checks.slice(0, 14).join(' ')})`).toBe(true);
  }
  // the filter is one group: the arrows move the choice, and the cards follow
  await page.locator('.cfilter input[value="all"]').focus();
  await page.keyboard.press('ArrowRight');
  const chosen = await page.locator('.cfilter input:checked').getAttribute('value');
  expect(chosen).not.toBe('all');
  const visible = await page.locator('.ccard').evaluateAll((list) => list.filter((e) => /** @type {HTMLElement} */ (e).offsetParent !== null).map((e) => /** @type {HTMLElement} */ (e).dataset.status));
  expect(new Set(visible)).toEqual(new Set([chosen]));
  await expect(page.locator('[data-filter-status]')).toContainText(`Showing ${visible.length} of ${ROWS.length} checks`);
});

// ---- what a reader who cannot see the page is given ----

for (const file of MADE) {
  test(`${file}: pictures say what they show, controls have names, headings go down a step at a time, and ids are not used twice`, async ({ page }) => {
    await page.goto(file);
    await walk(page);
    const found = await page.evaluate(() => {
      const name = (/** @type {Element} */ e) => (e.getAttribute('aria-label') ?? '') || [...(e.getAttribute('aria-labelledby') ?? '').split(' ')].map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
        || (e.textContent ?? '').trim() || [...e.querySelectorAll('img')].map((img) => img.alt).join(' ').trim();
      const out = { noAlt: /** @type {string[]} */ ([]), noName: /** @type {string[]} */ ([]), twice: /** @type {string[]} */ ([]), dangling: /** @type {string[]} */ ([]), jumps: /** @type {string[]} */ ([]), unlabelled: /** @type {string[]} */ ([]), tables: /** @type {string[]} */ ([]) };
      for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt') || (img.alt === '' && !img.closest('[aria-hidden="true"]'))) out.noAlt.push(img.src);
      for (const e of document.querySelectorAll('button, a[href], summary, [role="img"], [role="group"]')) if (name(e) === '') out.noName.push(e.outerHTML.slice(0, 120));
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      out.twice = ids.filter((id, i) => ids.indexOf(id) !== i);
      for (const e of document.querySelectorAll('[aria-labelledby], [aria-describedby], label[for]')) {
        for (const id of `${e.getAttribute('aria-labelledby') ?? ''} ${e.getAttribute('aria-describedby') ?? ''} ${e.getAttribute('for') ?? ''}`.split(' ').filter(Boolean)) if (!document.getElementById(id)) out.dangling.push(id);
      }
      let last = 0;
      for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (/** @type {HTMLElement} */ (h).offsetParent === null) continue;
        const level = Number(h.tagName[1]);
        if (level > last + 1) out.jumps.push(`${h.tagName} "${(h.textContent ?? '').slice(0, 40)}" after h${last}`);
        last = level;
      }
      for (const e of document.querySelectorAll('input, select, textarea')) {
        const input = /** @type {HTMLInputElement} */ (e);
        if (!input.labels?.length && !input.getAttribute('aria-label')) out.unlabelled.push(input.outerHTML.slice(0, 100));
      }
      for (const t of document.querySelectorAll('table')) {
        if (!t.querySelector('th[scope="col"]')) out.tables.push('a table without column headings');
        if (t.closest('.table-scroll')?.getAttribute('tabindex') !== '0') out.tables.push('a table that may scroll cannot take focus');
      }
      return out;
    });
    expect(found).toEqual({ noAlt: [], noName: [], twice: [], dangling: [], jumps: [], unlabelled: [], tables: [] });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // text on the page is light on dark: no text of the content is fainter than the faintest text colour of the site
    const faint = await page.evaluate(() => {
      const lum = (/** @type {string} */ c) => {
        const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => { const s = Number(v) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = lum(getComputedStyle(document.body).backgroundColor);
      /** @type {string[]} */
      const low = [];
      const walker = document.createTreeWalker(/** @type {Element} */ (document.querySelector('main')), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const e = n.parentElement;
        // a button, a chip of the filter and a word on a photo have a ground of their own
        if (!e || !(n.textContent ?? '').trim() || e.closest('svg, .visually-hidden, [hidden], .plate-tag, .cfilter-choice, .btn, [data-on], [data-panel]') || /** @type {HTMLElement} */ (e).offsetParent === null) continue;
        const s = getComputedStyle(e);
        if (s.visibility === 'hidden') continue;
        const ratio = (lum(s.color) + 0.05) / (bg + 0.05);
        if (ratio < 4.5) low.push(`${ratio.toFixed(2)} ${e.tagName}.${e.className}: ${(n.textContent ?? '').trim().slice(0, 30)}`);
      }
      return [...new Set(low)];
    });
    expect(faint).toEqual([]);
  });
}

// ---- the parts that are shown only when their checks allow them ----

test.describe('with a gallery, "Can you spot it?" and Pluto allowed (made-up data)', () => {
  const optional = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'v4', 'optional.json'), 'utf8'));
  const body = makePages(withOptional(loadSite(), optional), readPages()).pages['targets.html'];
  const picture = path.join(SITE, 'data', 'targets', 'eps-indi-b', 'wise2010.png');

  test.beforeEach(async ({ page }) => {
    await page.route('**/targets.html', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
    await page.route(/\/data\/(gallery|spotit|pluto)\/[^?]*\.png$/, (route) => route.fulfill({ path: picture, contentType: 'image/png' }));
  });

  test('the three parts are on the page, after the five targets', async ({ page, baseURL }) => {
    const problems = watch(page, /** @type {string} */ (baseURL));
    await page.goto('targets.html');
    await walk(page);
    await expect(page.locator('#targets > article.tcard')).toHaveCount(5);
    await expect(page.getByRole('heading', { level: 2, name: 'More stars that moved' })).toBeVisible();
    await expect(page.locator('#gallery article.tcard')).toHaveCount(2);
    await expect(page.locator('#gallery article.tcard').first().getByRole('heading', { level: 3 })).toHaveText('GAIA DR3 101');
    await expect(page.locator('#gallery .tcard-open a').first()).toHaveAttribute('href', 'view.html?t=gallery/g101');
    await expect(page.getByRole('heading', { level: 2, name: 'Can you spot it?' })).toBeVisible();
    await expect(page.locator('#spot-it .spot')).toHaveCount(3);
    await expect(page.getByRole('heading', { level: 2, name: 'Pluto, photo by photo' })).toBeVisible();
    await expect(page.locator('#pluto img')).toBeVisible();
    // a star of the gallery: its two pictures side by side with their rings, then laid over each other and stepped
    const star = page.locator('#g101 .tcard-jump');
    await expect(star.locator('.jump-marks').first()).toBeVisible();
    await star.getByRole('button', { name: 'Flip' }).click();
    await expect(star.locator('.jump')).toHaveClass(/is-stacked/);
    await star.getByRole('button', { name: 'Side by side' }).click();
    await expect(star.locator('.jump')).not.toHaveClass(/is-stacked/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('"Can you spot it?" shows the ring after the tap, and keeps nothing', async ({ page, baseURL }) => {
    const problems = watch(page, /** @type {string} */ (baseURL));
    await page.goto('targets.html');
    const spots = page.locator('#spot-it .spot');
    await spots.first().scrollIntoViewIfNeeded();
    // before the tap: no ring, and no word that gives the answer away
    for (let i = 0; i < 3; i++) {
      await expect(spots.nth(i).locator('details')).not.toHaveAttribute('open', '');
      for (const marks of await spots.nth(i).locator('.jump-marks').all()) await expect(marks).toBeHidden();
      await expect(spots.nth(i).locator('.spot-answer > p')).toBeHidden();
    }
    // the tap on the first pair, which holds a star that moved: its rings show, the other pairs stay closed
    await spots.nth(0).locator('summary').click();
    await expect(spots.nth(0).locator('.jump-marks')).toHaveCount(2);
    for (const marks of await spots.nth(0).locator('.jump-marks').all()) await expect(marks).toBeVisible();
    await expect(spots.nth(0).locator('.spot-answer > p')).toContainText('A star moved here.');
    for (const marks of await spots.nth(2).locator('.jump-marks').all()) await expect(marks).toBeHidden();
    // a pair that holds none says so, and has no ring to show
    await spots.nth(1).locator('summary').click();
    await expect(spots.nth(1).locator('.spot-answer > p')).toContainText('Nothing moved here.');
    await expect(spots.nth(1).locator('.jump-marks')).toHaveCount(0);
    // the two pictures of a pair can be laid over each other and blinked
    await spots.nth(2).getByRole('button', { name: 'Blink' }).click();
    await expect(spots.nth(2).locator('.jump')).toHaveClass(/is-stacked/);
    await expect.poll(() => spots.nth(2).locator('.jump').getAttribute('data-shows')).toBe('second');
    await expect.poll(() => spots.nth(2).locator('.jump').getAttribute('data-shows')).toBe('first');
    for (const marks of await spots.nth(2).locator('.jump-marks').all()) await expect(marks).toBeHidden();

    // nothing was kept, and nothing was sent
    const kept = await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
      bases: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
    }));
    expect(kept).toEqual({ local: 0, session: 0, cookie: '', bases: 0, caches: 0 });
    expect(problems).toEqual([]);
    // and when the page is opened again every answer is closed
    await page.reload();
    await expect(page.locator('#spot-it details[open]')).toHaveCount(0);
  });
});
