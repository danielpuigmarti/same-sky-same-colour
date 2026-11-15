#!/usr/bin/env node
// The fifteen reviews that two people were to do before the project went out, in the order they are done. None was
// done within the hackathon; every row they cover stays UNVERIFIED on the Checks page until one is.
//
//   node tools/review.mjs --list     print the table: what to open, the one number, the pass rule, the minutes,
//                                    whether the sheet exists, and the command that records the review
//   node tools/review.mjs --write    write review/README.md (the gate keeps it in step with the numbers)
//   --root <folder>                  the project folder (default: the folder above tools/)
//
// The numbers in the table are read from site/data/numbers.json, the sheets from review/, and the last row from
// site/data/checks/checks.json, so the table cannot say something the data does not.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * @typedef {Object} Review
 * @property {string} id
 * @property {string} block      when it is done
 * @property {string} title
 * @property {string} open       what to open
 * @property {{label: string, key?: string, err?: string, limit?: string, unit?: string}} number   the one number to read
 * @property {string} rule       the pass rule, in a line
 * @property {number} minutes
 * @property {string} command    what records the review
 */

const LATER = 'Sunday 15:00';
const FIRST = 'Sunday 08:00';
const BY_JOB = (job) => `\`python -m sx.run ${job} --reviewed "<role>" <YYYY-MM-DD>\``;

/** @type {Review[]} */
export const REVIEWS = [
  { id: 'H1', block: FIRST, title: 'The comet\'s colour strip', open: 'the strip of the three photos of the comet with their times, colours, stretch and fluxes',
    number: { label: 'brightness at the colour of carbon dioxide against its neighbours, 26 February', key: 'lemmon.contrast.feb26.exact', err: 'lemmon.contrast.feb26.err', unit: 'times' },
    rule: 'at least 5 times; one stretch and one crop in every tile; the August tile is empty at the mark; no star hidden; the caption of the faint tile matches what is visible', minutes: 7, command: BY_JOB('lemmon') },
  { id: 'H2', block: FIRST, title: 'The comet\'s evidence panel', open: 'brightness against colour for both days, the template rows and the headline number',
    number: { label: 'smallest excess of an in-band photo over its template', key: 'lemmon.template.sigma.smallest', unit: 'standard errors' },
    rule: '5 or more, on both days; the headline says "lower limit" with its aperture and ring; the table of photos left out is shown as it is; no "only" in the wording of the comet', minutes: 8, command: BY_JOB('lemmon') },
  { id: 'H3', block: FIRST, title: 'The colour axis', open: 'the two hydrogen lines of NGC 6543 beside the colour ruler, with the largest error of the browser tables',
    number: { label: 'Brackett-alpha, fitted minus laboratory', key: 'lines.bra.dev_nm', unit: 'nm' },
    rule: 'Paschen-beta within 5 nm and Brackett-alpha within 15 nm; browser error at most 0.00001 µm; the four detectors without a line test are marked LIMIT; the carbon dioxide mark has a source', minutes: 3, command: BY_JOB('lines') },
  { id: 'H4', block: FIRST, title: 'The 3I/ATLAS row', open: 'the card of the row: ratio, photo counts, scaling formula, the three aperture choices',
    number: { label: 'ratio with the aperture on the position JPL Horizons gives', key: 'threei.ratio.horizons_centre' },
    rule: 'the formula is written; the same quantity as the published one, or the mismatch is stated; the verdict follows the rule written before the run (LIMIT is the cautious reading); the row is on the Checks page and nowhere else', minutes: 3, command: BY_JOB('threei') },
  { id: 'H5', block: FIRST, title: 'The five target cards', open: 'one sheet with the five cards: pictures, numbers, references, tolerances, the star beside WISE 0855',
    number: { label: 'Barnard\'s Star, measured minus catalogue shift', key: 'targets.barnard.shift.diff', limit: 'targets.barnard.shift.tolerance', unit: 'arcsec' },
    rule: 'every reference is Gaia DR3 or the named paper; tolerances were written before the run; every jump shows its two dates; the star beside WISE 0855 is within 1 pixel of a catalogue source; no brightness for a saturated target', minutes: 9, command: BY_JOB('targets') },
  { id: 'H6', block: FIRST, title: 'RW Aurigae with a common mask', open: 'the sheet with filled and flagged points apart, the comparison stars of each band with their counts, the clean pairs',
    number: { label: 'comparison stars, median change, band 3 (the largest of the bands that ship)', key: 'rwaur.d3.stars.median', unit: '%' },
    rule: 'a band ships only if its sign holds and its comparison stars are flat within 1%; the star counts are printed; the clean-pair result is shown; a failing band says "too bright to measure reliably"', minutes: 5, command: BY_JOB('rwaur') },
  { id: 'H7', block: FIRST, title: 'The false-flicker meter', open: 'the three stops of the slider at one stretch, with the meter values',
    number: { label: 'steady stars, median swing at the stop with matched colours', key: 'lie.swing.matched', unit: 'times' },
    rule: 'one stretch at every stop; the meter measures comparison stars, not the target; the values equal the Checks card', minutes: 3, command: BY_JOB('rwaur') },
  { id: 'H8', block: FIRST, title: 'Difference, background and flag tiers', open: 'one sheet: Epsilon Indi B\'s pair against Gaia, an empty field, 20 comparison residuals, a histogram in noise units, the flag table on three stamps',
    number: { label: 'empty positions where the mean of the difference (co-adds) is zero within noise', key: 'pb6.empty.coadd', unit: 'of 20' },
    rule: 'at least 18 of 20 empty positions and at least 18 of 20 comparison stars without a dipole above 3 noise units; injected sources within 20%; SOURCE is never hatched; saturation is hatched on Barnard\'s Star and R Draconis', minutes: 6, command: BY_JOB('diffcheck') },
  { id: 'H9', block: LATER, title: 'Pluto and "Is it real?"', open: 'the card of Pluto on the Checks page (row K-pluto) and one contact sheet with the four false-positive panels',
    number: { label: 'Pluto\'s difference photos within 1 pixel of JPL Horizons, in the best detector', key: 'pluto.best.within', unit: 'of 24' },
    rule: 'at least 80% within 1 pixel, or Pluto is not shown and its row says FAIL; each false-positive panel flags its case; no "new" or "candidate" anywhere', minutes: 5, command: 'none for Pluto: it failed its rule and is not shown; the four panels run again with `node --test tests/unit/v3-isitreal.test.mjs`' },
  { id: 'H10', block: LATER, title: 'The live path and the visit rule', open: 'the timings in site/data/checks/live.json (27 positions: the five targets, both poles, 20 at random; a laptop and a slowed link), and five positions typed on a real phone',
    number: { label: 'median time to the first pair on a laptop', key: 'live.first_pair.median_s', limit: 'live.first_pair.budget_s', unit: 's' },
    rule: 'every position ends in pictures or in a message with a next step; no uncaught error; the median to the first pair under the budget; photo counts equal the index at every position; two targets within 1 pixel of their catalogue motion', minutes: 8, command: '`node tools/timing.mjs --reviewed "<role>" <YYYY-MM-DD>`' },
  { id: 'H11', block: LATER, title: 'The spectra of the showcases', open: 'Epsilon Indi B and three steady stars drawn over the output of IRSA\'s Spectrophotometry Tool',
    number: { label: 'median ratio of our spectra to IRSA\'s tool (the reviewer reads it off the sheet)' },
    rule: 'median ratio from 0.9 to 1.1; otherwise every spectrum is labelled "relative only"', minutes: 4, command: `${BY_JOB('spectra')} \`--ratio <median>\`` },
  { id: 'H12', block: LATER, title: 'The movers gallery and the spot-it set', open: 'the card of the gallery on the Checks page (row K-gallery); a contact sheet only if the gallery is built',
    number: { label: 'tested stars on their catalogue position within 1 pixel and unsaturated (at least 8)', key: 'gallery.stars.passed', unit: 'of 24' },
    rule: 'each mover sits on its ring within 1 pixel and is unsaturated in every photo used; each empty field is truly empty; without 8 movers and 6 empty fields nothing is built and the row says FAIL', minutes: 5, command: BY_JOB('gallery') },
  { id: 'H13', block: LATER, title: 'Copy as Python', open: 'the terminal output of one exported script next to the numbers the page shows',
    number: { label: 'printed numbers that differ after rounding' },
    rule: 'none differ; the photo lists are identical', minutes: 2, command: 'none yet: the comparison is not written' },
  { id: 'H14', block: LATER, title: 'The release test', open: 'the table of counts for the test release and the command line that built it',
    number: { label: 'test positions where the count equals IRSA\'s (of 5)' },
    rule: 'equal at all 5 positions; the test release is absent from the public view', minutes: 2, command: 'none yet: the test is only built if the time allows' },
  { id: 'H15', block: LATER, title: 'The Checks sweep', open: 'the Checks page in a private window',
    number: { label: 'Checks rows nobody has reviewed' },
    rule: 'every tag opens a card; every picture is the file that was reviewed; every reviewed row has a role and a date; nothing is marked PASS without a review', minutes: 5, command: '`node tools/gate.mjs --check` (it fails on all but the first; the review itself is by eye)' },
];

/** What only people can do, with the minutes. */
export const PEOPLE = [
  ['Tonight', 'Answer the open decisions (name, address of the repository, licence, who owns which review). Show the first screen to one person who is not a physicist and write down what they say they see. (No AAVSO numbers and no line about the comet\'s visibility in October 2025 are shown, so neither needs a source.)', 30],
  ['Sunday 08:00', 'Reviews H1 to H8, on the sheets.', 44],
  ['Sunday 09:00', 'The tester session on the public address: five people who are not physicists, six tasks, the pass bar as it is written in `site/data/tried.json`. Fill the table by hand, whichever way it goes.', 60],
  ['Sunday 10:00', 'The search by hand of NASA ADS and the DPS 2026 abstracts for an infrared carbon dioxide measurement of the comet, with its date; write the result on the card of row K14 of the Checks page. Five positions typed on a real phone (part of H10).', 30],
  ['Sunday 12:00', 'One of you says the three-minute pitch aloud once, timed.', 15],
  ['Sunday 15:00', 'Reviews H9 to H15. After this only fixes.', 31],
  ['Sunday afternoon', 'The community posts, once the public version works. Someone outside the team reads the page text and watches the video.', 45],
  ['Sunday 20:00', 'The first "Submit for Judging", with the final check.', 20],
  ['Sunday 23:30', 'The last save. Nothing is touched after it.', 0],
];

/** @param {string} file */
const read = (file) => readFileSync(file, 'utf8').replace(/^﻿/, '');

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|');

/**
 * The reviews with their numbers and sheets filled in.
 * @param {{root: string, numbers: Record<string, any>, rows: {status: string}[]}} source
 */
export function reviewRows({ root, numbers, rows }) {
  return REVIEWS.map((r) => {
    const n = r.number;
    let value;
    if (r.id === 'H15') {
      const open = rows.filter((x) => x.status === 'UNVERIFIED').length;
      value = `${n.label}: ${open} of ${rows.length}`;
    } else if (n.key && Object.hasOwn(numbers, n.key)) {
      const err = n.err && Object.hasOwn(numbers, n.err) ? ` ± ${numbers[n.err].text}` : '';
      const limit = n.limit && Object.hasOwn(numbers, n.limit) ? ` (tolerance ${numbers[n.limit].text}${n.unit ? ` ${n.unit}` : ''})` : '';
      value = `${n.label}: ${numbers[n.key].text}${err}${n.unit ? ` ${n.unit}` : ''}${limit}`;
    } else value = `${n.label}: not measured yet`;
    const stem = r.id.toLowerCase();
    const md = existsSync(path.join(root, 'review', `${stem}.md`)), png = existsSync(path.join(root, 'review', `${stem}.png`));
    const sheet = md && png ? `yes: review/${stem}.md, review/${stem}.png` : md ? `text only: review/${stem}.md` : 'not yet';
    return { ...r, value, sheet };
  });
}

/** @param {ReturnType<typeof reviewRows>} rows @returns {string} */
export function renderTable(rows) {
  const out = ['| Order | Review | When | Open | The one number | It passes if | Minutes | Sheet | Record it with |', '|---|---|---|---|---|---|---|---|---|'];
  rows.forEach((r, i) => out.push(`| ${i + 1} | ${r.id}: ${cell(r.title)} | ${r.block} | ${cell(r.open)} | ${cell(r.value)} | ${cell(r.rule)} | ${r.minutes} | ${cell(r.sheet)} | ${cell(r.command)} |`));
  return out.join('\n');
}

/**
 * review/README.md.
 * @param {{root: string, numbers: Record<string, any>, rows: {status: string}[]}} source
 */
export function renderReviewReadme(source) {
  const rows = reviewRows(source);
  const total = rows.reduce((n, r) => n + r.minutes, 0);
  return `${[
    '# Reviews',
    '',
    'Fifteen reviews, one sheet each, for two people to do. None was done within the hackathon, so every row they cover stays UNVERIFIED (not reviewed by a person) on the Checks page. A review is one picture, one number and one rule. When it passes, the command in the last column records the role of the reviewer and the date, and the row of the Checks page changes from UNVERIFIED to PASS. Nothing is marked PASS before that.',
    '',
    'This file is written by `node tools/review.mjs --write` and kept up to date by `npm run gate`; edit `tools/review.mjs`, not this file. `node tools/review.mjs --list` prints the table below from the same files.',
    '',
    `The reviews are in the order to do them. They take ${total} minutes in all.`,
    '',
    renderTable(rows),
    '',
    '## What only people can do',
    '',
    '| When | What | Minutes |',
    '|---|---|---|',
    ...PEOPLE.map(([when, what, minutes]) => `| ${when} | ${cell(what)} | ${minutes || ''} |`),
    '',
    'The 44 and the 31 minutes are the reviews of the table above, split as they are done.',
  ].join('\n')}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = path.resolve(at >= 0 ? args[at + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const source = {
    root,
    numbers: JSON.parse(read(path.join(root, 'site', 'data', 'numbers.json'))),
    rows: JSON.parse(read(path.join(root, 'site', 'data', 'checks', 'checks.json'))),
  };
  if (args.includes('--write')) {
    writeFileSync(path.join(root, 'review', 'README.md'), renderReviewReadme(source));
    console.log('review: wrote review/README.md');
  } else if (args.includes('--list')) {
    console.log(renderTable(reviewRows(source)));
  } else {
    console.error('review: use --list or --write');
    process.exit(1);
  }
}
