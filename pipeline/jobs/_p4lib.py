"""What the jobs diffcheck, limits and falsepos share. This file is not a job (its name starts with an underscore).

A position, a detector and two visits give matched pairs of photos (sx.visits, sx.match). Each photo is cut as a 96 by
96 stamp, loses its own background (sx.stack) and is read onto one 64 by 64 sky grid of 6.15 arcsec pixels, north up
and east left, with the distortion of the frame (all_world2pix) and sx.stack.resample. The planes of a visit are added
with sx.stack.coadd and two co-adds are subtracted with sx.stack.difference. Only pixels whose colour matches in
every pair of a view are used (sx.match.matched_mask). Nothing here has a rule of its own for background, noise,
visits or matching.

Angles are degrees unless a name says arcsec or px; times are MJD (UTC); pixels are 0-based.
"""
from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

import numpy as np
from astropy.wcs import WCS

from sx import checks, index, match, s3, stack, visits, wave
from sx.fits import FrameFile
from sx.stamp import StampVar, cut
from sx.wcs import sky_to_pixel, stamp_origin

GRID = 64
"""Side of the sky grid, pixels."""
STAMP = 96
"""Side of the cut of each photo. A grid turned by any angle fits inside it."""
PX_ARCSEC = 6.15
"""Size of one pixel on the sky, as the archive's documentation gives it."""
MIN_PAIRS = 3
"""Fewest matched pairs a run is made of."""
PIXEL_SR = (PX_ARCSEC / 206264.80624709636) ** 2
"""Solid angle of a pixel, steradians."""
MJY_SR_PX_TO_MJY = PIXEL_SR * 1e9
"""Multiply a sum over pixels in MJy/sr by this to get a flux in mJy."""


# -- the sky grid and the frames -------------------------------------------------------------------------


def sky_grid(ra0: float, dec0: float, n: int = GRID) -> WCS:
    """A square grid of n by n pixels on the tangent plane at (ra0, dec0): north up, east to the left, centred
    on that point."""
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.cdelt = [-PX_ARCSEC / 3600.0, PX_ARCSEC / 3600.0]
    w.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    return w


_frames: dict[str, FrameFile] = {}
_lock = threading.Lock()


def open_frame(key: str) -> FrameFile:
    ff = _frames.get(key)
    if ff is None:
        ff = FrameFile.open(key)
        with _lock:
            _frames.setdefault(key, ff)
    return _frames[key]


def stamp_fits(ff: FrameFile, ra: float, dec: float) -> Optional[tuple[float, float]]:
    """The pixel of the position when a whole STAMP lies on the detector round it, else None."""
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    x0, y0 = stamp_origin(px, py, STAMP, STAMP)
    if x0 < 0 or y0 < 0 or x0 + STAMP > ff.nx or y0 + STAMP > ff.ny:
        return None
    return px, py


# -- the plan: visits and matched pairs ------------------------------------------------------------------


@dataclass
class Plan:
    ra: float
    dec: float
    det: int
    ok: bool
    why: str = ""
    infos_a: list = field(default_factory=list)  # one dict per photo of the earlier visit: key, mjd, px, py, lam, bw
    infos_b: list = field(default_factory=list)
    pairs: list = field(default_factory=list)  # (position in infos_a, position in infos_b)
    visits: list = field(default_factory=list)  # [{n, first, last, short}] of the detector's visits
    visit_pair: Optional[tuple] = None
    n_index: int = 0  # frames of the detector the index lists for the position
    n_usable: int = 0  # of those, the frames that hold a whole stamp
    info: dict = field(default_factory=dict)  # key -> the same dicts, for every usable frame
    visit_keys: list = field(default_factory=list)  # the keys of each visit of `visits`

    @property
    def dt_days(self) -> float:
        a = np.mean([i["mjd"] for i in self.infos_a])
        b = np.mean([i["mjd"] for i in self.infos_b])
        return float(b - a)


def plan(ra: float, dec: float, det: int, min_pairs: int = MIN_PAIRS, visit_pair: Optional[tuple] = None) -> Plan:
    """Visits and matched pairs of a position in one detector, by the shared rules. The two visits are the default pair
    unless `visit_pair` (positions in the visits of the detector, the earlier first) names others."""
    fr = [f for f in index.frames_covering(ra, dec) if f["det"] == det]
    p = Plan(ra, dec, det, False, n_index=len(fr))

    def one(f):
        ff = open_frame(f["key"])
        at = stamp_fits(ff, ra, dec)
        if at is None:
            return None
        lb = wave.wavelength_at(det, at[0], at[1])
        return {"key": f["key"], "det": det, "tmid": f["tmid"], "mjd": ff.mjd, "px": at[0], "py": at[1],
                "lam": lb["lam"], "bw": lb["bw"], "y0": stamp_origin(at[0], at[1], STAMP, STAMP)[1], "h": STAMP}

    info = {i["key"]: i for i in s3.map_threads(one, fr) if i}
    p.n_usable = len(info)
    frames = [{"key": k, "det": det, "tmid": i["tmid"], "corners": []} for k, i in info.items()]
    vs = visits.visits(frames, det)
    p.visits = [{"n": len(v["frames"]), "first": v["frames"][0]["tmid"], "last": v["frames"][-1]["tmid"], "short": v["short"]} for v in vs]
    p.info = info
    p.visit_keys = [[f["key"] for f in v["frames"]] for v in vs]
    vp = visit_pair or visits.default_pair(vs)
    if vp is None:
        p.why = "fewer than two visits with 3 photos or more"
        return p
    p.visit_pair = vp
    a, b = vs[vp[0]]["frames"], vs[vp[1]]["frames"]
    ia, ib = [info[f["key"]] for f in a], [info[f["key"]] for f in b]
    pairs = match.match_pairs(ia, ib)
    p.infos_a, p.infos_b, p.pairs = ia, ib, [(int(i), int(j)) for i, j in pairs]
    if len(p.pairs) < min_pairs:
        p.why = f"{len(p.pairs)} matched pairs"
        return p
    p.ok = True
    return p


# -- stamps and planes -----------------------------------------------------------------------------------


@dataclass
class Plane:
    key: str
    mjd: float
    data: np.ndarray  # (GRID, GRID) float64, background removed, NaN where not valid
    valid: np.ndarray  # bool
    quiet: np.ndarray  # bool
    lam: np.ndarray  # (GRID, GRID) colour of each grid pixel in this photo, um
    bw: np.ndarray
    background: float
    noise: float  # robust noise of the stamp


def load_stamps(infos: Sequence[dict], ra: float, dec: float) -> dict[str, StampVar]:
    """The STAMP by STAMP cuts of photos round a position, with flags, read in parallel."""

    def one(i):
        return i["key"], cut(open_frame(i["key"]), ra, dec, size=STAMP, flags=True)

    return {k: st for k, st in s3.map_threads(one, list(infos)) if st is not None}


def add_gaussian(data: np.ndarray, x0: int, y0: int, x: float, y: float, amp: float, sigma: float) -> np.ndarray:
    """A copy of a stamp with a round Gaussian of peak `amp` at the full-frame pixel (x, y) added."""
    h, w = data.shape
    yy, xx = np.mgrid[:h, :w]
    g = amp * np.exp(-(((xx + x0) - x) ** 2 + ((yy + y0) - y) ** 2) / (2.0 * sigma * sigma))
    return (data.astype(np.float64) + g).astype(np.float32)


def make_plane(st: StampVar, grid: WCS, inject: Optional[dict] = None, n: int = GRID, show_flagged: bool = False) -> Optional[Plane]:
    """One photo on the sky grid. `inject` = {ra, dec, amp, sigma}: a Gaussian is added to the photo first, at that
    place on the sky, before its background is measured. With `show_flagged` the pixels that carry a flag are kept (as the
    stage draws them, hatched) instead of being left out; the background is still measured on the quiet pixels. None when
    the stamp is too empty to measure a background."""
    ff = open_frame(st.key)
    data = st.data
    if inject is not None:
        ix, iy = (float(v) for v in sky_to_pixel(ff.wcs, inject["ra"], inject["dec"]))
        data = add_gaussian(data, st.x0, st.y0, ix, iy, inject["amp"], inject["sigma"])
    stats = stack.stamp_stats(data, st.flags)
    if stats["n"] == 0:
        return None
    yy, xx = np.mgrid[:n, :n].astype(float)
    gra, gdec = grid.all_pix2world(xx, yy, 0)
    fx, fy = sky_to_pixel(ff.wcs, gra, gdec)
    mx, my = fx - st.x0, fy - st.y0
    d = data.astype(np.float64) - stats["background"]
    shown = np.isfinite(data).astype(np.uint8) if show_flagged else stack.valid_mask(data, st.flags)
    img, ok_v = stack.resample(d, mx, my, shown)
    _, ok_q = stack.resample(d, mx, my, stack.quiet_mask(data, st.flags))
    wb = wave.wavelength_at(st.det, np.clip(fx, 0, ff.nx - 1), np.clip(fy, 0, ff.ny - 1))
    valid = ok_v.astype(bool)
    quiet = ok_q.astype(bool) & valid
    return Plane(st.key, st.mjd, np.where(valid, img, np.nan).astype(np.float64), valid, quiet,
                 np.asarray(wb["lam"]), np.asarray(wb["bw"]), float(stats["background"]), float(stats["noise"]))


def as_stamp(p: Plane) -> dict:
    """A plane in the form sx.stack.coadd reads: quiet pixels carry no flag, valid ones that are not quiet carry the
    SOURCE flag (valid but not used for the background), the rest carry a defect flag."""
    flags = np.where(p.quiet, 0, np.where(p.valid, stack.FLAG_SOURCE, 1)).astype(np.int32)
    return {"data": p.data, "flags": flags}


def pair_matched(a: Plane, b: Plane) -> np.ndarray:
    """(GRID, GRID) bool: the colours of the two photos agree there (sx.match.matched_mask)."""
    m = {"lamA": a.lam.ravel(), "bwA": a.bw.ravel(), "lamB": b.lam.ravel(), "bwB": b.bw.ravel()}
    return match.matched_mask([m], a.lam.size).reshape(a.lam.shape).astype(bool)


def restrict(co: dict, keep: np.ndarray) -> dict:
    """A co-add that only counts the pixels of `keep`."""
    out = dict(co)
    out["valid"] = (co["valid"].astype(bool) & keep).astype(np.uint8)
    out["quiet"] = (co["quiet"].astype(bool) & keep).astype(np.uint8)
    return out


def difference_of(planes_a: Sequence[Plane], planes_b: Sequence[Plane]) -> dict:
    """The difference later minus earlier of the co-adds of two lists of planes that are matched in pairs (the
    n-th of one with the n-th of the other). Only pixels that match in every pair are used. Returns the
    sx.stack.difference dictionary with `matched`, `n_pairs`, `coadd_a` and `coadd_b` added."""
    maps = [{"lamA": a.lam.ravel(), "bwA": a.bw.ravel(), "lamB": b.lam.ravel(), "bwB": b.bw.ravel()}
            for a, b in zip(planes_a, planes_b)]
    matched = match.matched_mask(maps, planes_a[0].lam.size).reshape(planes_a[0].lam.shape).astype(bool)
    ca = restrict(stack.coadd([as_stamp(p) for p in planes_a]), matched)
    cb = restrict(stack.coadd([as_stamp(p) for p in planes_b]), matched)
    d = stack.difference(ca, cb)
    d["matched"] = matched
    d["quiet"] = (ca["quiet"].astype(bool) & cb["quiet"].astype(bool) & d["valid"].astype(bool))
    d["n_pairs"] = len(planes_a)
    d["coadd_a"], d["coadd_b"] = ca, cb
    return d


# -- the tests -------------------------------------------------------------------------------------------


def used_pixels(d: dict) -> tuple[np.ndarray, str]:
    """The pixels the zero-mean test is made on: the quiet ones (no flag other than FULLSAMPLE in either photo, so stars are
    left out, as they are for the background), or, when fewer than stack.MIN_PIXELS of those are left, all the shown pixels,
    as sx.stack does for the background and the noise. Returns (boolean mask, "quiet" or "valid")."""
    q = d["quiet"] if "quiet" in d else d["valid"].astype(bool)
    if int(q.sum()) >= stack.MIN_PIXELS:
        return q, "quiet"
    return d["valid"].astype(bool), "valid"


def mean_test(d: dict) -> dict:
    """The mean of a difference over its used pixels (see used_pixels) and how many standard errors it is from zero. The
    error is the robust scatter of the difference over the square root of the number of pixels (pixels counted as
    independent)."""
    v, basis = used_pixels(d)
    n = int(v.sum())
    if n == 0 or not np.isfinite(d["scatter"]) or d["scatter"] <= 0:
        return {"n": n, "ok": False, "basis": basis}
    vals = d["diff"][v].astype(np.float64)
    mean = float(np.mean(vals))
    se = float(d["scatter"] / math.sqrt(n))
    out = {"ok": True, "n": n, "basis": basis, "mean_mjysr": mean, "mean_units": mean / d["sigma"], "scatter_mjysr": float(d["scatter"]),
           "sigma_mjysr": float(d["sigma"]), "scatter_over_sigma": float(d["scatter"] / d["sigma"]), "se_mjysr": se, "z": mean / se}
    # For comparison only, not the rule: the same after dropping pixels beyond 5 times the scatter from the median, as the
    # earlier background test did before it took the mean.
    keep = np.abs(vals - np.median(vals)) <= 5.0 * d["scatter"]
    if keep.sum() >= 2:
        out["z_clip"] = float(np.mean(vals[keep]) / (d["scatter"] / math.sqrt(int(keep.sum()))))
        out["n_clip"] = int(keep.sum())
    return out


def disc(cx: float, cy: float, r: float, n: int = GRID) -> np.ndarray:
    yy, xx = np.mgrid[:n, :n]
    return np.hypot(xx - cx, yy - cy) <= r


def pair_test(units: np.ndarray, cx: float, cy: float, r: float = 3.0, thr: float = 3.0, min_finite: float = 0.4) -> dict:
    """Does the difference show a dark-bright pair at a star? Within r pixels of (cx, cy), one pixel at +thr noise
    units or more and another at -thr or less, among the pixels the view shows (the finite ones). A disc with under
    `min_finite` of its pixels shown cannot be tested."""
    m = disc(cx, cy, r, units.shape[0])
    v = units[m]
    frac = float(np.isfinite(v).mean()) if v.size else 0.0
    if frac < min_finite:
        return {"testable": False, "pair": False, "finite": frac}
    hi, lo = float(np.nanmax(v)), float(np.nanmin(v))
    return {"testable": True, "pair": bool(hi >= thr and lo <= -thr), "max_units": hi, "min_units": lo, "finite": frac}


def aperture_sum(arr: np.ndarray, cx: float, cy: float, r: float) -> tuple[float, int]:
    """Sum of the finite pixels within r of (cx, cy) and how many there are."""
    m = disc(cx, cy, r, arr.shape[0]) & np.isfinite(arr)
    return float(arr[m].sum()), int(m.sum())


# -- an injected source ----------------------------------------------------------------------------------


def gaussian_total(amp: float, sigma: float) -> float:
    """Sum over pixels of a round Gaussian of peak `amp` (in the unit of amp, per pixel)."""
    return amp * 2.0 * math.pi * sigma * sigma


def offset_to_sky(ra0: float, dec0: float, dx_px: float, dy_px: float) -> tuple[float, float]:
    """The sky position dx_px pixels to the right and dy_px up on the grid of sky_grid(ra0, dec0)."""
    g = sky_grid(ra0, dec0)
    c = (GRID - 1) / 2.0
    ra, dec = g.all_pix2world(c + dx_px, c + dy_px, 0)
    return float(ra), float(dec)


def grid_xy(grid: WCS, ra: float, dec: float) -> tuple[float, float]:
    x, y = grid.all_world2pix(ra, dec, 0)
    return float(x), float(y)


def gaussian_image(cx: float, cy: float, amp: float, sigma: float, n: int = GRID) -> np.ndarray:
    yy, xx = np.mgrid[:n, :n]
    return amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2.0 * sigma * sigma))


def unit_sigma(d: dict) -> float:
    return float(d["sigma"])


# -- the file of rows that diffcheck and limits both write ------------------------------------------------

PRODUCER = "p4"
ROW_ORDER = ["K8", "K10"]


def put_rows(rows: list[dict]) -> "Path":
    """Add rows to the Checks rows of this producer: a row with the id of one already there replaces it, the others
    stay, and the file keeps one order whichever job wrote last."""
    path = checks.ROWS_DIR / f"{PRODUCER}.json"
    have = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    by = {r["id"]: r for r in have}
    by.update({r["id"]: r for r in rows})
    ordered = [by[i] for i in ROW_ORDER if i in by] + [by[i] for i in sorted(by) if i not in ROW_ORDER]
    return checks.write_rows(PRODUCER, ordered)
