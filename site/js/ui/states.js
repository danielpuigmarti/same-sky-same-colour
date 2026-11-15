// One plain message, with a next step, for each way a view can end without a comparison (CT-12).
// `cancelled` has none: the page withdrew the call itself, and what was on the stage stays.

/** @import { FailureState } from '../contracts.js' */
import { FAILURE_STATES } from '../contracts.js';

/**
 * What can be offered as a next step. `retry`: try again. `targets`: the prepared targets. `comet`: the page of
 * the comet. `home`: the first page, where a position is typed.
 * @typedef {'retry' | 'targets' | 'comet' | 'home'} StateAction
 */

/**
 * @typedef {Object} StateText
 * @property {string} title  What happened.
 * @property {string} next  What to do next.
 * @property {StateAction[]} actions  What is offered, in this order.
 * @property {boolean} keeps  True when the pictures that are already on the stage stay there.
 */

/** @type {Readonly<Record<Exclude<FailureState, 'cancelled'>, StateText>>} */
export const STATE_TEXT = Object.freeze({
  'no-coverage': {
    title: 'SPHEREx has no photos of this position in this release of its data.',
    next: 'Try another position, or open one of the prepared targets.',
    actions: ['home', 'targets'],
    keeps: false,
  },
  'one-visit': {
    title: 'SPHEREx has photographed this position during one visit only, so there is nothing to compare it with yet.',
    next: 'A later release of the data will bring a second visit. Until then, open one of the prepared targets.',
    actions: ['targets', 'home'],
    keeps: false,
  },
  'not-indexed': {
    title: 'This part of the sky is not in our list of photos yet.',
    next: 'The list is still being built. Try again later, or open one of the prepared targets.',
    actions: ['retry', 'targets'],
    keeps: false,
  },
  slow: {
    title: 'The archive is answering slowly.',
    next: 'What has arrived is shown. Try again for the rest.',
    actions: ['retry'],
    keeps: true,
  },
  unreachable: {
    title: 'The archive cannot be reached right now.',
    next: 'The prepared targets are stored with this site and still work. Or try again.',
    actions: ['retry', 'targets'],
    keeps: true,
  },
  'too-bright': {
    title: 'This star is too bright for SPHEREx: it fills its pixels, so its brightness cannot be compared.',
    next: 'Where it is can still be compared. For brightness, choose a fainter star.',
    actions: ['targets', 'home'],
    keeps: true,
  },
  'too-faint': {
    title: 'These are the photos of this patch. Nothing bright stands at its centre.',
    next: 'Look around the patch, and click any pixel to read its spectrum and to see whether something is known there.',
    actions: [],
    keeps: true,
  },
  quiet: {
    title: 'Nothing changed above the noise here, which is normal.',
    next: 'Most of the sky stays as it is. These things do change:',
    actions: ['targets', 'comet'],
    keeps: true,
  },
});

/** Where the links of the next steps lead, from a page in the top folder of the site. */
export const STATE_LINKS = Object.freeze({ targets: 'targets.html', comet: 'lemmon.html', home: './' });

const ACTION_WORDS = Object.freeze({ retry: 'Try again', targets: 'Prepared targets', comet: 'Comet Lemmon', home: 'Type another position' });

/**
 * True for a value that is a failure of CT-12: an object with a `state` that is one of the states.
 * @param {unknown} value
 * @returns {value is {state: FailureState}}
 */
export function isFailure(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && FAILURE_STATES.includes(/** @type {any} */ (value).state);
}

/**
 * Take the message away.
 * @param {HTMLElement} root
 */
export function clearState(root) {
  root.replaceChildren();
  delete root.dataset.state;
  root.hidden = true;
}

/**
 * Show the message of a state in `root`, in place of whatever message was there. `cancelled`, or a state this
 * page does not know, shows nothing and takes the old message away.
 * @param {HTMLElement} root
 * @param {FailureState | string} state
 * @param {{onRetry?: () => void, links?: Partial<Record<'targets' | 'comet' | 'home', string>>}} [options]
 *   Without onRetry, "Try again" loads the page again.
 * @returns {StateText | null}  The text that was shown, or null when nothing was.
 */
export function renderState(root, state, options = {}) {
  clearState(root);
  const text = Object.hasOwn(STATE_TEXT, state) ? STATE_TEXT[/** @type {Exclude<FailureState, 'cancelled'>} */ (state)] : null;
  if (!text) return null;
  const links = { ...STATE_LINKS, ...options.links };
  root.hidden = false;
  root.dataset.state = state;
  root.classList.add('state');
  root.setAttribute('role', 'status');

  const title = document.createElement('p');
  title.className = 'state-title';
  title.textContent = text.title;
  const next = document.createElement('p');
  next.className = 'state-next';
  next.textContent = text.next;
  const actions = document.createElement('p');
  actions.className = 'state-actions';
  for (const action of text.actions) {
    if (action === 'retry') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn state-retry';
      b.textContent = ACTION_WORDS.retry;
      b.addEventListener('click', () => (options.onRetry ? options.onRetry() : root.ownerDocument.defaultView?.location.reload()));
      actions.append(b);
    } else {
      const a = document.createElement('a');
      a.className = 'state-link';
      a.dataset.action = action;
      a.href = links[action];
      a.textContent = ACTION_WORDS[action];
      actions.append(a);
    }
  }
  root.append(title, next);
  if (text.actions.length) root.append(actions);
  return text;
}
