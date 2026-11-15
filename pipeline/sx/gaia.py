"""Gaia DR3 stars around a position, through the cone search of the MAST archive (a public service), and the
placement test: do catalogue stars land where the stamp shows them?

Positions are propagated from the catalogue epoch (J2016.0) to the time of a frame with astropy, using the
catalogue's proper motion (no parallax or radial velocity: for the stars used here the difference is far below
a hundredth of a pixel).
"""
from __future__ import annotations

import hashlib
import json
import time
import warnings
from typing import Optional

import numpy as np
import requests
from scipy.optimize import curve_fit

from . import s3

MAST = "https://mast.stsci.edu/api/v0/invoke"
GAIA_EPOCH_MJD = 57388.5  # J2016.0
FIELDS = ("source_id", "ra", "dec", "pmra", "pmdec", "parallax", "phot_g_mean_mag", "bp_rp")
MAD = 1.4826
PAGE = 5000


def cone(ra: float, dec: float, radius: float, tries: int = 4) -> list[dict]:
    """Gaia DR3 sources within `radius` degrees of (ra, dec), as dicts with the keys of FIELDS (missing values
    None), all pages of the answer. Answers are cached on disk, so a rerun sees the same list."""
    tag = hashlib.sha1(f"{ra:.6f},{dec:.6f},{radius:.6f}".encode()).hexdigest()[:12]
    cache = s3.cache_dir() / f"gaia_{tag}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    rows: list[dict] = []
    page = 1
    while True:
        got = _page(ra, dec, radius, page, tries)
        rows += got
        if len(got) < PAGE:
            break
        page += 1
    out = [{f: row.get(f) for f in FIELDS} for row in rows]
    for o in out:
        o["source_id"] = str(o["source_id"])
    cache.write_text(json.dumps(out))
    return out


def _page(ra: float, dec: float, radius: float, page: int, tries: int) -> list[dict]:
    req = {"service": "Mast.Catalogs.GaiaDR3.Cone", "params": {"ra": ra, "dec": dec, "radius": radius},
           "format": "json", "pagesize": PAGE, "page": page}
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.post(MAST, data={"request": json.dumps(req)}, timeout=180)
            if r.status_code == 200:
                return r.json().get("data", [])
            err = RuntimeError(f"status {r.status_code}")
        except (requests.RequestException, ValueError) as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"Gaia cone search failed: {err}")


def propagate(stars: list[dict], mjd: float) -> tuple[np.ndarray, np.ndarray]:
    """(ra, dec) in degrees of the stars at time mjd, from the catalogue positions and proper motions."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.time import Time

    ra = np.array([s["ra"] for s in stars], float)
    dec = np.array([s["dec"] for s in stars], float)
    pmra = np.array([s["pmra"] if s["pmra"] is not None else 0.0 for s in stars], float)
    pmde = np.array([s["pmdec"] if s["pmdec"] is not None else 0.0 for s in stars], float)
    c = SkyCoord(ra * u.deg, dec * u.deg, pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmde * u.mas / u.yr,
                 obstime=Time(GAIA_EPOCH_MJD, format="mjd"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        n = c.apply_space_motion(new_obstime=Time(mjd, format="mjd"))
    return n.ra.deg, n.dec.deg


def _gauss(xy, a, x0, y0, s, c):
    x, y = xy
    return a * np.exp(-((x - x0) ** 2 + (y - y0) ** 2) / (2 * s * s)) + c


def centroid(data: np.ndarray, sx: float, sy: float) -> Optional[tuple[float, float, float]]:
    """Fit a circular Gaussian plus a constant to the 7 by 7 pixels round the brightest pixel within 2 pixels
    of (sx, sy), where the catalogue says the star is: a star that the stamp does not show there is not
    measured (so a position error of more than 2 pixels leaves no star to measure). Returns (x, y,
    signal-to-noise of the peak) in stamp pixels, or None when the window has missing pixels or the fit is not
    a point source."""
    h, w = data.shape
    ix, iy = int(round(sx)), int(round(sy))
    if not (4 <= ix < w - 4 and 4 <= iy < h - 4):
        return None
    win = data[iy - 2 : iy + 3, ix - 2 : ix + 3]
    if np.isnan(win).any():
        return None
    k = np.unravel_index(np.argmax(win), win.shape)
    cy, cx = iy - 2 + k[0], ix - 2 + k[1]
    if not (3 <= cx < w - 3 and 3 <= cy < h - 3):
        return None
    box = data[cy - 3 : cy + 4, cx - 3 : cx + 4]
    if np.isnan(box).any():
        return None
    bg = float(np.nanmedian(data))
    noise = float(MAD * np.nanmedian(np.abs(data - bg)))
    snr = (float(data[cy, cx]) - bg) / noise if noise > 0 else 0.0
    yy, xx = np.mgrid[cy - 3 : cy + 4, cx - 3 : cx + 4]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            p, _ = curve_fit(_gauss, (xx.ravel(), yy.ravel()), box.ravel().astype(float),
                             p0=(float(data[cy, cx]) - bg, cx, cy, 1.0, bg), maxfev=4000)
    except (RuntimeError, ValueError):
        return None
    if not (0.3 < abs(p[3]) < 4):
        return None
    return float(p[1]), float(p[2]), snr


def placement(stamp, wcs, stars: list[dict], gmin: float = 7.0, gmax: float = 14.5, min_snr: float = 30.0,
              isolation_px: float = 6.0) -> list[dict]:
    """For each bright, isolated Gaia star on the stamp: where the catalogue puts it (stamp pixels, from
    all_world2pix at the frame's time) and where the stamp shows it, as
    {"source_id", "G", "px", "py", "x", "y", "dx", "dy", "offset", "snr"}. `stamp` is a Stamp (data, x0, y0,
    mjd), `wcs` the frame's celestial WCS."""
    ok = [s for s in stars if s["phot_g_mean_mag"] is not None]
    if not ok:
        return []
    ra, dec = propagate(ok, stamp.mjd)
    ax, ay = wcs.all_world2pix(ra, dec, 0)
    sx, sy = ax - stamp.x0, ay - stamp.y0
    g = np.array([s["phot_g_mean_mag"] for s in ok], float)
    out = []
    for j in range(len(ok)):
        if not (gmin < g[j] < gmax):
            continue
        d = np.hypot(sx - sx[j], sy - sy[j])
        if np.any((d < isolation_px) & (d > 0) & (g < g[j] + 2.5)):
            continue
        c = centroid(stamp.data, float(sx[j]), float(sy[j]))
        if c is None or c[2] < min_snr:
            continue
        dx, dy = c[0] - float(sx[j]), c[1] - float(sy[j])
        out.append({"source_id": ok[j]["source_id"], "G": float(g[j]), "px": float(sx[j]), "py": float(sy[j]),
                    "x": c[0], "y": c[1], "dx": dx, "dy": dy, "offset": float(np.hypot(dx, dy)), "snr": c[2]})
    return out
