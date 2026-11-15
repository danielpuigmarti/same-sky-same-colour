/**
 * The text of a number as it is printed: a minus sign, not a hyphen, before a figure; an en dash between the two
 * ends of a range when either end has a decimal point (dates and catalogue names keep their hyphens); a no-break
 * space between a figure and its unit. Setting a text twice changes nothing. Used by the gate, which fills the
 * pages, and by the makers of the three pages written from the data, so that both write the same text.
 * @param {string} s
 * @returns {string}
 */
export const setNumber = (s) => s
  .replace(/(^|[\s(\[])-(?=\d)/g, '$1−')
  .replace(/(\d\.\d+)-(?=\d)/g, '$1–')
  .replace(/(\d)-(?=\d+\.\d)/g, '$1–')
  .replace(/(\d) (?=(?:µm|μm|nm|arcsec|arcmin|px|pixels?|%|mag|ms|s|days?|years?|degrees?|km)(?![\p{L}]))/gu, '$1 ');
