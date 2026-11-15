"""Job index: the index of photos, built again from the archive or extended with the photos that are new.

    python -m sx.run index                          what the site's index holds; nothing is asked of the archive
    python -m sx.run index --week 2025W46_1A        the photos of one week (a folder of the bucket; several may be named)
    python -m sx.run index --since 2026W20_1A       the photos of every week after that one
    python -m sx.run index --all                    the photos of every week of the release
        --into <folder>                             add them to the index in that folder (the site's: ../site/idx)
        --check [--reviewed "<role>" <YYYY-MM-DD>]  with one --week: compare with the site's index, write row K-index

Without --into the index is written to pipeline/out/idx/, which is not part of the site.

A week is read in three steps. The bucket lists its photos. Of each photo that the index does not hold yet, one
byte range is read: the cards of the IMAGE header from CRPIX1 to MJD-END, which hold the sky transform (TAN with
SIP) and the times of the exposure. They give a row of the index (CT-2): week and version, observation, exposure,
detector, the mid-time (MJD-AVG) and the four corners (the outer edges of the corner pixels). The row goes into
every tile that the circle round its corners touches, so the tile of a position holds every photo that covers it.

A week is added whole or not at all: if a photo cannot be read, the week is left out and the job ends with 1; what
was read is kept in the cache (s3.cache_dir(), one file a week), so the next run asks only for the rest. Rows that
an index holds are never changed or taken out, and a tile or meta.json is written only when it gains something,
so the same command run twice changes nothing.

The archive is asked gently: range requests of 6,640 bytes, at most s3.MAX_PER_HOST in flight, each tried up to
s3.TRIES times with a pause, and no more at all once GIVE_UP photos in a row have failed.

--check builds the week into pipeline/out/check/, reads the rows back and compares them, photo by photo, with the
rows of the same photos in the site's index. It writes the Checks row K-index (site/data/checks/rows/p8.json).
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import shutil
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Callable, Optional, Union

import requests
from astropy.io.fits import Header

from sx import checks, s3
from sx import contracts as C
from sx.fits import HEAD_BYTES
from sx.index import INDEX_DIR
from sx.numbers import text as n
from sx.wcs import corners, make_wcs

PIPELINE = Path(__file__).resolve().parents[1]
OUT = PIPELINE / "out"
"""Where an index is written when no folder is named (out/idx), and where the check builds its own (out/check)."""

PREFIX = C.KEY_PATTERN.split("{week}")[0]
"""Where the photos of the release lie in the bucket: dr1/level2/."""

SIDE = 2040
"""Pixels along each side of a photo."""

FIRST, LAST, SPAN = b"CRPIX1  =", b"MJD-END =", 83 * 80
"""The cards read from a photo: CRPIX1 to MJD-END, which are 83 cards of 80 bytes in the photos of release 1."""

BAND = 5.0
"""Height of a declination band of a new index, degrees. An index that exists keeps its own bands."""

MARGIN = 0.01
"""Added to the radius of the circle round a photo, degrees, so that rounding leaves no corner outside it."""

CHUNK = 600
"""Photos read between two savings of the cache and two lines of progress."""

GIVE_UP = 12
"""After this many photos in a row that the archive did not give, no more are asked for."""

FLUSH = 100_000
"""Rows held in memory before they are written into the tiles."""

NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"
PRODUCER = "p8"
ROW_ID = "K-index"
RATE = {"asked": 0, "spent": 0.0}
"""How many headers the last build asked of the archive and the seconds that took, the listing included."""
ROWS_DIR = checks.ROWS_DIR

Reading = list[float]
"""What a row is made from: [MJD-AVG, MJD-BEG, MJD-END, ra1, dec1, ..., ra4, dec4], nothing rounded."""

# -- the bucket's listing --------------------------------------------------------------------------------


def _page(params: dict) -> ET.Element:
    """One page of the bucket's listing; tried again after a pause."""
    err: Exception = RuntimeError("no try made")
    for k in range(s3.TRIES):
        try:
            r = requests.get(C.BUCKET_URLS[0], params=params, timeout=120)
            if r.status_code == 200:
                return ET.fromstring(r.content)
            err = RuntimeError(f"status {r.status_code}")
        except (requests.RequestException, ET.ParseError) as e:
            err = e
        time.sleep(2.0 * 2**k)
    raise RuntimeError(f"the bucket did not list {params['prefix']} in {s3.TRIES} tries: {err}")


def listing(prefix: str, folders: bool = False) -> list[str]:
    """Every key below a prefix of the bucket; with `folders`, the folders directly below it instead."""
    out: list[str] = []
    token = None
    while True:
        params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if folders:
            params["delimiter"] = "/"
        if token:
            params["continuation-token"] = token
        page = _page(params)
        path = f"{NS}CommonPrefixes/{NS}Prefix" if folders else f"{NS}Contents/{NS}Key"
        out += [e.text or "" for e in page.iterfind(path)]
        if page.findtext(f"{NS}IsTruncated") != "true":
            return out
        token = page.findtext(f"{NS}NextContinuationToken")
        if not token:
            raise RuntimeError(f"the listing of {prefix} is cut short and names no next page")


def weeks_of_release() -> list[str]:
    """The weeks of the release, as the bucket lists their folders, in order of time."""
    return sorted(p[len(PREFIX):].strip("/") for p in listing(PREFIX, folders=True))


def photos_of(week: str) -> list[str]:
    """The keys of the photos of a week, sorted. Anything in the folder that is not named as a photo is left out."""
    return sorted(k for k in listing(f"{PREFIX}{week}/") if C.KEY_REGEX.fullmatch(k))


# -- one photo -------------------------------------------------------------------------------------------


def photo(key: str) -> tuple[str, int, int, int]:
    """What names a photo in the index: ("week/version", observation, exposure, detector)."""
    m = C.KEY_REGEX.fullmatch(key)
    if not m:
        raise ValueError(f"not the key of a photo: {key}")
    return f"{m.group(1)}/{m.group(2)}", int(m.group(4)), int(m.group(5)), int(m.group(3))


def key_of(wv: str, obs: int, exp: int, det: int) -> str:
    week, ver = wv.split("/")
    return C.KEY_PATTERN.format(week=week, ver=ver, det=det, obs=obs, exp=exp)


def start_of(key: str) -> int:
    """Where the cards start in a photo of release 1: byte 12,960, and 1,200 bytes later in detectors 1 and 2
    (their headers hold fifteen more cards), and 400 later in the files of a retry folder (five more)."""
    wv, _, _, det = photo(key)
    return 12960 + (1200 if det <= 2 else 0) + (400 if "retry" in wv else 0)


def read_cards(key: str, found: dict) -> bytes:
    """The cards CRPIX1 to MJD-END of a photo. One range request when they are where the photos of its folder and
    detector have them; otherwise the start of the file is read and searched, and `found` keeps the place for the
    photos that follow."""
    wv, _, _, det = photo(key)
    a, size = found.get((wv, det), (start_of(key), SPAN))
    raw = s3.get_range(key, a, a + size - 1, cache=False)
    if raw.startswith(FIRST) and raw[-80:].startswith(LAST):
        return raw
    head = s3.get_range(key, 0, HEAD_BYTES - 1, cache=False)
    a, b = head.find(FIRST), head.find(LAST)
    if a < 0 or b < a or a % 80 or b % 80:
        raise ValueError(f"no cards CRPIX1 to MJD-END in the first {HEAD_BYTES} bytes")
    found[(wv, det)] = (a, b + 80 - a)
    return head[a : b + 80]


def reading(cards: bytes) -> Reading:
    """The times and the corners that the cards give. The corners are the outer edges of the corner pixels, going
    round from the lowest x and y, through the distortion terms (sx.wcs.corners)."""
    h = Header.fromstring(cards.decode("latin-1"))
    w = make_wcs(h)
    if not w.has_celestial:
        raise ValueError("the header has no sky transform")
    out = [float(h["MJD-AVG"]), float(h["MJD-BEG"]), float(h["MJD-END"])]
    for ra, dec in corners(w, SIDE, SIDE):
        out += [ra % 360.0, dec]
    if not all(math.isfinite(x) for x in out):
        raise ValueError("a time or a corner is not a number")
    return out


def values(r: Reading) -> list[float]:
    """The nine numbers of a row after the photo's name: the mid-time to 0.000001 day and the corners to 0.0001
    degree. A corner is rounded to 0.0000001 degree first, as it was when the installed index was built from the
    headers: rounding once would move the last digit of about four rows in a thousand."""
    return [round(r[0], 6)] + [round(round(x, 7), 4) for x in r[3:]]


def values_as_searched(r: Reading) -> list[float]:
    """The same nine numbers as the archive's image search leads to them. The search gives the start and the end
    of an exposure to 0.000001 day and the corners in full; a third of the installed index was built from it, with
    the mean of start and end as the mid-time. Only the check uses this, to say why a row differs."""
    return [round((round(r[1], 6) + round(r[2], 6)) / 2, 6)] + [round(x, 4) for x in r[3:]]


# -- tiles -----------------------------------------------------------------------------------------------


def scheme(band: float = BAND) -> dict:
    """The tiles of a new index: bands of declination `band` degrees high, counted from the south pole, each cut
    in right ascension into as many tiles as make them about as wide as high in the middle of the band."""
    nb = int(round(180 / band))
    mid = [math.radians(-90 + (b + 0.5) * 180 / nb) for b in range(nb)]
    return {"T": band, "nbands": nb, "nra": [max(1, int(round(360 * math.cos(d) / band))) for d in mid]}


def order(tile: str) -> tuple[int, ...]:
    return tuple(int(x) for x in tile.split("_"))


def all_tiles(meta: dict) -> list[str]:
    return [f"{b}_{j}" for b in range(meta["nbands"]) for j in range(meta["nra"][b])]


def tiles_of(corner_values: list[float], meta: dict) -> list[str]:
    """The tiles a photo is written into: every tile touched by the circle whose centre is the mean of the four
    corners and whose radius is the distance to the farthest corner plus MARGIN."""
    v = []
    for ra, dec in zip(corner_values[0::2], corner_values[1::2]):
        a, d = math.radians(ra), math.radians(dec)
        v.append((math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)))
    c = [sum(p[k] for p in v) / len(v) for k in range(3)]
    norm = math.sqrt(sum(x * x for x in c))
    c = [x / norm for x in c]
    r = max(math.degrees(math.acos(max(-1.0, min(1.0, sum(p[k] * c[k] for k in range(3)))))) for p in v) + MARGIN
    ra, dec = math.degrees(math.atan2(c[1], c[0])) % 360, math.degrees(math.asin(c[2]))
    lo, hi = dec - r, dec + r
    around = hi >= 90 or lo <= -90 or math.sin(math.radians(r)) >= math.cos(math.radians(dec))
    da = 180.0 if around else math.degrees(math.asin(math.sin(math.radians(r)) / math.cos(math.radians(dec))))
    nb = meta["nbands"]
    height = 180 / nb
    out = []
    for b in range(max(0, int((lo + 90) // height)), min(nb - 1, int((hi + 90) // height)) + 1):
        count = meta["nra"][b]
        width = 360 / count
        if da >= 180:
            js = list(range(count))
        else:
            js = sorted({j % count for j in range(math.floor((ra - da) / width), math.floor((ra + da) / width) + 1)})
        out += [f"{b}_{j}" for j in js]
    return out


def code(row: list) -> int:
    """One whole number for the photo of a row, so that the photos of a whole index fit in memory as a set."""
    return ((row[0] * 10000 + row[1]) * 10 + row[2]) * 10 + row[3]


def tile_names(folder: Path) -> list[str]:
    """The tiles a folder holds, in the order of the sky: bands from the south, then right ascension."""
    return sorted((p.name.split(".")[0] for p in (folder / "t").glob("*.json.gz")), key=order)


def read_tile(folder: Path, name: str) -> list[list]:
    f = folder / C.INDEX_TILE_FILE.format(tile=name)
    return json.loads(gzip.decompress(f.read_bytes())) if f.exists() else []


def put(path: Path, data: bytes) -> None:
    """Write a file in one step."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def shown(folder: Path) -> str:
    """A folder as a message names it: from the top of the project when it lies inside it."""
    root = PIPELINE.parent
    return folder.relative_to(root).as_posix() if folder.is_relative_to(root) else str(folder)


def some(k: int, thing: str) -> str:
    """A count with its noun: "1 week", "9,169 photos"."""
    return f"{n(k)} {thing}{'' if k == 1 else 's'}"


@dataclass
class Index:
    """An index folder: meta.json and the tiles under t/, as site/js/lib/tiles.js and sx/index.py read them."""

    folder: Path
    meta: dict
    held: set[int]  # the photos in the tiles, as code() names them
    wv: dict[str, int] = field(default_factory=dict)  # where each "week/version" stands in meta["wv"]
    waiting: dict[str, list[list]] = field(default_factory=dict)  # rows not yet written, by tile
    n_waiting: int = 0

    @classmethod
    def open(cls, folder: Path) -> "Index":
        """The index in a folder, or a new and empty one when the folder has no meta.json. Every tile is read once,
        for the photos it holds."""
        f = folder / C.INDEX_META_FILE
        if f.exists():
            meta = json.loads(f.read_text(encoding="utf-8"))
        else:
            meta = {**scheme(), "wv": [], "complete": [], "key": C.KEY_PATTERN, "row": f"[{', '.join(C.INDEX_ROW)}]",
                    "n_frames": 0, "sources": {"sia": 0, "header": 0}}
            meta["complete"] = all_tiles(meta)  # nothing is listed that is not in it
        held = {code(r) for name in tile_names(folder) for r in read_tile(folder, name)}
        return cls(folder, meta, held, {name: i for i, name in enumerate(meta["wv"])})

    def holds(self, key: str) -> bool:
        wv, obs, exp, det = photo(key)
        return wv in self.wv and code([self.wv[wv], obs, exp, det]) in self.held

    def add(self, key: str, r: Reading) -> None:
        """Put the row of a photo in line for every tile it belongs to."""
        wv, obs, exp, det = photo(key)
        if wv not in self.wv:
            self.wv[wv] = len(self.meta["wv"])
            self.meta["wv"].append(wv)
        row = [self.wv[wv], obs, exp, det] + values(r)
        for tile in tiles_of([round(x, 7) for x in r[3:]], self.meta):
            self.waiting.setdefault(tile, []).append(row)
        self.n_waiting += 1

    def flush(self) -> tuple[int, int]:
        """Write what is in line; returns (photos gained, tiles written). meta.json goes first, so that no row
        ever names a week the file does not list, then every tile that gains a row, then meta.json with the count.
        Rows already in a tile stay as they are and where they are; new rows go in by time."""
        before, written = len(self.held), 0
        if not self.held and not self.waiting:
            return 0, 0  # nothing to hold: no empty index is written
        self._write_meta()
        for name in sorted(self.waiting, key=order):
            old = read_tile(self.folder, name)
            there = {code(r) for r in old}
            new = [r for r in self.waiting[name] if code(r) not in there]
            if new:
                new.sort(key=lambda r: (r[4], self.meta["wv"][r[0]], r[1], r[2], r[3]))
                rows = sorted(old + new, key=lambda r: r[4])
                data = json.dumps(rows, separators=(",", ":")).encode()
                put(self.folder / C.INDEX_TILE_FILE.format(tile=name), gzip.compress(data, 9, mtime=0))
                written += 1
            self.held.update(code(r) for r in self.waiting[name])
        self.waiting, self.n_waiting = {}, 0
        self.meta["n_frames"] = len(self.held)
        if "sources" in self.meta:
            others = sum(v for k, v in self.meta["sources"].items() if k != "header")
            self.meta["sources"]["header"] = len(self.held) - others
        self._write_meta()
        return len(self.held) - before, written

    def _write_meta(self) -> None:
        f = self.folder / C.INDEX_META_FILE
        if f.exists() and json.loads(f.read_text(encoding="utf-8")) == self.meta:
            return
        put(f, json.dumps(self.meta, separators=(",", ":")).encode())


# -- a week ----------------------------------------------------------------------------------------------


def cache_file(week: str) -> Path:
    return s3.cache_dir() / f"index_{week}.json.gz"


def cached(week: str) -> dict[str, Reading]:
    """The readings of a week that earlier runs took from the archive, by key."""
    f = cache_file(week)
    return json.loads(gzip.decompress(f.read_bytes())) if f.exists() else {}


def readings_of(week: str, keys: list[str], skip: Callable[[str], bool]) -> tuple[dict[str, Reading], dict[str, str], int]:
    """(the readings of the photos of a week by key, what went wrong by key, how many photos were asked of the
    archive). A photo is asked for only when the cache has no reading of it and `skip` does not say that it can be
    left alone."""
    got = cached(week)
    todo = [k for k in keys if k not in got and not skip(k)]
    wrong: dict[str, str] = {}
    found: dict = {}
    failed = [0]  # photos in a row that the archive did not give

    def fetch(key: str) -> Union[bytes, Exception]:
        if failed[0] >= GIVE_UP:
            return RuntimeError("not asked for: the archive had stopped answering")
        try:
            cards = read_cards(key, found)
            failed[0] = 0
            return cards
        except ValueError as e:
            return e
        except RuntimeError as e:
            failed[0] += 1
            return e

    t = time.time()
    with ThreadPoolExecutor(s3.MAX_PER_HOST) as threads:
        for i in range(0, len(todo), CHUNK):
            part = todo[i : i + CHUNK]
            for key, cards in zip(part, threads.map(fetch, part)):  # read while the next ones are on their way
                try:
                    if isinstance(cards, Exception):
                        raise cards
                    got[key] = reading(cards)
                except Exception as e:  # whatever is wrong with one photo, the others are still read
                    wrong[key] = f"{type(e).__name__}: {e}"
            put(cache_file(week), gzip.compress(json.dumps(got, separators=(",", ":")).encode(), 6, mtime=0))
            done = min(i + CHUNK, len(todo))
            print(f"{week}: {n(done)} of {n(len(todo))} headers ({done / max(time.time() - t, 1e-9):.0f} a second)", flush=True)
            if failed[0] >= GIVE_UP:
                for key in todo[done:]:
                    wrong[key] = "not asked for: the archive had stopped answering"
                break
    return {k: got[k] for k in keys if k in got}, wrong, len(todo)


def build(weeks: list[str], folder: Path) -> tuple[int, dict[str, int]]:
    """Add the photos of the weeks to the index in a folder. Returns (0, or 1 when a week was left out; how many
    photos the bucket lists in each week)."""
    t0 = time.time()
    index = Index.open(folder)
    print(f"{shown(folder)}: {some(len(index.held), 'photo')} in {some(len(tile_names(folder)), 'tile')}", flush=True)
    listed: dict[str, int] = {}
    left_out: list[str] = []
    gained = written = asked = 0
    spent = 0.0
    for week in weeks:
        t = time.time()
        keys = photos_of(week)
        listed[week] = len(keys)
        print(f"{week}: the bucket lists {some(len(keys), 'photo')}; the index holds "
              f"{n(sum(index.holds(k) for k in keys))} of them", flush=True)
        got, wrong, count = readings_of(week, keys, index.holds)
        if count:
            asked, spent = asked + count, spent + time.time() - t
        if wrong or not keys:
            left_out.append(week)
            for key, why in sorted(wrong.items())[:5]:
                print(f"{week}: {why} | {key}", file=sys.stderr)
            print(f"{week}: left out, {some(len(wrong), 'photo')} could not be read; run the command again" if keys
                  else f"{week}: left out, the bucket lists no photo in it", file=sys.stderr, flush=True)
            continue
        for key, r in got.items():
            index.add(key, r)
        if index.n_waiting >= FLUSH:
            g, w = index.flush()
            gained, written = gained + g, written + w
    t = time.time()
    g, w = index.flush()
    gained, written = gained + g, written + w
    weeks_held = len({wv.split("/")[0] for wv in index.meta["wv"]})
    RATE.update(asked=asked, spent=spent)
    if asked:
        print(f"{some(asked, 'header')} read from the archive in {spent:.0f} s, the listing included: "
              f"{1000 * spent / asked:.0f} s for a thousand photos", flush=True)
    print(f"{shown(folder)}: {some(gained, 'photo')} added, {some(written, 'tile')} written in {time.time() - t:.0f} s; "
          f"it holds {some(len(index.held), 'photo')} of {some(weeks_held, 'week')} ({time.time() - t0:.0f} s in all)",
          flush=True)
    return (1 if left_out else 0), listed


# -- the check -------------------------------------------------------------------------------------------


def rows_of(folder: Path, week: str) -> tuple[dict, Counter]:
    """(the rows of one week of an index by photo: {(week/version, obs, exp, det): (the nine numbers, the tiles
    that hold the row)}; how many photos each week of the index has)."""
    wv = json.loads((folder / C.INDEX_META_FILE).read_text(encoding="utf-8"))["wv"]
    rows: dict = {}
    seen: set[int] = set()
    for name in tile_names(folder):
        for r in read_tile(folder, name):
            seen.add(code(r))
            if wv[r[0]].split("/")[0] == week:
                rows.setdefault((wv[r[0]], r[1], r[2], r[3]), (r[4:], []))[1].append(name)
    return rows, Counter(wv[c // 1_000_000].split("/")[0] for c in seen)


def compare(week: str, built: Path, installed: Path, readings: dict[str, Reading]) -> dict:
    """The rows of a week in a newly built index against the rows of the same photos in the installed one. A row
    differs when its mid-time is not the same number or a corner is more than 0.000001 degree away."""
    a, _ = rows_of(built, week)
    b, weeks = rows_of(installed, week)
    out = {"week": week, "built": len(a), "installed": len(b), "only_built": len(set(a) - set(b)),
           "only_installed": len(set(b) - set(a)), "compared": 0, "differ": 0, "differ_time": 0, "differ_corner": 0,
           "as_searched": 0, "other_tiles": 0, "most_days": 0.0, "most_degrees": 0.0,
           "weeks": len(weeks), "fewest": bool(b) and len(b) == min(weeks.values()),
           "from_search": json.loads((installed / C.INDEX_META_FILE).read_text(encoding="utf-8")).get("sources", {}).get("sia")}
    for p in sorted(set(a) & set(b)):
        (va, ta), (vb, tb) = a[p], b[p]
        dt = abs(va[0] - vb[0])
        dc = max(abs(x - y) for x, y in zip(va[1:], vb[1:]))
        out["compared"] += 1
        out["other_tiles"] += ta != tb
        if va[0] != vb[0] or dc > 1e-6:
            out["differ"] += 1
            out["differ_time"] += va[0] != vb[0]
            out["differ_corner"] += dc > 1e-6
            out["most_days"], out["most_degrees"] = max(out["most_days"], dt), max(out["most_degrees"], dc)
            r = readings.get(key_of(*p))
            out["as_searched"] += r is not None and values_as_searched(r) == vb
    return out


def verdict(c: dict, listed: int) -> str:
    """"same" when no row differs, "limit" when every row that differs is explained by the image search's
    rounding, "fail" otherwise. In the first two the photos and their tiles are the same in both."""
    same = (c["built"] == c["installed"] == c["compared"] == listed and c["other_tiles"] == 0
            and c["only_built"] == c["only_installed"] == 0)
    if same and c["differ"] == 0:
        return "same"
    return "limit" if same and c["as_searched"] == c["differ"] else "fail"


def check_row(c: dict, listed: int, reviewer: Optional[tuple[str, str]]) -> C.CheckRow:
    """The Checks row K-index from what compare() counted."""
    how = verdict(c, listed)
    status = {"same": "PASS" if reviewer else "UNVERIFIED", "limit": "LIMIT", "fail": "FAIL"}[how]
    week = c["week"]
    test = (f"Week {week}" + (f", the one with the fewest photos of the {c['weeks']} weeks in the installed index" if c["fewest"] else "")
            + f". The command listed the week in the archive's public bucket ({n(listed)} photos), read from each photo "
            "the cards CRPIX1 to MJD-END of its header with one range request, and wrote rows and tiles into a folder of "
            f"its own. The rows were read back from those tiles ({n(c['built'])} photos) and compared with the rows of the "
            f"same photos in the installed index (site/idx, {n(c['installed'])} photos of that week): the photo (week, "
            "version, observation, exposure, detector), the mid-time as stored, to 0.000001 day, the four corners, and the "
            f"tiles that hold the row. {n(c['compared'])} rows compared, {n(c['differ'])} differ; "
            f"{n(c['only_built'] + c['only_installed'])} photos are in one index only; {n(c['other_tiles'])} rows lie in "
            "other tiles.")
    if RATE["asked"]:
        test += (f" Reading the headers took {1000 * RATE['spent'] / RATE['asked']:.0f} s for a thousand photos "
                 f"({n(RATE['asked'])} photos, the listing included, six requests at a time).")
    if c["differ"]:
        test += (f" Of the rows that differ, {n(c['differ_time'])} differ in the mid-time, by up to "
                 f"{c['most_days']:.6f} day, and {n(c['differ_corner'])} in a corner, by up to {c['most_degrees']:.4f} degree. "
                 + (f"The installed index took {n(c['from_search'])} of its rows from the archive's image search and not "
                    "from the headers (meta.json, sources). " if c["from_search"] else "")
                 + "The search gives the start and the end of an exposure to 0.000001 day, and their mean can fall one "
                 "digit beside the mid-time that the header itself gives (MJD-AVG). Built from the same header with the "
                 f"times rounded that way and the corners rounded once, {n(c['as_searched'])} of the {n(c['differ'])} rows "
                 f"are the installed rows digit for digit; {n(c['differ'] - c['as_searched'])} are not explained.")
    plain = {"same": "one week built again from the archive, row for row",
             "limit": "one week built again from the archive: the same photos, a last digit apart in some rows",
             "fail": "one week built again from the archive does not give the installed index"}[how]
    claim = ("One command builds the index of photos from the archive alone: the bucket's listing of a week and each "
             "photo's own header. ")
    if how == "limit":
        claim += ("For a whole week it gives the photos of the installed index, each in the same tiles. It does not give "
                  "every row digit for digit: a row that the installed index took from the archive's image search, and "
                  "not from the photo's header, can differ in its last digit.")
    else:
        claim += ("For a whole week it gives the rows of the installed index: the same photos in the same tiles, with the "
                  "same mid-times and the same corners.")
    return checks.row(
        id=ROW_ID,
        title="The index of photos, built again from the archive for one week",
        claim=claim,
        test=test,
        pass_rule="PASS if the week has the same photos in both, every row in the same tiles, and no row differs: "
                  "mid-times equal as stored, corners within 0.000001 degree. A limit, not a pass, if the photos and "
                  "the tiles are the same and every row that differs is the installed row digit for digit once the "
                  "header's times are rounded as the archive's image search rounds them. FAIL otherwise.",
        status=status, plain=plain,
        value=f"{n(c['compared'])} rows compared, {n(c['differ'])} differ",
        reference="the installed index: 0 differ", tolerance="mid-time equal; corners within 0.000001 degree",
        reviewer_role=reviewer[0] if reviewer and status == "PASS" else None,
        reviewed_on=reviewer[1] if reviewer and status == "PASS" else None,
        rerun=f"python -m sx.run index --week {week} --check",
    )


def check(week: str, reviewer: Optional[tuple[str, str]]) -> int:
    """Build a week into a folder of its own, compare it with the site's index, write the Checks row."""
    folder = OUT / "check"
    shutil.rmtree(folder, ignore_errors=True)
    failed, listed = build([week], folder)
    if failed:
        print("the check was not made: the week could not be read whole", file=sys.stderr)
        return 1
    print(f"comparing with {shown(INDEX_DIR)} ...", flush=True)
    c = compare(week, folder, INDEX_DIR, cached(week))
    row = check_row(c, listed[week], reviewer)
    checks.write_rows(PRODUCER, [row], ROWS_DIR)
    print(json.dumps(c))
    print(f"{row['id']}: {row['value']} ({row['status']})")
    return 0 if row["status"] != "FAIL" else 1


# -- the command -----------------------------------------------------------------------------------------


def describe(folder: Path = INDEX_DIR) -> None:
    """Say what an index holds, from its meta.json alone."""
    f = folder / C.INDEX_META_FILE
    if not f.exists():
        print(f"{shown(folder)}: no index")
        return
    meta = json.loads(f.read_text(encoding="utf-8"))
    weeks = sorted({wv.split("/")[0] for wv in meta["wv"]})
    print(f"{shown(folder)}: {n(meta['n_frames'])} photos of {n(len(weeks))} weeks, {weeks[0]} to {weeks[-1]}; "
          f"{n(len(meta['complete']))} of {n(len(all_tiles(meta)))} tiles complete")
    print(f"to add what is new: python -m sx.run index --since {weeks[-1]} --into ../site/idx")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="python -m sx.run index", description="Build or extend the index of photos.")
    p.add_argument("--week", nargs="+", default=[], metavar="WEEK", help="a week folder of the bucket, such as 2025W46_1A")
    p.add_argument("--since", metavar="WEEK", help="every week after this one")
    p.add_argument("--all", action="store_true", help="every week of the release")
    p.add_argument("--into", metavar="FOLDER", help="the index to add to (default: pipeline/out/idx)")
    p.add_argument("--check", action="store_true", help="compare one week with the site's index; writes Checks row K-index")
    p.add_argument("--reviewed", nargs=2, metavar=("ROLE", "DATE"), help="who reviewed the check, and when (YYYY-MM-DD)")
    a = p.parse_args(argv)
    if not (a.week or a.since or a.all):
        describe()
        return 0
    for week in a.week + ([a.since] if a.since else []):
        if not re.fullmatch(r"[A-Za-z0-9_]+", week):
            p.error(f"not the name of a week: {week}")
    if a.check:
        if len(a.week) != 1 or a.since or a.all or a.into:
            p.error("--check takes one --week and nothing else")
        if a.reviewed:
            date.fromisoformat(a.reviewed[1])
        return check(a.week[0], tuple(a.reviewed) if a.reviewed else None)
    weeks = set(a.week)
    if a.all or a.since:
        weeks |= {w for w in weeks_of_release() if a.all or w > a.since}
    if not weeks:
        print(f"the bucket lists no week after {a.since}: nothing to add")
        return 0
    failed, _ = build(sorted(weeks), Path(a.into).resolve() if a.into else OUT / "idx")
    return failed


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
