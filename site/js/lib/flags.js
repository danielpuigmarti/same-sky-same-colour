// The flags of a SPHEREx Level 2 image: one table for the whole site.
//
// Every pixel of a frame has a flag word (the FLAGS part of the file). Bits and names are the ones the frames
// declare themselves, in the MSKN and MSKM cards of their headers. The tier says how a flag is treated on screen:
//
//   saturation  the pixel was too bright to be measured well: hatched one way
//   defect      the value of the pixel cannot be trusted: hatched the other way
//   source      the pixel lies on a known star or galaxy, which is no defect: shown only on request
//   none        never drawn
//
// The readout under the pointer names every flag that is set, except FULLSAMPLE.

/**
 * @typedef {'saturation' | 'defect' | 'source' | 'none'} FlagTier
 */

/**
 * @typedef {Object} FlagRow
 * @property {number} bit  Bit number in the flag word; the bit's value is 1 << bit.
 * @property {string} name  Name of the flag in the header of a frame.
 * @property {string} label  What it means, in plain words.
 * @property {FlagTier} tier
 */

/** @type {readonly Readonly<FlagRow>[]} */
export const FLAG_TABLE = Object.freeze(/** @type {FlagRow[]} */ ([
  { bit: 0, name: 'TRANSIENT', label: 'sudden jump during the exposure, such as a cosmic-ray hit', tier: 'defect' },
  { bit: 1, name: 'OVERFLOW', label: 'nearing saturation: the pixel filled up during the exposure', tier: 'saturation' },
  { bit: 2, name: 'SUR_ERROR', label: 'error in the processing on board', tier: 'defect' },
  { bit: 6, name: 'NONFUNC', label: 'pixel that never works', tier: 'defect' },
  { bit: 7, name: 'DICHROIC', label: 'little light reaches this pixel', tier: 'none' },
  { bit: 9, name: 'MISSING_DATA', label: 'data lost on the way to the ground', tier: 'defect' },
  { bit: 10, name: 'HOT', label: 'hot pixel', tier: 'defect' },
  { bit: 11, name: 'COLD', label: 'pixel with far too little signal', tier: 'defect' },
  { bit: 12, name: 'FULLSAMPLE', label: 'the full readout of this pixel was kept; not a defect', tier: 'none' },
  { bit: 14, name: 'PHANMISS', label: 'one correction was not applied', tier: 'none' },
  { bit: 15, name: 'NONLINEAR', label: 'too bright to be corrected reliably', tier: 'saturation' },
  { bit: 17, name: 'PERSIST', label: 'after-image of something bright seen just before', tier: 'defect' },
  { bit: 19, name: 'OUTLIER', label: 'stands out from the pixels around it', tier: 'defect' },
  { bit: 20, name: 'CROSSTALK', label: 'electrical echo of a bright pixel', tier: 'defect' },
  { bit: 21, name: 'SOURCE', label: 'a known star or galaxy; not a defect', tier: 'source' },
  { bit: 22, name: 'GHOST', label: 'reflection of a bright star in this photo', tier: 'defect' },
  { bit: 23, name: 'GHOST_FPA', label: 'reflection of a bright star on another detector', tier: 'defect' },
  { bit: 24, name: 'GHOST_EXT', label: 'reflection of a bright star outside the photo', tier: 'defect' },
  { bit: 25, name: 'STREAK', label: 'streak, probably a satellite', tier: 'defect' },
  { bit: 26, name: 'BLOOM', label: 'charge spilled over from a saturated neighbour', tier: 'saturation' },
  { bit: 27, name: 'SNOWBALL', label: 'burst of charge inside the detector', tier: 'defect' },
  { bit: 28, name: 'HALO', label: 'halo around a sudden jump', tier: 'defect' },
]).map((row) => Object.freeze(row)));

/** @param {FlagTier} tier @returns {number} the bits of a tier as one word */
function maskOf(tier) {
  let word = 0;
  for (const row of FLAG_TABLE) if (row.tier === tier) word |= 1 << row.bit;
  return word;
}

/** The bits of the tier "saturation". A pixel is hatched as saturated when `(word & SATURATION_MASK) !== 0`. */
export const SATURATION_MASK = maskOf('saturation');

/** The bits of the tier "defect". */
export const DEFECT_MASK = maskOf('defect');

/** The bit of the tier "source". */
export const SOURCE_MASK = maskOf('source');

/** The flag that the readout does not name. */
const UNNAMED = 'FULLSAMPLE';

/**
 * The rows of the flags set in a word, lowest bit first. A bit the table does not hold is given as BIT_n with the
 * tier "none".
 * @param {number} word
 * @returns {Readonly<FlagRow>[]}
 */
export function flagRows(word) {
  /** @type {Readonly<FlagRow>[]} */
  const out = [];
  for (let bit = 0; bit < 32; bit++) {
    if (!(word & (1 << bit))) continue;
    out.push(FLAG_TABLE.find((row) => row.bit === bit) ?? { bit, name: `BIT_${bit}`, label: 'a flag the frames do not describe', tier: 'none' });
  }
  return out;
}

/**
 * The names of the flags set in a word, as the readout lists them: all of them except FULLSAMPLE.
 * @param {number} word
 * @returns {string[]}
 */
export function flagNames(word) {
  return flagRows(word).map((row) => row.name).filter((name) => name !== UNNAMED);
}
