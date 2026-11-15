"""Positions of a solar-system body as SPHEREx saw it, from JPL Horizons.

The observer is the spacecraft itself (Horizons id -163182), so the parallax of the orbit round the Earth is
in the position: it reaches several arcseconds for a body as near as a comet. Times are MJD (UTC), the same as
the frames' MJD-AVG. Answers are cached on disk, so a rerun gets the same numbers.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass

import numpy as np
import requests

from . import s3

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
SPHEREX = "-163182"
CHUNK = 40


@dataclass
class Ephemeris:
    mjd: np.ndarray  # as asked
    ra: np.ndarray  # degrees, ICRF, astrometric
    dec: np.ndarray
    r_au: np.ndarray  # distance from the Sun
    delta_au: np.ndarray  # distance from the observer


def _query(command: str, center: str, mjds: list[float], tries: int = 4) -> list[list[float]]:
    tl = " ".join(f"{m:.7f}" for m in mjds)
    params = {"format": "json", "COMMAND": f"'{command}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
              "EPHEM_TYPE": "OBSERVER", "CENTER": f"'{center}'", "TLIST": f"'{tl}'", "TLIST_TYPE": "MJD",
              "TIME_TYPE": "UT", "QUANTITIES": "'1,19,20'", "EXTRA_PREC": "YES", "ANG_FORMAT": "DEG",
              "CAL_FORMAT": "JD", "CSV_FORMAT": "YES"}
    tag = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()[:16]
    cache = s3.cache_dir() / f"horizons_{tag}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.get(HORIZONS, params=params, timeout=120)
            body = r.json()
            text = body.get("result", "")
            if "$$SOE" in text:
                rows = []
                for line in text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
                    f = [c.strip() for c in line.split(",")]
                    rows.append([float(f[0]), float(f[3]), float(f[4]), float(f[5]), float(f[7])])
                cache.write_text(json.dumps(rows))
                return rows
            err = RuntimeError(text[-300:] or str(body)[:300])
        except (requests.RequestException, ValueError, IndexError) as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"Horizons failed: {err}")


def positions(command: str, mjds, center: str = f"@{SPHEREX}") -> Ephemeris:
    """Astrometric (ra, dec) in degrees of `command` (a Horizons target, for example "C/2025 N1") at each time
    in `mjds` (MJD, UTC), seen from `center` (default: SPHEREx). Also the distance from the Sun and from the
    observer in au."""
    mjds = [float(m) for m in mjds]
    rows: list[list[float]] = []
    for i in range(0, len(mjds), CHUNK):
        rows += _query(command, center, mjds[i : i + CHUNK])
    if len(rows) != len(mjds):
        raise RuntimeError(f"Horizons gave {len(rows)} rows for {len(mjds)} times")
    a = np.array(rows)
    if np.abs(a[:, 0] - 2400000.5 - np.array(mjds)).max() > 1e-5:
        raise RuntimeError("Horizons answered for other times than asked")
    return Ephemeris(np.array(mjds), a[:, 1], a[:, 2], a[:, 3], a[:, 4])
