// The first page. Without this script the page is whole: the two photos of the comet's patch of sky side by side,
// the four photos of one night with their numbers, the box and the lists are in the page itself. The script adds
// what needs one: the plate that flips by itself, the chip on the ruler of the night and the bars under its
// photos, the stage of "a plain blink lies" and the bars of its meter, and an answer on the spot to what is typed
// in the box.
import { mountFlip, mountNight, mountBars } from '../ui/hero.js';
import { mountLie, mountMeter } from '../ui/lie.js';
import { mountSuggest, movingBody, MOVING_PAGE } from '../ui/suggest.js';
import { mountCheckLinks } from '../ui/checklink.js';

/** How long each address of the name service may take before the box answers by itself, ms. */
const NAME_SERVICE_WAIT_MS = 2000;

/**
 * Run a job once an element comes near the window, so that nothing below the first screen is fetched before it
 * is wanted.
 * @param {Element} element
 * @param {() => void} job
 */
function whenNear(element, job) {
  if (typeof IntersectionObserver !== 'function') {
    job();
    return;
  }
  const watch = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    watch.disconnect();
    job();
  }, { rootMargin: '600px 0px' });
  watch.observe(element);
}

/**
 * The box: read what was typed here, and go straight to the view it means. A position goes to the viewer with its
 * coordinates; a name the site knows goes where the page's own link for that name goes, or to its position. Another
 * name is asked of the name service of the CDS, to which the name alone is sent. What cannot be read gets an answer
 * under the box, in plain words.
 * @param {HTMLFormElement} form
 */
function mountBox(form) {
  const input = form.querySelector('input[name="q"]'), message = form.querySelector('[data-message]');
  if (!(input instanceof HTMLInputElement) || !(message instanceof HTMLElement)) return;
  /** @type {Promise<[typeof import('../lib/names.js'), typeof import('../lib/urlstate.js'), import('../lib/names.js').NamesFile]> | undefined} */
  let ready;
  const load = () => {
    ready ??= Promise.all([import('../lib/names.js'), import('../lib/urlstate.js')]).then(async ([names, urlstate]) => {
      const r = await fetch(new URL(names.NAMES_FILE, document.baseURI));
      if (!r.ok) throw new Error('no names');
      return /** @type {[typeof names, typeof urlstate, import('../lib/names.js').NamesFile]} */ ([names, urlstate, await r.json()]);
    });
    ready.catch(() => { ready = undefined; });
    return ready;
  };
  /**
   * Say something under the box, and bring it into view: on a small screen the box stands at the foot of the first
   * screen and its answer would be below it.
   * @param {string} text  @param {{href: string, text: string}} [link]
   */
  const say = (text, link) => {
    message.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text;
      message.append(' ', a);
    }
    if (text !== '') message.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  input.addEventListener('focus', () => { load().catch(() => {}); }, { once: true });
  input.addEventListener('input', () => {
    message.textContent = '';
    input.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', (event) => {
    const text = input.value.trim();
    event.preventDefault();
    if (text === '') {
      say('Type a name or a position first, or pick one of the five targets.');
      input.focus();
      return;
    }
    // the Sun, the Moon and the planets are not shown: the answer stays here, and the comet's page is a link away
    const moving = movingBody(text);
    if (moving) {
      say(`${moving.said.charAt(0).toUpperCase()}${moving.said.slice(1)}`, { href: MOVING_PAGE, text: 'The page of the comet shows a moving object.' });
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    load().then(([names, urlstate, table]) => {
      const found = names.resolveInput(text, table);
      if (found.kind === 'none') {
        const refuse = () => {
          say(found.message);
          input.setAttribute('aria-invalid', 'true');
          input.focus();
        };
        // not a position and not a name of this site's own list: the name service of the CDS may know it. Only the
        // name is sent. When it does, the viewer takes the name; when it does not, or cannot be reached in time,
        // the answer is given here, as for anything else that cannot be read
        import('../lib/sesame.js').then(async (sesame) => {
          if (!sesame.looksLikeName(text)) return refuse();
          say(`Asking the name service of the CDS for “${text}”…`);
          const got = await sesame.resolveName(text, { timeoutMs: NAME_SERVICE_WAIT_MS });
          if (input.value.trim() !== text) return undefined; // the visitor has typed on
          if (got.ok) location.assign(urlstate.viewUrl({ q: text }));
          else refuse();
          return undefined;
        }).catch(refuse);
        return;
      }
      // a name that the page itself links to goes where that link goes
      const own = found.kind === 'name' ? document.querySelector(`a[data-target="${CSS.escape(found.entry.id)}"]`) : null;
      location.assign(own instanceof HTMLAnchorElement ? own.href : urlstate.viewUrl({ ra: Number(found.ra.toFixed(6)), dec: Number(found.dec.toFixed(6)) }));
    }, () => {
      // the reader of positions could not be loaded: hand the text to the viewer as it is
      form.submit();
    });
  });
}

const flip = document.querySelector('[data-flip]');
if (flip instanceof HTMLElement) {
  // where scripts run the plate shows one photo from the start; if it cannot come to life, the two go back side by side
  mountFlip(flip).then((live) => { if (!live) flip.classList.add('is-still'); }, () => flip.classList.add('is-still'));
}

const night = document.querySelector('[data-night]');
if (night instanceof HTMLElement) {
  whenNear(night, () => {
    mountNight(night);
    mountBars(night);
  });
}

const lie = document.querySelector('[data-lie]');
if (lie instanceof HTMLElement) {
  whenNear(lie, () => {
    mountLie(lie);
    mountMeter(lie);
  });
}

mountCheckLinks();

// the box stands twice on the page: under the headline and once more at the end
for (const box of document.querySelectorAll('[data-position]')) {
  if (!(box instanceof HTMLFormElement)) continue;
  mountBox(box);
  mountSuggest(box);
}
