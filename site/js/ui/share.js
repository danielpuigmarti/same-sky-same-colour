// The menu of a view: copy its link, copy the code that embeds it in another page, and the list of the photos it
// is made of, each with its address in the archive.
//
// The link carries the whole view: the address of the page as the viewer keeps it. The embed code is an iframe on
// the same address with embed=1, which shows the stage alone with a link back. Nothing is stored and nothing is
// sent: copying goes to the visitor's own clipboard.
//
// The first half of this file has no need of a page; createShare builds the menu in one.

import { BUCKET_URLS, KEY_REGEX } from '../contracts.js';

/** The size of the frame that the embed code asks for, CSS px. */
export const EMBED_WIDTH = 480, EMBED_HEIGHT = 720;

/**
 * One photo of a view, for the list.
 * @typedef {Object} UsedPhoto
 * @property {string} key  Bucket key of the frame.
 * @property {number} mjd  Mid-exposure time, MJD (UTC).
 * @property {number} lam  Wavelength at the target, µm.
 * @property {'earlier' | 'later'} side  Which of the two visits it belongs to.
 */

/** @param {string} text */
const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The address of a frame in the archive; empty for a key that is not the key of a frame.
 * @param {string} key
 * @returns {string}
 */
export function bucketUrl(key) {
  return KEY_REGEX.test(key ?? '') ? BUCKET_URLS[0] + key : '';
}

/**
 * The file name of a frame: the last part of its key.
 * @param {string} key
 * @returns {string}
 */
export function fileName(key) {
  return String(key ?? '').split('/').pop() ?? '';
}

/**
 * The address of a view with embed=1 set, whatever it had before; the part after "#" is kept.
 * @param {string} link  A whole address.
 * @returns {string}
 */
export function embedUrl(link) {
  const u = new URL(link);
  u.searchParams.delete('embed');
  u.searchParams.append('embed', '1');
  return u.href.replace(/%2F/gi, '/');
}

/**
 * The code that shows a view inside another page.
 * @param {string} link  The whole address of the view.
 * @param {string} [title]  What the frame shows, for someone who cannot see it.
 * @returns {string}
 */
export function embedCode(link, title = 'Two visits of one patch of sky at one colour') {
  return `<iframe src="${escapeAttribute(embedUrl(link))}" width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}" style="border:0;max-width:100%" loading="lazy" title="${escapeAttribute(title)}"></iframe>`;
}

/**
 * Put text on the clipboard. True when it worked.
 * @param {string} text
 * @param {Document} [doc]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, doc = document) {
  try {
    const clip = doc.defaultView?.navigator.clipboard;
    if (clip?.writeText) {
      await clip.writeText(text);
      return true;
    }
  } catch { /* not allowed here: the older way is tried */ }
  try {
    const field = doc.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    doc.body.append(field);
    field.select();
    const ok = doc.execCommand('copy');
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Build the menu in `root`.
 * @param {HTMLElement} root
 * @param {{link: () => string, title?: () => string, formatDate?: (mjd: number) => string, copy?: (text: string) => Promise<boolean> | boolean}} options
 *   `link` gives the whole address of the view as it is now. `copy` replaces the clipboard, for tests.
 * @returns {{setPhotos: (photos: UsedPhoto[]) => void, close: () => void}}
 */
export function createShare(root, options) {
  const doc = root.ownerDocument;
  const copy = options.copy ?? ((/** @type {string} */ text) => copyText(text, doc));
  root.classList.add('share');

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'share-toggle';
  toggle.textContent = 'Share this view';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = doc.createElement('div');
  panel.className = 'share-panel';
  panel.id = 'share-panel';
  panel.hidden = true;
  toggle.setAttribute('aria-controls', panel.id);

  /** @param {string} words @param {() => string} what @param {string} done */
  const button = (words, what, done) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'btn share-copy';
    b.textContent = words;
    b.addEventListener('click', async () => {
      const text = what();
      const ok = await copy(text);
      status.textContent = ok ? done : 'Could not copy. Select the text below and copy it by hand.';
      fallback.hidden = ok;
      fallback.value = ok ? '' : text;
      if (!ok) fallback.select();
    });
    return b;
  };
  const status = doc.createElement('p');
  status.className = 'share-status';
  status.setAttribute('role', 'status');
  const fallback = doc.createElement('textarea');
  fallback.className = 'share-fallback';
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.rows = 3;
  fallback.setAttribute('aria-label', 'Text to copy');
  const actions = doc.createElement('div');
  actions.className = 'share-actions';
  actions.append(
    button('Copy link', () => options.link(), 'Link copied. It opens this view: the position, the range of colours, the two visits and how they are shown.'),
    button('Copy embed code', () => embedCode(options.link(), options.title?.()), 'Embed code copied. Pasted into a page, it shows the pictures alone, with a link back here.'),
  );

  const photosBox = doc.createElement('details');
  photosBox.className = 'disclosure share-photos';
  const summary = doc.createElement('summary');
  const list = doc.createElement('ol');
  list.className = 'rows share-photo-list';
  const source = doc.createElement('p');
  source.className = 'share-source';
  source.textContent = 'Each link is the whole photo as the archive holds it: a large FITS file in the public bucket of the NASA/IPAC Infrared Science Archive. This page read only the rows it shows.';
  photosBox.append(summary, source, list);
  photosBox.hidden = true;

  panel.append(actions, status, fallback, photosBox);
  root.replaceChildren(toggle, panel);

  /** @param {boolean} open */
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (!open) { status.textContent = ''; fallback.hidden = true; }
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    setOpen(false);
    toggle.focus();
  });

  return {
    setPhotos(photos) {
      list.replaceChildren();
      photosBox.hidden = photos.length === 0;
      summary.textContent = `Photos used (${photos.length})`;
      for (const p of photos) {
        const item = doc.createElement('li');
        item.dataset.side = p.side;
        const when = doc.createElement('span');
        when.className = 'share-photo-when';
        when.textContent = `${p.side === 'earlier' ? 'Earlier visit' : 'Later visit'}, ${options.formatDate ? options.formatDate(p.mjd) : ''}${Number.isFinite(p.lam) ? `, ${p.lam.toFixed(3)} µm` : ''}`;
        const url = bucketUrl(p.key);
        /** @type {HTMLElement} */
        let name;
        if (url) {
          const a = doc.createElement('a');
          a.href = url;
          a.rel = 'noopener';
          name = a;
        } else name = doc.createElement('span');
        name.className = 'share-photo-file';
        name.textContent = fileName(p.key);
        item.append(when, ' ', name);
        list.append(item);
      }
    },
    close: () => setOpen(false),
  };
}
