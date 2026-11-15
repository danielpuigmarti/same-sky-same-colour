// The first page: what it shows with scripts off, what its three live parts do with scripts on (the plate that
// flips, the ruler of one night, the demonstration "a plain blink lies"), and how it behaves at 360 px, by keyboard
// alone, with less motion, and in both editions. The page reads the real files of the site: the wide photos of the
// comet's field, the photos of the demonstration, and the numbers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(ROOT, 'site');
const NAME = JSON.parse(readFileSync(path.join(SITE, 'data', 'site.json'), 'utf8')).name;
const NUMBERS = JSON.parse(readFileSync(path.join(SITE, 'data', 'numbers.json'), 'utf8'));

const LIE_CANVAS = '[data-lie-stage] canvas';

/**
 * Watch a canvas for a while and return the moments at which the photo on it changed, ms.
 * @param {import('@playwright/test').Page} page @param {string} selector @param {number} ms
 */
async function flipsOf(page, selector, ms) {
  return page.evaluate(async ([sel, wait]) => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector(/** @type {string} */ (sel)));
    /** @type {number[]} */
    const at = [];
    let last = canvas.dataset.photo;
    const watch = new MutationObserver(() => {
      if (canvas.dataset.photo === last) return;
      last = canvas.dataset.photo;
      at.push(performance.now());
    });
    watch.observe(canvas, { attributes: true, attributeFilter: ['data-photo'] });
    await new Promise((done) => setTimeout(done, /** @type {number} */ (wait)));
    watch.disconnect();
    return at;
  }, [selector, ms]);
}

/**
 * Watch the lead plate for a while and return the moments at which it changed from one photo to the other, ms.
 * @param {import('@playwright/test').Page} page @param {number} ms
 */
async function plateFlips(page, ms) {
  return page.evaluate(async (wait) => {
    const root = /** @type {HTMLElement} */ (document.querySelector('#comet'));
    /** @type {number[]} */
    const at = [];
    let last = root.dataset.shows;
    const watch = new MutationObserver(() => {
      if (root.dataset.shows === last) return;
      last = root.dataset.shows;
      at.push(performance.now());
    });
    watch.observe(root, { attributes: true, attributeFilter: ['data-shows'] });
    await new Promise((done) => setTimeout(done, wait));
    watch.disconnect();
    return at;
  }, ms);
}

// ---------------------------------------------------------------------------------------------
// The page itself, with scripts off
// ---------------------------------------------------------------------------------------------

test.describe('with scripts off', () => {
  test.use({ javaScriptEnabled: false });

  test('the first screen says what this is, what changed on its photo, and what to do', async ({ page }) => {
    await page.goto('');
    const first = page.locator('#first-screen');
    await expect(first.getByRole('heading', { level: 1 })).toHaveText('TWO PHOTOS OF THE SAME SKY. WHAT CHANGED?');
    await expect(first.locator('.lede')).toContainText('Pick a place in the sky that SPHEREx has photographed.');
    await expect(first.locator('.lede')).toContainText('the same kind of infrared light');

    // colour and blink are defined where they are first used
    await expect(first.locator('.terms dt')).toHaveText(['Colour', 'Blink']);
    await expect(first.locator('.terms dd').nth(0)).toContainText('shows every photo in grey');
    await expect(first.locator('.terms dd').nth(1)).toContainText('Clyde Tombaugh found Pluto at Lowell Observatory');

    // both photos stand side by side, each with its verdict, its date and its colour
    const states = first.locator('[data-state]');
    await expect(states).toHaveCount(2);
    for (const img of await states.locator('img').all()) {
      await expect(img).toBeVisible();
      expect(await img.evaluate((i) => /** @type {HTMLImageElement} */ (i).naturalWidth)).toBeGreaterThan(0);
    }
    await expect(states.locator('.plate-verdict')).toHaveText(['NOTHING HERE', 'COMET LEMMON']);
    await expect(states.nth(0)).toContainText('10 August 2025');
    await expect(states.nth(1)).toContainText('26 February 2026');

    // the caption is always there: whose photos, what a square is, how wide the picture is
    const caption = first.locator('#flip-caption');
    await expect(caption).toBeVisible();
    await expect(caption).toContainText("Real photos from NASA’s SPHEREx space telescope, read from its public archive.");
    await expect(caption).toContainText('Each small square is one pixel of its camera.');
    const shown = Number(NUMBERS['r1.flip.shown_px'].value), pixel = Number(NUMBERS['stage.pixel_arcsec'].value);
    expect(Number(NUMBERS['r1.flip.field_arcmin'].value)).toBeCloseTo((shown * pixel) / 60, 1);
    await expect(caption).toContainText(`${NUMBERS['r1.flip.field_arcmin'].text} arcminutes wide`);

    // the form, and five examples that each say what they are
    await expect(first.getByLabel("Type a star’s name or a sky position")).toBeVisible();
    await expect(first.getByRole('button', { name: 'BLINK IT' })).toBeVisible();
    const tries = first.locator('.try a');
    await expect(tries).toHaveText(['EPSILON INDI B', 'BARNARD’S STAR', 'WISE 0855', 'RW AURIGAE', 'R DRACONIS', 'COMET LEMMON']);
    await expect(first.locator('.try-what')).toHaveCount(6);
    for (const href of await tries.evaluateAll((list) => list.map((a) => a.getAttribute('href')))) expect(href).toMatch(/^(view\.html\?t=[a-z0-9-]+|lemmon\.html)$/);

    // nothing that only a script can work is on the page
    await expect(page.locator('.flip-control, .scale, .transport, input[type="radio"], .night-input')).toHaveCount(0);
  });

  test('the masthead has three cells, with the dates on one line; the page announces no count of failures or stamps, and its checks are quiet links', async ({ page }) => {
    await page.goto('');
    await expect(page.locator('.masthead-cells .cell')).toHaveCount(3);
    await expect(page.locator('.masthead-cells .cell').nth(2)).toContainText('10 August 2025–26 February 2026'.replace('–', ' – '));
    await expect(page.locator('.masthead-nav').getByRole('link', { name: 'Checks' })).toHaveAttribute('href', 'checks.html');
    await expect(page.locator('a.check-link')).toHaveCount(3);
    await expect(page.locator('a.check-link[href="checks.html#K2"]').first()).toHaveText('K2');
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/not reviewed/i);
    expect(text).not.toMatch(/\d+ failed/i);
    await expect(page.locator('.stamp')).toHaveCount(0);
  });

  test('one line of results, each part a number of the site linked to its entry, and the challenge named once', async ({ page }) => {
    await page.goto('');
    const results = page.locator('#results');
    await expect(results.getByRole('heading', { level: 2 })).toHaveText('TESTED ON THE CHALLENGE’S FIVE TARGETS');
    const line = results.locator('.results-ledger');
    for (const id of ['eps-indi-b', 'barnard', 'wise0855', 'rw-aur', 'r-dra']) await expect(line.locator(`a[href="targets.html#${id}"]`).first()).toBeVisible();
    for (const key of [
      'targets.eps-indi-b.shift.measured', 'targets.barnard.shift.measured', 'targets.wise0855.shift.measured',
      'rwaur.d2.masked', 'rwaur.d3.masked', 'targets.r-dra.saturated',
    ]) await expect(line.locator(`a [data-n="${key}"]`)).toHaveCount(1);
    await expect(line).toContainText('Too bright to measure');
    const text = await page.locator('main').innerText();
    expect(text.match(/Planet X and SPHEREx/g)).toHaveLength(1);
    await expect(results.locator('.results-for')).toContainText('2026 NASA Space Apps Challenge');
  });

  test('below the first screen: the night, what you are looking at, why a plain blink lies, the targets, the box again', async ({ page }) => {
    await page.goto('');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'TESTED ON THE CHALLENGE’S FIVE TARGETS', 'ONE NIGHT, FOUR COLOURS',
      'A PLAIN BLINK LIES', 'NOW A PLACE OF YOUR OWN',
    ]);
    await expect(page.locator('#plain-blink .stop-name')).toHaveText(['All photos of one visit, in time order', 'One detector only', 'Same colour']);
    await expect(page.locator('#things-that-change')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Places to try' }).getByRole('link').first()).toHaveAttribute('href', 'view.html?t=eps-indi-b');
    // the record of the checks, in one line, linked to the Checks page
    const record = page.locator('#honesty');
    await expect(record).toContainText('the rule was written before its run');
    await expect(record.getByRole('link')).toHaveAttribute('href', 'checks.html');
    // the four photos of one night give their brightness with its unit
    await expect(page.locator('#one-night .night-data')).toHaveCount(4);
    for (const li of await page.locator('#one-night .night-data li:nth-child(2)').all()) await expect(li).toContainText(/\d\smJy$/);
    // what "×" means, with the link to its check
    const def = page.locator('#plain-blink .lie-def');
    await expect(def).toContainText("means that across these photos a steady star’s brightest reading is");
    await expect(def).toContainText('times its faintest');
    await expect(def.getByRole('link')).toHaveAttribute('href', 'checks.html#K7');
  });

  test('numbers come from the gate: every one sits in a span with its key and the text of numbers.json', async ({ page }) => {
    await page.goto('');
    const spans = await page.locator('main [data-n], header [data-n]').evaluateAll((list) => list.map((s) => [s.getAttribute('data-n'), s.textContent]));
    expect(spans.length).toBeGreaterThan(30);
    for (const [key, text] of spans) {
      expect(NUMBERS[/** @type {string} */ (key)], String(key)).toBeTruthy();
      expect(text, String(key)).toBe(NUMBERS[/** @type {string} */ (key)].text);
    }
    // outside those spans the only figures are names: of a target, a comet, a challenge, a check, a kind of light
    const typed = await page.locator('main').evaluate((main) => {
      const copy = /** @type {HTMLElement} */ (main.cloneNode(true));
      for (const s of copy.querySelectorAll('[data-n]')) s.remove();
      const words = [copy.textContent ?? '', ...[...copy.querySelectorAll('[alt], [aria-label], [title], [placeholder]')].flatMap((e) => ['alt', 'aria-label', 'title', 'placeholder'].map((a) => e.getAttribute(a) ?? ''))];
      return [...new Set(words.join(' ').match(/\d+/g) ?? [])].sort();
    });
    expect(typed).toEqual(['0855', '1', '1930', '2', '20', '2010', '2025', '2026', '330', '39', '41', '43', '46', '56', '57', '6', '7', '79', '84']);
  });
});

// ---------------------------------------------------------------------------------------------
// The plate that flips
// ---------------------------------------------------------------------------------------------

test.describe('the lead plate', () => {
  test('shows one photo at a time with its verdict, date and colour, flips by itself on the beat and stops when asked', async ({ page }) => {
    await page.goto('');
    const comet = page.locator('#comet'), control = page.locator('[data-flip-control]');
    await expect(comet).toHaveClass(/is-live/);
    await expect(control).toHaveText('PAUSE THE BLINK');
    const visible = comet.locator('[data-state]:visible');
    await expect(visible).toHaveCount(1);
    const flips = await plateFlips(page, 3800);
    expect(flips.length).toBeGreaterThanOrEqual(2);
    expect(flips.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < flips.length; i++) expect(flips[i] - flips[i - 1]).toBeGreaterThanOrEqual(490);

    await control.click();
    await expect(control).toHaveText('PLAY THE BLINK');
    expect(await plateFlips(page, 1500)).toEqual([]);
    // the two states: what is on the plate is the verdict, the date and the colour of one photo
    const seen = new Set();
    for (let i = 0; i < 2; i++) {
      await control.click();                                        // the first flip is at once, so a press is answered
      await control.click();                                        // and a second press pauses it again
      const state = comet.locator('[data-state]:visible');
      seen.add(await state.locator('.plate-verdict').innerText());
    }
    expect([...seen].sort()).toEqual(['COMET LEMMON', 'NOTHING HERE']);
    const shown = comet.locator('[data-state]:visible');
    const which = await shown.getAttribute('data-state');
    await expect(shown).toContainText(which === 'before' ? '10 August 2025' : '26 February 2026');
    await expect(shown).toContainText('carbon dioxide');
  });

  test('the picture shows a window of 128 photo pixels: each is a square, and the caption says how wide that is', async ({ page }) => {
    await page.goto('');
    const img = page.locator('#comet [data-state]:visible img');
    const box = /** @type {{width: number}} */ (await page.locator('#comet [data-state]:visible .plate').boundingBox());
    const width = await img.evaluate((i) => i.getBoundingClientRect().width);
    expect(width / box.width).toBeCloseTo(512 / Number(NUMBERS['r1.flip.shown_px'].value), 2);
    expect(await img.evaluate((i) => getComputedStyle(i).imageRendering)).toBe('pixelated');
  });

  test('when less motion is asked for, nothing plays and the button flips once for each press', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('');
    const comet = page.locator('#comet'), control = page.locator('[data-flip-control]');
    await expect(control).toHaveText('FLIP TO AUGUST 2025');
    expect(await plateFlips(page, 1800)).toEqual([]);
    await expect(comet.locator('.plate-verdict:visible')).toHaveText('COMET LEMMON');
    await control.click();
    await expect(comet.locator('.plate-verdict:visible')).toHaveText('NOTHING HERE');
    await expect(control).toHaveText('FLIP TO FEBRUARY 2026');
    expect(await plateFlips(page, 1500)).toEqual([]);
  });

  test('a photo that cannot be had leaves the two photos side by side, with no error', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/data/lemmon/**', (route) => route.fulfill({ status: 404, body: 'Not found.' }));
    await page.goto('', { waitUntil: 'networkidle' });
    await expect(page.locator('#comet')).not.toHaveClass(/is-live/);
    await expect(page.locator('#comet [data-state]')).toHaveCount(2);
    await expect(page.locator('[data-flip-control]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// One night, four colours
// ---------------------------------------------------------------------------------------------

test('the chip steps along the ruler of one night, photo by photo, and says each brightness with its unit', async ({ page }) => {
  await page.goto('');
  const night = page.locator('#one-night');
  await night.scrollIntoViewIfNeeded();
  await expect(night).toHaveClass(/is-live/);
  const chip = night.getByRole('slider'), readout = night.locator('[data-night-readout]');
  await expect(chip).toHaveAccessibleName('Colour of the photo in the heavy frame');
  await expect(night.locator('.night-photo.is-on')).toHaveCount(1);
  await chip.focus();
  await page.keyboard.press('Home');
  await expect(readout).toContainText('PHOTO 1 OF 4');
  await expect(readout).toContainText('BRIGHTNESS 14.1 mJy.');
  await page.keyboard.press('ArrowRight');
  await expect(readout).toContainText('PHOTO 2 OF 4');
  await expect(readout).toContainText('WHERE CARBON DIOXIDE GLOWS');
  await page.keyboard.press('End');
  await expect(readout).toContainText('PHOTO 4 OF 4');
  await expect(night.locator('.night-photo').nth(3)).toHaveClass(/is-on/);
  await night.locator('.night-photo').nth(2).locator('.plate').click();
  await expect(readout).toContainText('BRIGHTNESS 263.2 mJy.');
  const widths = await night.locator('.meter-fill').evaluateAll((bars) => bars.map((b) => b.getBoundingClientRect().width));
  expect(widths[2]).toBeGreaterThan(widths[1]);
  expect(widths[1]).toBeGreaterThan(widths[0]);
});

// ---------------------------------------------------------------------------------------------
// A plain blink lies
// ---------------------------------------------------------------------------------------------

test.describe('the demonstration "a plain blink lies"', () => {
  test('three stops: all photos of one visit, one detector only, the same colour; no cross-hair marks a star', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('');
    const lie = page.locator('#plain-blink'), canvas = lie.locator(LIE_CANVAS), next = lie.getByRole('button', { name: 'Next photo' });
    await lie.scrollIntoViewIfNeeded();
    await expect(lie).toHaveClass(/is-live/);
    const stops = lie.getByRole('radiogroup').getByRole('radio');
    await expect(stops).toHaveCount(3);
    await expect(lie.getByRole('radio', { name: /^All photos of one visit, in time order/ })).toBeChecked();
    await expect(lie.locator('[data-lie-stage] .plate-mark')).toHaveCount(0);
    await expect(lie.locator('.lie-note')).toContainText('RW Aurigae, at the centre, is the one star here that really varies');

    /** @param {string} name */
    const choose = async (name) => {
      await lie.locator(`[data-stop="${name}"]`).click();
      await expect(lie.locator(`[data-stop="${name}"] input`)).toBeChecked();
    };
    /** The photos a stop plays, by pressing Next once round: it comes back to the first. @param {RegExp} pattern */
    const round = async (pattern) => {
      const first = await lie.locator('.readout').innerText();
      expect(first).toMatch(pattern);
      const n = Number(/of (\d+)/.exec(first)?.[1]);
      for (let i = 1; i < n; i++) await next.click();
      await next.click();
      await expect(lie.locator('.readout')).toHaveText(first);
      return n;
    };
    const all = await round(/^Photo 1 of \d+/);
    await choose('detector');
    const detector = await round(/^Photo 1 of \d+/);
    expect(detector).toBeLessThan(all);
    await choose('matched');
    expect(await round(/^Photo 1 of 2/)).toBe(2);
    await expect(lie.locator('.scale-tick:not(.scale-end)')).toHaveCount(2);
    await expect(lie.getByRole('img', { name: /RW Aurigae and the stars around it\. Photo 1 of 2/ })).toBeVisible();
    expect((await canvas.evaluate((c) => [/** @type {HTMLCanvasElement} */ (c).width, getComputedStyle(c).imageRendering]))[1]).toBe('pixelated');
  });

  test('the meter: a bar for each stop, as long as the logarithm of its number', async ({ page }) => {
    await page.goto('');
    const lie = page.locator('#plain-blink');
    await lie.scrollIntoViewIfNeeded();
    await expect(lie).toHaveClass(/is-live/);
    const [a, b, c] = ['all', 'detector', 'matched'].map((k) => Number(NUMBERS[`lie.swing.${k}`].value));
    await expect(lie.locator('[data-stop="all"] .meter-value')).toHaveText(new RegExp(`^×\\s${NUMBERS['lie.swing.all'].text}$`));
    await expect(lie.locator('[data-stop="all"] .meter-bar')).toHaveAttribute('style', /--fill:\s*1\.0000/);
    const fills = await lie.locator('.meter-bar').evaluateAll((bars) => bars.map((x) => Number(/** @type {HTMLElement} */ (x).style.getPropertyValue('--fill'))));
    expect(fills[1]).toBeCloseTo(Math.log(b) / Math.log(a), 3);
    expect(fills[2]).toBeCloseTo(Math.log(c) / Math.log(a), 3);
    const widths = await lie.locator('.meter-fill').evaluateAll((bars) => bars.map((x) => x.getBoundingClientRect().width));
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
  });

  test('it plays when it comes into view, waits when it is scrolled away, and can be paused', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('');
    const lie = page.locator('#plain-blink'), play = lie.locator('.transport-play');
    await lie.scrollIntoViewIfNeeded();
    await expect(lie).toHaveClass(/is-live/);
    await lie.locator('[data-lie-stage]').scrollIntoViewIfNeeded();
    await expect(play).toHaveText('PAUSE');
    const flips = await flipsOf(page, LIE_CANVAS, 2700);
    expect(flips.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < flips.length; i++) expect(flips[i] - flips[i - 1]).toBeGreaterThanOrEqual(490);

    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(300);
    expect(await flipsOf(page, LIE_CANVAS, 1800)).toEqual([]);
    await lie.locator('[data-lie-stage]').scrollIntoViewIfNeeded();
    expect((await flipsOf(page, LIE_CANVAS, 2200)).length).toBeGreaterThanOrEqual(1);

    await play.click();
    await expect(play).toHaveText('PLAY');
    expect(await flipsOf(page, LIE_CANVAS, 1300)).toEqual([]);
    await play.click();
    await lie.getByRole('button', { name: 'Previous photo' }).click();
    await expect(play).toHaveText('PLAY');
  });

  test('when less motion is asked for, it does not play: there is no Play button, only steps', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('');
    const lie = page.locator('#plain-blink');
    await lie.scrollIntoViewIfNeeded();
    await expect(lie).toHaveClass(/is-live/);
    await lie.locator('[data-lie-stage]').scrollIntoViewIfNeeded();
    await expect(lie.locator('.transport-play')).toBeHidden();
    expect(await flipsOf(page, LIE_CANVAS, 1800)).toEqual([]);
    const before = await lie.locator('.readout').innerText();
    await lie.getByRole('button', { name: 'Next photo' }).click();
    expect(await lie.locator('.readout').innerText()).not.toBe(before);
  });
});

test('one loop plays at a time: starting one stops the other', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 6000 });   // both in view at once
  await page.goto('');
  const control = page.locator('[data-flip-control]'), play = page.locator('#plain-blink .transport-play');
  await expect(control).toHaveText('PAUSE THE BLINK');         // the plate at the top plays first
  await expect(play).toHaveText('PLAY');                       // the demonstration waits for it
  // nothing is scrolled to: a click that scrolled would take the plate out of view, and the demonstration would start
  expect(await play.evaluate((b) => b.getBoundingClientRect().bottom)).toBeLessThan(6000);
  expect(await flipsOf(page, LIE_CANVAS, 1300)).toEqual([]);
  await play.click();
  await expect(play).toHaveText('PAUSE');
  await expect(control).toHaveText('PLAY THE BLINK');
  expect(await plateFlips(page, 1300)).toEqual([]);
  expect((await flipsOf(page, LIE_CANVAS, 1300)).length).toBeGreaterThanOrEqual(1);
  await control.click();
  await expect(control).toHaveText('PAUSE THE BLINK');
  await expect(play).toHaveText('PLAY');
  expect(await flipsOf(page, LIE_CANVAS, 1300)).toEqual([]);
  await play.click();
  await expect(play).toHaveText('PAUSE');
  await expect(control).toHaveText('PLAY THE BLINK');
});

// ---------------------------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------------------------

test('the box goes straight to the view that was meant, and answers in words when it cannot read what was typed', async ({ page }) => {
  await page.goto('');
  const box = page.getByLabel("Type a star’s name or a sky position").first(), message = page.locator('#where-message');
  /** @param {string} text @param {RegExp} address */
  const typed = async (text, address) => {
    await page.goto('');
    await box.fill(text);
    await box.press('Enter');
    await page.waitForURL(address);
  };
  await typed('330.84 -56.79', /\/view\.html\?ra=330\.84&dec=-56\.79$/);
  await typed('08h55m10.831s -7d14m42.53s', /\/view\.html\?ra=133\.795129&dec=-7\.245147$/);
  await typed("Barnard's Star", /\/view\.html\?t=barnard$/);
  await typed('eps indi b', /\/view\.html\?t=eps-indi-b$/);
  await typed('Comet Lemmon', /\/lemmon\.html$/);

  await page.goto('');
  const here = page.url();
  await box.fill('not a place');
  await page.getByRole('button', { name: 'BLINK IT' }).first().click();
  await expect(message).toContainText("Barnard's Star");
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(box).toBeFocused();
  expect(page.url()).toBe(here);
  await box.fill('');
  await expect(message).toBeEmpty();
  await page.getByRole('button', { name: 'BLINK IT' }).first().click();
  await expect(message).toHaveText(/Type a name or a position first/);
  expect(page.url()).toBe(here);
});

test('both forms have suggestions: a combobox that opens on typing and takes a row with the keyboard', async ({ page }) => {
  await page.goto('');
  for (const id of ['where', 'where-again']) {
    const box = page.locator(`#${id}`);
    await expect(box).toHaveAttribute('role', 'combobox');
    await expect(box.locator('xpath=..')).toHaveAttribute('data-suggest-anchor', '');
  }
  const box = page.locator('#where');
  await box.fill('barnard');
  const list = page.locator('#position [data-suggest-list]');
  await expect(list).toBeVisible();
  await expect(list.locator('[data-suggest-option]').first()).toContainText("Barnard's Star");
  await box.press('ArrowDown');
  await box.press('Enter');
  await page.waitForURL(/view\.html\?t=barnard$/);
});

// ---------------------------------------------------------------------------------------------
// Every visitor
// ---------------------------------------------------------------------------------------------

test('landmarks and headings: a screen reader can find its way', async ({ page }) => {
  await page.goto('');
  await expect(page.getByRole('search')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'TWO PHOTOS OF THE SAME SKY. WHAT CHANGED?' })).toHaveCount(1);
  for (const name of ['TESTED ON THE CHALLENGE’S FIVE TARGETS', 'ONE NIGHT, FOUR COLOURS', 'A PLAIN BLINK LIES', 'NOW A PLACE OF YOUR OWN']) {
    await expect(page.getByRole('region', { name })).toHaveCount(1);
  }
  await expect(page.getByRole('figure').first()).toHaveAccessibleName(/Real photos from NASA’s SPHEREx space telescope/);
  await expect(page.getByRole('list', { name: 'Places to try' }).getByRole('link')).toHaveCount(6);
  const nameless = await page.evaluate(() => [
    ...document.querySelectorAll('img:not([alt]), canvas:not([aria-hidden]):not([aria-label])'),
    ...[...document.querySelectorAll('button, input, a[href], summary')].filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim() || /** @type {HTMLInputElement} */ (e).labels?.length)),
  ].map((e) => e.outerHTML.slice(0, 80)));
  expect(nameless).toEqual([]);
});

test('by keyboard alone: everything can be reached, in the order of the page, and shows where the focus is', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('');
  await page.locator('#plain-blink').scrollIntoViewIfNeeded();
  await expect(page.locator('#plain-blink')).toHaveClass(/is-live/);
  await page.locator('#one-night').scrollIntoViewIfNeeded();
  await expect(page.locator('#one-night')).toHaveClass(/is-live/);
  await page.evaluate(() => scrollTo(0, 0));

  /** @type {string[]} */
  const order = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const at = await page.evaluate(() => {
      const e = /** @type {HTMLElement} */ (document.activeElement);
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      const ring = (s.outlineStyle === 'solid' && parseFloat(s.outlineWidth) >= 3) || /** @type {Element | null} */ (e.closest('.stop') && getComputedStyle(/** @type {Element} */ (e.closest('.stop'))).outlineStyle === 'solid');
      const name = e.getAttribute('aria-label') || /** @type {HTMLInputElement} */ (e).labels?.[0]?.textContent?.trim().split('\n')[0] || e.textContent?.trim() || e.tagName;
      return { name: name.replace(/\s+/g, ' ').slice(0, 22), ring, inView: r.bottom > 0 && r.top < innerHeight, footer: Boolean(e.closest('footer')) || e === document.body };
    });
    if (at.footer) break;
    expect(at.ring, `${at.name} shows the focus`).toBe(true);
    expect(at.inView, `${at.name} is scrolled into view`).toBe(true);
    order.push(at.name);
  }
  expect(order.slice(0, 17).map((n) => n.trim())).toEqual([
    'Skip to the content', NAME, 'Bulletin', 'Blink a place', 'The comet', 'Five targets', 'Checks', 'Why', 'Day edition',
    'Type a star’s name or', 'BLINK IT',
    'EPSILON INDI B', 'BARNARD’S STAR', 'WISE 0855', 'RW AURIGAE', 'R DRACONIS', 'COMET LEMMON',
  ].map((n) => n.slice(0, 22)));
  expect(order).toContain('FLIP TO AUGUST 2025'.slice(0, 22));
  expect(order).toContain('Colour of the photo in');
  expect(order).toContain('Previous photo');
  expect(order).toContain('Next photo');
  expect(order.at(-1)).toMatch(/^BLINK IT/);

  // and worked: Space on the button, arrows on the chip and on the stops, Enter on a step
  await page.locator('[data-flip-control]').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#comet .plate-verdict:visible')).toHaveText('NOTHING HERE');
  await page.getByRole('radio', { name: /^All photos/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /^One detector only/ })).toBeChecked();
  const first = await page.locator('#plain-blink .readout').innerText();
  await page.getByRole('button', { name: 'Next photo' }).focus();
  await page.keyboard.press('Enter');
  expect(await page.locator('#plain-blink .readout').innerText()).not.toBe(first);
});

test('at 360 px wide the page fits, and the first screen holds the name, the headline and the form, and the plate follows the form', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('', { waitUntil: 'networkidle' });
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await fits()).toBe(true);
  await expect(page.locator('.masthead-name')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#title')).toBeInViewport({ ratio: 1 });
  // on a phone: the headline, the offer, the form (on the first screen), then the plate, then the places to try
  await expect(page.locator('#first-screen .btn-primary')).toBeInViewport({ ratio: 1 });
  const at = async (/** @type {string} */ sel) => /** @type {{y: number}} */ (await page.locator(sel).first().boundingBox()).y;
  const [lede, form, plate, tries] = [await at('#first-screen .lede'), await at('#position'), await at('#comet .plate'), await at('.position-try')];
  expect(lede).toBeLessThan(form);
  expect(form).toBeLessThan(plate);
  expect(plate).toBeLessThan(tries);
  // nothing a finger must hit is smaller than 24 px
  const small = await page.evaluate(() => [...document.querySelectorAll('main a, main button, main input')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && !e.closest('.note, .about, p, .results-ledger') && !e.matches('input[type="radio"]') && (r.height < 23.5 || r.width < 23.5);
  }).map((e) => `${e.outerHTML.slice(0, 60)} ${Math.round(e.getBoundingClientRect().height)}`));
  expect(small).toEqual([]);
  await page.locator('#plain-blink').scrollIntoViewIfNeeded();
  await expect(page.locator('#plain-blink')).toHaveClass(/is-live/);
  await page.locator('footer').scrollIntoViewIfNeeded();
  expect(await fits()).toBe(true);
  const wide = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5) && !e.closest('.visually-hidden, [data-plate]'); }).map((e) => e.outerHTML.slice(0, 70)));
  expect(wide).toEqual([]);
});

for (const edition of /** @type {const} */ (['night', 'day'])) {
  test(`text stands out from what is behind it (WCAG AA) in the ${edition} edition, with every part live`, async ({ page }) => {
    await page.addInitScript((e) => { try { localStorage.setItem('same-sky-same-colour:edition', e); } catch { /* the choice then holds for nothing */ } }, edition);
    await page.goto('');
    await expect(page.locator('html')).toHaveAttribute('data-edition', edition);
    await page.locator('#one-night').scrollIntoViewIfNeeded();
    await expect(page.locator('#one-night')).toHaveClass(/is-live/);
    await page.locator('#plain-blink').scrollIntoViewIfNeeded();
    await expect(page.locator('#plain-blink')).toHaveClass(/is-live/);
    await page.locator('.try a').first().focus();
    await page.locator('#where').fill('bar');                      // the list of suggestions is open
    const faint = await page.evaluate(() => {
      const probe = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d', { willReadFrequently: true }));
      /** @param {string} colour @returns {[number, number, number, number]} */
      const rgba = (colour) => {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = colour;
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      };
      /** @param {number[]} c */
      const luminance = (c) => c.slice(0, 3).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      /** @param {Element} e @returns {number[]} */
      const behind = (e) => {
        for (let x = /** @type {Element | null} */ (e); x; x = x.parentElement) {
          const c = rgba(getComputedStyle(x).backgroundColor);
          if (c[3] > 0.99) return c;
        }
        return rgba(getComputedStyle(document.documentElement).backgroundColor);
      };
      /** @type {string[]} */
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const e = node.parentElement;
        if (!e || !node.textContent?.trim() || e.closest('.visually-hidden, script, style, [hidden]')) continue;
        const style = getComputedStyle(e), r = e.getBoundingClientRect();
        if (r.width === 0 || style.visibility === 'hidden') continue;
        const a = luminance(rgba(style.color)), b = luminance(behind(e));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const size = parseFloat(style.fontSize), large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) out.push(`${ratio.toFixed(2)} "${node.textContent.trim().slice(0, 30)}" ${style.color}`);
      }
      return out;
    });
    expect(faint).toEqual([]);
  });
}
