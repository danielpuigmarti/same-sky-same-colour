"""The frames that cover a position, from IRSA's image search (collection spherex_dr1).

The search is a convenience of the jobs that need a list of frames before the project's own frame index is
used. The answer is frozen (see frozen.py), so a rerun never depends on the service being up.
"""
from __future__ import annotations

import io
import json
import re
import time
import warnings

import requests
from astropy.io.votable import parse_single_table

from . import s3
from .contracts import KEY_REGEX

SIA = "https://irsa.ipac.caltech.edu/SIA"
PREFIX = "/ibe/data/spherex/"


def sia_frames(ra: float, dec: float, radius: float = 0.0001, tries: int = 5) -> list[dict]:
    """Level 2 frames whose outline contains the circle (ra, dec, radius), degrees. Each frame is
    {"key", "det", "obs_id", "tmin", "tmax"}, sorted by time; times are MJD."""
    cache = s3.cache_dir() / f"sia_{ra:.6f}_{dec:.6f}_{radius:g}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    params = {"COLLECTION": "spherex_dr1", "POS": f"CIRCLE {ra:.6f} {dec:.6f} {radius:g}"}
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.get(SIA, params=params, timeout=180)
            if r.status_code == 200:
                break
            err = RuntimeError(f"status {r.status_code}")
        except requests.RequestException as e:
            err = e
        time.sleep(3 * (k + 1))
    else:
        raise RuntimeError(f"IRSA image search failed: {err}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
    out = []
    for row in table:
        u = str(row["access_url"])
        if PREFIX not in u:
            continue
        key = u.split(PREFIX)[1]
        m = KEY_REGEX.fullmatch(key)
        if not m or "/level2/" not in key:
            continue
        out.append({"key": key, "det": int(m.group(3)), "obs_id": str(row["obs_id"]),
                    "tmin": float(row["t_min"]), "tmax": float(row["t_max"])})
    out.sort(key=lambda f: (f["tmin"], f["det"]))
    cache.write_text(json.dumps(out))
    return out
