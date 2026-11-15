// The stage in a real browser, on the fixtures and on stamps set by hand. Every check reads back what the canvas
// holds (its bytes) and what it was drawn from (the array), and compares them with the files of the fixture and
// with values computed elsewhere: numpy for the greys (tests/fixtures/v2/display.json), astropy for the sky
// (tests/fixtures/v2/sky.json).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { fixturePath, readJson, readFloat32, readInt32, loadFrame, FRAME_IDS } from '../helpers/fixtures.mjs';

const ID = 'barnard-d5';
const manifest = readJson('showcase', ID, 'manifest.json');
const W = manifest.w, H = manifest.h, N = W * H;
const fileData = readFloat32('showcase', ID, 'stamps.bin'), fileFlags = readInt32('showcase', ID, 'flags.bin');
const display = readJson('v2', 'display.json'), sky = readJson('v2', 'sky.json').frames;

/** The colours of the tokens, read from the stylesheet. @param {string} name @returns {number[]} */
function token(name) {
  const css = readFileSync(new URL('../../site/css/tokens.css', import.meta.url), 'utf8');
  const m = new RegExp(`--${name}:\\s*#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})`, 'i').exec(css);
  if (!m) throw new Error(`no token ${name}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
const NONE = token('color-line'), NEG = token('color-diff-neg'), POS = token('color-diff-pos');

/** The bits of the values of frame i in the file. @param {number} i */
const fileBits = (i) => Array.from(new Uint32Array(fileData.buffer, fileData.byteOffset + i * N * 4, N));

/**
 * The bytes a canvas must hold for frame `i` shown as side `k` of pair `p`, from numpy's greys: red, green, blue,
 * alpha for each pixel, the top row first.
 * @param {number} p @param {number} k
 */
function wantRgba(p, k) {
  const i = display.pairs[p].frames[k], grey = Buffer.from(display.pairs[p].grey[k], 'base64');
  const out = new Array(N * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = ((H - 1 - y) * W + x) * 4, v = fileData[i * N + y * W + x], g = grey[y * W + x];
      const c = Number.isFinite(v) ? [g, g, g] : NONE;
      out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
    }
  }
  return out;
}

/** Serve the files of the fixtures to the page: the showcase as a target of the site, the frames under __fixtures__/. @param {import('@playwright/test').Page} page */
async function serveFixtures(page) {
  await page.route(`**/data/targets/${ID}/*`, (route) => route.fulfill({ path: fixturePath('showcase', ID, new URL(route.request().url()).pathname.split('/').pop() ?? '') }));
  await page.route('**/__fixtures__/**', (route) => route.fulfill({ path: fixturePath(...new URL(route.request().url()).pathname.split('/__fixtures__/')[1].split('/')) }));
}

/**
 * Open the viewer page (for its styles), load the modules and the stamps of the showcase, and make a place for a stage.
 * @param {import('@playwright/test').Page} page
 */
async function boot(page) {
  /** @type {string[]} */
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await serveFixtures(page);
  await page.goto('view.html');
  await page.evaluate(async () => {
    const load = (/** @type {string} */ p) => import(new URL(p, document.baseURI).href);
    const [stageMod, showcaseMod, hoverMod, rulerMod] = await Promise.all([load('js/ui/stage.js'), load('js/lib/showcase.js'), load('js/ui/hover.js'), load('js/ui/ruler.js')]);
    const got = await showcaseMod.loadShowcase('data/targets/barnard-d5/');
    const host = document.createElement('section');
    host.id = 't-stage';
    /** @type {HTMLElement} */ (document.querySelector('main')).prepend(host);
    const bits = (/** @type {Float32Array} */ v) => Array.from(new Uint32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    const t = /** @type {any} */ (window).__t = { stageMod, hoverMod, rulerMod, stamps: got.stamps, manifest: got.manifest, host, bits, points: [] };
    // what is drawn now, in a form that can leave the page
    t.read = () => {
      const rb = t.stage.readback();
      return {
        ...rb,
        panels: rb.panels.map((/** @type {any} */ p) => ({
          kind: p.kind, w: p.w, h: p.h, cssWidth: p.cssWidth, caption: p.caption,
          rgba: Array.from(p.rgba), bits: bits(p.values),
          isA: p.values === t.view.a.data, isB: p.values === t.view.b.data, isDiff: Boolean(t.view.diff) && p.values === t.view.diff.data,
          saturated: Array.from(p.saturated), defect: Array.from(p.defect), veiled: p.veiled && Array.from(p.veiled), source: p.source && Array.from(p.source),
        })),
      };
    };
    // a stage on two stamps of the showcase, paused unless told otherwise
    t.open = (/** @type {number} */ i, /** @type {number} */ j, /** @type {any} */ options = {}, /** @type {any} */ extra = {}) => {
      t.stage?.destroy();
      t.view = { a: { ...t.stamps[i], ...extra.a }, b: { ...t.stamps[j], ...extra.b }, ...extra.view };
      t.stage = stageMod.createStage(host, { autoplay: false, onPoint: (/** @type {any} */ p) => t.points.push(p), ...options });
      t.stage.show(t.view);
    };
  });
  return problems;
}

/** @param {import('@playwright/test').Page} page @returns {Promise<any>} */
const read = (page) => page.evaluate(() => /** @type {any} */ (window).__t.read());

test('one stamp gives identical pixel values in every mode, and they are the values of the file', async ({ page }) => {
  const problems = await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  const wantA = wantRgba(0, 0), wantB = wantRgba(0, 1);
  /** @type {Record<string, any>} */
  const seen = {};

  // Blink, stepped: the earlier visit, then the later one
  seen.blinkA = (await read(page)).panels;
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.step('b'));
  await expect.poll(async () => (await read(page)).side, 'a step that comes right after a new picture waits its turn').toBe('b');
  seen.blinkB = (await read(page)).panels;
  // Side by side
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.setMode('side'));
  seen.side = (await read(page)).panels;
  // Curtain, at its two ends
  await page.evaluate(() => { const s = /** @type {any} */ (window).__t.stage; s.setMode('curtain'); s.setCurtain(1); });
  seen.curtainA = (await read(page)).panels;
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.setCurtain(0));
  seen.curtainB = (await read(page)).panels;

  expect(seen.blinkA.map((/** @type {any} */ p) => p.kind)).toEqual(['a']);
  expect(seen.blinkB.map((/** @type {any} */ p) => p.kind)).toEqual(['b']);
  expect(seen.side.map((/** @type {any} */ p) => p.kind)).toEqual(['a', 'b']);
  expect(seen.curtainA.map((/** @type {any} */ p) => p.kind)).toEqual(['curtain']);

  const showsA = [seen.blinkA[0], seen.side[0], seen.curtainA[0]], showsB = [seen.blinkB[0], seen.side[1], seen.curtainB[0]];
  for (const [panels, want, frame] of /** @type {[any[], number[], number][]} */ ([[showsA, wantA, 0], [showsB, wantB, 2]])) {
    for (const p of panels) {
      expect([p.w, p.h]).toEqual([W, H]);
      expect(p.bits, 'the values the canvas was drawn from are the values of the file, bit for bit').toEqual(fileBits(frame));
      expect(p.rgba, 'the canvas holds the greys that numpy gives those values').toEqual(want);
    }
  }
  // in Blink and Side by side the canvas is drawn from the very array of the stamp, not from a copy
  expect([seen.blinkA[0].isA, seen.side[0].isA, seen.blinkB[0].isB, seen.side[1].isB]).toEqual([true, true, true, true]);
  // one rule for the whole view: black and white from both stamps together
  const limits = (await read(page)).limits;
  expect(limits.lo).toBeCloseTo(display.pairs[0].lo, 9);
  expect(limits.hi).toBeCloseTo(display.pairs[0].hi, 9);
  expect(problems).toEqual([]);
});

test('the curtain at 0% and at 100% is each visit; between, whole columns of one or the other', async ({ page }) => {
  test.slow(); // thousands of pixels are compared one by one: with every other test running beside it, that takes long
  await boot(page);
  await page.evaluate(() => { const t = /** @type {any} */ (window).__t; t.open(0, 2, { mode: 'curtain' }); });
  const a = fileBits(0), b = fileBits(2), ra = wantRgba(0, 0), rb = wantRgba(0, 1);
  // it opens in the middle
  let now = await read(page);
  expect(now.split).toBe(W / 2);
  for (const [fraction, split] of [[0, 0], [1, W], [0.25, 16], [0.5, 32], [0.8125, 52]]) {
    await page.evaluate((f) => /** @type {any} */ (window).__t.stage.setCurtain(f), fraction);
    now = await read(page);
    const p = now.panels[0];
    expect(now.split).toBe(split);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x += 7) {
        const i = y * W + x, o = ((H - 1 - y) * W + x) * 4;
        expect(p.bits[i]).toBe((x < split ? a : b)[i]);
        expect(p.rgba.slice(o, o + 4)).toEqual((x < split ? ra : rb).slice(o, o + 4));
      }
    }
    if (split === 0) { expect(p.bits).toEqual(b); expect(p.rgba).toEqual(rb); }
    if (split === W) { expect(p.bits).toEqual(a); expect(p.rgba).toEqual(ra); }
  }
  // the slider and the arrow keys move it by whole columns, and it stops at its ends
  const slider = page.locator('#t-stage .stage-curtain-input');
  await expect(slider).toBeVisible();
  await slider.focus();
  await page.keyboard.press('End');
  expect((await read(page)).split).toBe(W);
  await page.keyboard.press('ArrowLeft');
  expect((await read(page)).split).toBe(W - 1);
  await page.keyboard.press('Home');
  expect((await read(page)).panels[0].bits).toEqual(b);
  // dragging on the picture moves the curtain to the column under the pointer
  await page.locator('#t-stage .stage-canvas').scrollIntoViewIfNeeded();
  const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await page.locator('#t-stage .stage-canvas').boundingBox());
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * (40 / W), box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#t-stage .stage-curtain-line'), 'once the page has handled the pointer').toHaveAttribute('x1', '40');
  expect((await read(page)).split).toBe(40);
});

test('a stamp set by hand: each value has its grey, and on the screen each pixel is one flat square', async ({ page }) => {
  await boot(page);
  // 8 by 6, values 0 to 47 with one missing; the other side is the same picture turned upside down
  const made = await page.evaluate(() => {
    const t = /** @type {any} */ (window).__t;
    const w = 8, h = 6, data = Float32Array.from({ length: w * h }, (_, i) => i), back = Float32Array.from(data).reverse();
    data[13] = NaN;
    back[w * h - 1 - 13] = NaN;
    const stamp = (/** @type {Float32Array} */ d) => ({ key: '', det: 2, mjd: 61000, w, h, x0: NaN, y0: NaN, tx: NaN, ty: NaN, lam: 1.5, bw: 0.03, data: d, flags: null });
    t.stage?.destroy();
    t.view = { a: stamp(data), b: stamp(back) };
    t.stage = t.stageMod.createStage(t.host, { autoplay: false });
    t.stage.show(t.view);
    return { read: t.read(), style: getComputedStyle(/** @type {Element} */ (document.querySelector('#t-stage .stage-canvas'))).imageRendering, dpr: devicePixelRatio };
  });
  const { lo, hi } = made.read.limits, p = made.read.panels[0];
  // percentiles 0.5 and 99.5 of 0..47 without 13, twice over
  const pool = [...Array(48).keys()].filter((v) => v !== 13).flatMap((v) => [v, v]).sort((x, y) => x - y);
  const pct = (/** @type {number} */ q) => { const at = (pool.length - 1) * q / 100, i = Math.floor(at); return pool[i] + (at - i) * (pool[Math.min(i + 1, pool.length - 1)] - pool[i]); };
  expect([lo, hi]).toEqual([pct(0.5), pct(99.5)]);
  const grey = (/** @type {number} */ v) => { const t = (v - lo) / (hi - lo); return t <= 0 ? 0 : t >= 1 ? 255 : Math.round(255 * Math.asinh(10 * t) / Math.asinh(10)); };
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      const v = y * 8 + x, o = ((5 - y) * 8 + x) * 4;
      expect(p.rgba.slice(o, o + 4), `value ${v}`).toEqual(v === 13 ? [...NONE, 255] : [grey(v), grey(v), grey(v), 255]);
    }
  }
  // nearest neighbour: a whole number of screen pixels to a pixel of the stamp, and no smoothing
  expect(made.style).toBe('pixelated');
  const zoom = p.cssWidth * made.dpr / 8;
  expect(Number.isInteger(zoom) && zoom >= 8, `zoom ${zoom}`).toBe(true);
  expect((await page.locator('#t-stage .stage-canvas').boundingBox())?.height).toBe(zoom * 6 / made.dpr);

  // the screen itself: a photograph of the canvas, read back in the page
  await page.locator('#t-stage .stage-hatch-saturated').evaluate((e) => e.setAttribute('visibility', 'hidden')); // the missing value is hatched; look under the hatching
  const shot = (await page.locator('#t-stage .stage-canvas').screenshot()).toString('base64');
  const blocks = await page.evaluate(async ({ png, w, h }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const c = new OffscreenCanvas(image.width, image.height), ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, image.width, image.height).data, k = image.width / w;
    const out = [];
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        // five places inside the square: its middle and near its four corners
        const places = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].map(([fx, fy]) => {
          const o = (Math.floor((row + fy) * k) * image.width + Math.floor((x + fx) * k)) * 4;
          return [px[o], px[o + 1], px[o + 2]].join(',');
        });
        out.push({ flat: new Set(places).size === 1, colour: places[0] });
      }
    }
    return { size: [image.width, image.height], out };
  }, { png: shot, w: 8, h: 6 });
  expect(blocks.size).toEqual([zoom * 8, zoom * 6]);
  for (let row = 0; row < 6; row++) {
    for (let x = 0; x < 8; x++) {
      const v = (5 - row) * 8 + x, b = blocks.out[row * 8 + x];
      expect(b.flat, `the square of value ${v} is one colour`).toBe(true);
      expect(b.colour).toBe(v === 13 ? NONE.join(',') : [grey(v), grey(v), grey(v)].join(','));
    }
  }
});

test('the difference is drawn in noise units on a fixed scale of ±5, grey below 3, and is labelled "resampled"', async ({ page }) => {
  await boot(page);
  const values = [-50, -5.01, -5, -4, -3.2, -3, -2.99, -1, 0, 1, 2.99, 3, 3.2, 4, 5, 5.01, 50, NaN];
  const got = await page.evaluate((list) => {
    const t = /** @type {any} */ (window).__t;
    const w = list.length, h = 2, data = new Float32Array(w * h);
    for (let x = 0; x < w; x++) { data[x] = list[x]; data[w + x] = list[w - 1 - x]; }
    const points = /** @type {any[]} */ ([]);
    t.open(0, 2, { onPoint: (/** @type {any} */ p) => points.push(p) }, { view: { diff: { w, h, data, tx: 3.5, ty: 0.5, sigma: 0.2 } } });
    const before = t.read();
    t.stage.setMode('diff');
    return { before, diff: t.read(), text: t.host.textContent, mode: t.stage.mode };
  }, values);
  expect(got.before.panels.map((/** @type {any} */ p) => p.kind)).toEqual(['a']);
  expect(got.mode).toBe('diff');
  const p = got.diff.panels[0];
  expect([p.kind, p.w, p.h, p.isDiff]).toEqual(['diff', values.length, 2, true]);
  /** @param {number} x @param {number} y */
  const at = (x, y) => p.rgba.slice(((1 - y) * values.length + x) * 4, ((1 - y) * values.length + x) * 4 + 3);
  const isGrey = (/** @type {number[]} */ c) => c[0] === c[1] && c[1] === c[2];
  for (const [x, u] of values.entries()) {
    const c = at(x, 0);
    expect(at(values.length - 1 - x, 1), 'the same value, the same colour, wherever it stands').toEqual(c);
    if (Number.isNaN(u)) expect(c).toEqual(NONE);
    else if (Math.abs(u) < 3) expect(isGrey(c), `${u} is grey`).toBe(true);
    else expect(isGrey(c), `${u} is coloured`).toBe(false);
    if (u >= 5) expect(c, `${u}: the full colour of "brighter"`).toEqual(POS);
    if (u <= -5) expect(c, `${u}: the full colour of "fainter"`).toEqual(NEG);
  }
  expect(at(7, 0)[0]).toBeLessThan(at(8, 0)[0]); // -1 is darker than 0
  expect(at(8, 0)[0]).toBeLessThan(at(9, 0)[0]); // 0 is darker than +1
  // a pixel without a value is hatched, not coloured as a difference
  expect(p.saturated[values.length - 1]).toBe(1);

  const panel = page.locator('#t-stage .stage-panel[data-kind="diff"]');
  await expect(panel.locator('.stage-resampled')).toHaveText('resampled');
  await expect(panel.locator('.stage-caption')).toContainText('Difference: later visit minus earlier visit');
  const legend = page.locator('#t-stage .stage-legend-diff');
  await expect(legend).toContainText('−5');
  await expect(legend).toContainText('+5');
  await expect(page.locator('#t-stage .stage-diff-words')).toContainText('grey means less than 3 times the noise');
  await expect(page.locator('#t-stage .stage-legend')).toContainText('no value: this pixel could not be compared');
  // the key of the legend is painted with the same rule: its two ends are the two full colours, its middle is grey
  const key = await page.locator('#t-stage .stage-diff-key').evaluate((c) => {
    const d = /** @type {CanvasRenderingContext2D} */ (/** @type {HTMLCanvasElement} */ (c).getContext('2d')).getImageData(0, 0, 201, 1).data;
    return [0, 100, 200].map((i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  });
  expect(key[0]).toEqual(NEG);
  expect(key[2]).toEqual(POS);
  expect(isGrey(key[1])).toBe(true);
});

test('without a difference, the Difference view says so instead of showing one', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  await page.locator('#t-stage .stage-mode[data-mode="diff"]').click();
  await expect(page.locator('#t-stage .stage-message')).toHaveText(/There is no difference picture for these two visits/);
  await expect(page.locator('#t-stage .stage-panel')).toHaveCount(0);
  await page.locator('#t-stage .stage-mode[data-mode="blink"]').click();
  await expect(page.locator('#t-stage .stage-panel')).toHaveCount(1);
  await expect(page.locator('#t-stage .stage-message')).toHaveText('');
});

test('saturation is hatched one way and defects the other; a known source only on the toggle', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  const SAT = (1 << 1) | (1 << 15) | (1 << 26), SOURCE = 1 << 21;
  const DEFECT = [0, 2, 6, 9, 10, 11, 17, 19, 20, 22, 23, 24, 25, 27, 28].reduce((w, b) => w | (1 << b), 0);
  const want = (/** @type {number} */ frame, /** @type {number} */ mask, missing = false) => Array.from({ length: N }, (_, i) => ((fileFlags[frame * N + i] & mask) !== 0 || (missing && !Number.isFinite(fileData[frame * N + i])) ? 1 : 0));

  let p = (await read(page)).panels[0];
  expect(p.saturated).toEqual(want(0, SAT, true));
  expect(p.defect).toEqual(want(0, DEFECT));
  expect(p.source, 'known sources are not marked until asked for').toBeNull();
  const sourceOnly = want(0, SOURCE).filter((v, i) => v && !p.saturated[i] && !p.defect[i]).length;
  expect(sourceOnly, 'nearly every pixel of this field lies on a known source').toBeGreaterThan(3500);
  expect(p.saturated.filter(Boolean).length + p.defect.filter(Boolean).length).toBeLessThan(500);

  // on the page: two hatchings with lines in opposite directions, each over exactly its pixels; nothing for sources
  const marks = () => page.evaluate(() => {
    const panel = /** @type {Element} */ (document.querySelector('#t-stage .stage-panel'));
    const area = (/** @type {string} */ sel) => [...(/** @type {Element} */ (panel.querySelector(sel)).getAttribute('d') ?? '').matchAll(/h(\d+)v1/g)].reduce((n, m) => n + Number(m[1]), 0);
    const line = (/** @type {string} */ sel) => {
      const path = /** @type {Element} */ (panel.querySelector(sel)), id = /url\(#([^)]+)\)/.exec(path.getAttribute('fill') ?? '')?.[1] ?? '';
      const [, x1, y1, x2, y2] = /^M([-\d.e]+) ([-\d.e]+)L([-\d.e]+) ([-\d.e]+)/.exec(/** @type {Element} */ (/** @type {Element} */ (panel.querySelector(`#${id}`)).firstElementChild).getAttribute('d') ?? '') ?? [];
      return Math.sign((Number(y2) - Number(y1)) * (Number(x2) - Number(x1))); // on the screen y runs down: -1 rises to the right
    };
    return {
      saturated: area('.stage-hatch-saturated'), defect: area('.stage-hatch-defect'), source: area('.stage-source'),
      rises: [line('.stage-hatch-saturated'), line('.stage-hatch-defect')],
      stroke: getComputedStyle(/** @type {Element} */ (panel.querySelector('.stage-hatch-line'))).stroke,
      legend: [.../** @type {Element} */ (document.querySelector('#t-stage .stage-legend')).querySelectorAll('li')].map((li) => li.textContent),
    };
  });
  let m = await marks();
  expect(m.saturated).toBe(p.saturated.filter(Boolean).length);
  expect(m.defect).toBe(p.defect.filter(Boolean).length);
  expect(m.source).toBe(0);
  expect(m.rises).toEqual([-1, 1]);
  expect(m.stroke).toBe('rgb(255, 106, 193)');
  expect(m.legend).toEqual(['saturated: too bright to measure', 'damaged or disturbed pixel']);

  // the toggle marks the known sources, and takes the marks away again
  const toggle = page.locator('#t-stage').getByLabel('Mark known stars and galaxies');
  await page.locator('#t-stage .stage-display-details > summary').click(); // the toggle stands in the disclosure "Display"
  await toggle.check();
  p = (await read(page)).panels[0];
  expect(p.source).toEqual(want(0, SOURCE));
  m = await marks();
  expect(m.source).toBe(want(0, SOURCE).filter(Boolean).length);
  expect(m.legend).toEqual(['saturated: too bright to measure', 'damaged or disturbed pixel', 'known star or galaxy']);
  expect([m.saturated, m.defect]).toEqual([p.saturated.filter(Boolean).length, p.defect.filter(Boolean).length]);
  await toggle.uncheck();
  expect((await read(page)).panels[0].source).toBeNull();
  expect((await marks()).source).toBe(0);

  // the other visit has its own flags, and the curtain takes the marks of each side with its columns
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.step('b'));
  await expect.poll(async () => (await read(page)).side).toBe('b');
  p = (await read(page)).panels[0];
  expect(p.saturated).toEqual(want(2, SAT, true));
  expect(p.defect).toEqual(want(2, DEFECT));
  await page.evaluate(() => { const s = /** @type {any} */ (window).__t.stage; s.setMode('curtain'); s.setCurtain(0.5); });
  p = (await read(page)).panels[0];
  const mixed = (/** @type {number} */ mask, missing = false) => { const a = want(0, mask, missing), b = want(2, mask, missing); return a.map((v, i) => (i % W < W / 2 ? v : b[i])); };
  expect(p.saturated).toEqual(mixed(SAT, true));
  expect(p.defect).toEqual(mixed(DEFECT));
});

test('a stamp without flags hatches only its missing values, and offers no toggle', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2, {}, { a: { flags: null }, b: { flags: null } }));
  const p = (await read(page)).panels[0];
  expect(p.saturated).toEqual(Array.from({ length: N }, (_, i) => (Number.isFinite(fileData[i]) ? 0 : 1)));
  expect(p.saturated.filter(Boolean).length).toBe(3);
  expect(p.defect.every((/** @type {number} */ v) => v === 0)).toBe(true);
  await expect(page.locator('#t-stage').getByLabel('Mark known stars and galaxies')).toBeHidden();
});

test('pixels whose colours differ between the two visits are veiled, and the veil is labelled', async ({ page }) => {
  await boot(page);
  // matched in a band of rows around the target, as the colour runs along y; the stage is handed the mask
  const got = await page.evaluate(() => {
    const t = /** @type {any} */ (window).__t, w = 64, h = 64;
    const matched = Uint8Array.from({ length: w * h }, (_, i) => (Math.abs(Math.floor(i / w) - 32) <= 20 ? 1 : 0));
    t.open(0, 2, {}, { a: { matched }, b: { matched } });
    const d = /** @type {Element} */ (document.querySelector('#t-stage .stage-veil')).getAttribute('d') ?? '';
    return { read: t.read(), matched: Array.from(matched), d, fill: getComputedStyle(/** @type {Element} */ (document.querySelector('#t-stage .stage-veil'))).fill };
  });
  const p = got.read.panels[0];
  expect(p.veiled).toEqual(got.matched.map((/** @type {number} */ v) => 1 - v));
  expect(p.veiled.filter(Boolean).length).toBe((64 - 41) * 64);
  // drawn as whole rows at the top and at the bottom of the picture
  const rects = [...got.d.matchAll(/M(\d+) (\d+)h(\d+)v1/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  expect(rects.length).toBe(64 - 41);
  expect(rects.every(([x, y, len]) => x === 0 && len === 64 && (y < 11 || y > 51))).toBe(true);
  expect(got.fill).toBe('rgba(10, 12, 16, 0.72)');
  await expect(page.locator('#t-stage .stage-legend')).toContainText('colours differ here');
  // the values under the veil are untouched
  expect(p.bits).toEqual(fileBits(0));
  expect(p.rgba).toEqual(wantRgba(0, 0));

  // no mask, no veil and no label
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  expect((await read(page)).panels[0].veiled).toBeNull();
  await expect(page.locator('#t-stage .stage-legend')).not.toContainText('colours differ here');
});

test('Blink changes picture at most twice a second, pauses, and steps', async ({ page }) => {
  await boot(page);
  // playing: every change of picture over three seconds, timed in the page at the moment the stage draws it
  const played = await page.evaluate(async () => {
    const t = /** @type {any} */ (window).__t, t0 = performance.now();
    t.open(0, 2, { autoplay: true });
    const s = t.stage, playing = s.playing;
    /** @type {{ms: number, side: string, from: string, same: boolean}[]} */
    const changes = [];
    /** @type {Record<string, number[]>} */
    const first = { a: Array.from(s.readback().panels[0].rgba) };
    let last = s.side;
    const watch = new MutationObserver(() => {
      if (s.side === last) return;
      last = s.side;
      const p = s.readback().panels[0], rgba = Array.from(p.rgba);
      first[last] ??= rgba;
      changes.push({ ms: performance.now() - t0, side: last, from: p.values === t.view.a.data ? 'a' : p.values === t.view.b.data ? 'b' : '?', same: rgba.every((v, i) => v === first[last][i]) });
    });
    watch.observe(t.host, { attributes: true, attributeFilter: ['data-side'] });
    await new Promise((r) => setTimeout(r, 3000));
    watch.disconnect();
    return { playing, changes, first, flips: s.flips };
  });
  expect(played.playing).toBe(true);
  expect(played.changes.length).toBeGreaterThanOrEqual(2);
  expect(played.changes.length, 'at most 2 changes of picture a second').toBeLessThanOrEqual(6);
  expect(played.flips, 'the count the stage keeps is the count of what it drew').toBe(played.changes.length);
  expect(played.changes.map((c) => c.side), 'the two visits in turn').toEqual(played.changes.map((_, i) => (i % 2 ? 'a' : 'b')));
  // each change drew the picture of the visit it names, from the array of that stamp, the same bytes every time
  expect(played.changes.every((c) => c.from === c.side && c.same)).toBe(true);
  expect(played.first.a).toEqual(wantRgba(0, 0));
  expect(played.first.b).toEqual(wantRgba(0, 1));
  // no picture was on for less than half a second
  for (let i = 1; i < played.changes.length; i++) {
    expect(played.changes[i].ms - played.changes[i - 1].ms, 'each picture stays on for at least half a second').toBeGreaterThanOrEqual(498);
  }
  expect(played.changes[0].ms, 'the first picture too, counted from the moment it was shown').toBeGreaterThanOrEqual(498);

  // paused: nothing changes
  await page.locator('#t-stage .stage-play').click();
  await expect(page.locator('#t-stage .stage-play')).toHaveText('PLAY');
  const paused = await read(page);
  await page.waitForTimeout(1200);
  const later = await read(page);
  expect([later.playing, later.flips, later.side]).toEqual([false, paused.flips, paused.side]);

  // stepping: one press, one change of picture
  await page.waitForTimeout(600);
  await page.locator('#t-stage .stage-step').click();
  const stepped = await read(page);
  expect(stepped.flips).toBe(paused.flips + 1);
  expect(stepped.side).not.toBe(paused.side);

  // however fast it is asked, it does not change more often: twenty requests at once give one change, half a second later
  await page.waitForTimeout(600);
  const burst = await page.evaluate(async () => {
    const s = /** @type {any} */ (window).__t.stage, start = s.flips, t = performance.now();
    for (let i = 0; i < 21; i++) s.step();
    const atOnce = s.flips - start;
    /** @type {number[]} */
    const when = [];
    let last = s.flips;
    while (performance.now() - t < 1400) {
      await new Promise((r) => setTimeout(r, 10));
      if (s.flips !== last) { when.push(performance.now() - t); last = s.flips; }
    }
    return { atOnce, total: s.flips - start, when };
  });
  expect(burst.atOnce).toBe(1);
  expect(burst.total, 'twenty-one steps in a row ask for the other picture and back twenty times; only the last wish is kept').toBeLessThanOrEqual(2);
  for (const ms of burst.when) expect(ms).toBeGreaterThanOrEqual(490);
});

test('the keys: space plays and pauses, the arrows step, D shows the difference and goes back', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const t = /** @type {any} */ (window).__t;
    t.open(0, 2, { autoplay: true }, { view: { diff: { w: 64, h: 64, data: new Float32Array(64 * 64), tx: 32, ty: 32 } } });
  });
  const pictures = page.locator('#t-stage .stage-pictures');
  await pictures.focus();
  await expect(pictures).toBeFocused();
  expect((await read(page)).playing).toBe(true);
  await page.keyboard.press('Space');
  expect((await read(page)).playing).toBe(false);
  await page.keyboard.press('Space');
  expect((await read(page)).playing).toBe(true);

  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await read(page)).side).toBe('b');
  expect((await read(page)).playing, 'stepping stops the blink').toBe(false);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await read(page)).side).toBe('a');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  expect((await read(page)).side, 'the left arrow shows the earlier visit, however often it is pressed').toBe('a');

  await page.keyboard.press('d');
  expect((await read(page)).mode).toBe('diff');
  await expect(page.locator('#t-stage .stage-mode[data-mode="diff"]')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('d');
  expect((await read(page)).mode).toBe('blink');
  // from another view, D goes to the difference and back to that view
  await page.locator('#t-stage .stage-mode[data-mode="side"]').click();
  await page.keyboard.press('D');
  expect((await read(page)).mode).toBe('diff');
  await page.keyboard.press('D');
  expect((await read(page)).mode).toBe('side');
  // Space on a button presses the button, and does nothing else
  await page.locator('#t-stage .stage-mode[data-mode="blink"]').focus();
  await page.keyboard.press('Space');
  const now = await read(page);
  expect(now.mode).toBe('blink');
});

test('reduced motion means step mode: nothing plays, space and the button step', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2, { autoplay: true }));
  const start = await read(page);
  expect(start.playing).toBe(false);
  await expect(page.locator('#t-stage .stage-play')).toBeHidden();
  await expect(page.locator('#t-stage .stage-step')).toBeVisible();
  await page.waitForTimeout(1800);
  expect((await read(page)).flips, 'nothing moves by itself').toBe(start.flips);
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.play());
  expect((await read(page)).playing, 'asking it to play changes nothing').toBe(false);

  await page.locator('#t-stage .stage-pictures').focus();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await read(page)).side).toBe('b');
  await page.waitForTimeout(550);
  await page.locator('#t-stage .stage-step').click();
  await expect.poll(async () => (await read(page)).side).toBe('a');
  expect((await read(page)).flips).toBe(start.flips + 2);
  // other views are still there
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.setMode('side'));
  expect((await read(page)).panels.length).toBe(2);
});

test('the modes: Blink and Difference show; Curtain and Side by side stand beside them as joined choices', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  const stage = page.locator('#t-stage');
  await expect(stage.getByRole('button', { name: 'Blink', exact: true })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Difference', exact: true })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Curtain', exact: true })).toBeVisible();
  await expect(stage.getByRole('button', { name: 'Side by side', exact: true })).toBeVisible();
  await stage.getByRole('button', { name: 'Side by side', exact: true }).click();
  await expect(stage.locator('.stage-panel')).toHaveCount(2);
  await expect(stage.locator('.stage-panel').nth(0).locator('.stage-caption')).toContainText('Earlier visit');
  await expect(stage.locator('.stage-panel').nth(0).locator('.stage-caption')).toContainText('25 Aug 2025, 17:09 UTC');
  await expect(stage.locator('.stage-panel').nth(0).locator('.colour-chip')).toHaveText('4.296 µm');
  await expect(stage.locator('.stage-panel').nth(1).locator('.stage-caption')).toContainText('Later visit');
  await expect(stage.locator('.stage-panel').nth(1).locator('.stage-caption')).toContainText('15 Mar 2026, 00:51 UTC');
  await stage.getByRole('button', { name: 'Curtain', exact: true }).click();
  await expect(stage.locator('.stage-panel')).toHaveCount(1);
  await expect(stage.getByRole('button', { name: 'Curtain', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(stage.getByRole('button', { name: 'Blink', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // the pair is at one colour, and the stage says how close the two colours are
  await expect(stage.locator('.stage-match')).toHaveText('Same colour: the two pictures are 0.0006 µm apart; up to 0.0187 µm counts as the same colour.');
  // two photos that are not at the same colour are called that
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 3));
  await expect(stage.locator('.stage-match')).toHaveText(/^Not the same colour: the two pictures are 0\.0744 µm apart/);
  await expect(stage.locator('.stage-match')).toHaveAttribute('data-same', 'false');
});

test('the scale bar is 60 arcsec at 6.15 arcsec to a pixel, and the compass comes from the frame', async ({ page }) => {
  await boot(page);
  // without a transform there is a scale bar and no compass
  await page.evaluate(() => /** @type {any} */ (window).__t.open(0, 2));
  const stage = page.locator('#t-stage');
  await expect(stage.locator('.stage-scale-label')).toHaveText('60 arcsec');
  await expect(stage.locator('.stage-compass')).toHaveCount(0);
  const { cssWidth } = (await read(page)).panels[0];
  const bar = /** @type {{width: number}} */ (await stage.locator('.stage-scale-bar').boundingBox());
  expect(Math.abs(bar.width - (60 / 6.15) * (cssWidth / W))).toBeLessThan(0.51);

  // with the transform of each frame (astropy, from its header): north is down in August and up in March
  const keys = manifest.frames.map((/** @type {{key: string}} */ f) => f.key);
  await page.evaluate(({ a, b }) => /** @type {any} */ (window).__t.open(0, 2, {}, { a: { sky: a }, b: { sky: b } }), { a: sky[keys[0]].sky, b: sky[keys[2]].sky });
  const compass = stage.locator('.stage-compass');
  await expect(compass).toHaveCount(1);
  await expect(compass).toHaveAttribute('data-north', String(Math.round(sky[keys[0]].north_angle)));
  expect(Math.round(sky[keys[0]].north_angle)).toBe(181);
  // the arrow on the page points where astropy says north is
  const arrow = () => compass.locator('line').first().evaluate((l) => ['x1', 'y1', 'x2', 'y2'].map((k) => Number(l.getAttribute(k))));
  let [x1, y1, x2, y2] = await arrow();
  let len = Math.hypot(x2 - x1, y2 - y1);
  expect((x2 - x1) / len).toBeCloseTo(sky[keys[0]].north[0], 6);
  expect(-(y2 - y1) / len).toBeCloseTo(sky[keys[0]].north[1], 6);
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.step('b'));
  await expect(compass).toHaveAttribute('data-north', String(Math.round(sky[keys[2]].north_angle)));
  [x1, y1, x2, y2] = await arrow();
  len = Math.hypot(x2 - x1, y2 - y1);
  expect(-(y2 - y1) / len, 'north points up in the later visit').toBeGreaterThan(0.99);
  // the curtain has one compass for each side
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.setMode('curtain'));
  await expect(compass).toHaveCount(2);
  expect(await compass.evaluateAll((list) => list.map((c) => c.getAttribute('data-north')))).toEqual(['181', '1']);
});

test('the readout under the pointer equals the stamp at five points: sky, colour, value, flags, date, file', async ({ page }) => {
  await boot(page);
  for (const id of FRAME_IDS) {
    const frame = loadFrame(id), ref = sky[frame.meta.key];
    // the frame fixture as a picture with its sky, shown on both sides; the readout is wired as the page wires it
    await page.evaluate(async ({ id: name, stamp, skyOf }) => {
      const t = /** @type {any} */ (window).__t;
      const get = async (/** @type {string} */ file) => (await fetch(`__fixtures__/frames/${name}/${file}`)).arrayBuffer();
      const picture = { ...stamp, data: new Float32Array(await get('image.f32')), flags: new Int32Array(await get('flags.i32')), sky: skyOf };
      t.tables ??= await t.rulerMod.loadTables();
      t.readoutBox ??= /** @type {HTMLElement} */ (document.querySelector('main')).appendChild(Object.assign(document.createElement('section'), { id: 't-readout' }));
      t.hover = t.hoverMod.createHover(t.readoutBox);
      t.stage?.destroy();
      t.view = { a: picture, b: picture };
      t.stage = t.stageMod.createStage(t.host, { autoplay: false, onPoint: (/** @type {any} */ p) => t.hover.show(p ? t.hoverMod.readout(p, { wavelengthAt: t.rulerMod.colourLookup(t.tables) }) : null) });
      t.stage.show(t.view);
    }, { id, stamp: frame.meta.stamp, skyOf: ref.sky });

    const canvas = page.locator('#t-stage .stage-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const s = frame.meta.stamp;
    for (const p of ref.points) {
      const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
      await page.mouse.move(box.x + (p.x + 0.5) * box.width / s.w, box.y + (s.h - 1 - p.y + 0.5) * box.height / s.h);
      // once the page has handled the pointer, the readout names that pixel
      await expect(page.locator('#t-readout')).toHaveAttribute('data-x', String(p.x));
      await expect(page.locator('#t-readout')).toHaveAttribute('data-y', String(p.y));
      const out = await page.locator('#t-readout').evaluate((e) => ({ ...e.dataset, text: e.textContent }));
      const i = p.y * s.w + p.x, at = `${id}, pixel ${p.x}, ${p.y}`;
      expect([out.x, out.y, out.kind], at).toEqual([String(p.x), String(p.y), 'a']);
      // the stamp's own values
      expect(Number.isFinite(frame.data[i]) ? Number(out.value) : out.value, at).toBe(Number.isFinite(frame.data[i]) ? frame.data[i] : undefined);
      expect(Number(out.word), at).toBe(frame.flags[i]);
      expect(Number(out.mjd), at).toBe(s.mjd);
      expect(out.id, at).toBe(frame.meta.key.split('/').pop().slice(7).split('_spx_')[0]);
      // the colour of that pixel, as scipy reads it from the table; the sky position, as astropy computes it
      expect(Math.abs(Number(out.lam) - p.lam), at).toBeLessThan(1e-12);
      const arcsec = 3600 * Math.hypot((Number(out.ra) - p.ra) * Math.cos(p.dec * Math.PI / 180), Number(out.dec) - p.dec);
      expect(arcsec, `${at}: distance from astropy in arcsec`).toBeLessThan(0.1);
      // and in words
      expect(out.text).toContain(`${p.lam.toFixed(3)} µm`);
      expect(out.text).toContain(`RA ${Number(out.ra).toFixed(4)}°`);
      expect(out.text).toContain('MJy/sr');
      expect(out.unit).toBe('MJy/sr');
      for (const name of (out.flags ?? '').split(' ').filter(Boolean)) expect(out.text).toContain(name);
      expect(out.flags?.split(' ')).not.toContain('FULLSAMPLE');
    }
    // leaving the picture empties the readout
    await page.mouse.move(2, 2);
    await expect(page.locator('#t-readout')).toHaveAttribute('data-empty', 'true');
  }
});

test('in Blink the readout follows the picture: the same pixel, the other visit', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const t = /** @type {any} */ (window).__t;
    t.seen = [];
    t.open(0, 2, { onPoint: (/** @type {any} */ p) => t.seen.push(p && { kind: p.kind, x: p.x, y: p.y, value: p.picture.data[p.y * p.picture.w + p.x] }) });
  });
  const canvas = page.locator('#t-stage .stage-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = /** @type {{x: number, y: number, width: number, height: number}} */ (await canvas.boundingBox());
  await page.mouse.move(box.x + (10 + 0.5) * box.width / W, box.y + (H - 1 - 20 + 0.5) * box.height / H);
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__t.seen.length), 'once the page has handled the pointer').toBeGreaterThan(0);
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.step('b'));
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).__t.stage.side)).toBe('b');
  const seen = await page.evaluate(() => /** @type {any} */ (window).__t.seen);
  expect(seen.at(-2)).toEqual({ kind: 'a', x: 10, y: 20, value: fileData[0 * N + 20 * W + 10] });
  expect(seen.at(-1)).toEqual({ kind: 'b', x: 10, y: 20, value: fileData[2 * N + 20 * W + 10] });
});

test('the stage fits a window 360 px wide in every view', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await boot(page);
  const keys = manifest.frames.map((/** @type {{key: string}} */ f) => f.key);
  await page.evaluate(({ a, b }) => {
    const t = /** @type {any} */ (window).__t;
    t.open(0, 2, {}, { a: { sky: a }, b: { sky: b }, view: { diff: { w: 64, h: 64, data: new Float32Array(64 * 64), tx: 32, ty: 32 } } });
  }, { a: sky[keys[0]].sky, b: sky[keys[2]].sky });
  for (const mode of ['blink', 'diff', 'curtain', 'side']) {
    await page.evaluate((m) => /** @type {any} */ (window).__t.stage.setMode(m), mode);
    const fit = await page.evaluate(() => {
      const host = /** @type {HTMLElement} */ (document.querySelector('#t-stage'));
      const over = [...host.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 && getComputedStyle(e).display !== 'none' && !e.parentElement?.closest('details:not([open])')).map((e) => e.className);
      return { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, over, zoom: [...host.querySelectorAll('.stage-panel')].map((e) => Number(/** @type {HTMLElement} */ (e).dataset.zoom)) };
    });
    expect(fit.scroll, mode).toBeLessThanOrEqual(fit.client);
    expect(fit.over, mode).toEqual([]);
    expect(fit.zoom, mode).toEqual(mode === 'side' ? [2, 2] : [5]);
  }
  // every button of the stage can be pressed with a thumb
  await page.evaluate(() => /** @type {any} */ (window).__t.stage.setMode('blink'));
  const small = await page.evaluate(() => [.../** @type {Element} */ (document.querySelector('#t-stage')).querySelectorAll('button')].filter((b) => b.offsetParent !== null && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44)).map((b) => b.textContent));
  expect(small).toEqual([]);
});
