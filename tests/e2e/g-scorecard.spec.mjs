// The challenge scorecard on the first page: one line for each line of challenge.json, the status the file gives, a
// link that opens, nothing wider than the screen at 360 px, and the same list with scripts off.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT } from '../fixtures/v4/make.mjs';

const ITEMS = JSON.parse(readFileSync(path.join(ROOT, 'site', 'data', 'challenge.json'), 'utf8')).items;
const WORDS = { built: 'Built', partial: 'Partly built', 'not built': 'Not built' };

/** @param {import('@playwright/test').Page} page */
async function readList(page) {
  const rows = page.locator('.scorecard > .score');
  await expect(rows).toHaveCount(ITEMS.length);
  for (const [k, item] of ITEMS.entries()) {
    const row = rows.nth(k);
    await expect(row).toHaveAttribute('data-status', item.status);
    await expect(row.locator('.score-status')).toHaveText(WORDS[/** @type {keyof typeof WORDS} */ (item.status)]);
    await expect(row.locator('.score-line')).toContainText(item.line.replace(/'/g, '’'));
  }
}

test('the scorecard lists every line of the challenge, with the status of challenge.json', async ({ page }) => {
  await page.goto('./');
  await readList(page);
  await expect(page.locator('#results .scorecard')).toBeVisible();
});

test('each See it link of the scorecard opens a page of the site', async ({ page, request, baseURL }) => {
  await page.goto('./');
  const links = await page.locator('.scorecard .score-link a').evaluateAll((as) => as.map((a) => /** @type {HTMLAnchorElement} */ (a).href));
  expect(links.length).toBe(ITEMS.filter((i) => typeof i.where === 'string').length);
  for (const href of new Set(links.map((h) => h.split('#')[0]))) expect((await request.get(href)).status(), href).toBe(200);
  expect(links.every((h) => h.startsWith(/** @type {string} */ (baseURL)))).toBe(true);
});

test('with scripts off the scorecard reads the same', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto('./');
  await readList(page);
  await context.close();
});

test('at 360 px the scorecard does not widen the page', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, baseURL });
  const page = await context.newPage();
  await page.goto('./');
  await page.locator('.scorecard').scrollIntoViewIfNeeded();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(0);
  const over = await page.locator('.scorecard .score').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  expect(over).toBe(0);
  await context.close();
});
