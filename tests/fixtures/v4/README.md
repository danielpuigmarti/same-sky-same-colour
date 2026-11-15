# Fixtures for the targets, comet and Checks pages

`optional.json` holds made-up data in the form that the gallery job (`pipeline/jobs/gallery.py`) and the Pluto job
(`pipeline/jobs/pluto.py`) write: two stars of a gallery, three pairs of "Can you spot it?" with their answers, a
card for Pluto, the numbers and Checks rows they name, and decisions that say all of it is built.

Nothing in it was measured. The stars, the places and the numbers are invented, and none of it is shown on the
site. It exists because those parts of the targets page are shown only when their checks allow them, and the
tests have to see them in both states: `tests/unit/v4-cards.test.mjs` makes the parts from it, and
`tests/e2e/v4-pages.spec.mjs` serves a targets page made from it, with pictures of the site standing in for the
pictures it names.

The tests of the parts that are always shown use the data files of the site itself.
