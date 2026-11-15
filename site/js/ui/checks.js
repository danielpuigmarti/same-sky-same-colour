// The Checks page as text: a register. The two sentences the page opens on, the filter that also counts the checks
// by status, the list of all checks, one ruled row for each row of checks.json that opens in place to its entry,
// the tables of what the tool can and cannot see, the challenge line by line and the table of observed use.
//
// Everything here makes HTML from the data files and needs no page (see the top of cards.js). The page it makes
// reads whole with scripts off: the filter is a group of radio buttons that the stylesheet acts on, and every row is
// open. A status is always told by its word and its mark, never by its colour alone.

/** @import { CheckRow, CheckStatus, NumberEntry } from '../contracts.js' */
/** @import { Build } from './cards.js' */
import { esc, attr, fill, dateWords, numberSpan, picture, tagOf, plainWords, cellRow, factList, stamp, statusMark, STATUS_NAME, STATUS_STAMP } from './cards.js';

export { STATUS_NAME };

/** The statuses in the order the page lists them: what needs a reader's attention first, what is not reviewed last. */
export const STATUS_ORDER = Object.freeze(/** @type {CheckStatus[]} */ (['FAIL', 'LIMIT', 'CORRECTED', 'PASS', 'UNVERIFIED']));

/** What a status means, in a sentence. */
export const STATUS_MEANS = Object.freeze(/** @type {Record<CheckStatus, string>} */ ({
  PASS: 'The rule held, and a person has looked at the result.',
  CORRECTED: 'An earlier figure was wrong. The entry keeps both it and the right one.',
  LIMIT: 'This is something the tool cannot measure or claim, said plainly.',
  UNVERIFIED: 'The code ran the test against its rule, but no person reviewed the result within the hackathon, so it is not marked passed.',
  FAIL: 'The rule did not hold. The entry says what was switched off because of it.',
}));

/** The key of numbers.json that holds how many rows have a status. @param {CheckStatus | 'total'} status */
export const countKey = (status) => `v4.checks.${status.toLowerCase()}`;

/**
 * How many rows have each status.
 * @param {CheckRow[]} rows
 * @returns {Record<CheckStatus | 'total', number>}
 */
export function countRows(rows) {
  /** @type {Record<CheckStatus | 'total', number>} */
  const n = { PASS: 0, CORRECTED: 0, LIMIT: 0, UNVERIFIED: 0, FAIL: 0, total: rows.length };
  for (const r of rows) if (Object.hasOwn(n, r.status)) n[r.status]++;
  return n;
}

/** A row that a person has looked at: it names who, and when. @param {CheckRow} r */
const lookedAt = (r) => Boolean(r.reviewer_role && r.reviewed_on);

/** A failed row of a part that was tried and not built: its words say that it is not built or not shown. @param {CheckRow} r */
const notBuilt = (r) => r.status === 'FAIL' && /^not (built|shown)\b/i.test(String(r.plain));

/**
 * The counts as numbers of numbers.json, so that the page carries them as it carries every number.
 * @param {CheckRow[]} rows
 * @returns {Record<string, NumberEntry>}
 */
export function countNumbers(rows) {
  const n = countRows(rows);
  /** @type {Record<string, NumberEntry>} */
  const out = {};
  for (const status of /** @type {(CheckStatus | 'total')[]} */ (['total', ...STATUS_ORDER])) {
    out[countKey(status)] = { value: n[status], err: null, unit: null, text: String(n[status]), check: null };
  }
  // how many a person has looked at, and how many of the failed are parts that were tried and not built
  const more = { reviewed: rows.filter(lookedAt).length, notbuilt: rows.filter(notBuilt).length };
  for (const [key, value] of Object.entries(more)) out[`v4.checks.${key}`] = { value, err: null, unit: null, text: String(value), check: null };
  return out;
}

/**
 * The rows in the order of the page: K1, K2, ... by their number, each followed by the rows that hang on it
 * (K1-limit), then the other rows in the order they were given.
 * @param {CheckRow[]} rows
 * @returns {CheckRow[]}
 */
export function sortRows(rows) {
  /** @param {CheckRow} r @returns {[number, number]} */
  const rank = (r) => {
    const m = /^K(\d+)(.*)$/.exec(r.id);
    return m ? [0, Number(m[1]) + (m[2] ? 0.5 : 0)] : [/^K\b/.test(r.id) ? 1 : 2, 0];
  };
  return rows.map((r, i) => ({ r, i, k: rank(r) }))
    .sort((p, q) => p.k[0] - q.k[0] || p.k[1] - q.k[1] || p.i - q.i)
    .map((x) => x.r);
}


/**
 * What the page opens on: how many checks there are and what they cover, how many a person has reviewed so far, what
 * makes a check count as passed, and a key to the five marks. How many have each status is in the choices of the filter
 * under it. Each count is a number of numbers.json.
 * @param {Build} b @param {CheckRow[]} rows
 * @returns {string}
 */
export function checksIntro(b, rows) {
  const n = countRows(rows);
  const total = `{{${countKey('total')}}}`;
  const covers = `${n.total === 1 ? 'There is' : 'There are'} ${total} ${n.total === 1 ? 'check' : 'checks'}, for what the site claims: the colour axis, the comet, the five targets, the difference view, the “Is it real?” panel, how a typed position is read, the index of photos, the interstellar comet 3I/ATLAS, the spectra and the speed of the live path. A check counts as passed only when its rule holds and a person has reviewed the result.`;
  const bottom = `In short: of ${total} checks, {{${countKey('PASS')}}} have passed, {{${countKey('FAIL')}}} failed, {{${countKey('LIMIT')}}} mark limits, {{${countKey('CORRECTED')}}} corrected an earlier figure and {{${countKey('UNVERIFIED')}}} were run by the code but not reviewed by a person. A person reviewed {{v4.checks.reviewed}} of ${total} within the hackathon, and a check counts as passed only once a person has reviewed it. Where a check failed, its row says what was switched off because of it.`;
  const plain = 'Nothing here is for you to do. Before trusting the tool we tested it, and this page is the record: each row is one test, with the rule we wrote before running it (for those that can pass or fail) and what came out, failures included.';
  const key = STATUS_ORDER.map((s) => `<div class="checks-key-row"><dt>${statusMark(s)}${esc(STATUS_NAME[s])}</dt><dd>${esc(STATUS_MEANS[s])}</dd></div>`).join('\n');
  return `<div class="checks-intro-text">
<p class="checks-plain">${esc(plain)}</p>
<p class="checks-reviewed">${fill(b, bottom)}</p>
<p>${fill(b, covers)}</p>
</div>
<dl class="checks-key" aria-label="What the marks mean">
${key}
</dl>`;
}

/** What a choice of the filter is called. */
const FILTER_NAME = Object.freeze(/** @type {Record<CheckStatus, string>} */ ({
  FAIL: 'Failed', LIMIT: 'Limits', CORRECTED: 'Corrected', PASS: 'Passed', UNVERIFIED: 'Not reviewed by a person',
}));

/**
 * The filter by status, as one row of joined cells that is also the count: one radio button for all rows and one for
 * each status that has a row, each with its mark and the number of rows it leaves. The stylesheet hides the rows of
 * the other statuses, so it works without a script.
 * @param {Build} b @param {CheckRow[]} rows
 * @returns {string}
 */
export function checksFilter(b, rows) {
  const n = countRows(rows);
  /** @param {string} value @param {string} name @param {CheckStatus | 'total'} status @param {boolean} checked */
  const choice = (value, name, status, checked) => `<label class="cfilter-choice"${status === 'total' ? '' : ` data-status="${status}"`}><input type="radio" name="show" value="${value}"${checked ? ' checked' : ''}>${status === 'total' ? '' : statusMark(status)}<span class="cfilter-name">${esc(name)}</span> <span class="cfilter-count">${numberSpan(b, countKey(status))}</span></label>`;
  return `<fieldset class="cfilter" data-filter>
<legend>Show</legend>
<div class="choice">
${[choice('all', 'All', 'total', true), ...STATUS_ORDER.filter((s) => n[s] > 0).map((s) => choice(s, FILTER_NAME[s], s, false))].join('\n')}
</div>
</fieldset>
<p class="visually-hidden" role="status" data-filter-status></p>`;
}

/** A value of a row as text. @param {number | string | null} v */
const shown = (v) => (v === null || v === '' ? '' : String(v));

/** A value of a row longer than this many characters reads as a sentence, not as a reading. */
const LONG_VALUE = 48;

/** A figure that stands in the line of a row, when it is short enough to be read there. */
const IN_LINE = 36;

/**
 * One row of the list: the mark and the word of its status, its id, its title and its figure. It opens in place to
 * the entry: the claim; its status as a stamp, its id and who looked at it and when; the number with what it is
 * compared with and how far it may be from it; the pass rule; what the status means, the words it carries in the
 * story, how it was tested and the command that runs the check again; and its picture, on a plate. The entry is open
 * in the page as it is written, so that it reads whole with scripts off; the script of the page closes all but the
 * one that the address names.
 * @param {Build} b @param {CheckRow} row
 * @returns {string}
 */
export function checkCard(b, row) {
  const id = attr(row.id);
  const img = row.image ? picture(b, `data/checks/${row.image}`, `The picture of this check: ${row.title}.`) : '';
  // the caption of the picture is true whether or not a person has looked at it
  const figure = img === '' ? '' : `<figure class="ccard-picture">
<div class="plate-frame">
<div class="plate" data-plate><a href="data/checks/${attr(row.image)}">${img}</a></div>
${cellRow([
    ['Picture', 'The picture this check rests on; it opens at full size.'],
    ...(row.image_sha256 ? [/** @type {[string, string]} */ (['Start of its SHA-256', `<code>${esc(row.image_sha256.slice(0, 16))}</code>`])] : []),
  ], { cols: 2 })}
</div>
</figure>`;
  const value = shown(row.value), unit = shown(row.unit), reference = shown(row.reference), tolerance = shown(row.tolerance);
  // a short value is set as a reading of an instrument, a long one as a sentence
  /** @param {string} label @param {string} text @param {string} [after] @returns {[string, string, boolean]} */
  const line = (label, text, after = '') => [label, `${esc(text)}${after}`, text.length > LONG_VALUE];
  const values = [
    value ? line('Measured', value, unit ? ` <span class="ccard-unit">${esc(unit)}</span>` : '') : null,
    reference ? line('Reference', reference) : null,
    tolerance ? line('Tolerance', tolerance) : null,
  ].filter((x) => x !== null);
  const looked = row.reviewer_role && row.reviewed_on;
  const cells = cellRow([
    ['Status', stamp(row.status), ' data-cell="status"'],
    ['Entry', `<a href="#${attr(encodeURIComponent(row.id))}">${esc(row.id)}</a>`],
    ['Reviewed', looked ? `${esc(row.reviewer_role)}, ${dateWords(row.reviewed_on)}` : 'Not yet'],
  ], { cls: 'ccard-cells', cols: 3 });
  const more = factList([
    ['What the status means', esc(STATUS_MEANS[row.status])],
    ['In plain words', plainWords(row.plain)],
    ['How it was tested', esc(row.test)],
    ['Rule recorded as', row.rule_commit ? `<code>${esc(row.rule_commit.slice(0, 12))}</code>` : ''],
    ['Run it again', row.rerun ? `<code>${esc(row.rerun)}</code>` : ''],
  ], 'ccard-facts');
  const inLine = value && `${value}${unit ? ` ${unit}` : ''}`.length <= IN_LINE ? `${esc(value)}${unit ? ` <span class="ccard-unit">${esc(unit)}</span>` : ''}` : '';
  return `<li class="ccard" id="${id}" data-status="${row.status}">
<details class="ccard-details" open>
<summary class="ccard-row"><span class="ccard-id">${esc(row.id)}</span><span class="ccard-status">${statusMark(row.status)}${esc(STATUS_NAME[row.status])}</span><span class="ccard-title">${esc(row.title)}</span><span class="ccard-figure">${inLine}</span></summary>
<div class="ccard-body">
<div class="ccard-text">
<p class="ccard-claim">${esc(row.claim)}</p>
${cells}
${values.length ? `<dl class="facts ccard-values">\n${values.map(([label, html, long]) => `<div><dt>${label}</dt><dd${long ? ' class="is-long"' : ''}>${html}</dd></div>`).join('\n')}\n</dl>` : ''}
${factList([['Pass rule', esc(row.pass_rule)]], 'ccard-rule')}
${more}
</div>
${figure}
</div>
</details>
</li>`.replace(/\n{2,}/g, '\n');
}

/**
 * The list of the checks: one ruled row for each row of checks.json, each opening in place to its entry.
 * @param {Build} b @param {CheckRow[]} rows
 * @returns {string}
 */
export function checksList(b, rows) {
  return `<ol class="checklist" aria-label="The checks">
${[...rows].sort((p, q) => STATUS_ORDER.indexOf(p.status) - STATUS_ORDER.indexOf(q.status)).map((r) => checkCard(b, r)).join('\n')}
</ol>`;
}

/** A brightness in millijanskys, to two figures. @param {number} v */
const mjy = (v) => String(Number(v.toPrecision(2)));

/** The two views of the table of limits, with the heading of each. */
const LIMIT_VIEWS = Object.freeze(/** @type {[string, string][]} */ ([['coadd', 'The photos of each visit added together'], ['pair', 'One photo against one photo']]));

/**
 * The key of a number of the table of limits.
 * @param {string} view @param {number} row  From 0. @param {string} what  "speed", "shift" or "d" and a detector.
 */
const limitKey = (view, row, what) => `v4.limits.${view}.${row + 1}.${what}`;

/**
 * The numbers of the table of limits (limits.json), so that the page carries each cell as it carries every number:
 * for each view and each speed, the speed, the shift between the visits and the faintest brightness that shows in
 * each detector. A detector in which nothing shows has no number.
 * @param {any} limits
 * @returns {Record<string, NumberEntry>}
 */
export function limitsNumbers(limits) {
  /** @type {Record<string, NumberEntry>} */
  const out = {};
  /** @param {string} key @param {unknown} v @param {string} unit @param {(v: number) => string} text */
  const put = (key, v, unit, text) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = { value: v, err: null, unit, text: text(v), check: 'K10' };
  };
  for (const [view] of LIMIT_VIEWS) {
    const rows = limits?.table?.[view];
    if (!Array.isArray(rows)) continue;
    for (const [i, r] of rows.entries()) {
      put(limitKey(view, i, 'speed'), r?.speed_arcsec_per_year, 'arcsec per year', String);
      put(limitKey(view, i, 'shift'), r?.shift_px, 'pixels', (v) => v.toFixed(2));
      for (const [det, v] of Object.entries(r?.limit_mjy ?? {})) if (/^[1-9]$/.test(det)) put(limitKey(view, i, `d${det}`), v, 'mJy', mjy);
    }
  }
  return out;
}

/**
 * The table of what the difference view can and cannot see (limits.json): for each speed of a moving object, the
 * faintest brightness at which it shows, in each of the six detectors. A view the file does not hold gives no table.
 * @param {Build} b @param {any} limits
 * @returns {string}
 */
export function limitsTables(b, limits) {
  const tables = [];
  for (const [view, title] of LIMIT_VIEWS) {
    const rows = limits?.table?.[view];
    if (!Array.isArray(rows) || !rows.length) continue;
    const dets = Object.keys(rows[0]?.limit_mjy ?? {}).filter((d) => /^[1-9]$/.test(d)).sort();
    if (!dets.length) continue;
    /** A cell: its number, or nothing when the table has none there. @param {number} i @param {string} what */
    const cell = (i, what) => (Object.hasOwn(b.numbers, limitKey(view, i, what)) ? numberSpan(b, limitKey(view, i, what)) : '');
    const body = rows.map((_, i) => (cell(i, 'speed') === '' ? '' : `<tr><th scope="row">${cell(i, 'speed')}</th><td>${cell(i, 'shift')}</td>${dets.map((d) => {
      const seen = cell(i, `d${d}`);
      return seen ? `<td>${seen}</td>` : '<td class="limits-none">not seen</td>';
    }).join('')}</tr>`)).filter(Boolean).join('\n');
    if (!body) continue;
    tables.push(`<h3>${esc(title)}</h3>
<div class="table-scroll" tabindex="0" role="group" aria-label="${attr(title)}: table of limits">
<table class="ledger limits">
<thead>
<tr><th scope="col">Speed, arcsec a year</th><th scope="col">Shift between the visits, pixels</th>${dets.map((d) => `<th scope="col">Detector ${esc(d)}</th>`).join('')}</tr>
</thead>
<tbody>
${body}
</tbody>
</table>
</div>`);
  }
  if (!tables.length) return '';
  const row = b.rows.find((r) => r.id === 'K10');
  /** A sentence that is said when its numbers exist, and left out without a word when they do not. @param {string} s */
  const said = (s) => ([...s.matchAll(/\{\{([^{}]+)\}\}/g)].every((m) => Object.hasOwn(b.numbers, m[1])) ? ` ${fill(b, s)}` : '');
  const rule = said('A made-up moving object counts as seen when its dark and bright pair reaches {{limits.units}} times the noise in at least {{limits.fraction_pct}} of every hundred tries.');
  const shift = said('The shift is how far an object of that speed goes in {{limits.shift_years}} years, the typical time between two visits.');
  return `<div class="section-head">
<h2 id="limits-title">WHAT THE TOOL CAN AND CANNOT SEE</h2>
<p>An object that moves between two visits leaves a dark patch where it was and a bright patch where it is. The tables give the faintest brightness, in millijanskys, at which that pair shows, for objects of different speeds. “Not seen” means that no brightness that was tried shows at that speed.${rule}${shift}${row ? ` ${tagOf(row)}` : ''}</p>
</div>
${tables.join('\n')}`;
}

/** How far a line of the challenge is built: the words the form prints, and the mark that goes with them. */
const LINE_STATUS = Object.freeze(/** @type {Record<string, [words: string, mark: CheckStatus]>} */ ({
  built: ['Built', 'PASS'], partial: ['Partly built', 'LIMIT'], 'not built': ['Not built', 'UNVERIFIED'],
}));

/**
 * The challenge, line by line (challenge.json): what it asks for and what it suggests, each marked built (a full
 * square), partly built (a half-full square) or not built (an empty square), with the view that does it.
 * @param {any} challenge
 * @param {Record<string, string>} [names]  Names of the targets by their id, for the links to their views.
 * @returns {string}
 */
export function challengeLines(challenge, names = {}) {
  const items = Array.isArray(challenge?.items) ? challenge.items.filter((/** @type {any} */ i) => typeof i?.line === 'string' && Object.hasOwn(LINE_STATUS, i.status)) : [];
  if (!items.length) return '';
  /** @param {string} where */
  const label = (where) => {
    const t = new URLSearchParams(where.split('?')[1]?.split('#')[0] ?? '').get('t');
    return t && names[t] ? names[t] : null;
  };
  /** @param {any[]} list @param {string} title */
  const group = (list, title) => (list.length ? `<h3>${esc(title)}</h3>
<ul class="rows lines">
${list.map((i) => {
    const also = (Array.isArray(i.also) ? i.also : []).filter((/** @type {unknown} */ w) => typeof w === 'string' && label(w));
    const links = [
      typeof i.where === 'string' ? `<a href="${attr(i.where)}">See it<span class="visually-hidden">: ${esc(i.line)}</span></a>` : '',
      ...also.map((/** @type {string} */ w) => `<a href="${attr(w)}">${esc(label(w))}</a>`),
    ].filter(Boolean);
    return `<li class="line" id="${attr(i.id ?? '')}" data-status="${attr(i.status)}">
<p class="line-text">${esc(i.line)}</p>
<p class="line-status">${statusMark(LINE_STATUS[i.status][1])}${LINE_STATUS[i.status][0]}</p>
${typeof i.note === 'string' ? `<p class="line-note">${esc(i.note)}</p>` : ''}
${links.length ? `<p class="links line-links">${links.join(' ')}</p>` : ''}
</li>`.replace(/\n{2,}/g, '\n');
  }).join('\n')}
</ul>` : '');
  const must = items.filter((/** @type {any} */ i) => i.kind === 'MUST'), could = items.filter((/** @type {any} */ i) => i.kind !== 'MUST');
  return `<div class="section-head">
<h2 id="challenge-title">THE CHALLENGE, LINE BY LINE</h2>
<p>What the challenge asks for and what it suggests, in our words, and what this site does about each line. A line is built when everything it asks for works, and partly built when some of it does.${typeof challenge.updated === 'string' ? ` As of ${dateWords(challenge.updated)}.` : ''}</p>
</div>
${group(must, 'What it asks for')}
${group(could, 'What it suggests')}`.replace(/\n{2,}/g, '\n');
}

/**
 * The same lines as a compact ruled list for the first page: each line of the challenge, how far it is built, and
 * where to see it. The words and marks of the status are those of challengeLines, from the same file.
 * @param {any} challenge
 * @returns {string}
 */
export function challengeScorecard(challenge) {
  const items = Array.isArray(challenge?.items) ? challenge.items.filter((/** @type {any} */ i) => typeof i?.line === 'string' && Object.hasOwn(LINE_STATUS, i.status)) : [];
  if (!items.length) return '';
  const rows = items.map((/** @type {any} */ i) => {
    const [words, mark] = LINE_STATUS[i.status];
    const link = typeof i.where === 'string' ? `<a href="${attr(i.where)}">See it<span class="visually-hidden">: ${esc(i.line)}</span></a>` : '';
    return `<li class="score" data-status="${attr(i.status)}">
<span class="score-line">${esc(i.line)}</span>
<span class="score-status">${statusMark(mark)}${words}</span>
<span class="score-link">${link}</span>
</li>`;
  });
  return `<h3 id="scorecard-title">WHAT THE CHALLENGE ASKS, AND WHERE IT IS ANSWERED</h3>
<ul class="scorecard" aria-labelledby="scorecard-title">
${rows.join('\n')}
</ul>
<p class="note">Marked as on the Checks page. <a href="checks.html#challenge">The same list, with a note on each line</a></p>`;
}

/**
 * The same lines as plain text for the project page, one short line each, with the status in the words of the page.
 * @param {any} challenge
 * @returns {string[]}
 */
export function challengeText(challenge) {
  const items = Array.isArray(challenge?.items) ? challenge.items : [];
  return items.filter((/** @type {any} */ i) => typeof i?.short === 'string' && Object.hasOwn(LINE_STATUS, i.status)).map((/** @type {any} */ i) => `- ${i.short}: ${LINE_STATUS[i.status][0].toLowerCase()}.`);
}

/** The tasks of tried.json that can be shown. @param {any} tried @returns {any[]} */
const tasksOf = (tried) => (Array.isArray(tried?.tasks) ? tried.tasks.filter((/** @type {any} */ t) => typeof t?.task === 'string') : []);

/**
 * The counts of observed use (tried.json) as numbers, so that the page carries them as it carries every number:
 * for each task how many testers tried it and how many did it without help, then the testers of the session, the
 * answers of "spot the mover" and the places where checking was asked for. A count that is not there yet has no number.
 * @param {any} tried
 * @returns {Record<string, NumberEntry>}
 */
export function triedNumbers(tried) {
  /** @type {Record<string, NumberEntry>} */
  const out = {};
  /** @param {string} key @param {unknown} v */
  const put = (key, v) => {
    if (typeof v === 'number' && Number.isInteger(v)) out[`v4.tried.${key}`] = { value: v, err: null, unit: null, text: String(v), check: null };
  };
  for (const [i, t] of tasksOf(tried).entries()) {
    if (!Number.isInteger(t.completed) || !Number.isInteger(t.attempted)) continue;
    put(`task${i + 1}.completed`, t.completed);
    put(`task${i + 1}.attempted`, t.attempted);
  }
  if (typeof tried?.session?.date === 'string') put('testers', tried.session.testers);
  const spot = tried?.spot_the_mover;
  if (spot?.built === true && Number.isInteger(spot.hits) && Number.isInteger(spot.of)) {
    put('spot.hits', spot.hits);
    put('spot.of', spot.of);
    put('spot.testers', spot.testers);
  }
  if (Number.isInteger(tried?.community?.posts)) {
    put('posts', tried.community.posts);
    put('replies', tried.community.replies);
  }
  return out;
}

/**
 * Observed use (tried.json): the tasks, the bar that was written before the session, and what happened. Before the
 * session the tasks stand with nothing beside them.
 * @param {Build} b @param {any} tried
 * @returns {string}
 */
export function triedTable(b, tried) {
  const tasks = tasksOf(tried);
  if (!tasks.length) return '';
  const bar = tried.pass_bar ?? {}, session = tried.session ?? {};
  const held = typeof session.date === 'string';
  const roles = Array.isArray(session.roles) ? session.roles.filter((/** @type {unknown} */ r) => typeof r === 'string') : [];
  /** True when the page has this count. @param {string} key */
  const has = (key) => Object.hasOwn(b.numbers, `v4.tried.${key}`);
  /** A count with its noun, in the singular when it is one. @param {string} key @param {string} single @param {string} many */
  const count = (key, single, many) => `${numberSpan(b, `v4.tried.${key}`)} ${b.numbers[`v4.tried.${key}`].value === 1 ? single : many}`;
  const who = held
    ? `The session was held on ${dateWords(session.date)}${has('testers') ? ` with ${count('testers', 'tester', 'testers')}` : ''}${roles.length ? ` (${esc(roles.join(', '))})` : ''}.${roles.length ? ' Each is named by role and nothing else.' : ''}${typeof session.notes === 'string' ? ` ${esc(session.notes)}` : ''}`
    : 'The session has not been held yet. The tasks and the bar stand here before any result, and the results will be shown whichever way they go.';
  const rows = tasks.map((/** @type {any} */ t, /** @type {number} */ i) => {
    const done = has(`task${i + 1}.completed`) && has(`task${i + 1}.attempted`)
      ? `${numberSpan(b, `v4.tried.task${i + 1}.completed`)} of ${numberSpan(b, `v4.tried.task${i + 1}.attempted`)}` : 'not tried yet';
    const result = t.passed === true ? 'Passed' : t.passed === false ? 'Not passed' : '';
    return `<tr><th scope="row">${esc(t.task)}</th><td>${done}</td><td>${result}</td><td>${typeof t.quote === 'string' ? `“${esc(t.quote)}”` : ''}</td></tr>`;
  }).join('\n');
  const spotLine = has('spot.hits') && has('spot.of')
    ? `<p>Spot the mover: ${numberSpan(b, 'v4.tried.spot.hits')} right of ${numberSpan(b, 'v4.tried.spot.of')}${has('spot.testers') ? `, by ${count('spot.testers', 'tester', 'testers')}` : ''}.</p>` : '';
  const community = tried.community ?? {};
  const quotes = Array.isArray(community.quotes) ? community.quotes.filter((/** @type {unknown} */ q) => typeof q === 'string') : [];
  const communityLine = has('posts')
    ? `<p>Asked for checking in ${count('posts', 'place', 'places')}${has('replies') ? `; ${count('replies', 'reply', 'replies')}` : ''}.${quotes.map((/** @type {string} */ q) => ` “${esc(q)}”`).join('')}</p>` : '';
  return `<div class="section-head">
<h2 id="tried-title">TRIED BY</h2>
<p>People who are not physicists try the site without help. ${typeof bar.rule === 'string' ? `The bar${typeof bar.written_on === 'string' ? `, written on ${dateWords(bar.written_on)}` : ''}: ${esc(bar.rule.charAt(0).toLowerCase() + bar.rule.slice(1))} ` : ''}${who}</p>
</div>
<div class="table-scroll" tabindex="0" role="group" aria-label="Table of the tasks">
<table class="ledger tried">
<thead>
<tr><th scope="col">Task</th><th scope="col">Done without help</th><th scope="col">Result</th><th scope="col">In their words</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</div>
${spotLine}
${communityLine}`.replace(/\n{2,}/g, '\n');
}
