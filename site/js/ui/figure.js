// What the card of a prepared target says that its pictures cannot, and in which range of colours it measures.
// The pure functions have no need of a page.

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** @type {Promise<Record<string, {text: string}> | null> | null} */
let numbersAsked = null;

/** The numbers of the site, as the cards name them; null when they cannot be had. @returns {Promise<Record<string, {text: string}> | null>} */
export function loadNumbers(base = '') {
  numbersAsked ??= fetch(`${base}data/numbers.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return numbersAsked;
}

/**
 * A sentence of a card, with its {{numbers}} filled; empty when one of them is missing.
 * @param {string} text @param {Record<string, {text: string}> | null} numbers
 * @returns {string}
 */
export function fillCard(text, numbers) {
  let whole = true;
  const out = text.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const n = numbers?.[key];
    if (!n) whole = false;
    return n?.text ?? '';
  });
  return whole ? out.replace(/ (%|µm)/g, '\u00a0$1') : '';
}

/**
 * The card of a prepared target, as far as the viewer reads it.
 * @typedef {{name?: string, kind?: string, detector?: number, verdict?: string, bands?: {detector: number, shown: boolean, text?: string}[]}} Card
 */

/**
 * What the card of a prepared target says that the pictures cannot: for a star too bright for SPHEREx, that no
 * brightness is given; for a variable star, the change the card measures and in which colours.
 * @param {Card | null} card @param {Record<string, {text: string}> | null} numbers
 * @returns {string}  '' when the card has nothing to add, or a figure of it is missing.
 */
export function figureOf(card, numbers) {
  if (!card) return '';
  if (card.kind === 'saturated') return card.verdict ? fillCard(card.verdict, numbers) : '';
  if (card.kind !== 'variable' || !Array.isArray(card.bands)) return '';
  const shown = card.bands.filter((b) => b.shown && b.text).map((b) => fillCard(/** @type {string} */ (b.text), numbers));
  const left = card.bands.filter((b) => !b.shown).length;
  if (!shown.length || shown.some((t) => t === '')) return '';
  const name = (card.name ?? 'This star').replace(/'/g, '’');
  return `The card of ${name} measures a change of ${shown.join(' and ')}.${left ? ` In the other ${COUNT_WORDS[left] ?? String(left)} ranges of colour it is too bright to measure reliably.` : ''}`;
}

/**
 * The range of colours that a card measures, when the stored pictures of its target are in one that it calls too
 * bright to measure; null when the stored pictures are in a range it measures, or it measures none.
 * @param {Card | null} card @param {number} stored  The detector of the stored pictures.
 * @returns {number | null}  The detector.
 */
export function measuredRange(card, stored) {
  const bands = Array.isArray(card?.bands) ? card.bands : [];
  if (!bands.length || bands.find((b) => b.detector === stored)?.shown !== false) return null;
  return bands.find((b) => b.shown)?.detector ?? null;
}

/** @param {string} folder @returns {Promise<Card | null>} */
export async function loadCard(folder) {
  try {
    const r = await fetch(`${folder}card.json`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

