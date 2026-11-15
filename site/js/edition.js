// The two editions of the site: night (black paper, the default) and day (pale paper).
//
// This script stands in the head of every page and is not a module, so that it runs before anything is drawn:
// the page never shows one edition and then the other. The choice is kept on this device and nowhere else.
// The control that changes the edition is any button marked data-edition-toggle. Pages keep it hidden, because
// without this script it could do nothing; here it is shown, and it says which edition a press leads to.
(function () {
  const KEY = 'same-sky-same-colour:edition';
  const root = document.documentElement;

  /** The edition that was chosen on this device, if any. Storage may be closed to the page: then there is none. */
  function chosen() {
    try {
      return localStorage.getItem(KEY) === 'day' ? 'day' : 'night';
    } catch {
      return 'night';
    }
  }

  /** The colour of the paper, which a phone's browser also gives its own bar. */
  const PAPER = { night: '#0c0b08', day: '#f6efd6' };

  /** @param {string} edition  'day' or 'night' */
  function show(edition) {
    root.dataset.edition = edition === 'day' ? 'day' : 'night';
    let bar = document.querySelector('meta[name="theme-color"]');
    if (!bar && document.head) {
      bar = document.createElement('meta');
      bar.setAttribute('name', 'theme-color');
      document.head.append(bar);
    }
    bar?.setAttribute('content', root.dataset.edition === 'day' ? PAPER.day : PAPER.night);
    for (const button of document.querySelectorAll('[data-edition-toggle]')) {
      button.textContent = root.dataset.edition === 'day' ? 'Night edition' : 'Day edition';
    }
  }

  show(chosen());

  function ready() {
    for (const button of document.querySelectorAll('[data-edition-toggle]')) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.hidden = false;
      button.addEventListener('click', () => {
        const next = root.dataset.edition === 'day' ? 'night' : 'day';
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // the choice then holds for this page only
        }
        show(next);
      });
    }
    show(root.dataset.edition ?? 'night');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  // another window of the site changed the edition: follow it
  addEventListener('storage', (/** @type {StorageEvent} */ event) => {
    if (event.key === KEY) show(chosen());
  });
})();
