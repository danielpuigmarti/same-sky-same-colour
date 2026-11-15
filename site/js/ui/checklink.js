// The quiet link to a claim's check: a link with the class check-link and data-check="K5" gets the mark of that
// check's status (data-status), read from the data of the Checks page. Without this script, or when the data
// cannot be had, the link is still there: the id, underlined, with no mark.
import { CHECKS_FILE } from '../contracts.js';

/**
 * @param {ParentNode} [root]
 * @returns {Promise<void>}
 */
export async function mountCheckLinks(root = document) {
  const links = [...root.querySelectorAll('a.check-link[data-check]')];
  if (links.length === 0) return;
  try {
    const r = await fetch(new URL(CHECKS_FILE, document.baseURI));
    if (!r.ok) return;
    /** @type {{id: string, status: string, plain?: string}[]} */
    const rows = await r.json();
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const link of links) {
      const id = link.getAttribute('data-check') ?? '', row = found.get(id);
      if (!row) continue;
      link.setAttribute('data-status', row.status);
      if (!link.querySelector('.status-mark')) {
        const mark = document.createElement('span');
        mark.className = 'status-mark';
        mark.setAttribute('data-status', row.status.toLowerCase());
        mark.setAttribute('aria-hidden', 'true');
        link.prepend(mark);
      }
      if (row.plain) link.setAttribute('aria-label', `Check ${id}: ${row.plain}`);
    }
  } catch {
    // the link stands without its mark
  }
}
