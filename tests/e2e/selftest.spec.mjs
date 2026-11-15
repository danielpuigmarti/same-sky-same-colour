// The live self-test on the Checks page, in a real browser. The archive is stood in for by page.route: a FITS file
// whose header is that of the stored answer (the headers and the first stamp rows are real bytes, the rest zeros).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const ANSWER = JSON.parse(readFileSync(new URL('../../site/data/selftest/answer.json', import.meta.url), 'utf8'));
const BLOCK = 2880, NX = 2040, NY = 2040;
const MJD = ANSWER.values.find((v) => v.id === 'mjd').stored;
const X = 930.7172035534379, Y = 1982.5141416088813; // where the target falls, 0-based
const P = 0.0017083333333333334;

function card(key, value) {
  const text = typeof value === 'string' ? `'${value.padEnd(8)}'` : typeof value === 'boolean' ? (value ? 'T' : 'F').padStart(20) : String(value).padStart(20);
  return `${key.padEnd(8)}= ${text}`.padEnd(80);
}
function header(cards) {
  const text = cards.map(([k, v]) => card(k, v)).join('') + 'END'.padEnd(80);
  return Buffer.from(text.padEnd(Math.ceil(text.length / BLOCK) * BLOCK), 'latin1');
}
function fileStart({ mjd = MJD } = {}) {
  return Buffer.concat([
    header([['SIMPLE', true], ['BITPIX', 8], ['NAXIS', 0], ['EXTEND', true]]),
    header([
      ['XTENSION', 'IMAGE'], ['BITPIX', -32], ['NAXIS', 2], ['NAXIS1', NX], ['NAXIS2', NY], ['PCOUNT', 0], ['GCOUNT', 1], ['EXTNAME', 'IMAGE'],
      ['MJD-AVG', mjd], ['CTYPE1', 'RA---TAN'], ['CTYPE2', 'DEC--TAN'], ['CRVAL1', ANSWER.target.ra], ['CRVAL2', ANSWER.target.dec],
      ['CRPIX1', X + 1], ['CRPIX2', Y + 1], ['CD1_1', -P], ['CD1_2', 0], ['CD2_1', 0], ['CD2_2', P],
    ]),
  ]);
}

/** Answer every range request for the photo; `mjd` is what its header says. */
async function stubArchive(page, options) {
  const start = fileStart(options);
  let requests = 0;
  await page.route(/amazonaws\.com\/.*\.fits$/, (route) => {
    requests++;
    const m = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range ?? '');
    const a = Number(m[1]), b = Number(m[2]);
    const body = Buffer.alloc(b - a + 1);
    if (a < start.length) start.copy(body, 0, a, Math.min(start.length, b + 1));
    route.fulfill({ status: 206, headers: { 'content-range': `bytes ${a}-${b}/99999999`, 'access-control-allow-origin': '*' }, body });
  });
  return () => requests;
}

const button = (page) => page.getByRole('button', { name: 'Test the live connection now' });

test('the rule is written before the button, with its tolerances and reasons', async ({ page }) => {
  await page.goto('checks.html');
  const section = page.locator('#selftest');
  await expect(button(page)).toBeVisible();
  const rule = section.locator('.selftest-rule li');
  await expect(rule).toHaveCount(ANSWER.values.length);
  await expect(section).toContainText('0.1000 arcsec');
  const order = await section.evaluate((s) => {
    const r = s.querySelector('.selftest-rule'), b = s.querySelector('button');
    return Boolean(r.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('with an archive that holds the stored answer, every line matches', async ({ page }) => {
  const requests = await stubArchive(page);
  await page.goto('checks.html');
  await button(page).click();
  const verdict = page.locator('.selftest-verdict');
  await expect(verdict).toContainText('matches the stored answer');
  await expect(verdict).toHaveAttribute('data-state', 'matches');
  await expect(verdict).toContainText('Time taken');
  await expect(verdict).toContainText('level2_2025W46_1A_0075_4D6');
  const rows = page.locator('.selftest-table tbody tr');
  await expect(rows).toHaveCount(ANSWER.values.length);
  await expect(page.locator('.selftest-table tr[data-ok="false"]')).toHaveCount(0);
  expect(requests()).toBeGreaterThan(1);
});

test('with a stored value that was perturbed, the test says it differs and which line', async ({ page }) => {
  await stubArchive(page);
  await page.route('**/data/selftest/answer.json', async (route) => {
    const res = await route.fetch();
    const a = await res.json();
    a.values.find((v) => v.id === 'mjd').stored += 0.5;
    await route.fulfill({ response: res, json: a });
  });
  await page.goto('checks.html');
  await button(page).click();
  const verdict = page.locator('.selftest-verdict');
  await expect(verdict).toContainText('differs from the stored answer');
  await expect(verdict).toHaveAttribute('data-state', 'differs');
  const bad = page.locator('.selftest-table tr[data-ok="false"]');
  await expect(bad).toHaveCount(1);
  await expect(bad).toContainText('Time of the photo');
  await expect(bad.locator('td').last()).toHaveText('no');
});

test('with the archive blocked, the page says it cannot be reached and points to the prepared targets', async ({ page }) => {
  await page.route(/amazonaws\.com\//, (route) => route.abort('connectionrefused'));
  await page.goto('checks.html');
  await button(page).click();
  const message = page.locator('.selftest-out [data-state="unreachable"]');
  await expect(message).toContainText('could not be reached', { timeout: 30000 });
  await expect(message.getByRole('link', { name: 'The prepared targets' })).toHaveAttribute('href', 'targets.html');
  await expect(page.locator('.selftest-table')).toHaveCount(0);
  await expect(button(page)).toBeEnabled();
});
