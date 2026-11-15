// Every page loads: no console error, no failed request, no request to a host other than the site and the
// archive bucket, and the frame that all pages share is in place.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { BUCKET_HOSTS } from '../../site/js/contracts.js';

const NAME = JSON.parse(readFileSync(new URL('../../site/data/site.json', import.meta.url), 'utf8')).name;

const PAGES = [
  { file: '', title: NAME, current: './' },
  { file: 'view.html', title: `Viewer · ${NAME}`, current: 'view.html' },
  { file: 'lemmon.html', title: `The comet · ${NAME}`, current: 'lemmon.html' },
  { file: 'targets.html', title: `Five targets · ${NAME}`, current: 'targets.html' },
  { file: 'checks.html', title: `Checks · ${NAME}`, current: 'checks.html' },
  { file: 'why.html', title: `Why · ${NAME}`, current: 'why.html' },
];

for (const { file, title, current } of PAGES) {
  test(`${file || 'index.html'} loads clean and has the shared frame`, async ({ page, baseURL }) => {
    const origin = new URL(/** @type {string} */ (baseURL)).origin;
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const loaded = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.origin !== origin && !BUCKET_HOSTS.includes(u.host)) problems.push(`request to another host: ${r.url()}`);
    });
    page.on('response', (r) => {
      loaded.push(new URL(r.url()).pathname.split('/').pop() ?? '');
      if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`);
    });

    await page.goto(file, { waitUntil: 'load' });

    await expect(page).toHaveTitle(title);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    for (const sheet of ['tokens.css', 'base.css', 'components.css']) expect(loaded).toContain(sheet);

    // landmarks: one header, one navigation of pages, one main, one footer; one top heading
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Pages' })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

    // the header names the site and marks the page we are on; the footer names the source of the images
    await expect(page.locator('.masthead-name')).toHaveText(NAME);
    await expect(page.locator('.masthead [aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.masthead [aria-current="page"]')).toHaveAttribute('href', current);
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link')).toHaveText(['Bulletin', 'Blink a place', 'The comet', 'Five targets', 'Checks', 'Why']);
    await expect(page.locator('[data-edition-toggle]')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText(NAME);
    await expect(page.getByRole('contentinfo')).toContainText('SPHEREx');

    // the styles are the shared ones: the night edition by default, black paper and warm off-white ink
    const colours = await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      return [document.documentElement.dataset.edition, s.backgroundColor, s.color];
    });
    expect(colours).toEqual(['night', 'rgb(12, 11, 8)', 'rgb(241, 234, 214)']);

    expect(problems).toEqual([]);
  });
}

test('the edition control switches to the day edition, remembers it on this device, and switches back', async ({ page }) => {
  await page.goto('');
  const toggle = page.locator('[data-edition-toggle]');
  await expect(toggle).toHaveText('Day edition');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-edition', 'day');
  await expect(toggle).toHaveText('Night edition');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 239, 214)');
  await page.goto('targets.html');
  await expect(page.locator('html')).toHaveAttribute('data-edition', 'day');
  await page.locator('[data-edition-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-edition', 'night');
});

test('the first Tab reaches a visible skip link, and focus can be seen on every link of the header', async ({ page }) => {
  await page.goto('');
  await page.keyboard.press('Tab');
  const skip = page.locator('.skip-link');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const s = getComputedStyle(/** @type {Element} */ (document.activeElement));
      return { style: s.outlineStyle, width: s.outlineWidth, colour: s.outlineColor, inHeader: Boolean(document.activeElement?.closest('.masthead')) };
    });
    expect(outline).toEqual({ style: 'solid', width: '3px', colour: 'rgb(241, 234, 214)', inHeader: true });
  }
});

test('every page fits a window 360 px wide', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  for (const { file } of PAGES) {
    await page.goto(file);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll, file || 'index.html').toBeLessThanOrEqual(client);
  }
});

test('the links of the header lead to the five pages', async ({ page }) => {
  await page.goto('');
  for (const { file, title } of PAGES.slice(1)) {
    await page.locator(`.masthead-nav a[href="${file}"]`).click();
    await expect(page).toHaveTitle(title);
  }
  await page.locator('.masthead-name').click();
  await expect(page).toHaveTitle(PAGES[0].title);
});

test('on a phone the six page links stand on one line, each at least 24 px high, at 360, 375, 390 and 414 px, in both editions', async ({ page }) => {
  for (const [edition, width] of [['night', 360], ['night', 375], ['night', 390], ['night', 414], ['day', 360], ['day', 414]]) {
    await page.addInitScript((e) => { try { localStorage.setItem('same-sky-same-colour:edition', e); } catch { /* closed */ } }, edition);
    await page.setViewportSize({ width, height: 800 });
    for (const { file } of PAGES) {
      await page.goto(file);
      await page.evaluate(() => document.fonts.ready);
      const boxes = await page.locator('.masthead-nav a').evaluateAll((list) => list.map((a) => { const r = a.getBoundingClientRect(); return { top: Math.round(r.top), height: r.height, right: r.right }; }));
      expect(boxes, `${file || 'index'} at ${width}`).toHaveLength(6);
      expect(new Set(boxes.map((b) => b.top)).size, `${file || 'index'} at ${width}: one line`).toBe(1);
      for (const b of boxes) { expect(b.height).toBeGreaterThanOrEqual(24); expect(b.right).toBeLessThanOrEqual(width - 8); }
    }
  }
});

test('404.html finds its styles and links from a deep address on the live site', async ({ page, baseURL }) => {
  const root = new URL(/** @type {string} */ (baseURL));
  const html = readFileSync(new URL('../../site/404.html', import.meta.url), 'utf8');
  // the host serves 404.html at the mistyped address, whatever its depth: here a github.io project site
  await page.route('http://stars.github.io/same-sky-same-colour/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.includes('/nope/')) return route.fulfill({ status: 404, contentType: 'text/html', body: html });
    const res = await page.request.get(new URL(u.pathname.replace('/same-sky-same-colour/', root.pathname), root).href);
    return route.fulfill({ status: res.status(), headers: { 'content-type': res.headers()['content-type'] ?? 'application/octet-stream' }, body: await res.body() });
  });
  await page.goto('http://stars.github.io/same-sky-same-colour/nope/deep/x');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 11, 8)');
  await expect(page.locator('.masthead-nav a[href="view.html"]')).toHaveJSProperty('href', 'http://stars.github.io/same-sky-same-colour/view.html');
  // and the file itself, opened in its own folder
  await page.goto('404.html');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 11, 8)');
  await expect(page.locator('.masthead-nav a[href="view.html"]')).toHaveJSProperty('href', new URL('view.html', root).href);
});
