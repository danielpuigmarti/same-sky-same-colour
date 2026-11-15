// The plan before loading (visits, photos, MB, seconds) and the progress while loading
// ("photo 7 of 16 · 4.1 of 9 MB"). The first half of this file has no need of a page.

/** @import { Plan } from '../contracts.js' */

/**
 * Bytes as megabytes in text, without the unit: one decimal below 10 ("4.1"; "9" for a whole number), none above.
 * @param {number} bytes
 * @returns {string}
 */
export function formatMB(bytes) {
  const mb = Math.max(0, Number.isFinite(bytes) ? bytes : 0) / 1e6;
  return mb >= 9.95 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, '');
}

/**
 * Seconds as words: "about 12 seconds", "about 2 minutes".
 * @param {number} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  const s = Math.max(1, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 90) return `about ${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(s / 60);
  return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/**
 * What a plan costs, counted.
 * @param {Plan} plan
 * @returns {{visits: number, photos: number, bytes: number, seconds: number}}
 */
export function planCounts(plan) {
  return {
    visits: plan.visits.filter((v) => v.frames.length > 0).length,
    photos: plan.pairs.length * 2,
    bytes: plan.bytes,
    seconds: plan.seconds,
  };
}

/**
 * A plan in one line: "3 visits · 16 photos · 9 MB · about 12 seconds".
 * @param {Plan} plan
 * @returns {string}
 */
export function planText(plan) {
  const c = planCounts(plan);
  return [
    `${c.visits} ${c.visits === 1 ? 'visit' : 'visits'}`,
    `${c.photos} ${c.photos === 1 ? 'photo' : 'photos'}`,
    `${formatMB(c.bytes)} MB`,
    formatSeconds(c.seconds),
  ].join(' · ');
}

/**
 * What is read from a progress report: how many photos are ready, of how many, and the bytes read so far.
 * The contract leaves the report open; this takes any object with the numbers `done` and `total`, and `bytes`
 * when it has it. Null for anything else.
 * @param {unknown} progress
 * @returns {{done: number, total: number, bytes: number | null} | null}
 */
export function progressOf(progress) {
  const p = /** @type {any} */ (progress);
  if (p === null || typeof p !== 'object' || !Number.isFinite(p.done) || !Number.isFinite(p.total)) return null;
  return { done: p.done, total: p.total, bytes: Number.isFinite(p.bytes) ? p.bytes : null };
}

/**
 * Progress in one line: "photo 7 of 16 · 4.1 of 9 MB". The megabytes are left out when they are not known.
 * @param {{done: number, total: number, bytes: number | null}} progress
 * @param {number | null} [planBytes]  The bytes the plan expects.
 * @returns {string}
 */
export function progressText(progress, planBytes = null) {
  const photos = `photo ${progress.done} of ${progress.total}`;
  if (progress.bytes === null || planBytes === null || !(planBytes > 0)) return photos;
  return `${photos} · ${formatMB(progress.bytes)} of ${formatMB(Math.max(planBytes, progress.bytes))} MB`;
}

/**
 * Build the plan in `root`.
 * @param {HTMLElement} root
 */
export function createPlan(root) {
  root.classList.add('plan');
  const summary = document.createElement('p');
  summary.className = 'plan-summary';
  const line = document.createElement('p');
  line.className = 'plan-progress';
  const meter = document.createElement('progress');
  meter.className = 'plan-meter';
  meter.setAttribute('aria-label', 'Photos loaded');
  const text = document.createElement('span');
  text.className = 'plan-progress-text';
  line.append(meter, text);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn plan-button';
  root.replaceChildren(summary, line, button);
  /** @type {(() => void) | null} */
  let action = null;
  button.addEventListener('click', () => {
    const run = action;
    action = null;
    button.hidden = true;
    run?.();
  });
  /** @type {number | null} */
  let planBytes = null;

  function clear() {
    summary.textContent = '';
    summary.hidden = true;
    line.hidden = true;
    button.hidden = true;
    action = null;
    planBytes = null;
    root.dataset.phase = 'idle';
  }

  return {
    /** A line of its own, before there is a plan: "Looking for photos of this position". @param {string} words */
    busy(words) {
      clear();
      summary.textContent = words;
      summary.hidden = false;
      root.dataset.phase = 'busy';
    },
    /** The plan, before anything is loaded. @param {Plan} plan */
    showPlan(plan) {
      clear();
      planBytes = plan.bytes;
      summary.textContent = planText(plan);
      summary.hidden = false;
      root.dataset.phase = 'plan';
    },
    /**
     * A progress report. Reports that carry no count are ignored.
     * @param {unknown} report
     * @param {{done?: number, total?: number, bytes?: number}} [before]  What earlier loads of the same plan already brought.
     */
    progress(report, before = {}) {
      const p = progressOf(report);
      if (!p) return;
      const done = p.done + (before.done ?? 0), total = before.total ?? p.total;
      const bytes = p.bytes === null ? null : p.bytes + (before.bytes ?? 0);
      meter.max = Math.max(1, total);
      meter.value = Math.min(done, total);
      text.textContent = progressText({ done, total, bytes }, planBytes);
      line.hidden = false;
      root.dataset.phase = 'loading';
    },
    /** Loading has ended; the summary stays. */
    finish() {
      line.hidden = true;
      root.dataset.phase = 'done';
    },
    /**
     * Offer something to press: "Load 9 MB", "Load more (5 MB)".
     * @param {string} label @param {() => void} run
     */
    offer(label, run) {
      button.textContent = label;
      button.hidden = false;
      action = run;
    },
    clear,
  };
}

/** @typedef {ReturnType<typeof createPlan>} PlanBox */
