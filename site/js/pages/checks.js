// The Checks page: every claim of the site with the check behind it, as a register.
//
// The page is made from the data files and stored as plain HTML (see the top of ui/cards.js): buildChecks makes the
// parts that tests/unit/v4-pages.test.mjs writes into checks.html. The filter by status is a group of radio buttons
// that the stylesheet acts on, and every row is written open, so the page works whole with scripts off. This script
// closes the rows, says aloud how many a choice leaves, and opens the row that an address names, whatever is chosen.

/** @import { CheckRow, NumberEntry } from '../contracts.js' */
/** @import { Build } from '../ui/cards.js' */
import { mountSelfTest } from '../ui/selftest.js';
import { checksIntro, checksFilter, checksList, limitsTables, challengeLines, triedTable, sortRows, countNumbers, limitsNumbers, triedNumbers, STATUS_NAME } from '../ui/checks.js';

/**
 * What the page is made from. A file that is not there is null, and its part stays empty.
 * @typedef {Object} ChecksData
 * @property {any} limits  checks/limits.json.
 * @property {any} challenge  challenge.json.
 * @property {any} tried  tried.json.
 * @property {Record<string, string>} names  Names of the targets by their id.
 */

/**
 * The numbers this page adds to numbers.json: how many rows have each status, the cells of the table of limits and
 * the counts of observed use.
 * @param {CheckRow[]} rows @param {ChecksData} data
 * @returns {Record<string, NumberEntry>}
 */
export const checksNumbers = (rows, data) => ({ ...countNumbers(rows), ...limitsNumbers(data.limits), ...triedNumbers(data.tried) });

/**
 * The parts of the page, by the name of the element that holds each.
 * @param {Build} b @param {ChecksData} data
 * @returns {Record<string, string>}
 */
export function buildChecks(b, data) {
  const rows = sortRows(b.rows);
  return {
    intro: rows.length ? checksIntro(b, rows) : '',
    checks: rows.length ? `${checksFilter(b, rows)}
${checksList(b, rows)}` : '',
    limits: data.limits ? limitsTables(b, data.limits) : '',
    challenge: data.challenge ? challengeLines(data.challenge, data.names) : '',
    'tried-by': data.tried ? triedTable(b, data.tried) : '',
  };
}

// ---------------------------------------------------------------------------------------------
// In the page
// ---------------------------------------------------------------------------------------------

function start() {
  const filter = document.querySelector('[data-filter]'), status = document.querySelector('[data-filter-status]');
  if (!(filter instanceof HTMLElement)) return;
  const list = document.querySelector('.checklist');
  const cards = [...document.querySelectorAll('.ccard')];
  const detailsOf = (/** @type {Element} */ card) => card.querySelector(':scope > .ccard-details');
  /** @returns {HTMLInputElement | null} */
  const chosen = () => filter.querySelector('input:checked');
  const say = () => {
    const value = chosen()?.value ?? 'all';
    const n = value === 'all' ? cards.length : cards.filter((c) => /** @type {HTMLElement} */ (c).dataset.status === value).length;
    if (status) status.textContent = value === 'all' ? `Showing all ${cards.length} checks.` : `Showing ${n} of ${cards.length} checks: ${STATUS_NAME[/** @type {keyof typeof STATUS_NAME} */ (value)] ?? value}.`;
  };
  filter.addEventListener('change', say);
  // the rows are written open, so that the page reads whole without a script; with one they stand closed, and the row
  // that an address names opens
  const named = () => {
    const id = decodeURIComponent(location.hash.slice(1));
    const card = id ? document.getElementById(id) : null;
    return card && card.classList.contains('ccard') ? card : null;
  };
  for (const card of cards) {
    const more = detailsOf(card);
    if (more instanceof HTMLDetailsElement && card !== named()) more.open = false;
  }
  list?.classList.add('is-ready');
  // an address that names a row shows that row whatever is chosen, and opens it; the choice goes back to "all", so
  // that the rows around it are there too
  /** @param {boolean} [scroll]  Bring the row into view: the rows above it have just been closed. */
  const reveal = (scroll = false) => {
    const card = named();
    if (!card) return;
    const more = detailsOf(card);
    if (more instanceof HTMLDetailsElement) more.open = true;
    const all = filter.querySelector('input[value="all"]');
    if (all instanceof HTMLInputElement && !all.checked && card.dataset.status !== chosen()?.value) {
      all.checked = true;
      say();
      scroll = true;
    }
    if (scroll) card.scrollIntoView();
  };
  window.addEventListener('hashchange', () => reveal());
  reveal(true);
  const selftest = document.querySelector('[data-selftest-body]');
  if (selftest instanceof HTMLElement) mountSelfTest(selftest);
}

if (typeof document !== 'undefined') start();
