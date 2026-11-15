"""Shared contracts: the shapes and constants that the parts of this project hand to each other.

The same names live in site/js/contracts.js, and tests/vectors/contracts.json lists every name, field and
value so that both files are tested against one list.

Conventions: wavelengths in µm; images in MJy/sr; angles in degrees; times as MJD (UTC); pixels 0-based,
with whole numbers at pixel centres.

The second half of the file checks the three JSON contracts (numbers.json, checks.json, a showcase
manifest) against the schemas in tests/vectors/schema/. tools/contracts.mjs holds the same checks in
JavaScript; both are run on the cases in tests/vectors/contract-cases.json.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Literal, NotRequired, Optional, TypedDict, Union

if TYPE_CHECKING:
    import numpy as np

# ---------------------------------------------------------------------------------------------
# CT-1  Frame
# ---------------------------------------------------------------------------------------------

Det = Literal[1, 2, 3, 4, 5, 6]
"""Detector (band) number."""

RaDec = tuple[float, float]
"""A sky position, (ra, dec) in degrees (ICRS)."""


class Frame(TypedDict):
    """CT-1. One Level 2 frame of the archive."""

    key: str  # bucket key; see KEY_PATTERN
    det: Det  # detector, 1 to 6
    tmid: float  # mid-exposure time, MJD (UTC)
    corners: list[RaDec]  # the four corners of the frame, (ra, dec) in degrees (ICRS)


BUCKET_HOSTS = (
    "nasa-irsa-spherex.s3.us-east-1.amazonaws.com",
    "s3.us-east-1.amazonaws.com",
)
"""The two hostnames that serve the archive bucket."""

BUCKET_URLS = (
    "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/",
    "https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/",
)
"""The two address forms of the bucket, in the order of BUCKET_HOSTS. A frame's address is one of these + its key."""

KEY_PATTERN = "dr1/level2/{week}/{ver}/{det}/level2_{week}_{obs:04d}_{exp}D{det}_spx_{ver}.fits"
"""How a bucket key is built; usable with str.format. `week` and `ver` appear twice."""

KEY_REGEX = re.compile(
    r"^dr1\/level2\/([A-Za-z0-9_]+)\/([A-Za-z0-9_.-]+)\/([1-6])\/level2_\1_([0-9]{4})_([0-9])D\3_spx_\2\.fits$"
)
"""Matches a bucket key; use KEY_REGEX.fullmatch(key). Groups: 1 week, 2 ver, 3 det, 4 obs, 5 exp."""

# ---------------------------------------------------------------------------------------------
# CT-2  Frame index
# ---------------------------------------------------------------------------------------------


class IndexMeta(TypedDict):
    """CT-2. `idx/meta.json`."""

    T: float  # height of a declination band, degrees
    nbands: int  # number of declination bands, counted from the south pole
    nra: list[int]  # number of right-ascension tiles in each band
    wv: list[str]  # "week/ver" strings; the first number of a row is a position in this list
    complete: list[str]  # names of the finished tiles
    key: str  # the key pattern, for the reader of the file
    row: str  # the row layout, for the reader of the file
    n_frames: int  # number of frames in the index


IndexRow = tuple[float, float, float, float, float, float, float, float, float, float, float, float, float]
"""CT-2. One row of a tile, in the order of INDEX_ROW."""

FramesCovering = Callable[[float, float, str], list[Frame]]
"""CT-2. The frames whose outline contains a position: (ra, dec, base)."""

IsIndexed = Callable[[float, float, str], bool]
"""CT-2. Whether the tile of a position is finished: (ra, dec, base)."""

INDEX_ROW = ("wv", "obs", "exp", "det", "t_mid_mjd", "ra1", "dec1", "ra2", "dec2", "ra3", "dec3", "ra4", "dec4")
"""The meaning of each number in a tile row."""

INDEX_DIR = "idx/"
INDEX_META_FILE = "meta.json"
INDEX_TILE_FILE = "t/{tile}.json.gz"
"""File names inside the index folder. A tile is named "{band}_{j}" and is a gzip file holding a JSON list of rows."""

# ---------------------------------------------------------------------------------------------
# CT-3  Wavelength
# ---------------------------------------------------------------------------------------------


class WaveTable(TypedDict):
    """CT-3. The WCS-WAVE grid of one detector. Between nodes the value is bilinear inside each cell."""

    X: list[float]  # pixel x of each grid column as stored in the FITS table: 1-based; subtract 1 for 0-based pixels
    Y: list[float]  # pixel y of each grid row, same convention
    lam: list[list[float]]  # wavelength in µm at each node, lam[row][column]
    bw: list[list[float]]  # bandwidth in µm at each node, bw[row][column]
    src: str  # bucket key of the frame the table was copied from


WaveTables = dict[str, WaveTable]
"""CT-3. `data/wave/tables.json`: the six tables under the detector numbers "1" to "6"."""


class Wavelength(TypedDict):
    """CT-3. Wavelength and bandwidth, µm."""

    lam: float
    bw: float


WavelengthAt = Callable[[int, float, float], Wavelength]
"""CT-3. Wavelength at a pixel: (det, x, y); x and y are 0-based full-frame pixel centres. SIP terms play no part."""

WAVE_TABLES_FILE = "data/wave/tables.json"

# ---------------------------------------------------------------------------------------------
# CT-4  Stamp
# ---------------------------------------------------------------------------------------------


class LocalSky(TypedDict):
    """CT-4. The flat approximation of the sky around a stamp's target pixel, on the plane that touches the sky
    there: one pixel to the right moves cd[0] degrees east and cd[2] north; one pixel up moves cd[1] east and
    cd[3] north."""

    ra: float  # degrees (ICRS), at the target pixel
    dec: float  # degrees (ICRS), at the target pixel
    cd: list[float]  # [east per x, east per y, north per x, north per y], degrees per pixel


@dataclass
class Stamp:
    """CT-4. A cut-out of one frame around the target. Stamps are never rotated or smoothed."""

    key: str  # bucket key of the frame
    det: int  # detector, 1 to 6
    mjd: float  # mid-exposure time, MJD (UTC)
    w: int  # width in pixels
    h: int  # height in pixels
    x0: int  # full-frame pixel x of the first element
    y0: int  # full-frame pixel y of the first element
    tx: float  # the target's x in stamp pixels (not rounded)
    ty: float  # the target's y in stamp pixels (not rounded)
    lam: float  # wavelength at the target pixel, µm
    bw: float  # bandwidth at the target pixel, µm
    data: "np.ndarray"  # float32, shape (h, w), MJy/sr, first row at the lowest y (FITS order)
    flags: Optional["np.ndarray"]  # int32, shape (h, w), or None
    sky: Optional[LocalSky] = None  # the sky around the target pixel; None when not known


# ---------------------------------------------------------------------------------------------
# CT-5  Visits
# ---------------------------------------------------------------------------------------------


class Visit(TypedDict):
    """CT-5. A group of frames taken close together in time."""

    frames: list[Frame]  # the frames of the visit, sorted by tmid
    short: bool  # True when the visit has fewer than VISIT_MIN_FRAMES frames in the detector


Visits = Callable[[list[Frame]], list[Visit]]
"""CT-5. Sort by tmid; a gap over VISIT_GAP_DAYS starts a visit; a run over VISIT_RUN_DAYS is cut into
VISIT_BIN_DAYS bins from its first frame. Default pair: the two deepest visits farthest apart."""

VISIT_GAP_DAYS = 10
VISIT_RUN_DAYS = 60
VISIT_BIN_DAYS = 30
VISIT_MIN_FRAMES = 3

# ---------------------------------------------------------------------------------------------
# CT-6  Match
# ---------------------------------------------------------------------------------------------


class Matchable(TypedDict):
    """CT-6. What the match rule reads from a frame."""

    det: Det  # detector, 1 to 6
    lam: float  # wavelength at the target pixel, µm
    bw: float  # bandwidth at the target pixel, µm


Pair = tuple[int, int]
"""CT-6. A matched pair, as two positions in a list: for match_pairs, (position in a, position in b);
in a showcase manifest, two positions in `frames`, the earlier visit first."""

MatchPairs = Callable[[list[Matchable], list[Matchable]], list[Pair]]
"""CT-6. Same detector; candidate pairs sorted by wavelength difference at the target pixel; greedy one-to-one;
accepted within MATCH_BANDWIDTH_FRACTION of the smaller local bandwidth; the MATCH_MAX_PAIRS closest kept."""

MATCH_BANDWIDTH_FRACTION = 0.5
MATCH_MAX_PAIRS = 8

# ---------------------------------------------------------------------------------------------
# CT-7  Background and noise
# ---------------------------------------------------------------------------------------------

CLIP_SIGMA = 3
CLIP_PASSES = 5
"""Each stamp: subtract its sigma-clipped median, CLIP_SIGMA sigma and CLIP_PASSES passes."""

MAD_TO_SIGMA = 1.4826
"""Noise = MAD_TO_SIGMA times the median absolute deviation after the subtraction."""

DIFF_RANGE = 5
"""Differences are shown in noise units on a fixed scale from -DIFF_RANGE to +DIFF_RANGE."""

# ---------------------------------------------------------------------------------------------
# CT-8  Showcase
# ---------------------------------------------------------------------------------------------


class ShowcaseFrame(TypedDict):
    """CT-8. One frame of a showcase; the fields have the meaning they have in a Stamp."""

    key: str
    mjd: float
    lam: float
    bw: float
    x0: int
    y0: int
    tx: float
    ty: float
    visit: int  # 0 for the earliest visit, counting up in time
    sky: NotRequired[LocalSky]  # the sky around the target pixel of this frame's stamp as written


class Manifest(TypedDict):
    """CT-8. `data/<group>/<id>/manifest.json`. The binary files sit beside it: little-endian, frames in order,
    each frame w*h values row by row with the first row at the lowest y; float32 for stamps, int32 for flags."""

    id: str  # folder name of the showcase
    name: str  # name shown to the visitor
    ra: float  # degrees (ICRS)
    dec: float  # degrees (ICRS)
    det: Det
    w: int
    h: int
    frames: list[ShowcaseFrame]  # sorted by mjd
    pairs: list[Pair]  # matched pairs, as positions in `frames`
    stamps: Literal["stamps.bin"]
    flags: Optional[Literal["flags.bin"]]
    refs: list[str]  # sources for what the showcase shows
    numbers: list[str]  # keys of numbers.json that belong to the showcase
    grid: NotRequired[Literal["detector", "north-up"]]  # "detector" when absent; "north-up" is the display grid:
    # north up, east to the left, 6.15 arcsec per pixel, centred on the target, nearest neighbour; each frame has `sky`,
    # tx = w / 2, ty = h / 2, and the x0, y0 of the stamp it was made from


MANIFEST_FILE = "manifest.json"
STAMPS_FILE = "stamps.bin"
FLAGS_FILE = "flags.bin"

# ---------------------------------------------------------------------------------------------
# CT-9  Checks
# ---------------------------------------------------------------------------------------------

CheckStatus = Literal["PASS", "FAIL", "LIMIT", "CORRECTED", "UNVERIFIED"]


class CheckRow(TypedDict):
    """CT-9. One row of `data/checks/checks.json`, which is a list of rows."""

    id: str
    title: str
    claim: str
    test: str
    pass_rule: str  # the rule that decides the status, written before the test was run
    rule_commit: Optional[str]  # commit in which the rule was written
    status: CheckStatus
    plain: str  # the plain-word tag shown in the story
    value: Union[float, str, None]
    unit: Optional[str]
    reference: Union[float, str, None]
    tolerance: Union[float, str, None]
    image: Optional[str]  # a path inside data/checks/
    image_sha256: Optional[str]
    reviewer_role: Optional[str]  # a PASS row needs one
    reviewed_on: Optional[str]  # YYYY-MM-DD; a PASS row needs one
    rerun: Optional[str]  # command that runs the check again


CHECK_STATUSES = ("PASS", "FAIL", "LIMIT", "CORRECTED", "UNVERIFIED")

CHECKS_FILE = "data/checks/checks.json"
CHECKS_PARTS_DIR = "data/checks/rows/"
"""The merged file, and the folder of the files it is merged from (one per producer)."""

# ---------------------------------------------------------------------------------------------
# CT-10  Numbers
# ---------------------------------------------------------------------------------------------


class NumberEntry(TypedDict):
    """CT-10. One number. Pages carry numbers only as <span data-n="key">, filled with `text`."""

    value: float
    err: Optional[float]
    unit: Optional[str]
    text: str  # the number as the page shows it
    check: Optional[str]  # the id of the Checks row behind it


Numbers = dict[str, NumberEntry]
"""CT-10. `data/numbers.json`: numbers by key."""

NUMBERS_FILE = "data/numbers.json"
NUMBERS_PARTS_DIR = "data/numbers/"
"""The merged file, and the folder of the files it is merged from (one per producer)."""

# ---------------------------------------------------------------------------------------------
# CT-11  Address of a view
# ---------------------------------------------------------------------------------------------

ViewMode = Literal["blink", "diff", "curtain", "side", "flip"]


class ViewAddress(TypedDict, total=False):
    """CT-11. view.html?ra=&dec=&det=&mode=&a=&b=&fov=&t=&embed=1&pitch=1&q=. Every part may be absent."""

    ra: float  # degrees
    dec: float  # degrees
    det: Det
    mode: ViewMode
    a: str  # the first of the two sides compared, as written in the address
    b: str  # the second of the two sides compared, as written in the address
    fov: float  # field of view, degrees
    t: str  # a target id
    embed: bool  # True for embed=1
    pitch: bool  # True for pitch=1
    q: str  # what was typed in the box, as written


VIEW_PAGE = "view.html"
VIEW_PARAMS = ("ra", "dec", "det", "mode", "a", "b", "fov", "t", "embed", "pitch", "q")
VIEW_MODES = ("blink", "diff", "curtain", "side", "flip")

# ---------------------------------------------------------------------------------------------
# CT-12  Worker client (the page's side; listed here so that both files hold the same names)
# ---------------------------------------------------------------------------------------------

FailureState = Literal[
    "no-coverage", "one-visit", "not-indexed", "slow", "unreachable", "too-bright", "too-faint", "quiet", "cancelled"
]


class Failure(TypedDict):
    """CT-12. What a call gives back in place of its result when it fails."""

    state: FailureState


class Plan(TypedDict):
    """CT-12. What `client.plan` gives: what would be loaded, and what it costs."""

    visits: list[Visit]
    pairs: list[tuple[Frame, Frame]]
    bytes: int
    seconds: float


OnProgress = Callable[[Any], None]


class Client(TypedDict):
    """CT-12. The page's side of the worker."""

    plan: Callable[[float, float, int], Union[Plan, Failure]]
    load: Callable[..., Union[list[Stamp], Failure]]


FAILURE_STATES = (
    "no-coverage", "one-visit", "not-indexed", "slow", "unreachable", "too-bright", "too-faint", "quiet", "cancelled",
)

# ---------------------------------------------------------------------------------------------
# Checks for the three JSON contracts
# ---------------------------------------------------------------------------------------------

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "tests" / "vectors" / "schema"

_NOTES = {"$schema", "$id", "$defs", "$comment", "title", "description"}
_KEYWORDS = {
    "$ref", "type", "enum", "const",
    "properties", "required", "additionalProperties", "propertyNames",
    "items", "minItems", "maxItems",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "pattern",
}


def load_schema(name: str) -> dict:
    """One of the schemas: "numbers", "checks" or "manifest"."""
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))


def _type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number" if math.isfinite(v) else "not-finite"
    if isinstance(v, str):
        return "string"
    if isinstance(v, (list, tuple)):
        return "array"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def _is_type(v: Any, t: str) -> bool:
    k = _type_of(v)
    if t == "integer":
        return k == "number" and float(v).is_integer()
    return k == t


def _same(a: Any, b: Any) -> bool:
    ka, kb = _type_of(a), _type_of(b)
    return ka == kb and a == b


def _search(pattern: str, s: str) -> bool:
    # "$" means the end of the text, as in JavaScript, not "before a final line break"
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.search(pattern, s) is not None


def validate(value: Any, schema: dict, root: Optional[dict] = None, at: str = "$") -> list[str]:
    """Check a value against a schema. Returns one message per problem; an empty list means valid.

    Only the keywords the project's schemas use are known; any other raises, so a rule is never skipped
    without notice."""
    root = schema if root is None else root
    out: list[str] = []
    for k in schema:
        if k not in _KEYWORDS and k not in _NOTES:
            raise ValueError(f"schema keyword not supported: {k}")
    if "$ref" in schema:
        m = re.fullmatch(r"#/\$defs/([A-Za-z0-9_]+)", schema["$ref"])
        if not m or m.group(1) not in root.get("$defs", {}):
            raise ValueError(f"schema $ref not supported: {schema['$ref']}")
        out += validate(value, root["$defs"][m.group(1)], root, at)
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_is_type(value, t) for t in types):
            out.append(f"{at}: expected {' or '.join(types)}, found {_type_of(value)}")
            return out
    if "enum" in schema and not any(_same(e, value) for e in schema["enum"]):
        out.append(f"{at}: {json.dumps(value)} is not one of {json.dumps(schema['enum'])}")
    if "const" in schema and not _same(schema["const"], value):
        out.append(f"{at}: expected {json.dumps(schema['const'])}, found {json.dumps(value)}")
    kind = _type_of(value)
    if kind == "number":
        if "minimum" in schema and value < schema["minimum"]:
            out.append(f"{at}: {value} is below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            out.append(f"{at}: {value} is above {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            out.append(f"{at}: {value} is not above {schema['exclusiveMinimum']}")
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            out.append(f"{at}: {value} is not below {schema['exclusiveMaximum']}")
    if kind == "string":
        if "minLength" in schema and len(value) < schema["minLength"]:
            out.append(f"{at}: shorter than {schema['minLength']}")
        if "pattern" in schema and not _search(schema["pattern"], value):
            out.append(f"{at}: {json.dumps(value)} does not match {schema['pattern']}")
    if kind == "array":
        if "minItems" in schema and len(value) < schema["minItems"]:
            out.append(f"{at}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            out.append(f"{at}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, v in enumerate(value):
                out += validate(v, schema["items"], root, f"{at}[{i}]")
    if kind == "object":
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in value:
                out.append(f'{at}: "{k}" is missing')
        for k, v in value.items():
            where = f"{at}.{k}"
            if "propertyNames" in schema:
                out += validate(k, schema["propertyNames"], root, f'{at}: key "{k}"')
            if k in props:
                out += validate(v, props[k], root, where)
            elif schema.get("additionalProperties") is False:
                out.append(f"{where}: not a known field")
            elif isinstance(schema.get("additionalProperties"), dict):
                out += validate(v, schema["additionalProperties"], root, where)
    return out


def check_numbers(numbers: Any) -> list[str]:
    """numbers.json, or one of the files it is merged from."""
    return validate(numbers, load_schema("numbers"))


def check_checks(rows: Any) -> list[str]:
    """checks.json, or one of the files it is merged from.

    Beyond the schema: ids are unique; a PASS row names the reviewer's role and the date of the review;
    a row has a picture and its SHA-256 together, or neither."""
    out = validate(rows, load_schema("checks"))
    if out or not isinstance(rows, list):
        return out
    seen: set[str] = set()
    for i, r in enumerate(rows):
        at = f"$[{i}] ({r['id']})"
        if r["id"] in seen:
            out.append(f"{at}: id is used twice")
        seen.add(r["id"])
        if r["status"] == "PASS" and (r["reviewer_role"] is None or r["reviewed_on"] is None):
            out.append(f"{at}: a PASS row needs reviewer_role and reviewed_on")
        if (r["image"] is None) != (r["image_sha256"] is None):
            out.append(f"{at}: image and image_sha256 go together")
    return out


def check_numbers_have_checks(numbers: dict, rows: list) -> list[str]:
    """Every number that names a check names one that exists."""
    ids = {r["id"] for r in rows}
    return [
        f'number "{key}": there is no Checks row "{n["check"]}"'
        for key, n in numbers.items()
        if n["check"] is not None and n["check"] not in ids
    ]


def check_manifest(manifest: Any, stamps_bytes: Optional[int] = None, flags_bytes: Optional[int] = None) -> list[str]:
    """A showcase manifest.

    Beyond the schema: frames are sorted by mjd; visits count up from 0 without a gap; a pair names two
    different frames, the first in an earlier visit; no frame is in two pairs; the binary files, when their
    sizes are given, hold exactly frames * w * h values of four bytes."""
    out = validate(manifest, load_schema("manifest"))
    if out:
        return out
    frames = manifest["frames"]
    n = len(frames)
    for i in range(1, n):
        if frames[i]["mjd"] < frames[i - 1]["mjd"]:
            out.append(f"$.frames[{i}]: frames are not sorted by mjd")
        step = frames[i]["visit"] - frames[i - 1]["visit"]
        if step not in (0, 1):
            out.append(f"$.frames[{i}]: visit goes from {frames[i - 1]['visit']} to {frames[i]['visit']}")
    if frames[0]["visit"] != 0:
        out.append("$.frames[0]: the first visit is 0")
    used: set[int] = set()
    for k, (i, j) in enumerate(manifest["pairs"]):
        at = f"$.pairs[{k}]"
        if i >= n or j >= n:
            out.append(f"{at}: there is no frame {max(i, j)}")
            continue
        if not frames[i]["visit"] < frames[j]["visit"]:
            out.append(f"{at}: the first frame must be in an earlier visit than the second")
        for f in (i, j):
            if f in used:
                out.append(f"{at}: frame {f} is in two pairs")
            used.add(f)
    want = n * manifest["w"] * manifest["h"] * 4
    if stamps_bytes is not None and stamps_bytes != want:
        out.append(f"stamps.bin: {stamps_bytes} bytes, expected {want}")
    if manifest["flags"] is not None and flags_bytes is not None and flags_bytes != want:
        out.append(f"flags.bin: {flags_bytes} bytes, expected {want}")
    return out


def check_showcase(folder: Union[str, Path]) -> list[str]:
    """A showcase folder: manifest.json with its binary files beside it."""
    folder = Path(folder)
    file = folder / MANIFEST_FILE
    if not file.exists():
        return [f"{file}: missing"]
    manifest = json.loads(file.read_text(encoding="utf-8"))

    def size(name: str) -> int:
        p = folder / name
        return p.stat().st_size if p.exists() else -1

    out = check_manifest(
        manifest,
        stamps_bytes=size(STAMPS_FILE),
        flags_bytes=None if manifest.get("flags") is None else size(FLAGS_FILE),
    )
    if manifest.get("id") != folder.name:
        out.append(f'$.id: "{manifest.get("id")}" is not the folder name "{folder.name}"')
    return out
