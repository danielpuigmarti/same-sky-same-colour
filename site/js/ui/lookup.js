// "Look it up elsewhere": links, for a place on the sky, to the services where a volunteer finds out whether it is
// known. Nothing is sent from this page: these are plain links that open in a new tab.
//
// SIMBAD lists a star where the catalogue put it in 2000, so a star that moves fast is not near where it is now:
// SIMBAD and VizieR are asked for 2 arcmin around the place, nearest first.

/** How far around the place SIMBAD and VizieR look, arcmin. */
export const LOOKUP_RADIUS_ARCMIN = 2;

/** The width of the WiseView field and of the Aladin Lite field, arcsec and degrees: a little more than the 4.5 arcmin of the pictures here. */
export const WISEVIEW_SIZE_ARCSEC = 176;
export const ALADIN_FOV_DEG = 0.1;

/**
 * @typedef {Object} LookupLink
 * @property {'simbad' | 'vizier' | 'wiseview' | 'legacy' | 'aladin'} id
 * @property {string} label  What the link is, in words.
 * @property {string} href
 */

/** @param {number} v  Degrees, as the links carry them: a millionth of a degree. */
const deg = (v) => Number(v.toFixed(6));

/**
 * The links for a place.
 * @param {number} ra @param {number} dec  Degrees, ICRS.
 * @returns {LookupLink[]}  Empty when the place is not a position.
 */
export function lookupLinks(ra, dec) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return [];
  const r = deg(((ra % 360) + 360) % 360), d = deg(dec);
  const pair = encodeURIComponent(`${r} ${d}`);
  const r2 = LOOKUP_RADIUS_ARCMIN;
  return [
    { id: 'simbad', label: `SIMBAD, ${r2}′ around`, href: `https://simbad.cfa.harvard.edu/simbad/sim-coo?Coord=${pair}&Radius=${r2}&Radius.unit=arcmin&coodisp1=d2&list.pmsel=on&list.plxsel=on&list.rvsel=on&list.bibsel=off&list.notesel=off` },
    { id: 'vizier', label: `VizieR, ${r2}′ around`, href: `https://vizier.cfa.harvard.edu/viz-bin/VizieR?-c=${pair}&-c.rs=${r2}&-c.u=arcmin&-out.add=_r&-sort=_r` },
    { id: 'wiseview', label: 'WiseView, WISE photos 2010–2024', href: `http://byw.tools/wiseview#ra=${r}&dec=${d}&size=${WISEVIEW_SIZE_ARCSEC}&band=2&speed=500&minbright=-50&maxbright=500&window=0.5&diff_window=1&linear=1&zoom=9&border=0&gaia=0&invert=1&maxdyr=0&scandir=0&neowise=0&diff=0&outer_epochs=0&unique_window=1&smooth_scan=0&shift=0&pmra=0&pmdec=0` },
    { id: 'legacy', label: 'Legacy Survey viewer', href: `https://www.legacysurvey.org/viewer?ra=${r}&dec=${d}&zoom=14&layer=ls-dr10` },
    { id: 'aladin', label: 'Aladin Lite', href: `https://aladin.cds.unistra.fr/AladinLite/?target=${pair}&fov=${ALADIN_FOV_DEG}` },
  ];
}

/**
 * The position a link names, read back from its address: what the checks compare with the readout.
 * @param {string} href
 * @returns {{ra: number, dec: number} | null}
 */
export function positionOfLink(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const own = url.hash ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
  const both = own.get('Coord') ?? own.get('-c') ?? own.get('target');
  if (both !== null) {
    const [ra, dec] = both.trim().split(/\s+/).map(Number);
    return Number.isFinite(ra) && Number.isFinite(dec) ? { ra, dec } : null;
  }
  const ra = Number(own.get('ra')), dec = Number(own.get('dec'));
  return own.has('ra') && own.has('dec') && Number.isFinite(ra) && Number.isFinite(dec) ? { ra, dec } : null;
}

/**
 * @param {number} ra @param {number} dec @param {number} decimals
 * @returns {string}  "270.0000° +66.5600°", as the readouts of the page write a position.
 */
export function formatPlace(ra, dec, decimals = 4) {
  return `${ra.toFixed(decimals)}° ${dec < 0 ? '−' : '+'}${Math.abs(dec).toFixed(decimals)}°`;
}

/**
 * Build the part in `root`: one row for the centre of the view and one for the place clicked.
 * @param {HTMLElement} root
 * @param {{decimals?: number}} [options]
 */
export function createLookup(root, { decimals = 4 } = {}) {
  root.classList.add('lookup');
  const heading = document.createElement('h2');
  heading.textContent = 'LOOK IT UP ELSEWHERE';
  const note = document.createElement('p');
  note.className = 'lookup-note';
  note.textContent = `Each link opens another site in a new tab. A star that moves fast is listed where it was in 2000, so SIMBAD and VizieR are asked for ${LOOKUP_RADIUS_ARCMIN} arcmin around the place, nearest first.`;
  const rows = document.createElement('div');
  rows.className = 'lookup-rows';
  root.replaceChildren(heading, note, rows);

  /** @param {'centre' | 'clicked'} id @param {string} label */
  const makeRow = (id, label) => {
    const row = document.createElement('div');
    row.className = 'lookup-row';
    row.dataset.row = id;
    const name = document.createElement('p');
    name.className = 'lookup-name';
    name.textContent = label;
    const where = document.createElement('p');
    where.className = 'lookup-where';
    where.dataset.where = id;
    const links = document.createElement('p');
    links.className = 'lookup-links';
    row.append(name, where, links);
    rows.append(row);
    return { row, where, links };
  };
  const centre = makeRow('centre', 'Centre of the view');
  const clicked = makeRow('clicked', 'Place clicked');

  /** @param {{where: HTMLElement, links: HTMLElement}} part @param {number | null} ra @param {number | null} dec @param {string} empty */
  function fill(part, ra, dec, empty) {
    const links = ra !== null && dec !== null ? lookupLinks(ra, dec) : [];
    part.where.textContent = links.length ? formatPlace(/** @type {number} */ (ra), /** @type {number} */ (dec), decimals) : empty;
    part.links.replaceChildren();
    for (const l of links) {
      const a = document.createElement('a');
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.dataset.lookup = l.id;
      a.textContent = l.label;
      part.links.append(a, ' ');
    }
    part.links.hidden = links.length === 0;
  }

  fill(centre, null, null, '—');
  fill(clicked, null, null, 'Click a place in the picture.');
  root.hidden = true;

  return {
    /** The centre of the view; no place hides the part. @param {number | null} ra @param {number | null} dec */
    setCentre(ra, dec) {
      fill(centre, ra, dec, '—');
      root.hidden = !(ra !== null && dec !== null && Number.isFinite(ra) && Number.isFinite(dec));
    },
    /** The place the visitor clicked; null for none. @param {number | null} ra @param {number | null} dec */
    setClicked(ra, dec) {
      fill(clicked, ra !== null && Number.isFinite(ra) ? ra : null, dec !== null && Number.isFinite(dec) ? dec : null, 'Click a place in the picture.');
    },
  };
}
