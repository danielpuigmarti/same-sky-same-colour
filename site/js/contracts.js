// Shared contracts: the shapes and constants that the parts of this project hand to each other.
//
// Types are JSDoc typedefs, checked with `npm run typecheck`. To use one in another module:
//   /** @import { Stamp } from '../contracts.js' */
// The same names live in pipeline/sx/contracts.py, and tests/vectors/contracts.json lists every
// name, field and value so that both files are tested against one list.
//
// Conventions: wavelengths in µm; images in MJy/sr; angles in degrees; times as MJD (UTC);
// pixels 0-based, with whole numbers at pixel centres.

// ---------------------------------------------------------------------------------------------
// CT-1  Frame
// ---------------------------------------------------------------------------------------------

/**
 * Detector (band) number.
 * @typedef {1 | 2 | 3 | 4 | 5 | 6} Det
 */

/**
 * A sky position, [ra, dec] in degrees (ICRS).
 * @typedef {[number, number]} RaDec
 */

/**
 * CT-1. One Level 2 frame of the archive.
 * @typedef {Object} Frame
 * @property {string} key  Bucket key; see KEY_PATTERN. Its address is a BUCKET_URLS entry followed by the key.
 * @property {Det} det  Detector, 1 to 6.
 * @property {number} tmid  Mid-exposure time, MJD (UTC).
 * @property {[RaDec, RaDec, RaDec, RaDec]} corners  The four corners of the frame, [ra, dec] in degrees (ICRS).
 */

/** The two hostnames that serve the archive bucket. Request limits are counted per hostname. */
export const BUCKET_HOSTS = Object.freeze([
  'nasa-irsa-spherex.s3.us-east-1.amazonaws.com',
  's3.us-east-1.amazonaws.com',
]);

/** The two address forms of the bucket, in the order of BUCKET_HOSTS. A frame's address is one of these + its key. */
export const BUCKET_URLS = Object.freeze([
  'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
  'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
]);

/** How a bucket key is built. `obs` is written with four digits; `week` and `ver` appear twice. */
export const KEY_PATTERN = 'dr1/level2/{week}/{ver}/{det}/level2_{week}_{obs:04d}_{exp}D{det}_spx_{ver}.fits';

/** Matches a bucket key. Groups: 1 week, 2 ver, 3 det, 4 obs, 5 exp. */
export const KEY_REGEX = /^dr1\/level2\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+)\/([1-6])\/level2_\1_([0-9]{4})_([0-9])D\3_spx_\2\.fits$/;

// ---------------------------------------------------------------------------------------------
// CT-2  Frame index
// ---------------------------------------------------------------------------------------------

/**
 * CT-2. `idx/meta.json`.
 * @typedef {Object} IndexMeta
 * @property {number} T  Height of a declination band, degrees.
 * @property {number} nbands  Number of declination bands, counted from the south pole.
 * @property {number[]} nra  Number of right-ascension tiles in each band.
 * @property {string[]} wv  "week/ver" strings; the first number of a row is a position in this list.
 * @property {string[]} complete  Names of the finished tiles. Elsewhere the index is not complete yet.
 * @property {string} key  The key pattern, for the reader of the file.
 * @property {string} row  The row layout, for the reader of the file.
 * @property {number} n_frames  Number of frames in the index.
 */

/**
 * CT-2. One row of a tile, in the order of INDEX_ROW:
 * [wv, obs, exp, det, t_mid_mjd, ra1, dec1, ra2, dec2, ra3, dec3, ra4, dec4].
 * @typedef {[number, number, number, number, number, number, number, number, number, number, number, number, number]} IndexRow
 */

/**
 * CT-2. The frames whose outline contains a position. `base` is the address of the index folder.
 * @typedef {(ra: number, dec: number, base: string) => Promise<Frame[]>} FramesCovering
 */

/**
 * CT-2. Whether the tile of a position is finished.
 * @typedef {(ra: number, dec: number, base: string) => Promise<boolean>} IsIndexed
 */

/** The meaning of each number in a tile row. */
export const INDEX_ROW = Object.freeze([
  'wv', 'obs', 'exp', 'det', 't_mid_mjd', 'ra1', 'dec1', 'ra2', 'dec2', 'ra3', 'dec3', 'ra4', 'dec4',
]);

/** The index folder inside the site. */
export const INDEX_DIR = 'idx/';

/** File names inside the index folder. A tile is named "{band}_{j}" and is a gzip file holding a JSON list of rows. */
export const INDEX_META_FILE = 'meta.json';
export const INDEX_TILE_FILE = 't/{tile}.json.gz';

// ---------------------------------------------------------------------------------------------
// CT-3  Wavelength
// ---------------------------------------------------------------------------------------------

/**
 * CT-3. The WCS-WAVE grid of one detector, as it is stored in every frame of that detector.
 * Between nodes the value is interpolated linearly in x and in y (bilinear inside each cell).
 * @typedef {Object} WaveTable
 * @property {number[]} X  Pixel x of each grid column, as stored in the FITS table: 1-based. Subtract 1 for 0-based pixels.
 * @property {number[]} Y  Pixel y of each grid row, same convention.
 * @property {number[][]} lam  Wavelength in µm at each node, lam[row][column].
 * @property {number[][]} bw  Bandwidth in µm at each node, bw[row][column].
 * @property {string} src  Bucket key of the frame the table was copied from.
 */

/**
 * CT-3. `data/wave/tables.json`: the six tables under the detector numbers "1" to "6".
 * @typedef {Record<string, WaveTable>} WaveTables
 */

/**
 * CT-3. Wavelength and bandwidth, µm.
 * @typedef {Object} Wavelength
 * @property {number} lam  Wavelength, µm.
 * @property {number} bw  Bandwidth, µm.
 */

/**
 * CT-3. Wavelength at a pixel; x and y are 0-based full-frame pixel centres. The celestial distortion (SIP) terms play no part.
 * @typedef {(det: Det, x: number, y: number) => Wavelength} WavelengthAt
 */

/** Where the tables are, inside the site. */
export const WAVE_TABLES_FILE = 'data/wave/tables.json';

// ---------------------------------------------------------------------------------------------
// CT-4  Stamp
// ---------------------------------------------------------------------------------------------

/**
 * CT-4. A cut-out of one frame around the target. Stamps are never rotated or smoothed.
 * @typedef {Object} Stamp
 * @property {string} key  Bucket key of the frame.
 * @property {Det} det  Detector, 1 to 6.
 * @property {number} mjd  Mid-exposure time, MJD (UTC).
 * @property {number} w  Width in pixels.
 * @property {number} h  Height in pixels.
 * @property {number} x0  Full-frame pixel x of the first element.
 * @property {number} y0  Full-frame pixel y of the first element.
 * @property {number} tx  The target's x in stamp pixels (not rounded).
 * @property {number} ty  The target's y in stamp pixels (not rounded).
 * @property {number} lam  Wavelength at the target pixel, µm.
 * @property {number} bw  Bandwidth at the target pixel, µm.
 * @property {Float32Array} data  w*h values in MJy/sr, row by row, first row at the lowest y (FITS order).
 * @property {Int32Array | null} flags  w*h flag words in the same order, or null.
 * @property {LocalSky | null} [sky]  Where the target pixel is on the sky and what one pixel step does; null or absent when not known.
 */

/**
 * CT-4. The flat approximation of the sky around a stamp's target pixel, on the plane that touches the sky there.
 * One pixel to the right moves cd[0] degrees east and cd[2] north; one pixel up moves cd[1] east and cd[3] north.
 * @typedef {Object} LocalSky
 * @property {number} ra  Degrees (ICRS), at the target pixel.
 * @property {number} dec  Degrees (ICRS), at the target pixel.
 * @property {[number, number, number, number]} cd  [east per x, east per y, north per x, north per y], degrees per pixel.
 */

// ---------------------------------------------------------------------------------------------
// CT-5  Visits
// ---------------------------------------------------------------------------------------------

/**
 * CT-5. A group of frames taken close together in time.
 * @typedef {Object} Visit
 * @property {Frame[]} frames  The frames of the visit, sorted by tmid.
 * @property {boolean} short  True when the visit has fewer than VISIT_MIN_FRAMES frames in the detector.
 */

/**
 * CT-5. Sort by tmid; a gap over VISIT_GAP_DAYS starts a visit; a run over VISIT_RUN_DAYS is cut into
 * VISIT_BIN_DAYS bins from its first frame. Default pair: the two deepest visits farthest apart.
 * @typedef {(frames: Frame[]) => Visit[]} Visits
 */

export const VISIT_GAP_DAYS = 10;
export const VISIT_RUN_DAYS = 60;
export const VISIT_BIN_DAYS = 30;
export const VISIT_MIN_FRAMES = 3;

// ---------------------------------------------------------------------------------------------
// CT-6  Match
// ---------------------------------------------------------------------------------------------

/**
 * CT-6. What the match rule reads from a frame: its detector, and the wavelength and bandwidth at the target pixel.
 * @typedef {Object} Matchable
 * @property {Det} det  Detector, 1 to 6.
 * @property {number} lam  Wavelength at the target pixel, µm.
 * @property {number} bw  Bandwidth at the target pixel, µm.
 */

/**
 * CT-6. A matched pair, as two positions in a list: for matchPairs, [position in a, position in b];
 * in a showcase manifest, two positions in `frames`, the earlier visit first.
 * @typedef {[number, number]} Pair
 */

/**
 * CT-6. Same detector; candidate pairs sorted by wavelength difference at the target pixel; greedy one-to-one;
 * accepted within MATCH_BANDWIDTH_FRACTION of the smaller local bandwidth; the MATCH_MAX_PAIRS closest kept.
 * A pixel is "matched" if it is within tolerance in every pair; the rest are veiled.
 * @typedef {(a: Matchable[], b: Matchable[]) => Pair[]} MatchPairs
 */

export const MATCH_BANDWIDTH_FRACTION = 0.5;
export const MATCH_MAX_PAIRS = 8;

// ---------------------------------------------------------------------------------------------
// CT-7  Background and noise
// ---------------------------------------------------------------------------------------------

/** Each stamp: subtract its sigma-clipped median, CLIP_SIGMA sigma and CLIP_PASSES passes. */
export const CLIP_SIGMA = 3;
export const CLIP_PASSES = 5;

/** Noise = MAD_TO_SIGMA times the median absolute deviation after the subtraction. */
export const MAD_TO_SIGMA = 1.4826;

/** Differences are shown in noise units on a fixed scale from -DIFF_RANGE to +DIFF_RANGE. */
export const DIFF_RANGE = 5;

// ---------------------------------------------------------------------------------------------
// CT-8  Showcase
// ---------------------------------------------------------------------------------------------

/**
 * CT-8. One frame of a showcase; the fields have the meaning they have in a Stamp.
 * @typedef {Object} ShowcaseFrame
 * @property {string} key  Bucket key of the frame.
 * @property {number} mjd  Mid-exposure time, MJD (UTC).
 * @property {number} lam  Wavelength at the target pixel, µm.
 * @property {number} bw  Bandwidth at the target pixel, µm.
 * @property {number} x0  Full-frame pixel x of the first element.
 * @property {number} y0  Full-frame pixel y of the first element.
 * @property {number} tx  The target's x in stamp pixels.
 * @property {number} ty  The target's y in stamp pixels.
 * @property {number} visit  The visit the frame belongs to: 0 for the earliest, counting up in time.
 * @property {LocalSky} [sky]  The sky around the target pixel of this frame's stamp as written (see Stamp).
 */

/**
 * CT-8. `data/<group>/<id>/manifest.json`. The binary files sit beside it: little-endian, frames in order,
 * each frame w*h values row by row with the first row at the lowest y; float32 for stamps, int32 for flags.
 * @typedef {Object} Manifest
 * @property {string} id  Folder name of the showcase.
 * @property {string} name  Name shown to the visitor.
 * @property {number} ra  Degrees (ICRS).
 * @property {number} dec  Degrees (ICRS).
 * @property {Det} det  Detector, 1 to 6.
 * @property {number} w  Stamp width in pixels.
 * @property {number} h  Stamp height in pixels.
 * @property {ShowcaseFrame[]} frames  The frames, sorted by mjd.
 * @property {Pair[]} pairs  Matched pairs, as positions in `frames`.
 * @property {'stamps.bin'} stamps  File of the image values.
 * @property {'flags.bin' | null} flags  File of the flag words, or null when there is none.
 * @property {string[]} refs  Sources for what the showcase shows.
 * @property {string[]} numbers  Keys of numbers.json that belong to the showcase.
 * @property {'detector' | 'north-up'} [grid]  What the stamps are drawn on: "detector" (the default when absent) is the
 *   detector's own pixels; "north-up" is the display grid: north up, east to the left, 6.15 arcsec per pixel, centred
 *   on the target, nearest neighbour, so that every frame of the showcase lines up. Each frame then carries `sky`,
 *   has tx = w / 2 and ty = h / 2 (whole numbers, the target's pixel), and keeps the x0 and y0 of the stamp it was made from.
 */

export const MANIFEST_FILE = 'manifest.json';
export const STAMPS_FILE = 'stamps.bin';
export const FLAGS_FILE = 'flags.bin';

// ---------------------------------------------------------------------------------------------
// CT-9  Checks
// ---------------------------------------------------------------------------------------------

/**
 * CT-9. The result of a check.
 * @typedef {'PASS' | 'FAIL' | 'LIMIT' | 'CORRECTED' | 'UNVERIFIED'} CheckStatus
 */

/**
 * CT-9. One row of `data/checks/checks.json`, which is a list of rows.
 * @typedef {Object} CheckRow
 * @property {string} id  Unique name of the check.
 * @property {string} title  Short title.
 * @property {string} claim  What is claimed.
 * @property {string} test  How it was tested.
 * @property {string} pass_rule  The rule that decides the status, written before the test was run.
 * @property {string | null} rule_commit  Commit in which the rule was written.
 * @property {CheckStatus} status  PASS, FAIL, LIMIT, CORRECTED or UNVERIFIED.
 * @property {string} plain  The plain-word tag shown in the story.
 * @property {number | string | null} value  What was measured.
 * @property {string | null} unit  Unit of value, reference and tolerance.
 * @property {number | string | null} reference  What it is compared with.
 * @property {number | string | null} tolerance  How far value may be from reference.
 * @property {string | null} image  Picture of the check, a path inside data/checks/.
 * @property {string | null} image_sha256  SHA-256 of that picture, in hex.
 * @property {string | null} reviewer_role  Role of the person who reviewed the check. A PASS row needs one.
 * @property {string | null} reviewed_on  Date of the review, YYYY-MM-DD. A PASS row needs one.
 * @property {string | null} rerun  Command that runs the check again.
 */

export const CHECK_STATUSES = Object.freeze(['PASS', 'FAIL', 'LIMIT', 'CORRECTED', 'UNVERIFIED']);

/** The merged file, and the folder of the files it is merged from (one per producer). */
export const CHECKS_FILE = 'data/checks/checks.json';
export const CHECKS_PARTS_DIR = 'data/checks/rows/';

// ---------------------------------------------------------------------------------------------
// CT-10  Numbers
// ---------------------------------------------------------------------------------------------

/**
 * CT-10. One number. Pages carry numbers only as <span data-n="key">, filled with `text`.
 * @typedef {Object} NumberEntry
 * @property {number} value  The number.
 * @property {number | null} err  Its uncertainty, or null.
 * @property {string | null} unit  Its unit, or null.
 * @property {string} text  The number as the page shows it.
 * @property {string | null} check  The id of the Checks row behind it, or null.
 */

/**
 * CT-10. `data/numbers.json`: numbers by key.
 * @typedef {Record<string, NumberEntry>} Numbers
 */

/** The merged file, and the folder of the files it is merged from (one per producer). */
export const NUMBERS_FILE = 'data/numbers.json';
export const NUMBERS_PARTS_DIR = 'data/numbers/';

// ---------------------------------------------------------------------------------------------
// CT-11  Address of a view
// ---------------------------------------------------------------------------------------------

/**
 * CT-11. How the stage shows two visits.
 * @typedef {'blink' | 'diff' | 'curtain' | 'side' | 'flip'} ViewMode
 */

/**
 * CT-11. view.html?ra=&dec=&det=&mode=&a=&b=&fov=&t=&embed=1&pitch=1&q=. Every part may be absent.
 * @typedef {Object} ViewAddress
 * @property {number} [ra]  Degrees.
 * @property {number} [dec]  Degrees.
 * @property {Det} [det]  Detector, 1 to 6.
 * @property {ViewMode} [mode]  blink, diff, curtain, side or flip.
 * @property {string} [a]  The first of the two sides compared, as written in the address.
 * @property {string} [b]  The second of the two sides compared, as written in the address.
 * @property {number} [fov]  Field of view, degrees.
 * @property {string} [t]  A target id.
 * @property {boolean} [embed]  True for embed=1.
 * @property {boolean} [pitch]  True for pitch=1.
 * @property {string} [q]  What was typed in the box, as written.
 */

export const VIEW_PAGE = 'view.html';
export const VIEW_PARAMS = Object.freeze(['ra', 'dec', 'det', 'mode', 'a', 'b', 'fov', 't', 'embed', 'pitch', 'q']);
export const VIEW_MODES = Object.freeze(['blink', 'diff', 'curtain', 'side', 'flip']);

// ---------------------------------------------------------------------------------------------
// CT-12  Worker client
// ---------------------------------------------------------------------------------------------

/**
 * CT-12. A failure is a state, never an exception. `cancelled` is what a call gives when the page withdrew it.
 * @typedef {'no-coverage' | 'one-visit' | 'not-indexed' | 'slow' | 'unreachable' | 'too-bright' | 'too-faint' | 'quiet' | 'cancelled'} FailureState
 */

/**
 * CT-12. What a call gives back in place of its result when it fails.
 * @typedef {Object} Failure
 * @property {FailureState} state  Which failure.
 */

/**
 * CT-12. What `client.plan` gives: what would be loaded, and what it costs.
 * @typedef {Object} Plan
 * @property {Visit[]} visits  The visits at the position, in the detector.
 * @property {[Frame, Frame][]} pairs  The matched pairs that would be loaded.
 * @property {number} bytes  Bytes to download.
 * @property {number} seconds  Expected time to download them.
 */

/**
 * CT-12. Called while stamps load.
 * @typedef {(progress: unknown) => void} OnProgress
 */

/**
 * CT-12. The page's side of the worker.
 * @typedef {Object} Client
 * @property {(ra: number, dec: number, det: Det) => Promise<Plan | Failure>} plan  Look up, group and match; download nothing but headers.
 * @property {(plan: Plan, onProgress?: OnProgress) => Promise<Stamp[] | Failure>} load  Download and decode the stamps of a plan.
 */

export const FAILURE_STATES = Object.freeze([
  'no-coverage', 'one-visit', 'not-indexed', 'slow', 'unreachable', 'too-bright', 'too-faint', 'quiet', 'cancelled',
]);
