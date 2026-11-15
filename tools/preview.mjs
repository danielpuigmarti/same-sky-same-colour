#!/usr/bin/env node
// The picture a link to the site shows when it is shared (1200 by 630, site/img/preview.png): the site's name and
// what it does, beside the comet in the photo of 26 February 2026 at the colour of carbon dioxide. It is drawn from
// the site's own files (its name in site/data/site.json, its typefaces in site/fonts/, the photo in
// site/data/lemmon/wide/) by the browser of the test runner, so it can be made again whenever one of them changes.
//
//   node tools/preview.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(SITE, 'img', 'preview.png');

const site = JSON.parse(readFileSync(path.join(SITE, 'data', 'site.json'), 'utf8'));
const wide = JSON.parse(readFileSync(path.join(SITE, 'data', 'lemmon', 'wide', 'manifest.json'), 'utf8'));
/** @type {{file: string, lam_um: number}[]} */
const pictures = wide.pictures ?? [];
/** The photo at the colour of carbon dioxide on 26 February 2026: the one whose colour is nearest 4.266 µm. */
const glow = [...pictures].sort((a, b) => Math.abs(a.lam_um - 4.266) - Math.abs(b.lam_um - 4.266))[0];
if (!glow) throw new Error('site/data/lemmon/wide/manifest.json lists no picture');
const file = glow.file;
const url = (/** @type {string} */ p) => pathToFileURL(path.join(SITE, p)).href;

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
@font-face { font-family: "Archivo"; src: url("${url('fonts/archivo-latin.woff2')}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
@font-face { font-family: "Courier Prime"; src: url("${url('fonts/courier-prime-400-latin.woff2')}") format("woff2"); font-weight: 400; }
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: #0c0b08; color: #f1ead6; font-family: "Archivo", sans-serif; position: relative; overflow: hidden; }
.text { position: absolute; left: 64px; top: 56px; width: 520px; }
.name { font-stretch: 62%; font-weight: 900; font-size: 92px; line-height: 0.9; letter-spacing: -0.012em; color: #f2c41c; margin: 0; }
.rule { height: 4px; background: #f2c41c; margin: 34px 0 28px; width: 520px; }
.what { font-size: 27px; line-height: 1.32; margin: 0; text-wrap: pretty; }
.cells { position: absolute; left: 64px; bottom: 56px; width: 520px; display: grid; grid-template-columns: auto auto auto; border-top: 1.5px solid #3b3521; font-family: "Courier Prime", monospace; font-size: 17px; line-height: 1.3; }
.cells div { padding: 12px 18px 0 0; }
.cells div + div { padding-left: 18px; border-left: 1.5px solid #3b3521; }
.cells span { display: block; color: #a89f82; }
.plate { position: absolute; right: 40px; top: 40px; width: 550px; height: 550px; background: #000 url("${url(`data/lemmon/wide/${file}`)}") center / 1100px 1100px no-repeat; image-rendering: pixelated; }
.verdict { position: absolute; left: 22px; bottom: 18px; font-stretch: 62%; font-weight: 900; font-size: 52px; line-height: 0.9; color: #f2c41c; }
</style></head><body>
<div class="text">
<p class="name">${esc(site.name.toUpperCase())}</p>
<div class="rule"></div>
<p class="what">Type any star or place in the sky and flip between NASA SPHEREx photos of it, taken months apart in the same infrared colour.</p>
</div>
<div class="cells"><div><span>Object</span>Comet Lemmon</div><div><span>Taken</span>26 Feb 2026</div><div><span>Colour</span>4.266&#8239;µm</div></div>
<div class="plate"><div class="verdict">COMET LEMMON</div></div>
</body></html>`;

const dir = path.join(tmpdir(), `preview-${process.pid}`);
mkdirSync(dir, { recursive: true });
const page = path.join(dir, 'card.html');
writeFileSync(page, html);
const browser = await chromium.launch();
try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await tab.goto(pathToFileURL(page).href);
  await tab.evaluate(() => document.fonts.ready);
  mkdirSync(path.dirname(OUT), { recursive: true });
  await tab.screenshot({ path: OUT, type: 'png' });
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`wrote ${path.relative(ROOT, OUT)} from ${file}`);
