// The reading under the pointer: the receipt that "Copy this reading" puts on the clipboard, the one sentence about a
// saturated centre, and the flag words kept in a detail. Prepared targets only: nothing is read from the archive.
import { test, expect } from '@playwright/test';

/** Click the middle of the picture. @param {import('@playwright/test').Page} page */
async function clickMiddle(page) {
  await page.locator('#stage .stage-canvas').first().scrollIntoViewIfNeeded();
  const box = await page.locator('#stage .stage-canvas').first().boundingBox();
  if (!box) throw new Error('no picture');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('"Copy this reading" copies a plain receipt: position, colour, brightness or why none, flags, time, archive address', async ({ page }) => {
  await page.addInitScript(() => {
    /** @type {any} */ (window).__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (/** @type {string} */ t) => { /** @type {any} */ (window).__copied.push(t); } }, configurable: true });
  });
  await page.goto('view.html?t=wise0855');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await clickMiddle(page);
  const button = page.getByRole('button', { name: 'Copy this reading' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('.hover-copy-state')).toHaveText('Copied');
  const text = await page.evaluate(() => /** @type {any} */ (window).__copied.at(-1));
  expect(text).toMatch(/^One pixel of a SPHEREx photo, read on Same Sky, Same Colour/);
  expect(text).toMatch(/Sky position: RA \d+\.\d{4}°, Dec [+-]\d+\.\d{4}° \(ICRS\)/);
  expect(text).toMatch(/Colour: (\d\.\d{3} µm|not known for this pixel)/);
  expect(text).toMatch(/Brightness: (-?\d|none|no value)/);
  expect(text).toMatch(/Flags: /);
  expect(text).toMatch(/Photo taken: \d+ [A-Z][a-z]{2} 20\d\d, \d\d:\d\d UTC/);
  const archive = text.split('\n').filter((/** @type {string} */ l) => l.startsWith('Archive: '));
  expect(archive.length).toBeGreaterThan(0);
  for (const line of archive) expect(line).toMatch(/^Archive: https:\/\/\S+\/dr1\/level2\/\S+\.fits$/);
  expect(text).toMatch(/View: http\S+t=wise0855/);
});

test('a saturated centre is explained in one sentence, and the flag words wait in a detail', async ({ page }) => {
  await page.goto('view.html?t=barnard');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  const note = page.locator('.view-saturated');
  await expect(note).toBeVisible();
  await expect(note).toContainText('The pink hatching marks pixels that are saturated or damaged');
  await expect(note).toContainText('no brightness is given');
  await expect(note).toContainText('Difference view');
  const flags = page.locator('.hover-flags');
  await expect(flags).toBeVisible();
  await expect(flags).not.toHaveAttribute('open', '');
  await expect(flags.locator('summary')).toContainText(/\d flags? set/);
  await expect(flags).toContainText('OVERFLOW');
  // the position is written once in the facts: no RA and Dec tiles beside the readout's position
  await expect(page.locator('#view-where [data-cell="ra"]')).toHaveCount(0);
});

test('the line that says what the chosen view does stands directly under the choice of views', async ({ page }) => {
  await page.goto('view.html?t=wise0855');
  const modes = page.locator('#stage .stage-modes'), hint = page.locator('#stage .stage-hint');
  await expect(hint).toContainText('Blink shows');
  await expect(page.locator('#stage .stage-pictures')).toBeVisible();   // the pictures come after the line
  const a = await modes.boundingBox(), b = await hint.boundingBox(), pic = await page.locator('#stage .stage-pictures').boundingBox();
  if (!a || !b || !pic) throw new Error('no boxes');
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
  expect(b.y + b.height).toBeLessThanOrEqual(pic.y + 1);
  await page.getByRole('button', { name: 'Curtain' }).click();
  await expect(hint).toContainText('Curtain puts the earlier visit left of the line');
});
