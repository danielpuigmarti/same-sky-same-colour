# Test fixtures

Real data, cut small. Everything here is an excerpt of public data from NASA's SPHEREx mission, release DR1,
served by the NASA/IPAC Infrared Science Archive (IRSA) from the bucket `nasa-irsa-spherex`. The files each
fixture comes from are named below and in `REFERENCES.md`.

The fixtures were recorded on 14 November 2026. `checksums.json` holds the size and SHA-256 of every file in the
folders described here, and the unit tests compare them, so a fixture cannot change without notice. After
changing one on purpose, run `node tests/helpers/checksums.mjs --write` and say here what changed and why.
Fixtures for other tests go in a folder of their own beside these, and are not part of that list.

`tests/helpers/fixtures.mjs` reads the fixtures for a test: `loadFrame(id)`, `rangeFetch(frames)`, `readJson`,
`readFloat32`, `readInt32`.

Conventions, as everywhere in the project: pixels are 0-based with whole numbers at pixel centres; arrays go
row by row with the first row at the lowest y; binary files of expected values are little-endian; wavelengths
are in µm, images in MJy/sr, times in MJD (UTC), angles in degrees.

## frames/: the bytes a stamp needs, and the stamp

Three frames in three detectors. For each, the byte ranges that are enough to cut a 64 by 64 pixel stamp around
a sky position, and the stamp that must come out.

| Folder | Detector | Position (RA, Dec) | Taken | Frame |
|---|---|---|---|---|
| `barnard-d2` | 2 | 269.44636, 4.76706 | 15 Mar 2026 | `level2_2026W11_2A_0501_1D2_spx_l2b-v27-2026-234.fits` |
| `eps-indi-d4` | 4 | 330.84, -56.79 | 11 Nov 2025 | `level2_2025W46_1A_0287_1D4_spx_l2b-v27-2026-206.fits` |
| `eps-indi-d5` | 5 | 330.84, -56.79 | 7 Jun 2025 | `level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits` |

The first position is Barnard's Star in 2025-26. The second is in the field of Epsilon Indi; it is the position
that the first tests of the reader used, not a measured position of Epsilon Indi B. A very bright, saturated
star lies about 19 pixels from it in both stamps, which makes these stamps a good test of missing values.

Each folder holds:

- `frame.json`: what the fixture is.
  - `key`, `size`: the bucket key of the frame and the size of the whole file in bytes.
  - `target`: the sky position. `pixel`: where it falls on the detector (not rounded).
  - `stamp`: the fields of a stamp (CT-4) without the arrays: `key, det, mjd, w, h, x0, y0, tx, ty, lam, bw`.
    `x0, y0` is the full-frame pixel of the first element, `tx, ty` the target in stamp pixels, `lam, bw` the
    wavelength and bandwidth at the target's unrounded pixel, `mjd` the header's `MJD-AVG`.
  - `expected`: the names of the two files of expected values. `counts`: how many image values are not finite
    and how many flag words are not zero.
  - `hdus`: where the first three parts of the file start (`hdrLoc`) and where their data start (`datLoc`).
  - `flags_layout`: how the FLAGS image is stored. `heap` is the file offset of its compressed rows.
  - `ranges`: the recorded byte ranges, each with `start`, `end` (both included), `file` and `what`.
- `bytes-<start>-<end>.bin`: the bytes of the frame from `start` to `end`, both included. There are four:
  1. `0` to `28799`: the primary header and the IMAGE header. In detectors 4 and 5 the IMAGE header is one
     block shorter, so the last 2,880 bytes are already image data.
  2. the 64 rows of IMAGE that the stamp crosses, whole rows: 2,040 big-endian float32 values each.
  3. 39,360 bytes from the start of the FLAGS header: the header (17,280 bytes), the pointer table of all 2,040
     rows (8 bytes a row: length and offset in the heap, two big-endian int32) and the first 5,760 bytes of
     the heap.
  4. the compressed FLAGS rows of the stamp. FLAGS is a tile-compressed image: Rice coding, one row to a tile,
     blocks of 32 pixels, 4 bytes a pixel.
- `image.f32`: the expected image, 4,096 float32 values. Compare bit for bit: some values are NaN.
- `flags.i32`: the expected flag words, 4,096 int32 values.

Where the expected values come from: the whole frame was downloaded and opened with astropy. The target pixel
is `WCS(header).all_world2pix(ra, dec, 0)`, with the distortion terms. The stamp starts at
`floor(pixel + 0.5) - 32` in x and in y. The arrays are `hdul["IMAGE"].data[y0:y0+64, x0:x0+64]` and the same
cut of `hdul["FLAGS"].data`. Wavelength and bandwidth are `WCS(header, fobj=hdul, key="W")` with its `sip` set
to `None`, at the target's unrounded pixel.

How the fixture was checked: the recorded bytes, and nothing else, were decoded by a reader written
independently of astropy. For all three frames, through both addresses of the bucket, the image came out the
same bit for bit, the flags the same value for value, the target pixel within 0.00000001 pixel and the
wavelength within 0.000001 µm. Every recorded range was then fetched again from the bucket and was identical.

Good to know:

- The index gives the time of a frame rounded to a millionth of a day; `stamp.mjd` here is not rounded.
- All three stamps lie inside their frame. What a stamp is when the box crosses the edge of the detector is not
  covered by a fixture.
- Not every frame that the index lists for a position holds it. At 330.84, -56.79 the index lists
  `level2_2025W40_1A_0529_4D2_spx_l2b-v27-2026-239.fits`, and astropy puts the position at y = 2042.05, two
  and a half pixels beyond the last row.

## wave/: wavelength of a pixel

- `tables.json`: for each detector (`"1"` to `"6"`) the small table that every frame of that detector carries
  in its `WCS-WAVE` part, in the form of CT-3: `X` and `Y`, the pixel of each grid column and row as the FITS
  table stores them (counted from 1); `lam[row][column]` and `bw[row][column]`, wavelength and bandwidth in µm;
  `src`, the key of the frame the table was copied from. The grids have 9 by 9 to 13 by 20 nodes. Between
  nodes the value is linear in x and in y inside each cell.
- `reference.json`: for each detector 200 pixels with their wavelength and bandwidth: `src`, the frame they
  were computed on (another frame than the one the table was copied from); `x`, `y`, 0-based pixels;
  `lam`, `bw` in µm. The first five pixels are the four corners and the centre, the next 95 are whole pixels,
  the last 100 lie between pixels.

Where the reference values come from: astropy, `WCS(header, fobj=hdul, key="W")` with `sip = None`, then
`wcs_pix2world(x, y, 0)`.

How the fixture was checked: looking the 1,200 pixels up in the tables gives the reference wavelengths and
bandwidths within 0.000000000000002 µm. The table of a detector was identical in every frame of that detector
that was opened (ten frames, taken from June 2025 to March 2026).

## idx/: one tile of the frame index

- `meta.json`: the description of the index (CT-2), as the index converter wrote it from the part of the sky
  that had been collected when the fixture was made. It is a snapshot: `complete` names 26 finished tiles and
  `n_frames` counts 72,518 frames, not the whole release.
- `t/6_35.json.gz`: the tile that holds RA 330.84, Dec -56.79, a gzip file. Unpacked it is a JSON list of 2,537
  rows, each `[wv, obs, exp, det, t_mid_mjd, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4]`, sorted by time.
  The page unpacks it with `DecompressionStream("gzip")`.
- `expected.json`:
  - `ra`, `dec`, `tile`: the position and the name of its tile.
  - `tile_rows`, `tile_json_bytes`, `tile_json_sha256`: the unpacked tile.
  - `frames`: the 342 frames whose outline contains the position, as CT-1 frames (`key, det, tmid, corners`),
    in the order of the tile.
  - `indexed`: three positions with the answer of `isIndexed`. The tile of the fixture is not in `complete`;
    the frames at the position itself are all there.
  - `sia`: the answer of IRSA's image search for a circle of 0.0001 degrees around the position: 343 frames.
    The one frame more, named in `only_in_sia`, has an edge that passes 0.24 arcsec from the position: inside
    the circle, outside the outline. It is a row of the tile.

Where it comes from: the names, times and outlines of the frames are answers of IRSA's image search
(`https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1`), collected point by point over the sky.

How the fixture was checked: looking the position up in the tile with two independent lookups, one in
JavaScript and one in Python, gives the 342 frames, and they are the frames of IRSA's own answer apart from the
one described above.

## showcase/barnard-d5/: a showcase with two visits

A showcase in the form of CT-8: `manifest.json`, `stamps.bin` (float32) and `flags.bin` (int32), both
little-endian with the frames in the order of the manifest.

Barnard's Star in detector 5, four frames of 64 by 64 pixels: two taken on 25 Aug 2025 and two on 15 Mar 2026,
201 days later. They form two pairs at the same colour: 4.2958 with 4.2965 µm and 4.3697 with 4.3703 µm, where
the match rule allows 0.019 µm. The star is bright, so the flag words are rich: bits 0, 1, 2, 6, 11, 17, 19,
21, 26 and 28 occur.

| Frame | Visit | Taken (UTC) | Wavelength (µm) |
|---|---|---|---|
| `level2_2025W35_1A_0146_1D5_spx_l2b-v27-2026-230.fits` | 0 | 2025-08-25 17:09 | 4.2958 |
| `level2_2025W35_1A_0146_3D5_spx_l2b-v27-2026-230.fits` | 0 | 2025-08-25 17:13 | 4.3697 |
| `level2_2026W11_2A_0501_3D5_spx_l2b-v27-2026-234.fits` | 1 | 2026-03-15 00:51 | 4.2965 |
| `level2_2026W11_2A_0550_1D5_spx_l2b-v27-2026-234.fits` | 1 | 2026-03-15 07:18 | 4.3703 |

Where it comes from: the four frames were downloaded whole and cut with astropy, in the way described for
`frames/`.

How the fixture was checked: the same four stamps were read a second way, by byte range from the bucket with a
reader independent of astropy. Images and flags came out identical.

## contracts/: examples of numbers and Checks rows

`numbers.json` (CT-10) and `checks.json` (CT-9) in their final form. What they say is true: they describe the
checks of the fixtures above. No person has reviewed those checks, so the rows are `UNVERIFIED` and name no
reviewer. The tests of the contracts start from these two files and from the manifest of the showcase, and
change them step by step as `tests/vectors/contract-cases.json` says.
