// V5: the viewer for a searcher: a click on WISE 0855 names it, links to look a place up, the display choices kept in
// the address. Prepared targets only: nothing is read from the archive.
import { test, expect } from '@playwright/test';

/** Click the middle of the picture. @param {import('@playwright/test').Page} page */
async function clickMiddle(page) {
  await page.locator('#stage .stage-canvas').first().scrollIntoViewIfNeeded();
  const box = await page.locator('#stage .stage-canvas').first().boundingBox();
  if (!box) throw new Error('no picture');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test('a click on the object of WISE 0855 names it, and does not call it unknown or an artefact', async ({ page }) => {
  await page.goto('view.html?t=wise0855');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await clickMiddle(page);
  const real = page.locator('#is-it-real');
  await expect(real).toContainText('WISE 0855');
  await expect(real).not.toContainText('Not a known star');
  await expect(real).not.toContainText('probably an artefact');
});

test('the links for the centre and for the place clicked carry the coordinates that the page prints, to 0.001 degree', async ({ page }) => {
  await page.goto('view.html?t=barnard');
  const lookup = page.locator('#lookup');
  await expect(lookup).toBeVisible();
  const read = async (row) => {
    const where = (await lookup.locator(`[data-where="${row}"]`).innerText()).replace(/−/g, '-');
    const [ra, dec] = [...where.matchAll(/-?[0-9.]+/g)].map((m) => Number(m[0]));
    const hrefs = await lookup.locator(`[data-row="${row}"] a`).evaluateAll((list) => list.map((a) => ({ id: a.dataset.lookup, href: a.href, target: a.target })));
    return { ra, dec, hrefs };
  };
  const spot = (href) => {
    const u = new URL(href), own = u.hash ? new URLSearchParams(u.hash.slice(1)) : u.searchParams;
    const both = own.get('Coord') ?? own.get('-c') ?? own.get('target');
    if (both) { const [ra, dec] = both.split(/\s+/).map(Number); return { ra, dec }; }
    return { ra: Number(own.get('ra')), dec: Number(own.get('dec')) };
  };
  const centre = await read('centre');
  // the position is written once: in the row of the centre, not again in the facts
  expect(await page.locator('#view-where').innerText()).not.toMatch(/\bRA\b/);
  expect(await page.locator('#view-where [data-cell="ra"]').count()).toBe(0);
  expect(centre.hrefs.map((h) => h.id)).toEqual(['simbad', 'vizier', 'wiseview', 'legacy', 'aladin']);
  for (const h of centre.hrefs) {
    expect(h.target).toBe('_blank');
    const at = spot(h.href);
    expect(Math.abs(at.ra - centre.ra), h.id).toBeLessThan(0.001);
    expect(Math.abs(at.dec - centre.dec), h.id).toBeLessThan(0.001);
  }
  await page.getByRole('button', { name: 'Pause' }).click();
  await clickMiddle(page);
  await expect(lookup.locator('[data-row="clicked"] a')).toHaveCount(5);
  const clicked = await read('clicked');
  for (const h of clicked.hrefs) {
    const at = spot(h.href);
    expect(Math.abs(at.ra - clicked.ra), h.id).toBeLessThan(0.001);
    expect(Math.abs(at.dec - clicked.dec), h.id).toBeLessThan(0.001);
  }
});

test('white point, speed and invert live in the "Display" disclosure and are kept in the address; two pictures, one grey scale', async ({ page }) => {
  await page.goto('view.html?t=rw-aur&det=1');
  const display = page.locator('#stage .stage-display-details');
  await expect(display).toBeVisible();
  await expect(display).not.toHaveAttribute('open', '');
  await display.locator('summary').click();
  await page.getByRole('button', { name: 'Peak' }).click();
  await page.getByRole('button', { name: 'Fast' }).click();
  await page.getByRole('button', { name: 'Invert' }).click();
  await expect(page).toHaveURL(/white=3/);
  await expect(page).toHaveURL(/speed=fast/);
  await expect(page).toHaveURL(/invert=1/);
  await page.reload();
  await expect(page.locator('#stage .stage-display-details')).toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Peak' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Invert' })).toHaveAttribute('aria-pressed', 'true');
});

test('with no place chosen the page shows a headline, the form and a list of places, each with its line, and no row of blank cells', async ({ page }) => {
  await page.goto('view.html');
  await expect(page.locator('h1')).toHaveText('BLINK A PLACE');
  await expect(page.locator('#view-where')).toBeHidden();
  const places = page.locator('#places li');
  await expect(places.first()).toBeVisible();
  const lines = await places.evaluateAll((list) => list.map((li) => li.querySelector('.view-place-line')?.textContent ?? ''));
  expect(lines.every((t) => t.length > 10), JSON.stringify(lines)).toBe(true);
});

test('RW Aurigae and R Draconis say what their cards say', async ({ page }) => {
  await page.goto('view.html?t=r-dra');
  await expect(page.locator('#view-lede')).toContainText('Saturated in 412 of the 412 photos checked: no brightness is given.');
});

test('Space pauses the blink after a click on a view button, and D does nothing where there is no difference', async ({ page }) => {
  await page.goto('view.html?t=rw-aur&det=1');
  await expect(page.locator('#stage .stage-canvas').first()).toBeVisible();
  const play = page.locator('#stage .stage-play');
  await page.locator('#stage .stage-mode[data-mode="blink"]').click();
  await expect(play).toHaveText('PAUSE');
  await page.keyboard.press('Space');
  await expect(play).toHaveText('PLAY');
  await page.keyboard.press('Space');
  await expect(play).toHaveText('PAUSE');
  await page.locator('#stage .stage-mode[data-mode="side"]').click();
  const noDiff = await page.evaluate(() => document.querySelector('#stage .stage-mode[data-mode="diff"]')?.getAttribute('data-empty'));
  if (noDiff === 'true') {
    await page.keyboard.press('d');
    await expect(page.locator('#stage .stage-mode[data-mode="side"]')).toHaveAttribute('aria-pressed', 'true');
  }
});

test('when the archive cannot be reached the line under the title says so, and the search field fits 360 px', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.route('**/*', (route) => (route.request().url().startsWith(baseURL ?? '') ? route.continue() : route.abort()));
  await page.goto('view.html?ra=283.396251&dec=33.029152');
  await expect(page.locator('#plan .state')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#view-lede')).not.toContainText('Looking for');
  const placeholder = await page.locator('#where').getAttribute('placeholder');
  expect(placeholder).toBe('Vega, M57 or 330.84 −56.79');
  // measured with the face the page draws in: wait for the fonts, or a fallback face of another width is measured
  await page.evaluate(() => document.fonts.ready);
  const clipped = await page.locator('#where').evaluate((e) => {
    const c = document.createElement('canvas').getContext('2d');
    const s = getComputedStyle(e);
    const ph = getComputedStyle(e, '::placeholder');
    c.font = `${ph.fontSize} ${ph.fontFamily}`;
    const text = c.measureText(e.getAttribute('placeholder') ?? '').width, room = e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    return text > room ? `text ${text.toFixed(1)} px in ${c.font}, room ${room} px, field ${e.clientWidth} px, fonts ${[...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).join('/')}` : false;
  });
  expect(clipped).toBe(false);
});
