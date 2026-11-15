"""The all-sky frame index, read from the site's own files (contract CT-2).

The sky is cut into declination bands and each band into tiles in right ascension. A frame is written into every
tile its circumscribed circle touches, so the tile of a position holds every frame that covers it. A tile is a
gzip file with a JSON list of rows: [week/version index, obs, exp, detector, mid-exposure MJD, four corners].

    frames_covering(ra, dec)   the frames whose outline contains the position, in the order of the tile (by time)
    is_indexed(ra, dec)        False while the tile of the position is not listed as complete
    tile_of(ra, dec, meta)     the name of the tile that holds a position

Angles are in degrees (ICRS). The page reads the same files with site/js/lib/tiles.js.
"""
from __future__ import annotations

import gzip
import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Optional

INDEX_DIR = Path(__file__).resolve().parents[2] / "site" / "idx"


def _vec(ra: float, dec: float) -> tuple[float, float, float]:
    a, d = math.radians(ra), math.radians(dec)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def inside(ra: float, dec: float, corners: list[tuple[float, float]], eps: float = 1e-12) -> bool:
    """True when the position lies inside the outline given by its corners, taken as great-circle arcs."""
    p = _vec(ra, dec)
    v = [_vec(a, d) for a, d in corners]
    if sum(p[k] * sum(x[k] for x in v) for k in range(3)) <= 0:  # the far side of the sphere
        return False
    s = []
    for i in range(len(v)):
        a, b = v[i], v[(i + 1) % len(v)]
        n = (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
        s.append(n[0] * p[0] + n[1] * p[1] + n[2] * p[2])
    return all(x >= -eps for x in s) or all(x <= eps for x in s)


def tile_of(ra: float, dec: float, meta: dict) -> str:
    nb = meta["nbands"]
    b = min(nb - 1, max(0, int((dec + 90) // (180 / nb))))
    n = meta["nra"][b]
    return f"{b}_{int((ra % 360) // (360 / n)) % n}"


@lru_cache(maxsize=4)
def _meta(base: str) -> dict:
    return json.loads((Path(base) / "meta.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=8)
def _tile(base: str, name: str) -> Optional[list]:
    f = Path(base) / "t" / f"{name}.json.gz"
    if not f.exists():  # a tile without frames is not written
        return None
    return json.loads(gzip.decompress(f.read_bytes()))


def frames_covering(ra: float, dec: float, base: Optional[Path] = None) -> list[dict]:
    """The frames whose outline contains the position: dicts with key, det, tmid (MJD) and corners."""
    b = str(base or INDEX_DIR)
    m = _meta(b)
    rows = _tile(b, tile_of(ra, dec, m))
    out = []
    for r in rows or []:
        wv, obs, exp, det, t = r[:5]
        corners = list(zip(r[5::2], r[6::2]))
        if inside(ra, dec, corners):
            week, ver = m["wv"][wv].split("/")
            key = f"dr1/level2/{week}/{ver}/{det}/level2_{week}_{obs:04d}_{exp}D{det}_spx_{ver}.fits"
            out.append({"key": key, "det": det, "tmid": t, "corners": [list(c) for c in corners]})
    return out


def is_indexed(ra: float, dec: float, base: Optional[Path] = None) -> bool:
    b = str(base or INDEX_DIR)
    m = _meta(b)
    return tile_of(ra, dec, m) in set(m.get("complete", []))
