"""What the jobs gallery and pluto share. This file is not a job (its name starts with an underscore).

  - Gaia DR3 stars that move more than 1 arcsec a year (ESA archive, one query for each band of declination);
  - where a star is at a given time (proper motion and parallax, astropy), and the offset between two sky positions;
  - a round Gaussian fitted to a star, and a star measured in one photo;
  - a sky grid (north up, east left) with a photo, a co-add or an AllWISE image drawn on it;
  - the AllWISE Atlas image of a position (IRSA's search and cutout services);
  - small helpers for the frames of the index: visits of one detector, photos thinned evenly.

Angles are degrees unless a name says arcsec; times are MJD (UTC); pixels are 0-based.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import time
import warnings
from pathlib import Path
from typing import Optional, Sequence

import numpy as np
import requests
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates
from scipy.optimize import least_squares

from sx import gaia, s3, stack, visits
from sx.fits import FLAG, FrameFile
from sx.wcs import sky_to_pixel

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
REVIEW = ROOT / "review"
FROZEN = ROOT / "pipeline" / "frozen"

PX = 6.15
"""Size of a SPHEREx detector pixel on the sky, arcsec."""
WISE_PX = 1.375
ARCSEC = 180.0 / math.pi * 3600.0
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/async"
GAIA_EPOCH_MJD = 57388.5
SAT_MASK = FLAG["OVERFLOW"] | FLAG["NONLINEAR"] | FLAG["BLOOM"]
ALLWISE_SIA = "https://irsa.ipac.caltech.edu/SIA"
ALLWISE_BAND = "W2"
INK, BLUE, ORANGE, GREY, GREEN = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#2e7d32"


def read_rule(name: str) -> dict:
    return json.loads((FROZEN / name).read_text(encoding="utf-8"))


# -- Gaia ----------------------------------------------------------------------------------------------


def _tap(query: str, tries: int = 4) -> str:
    """The csv answer of an asynchronous query to the Gaia archive; cached on disk."""
    cache = s3.cache_dir() / ("gaiatap_" + hashlib.sha1(query.encode()).hexdigest()[:16] + ".csv")
    if cache.exists():
        return cache.read_text(encoding="utf-8")
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.post(GAIA_TAP, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "PHASE": "RUN",
                                              "QUERY": query}, allow_redirects=False, timeout=60)
            loc = r.headers["Location"]
            t0 = time.time()
            while time.time() - t0 < 900:
                phase = requests.get(loc + "/phase", timeout=60).text.strip()
                if phase in ("COMPLETED", "ERROR", "ABORTED"):
                    break
                time.sleep(4)
            if phase == "COMPLETED":
                text = requests.get(loc + "/results/result", timeout=300).text
                cache.write_text(text, encoding="utf-8")
                return text
            err = RuntimeError(f"job {phase}: " + requests.get(loc + "/error", timeout=60).text[:200])
        except (requests.RequestException, KeyError) as e:
            err = e
        time.sleep(5 * (k + 1))
    raise RuntimeError(f"Gaia archive query failed: {err}")


def gaia_fast(pm_min: float = 1000.0, gmin: float = 11.0, gmax: float = 16.0, band: float = 10.0) -> list[dict]:
    """Every Gaia DR3 source with a proper motion above pm_min (mas/yr) and G between gmin and gmax, as dicts with
    source_id (str), ra, dec (epoch J2016.0), pmra (times cos dec), pmdec, parallax, parallax_error, g, ruwe. One
    query for each band of declination `band` degrees high."""
    out: dict[str, dict] = {}

    def band_text(lo: float, hi: float) -> list[str]:
        q = ("SELECT source_id,ra,dec,pmra,pmdec,parallax,parallax_error,phot_g_mean_mag,ruwe FROM gaiadr3.gaia_source "
             f"WHERE dec >= {lo} AND dec < {hi} AND pmra*pmra+pmdec*pmdec > {pm_min * pm_min:.0f} "
             f"AND phot_g_mean_mag BETWEEN {gmin} AND {gmax}")
        try:
            return _tap(q, tries=1 if hi - lo > 1.3 else 3).splitlines()[1:]
        except RuntimeError:
            if hi - lo <= 1.3:
                raise
            mid = (lo + hi) / 2
            return band_text(lo, mid) + band_text(mid, hi)

    lo = -90.0
    while lo < 90.0:
        hi = min(90.0, lo + band)
        for line in band_text(lo, hi):
            f = line.split(",")
            if len(f) < 9 or "" in f[:8]:
                continue
            out[f[0]] = {"source_id": f[0], "ra": float(f[1]), "dec": float(f[2]), "pmra": float(f[3]), "pmdec": float(f[4]),
                         "parallax": float(f[5]), "parallax_error": float(f[6]), "g": float(f[7]),
                         "ruwe": float(f[8]) if f[8] else math.nan}
        lo = hi
    return sorted(out.values(), key=lambda s: s["source_id"])


def propagate(star: dict, mjd):
    """(ra, dec) in degrees of a Gaia star at time `mjd` (a number or an array), seen from near the Earth: the
    star is moved in space with its proper motion from J2016.0 (astropy's apply_space_motion), then the direction
    is taken from the Earth instead of the barycentre of the solar system, which is the parallax. SPHEREx and WISE
    circle the Earth some 7,000 km from its centre: that is below 0.001 arcsec at these distances."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord, get_body_barycentric
    from astropy.time import Time

    scalar = np.ndim(mjd) == 0
    t = Time(np.atleast_1d(np.asarray(mjd, float)), format="mjd", scale="utc")
    c = SkyCoord(ra=star["ra"] * u.deg, dec=star["dec"] * u.deg, distance=(1000.0 / star["parallax"]) * u.pc,
                 pm_ra_cosdec=star["pmra"] * u.mas / u.yr, pm_dec=star["pmdec"] * u.mas / u.yr,
                 obstime=Time(2016.0, format="jyear", scale="tcb"), frame="icrs")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        s = c.apply_space_motion(new_obstime=t)
    v = s.cartesian.xyz.to_value(u.au) - get_body_barycentric("earth", t).xyz.to_value(u.au)
    ra = np.degrees(np.arctan2(v[1], v[0])) % 360.0
    dec = np.degrees(np.arcsin(v[2] / np.linalg.norm(v, axis=0)))
    return (float(ra[0]), float(dec[0])) if scalar else (ra, dec)


def pm_total(star: dict) -> float:
    return math.hypot(star["pmra"], star["pmdec"])


def offset_arcsec(ra1, dec1, ra2, dec2):
    """(east, north) in arcsec of point 2 as seen from point 1, on the tangent plane at point 1."""
    a1, d1, a2, d2 = (np.radians(v) for v in (ra1, dec1, ra2, dec2))
    den = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(a2 - a1)
    return (np.cos(d2) * np.sin(a2 - a1) / den * ARCSEC,
            (np.cos(d1) * np.sin(d2) - np.sin(d1) * np.cos(d2) * np.cos(a2 - a1)) / den * ARCSEC)


def midpoint(ra1: float, dec1: float, ra2: float, dec2: float) -> tuple[float, float]:
    """Half-way between two nearby sky positions."""
    e, n = offset_arcsec(ra1, dec1, ra2, dec2)
    return move(ra1, dec1, e / 2, n / 2)


def move(ra: float, dec: float, east: float, north: float) -> tuple[float, float]:
    """The sky position `east` and `north` arcsec from (ra, dec) on the tangent plane there (inverse of offset_arcsec)."""
    xi, eta = east / ARCSEC, north / ARCSEC
    d0 = math.radians(dec)
    den = math.cos(d0) - eta * math.sin(d0)
    ra2 = math.radians(ra) + math.atan2(xi, den)
    dec2 = math.atan2(math.sin(d0) + eta * math.cos(d0), math.hypot(xi, den))
    return math.degrees(ra2) % 360.0, math.degrees(dec2)


def ecliptic_latitude(ra: float, dec: float) -> float:
    eps = math.radians(23.4392911)
    a, d = math.radians(ra), math.radians(dec)
    return math.degrees(math.asin(math.sin(d) * math.cos(eps) - math.cos(d) * math.sin(eps) * math.sin(a)))


def neighbours(ra: float, dec: float, radius_arcsec: float) -> list[dict]:
    """The Gaia DR3 sources within `radius_arcsec` of a position, with their G magnitude and proper motion (the
    MAST cone search, cached); G, pmra and pmdec are None where Gaia has no value."""
    return gaia.cone(round(ra, 4), round(dec, 4), radius_arcsec / 3600.0)


# -- centroids -----------------------------------------------------------------------------------------


def fit_gauss(data: np.ndarray, x0: float, y0: float, search: float = 2.0, half: int = 3, sigma0: float = 0.8) -> Optional[dict]:
    """A round Gaussian on a constant, fitted to the box of (2 half + 1) squared pixels round the brightest usable
    pixel within `search` pixels of (x0, y0). Pixels that are not finite are left out; at least 60% of the box must
    be usable. Returns {x, y, amp, sigma, bg, rms, n} in the pixels of `data`, or None when there is nothing to fit
    there. The fit keeps the width within 0.3 to 4 times `sigma0`."""
    h, w = data.shape
    good = np.isfinite(data)
    yy, xx = np.mgrid[:h, :w]
    near = good & (np.hypot(xx - x0, yy - y0) <= search)
    if not near.any():
        return None
    cy, cx = divmod(int(np.argmax(np.where(near, data, -np.inf))), w)
    if not (half <= cx < w - half and half <= cy < h - half):
        return None
    sl = (slice(cy - half, cy + half + 1), slice(cx - half, cx + half + 1))
    m = good[sl]
    if m.sum() < 0.6 * m.size:
        return None
    X, Y, Z = xx[sl][m].astype(float), yy[sl][m].astype(float), data[sl][m].astype(float)
    bg0 = float(np.percentile(Z, 25))
    amp0 = max(float(data[cy, cx]) - bg0, 1e-12)

    def res(p):
        return p[0] * np.exp(-((X - p[1]) ** 2 + (Y - p[2]) ** 2) / (2 * p[3] ** 2)) + p[4] - Z

    lo = [0, cx - 1.5, cy - 1.5, 0.3 * sigma0, -np.inf]
    hi = [np.inf, cx + 1.5, cy + 1.5, 4 * sigma0, np.inf]
    start = [amp0, min(max(float(cx), lo[1] + 1e-6), hi[1] - 1e-6), min(max(float(cy), lo[2] + 1e-6), hi[2] - 1e-6), sigma0, bg0]
    try:
        s = least_squares(res, start, bounds=(lo, hi))
    except (ValueError, RuntimeError):
        return None
    amp, x, y, sig, bg = (float(v) for v in s.x)
    if not (amp > 0 and np.isfinite(x) and np.isfinite(y)):
        return None
    return {"x": x, "y": y, "amp": amp, "sigma": sig, "bg": bg, "rms": float(np.std(s.fun)), "n": int(m.sum())}


def star_in_photo(ff: FrameFile, data: np.ndarray, x0: int, y0: int, ra: float, dec: float, search: float = 2.0) -> Optional[dict]:
    """A star measured in one photo: where the catalogue puts it (ra, dec at the time of the photo) and where the
    cut `data` (first element = full-frame pixel (x0, y0)) shows it. Returns {dE, dN: measured minus catalogue,
    arcsec; peak: fitted amplitude over the robust noise of the cut; amp, sigma}, or None when it cannot be fitted."""
    from sx.wcs import pixel_to_sky

    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    g = fit_gauss(data, px - x0, py - y0, search=search)
    if g is None:
        return None
    mra, mdec = (float(v) for v in pixel_to_sky(ff.wcs, g["x"] + x0, g["y"] + y0))
    de, dn = offset_arcsec(ra, dec, mra, mdec)
    noise = stack.robust_noise(data[np.isfinite(data)] - np.nanmedian(data))
    return {"dE": float(de), "dN": float(dn), "amp": g["amp"], "sigma": g["sigma"],
            "peak": g["amp"] / noise if noise > 0 else math.nan}


def clipped_mean(values: Sequence[float], sigma: float = 3.0) -> tuple[float, int]:
    """(mean, count) of values after dropping those farther than `sigma` robust standard deviations from the median
    (one pass, only with 4 or more values)."""
    a = np.asarray(values, float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return math.nan, 0
    if a.size >= 4:
        med = np.median(a)
        sd = 1.4826 * np.median(np.abs(a - med))
        if sd > 0:
            a = a[np.abs(a - med) <= sigma * sd]
    return float(np.mean(a)), int(a.size)


# -- sky grid ------------------------------------------------------------------------------------------


def sky_grid(ra0: float, dec0: float, n: int, scale_arcsec: float) -> WCS:
    """A square grid of n by n pixels on the tangent plane at (ra0, dec0): north up, east to the left."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    return w


def grid_xy(grid: WCS, ra: float, dec: float) -> tuple[float, float]:
    x, y = grid.all_world2pix(ra, dec, 0)
    return float(x), float(y)


def photo_on_grid(ff: FrameFile, data: np.ndarray, flags: Optional[np.ndarray], x0: int, y0: int, grid: WCS, n: int) -> Optional[np.ndarray]:
    """One cut of a photo drawn on a sky grid: the cut's background (sx.stack.stamp_stats) is subtracted, then the
    values are read at the pixel centres of the grid with sx.stack.resample (bilinear, a flat sky stays flat). A grid
    pixel that needs a flagged or missing pixel is NaN. None when the cut has too few pixels for a background."""
    st = stack.stamp_stats(data, flags)
    if st["n"] == 0:
        return None
    yy, xx = np.mgrid[:n, :n].astype(float)
    ra, dec = grid.all_pix2world(xx, yy, 0)
    fx, fy = sky_to_pixel(ff.wcs, ra, dec)
    out, _ = stack.resample(data.astype(np.float64) - st["background"], fx - x0, fy - y0, stack.valid_mask(data, flags))
    return out


def wise_on_grid(img: np.ndarray, wcs: WCS, grid: WCS, n: int) -> np.ndarray:
    """An AllWISE image drawn on a sky grid (bilinear), background (sigma-clipped median) subtracted; NaN outside it."""
    yy, xx = np.mgrid[:n, :n].astype(float)
    ra, dec = grid.all_pix2world(xx, yy, 0)
    sx, sy = wcs.all_world2pix(ra, dec, 0)
    ok = np.isfinite(img)
    v = map_coordinates(np.where(ok, img, 0.0), [sy, sx], order=1, cval=0.0)
    w = map_coordinates(ok.astype(float), [sy, sx], order=1, cval=0.0)
    out = np.where(w > 0.7, v / np.maximum(w, 1e-9), np.nan)
    return out - stack.clipped_median(out[np.isfinite(out)])


def display_range(img: np.ndarray) -> tuple[float, float]:
    """The one stretch rule: black at minus 2 times the robust noise, white at the 99.9th percentile of the image
    (at least 20 times the noise). Used for every picture of a set, from the image it shows."""
    v = img[np.isfinite(img)]
    sig = stack.robust_noise(v - np.median(v)) if v.size else 1.0
    return -2.0 * sig, max(float(np.percentile(v, 99.9)) if v.size else 20 * sig, 20.0 * sig)


# -- AllWISE ---------------------------------------------------------------------------------------------


def _get(url: str, params: Optional[dict] = None, tries: int = 5) -> bytes:
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.get(url, params=params, timeout=180)
            if r.status_code == 200:
                return r.content
            err = RuntimeError(f"status {r.status_code}")
        except requests.RequestException as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"{url} failed: {err}")


def allwise_tiles(ra: float, dec: float) -> list[dict]:
    """The AllWISE Atlas images (the science image of each band and tile) that hold a position: {band, tile, url,
    t_min, t_max, ra, dec}; the times (MJD) are those of the first and last photo in the image."""
    cache = s3.cache_dir() / f"allwise_sia_{ra:.5f}_{dec:.5f}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    from astropy.io.votable import parse_single_table

    raw = _get(ALLWISE_SIA, {"COLLECTION": "wise_allwise", "POS": f"CIRCLE {ra:.6f} {dec:.6f} 0.001"})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = parse_single_table(io.BytesIO(raw)).to_table(use_names_over_ids=True)
    out = []
    for row in table:
        url = str(row["access_url"])
        if url.endswith("-int-3.fits"):
            out.append({"band": str(row["energy_bandpassname"]), "tile": str(row["obs_id"]), "url": url,
                        "t_min": float(row["t_min"]), "t_max": float(row["t_max"]), "ra": float(row["s_ra"]),
                        "dec": float(row["s_dec"])})
    out.sort(key=lambda t: (t["band"], t["tile"]))
    cache.write_text(json.dumps(out))
    return out


def pick_tile(tiles: list[dict], ra: float, dec: float, band: str = ALLWISE_BAND) -> Optional[dict]:
    """The tile of `band` whose centre is nearest the position, or None."""
    cand = [t for t in tiles if t["band"] == band]
    if not cand:
        return None
    return min(cand, key=lambda t: (float(np.hypot(*offset_arcsec(ra, dec, t["ra"], t["dec"]))), t["tile"]))


def allwise_cutout(url: str, ra: float, dec: float, size_arcsec: int):
    """(image, WCS) of a square cut of an AllWISE Atlas image, from IRSA's cutout service; cached."""
    from astropy.io import fits

    full = f"{url}?center={ra:.6f},{dec:.6f}&size={size_arcsec:d}arcsec&gzip=false"
    cache = s3.cache_dir() / ("allwise_" + hashlib.sha1(full.encode()).hexdigest()[:16] + ".fits")
    if not cache.exists():
        cache.write_bytes(_get(full))
    with fits.open(io.BytesIO(cache.read_bytes())) as h:
        return h[0].data.astype(np.float64), WCS(h[0].header)


# -- frames of the index -------------------------------------------------------------------------------

_opened: dict[str, FrameFile] = {}


def frame(key: str) -> FrameFile:
    """The opened frame of a key; each key is opened once in a run."""
    ff = _opened.get(key)
    if ff is None:
        ff = FrameFile.open(key)
        _opened[key] = ff
    return ff


def deep_pair(frames: list[dict], det: int) -> Optional[tuple[list[dict], list[dict]]]:
    """The frames of the two visits of one detector that the visit rule compares, (earlier, later), or None when
    there are fewer than two visits that are not short."""
    vs = visits.visits(frames, det)
    p = visits.default_pair(vs)
    return None if p is None else (vs[p[0]]["frames"], vs[p[1]]["frames"])


def thin(frames: list[dict], n: int) -> list[dict]:
    """At most n frames, evenly spaced in the order given (the first and the last always stay)."""
    if len(frames) <= n:
        return list(frames)
    idx = sorted({round(i * (len(frames) - 1) / (n - 1)) for i in range(n)})
    return [frames[i] for i in idx]


def inside_margin(ff: FrameFile, px: float, py: float, margin: int) -> bool:
    return margin <= px < ff.nx - margin and margin <= py < ff.ny - margin


def core_flags(flags: Optional[np.ndarray], x: float, y: float, r: float = 2.0) -> int:
    """The OR of the flag words of the pixels within r pixels of (x, y), 0 when flags is None."""
    if flags is None:
        return 0
    h, w = flags.shape
    yy, xx = np.mgrid[:h, :w]
    m = np.hypot(xx - x, yy - y) <= r
    return int(np.bitwise_or.reduce(flags[m].astype(np.int64))) if m.any() else 0
