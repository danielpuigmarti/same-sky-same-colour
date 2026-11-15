"""Aperture photometry on a stamp, with the ring and the errors stated.

Rule, the same for every job:
  - pixels are used when they are finite in image and variance and carry no bit of BAD_MASK in FLAGS
    (all finite pixels when no flags are given);
  - the aperture is every pixel whose centre lies within r_ap pixels of the target (whole pixels);
  - the background is the sigma-clipped median (3 sigma, 5 passes, sigma = 1.4826 x MAD) of the usable pixels
    in the ring r_in <= r < r_out, leaving out pixels flagged SOURCE unless told not to; its scatter is the
    standard deviation of the pixels that stay;
  - flux = sum over the usable aperture pixels of (value - background), scaled by n_aperture / n_usable to
    stand in for the missing pixels, times the solid angle of a pixel; an aperture with fewer than
    MIN_FRACTION of its pixels usable gives NaN;
  - error: the variance of the aperture sum from VARIANCE (scaled the same way) plus the uncertainty of the
    background, (n_aperture x scatter)^2 x (pi / 2) / n_ring, where pi / 2 is the variance of a median of
    Gaussian values relative to that of a mean.
Fluxes come out in mJy: MJy/sr times sr is MJy, times 1e9 is mJy.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .fits import FLAG

BAD_MASK = sum(FLAG[n] for n in ("TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD",
                                  "NONLINEAR", "PERSIST"))
"""Bits that make a pixel unusable."""

SOURCE = FLAG["SOURCE"]
MIN_FRACTION = 0.6
MJY_TO_MJY = 1e9
CLIP_SIGMA, CLIP_PASSES, MAD_TO_SIGMA = 3, 5, 1.4826


@dataclass
class Photometry:
    flux: float  # mJy
    err: float  # mJy
    bkg: float  # MJy/sr
    bkg_sd: float  # MJy/sr
    n_ring: int  # pixels that set the background
    n_ap: int  # pixels in the aperture
    n_use: int  # usable pixels in the aperture
    n_source: int  # SOURCE-flagged pixels in the aperture


def clipped_median(a: np.ndarray) -> tuple[float, float, int]:
    """(median, standard deviation, count) of the values left after the clipping of the module's rule."""
    m = np.ones(a.size, bool)
    for _ in range(CLIP_PASSES):
        med = np.median(a[m])
        sd = MAD_TO_SIGMA * np.median(np.abs(a[m] - med))
        keep = np.abs(a - med) < CLIP_SIGMA * sd
        if keep.sum() < 3:
            break
        m = keep
    return float(np.median(a[m])), float(np.std(a[m])), int(m.sum())


def aperture(data: np.ndarray, var: Optional[np.ndarray], flags: Optional[np.ndarray], cx: float, cy: float,
             r_ap: float, ring: tuple[float, float], omega_sr: float, skip_source_in_ring: bool = True
             ) -> Optional[Photometry]:
    """Flux in mJy of the source at (cx, cy) in stamp pixels. `var` may be None (the error then holds only the
    background term). Pixels flagged SOURCE are left out of the ring unless skip_source_in_ring is False (in a
    crowded field, or where the source mask covers much of the sky, too few pixels would stay). Returns None when
    the ring holds fewer than 20 usable pixels."""
    ny, nx = data.shape
    yy, xx = np.mgrid[:ny, :nx]
    r = np.hypot(xx - cx, yy - cy)
    good = np.isfinite(data)
    if var is not None:
        good &= np.isfinite(var)
    if flags is not None:
        good &= (flags & BAD_MASK) == 0
    ring_ok = good & (r >= ring[0]) & (r < ring[1])
    if flags is not None and skip_source_in_ring:
        ring_ok &= (flags & SOURCE) == 0
    a = data[ring_ok]
    if a.size < 20:
        return None
    bkg, sd, n_ring = clipped_median(a)
    ap = r <= r_ap
    n_ap = int(ap.sum())
    use = ap & good
    n_use = int(use.sum())
    n_src = int(((flags & SOURCE) != 0)[ap].sum()) if flags is not None else 0
    if n_use < MIN_FRACTION * n_ap:
        return Photometry(math.nan, math.nan, bkg, sd, n_ring, n_ap, n_use, n_src)
    scale = n_ap / n_use
    total = float(np.sum(data[use] - bkg)) * scale
    v = (float(np.sum(var[use])) * scale**2 if var is not None else 0.0) + (n_ap * sd) ** 2 * (math.pi / 2) / n_ring
    return Photometry(total * omega_sr * MJY_TO_MJY, math.sqrt(v) * omega_sr * MJY_TO_MJY, bkg, sd, n_ring,
                      n_ap, n_use, n_src)
