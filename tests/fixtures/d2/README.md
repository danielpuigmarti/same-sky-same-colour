# Fixtures of the rules

Real data from SPHEREx release DR1, cut small, for the tests of the co-add, the difference and the alignment.
Not part of the recorded list of `../checksums.json`.

## empty/

Six stamps of 64 by 64 pixels, detector 2, around RA 180.0036, Dec -0.0015 (an empty field on the ecliptic):
`manifest.json` (key, time, colour, position of the stamp on the detector and of the target in it, visit),
`stamps.bin` (float32) and `flags.bin` (int32), little-endian, frames in the order of the manifest, first row at
the lowest y. Visit 0 is three photos of May 2025, visit 1 three of December 2025; the photo at position i of one
and at position i of the other are at the same colour (within 0.7 per cent). The two visits point 180 degrees apart.
Cut from 96 by 96 pixel boxes read by byte range from the bucket (IMAGE and FLAGS), centre 64 by 64.

## align/

`shifted.bin`: 20 float32 images of 64 by 64, made from the stamps `frames/barnard-d2`, `frames/eps-indi-d5` and
`showcase/barnard-d5` frames 0, 2 and 3, each with its background removed and shifted by one of four known amounts
(`shifted.json`: source, dx, dy in pixels) with scipy's cubic spline; pixels that were flagged are NaN. Made by
`pipeline/tests/test_d2_vectors.py --write`, and a test makes them again to compare.
