"""Job placement: do stamps put the sky where the catalogue says?

    python -m sx.run placement

One frame of each of the six detectors that covers Barnard's Star's field (a rich field: the star moves 10
arcsec a year, and many Gaia stars lie round it) is cut into a 128 by 128 stamp at that position. For every
bright, isolated Gaia DR3 star on it, the position the catalogue gives at the time of the frame (proper motion
applied) is turned into stamp pixels with all_world2pix and compared with the centre of a Gaussian fitted to the
star in the stamp. Writes the numbers place.gaia.* to site/data/numbers/p1.json and the frozen list. Needs the
network the first time.
"""
from __future__ import annotations

import sys

import numpy as np

from sx import frozen, gaia, irsa, numbers
from sx.fits import FrameFile
from sx.stamp import cut
from sx.wcs import sky_to_pixel

RA, DEC = 269.44636, 4.76706
"""Barnard's Star, J2000 epoch 2016, rounded; only the field matters here."""
SIZE = 128
MARGIN = 80
LIMIT_PX = 0.3
"""The pass rule: every star lands within this many pixels of its catalogue position."""


def pick_frames() -> list[str]:
    """For each detector the frame in the middle of the list (by time) that holds the position at least MARGIN
    pixels from the edges; the middle of the list, so that the choice does not hang on the first or last frame."""
    found = irsa.sia_frames(RA, DEC)
    keys = []
    for det in range(1, 7):
        c = sorted((f for f in found if f["det"] == det), key=lambda f: f["tmin"])
        for f in c[len(c) // 2 :] + c[: len(c) // 2]:
            ff = FrameFile.open(f["key"])
            px, py = sky_to_pixel(ff.wcs, RA, DEC)
            if MARGIN < px < ff.nx - MARGIN and MARGIN < py < ff.ny - MARGIN:
                keys.append(f["key"])
                break
    return keys


def measure(keys: list[str]) -> list[dict]:
    stars = gaia.cone(RA, DEC, SIZE * 6.15 / 3600 * 0.75)
    out = []
    for key in keys:
        ff = FrameFile.open(key)
        st = cut(ff, RA, DEC, size=SIZE, flags=False)
        res = gaia.placement(st, ff.wcs, stars)
        off = [r["offset"] for r in res]
        out.append({"key": key, "det": ff.det, "n": len(res), "median": float(np.median(off)) if off else None,
                    "max": float(max(off)) if off else None})
    return out


def main(argv: list[str]) -> int:
    keys = frozen.frames_for("placement", pick_frames)
    rows = measure(keys)
    for r in rows:
        print(f"detector {r['det']}: {r['n']} stars, median {r['median']} px, largest {r['max']} px ({r['key'][-45:]})")
    n = sum(r["n"] for r in rows)
    worst = max(r["max"] for r in rows if r["max"] is not None)
    med = float(np.median([r["median"] for r in rows if r["median"] is not None]))
    numbers.write("p1", {
        "place.gaia.frames": numbers.entry(len(rows), 0),
        "place.gaia.stars": numbers.entry(n, 0),
        "place.gaia.largest": numbers.entry(worst, 2, unit="pixels"),
        "place.gaia.median": numbers.entry(med, 2, unit="pixels"),
        "place.gaia.limit": numbers.entry(LIMIT_PX, 1, unit="pixels"),
    })
    return 0 if all(r["n"] > 0 for r in rows) and worst <= LIMIT_PX else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
