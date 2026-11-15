# Fixture of the first page

Real data from SPHEREx release DR1, for the tests of the two small stages of the first page
(`tests/unit/v1-stages.test.mjs`, `tests/e2e/v1-first-screen.spec.mjs`). Not part of the recorded list of
`../checksums.json`.

## lie/

A showcase (CT-8) with photos of two detectors in one visit, which the stage of "why a plain blink lies" needs and
the foundation's showcase does not have: `manifest.json`, `stamps.bin` (float32) and `flags.bin` (int32),
little-endian, frames in the order of the manifest, first row at the lowest y.

It holds no new data. It is five stamps of Barnard's Star, 64 by 64 pixels, that are already fixtures, joined in
time order:

| Frame of the manifest | Visit | Detector | Copied from |
|---|---|---|---|
| 0 | 0 | 5 | `showcase/barnard-d5`, frame 0 |
| 1 | 0 | 5 | `showcase/barnard-d5`, frame 1 |
| 2 | 1 | 2 | `frames/barnard-d2` (`image.f32`, `flags.i32`, and the `stamp` of `frame.json`) |
| 3 | 1 | 5 | `showcase/barnard-d5`, frame 2 |
| 4 | 1 | 5 | `showcase/barnard-d5`, frame 3 |

The manifest names detector 5, and the pairs are those of `showcase/barnard-d5` under their new numbers: frames 0
with 3, and 1 with 4. A unit test compares the three files with the fixtures they were copied from, byte for byte.

The comet of the first page is tested on `showcase/barnard-d5` itself.
