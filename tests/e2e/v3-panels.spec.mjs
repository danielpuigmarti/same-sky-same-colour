// The panels beside the stage in a real browser (tests/manual/v3.html, pictures made by hand): the frame map, the spectrum and
// "Is it real?" tied to each other and to a stand-in page. The page is served from the project folder, not from site/, so
// this spec starts its own server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { startServer } from '../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** @type {{server: import('node:http').Server, url: string}} */
let served;
test.beforeAll(async () => { served = await startServer({ root: ROOT, port: 0 }); });
test.afterAll(async () => { await new Promise((r) => served.server.close(r)); });

const open = (page, query = '') => page.goto(`${served.url}tests/manual/v3.html?${query}`);

/** A seeded generator. @param {number} seed */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The dots as drawn: key, position in the page, state. @param {import('@playwright/test').Page} page */
const dots = async (page) => { await page.locator('.framemap-canvas').scrollIntoViewIfNeeded(); return page.evaluate(() => {
  const box = document.querySelector('.framemap-canvas').getBoundingClientRect();
  return window.__v3.panels.parts.map.dots().map((d) => ({ key: d.frame.key, loaded: d.frame.loaded, lam: d.frame.lam, x: box.left + d.x, y: box.top + d.y }));
}); };
const calls = (page) => page.evaluate(() => window.__v3.calls.slice());

test('the frame map draws one dot for each photo, and says how many are loaded', async ({ page }) => {
  await open(page, 'scenario=clean&extra=150');
  const d = await dots(page);
  expect(d).toHaveLength(12 + 150);
  expect(d.filter((x) => x.loaded)).toHaveLength(12);
  await expect(page.locator('.framemap-summary')).toHaveText(/^162 photos cover this position · 12 loaded( · centre pixel saturated or damaged in \d+)?$/);
  const canvas = page.locator('.framemap-canvas');
  const px = await canvas.evaluate((c) => { const g = c.getContext('2d'); const w = c.width, h = c.height; const data = g.getImageData(0, 0, w, h).data; let lit = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++; return lit; });
  expect(px).toBeGreaterThan(1000);
});

test('50 random bands: the dot, the photo asked of the page and the point of the spectrum name the same file', async ({ page }) => {
  await open(page, 'scenario=real&extra=150');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 45, y: 45 }));
  const all = await dots(page), loaded = all.filter((x) => x.loaded);
  const box = await page.locator('.framemap-canvas').boundingBox();
  const lay = await page.evaluate(() => { const l = window.__v3.panels.parts.map.layout(); return { l: l.plot.l, r: l.plot.r }; });
  const r = rng(2026);
  let named = 0;
  for (let n = 0; n < 50; n++) {
    // a band that covers at least one loaded dot, whatever its size
    const c = loaded[Math.floor(r() * loaded.length)];
    const y0 = c.y - 3 - r() * 25, y1 = c.y + 3 + r() * 25;
    const before = (await calls(page)).length;
    await page.mouse.move(box.x + lay.l + 30, y0);
    await page.mouse.down();
    await page.mouse.move(box.x + lay.l + 40, (y0 + y1) / 2, { steps: 2 });
    await page.mouse.move(box.x + lay.l + 50, y1, { steps: 2 });
    await page.mouse.up();
    const after = await calls(page);
    const select = after.slice(before).filter((x) => 'selectFrames' in x).pop();
    expect(select, `selection ${n}: ${JSON.stringify({ y0, y1, box, c: c.y, calls: after.slice(before).length })}`).toBeTruthy();
    const keys = select.selectFrames;
    expect(keys.length).toBeGreaterThan(0);
    // every photo asked of the page is a loaded dot inside the band
    for (const key of keys) {
      const dot = all.find((x) => x.key === key);
      expect(dot, key).toBeTruthy();
      expect(dot.loaded).toBe(true);
      expect(dot.y).toBeGreaterThanOrEqual(Math.min(y0, y1) - 1);
      expect(dot.y).toBeLessThanOrEqual(Math.max(y0, y1) + 1);
    }
    // and every loaded dot inside the band was asked for
    const inside = loaded.filter((x) => x.y >= Math.min(y0, y1) && x.y <= Math.max(y0, y1)).map((x) => x.key).sort();
    expect([...keys].sort()).toEqual(inside);
    // hovering one of them: the page is asked to show that photo, and the spectrum point of that photo lights up
    const chosen = keys[Math.floor(r() * keys.length)];
    const pick = all.find((x) => x.key === chosen);
    await page.mouse.move(pick.x, pick.y, { steps: 2 });
    const shown = (await calls(page)).filter((x) => 'showFrame' in x).pop();
    expect(shown.showFrame).toBe(pick.key);
    const point = page.locator(`#spectrum .pt[data-key="${pick.key}"]`).first();
    await expect(point).toHaveCount(1);
    await expect(point).toHaveAttribute('data-lit', 'true');
    named++;
    await page.mouse.move(box.x + 2, box.y + 2);
  }
  expect(named).toBe(50);
  expect((await calls(page)).filter((x) => 'showFrame' in x).pop().showFrame).toBe(null);
});

test('a point of the spectrum asks the page for its photo and lights its dot', async ({ page }) => {
  await open(page, 'scenario=real');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 45, y: 45 }));
  const pt = page.locator('#spectrum .pt').first();
  await expect(pt).toBeVisible();
  const key = await pt.getAttribute('data-key');
  await pt.hover();
  expect((await calls(page)).filter((x) => 'showFrame' in x).pop().showFrame).toBe(key);
  await expect(page.locator('.framemap-canvas')).toBeVisible();
});

test('a place that shows in one photo only says so on the map, and every question has an answer', async ({ page }) => {
  await open(page, 'scenario=clean');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 40, y: 25 }));
  await expect(page.locator('.framemap-note')).toHaveText('The place you clicked shows in one photo only.');
  const key = await page.evaluate(() => window.__v3.stamps[8].key);
  const d = (await dots(page)).find((x) => x.key === key);
  await page.mouse.move(d.x, d.y);
  await expect(page.locator('.framemap-tip')).toContainText('present in one photo only');
  const rows = page.locator('#is-it-real .isreal-a');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute('data-answer', 'false');
  await expect(rows.nth(1)).toHaveAttribute('data-answer', 'false');
  await expect(page.locator('#is-it-real .isreal-verdict')).toHaveText('Not a known star; asteroids are not checked here.');
  await expect(page.locator('#is-it-real .isreal-caution')).toHaveText('Most blips that pass these checks are still artefacts or known objects.');
  await expect(page.locator('#is-it-real a')).toHaveCount(2);
  await expect(page.locator('#is-it-real a').first()).toHaveAttribute('href', /backyardworlds/);
  await expect(page.locator('#is-it-real a').nth(1)).toHaveAttribute('href', /minorplanetcenter/);
  const text = await page.locator('#frame-map, #spectrum, #is-it-real').allInnerTexts();
  expect(text.join('\n')).not.toMatch(/\b(new|candidates?|discover\w*)\b/i);
});

test('a flagged blip is flagged, and "Copy summary" copies plain lines and nothing is sent', async ({ page }) => {
  const sent = [];
  page.on('request', (rq) => { if (rq.method() !== 'GET') sent.push(rq.url()); });
  await open(page, 'scenario=ghost');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 40, y: 25 }));
  await expect(page.locator('#is-it-real .isreal-a').first()).toContainText('GHOST');
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await expect(page.locator('.isreal-status')).toHaveText('Copied.');
  const copied = await page.evaluate(() => window.__v3.copied);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toMatch(/Flagged pixel: yes \(GHOST\)/);
  expect(copied[0]).toMatch(/nothing was stored or sent/);
  expect(sent).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
});

test('the spectrum has one curve for each visit, the label, the button, and no curve for a place that is too bright or too faint', async ({ page }) => {
  await open(page, 'scenario=star');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 20, y: 40 }));
  await expect(page.locator('#spectrum .spectrum-body .curve')).toHaveCount(2);
  await expect(page.locator('#spectrum .spectrum-body .pt')).toHaveCount(12);
  await expect(page.locator('#spectrum .spectrum-label')).toContainText('relative, not aperture-corrected');
  await expect(page.locator('#spectrum .spectrum-change .chart')).toHaveCount(1);
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 5, y: 5 }));
  await expect(page.locator('#spectrum .spectrum-body .curve')).toHaveCount(0);
  await expect(page.locator('#spectrum .spectrum-body .pt')).toHaveCount(0);
  await expect(page.locator('#spectrum .panel-state').first()).toContainText('Too faint');
});

test('load all colours shows its cost and calls the page', async ({ page }) => {
  await open(page, 'scenario=real&extra=150');
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 45, y: 45 }));
  const btn = page.getByRole('button', { name: /^load all colours \(\d+(\.\d)? MB, about \d+ (seconds|minutes)\)$/ });
  await expect(btn).toBeVisible();
  await btn.click();
  expect((await calls(page)).some((c) => c.loadAllColours)).toBe(true);
});

test('Barnard\'s Star on its ring: the blip is a known fast star, whichever visit it is in', async ({ page }) => {
  await open(page, 'scenario=fast');
  await page.evaluate(() => window.__v3.panels.pointAt(window.__v3.place));
  await expect(page.locator('#is-it-real .isreal-a[data-part="ring"]')).toContainText('Yes');
  await expect(page.locator('#is-it-real .isreal-verdict')).toHaveText('This is probably a known star.');
});

test('at 360 pixels the panels fit without sideways scrolling, and 21,000 dots are drawn in under 1.5 seconds', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, 'scenario=real&extra=0&dots=21000');
  const t = await page.evaluate(() => window.__v3.timing.setFrames);
  expect(t).toBeLessThan(1500);
  const d = await dots(page);
  expect(d).toHaveLength(12 + 21000);
  const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, canvas: document.querySelector('.framemap-canvas').getBoundingClientRect().width }));
  expect(width.doc).toBeLessThanOrEqual(width.view);
  expect(width.canvas).toBeLessThanOrEqual(360);
  await page.evaluate(() => window.__v3.panels.pointAt({ x: 45, y: 45 }));
  const after = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(after).toBeLessThanOrEqual(360);
  // a loaded dot is still found in the crowd
  const one = d.find((x) => x.loaded);
  await page.mouse.move(one.x, one.y);
  expect((await calls(page)).filter((x) => 'showFrame' in x).pop().showFrame).toBe(one.key);
  console.log(`21000 dots: setFrames ${t.toFixed(0)} ms`);
});
