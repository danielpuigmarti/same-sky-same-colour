// When the centre of the view is saturated: one plain sentence that says what the pink hatching is and why no
// brightness is given. The first thing a visitor tries (Vega, Barnard's Star) is often too bright for SPHEREx.

import { SATURATION_MASK } from '../lib/flags.js';

/**
 * True when the pixel at the target of a picture is saturated.
 * @param {{w: number, h: number, tx: number, ty: number, flags?: ArrayLike<number> | null} | null | undefined} picture
 * @returns {boolean}
 */
export function centreSaturated(picture) {
  if (!picture || !picture.flags) return false;
  const x = Math.round(picture.tx), y = Math.round(picture.ty);
  if (!(x >= 0 && y >= 0 && x < picture.w && y < picture.h)) return false;
  return (picture.flags[y * picture.w + x] & SATURATION_MASK) !== 0;
}

/**
 * The sentence for a saturated centre.
 * @param {{moves?: boolean, prepared?: boolean}} [place]  `moves`: a prepared target that moves, whose motion the Difference view shows. `prepared`: one of the five prepared targets.
 * @returns {string}
 */
export function saturationNote({ moves = false, prepared = false } = {}) {
  const base = 'The pink hatching marks pixels that are saturated or damaged. The centre of this star is too bright for SPHEREx, so no brightness is given for it.';
  if (moves) return `${base} Its motion is what this view shows: see the Difference view.`;
  return prepared ? base : `${base} A fainter star gives a brightness.`;
}
