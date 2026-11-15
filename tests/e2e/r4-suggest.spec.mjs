// The suggestions under the box (site/js/ui/suggest.js) in a browser: typing, the arrow keys, Enter, Escape, the ARIA
// attributes at each step, and that nothing leaves the site while a visitor types. The component is mounted on a
// small page of its own (tests/e2e/r4-suggest-page.html), served at the site's root for the test.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('./r4-suggest-page.html', import.meta.url), 'utf8');

/** @param {import('@playwright/test').Page} page  @param {string} [query] `?stay`: a row's address is kept, not opened. */
async function open(page, query = '?stay') {
  await page.route('**/r4-suggest-page.html*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: PAGE }));
  /** @type {string[]} */
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`r4-suggest-page.html${query}`);
  return requests;
}

const box = (/** @type {import('@playwright/test').Page} */ page) => page.getByRole('combobox');
const options = (/** @type {import('@playwright/test').Page} */ page) => page.locator('[data-suggest-option]');
const went = (/** @type {import('@playwright/test').Page} */ page) => page.evaluate(() => /** @type {any} */ (window).__went);

/** The ARIA contract of the combobox at one moment. @param {import('@playwright/test').Page} page */
async function aria(page) {
  const input = box(page);
  const list = page.locator('[data-suggest-list]');
  const selected = page.locator('[data-suggest-option][aria-selected="true"]');
  const active = await input.getAttribute('aria-activedescendant');
  return {
    open: (await input.getAttribute('aria-expanded')) === 'true',
    controls: (await input.getAttribute('aria-controls')) === (await list.getAttribute('id')),
    hidden: await list.evaluate((el) => el.hidden),
    count: await options(page).count(),
    selected: await selected.count(),
    activeIsSelected: active === null ? null : (await selected.getAttribute('id')) === active,
    active,
  };
}

test('the box is a combobox that owns a listbox, closed until it is used', async ({ page }) => {
  await open(page);
  const input = box(page);
  await expect(input).toHaveAttribute('aria-autocomplete', 'list');
  await expect(input).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-suggest-list]')).toHaveAttribute('role', 'listbox');
  await expect(page.locator('[data-suggest-list]')).toBeHidden();
  await expect(page.locator('[data-suggest-status]')).toHaveAttribute('role', 'status');
  expect(await aria(page)).toMatchObject({ open: false, hidden: true, count: 0, controls: true, active: null });
});

test('an empty box with the focus shows the good first places, each with what the visitor will see', async ({ page }) => {
  await open(page);
  await box(page).focus();
  await expect(options(page)).toHaveCount(8);
  expect(await aria(page)).toMatchObject({ open: true, hidden: false, selected: 0, active: null, controls: true });
  const first = options(page).first();
  await expect(first).toHaveAttribute('data-type', 'first');
  await expect(first).toHaveAttribute('role', 'option');
  await expect(first.locator('[data-suggest-label]')).toHaveText('Epsilon Indi B');
  await expect(first.locator('[data-suggest-note]')).not.toBeEmpty();
  await expect(options(page).nth(5).locator('[data-suggest-label]')).toHaveText('Ring Nebula');
  await expect(page.locator('[data-suggest-status]')).toContainText('8 places to start with');
  // Escape closes it, and the box stays empty
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-suggest-list]')).toBeHidden();
  await expect(box(page)).toHaveAttribute('aria-expanded', 'false');
  // typing replaces the first places by suggestions
  await page.keyboard.type('barn');
  await expect(options(page).first().locator('[data-suggest-label]')).toHaveText("Barnard's Star");
  // emptying the box brings them back
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect(options(page)).toHaveCount(8);
  await expect(options(page).first()).toHaveAttribute('data-type', 'first');
});

test('typing, the arrow keys and Enter, with the ARIA attributes at each step', async ({ page }) => {
  await open(page);
  const input = box(page);
  await input.focus();
  await page.keyboard.press('Escape');
  await page.keyboard.type('barn');
  // 1. typed: the list is open, no row is active
  await expect(options(page).first()).toBeVisible();
  let a = await aria(page);
  expect(a).toMatchObject({ open: true, hidden: false, controls: true, selected: 0, active: null });
  expect(a.count).toBeGreaterThanOrEqual(2);
  const n = a.count;
  await expect(options(page).first()).toHaveAttribute('data-type', 'target');
  await expect(options(page).first()).toHaveAttribute('data-href', 'view.html?t=barnard');
  await expect(page.locator('[data-suggest-status]')).toContainText(`${n} suggestions`);
  // 2. Down: the first row
  await page.keyboard.press('ArrowDown');
  a = await aria(page);
  expect(a).toMatchObject({ selected: 1, activeIsSelected: true });
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', /-suggestions-0$/);
  await expect(input).toBeFocused();
  // 3. Up from the first row goes round to the last, Down comes back
  await page.keyboard.press('ArrowUp');
  a = await aria(page);
  expect(a).toMatchObject({ selected: 1, activeIsSelected: true });
  await expect(options(page).nth(n - 1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
  // 4. Enter takes the active row
  await page.keyboard.press('Enter');
  expect(await went(page)).toBe('view.html?t=barnard');
  await expect(input).toHaveValue("Barnard's Star");
  expect(await aria(page)).toMatchObject({ open: false, hidden: true, active: null });
});

test('the rows suggest what the visitor may mean, forgive a typing mistake, and answer plainly for what moves', async ({ page }) => {
  await open(page);
  const input = box(page);
  const label = () => options(page).first().locator('[data-suggest-label]');
  const note = () => options(page).first().locator('[data-suggest-note]');
  await input.fill('m 57');
  await expect(label()).toHaveText('M 57');
  await expect(note()).toHaveText('Ring Nebula · planetary nebula');
  await input.fill('betelguese');
  await expect(label()).toHaveText('Betelgeuse');
  await input.fill('alf Lyr');
  await expect(label()).toHaveText('Alpha Lyrae');
  await expect(note()).toContainText('very bright: SPHEREx saturates');
  await input.fill('330.84 -56.79');
  await expect(options(page).first()).toHaveAttribute('data-type', 'position');
  await expect(label()).toHaveText('Go to RA 330.8400°, Dec −56.7900°');
  await input.fill('The Moon');
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toHaveAttribute('data-type', 'moving');
  await expect(label()).toHaveText('The Moon moves across the sky from day to day; this tool shows fixed places.');
  await expect(options(page).first()).toHaveAttribute('data-href', 'lemmon.html');
  await input.fill('qwertyuiop');
  await expect(options(page).first()).toHaveAttribute('data-type', 'lookup');
  // a half-typed position is not a name: no row, and the list closes
  await input.fill('12h30m');
  await expect(page.locator('[data-suggest-list]')).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});

test('the offer to look a text up submits the form; with no active row, Enter takes the first row', async ({ page }) => {
  await page.route('**/view.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<title>viewer</title>' }));
  await open(page, '');
  await box(page).fill('qwertyuiop');
  await expect(options(page).first()).toHaveAttribute('data-type', 'lookup');
  await page.keyboard.press('ArrowDown');
  await Promise.all([page.waitForURL(/view\.html\?q=qwertyuiop$/), page.keyboard.press('Enter')]);
  await page.goBack();
  await page.waitForURL(/r4-suggest-page/);
  await box(page).fill('vega');
  await Promise.all([page.waitForURL(/view\.html\?ra=[-\d.]+&dec=[-\d.]+&q=Vega$/), page.keyboard.press('Enter')]);
});

test('a row can be clicked; Escape closes the list and then clears the box; Tab leaves', async ({ page }) => {
  await open(page);
  const input = box(page);
  await input.fill('ring neb');
  await options(page).first().click();
  expect(await went(page)).toBe('view.html?ra=283.396251&dec=33.029152&q=Ring+Nebula');
  await input.fill('vega');
  await expect(options(page).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-suggest-list]')).toBeHidden();
  await expect(input).toHaveValue('vega');
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await input.fill('vega');
  await expect(options(page).first()).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-suggest-list]')).toBeHidden();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
});

test('a target that the page links to itself is opened where that link leads', async ({ page }) => {
  await open(page);
  await box(page).fill('lemmon');
  await expect(options(page).first()).toHaveAttribute('data-type', 'target');
  await expect(options(page).first()).toHaveAttribute('data-href', 'lemmon.html');
});

test('while a visitor types, no request leaves the site and none carries the text', async ({ page }) => {
  const requests = await open(page);
  const origin = new URL(page.url()).origin;
  await box(page).pressSequentially('betelguese and the orion nebula', { delay: 15 });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.filter((u) => !u.startsWith(origin)), 'requests to other hosts').toEqual([]);
  const data = requests.filter((u) => /\/data\//.test(u)).map((u) => new URL(u).pathname.split('/').pop());
  expect(data.sort()).toEqual(['first-places.json', 'names.json', 'places.json']);
  expect(requests.filter((u) => /betelg|orion|%20|\+and/i.test(u))).toEqual([]);
});

for (const [width, name] of /** @type {[number, string][]} */ ([[360, 'a phone'], [1280, 'a desktop']])) {
  test(`the list fits ${name} (${width} px wide), under the box, in both editions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    for (const edition of ['night', 'day']) {
      await page.evaluate((e) => { if (e === 'day') document.documentElement.dataset.edition = 'day'; else delete document.documentElement.dataset.edition; }, edition);
      await box(page).fill('');
      await box(page).fill('an');
      await expect(options(page).first()).toBeVisible();
      const m = await page.evaluate(() => {
        const input = /** @type {HTMLElement} */ (document.querySelector('input'));
        const list = /** @type {HTMLElement} */ (document.querySelector('[data-suggest-list]'));
        const a = input.getBoundingClientRect(), l = list.getBoundingClientRect();
        const row = /** @type {HTMLElement} */ (list.querySelector('[data-suggest-option]')).getBoundingClientRect();
        const s = getComputedStyle(list);
        return { inputBottom: a.bottom, listTop: l.top, left: l.left, right: l.right, rowHeight: row.height, scrollWidth: document.documentElement.scrollWidth, innerWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
      });
      expect(m.listTop, edition).toBeGreaterThanOrEqual(m.inputBottom - 1);
      expect(m.listTop, edition).toBeLessThan(m.inputBottom + 4);
      expect(m.left, edition).toBeGreaterThanOrEqual(0);
      expect(m.right, edition).toBeLessThanOrEqual(m.innerWidth);
      expect(m.scrollWidth, edition).toBeLessThanOrEqual(m.innerWidth);
      expect(m.rowHeight, edition).toBeGreaterThanOrEqual(44);
      expect([m.radius, m.shadow]).toEqual(['0px', 'none']);
      await page.keyboard.press('ArrowDown');
      const colours = await page.evaluate(() => {
        const row = /** @type {HTMLElement} */ (document.querySelector('[aria-selected="true"]'));
        const other = /** @type {HTMLElement} */ (document.querySelectorAll('[data-suggest-option]')[1]);
        return [getComputedStyle(row).backgroundColor, getComputedStyle(other).backgroundColor, getComputedStyle(row).color];
      });
      expect(colours[0], `${edition}: the active row is filled`).not.toBe(colours[1]);
      expect(colours[0]).not.toBe(colours[2]);
    }
  });
}
