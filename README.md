# Same Sky, Same Colour

A web page that shows the same patch of sky as NASA's SPHEREx telescope saw it months apart, and blinks
between the two views. It only ever compares photos taken at the same infrared colour.

That last part is the point. SPHEREx looks through filters whose colour changes across each detector, so the
colour at which a star is recorded depends on where it happens to fall. Two photos of the same star are
usually taken at two different colours, and blinking them shows a change that is not a change in the sky.
This tool finds the photos of a position that were taken at the same colour, and blinks only those.

- **Challenge:** 2026 NASA Space Apps Challenge, "Planet X and SPHEREx".
- **Team:** two students of applied physics at TU/e, Eindhoven.
- **Live site:** https://danielpuigmarti.github.io/same-sky-same-colour/
- **Licence:** Apache-2.0, see [LICENSE](LICENSE).
- **Sources:** every dataset, library and tool is listed with its licence in [REFERENCES.md](REFERENCES.md).

The images come from the public archive of the SPHEREx mission at the NASA/IPAC Infrared Science Archive.
The page reads them straight from the archive, a few rows at a time.

## What is in the repository

```
site/         the web site, served as it is: no build step, no framework, no script or font from another host
  *.html      the six pages (bulletin, viewer, comet, targets, checks, why), and 404.html
  css/        tokens.css (colours, sizes, spacing, the two editions), base.css, components.css (shared
              classes, listed at its top), pages.css, and one file for each part: stage, live, panels (the
              viewer), cards (targets, comet, checks), suggest (the search box)
  fonts/      Archivo and Courier Prime, with their licences (SIL Open Font License 1.1)
  js/         contracts.js: the shapes and constants every part of the code shares; pages/ (one script per
              page), ui/ (the parts of a page), lib/ (reading, aligning and matching photos, with no page)
  data/       what the pages read: numbers, checks, wavelength tables, the names the search box knows
  idx/        the index of photos the viewer searches
pipeline/     Python that prepares data for the site (astropy); writes only under site/data/ and site/idx/
tests/        unit tests, browser tests, shared test vectors, and fixtures cut from real frames
tools/        gate.mjs (consistency), serve.mjs (development server), contracts.mjs and schema.mjs (contract
              checks), render-content.mjs (fills the texts of content/), review.mjs (the list of reviews),
              timing.mjs (times the viewer against the real archive), demo.mjs (records the demo video),
              preview.mjs (draws site/img/preview.png, the picture shown when a link is shared)
content/      the texts of the project page and the pitch, with {{keys}} for numbers; filled into content/out/
review/       one sheet for each review a person does, and README.md, the list of them
references/   the sources, one file per part of the project; REFERENCES.md is put together from them
```

The site has two editions that share every rule: the night edition (black paper, yellow ink) is the default,
and the day edition (pale paper, black ink) is one press of the button at the top right; the choice is kept
in the browser. A photo or a drawing made of data stays black in both.

## Run the site on your computer

You need [Node.js](https://nodejs.org/) 22 or newer.

```
npm ci
npm run serve
```

Then open http://127.0.0.1:8080/. `npm run serve -- --port 9000` uses another port.

## Run the tests

```
npm test
```

runs three things: the unit tests (`node --test`), the type check of `site/js` (`tsc --noEmit`, the types are
written as JSDoc), and the consistency gate in its checking mode (`node tools/gate.mjs --check`).

The browser tests open every page in Chromium:

```
npx playwright install chromium     # once
npm run test:e2e
```

The pipeline has its own environment and tests. With Python 3.11 or newer:

```
python -m venv pipeline/.venv
pipeline/.venv/Scripts/python -m pip install -r pipeline/requirements.txt     # Windows
pipeline/.venv/bin/python -m pip install -r pipeline/requirements.txt         # Linux, macOS
cd pipeline
.venv/Scripts/python -m pytest        # or .venv/bin/python -m pytest
```

## Development

### Numbers, checks and the gate

No number is typed into a page. A page holds `<span data-n="some.key"></span>`, and the gate fills the span
from the data. The name of the site works the same way: it is written once, in `site/data/site.json`, and
elements marked `data-site="name"` and the `<title data-page="...">` of each page are filled from it.

Numbers and the rows of the Checks page are written in parts, one file for each part of the project that
produces them, so that two parts never write the same file:

- `site/data/numbers/<name>.json`: an object of numbers, `{"key": {"value", "err", "unit", "text", "check"}}`
- `site/data/checks/rows/<name>.json`: a list of rows

```
npm run gate          # merge the parts, fill the pages, rebuild REFERENCES.md
npm run gate:check    # write nothing; fail if anything on disk differs from what a run would write
```

`npm run gate` merges the parts into `site/data/numbers.json` and `site/data/checks/checks.json`, fills the
pages and writes `REFERENCES.md`. It fails when a key or a row id is defined twice, when a page asks for a key
that does not exist, when a number names a check that does not exist, or when a row says PASS without the role
of a reviewer and the date of the review. The merged files and `REFERENCES.md` are never edited by hand. Run
`npm run gate` after changing a part or a page, and commit what it wrote; `npm test` fails until you do.

### References

Anything new that is used (a dataset, a library, a tool, an image, a text) is added at once to
`references/<name>.md`, the file of the part of the project that uses it. A file holds headings and entries:

```
## Libraries

- Name | https://address | licence | what it is used for
```

The headings are fixed: `Datasets`, `Libraries`, `Tools and services`, `Images and fonts`, `Text sources`.
The gate joins all files into `REFERENCES.md`. The same address may appear in two files if name and licence
agree.

### A new data release

The index of photos (`site/idx/`) is rebuilt from the archive's public bucket by one command, run from `pipeline/`
with `pipeline/.venv`. It lists the weeks in the bucket and reads the header of each photo with one range request
(at most six at a time, each tried again after a pause); photos the index already holds are not read again.

```
python -m sx.run index                              # say what the site's index holds and how to extend it
python -m sx.run index --week 2026W20_1A            # the photos of one week
python -m sx.run index --since 2026W20_1A           # every week after that one
python -m sx.run index --all                        # every week of the release
python -m sx.run index --since 2026W20_1A --into ../site/idx    # add to the site's index
python -m sx.run index --week 2025W46_1A --check    # rebuild one week, compare with the site's index
```

Without `--into` the index is written to `pipeline/out/idx/`, never to `site/idx/`. With `--into` the rows are
merged into the index in that folder: rows it holds are never changed, and running the same command twice
changes nothing. A week goes in whole or not at all; if the archive stops answering the command ends with 1,
keeps what it read, and the same command run again asks only for the rest.

Reading headers took 37 s for a thousand photos (measured on week 2025W46_1A, 9,169 photos, 340 s); a week of
about 10,000 photos takes six minutes, and the whole release of 1.18 million photos about twelve hours.
After it runs: run `--check` on one week; `python -m sx.run index` should say the new count and weeks;
run `npm run gate` and `npm test`; and read the new weeks on the viewer for a position they cover.

### Shared files

Four things belong to the foundation of the project and are shared by all of it: `package.json`,
`jsconfig.json`, the workflows in `.github/workflows/` and `site/css/tokens.css`. Work on one part of the
project does not edit them; a change to them is agreed first and made on its own.

The contracts are shared in the same way: `site/js/contracts.js`, `pipeline/sx/contracts.py`, the schemas in
`tests/vectors/schema/` and the list in `tests/vectors/contracts.json` change together or not at all, and the
tests fail if they disagree.

### Fixtures

`tests/fixtures/` holds small excerpts of real frames with the values that must come out of them. What each
one is, where it came from and how it was checked is in [tests/fixtures/README.md](tests/fixtures/README.md).

### Publishing

The site is published from `site/` by the workflow in `.github/workflows/deploy.yml`, after the same checks
as `npm test`. In the settings of the repository, the source of Pages has to be set to "GitHub Actions" once.
