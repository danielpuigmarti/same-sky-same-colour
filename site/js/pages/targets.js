// The targets page: one item for each of the five targets the challenge names and, when their checks allowed them,
// the stars that moved, "Can you spot it?" and Pluto.
//
// The page is made from the data files and stored as plain HTML (see the top of ui/cards.js): buildTargets makes
// the parts that tests/unit/v4-pages.test.mjs writes into targets.html. With scripts on, the photos of each item
// blink on its plate; without, the page reads the same and shows the two photos side by side.

/** @import { NumberEntry } from '../contracts.js' */
/** @import { Build } from '../ui/cards.js' */
import { targetCard, spotList, fill, tagLink, picture, esc, attr, markDates, keyEnding, mountBlink, mountJump } from '../ui/cards.js';

/** The five targets, in the order of the page. */
export const TARGET_ORDER = Object.freeze(['eps-indi-b', 'barnard', 'wise0855', 'rw-aur', 'r-dra']);

/**
 * What the page is made from.
 * @typedef {Object} TargetsData
 * @property {{card: any, manifest: any}[]} targets  card.json and manifest.json of each target that is in the site.
 * @property {any} tolerances  targets/tolerances.json, or null.
 * @property {Record<string, any>} decisions  The decisions of the checks, all files of checks/decisions/ together.
 * @property {{index: any, cards: {card: any, manifest: any}[]} | null} gallery  gallery/index.json and the cards it lists.
 * @property {{set: any, answers: any} | null} spotit  spotit/set.json and spotit/answers.json.
 * @property {{card: any, manifest: any} | null} pluto  pluto/card.json and its manifest.
 * @property {Record<string, NumberEntry>} [numbers]  numbers.json, for the figures that are worked out from other figures.
 */

/**
 * The numbers this page adds to numbers.json: the tolerance of a check that its rule file gives and no job wrote,
 * and how many of the five targets are of each kind, which the row of cells at the head of the page says.
 * @param {TargetsData} data
 * @returns {Record<string, NumberEntry>}
 */
export function targetNumbers(data) {
  /** @type {Record<string, NumberEntry>} */
  const out = {};
  const bar = data.tolerances?.['rw-aur']?.comparison_median_pct;
  if (Number.isFinite(bar)) out['v4.tolerance.rw-aur'] = { value: bar, err: null, unit: '%', text: String(bar), check: 'K6' };
  const cards = data.targets.map((t) => t.card).filter((c) => TARGET_ORDER.includes(String(c?.id)));
  if (cards.length) {
    /** @param {string} key @param {(card: any) => boolean} which @param {string | null} [check] */
    const count = (key, which, check = null) => {
      const n = cards.filter(which).length;
      out[`v4.targets.${key}`] = { value: n, err: null, unit: null, text: String(n), check };
    };
    count('total', () => true);
    count('movers', (c) => c.kind === 'mover');
    count('within', (c) => c.kind === 'mover' && c.within_tolerance === true, 'K5');
    count('variable', (c) => c.kind === 'variable');
    count('saturated', (c) => c.kind === 'saturated');
  }
  // how far a mover goes between the two visits that its plate shows: its speed, for the time between them, in
  // SPHEREx pixels. It is under about one pixel for each of them, which is why nothing is seen to move there.
  const pixel = Number(data.numbers?.['stage.pixel_arcsec']?.value);
  for (const { card, manifest } of data.targets) {
    if (card?.kind !== 'mover' || !TARGET_ORDER.includes(String(card.id))) continue;
    const stem = keyEnding(card.numbers, '.shift.measured')?.replace(/\.shift\.measured$/, '');
    const speed = Number(stem ? data.numbers?.[`${stem}.speed.measured`]?.value : NaN);
    const [early, late] = (Array.isArray(manifest?.pairs?.[0]) ? manifest.pairs[0] : []).map((/** @type {number} */ i) => manifest.frames?.[i]?.mjd);
    if (![speed, pixel, early, late].every(Number.isFinite)) continue;
    const px = speed * Math.abs(late - early) / 365.25 / pixel;
    out[`v4.targets.${card.id}.visits_px`] = { value: px, err: null, unit: 'pixels', text: px.toFixed(2), check: 'K5' };
  }
  return out;
}

/** The name of what a card was set against: the catalogue it names, without its identifier. @param {any} card */
function referenceName(card) {
  const text = typeof card?.reference?.text === 'string' ? card.reference.text : '';
  if (/^Gaia DR3/.test(text)) return 'the Gaia catalogue';
  return /^(.*?\d{4}),/.exec(text)?.[1] ?? text.split(',')[0];
}

/**
 * The ledger at the head of the page: the five targets, each with its one figure against its reference, and the
 * stamp of its check. Every figure is a number of numbers.json; a row whose figures are not all there is left out.
 * @param {Build} b @param {TargetsData} data
 * @returns {string}
 */
function targetsLedger(b, data) {
  const rows = [];
  for (const id of TARGET_ORDER) {
    const card = data.targets.find((t) => t.card?.id === id)?.card;
    if (!card) continue;
    const name = esc(String(card.name).toUpperCase());
    /** @type {string} */
    let measured = '', figure = '', against = '';
    if (card.kind === 'mover') {
      const stem = keyEnding(card.numbers, '.shift.measured')?.replace(/\.shift\.measured$/, '');
      const year = Math.floor(card.jump?.panels?.[0]?.year);
      if (!stem || !Number.isFinite(year)) continue;
      const label = card.jump?.panels?.[0]?.label;
      measured = typeof label === 'string' && label.includes(String(year)) ? `How far it moved from the ${esc(label.split(',')[0])} picture of ${markDates(String(year))} to SPHEREx` : `How far it moved since ${markDates(String(year))}`;
      figure = fill(b, `{{${stem}.shift.measured}} arcsec`);
      against = fill(b, `{{${stem}.shift.catalogue}} arcsec, ${esc(referenceName(card))}`);
    } else if (card.kind === 'variable' && Array.isArray(card.bands)) {
      // the band that changed most, among those that are shown
      const shown = card.bands.map((/** @type {any} */ band) => ({ band, key: keyEnding(band.numbers, '.masked') })).filter((/** @type {any} */ x) => x.band.shown === true && x.key && Number.isFinite(b.numbers[x.key]?.value));
      shown.sort((/** @type {any} */ p, /** @type {any} */ q) => Math.abs(b.numbers[/** @type {string} */ (q.key)].value) - Math.abs(b.numbers[/** @type {string} */ (p.key)].value));
      const best = shown[0];
      if (!best) continue;
      const stem = /** @type {string} */ (best.key).replace(/\.masked$/, '');
      measured = 'How much its brightness changed';
      figure = fill(b, `{{${stem}.masked}} % at {{${stem}.colour.from}} to {{${stem}.colour.to}} µm`);
      against = fill(b, `{{${stem}.stars.median}} % in the {{${stem}.stars}} steady stars beside it`);
    } else if (card.kind === 'saturated') {
      measured = 'How many of its photos are saturated';
      figure = fill(b, 'saturated in {{targets.r-dra.saturated}} of {{targets.r-dra.frames}}');
      against = 'No brightness is given: it is too bright to compare';
    }
    if (!figure || !against) continue;
    rows.push(`<tr><th scope="row"><a href="#${attr(id)}">${name}</a></th><td data-label="What was measured">${measured}</td><td class="ledger-figure" data-label="Its figure">${figure}</td><td data-label="Set against">${against}</td><td data-label="Check">${tagLink(b, String(card.check))}</td></tr>`);
  }
  if (!rows.length) return '';
  return `<div class="table-scroll" tabindex="0" role="group" aria-label="The five targets, each with its figure and what it was set against">
<table class="ledger targets-ledger">
<thead>
<tr><th scope="col">Target</th><th scope="col">What was measured</th><th scope="col">Its figure</th><th scope="col">Set against</th><th scope="col">Check</th></tr>
</thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</div>`;
}

/**
 * The parts of the page, by the name of the element that holds each. A part whose check did not allow it, or
 * whose files are not there, is empty: the page then shows nothing for it.
 * @param {Build} b @param {TargetsData} data
 * @returns {Record<string, string>}
 */
export function buildTargets(b, data) {
  const byId = new Map(data.targets.map((t) => [String(t.card?.id), t]));
  const cards = TARGET_ORDER.map((id) => {
    const t = byId.get(id);
    if (!t) {
      b.left.push(`target ${id}`);
      return '';
    }
    return targetCard(b, t.card, t.manifest, { folder: `data/targets/${id}/`, viewer: id });
  }).filter(Boolean);

  const built = (/** @type {string} */ key) => data.decisions?.[key]?.build === true;

  let gallery = '';
  if (built('S4') && data.gallery && data.gallery.cards.length) {
    const stars = data.gallery.cards.map((g) => targetCard(b, g.card, g.manifest, { folder: `data/gallery/${g.card.id}/`, viewer: `gallery/${g.card.id}`, heading: 'h3' }));
    gallery = `<div class="section-head">
<h2 id="gallery-title">More stars that moved</h2>
<p>Other fast stars, each seen long ago by another telescope and now by SPHEREx, and each checked against the Gaia catalogue in the same way. ${tagLink(b, 'K-gallery')}</p>
</div>
<div class="items tcards">
${stars.join('\n')}
</div>`;
  }

  let spot = '';
  if (built('S4') && data.spotit) {
    const list = spotList(b, data.spotit.set, data.spotit.answers, 'data/spotit/');
    if (list) {
      spot = `<div class="section-head">
<h2 id="spot-it-title">Can you spot it?</h2>
<p>${fill(b, '{{spotit.items}} pairs of pictures of one patch of sky, years apart.') || 'Pairs of pictures of one patch of sky, years apart.'} In some a star has moved; in others nothing has. Look at a pair, make up your mind, then open its answer. Nothing you do here is kept or sent anywhere.</p>
</div>
${list}`;
    }
  }

  let pluto = '';
  if (built('S5') && data.pluto) {
    const card = data.pluto.card;
    const still = typeof card.preview === 'string' ? picture(b, `data/pluto/${card.preview}`, 'Pluto, photo by photo: each small picture is one photo minus a photo of the same colour from another visit, with a ring where Pluto is predicted to be.') : '';
    const verdict = fill(b, card.verdict);
    if (still && verdict) {
      pluto = `<div class="section-head">
<h2 id="pluto-title">Pluto, photo by photo</h2>
<p>${verdict} ${tagLink(b, String(card.check), typeof card.plain === 'string' ? card.plain : undefined)}</p>
</div>
<figure class="pluto-figure">
<div class="plate" data-plate>${still}</div>
<figcaption>${typeof card.note === 'string' ? esc(card.note) : ''}${typeof card.reference?.text === 'string' ? ` Reference: <cite>${esc(card.reference.text)}</cite>.` : ''}</figcaption>
</figure>`;
    }
  }

  return { tally: targetsLedger(b, data), targets: cards.join('\n'), gallery, 'spot-it': spot, pluto };
}

// ---------------------------------------------------------------------------------------------
// In the page
// ---------------------------------------------------------------------------------------------

function start() {
  for (const figure of document.querySelectorAll('[data-blink]')) {
    if (!(figure instanceof HTMLElement)) continue;
    mountBlink(figure).then((blink) => { if (!blink) figure.querySelector('[data-box]')?.classList.add('is-still'); }, () => figure.querySelector('[data-box]')?.classList.add('is-still'));
  }
  for (const figure of document.querySelectorAll('[data-jump]')) if (figure instanceof HTMLElement) mountJump(figure);
  // the picture of long ago and SPHEREx's flips in place; the pairs of "Can you spot it?" wait for a tap
  if (document.querySelector('[data-lead-flip], [data-spot]')) {
    import('../ui/spotit.js').then((m) => {
      for (const figure of document.querySelectorAll('[data-lead-flip]')) if (figure instanceof HTMLElement) m.mountSpot(figure, { auto: true });
      m.mountSpots(document.body);
    }, () => {});
  }
}

if (typeof document !== 'undefined') start();
