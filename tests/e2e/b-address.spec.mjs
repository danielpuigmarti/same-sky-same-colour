// The address and the box of the viewer: bad addresses say so, what was typed stays in the box, a stale name is
// dropped, the clicked place travels in the link, moving bodies are answered where the visitor is.
import { test, expect } from '@playwright/test';

test('an address with a position that cannot be read says so and offers the box, with the raw text in it', async ({ page }) => {
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  for (const [address, text, given] of [['ra=abc&dec=2', 'abc 2', true], ['ra=400x&dec=100', '400x 100', true], ['ra=10', '10', false], ['dec=95&ra=3', '3 95', true]]) {
    await page.goto(`view.html?${address}`);
    await expect(page.locator('#plan .state'), address).toHaveAttribute('data-state', 'page-bad-address');
    await expect(page.locator('#plan .state-title')).toHaveText(given ? 'The position in this address is not valid.' : 'This address does not give a sky position.');
    await expect(page.locator('#where'), address).toHaveValue(text);
    await expect(page.locator('#stage')).toBeHidden();
  }
});

test('an unknown target lists the five and offers the box', async ({ page }) => {
  await page.goto('view.html?t=bogus');
  await expect(page.locator('#plan .state')).toHaveAttribute('data-state', 'page-no-target');
  await expect(page.locator('#plan .state-next')).toContainText('Barnard’s Star, Epsilon Indi B, WISE 0855−0714, RW Aurigae, R Draconis');
  await expect(page.locator('#plan .state-next')).toContainText('box above');
  await expect(page.locator('#stage')).toBeHidden();
});

test('typed coordinates stay in the box and in the title, after a reload and after going back', async ({ page }) => {
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html');
  const box = page.locator('#where');
  await box.fill('200 -30');
  await box.press('Enter');
  await page.waitForURL(/ra=200&dec=-30/);
  await expect(box).toHaveValue('200 -30');
  await expect(page).toHaveTitle(/^200\.0000° −30\.0000° · /);
  await page.reload();
  await expect(box).toHaveValue('200 -30');
  await page.goto('view.html?t=barnard');
  await page.goBack();
  await expect(box).toHaveValue('200 -30');
});

test('a name in the address that is not at its coordinates is dropped; one that is stays', async ({ page }) => {
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html?ra=10&dec=20&q=m57');
  await expect(page.locator('#where')).toHaveValue('10 20');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('10.0000° +20.0000°');
  expect(new URL(page.url()).search).toBe('?ra=10&dec=20');
  await page.goto('view.html?ra=283.396251&dec=33.029152&q=Ring%20Nebula');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('RING NEBULA');
  await expect(page.locator('#where')).toHaveValue('Ring Nebula');
});

test('the link carries the clicked place, and opening it marks the place and gives the same answers', async ({ page, context }) => {
  await page.goto('view.html?t=barnard');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  const box = await page.locator('#stage .stage-canvas').first().boundingBox();
  if (!box) throw new Error('no picture');
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.55);
  await expect(page.locator('.view-answer [data-answer="real"]')).toHaveAttribute('data-ready', 'true');
  await expect(page).toHaveURL(/[?&]at=\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  const answers = await page.locator('.view-answer').innerText();
  const fresh = await context.newPage();
  await fresh.goto(page.url());
  await expect(fresh.locator('.view-answer [data-answer="real"]')).toHaveAttribute('data-ready', 'true');
  expect(await fresh.locator('.view-answer').innerText()).toBe(answers);
  await expect(fresh.locator('#stage .stage-pick').first()).toHaveAttribute('d', /M/);
  expect(fresh.url()).toBe(page.url());
  // Escape takes the place out of the address
  await fresh.keyboard.press('Escape');
  await expect(fresh).not.toHaveURL(/at=/);
  // old addresses, and addresses with a place that makes no sense or lies off the picture, still open
  for (const old of ['view.html?t=barnard', 'view.html?t=barnard&at=junk', 'view.html?t=barnard&at=1,2']) {
    await fresh.goto(old);
    await expect(fresh.locator('#stage .stage-canvas').first()).toBeVisible();
    await expect(fresh.locator('.view-answer')).toHaveAttribute('data-empty', 'true');
  }
  await expect(fresh).not.toHaveURL(/at=1,2/);
});

test('Space on a focused view button chooses that view', async ({ page }) => {
  await page.goto('view.html?t=barnard');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  const curtain = page.locator('#stage .stage-mode[data-mode="curtain"]');
  await curtain.focus();
  await page.keyboard.press('Space');
  await expect(curtain).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#stage .stage-mode[data-mode="blink"]')).toHaveAttribute('aria-pressed', 'false');
  const side = page.locator('#stage .stage-mode[data-mode="side"]');
  await side.focus();
  await page.keyboard.press('Space');
  await expect(side).toHaveAttribute('aria-pressed', 'true');
});

test('a planet or the Sun typed in the viewer stays there, says why, and links to the comet page', async ({ page }) => {
  for (const name of ['Jupiter', 'sun', 'The Moon']) {
    await page.goto('view.html');
    const box = page.locator('#where');
    await box.fill(name);
    await box.press('Enter');
    await expect(page).toHaveURL(/view\.html\?q=/);
    await expect(page.locator('#plan .state')).toBeVisible();
    await expect(page.locator('#plan .state-title')).toContainText('this tool shows fixed places.');
    await expect(page.locator('#plan .state a[href="lemmon.html"]')).toBeVisible();
  }
});

test('a planet or the Sun typed on the home page stays there, says why, and links to the comet page', async ({ page }) => {
  await page.goto('');
  const box = page.getByLabel('Type a star’s name or a sky position').first();
  const here = page.url();
  await box.fill('Mars');
  await box.press('Enter');
  const message = page.locator('#where-message');
  await expect(message).toContainText('Mars wanders among the stars from night to night; this tool shows fixed places.');
  await expect(message.locator('a')).toHaveAttribute('href', 'lemmon.html');
  expect(page.url()).toBe(here);
  await expect(box).toBeFocused();
  // a click on the row of the suggestions still leads to the comet's page
  await box.fill('Jupiter');
  await expect(page.locator('[data-suggest-option]').first()).toHaveAttribute('data-href', 'lemmon.html');
});

test('on a small phone the message of the box on the home page is brought into view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('');
  const box = page.getByLabel('Type a star’s name or a sky position').first();
  await box.fill('blorp');
  await box.press('Enter');
  const message = page.locator('#where-message');
  await expect(message).toContainText('does not read as a sky position');
  await expect.poll(async () => message.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
});

test('a comet name does not ask for a card that does not exist', async ({ page }) => {
  const missing = /** @type {string[]} */ ([]);
  page.on('response', (r) => { if (r.status() >= 400) missing.push(r.url()); });
  await page.goto('view.html?q=Lemmon');
  await expect(page.locator('#view-named')).toContainText('The page of the comet');
  await page.waitForTimeout(800);
  expect(missing).toEqual([]);
});

test('a photo shown alone says which visit it belongs to, so that its date and the date in the sentence agree', async ({ page }) => {
  await page.goto('view.html?t=rw-aur&det=1');
  await expect(page.locator('#view-lede')).toContainText('passes of SPHEREx over this place');
  const [, first, second] = /place, (\d+ \w+ \d+) and (\d+ \w+ \d+)/.exec(await page.locator('#view-lede').innerText()) ?? [];
  const short = (/** @type {string} */ d) => d.replace(/^(\d+) (\w{3})\w* /, '$1 $2 ');
  const captions = page.locator('#stage .stage-caption');
  // one pair of photos on its own, instead of all of them added up
  await page.locator('#colours .view-choice').nth(1).click();
  await expect(captions.first()).toContainText('UTC');
  await expect(captions.first()).toContainText(`1 photo of the visit of ${short(first)}`);
  await page.locator('#stage .stage-mode[data-mode="side"]').click();
  await expect(captions.last()).toContainText(`1 photo of the visit of ${short(second)}`);
});

test('the message for an address that cannot be read is on the page, not hidden with the start page', async ({ page }) => {
  await page.addInitScript(() => { /** @type {any} */ (window).viewerOptions = { live: false }; });
  await page.goto('view.html?ra=abc&dec=2');
  await expect(page.locator('#plan .state')).toBeVisible();
  await expect(page.locator('#plan .state')).toContainText('box above');
});
