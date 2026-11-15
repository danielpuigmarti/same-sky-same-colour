// The live self-test of the Checks page: one known photo is read now, from the public archive, with the reader the
// viewer uses (queue.js, frame.js, wcs.js), and what is read is compared with an answer stored in the site
// (data/selftest/answer.json). The comparison is a function of two plain objects, so it is tested without a browser.

import { BUCKET_URLS } from '../contracts.js';
import { createQueue } from '../lib/queue.js';
import { readHead, place, readStamp } from '../lib/frame.js';
import { makeWcs } from '../lib/wcs.js';

/**
 * @typedef {Object} AnswerValue
 * @property {string} id @property {string} label @property {string} unit @property {number} stored
 * @property {number} tolerance  The largest difference that still counts as the same.
 * @property {number} digits  Decimals to show. @property {string} why  Why this tolerance.
 */
/**
 * @typedef {Object} Answer
 * @property {string} about @property {number} budget_ms
 * @property {{id: string, name: string, ra: number, dec: number, det: number}} target
 * @property {string} key  Bucket key of the photo. @property {AnswerValue[]} values
 */
/** @typedef {Record<string, number | null | undefined>} Read  What was read, by value id. */
/**
 * @typedef {Object} Line
 * @property {AnswerValue} value @property {number | null} read  Null when nothing was read. @property {boolean} ok
 */

const finite = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Compare what was read with the stored answer. A value that is missing, on either side, does not match.
 * @param {Answer} answer @param {Read} read
 * @returns {{lines: Line[], matches: boolean}}
 */
export function compare(answer, read) {
  const lines = answer.values.map((value) => {
    const got = read[value.id];
    const ok = finite(got) && finite(value.stored) && Math.abs(/** @type {number} */ (got) - value.stored) <= value.tolerance;
    return { value, read: finite(got) ? /** @type {number} */ (got) : null, ok };
  });
  return { lines, matches: lines.every((l) => l.ok) };
}

/** Why a read ended without values: the archive was slow, or could not be reached. @typedef {'slow' | 'unreachable'} Failure */

/**
 * Read the photo of the answer: its header, where the target falls, and the stamp around it.
 * @param {Answer} answer
 * @param {{fetch?: typeof fetch, hosts?: readonly string[]}} [options]
 * @returns {Promise<{read: Read, bytes: number, ms: number} | {failure: Failure}>}
 */
export async function readLive(answer, { fetch: fetchFn, hosts = BUCKET_URLS } = {}) {
  const t0 = performance.now();
  const ac = new AbortController();
  let slow = false;
  const timer = setTimeout(() => { slow = true; ac.abort(); }, answer.budget_ms);
  const queue = createQueue({ fetch: fetchFn });
  try {
    for (const host of hosts) {
      /** @type {import('../lib/frame.js').Get} */
      const get = (start, end, kind, prio) => queue.get(host + answer.key, start, end, { kind, prio, signal: ac.signal });
      try {
        const head = await readHead(get, 0);
        const { ra, dec } = answer.target;
        const wcs = makeWcs(head.h);
        const at = place(wcs, head.nx, head.ny, ra, dec);
        const stamp = await readStamp(get, head, at, { flags: false });
        const back = wcs.pix2world(at.x, at.y);
        const dRa = (back[0] - ra) * Math.cos(dec * Math.PI / 180), dDec = back[1] - dec;
        const read = { nx: head.nx, ny: head.ny, mjd: head.mjd, x0: at.x0, y0: at.y0, pixels: stamp.data.length, roundtrip: Math.hypot(dRa, dDec) * 3600 };
        return { read, bytes: stamp.bytes, ms: performance.now() - t0 };
      } catch (e) {
        if (slow) return { failure: 'slow' };
        // a request that failed goes on to the other address of the bucket; bytes that cannot be understood are no different there
        if (!(e && typeof (/** @type {any} */ (e)).code === 'string')) throw e;
      }
    }
    return { failure: slow ? 'slow' : 'unreachable' };
  } finally {
    clearTimeout(timer);
    queue.cancel();
  }
}

/** @param {number} n @param {number} digits */
const show = (n, digits) => n.toFixed(digits);

/** @param {Answer} answer @param {string} fileName */
const frameName = (answer, fileName) => `${answer.target.name}, detector ${answer.target.det}: ${fileName}`;

/** @param {string} tag @param {string} [text] @param {string} [cls] */
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** The rule, in words, before the button. @param {Answer} answer */
function ruleList(answer) {
  const ul = el('ul', undefined, 'selftest-rule');
  for (const v of answer.values) {
    const tol = v.tolerance === 0 ? 'the same value' : `within ${show(v.tolerance, v.digits)} ${v.unit}`;
    const li = el('li');
    li.append(el('strong', `${v.label}: `), document.createTextNode(`${tol}. ${v.why}`));
    ul.append(li);
  }
  return ul;
}

/** The table of what was compared. @param {{lines: Line[]}} result */
function resultTable({ lines }) {
  const wrap = el('div', undefined, 'table-scroll');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'What the live read was compared with');
  const table = el('table', undefined, 'ledger selftest-table');
  const head = el('thead');
  const hr = el('tr');
  for (const h of ['Value', 'Stored', 'Read now', 'Tolerance', 'Matches']) {
    const th = el('th', h);
    th.setAttribute('scope', 'col');
    hr.append(th);
  }
  head.append(hr);
  const body = el('tbody');
  for (const { value, read, ok } of lines) {
    const tr = el('tr');
    const th = el('th', `${value.label} (${value.unit})`);
    th.setAttribute('scope', 'row');
    tr.append(th, el('td', show(value.stored, value.digits)), el('td', read === null ? 'not read' : show(read, value.digits)),
      el('td', value.tolerance === 0 ? 'none' : show(value.tolerance, value.digits)), el('td', ok ? 'yes' : 'no'));
    tr.dataset.ok = String(ok);
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

/**
 * Put the test into its section: the rule, a button, and a place for the result.
 * @param {HTMLElement} root  The element that holds the section's body.
 * @param {{fetch?: typeof fetch, answerUrl?: string}} [options]
 */
export async function mountSelfTest(root, { fetch: fetchFn, answerUrl = 'data/selftest/answer.json' } = {}) {
  /** @type {Answer} */
  let answer;
  try {
    const res = await fetch(answerUrl);
    if (!res.ok) throw new Error(String(res.status));
    answer = await res.json();
  } catch {
    root.replaceChildren(el('p', 'The stored answer could not be loaded, so the live test is not available. The prepared targets work offline.'));
    return;
  }
  const button = /** @type {HTMLButtonElement} */ (el('button', 'Test the live connection now', 'btn'));
  button.setAttribute('type', 'button');
  const out = el('div', undefined, 'selftest-out');
  out.setAttribute('role', 'status');
  out.setAttribute('aria-live', 'polite');
  const fileName = answer.key.slice(answer.key.lastIndexOf('/') + 1);
  const rule = el('div', undefined, 'selftest-rule-wrap');
  rule.append(
    el('p', `The test reads one photo, ${frameName(answer, fileName)}, from the public archive, with the same reader the viewer uses, and compares it with the answer stored in this site. It passes only when every value below is the same as the stored one, within its tolerance. A value that cannot be read counts as different.`),
    ruleList(answer),
  );
  root.replaceChildren(rule, button, out);

  button.addEventListener('click', async () => {
    button.disabled = true;
    out.replaceChildren(el('p', 'Reading the photo from the archive…'));
    out.setAttribute('aria-busy', 'true');
    /** @type {Awaited<ReturnType<typeof readLive>>} */
    let got;
    try { got = await readLive(answer, { fetch: fetchFn }); } catch { got = { failure: 'unreachable' }; }
    out.removeAttribute('aria-busy');
    button.disabled = false;
    if ('failure' in got) {
      const p = el('p', got.failure === 'slow'
        ? 'The archive is too slow to answer just now, so nothing was compared. This says nothing about the site. '
        : 'The archive could not be reached from here, so nothing was compared. This says nothing about the site. ');
      p.dataset.state = got.failure;
      const a = el('a', 'The prepared targets');
      a.setAttribute('href', 'targets.html');
      p.append(a, document.createTextNode(' work offline.'));
      out.replaceChildren(p);
      return;
    }
    const result = compare(answer, got.read);
    const seconds = (got.ms / 1000).toFixed(1);
    const p = el('p', `The live read ${result.matches ? 'matches' : 'differs from'} the stored answer. Frame read: ${frameName(answer, fileName)}. Time taken: ${seconds} seconds.`, 'selftest-verdict');
    p.dataset.state = result.matches ? 'matches' : 'differs';
    out.replaceChildren(p, resultTable(result));
  });
}
