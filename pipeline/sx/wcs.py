"""Sky and pixel positions on a frame. Pixels are 0-based, whole numbers at pixel centres, first row at the lowest y.

Sky to pixel always goes through all_world2pix, which inverts the SIP distortion by iteration; the version
without the distortion terms (wcs_world2pix) is off by up to about 3 pixels at the edge of a detector and is
never used here.
"""
from __future__ import annotations

import math
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

warnings.simplefilter("ignore", FITSFixedWarning)


def make_wcs(header: fits.Header) -> WCS:
    """The celestial WCS of an IMAGE header (TAN with SIP)."""
    return WCS(header)


def sky_to_pixel(w: WCS, ra, dec):
    """(x, y), 0-based, of sky positions in degrees. Scalars or arrays."""
    x, y = w.all_world2pix(ra, dec, 0)
    return x, y


def pixel_to_sky(w: WCS, x, y):
    """(ra, dec) in degrees of 0-based pixels."""
    ra, dec = w.all_pix2world(x, y, 0)
    return ra, dec


def corners(w: WCS, nx: int, ny: int) -> list[tuple[float, float]]:
    """The four corners of the frame as (ra, dec) in degrees: the outer edges of the corner pixels, going
    round from the lowest x and y."""
    xs = [-0.5, nx - 0.5, nx - 0.5, -0.5]
    ys = [-0.5, -0.5, ny - 0.5, ny - 0.5]
    ra, dec = pixel_to_sky(w, xs, ys)
    return [(float(a), float(b)) for a, b in zip(ra, dec)]


def pixel_area_sr(w: WCS) -> float:
    """Solid angle of one pixel at the reference point, steradians (the pixel scale is 6.15 arcsec)."""
    m = np.asarray(w.pixel_scale_matrix, float)
    return abs(float(np.linalg.det(m))) * (math.pi / 180.0) ** 2


def stamp_origin(px: float, py: float, w: int, h: int) -> tuple[int, int]:
    """Full-frame pixel of the first element of a w by h stamp centred on the pixel nearest (px, py)."""
    return int(math.floor(px + 0.5)) - w // 2, int(math.floor(py + 0.5)) - h // 2


def on_frame(px: float, py: float, nx: int, ny: int) -> bool:
    """True when a position lies on the detector (inside the outer edges of the edge pixels)."""
    return -0.5 <= px < nx - 0.5 and -0.5 <= py < ny - 0.5
