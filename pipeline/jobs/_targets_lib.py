"""What the jobs targets, motion and rwaur share. This file is not a job (its name starts with an underscore).

  - the named targets and their catalogue astrometry, read from site/data/names.json;
  - predict(): where the catalogue puts a star at a given time, with proper motion, parallax and, when known,
    radial velocity, as seen from near the Earth;
  - frames: opening a frame once, telling which target a frame holds, and the visit rule on bucket keys;
  - centroids: a round Gaussian fitted to a star in a stamp, and the mean position of a star over a visit;
  - a sky grid (north up, east left) and co-adds on it, built with the shared rules of sx.stack;
  - writers that add to the files several jobs share: Checks rows and the decisions of the two checks.

Angles are degrees unless a name says arcsec; times are MJD (UTC); pixels are 0-based.
"""
from __future__ import annotations

import json
import math
import os
import threading
import warnings
from dataclasses import replace
from datetime import date
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
from astropy.wcs import WCS
from scipy.optimize import least_squares

from sx import checks, display, gaia, s3, stack, visits
from sx.fits import FLAG, FrameFile
from sx.stamp import StampVar, cut
from sx.wcs import corners, on_frame, pixel_to_sky, sky_to_pixel

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
REVIEW = ROOT / "review"
NAMES_FILE = DATA / "names.json"
DECISIONS_FILE = DATA / "checks" / "decisions" / "p3.json"
PRODUCER = "p3"

PX_ARCSEC = 6.15
"""Size of a detector pixel on the sky, as the archive's documentation gives it. Used to state arcseconds in pixels."""

SAT_MASK = FLAG["OVERFLOW"] | FLAG["NONLINEAR"] | FLAG["BLOOM"]
"""The flags the page hatches as saturation (site/js/lib/flags.js, tier "saturation")."""

ARCSEC = 180.0 / math.pi * 3600.0
INK, BLUE, ORANGE, GREY, GREEN = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#2e7d32"
ROW_ORDER = ["K5", "K5-motion", "K6", "K6-rdra", "K7"]

# -- the targets ---------------------------------------------------------------------------------------


def targets() -> dict[str, dict]:
    """The entries of names.json by id."""
    return {e["id"]: e for e in json.loads(NAMES_FILE.read_text(encoding="utf-8"))["entries"]}


def predict(cat: dict, mjd):
    """(ra, dec) in degrees where the catalogue puts a star at time `mjd` (a number or an array), seen from the
    centre of the Earth. `cat` is the "catalogue" object of names.json: position at `epoch` (Julian year), proper
    motion in mas/yr (pmra includes cos(dec)), parallax in mas, radial velocity in km/s or None.

    The star is moved in space from the catalogue epoch to the time asked for (astropy's apply_space_motion); the
    direction is then taken from the Earth instead of the barycentre of the solar system, which is the parallax.
    SPHEREx and WISE circle the Earth some 7,000 km from its centre: at these distances that is below 0.001 arcsec."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord, get_body_barycentric
    from astropy.time import Time

    scalar = np.ndim(mjd) == 0
    t = Time(np.atleast_1d(np.asarray(mjd, float)), format="mjd", scale="utc")
    c = SkyCoord(ra=cat["ra"] * u.deg, dec=cat["dec"] * u.deg, distance=(1000.0 / cat["parallax"]) * u.pc,
                 pm_ra_cosdec=cat["pmra"] * u.mas / u.yr, pm_dec=cat["pmdec"] * u.mas / u.yr,
                 radial_velocity=(cat.get("rv") or 0.0) * u.km / u.s,
                 obstime=Time(cat["epoch"], format="jyear", scale="tcb"), frame="icrs")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        s = c.apply_space_motion(new_obstime=t)
    v = s.cartesian.xyz.to_value(u.au) - get_body_barycentric("earth", t).xyz.to_value(u.au)
    ra = np.degrees(np.arctan2(v[1], v[0])) % 360.0
    dec = np.degrees(np.arcsin(v[2] / np.linalg.norm(v, axis=0)))
    return (float(ra[0]), float(dec[0])) if scalar else (ra, dec)


def offset_arcsec(ra1, dec1, ra2, dec2):
    """(east, north) in arcsec of point 2 as seen from point 1, on the tangent plane at point 1."""
    a1, d1, a2, d2 = (np.radians(v) for v in (ra1, dec1, ra2, dec2))
    den = np.sin(d1) * np.sin(d2) + np.cos(d1) * np.cos(d2) * np.cos(a2 - a1)
    east = np.cos(d2) * np.sin(a2 - a1) / den
    north = (np.cos(d1) * np.sin(d2) - np.sin(d1) * np.cos(d2) * np.cos(a2 - a1)) / den
    return east * ARCSEC, north * ARCSEC


def year_of(mjd: float) -> float:
    """Julian year of an MJD."""
    return 2000.0 + (mjd - 51544.5) / 365.25


def day_of(mjd: float) -> str:
    """Calendar day (UTC) of an MJD, "2026-03-19"."""
    from astropy.time import Time

    return Time(mjd, format="mjd", scale="utc").iso[:10]


def month_of(mjd: float) -> str:
    """"March 2026" for an MJD."""
    from astropy.time import Time

    return Time(mjd, format="mjd", scale="utc").strftime("%B %Y")


# -- frames --------------------------------------------------------------------------------------------

_frames: dict[str, FrameFile] = {}
_lock = threading.Lock()


def frame(key: str) -> FrameFile:
    """The opened frame of a key; each key is opened once in a run."""
    ff = _frames.get(key)
    if ff is None:
        ff = FrameFile.open(key)
        with _lock:
            _frames.setdefault(key, ff)
    return _frames[key]


FRAME_REACH_DEG = 2.7
"""No point of a frame is farther than this from its reference point (a frame is 3.5 degrees on a side)."""


def _pixel(ff: FrameFile, ra: float, dec: float) -> Optional[tuple[float, float]]:
    """The pixel of a sky position on a frame, or None when the position is far from the frame (the inversion of
    the distortion does not converge there, and is not tried)."""
    h = ff.header
    den = (math.sin(math.radians(dec)) * math.sin(math.radians(h["CRVAL2"]))
           + math.cos(math.radians(dec)) * math.cos(math.radians(h["CRVAL2"])) * math.cos(math.radians(ra - h["CRVAL1"])))
    if math.degrees(math.acos(max(-1.0, min(1.0, den)))) > FRAME_REACH_DEG:
        return None
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    return px, py


def pixel_of(key: str, ra: float, dec: float) -> Optional[tuple[float, float]]:
    """Where a sky position falls on a frame, or None when it is not on the detector."""
    ff = frame(key)
    p = _pixel(ff, ra, dec)
    return p if p is not None and on_frame(p[0], p[1], ff.nx, ff.ny) else None


def frames_holding(keys: Iterable[str], places: dict[str, tuple[float, float]], margin: int = 0) -> dict[str, list[dict]]:
    """Sort keys by the place they hold: {name: [CT-1 frame, ...]}, each list in time order. `places` gives a sky
    position for each name; a frame goes to the first place that lies on it at least `margin` pixels from its edges.
    The places of this project are far apart, so a frame holds at most one."""
    keys = list(keys)

    def one(key: str):
        ff = frame(key)
        for name, (ra, dec) in places.items():
            p = _pixel(ff, ra, dec)
            if p is None:
                continue
            px, py = p
            if on_frame(px, py, ff.nx, ff.ny) and margin <= px < ff.nx - margin and margin <= py < ff.ny - margin:
                return name, {"key": key, "det": ff.det, "tmid": ff.mjd, "corners": [list(c) for c in corners(ff.wcs, ff.nx, ff.ny)]}
        return None, None

    out: dict[str, list[dict]] = {name: [] for name in places}
    for name, f in s3.map_threads(one, keys):
        if name is not None:
            out[name].append(f)
    for fs in out.values():
        fs.sort(key=lambda f: (f["tmid"], f["key"]))
    return out


def visit_table(frames: list[dict], det: int) -> list[dict]:
    """The visits of one detector by the shared rule, each with its dates: {frames, short, first, last, n}."""
    out = []
    for v in visits.visits(frames, det):
        out.append({**v, "n": len(v["frames"]), "first": v["frames"][0]["tmid"], "last": v["frames"][-1]["tmid"]})
    return out


_rows: dict[tuple[str, int, int], tuple[np.ndarray, np.ndarray, int]] = {}


def rows_of(key: str, y0: int, h: int) -> tuple[np.ndarray, np.ndarray, int]:
    """The whole rows y0 to y0 + h of a frame: (image, flags, the frame row of the first row returned). The same
    rows that a stamp starting at row y0 reads, so nothing new is fetched; kept in memory for the run."""
    k = (key, y0, h)
    if k not in _rows:
        ff = frame(key)
        got = (ff.image_rows(y0, y0 + h), ff.flag_rows(y0, y0 + h), max(0, y0))
        with _lock:
            _rows.setdefault(k, got)
    return _rows[k]


def stamp_at(key: str, ra: float, dec: float, size: int = 64) -> Optional[StampVar]:
    """The stamp of a frame round a sky position, with its flags."""
    return cut(frame(key), ra, dec, size=size, flags=True)


def north_up(st: StampVar, size: int) -> StampVar:
    """A stamp on the display grid, size by size: north up, east to the left, a SPHEREx pixel per pixel, centred on
    its target, by nearest neighbour (sx.display). x0 and y0 stay those of the stamp as cut. A stamp that carries
    no sky takes it from the header of its frame."""
    sky = st.sky or display.local_sky(frame(st.key).wcs, st.x0 + st.tx, st.y0 + st.ty)
    if sky is None:
        raise ValueError(f"no sky position at the target of {st.key}")
    g = display.to_display_grid(replace(st, sky=sky), size)
    return replace(st, w=size, h=size, tx=float(size // 2), ty=float(size // 2), data=g.data, flags=g.flags,
                   sky=display.grid_sky(sky), variance=None)


class Box:
    """A wide cut of the rows of a stamp: the same rows, more columns. No new rows are read for it."""

    def __init__(self, st: StampVar, width: int):
        ff = frame(st.key)
        self.key, self.det, self.mjd, self.h = st.key, st.det, st.mjd, st.h
        self.x0 = int(max(0, min(ff.nx - width, st.x0 + st.w // 2 - width // 2)))
        self.y0, self.w = st.y0, width
        self.data, self.flags, _ = ff.box(self.x0, self.y0, width, st.h, flags=True)


# -- centroids -----------------------------------------------------------------------------------------


def fit_gauss(data: np.ndarray, x0: float, y0: float, search: float = 2.0, half: int = 3, sigma0: float = 0.8,
              ok: Optional[np.ndarray] = None, fixed: Sequence[tuple[float, float]] = ()) -> Optional[dict]:
    """A round Gaussian on a constant, fitted to the box of (2 half + 1) squared pixels round the brightest usable
    pixel within `search` pixels of (x0, y0). Pixels that are not finite (or not `ok`) are left out; at least 60% of
    the box must be usable. Returns {x, y, amp, sigma, bg, rms, n, fixed_amp} in the pixels of `data`, or None when
    there is nothing to fit there. `sigma0` is the first guess of the width; the fit keeps the width within 0.3 to 4
    times it. `fixed` lists the positions of known neighbours: each is fitted as a Gaussian of the same width that
    stays where the catalogue puts it, with its own brightness (never below zero)."""
    h, w = data.shape
    good = np.isfinite(data) if ok is None else (np.isfinite(data) & ok)
    yy, xx = np.mgrid[:h, :w]
    near = good & (np.hypot(xx - x0, yy - y0) <= search)
    if not near.any():
        return None
    if fixed:  # with a neighbour in the box the brightest pixel may be the neighbour's: start from the expected place
        cx, cy = int(round(x0)), int(round(y0))
    else:
        cy, cx = divmod(int(np.argmax(np.where(near, data, -np.inf))), w)
    if not (half <= cx < w - half and half <= cy < h - half):
        return None
    sl = (slice(cy - half, cy + half + 1), slice(cx - half, cx + half + 1))
    m = good[sl]
    if m.sum() < 0.6 * m.size:
        return None
    X, Y, Z = xx[sl][m].astype(float), yy[sl][m].astype(float), data[sl][m].astype(float)
    bg0 = float(np.percentile(Z, 25))
    amp0 = max(float(data[cy, cx]) - bg0, 1e-12) if good[cy, cx] else max(float(Z.max()) - bg0, 1e-12)
    nf = len(fixed)

    def res(p):
        out = p[0] * np.exp(-((X - p[1]) ** 2 + (Y - p[2]) ** 2) / (2 * p[3] ** 2)) + p[4] - Z
        for k, (fx, fy) in enumerate(fixed):
            out = out + p[5 + k] * np.exp(-((X - fx) ** 2 + (Y - fy) ** 2) / (2 * p[3] ** 2))
        return out

    start = [amp0, float(x0) if fixed else cx, float(y0) if fixed else cy, sigma0, bg0] + [0.2 * amp0] * nf
    lo = [0, cx - 1.5, cy - 1.5, 0.3 * sigma0, -np.inf] + [0.0] * nf
    hi = [np.inf, cx + 1.5, cy + 1.5, 4 * sigma0, np.inf] + [np.inf] * nf
    start[1] = min(max(start[1], lo[1] + 1e-6), hi[1] - 1e-6)
    start[2] = min(max(start[2], lo[2] + 1e-6), hi[2] - 1e-6)
    try:
        s = least_squares(res, start, bounds=(lo, hi))
    except (ValueError, RuntimeError):
        return None
    amp, x, y, sig, bg = (float(v) for v in s.x[:5])
    if not (amp > 0 and np.isfinite(x) and np.isfinite(y)):
        return None
    return {"x": x, "y": y, "amp": amp, "sigma": sig, "bg": bg, "rms": float(np.std(s.fun)), "n": int(m.sum()),
            "fixed_amp": [float(v) for v in s.x[5:]]}


def wings_centre(data: np.ndarray, x0: float, y0: float, r_in: float, r_out: float, r_sky: tuple[float, float],
                 tol: float = 0.02, max_steps: int = 50) -> Optional[tuple[float, float, int]]:
    """The centre of a star from its wings alone, for an image whose core is spoiled by saturation: the centroid of
    the light between r_in and r_out pixels from the centre, above the median of the ring r_sky. The ring is put
    round the centre found, and the centroid taken again, until it moves by less than `tol` pixels; so the answer
    does not depend on where it was started, as long as it settles. A pixel at an edge of the ring counts by how
    far it is inside (a ramp one pixel wide): with a sharp edge, pixels jumping in and out keep the centre
    hopping by a few hundredths of a pixel for ever. Returns (x, y, steps), or None when it has not settled after
    max_steps or the ring holds no light."""
    yy, xx = np.mgrid[: data.shape[0], : data.shape[1]]
    ok = np.isfinite(data)
    x, y = float(x0), float(y0)
    for step in range(1, max_steps + 1):
        r = np.hypot(xx - x, yy - y)
        sky = data[(r >= r_sky[0]) & (r < r_sky[1]) & ok]
        if sky.size == 0:
            return None
        share = np.clip(r - r_in + 0.5, 0, 1) * np.clip(r_out - r + 0.5, 0, 1)
        w = np.where(ok, share * np.clip(np.where(ok, data, 0.0) - np.median(sky), 0, None), 0.0)
        if w.sum() <= 0:
            return None
        nx, ny = float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())
        moved = math.hypot(nx - x, ny - y)
        x, y = nx, ny
        if moved < tol:
            return x, y, step
    return None


def clipped_mean(values: Sequence[float], sigma: float = 3.0) -> tuple[float, float, int]:
    """(mean, standard error of the mean, count) of values after dropping those farther than `sigma` robust standard
    deviations from the median (one pass). With fewer than two values the error is NaN."""
    a = np.asarray(values, float)
    a = a[np.isfinite(a)]
    if a.size == 0:
        return math.nan, math.nan, 0
    if a.size >= 4:
        med = np.median(a)
        sd = 1.4826 * np.median(np.abs(a - med))
        if sd > 0:
            a = a[np.abs(a - med) <= sigma * sd]
    err = float(np.std(a, ddof=1) / math.sqrt(a.size)) if a.size > 1 else math.nan
    return float(np.mean(a)), err, int(a.size)


def star_in_frame(ff: FrameFile, data: np.ndarray, x0: int, y0: int, ra: float, dec: float, search: float = 2.0) -> Optional[dict]:
    """A star measured in one frame: where the catalogue puts it and where the image shows it.

    `data` is a cut of the frame whose first element is the full-frame pixel (x0, y0); (ra, dec) is the catalogue
    position at the time of the frame. Returns {dE, dN: the measured position minus the catalogue position, arcsec;
    ra, dec: the measured position; amp, sigma, snr}, or None when the star cannot be fitted."""
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    g = fit_gauss(data, px - x0, py - y0, search=search)
    if g is None:
        return None
    mra, mdec = (float(v) for v in pixel_to_sky(ff.wcs, g["x"] + x0, g["y"] + y0))
    de, dn = offset_arcsec(ra, dec, mra, mdec)
    noise = stack.robust_noise(data[np.isfinite(data)] - np.nanmedian(data))
    return {"dE": float(de), "dN": float(dn), "ra": mra, "dec": mdec, "amp": g["amp"], "sigma": g["sigma"],
            "snr": g["amp"] / noise if noise > 0 else math.nan}


def visit_position(rows: list[dict]) -> Optional[dict]:
    """The mean of per-frame measurements {dE, dN, mjd} of one visit: {dE, dN, eE, eN, n, mjd}, the offsets being
    measured minus catalogue in arcsec and the errors the standard errors of the means. None with fewer than 3 frames."""
    if len(rows) < 3:
        return None
    e, ee, ne = clipped_mean([r["dE"] for r in rows])
    n, en, nn = clipped_mean([r["dN"] for r in rows])
    return {"dE": e, "dN": n, "eE": ee, "eN": en, "n": min(ne, nn), "frames": len(rows),
            "mjd": float(np.mean([r["mjd"] for r in rows]))}


def field_stars(ra: float, dec: float, radius: float, gmax: float = 16.5, isolation_arcsec: float = 25.0,
                skip: Sequence[tuple[float, float]] = (), skip_arcsec: float = 40.0) -> list[dict]:
    """Gaia DR3 stars round a position that can serve as a control: brighter than `gmax`, with proper motion, no
    other star within 2.5 magnitudes closer than `isolation_arcsec`, and farther than `skip_arcsec` from the places in
    `skip` (where the target is). Each is the catalogue row of sx.gaia.cone."""
    stars = [s for s in gaia.cone(ra, dec, radius) if s["phot_g_mean_mag"] is not None]
    out = []
    for s in stars:
        if s["phot_g_mean_mag"] > gmax or s["pmra"] is None:
            continue
        de, dn = offset_arcsec(s["ra"], s["dec"], np.array([o["ra"] for o in stars]), np.array([o["dec"] for o in stars]))
        d = np.hypot(de, dn)
        g = np.array([o["phot_g_mean_mag"] for o in stars])
        if np.any((d > 0.01) & (d < isolation_arcsec) & (g < s["phot_g_mean_mag"] + 2.5)):
            continue
        if any(np.hypot(*offset_arcsec(s["ra"], s["dec"], a, b)) < skip_arcsec for a, b in skip):
            continue
        out.append(s)
    return out


# -- a sky grid and co-adds on it ----------------------------------------------------------------------


def sky_grid(ra0: float, dec0: float, n: int, scale_arcsec: float = PX_ARCSEC) -> WCS:
    """A square grid of n by n pixels on the tangent plane at (ra0, dec0): north up, east to the left, the centre
    of the grid on that point."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    return w


def on_grid(st: StampVar, grid: WCS, n: int) -> Optional[np.ndarray]:
    """One stamp on a sky grid: its background (sx.stack.stamp_stats) is subtracted, then the values are read at the
    grid's pixel centres with sx.stack.resample. A grid pixel that needs a pixel that may not be used (not finite,
    or with a flag of the saturation or defect tiers: sx.stack.usable_mask) is NaN. None when the stamp has too few
    pixels to measure a background on."""
    stats = stack.stamp_stats(st.data, st.flags)
    if stats["n"] == 0:
        return None
    yy, xx = np.mgrid[:n, :n].astype(float)
    ra, dec = grid.all_pix2world(xx, yy, 0)
    fx, fy = sky_to_pixel(frame(st.key).wcs, ra, dec)
    data, _ = stack.resample(st.data.astype(np.float64) - stats["background"], fx - st.x0, fy - st.y0,
                             stack.usable_mask(st.data, st.flags))
    return data


def local_coadd(planes: Sequence[np.ndarray], x: float, y: float, half: int = 4, clean: bool = False) -> tuple[Optional[dict], list[int]]:
    """The co-add by the shared rule (sx.stack.coadd: at each pixel the mean of the planes that may be used there,
    shown where at least half of them may) of the planes that have something to give in the box of (2 half + 1)
    squared pixels round (x, y). With `clean`, only the planes with every pixel of that box usable are taken: fewer
    photos, none of them with a hole near the source. Returns (co-add or None, the positions of the planes used)."""
    ix, iy = int(round(x)), int(round(y))
    use = []
    for i, p in enumerate(planes):
        b = p[max(0, iy - half) : iy + half + 1, max(0, ix - half) : ix + half + 1]
        if b.shape == (2 * half + 1, 2 * half + 1) and (np.isfinite(b).all() if clean else np.isfinite(b).any()):
            use.append(i)
    if not use:
        return None, use
    return stack.coadd([{"data": planes[i], "flags": None} for i in use]), use


COADD_HALF = 2
"""Half the side of the box a co-add position is fitted in: 5 by 5 pixels, beyond which a star of this telescope
has under 1% of its peak."""
COADD_MIN_PLANES = 5
"""Fewest photos a co-add position is measured on: with fewer, drawing them again says little about the error."""


def coadd_centroid(planes: Sequence[np.ndarray], x: float, y: float, search: float = 1.5, half: int = COADD_HALF,
                   n_boot: int = 200, seed: int = 1, min_planes: int = COADD_MIN_PLANES,
                   fixed: Sequence[tuple[float, float]] = (), clean: bool = False) -> Optional[dict]:
    """The position of a source in the co-add of `planes` (frames of one visit on one sky grid), near the grid
    position (x, y): {x, y, ex, ey, snr, n, ...}. The co-add is that of local_coadd: the shared rule over every
    plane, or with `clean` over the planes that have no unusable pixel in the fitted box. The errors are the
    scatter of the position over `n_boot` co-adds of the same number of planes drawn with replacement (seeded).
    None when fewer than `min_planes` planes can be used there or the co-add shows nothing to fit."""
    co, use = local_coadd(planes, x, y, half, clean)
    if co is None or len(use) < min_planes:
        return None
    g = fit_gauss(co["data"], x, y, search=search, half=half, fixed=fixed)
    if g is None:
        return None
    rs = np.random.default_rng(seed)
    pts = []
    for _ in range(n_boot):
        pick = rs.integers(0, len(use), len(use))
        b = stack.coadd([{"data": planes[use[i]], "flags": None} for i in pick])
        q = fit_gauss(b["data"], x, y, search=search, half=half, fixed=fixed)
        if q is not None:
            pts.append((q["x"], q["y"]))
    if len(pts) < max(10, n_boot // 2):
        return None
    pts = np.array(pts)
    return {"x": g["x"], "y": g["y"], "ex": float(pts[:, 0].std()), "ey": float(pts[:, 1].std()),
            "snr": g["amp"] / co["noise"] if co["noise"] > 0 else math.nan, "n": len(use), "amp": g["amp"],
            "sigma": g["sigma"], "noise": co["noise"], "coadd": co["data"], "boot_ok": len(pts),
            "fixed_amp": g["fixed_amp"], "used": use}


# -- a mover, measured in one visit --------------------------------------------------------------------

GRID = 64
"""Side of the sky grid a visit is co-added on, in pixels of the detector's size."""
NEIGHBOUR_ARCSEC = 12.0
NEIGHBOUR_GMAX = 18.5
"""A Gaia star brighter than this, closer than NEIGHBOUR_ARCSEC (two pixels) to a faint mover, is fitted with it."""


def mover_frames(frames: Sequence[dict], cat: dict, ra0: float, dec0: float) -> list[dict]:
    """A bright mover measured in each frame of a list: {key, mjd, dE, dN, ra, dec, snr, cat_ra, cat_dec}. The
    stamp is cut round the fixed position (ra0, dec0); the star is looked for where the catalogue puts it at the
    time of the frame, and dE, dN are the measured position minus that, in arcsec."""

    def one(f: dict):
        st = stamp_at(f["key"], ra0, dec0)
        if st is None:
            return None
        ra, dec = predict(cat, st.mjd)
        m = star_in_frame(frame(f["key"]), st.data, st.x0, st.y0, ra, dec)
        if m is None:
            return None
        return {"key": f["key"], "mjd": st.mjd, **m, "cat_ra": ra, "cat_dec": dec}

    return [r for r in s3.map_threads(one, list(frames)) if r]


def planes_of(frames: Sequence[dict], ra0: float, dec0: float, n: int = GRID):
    """The frames of a visit on one sky grid centred on (ra0, dec0): (grid, planes, their times)."""
    grid = sky_grid(ra0, dec0, n)

    def one(f: dict):
        st = stamp_at(f["key"], ra0, dec0)
        if st is None:
            return None
        p = on_grid(st, grid, n)
        return None if p is None else (p, st.mjd)

    got = [g for g in s3.map_threads(one, list(frames)) if g]
    return grid, [g[0] for g in got], [g[1] for g in got]


def neighbours_of(ra: float, dec: float, mjd: float, radius_arcsec: float = NEIGHBOUR_ARCSEC,
                  gmax: float = NEIGHBOUR_GMAX, search_deg: float = 0.02) -> list[dict]:
    """Gaia DR3 stars closer than radius_arcsec to a position at time mjd (their own motion applied), brighter than
    gmax: {source_id, G, ra, dec, sep_arcsec}, nearest first. The cone is asked for round the position rounded to
    0.01 degree, so that one answer serves all visits."""
    stars = [s for s in gaia.cone(round(ra, 2), round(dec, 2), search_deg) if s["phot_g_mean_mag"] is not None]
    if not stars:
        return []
    sra, sdec = gaia.propagate(stars, mjd)
    out = []
    for s, a, d in zip(stars, sra, sdec):
        sep = float(np.hypot(*offset_arcsec(ra, dec, a, d)))
        if sep <= radius_arcsec and s["phot_g_mean_mag"] <= gmax:
            out.append({"source_id": s["source_id"], "G": float(s["phot_g_mean_mag"]), "ra": float(a), "dec": float(d),
                        "sep_arcsec": sep})
    return sorted(out, key=lambda o: o["sep_arcsec"])


def mover_coadd(frames: Sequence[dict], cat: dict, ra0: float, dec0: float, n_boot: int = 200, clean: bool = False) -> Optional[dict]:
    """A faint mover measured in the co-add of one visit: {dE, dN, eE, eN, n, frames, mjd, ra, dec, cat_ra,
    cat_dec, snr, neighbours, image}. The frames go onto one sky grid and are co-added by the shared rule (with
    `clean`, only those with no unusable pixel round the target), and a Gaussian is fitted where the catalogue puts
    the mover (the mean of its positions at the times of the frames). dE, dN: measured minus catalogue, arcsec;
    eE, eN: from drawing the frames again. None when the visit cannot be measured (see coadd_centroid)."""
    grid, planes, mjds = planes_of(frames, ra0, dec0)
    if not planes:
        return None
    ra, dec = predict(cat, np.array(mjds))
    gx, gy = grid.all_world2pix(ra, dec, 0)
    x, y = float(np.mean(gx)), float(np.mean(gy))
    near = neighbours_of(float(np.mean(ra)), float(np.mean(dec)), float(np.mean(mjds)))
    fixed = [tuple(float(v) for v in grid.all_world2pix(o["ra"], o["dec"], 0)) for o in near]
    c = coadd_centroid(planes, x, y, n_boot=n_boot, fixed=fixed, clean=clean)
    if c is None:
        return {"n": len(local_coadd(planes, x, y, COADD_HALF, clean)[1]), "frames": len(planes), "measured": False}
    used = [mjds[i] for i in c["used"]]
    ura, udec = predict(cat, np.array(used))
    cra, cdec = float(np.mean(ura)), float(np.mean(udec))
    mra, mdec = (float(v) for v in grid.all_pix2world(c["x"], c["y"], 0))
    de, dn = offset_arcsec(cra, cdec, mra, mdec)
    for o, a in zip(near, c["fixed_amp"]):
        o["amp_over_target"] = a / c["amp"]
    return {"measured": True, "dE": float(de), "dN": float(dn), "eE": c["ex"] * PX_ARCSEC, "eN": c["ey"] * PX_ARCSEC,
            "n": c["n"], "frames": len(planes), "mjd": float(np.mean(used)), "ra": mra, "dec": mdec, "cat_ra": cra,
            "cat_dec": cdec, "snr": c["snr"], "neighbours": near, "image": c["coadd"], "grid": grid, "planes": planes,
            "mjds": mjds}


STAR_HALF = 10
"""Half the side of the cut round a field star that is co-added: 21 by 21 pixels."""


def star_coadd(frames: Sequence[dict], star: dict, ra0: float, dec0: float, n_boot: int = 60) -> Optional[dict]:
    """A field star measured in the co-add of a visit, the way mover_coadd measures the mover: {dE, dN, eE, eN, n,
    snr}, measured minus the Gaia position at the mean time of the frames, arcsec.

    The star is cut out of the rows that were read for the target (the stamp round (ra0, dec0)), so it may lie
    anywhere along those rows; each cut goes onto a small sky grid centred on the star, and the frames are
    co-added by the shared rule. None when the star is in too few frames."""
    half, n = STAR_HALF, 2 * STAR_HALF + 1
    frames = list(frames)
    if not frames:
        return None
    sra, sdec = (float(v[0]) for v in gaia.propagate([star], float(np.mean([f["tmid"] for f in frames]))))
    grid = sky_grid(sra, sdec, n)
    planes = []
    for f in frames:
        ff = frame(f["key"])
        t = _pixel(ff, ra0, dec0)
        p = _pixel(ff, sra, sdec)
        if t is None or p is None or not on_frame(t[0], t[1], ff.nx, ff.ny):
            continue
        y0 = int(math.floor(t[1] + 0.5)) - GRID // 2  # the first row of the target's stamp: the rows already read
        ix, iy = int(math.floor(p[0] + 0.5)), int(math.floor(p[1] + 0.5))
        if not (half <= ix < ff.nx - half and max(0, y0) + half <= iy < min(ff.ny, y0 + GRID) - half):
            continue
        img, flg, ya = rows_of(f["key"], y0, GRID)
        sl = (slice(iy - half - ya, iy + half + 1 - ya), slice(ix - half, ix + half + 1))
        st = StampVar(key=f["key"], det=ff.det, mjd=ff.mjd, w=n, h=n, x0=ix - half, y0=iy - half, tx=p[0] - ix + half,
                      ty=p[1] - iy + half, lam=math.nan, bw=math.nan, data=img[sl], flags=flg[sl])
        plane = on_grid(st, grid, n)
        if plane is not None:
            planes.append(plane)
    if len(planes) < COADD_MIN_PLANES:
        return None
    c = coadd_centroid(planes, float(half), float(half), n_boot=n_boot, seed=2)
    if c is None:
        return None
    mra, mdec = (float(v) for v in grid.all_pix2world(c["x"], c["y"], 0))
    de, dn = offset_arcsec(sra, sdec, mra, mdec)
    return {"dE": float(de), "dN": float(dn), "eE": c["ex"] * PX_ARCSEC, "eN": c["ey"] * PX_ARCSEC, "n": c["n"],
            "snr": c["snr"]}


def stars_in_rows(frames: Sequence[dict], stars: Sequence[dict], ra0: float, dec0: float, margin: int = STAR_HALF) -> np.ndarray:
    """For each star, in how many of the frames it lies inside the rows read for the target (the stamp round
    (ra0, dec0)), at least `margin` pixels from their edges. Cheap: one transform per frame for all stars."""
    stars = list(stars)
    count = np.zeros(len(stars), int)
    if not stars:
        return count
    for f in frames:
        ff = frame(f["key"])
        t = _pixel(ff, ra0, dec0)
        if t is None:
            continue
        y0 = int(math.floor(t[1] + 0.5)) - GRID // 2
        sra, sdec = gaia.propagate(stars, ff.mjd)
        try:
            x, y = sky_to_pixel(ff.wcs, sra, sdec)
        except Exception:  # a star far off the detector: the inversion of the distortion does not converge
            xy = [_pixel(ff, float(a), float(d)) or (math.nan, math.nan) for a, d in zip(sra, sdec)]
            x, y = np.array([q[0] for q in xy]), np.array([q[1] for q in xy])
        with np.errstate(invalid="ignore"):
            count += ((x >= margin) & (x < ff.nx - margin) & (y >= max(0, y0) + margin) & (y < min(ff.ny, y0 + GRID) - margin))
    return count


def stars_frames(frames: Sequence[dict], stars: Sequence[dict], ra0: float, dec0: float, width: int = 192,
                 min_snr: float = 30.0) -> dict[str, list[dict]]:
    """Field stars measured in each frame of a list, in a cut `width` pixels wide of the rows of the target's stamp:
    {source_id: [{mjd, dE, dN, snr}, ...]}, measured minus the Gaia position at the time of the frame, arcsec. A
    star counts in a frame when its peak is at least min_snr times the noise and it is found within a pixel of
    where Gaia puts it."""
    stars = list(stars)

    def one(f: dict):
        st = stamp_at(f["key"], ra0, dec0)
        if st is None:
            return []
        box = Box(st, width)
        ff = frame(f["key"])
        sra, sdec = gaia.propagate(stars, st.mjd)
        px, py = sky_to_pixel(ff.wcs, sra, sdec)
        out = []
        for s, a, d, x, y in zip(stars, sra, sdec, px, py):
            if not (box.x0 + 5 <= x < box.x0 + box.w - 5 and box.y0 + 5 <= y < box.y0 + box.h - 5):
                continue
            m = star_in_frame(ff, box.data, box.x0, box.y0, float(a), float(d), search=1.5)
            if m is not None and m["snr"] >= min_snr and math.hypot(m["dE"], m["dN"]) < PX_ARCSEC:
                out.append((s["source_id"], {"mjd": st.mjd, "dE": m["dE"], "dN": m["dN"], "snr": m["snr"]}))
        return out

    by: dict[str, list[dict]] = {}
    for rows in s3.map_threads(one, list(frames)):
        for sid, r in rows:
            by.setdefault(sid, []).append(r)
    return by


# -- files that several jobs write ---------------------------------------------------------------------


def update_card(target: str, parts: dict, folder: Optional[Path] = None) -> Path:
    """Add fields to site/data/targets/<target>/card.json (what the page needs to draw a target's card beyond its
    showcase). Fields already there stay unless `parts` names them. `folder`: the folder of the targets (tests)."""
    path = (DATA / "targets" if folder is None else Path(folder)) / target / "card.json"
    have = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    have.update(parts)
    checks.write_json(path, have)
    return path


def reviewer_from(argv: list[str]) -> Optional[tuple[str, str]]:
    """(role, date) of `--reviewed "<role>" <YYYY-MM-DD>`, or None."""
    if "--reviewed" not in argv:
        return None
    i = argv.index("--reviewed")
    role, day = argv[i + 1], argv[i + 2]
    date.fromisoformat(day)
    return role, day


def put_rows(rows: list[dict], folder: Optional[Path] = None) -> Path:
    """Add rows to the Checks rows of this producer: a row with the id of one already there replaces it, the others
    stay. The file keeps one order whichever job wrote last. `folder`: where the file is (tests)."""
    folder = checks.ROWS_DIR if folder is None else Path(folder)
    path = folder / f"{PRODUCER}.json"
    have = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    by_id = {r["id"]: r for r in have}
    by_id.update({r["id"]: r for r in rows})
    order = [i for i in ROW_ORDER if i in by_id] + sorted(i for i in by_id if i not in ROW_ORDER)
    return checks.write_rows(PRODUCER, [by_id[i] for i in order], folder)


def put_decision(part: str, entries: dict[str, dict], path: Optional[Path] = None) -> Path:
    """Write the outcome of a check that decides a part: {"S1": {target: {build, why}}, "S2": {band: {build, why}}}.
    `part` is "S1" or "S2"; the other part stays as it is. `path`: the file (tests)."""
    path = DECISIONS_FILE if path is None else Path(path)
    if part not in ("S1", "S2"):
        raise ValueError(f"no part {part!r}")
    have = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    for k, v in entries.items():
        if set(v) != {"build", "why"} or not isinstance(v["build"], bool) or not isinstance(v["why"], str):
            raise ValueError(f"decision {part}.{k} must be {{build: true or false, why: text}}")
    have[part] = entries
    checks.write_json(path, dict(sorted(have.items())))
    return path


def save_figure(fig, path: Path, dpi: int = 130) -> Path:
    """Save a matplotlib figure as PNG without the lines that name the software."""
    import matplotlib.pyplot as plt

    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=dpi, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    return path


def write_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)
    return path
