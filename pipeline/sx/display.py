"""The display grid: the one set of pixels on which every picture of a view is drawn.

Two visits of SPHEREx see the same sky turned by 145 to 180 degrees on the detector, so stamps in detector
orientation do not line up. On the display grid north is up, east is to the left, a pixel is PIXEL_ARCSEC
across, and the target is the pixel (size // 2, size // 2) (0-based, whole numbers at pixel centres, first row at
the lowest y, as everywhere). A stamp is put on it by nearest neighbour: each output pixel takes the value of the
one source pixel that its centre falls in, with no interpolation. A source pixel may be taken by two output
pixels or by none; an output pixel whose centre falls outside the stamp is NaN (image) and 0 (flags).

The sky of a stamp is flat around its target pixel: `sky = {ra, dec, cd}`, the target pixel's position and the
east and north offsets in degrees per pixel along x and y on the plane that touches the sky there. It is what
`localSky` in site/js/ui/hover.js computes, and local_sky below gives the same numbers.
"""
from __future__ import annotations

import math
from typing import NamedTuple, Optional

import numpy as np

from .contracts import LocalSky

PIXEL_ARCSEC = 6.15
"""The size of a pixel of the display grid, arcsec; the size of a SPHEREx pixel."""

PIXEL_DEG = PIXEL_ARCSEC / 3600.0

_D2R = math.pi / 180.0
_R2D = 180.0 / math.pi


def tangent_offset(ra0: float, dec0: float, ra: float, dec: float) -> tuple[float, float]:
    """How far east and north a sky position lies from another, degrees, on the plane that touches the sky at
    (ra0, dec0) (the gnomonic projection)."""
    da = (ra - ra0) * _D2R
    d, d0 = dec * _D2R, dec0 * _D2R
    depth = math.sin(d) * math.sin(d0) + math.cos(d) * math.cos(d0) * math.cos(da)
    return (_R2D * math.cos(d) * math.sin(da) / depth,
            _R2D * (math.sin(d) * math.cos(d0) - math.cos(d) * math.sin(d0) * math.cos(da)) / depth)


def local_sky(wcs, x: float, y: float) -> Optional[LocalSky]:
    """The flat sky around a full-frame pixel (x, y), 0-based, distortion included: the position of the pixel and
    what one pixel to the right and one pixel up do, measured half a pixel to each side of it. None when the
    transform gives no position there."""
    s = 0.5

    def at(px: float, py: float) -> tuple[float, float]:
        ra, dec = wcs.all_pix2world(px, py, 0)
        return float(ra), float(dec)

    ra, dec = at(x, y)

    def off(px: float, py: float) -> tuple[float, float]:
        r, d = at(px, py)
        return tangent_offset(ra, dec, r, d)

    right, left, up, down = off(x + s, y), off(x - s, y), off(x, y + s), off(x, y - s)
    cd = [(right[0] - left[0]) / (2 * s), (up[0] - down[0]) / (2 * s),
          (right[1] - left[1]) / (2 * s), (up[1] - down[1]) / (2 * s)]
    if not all(math.isfinite(v) for v in (ra, dec, *cd)):
        return None
    return {"ra": ra, "dec": dec, "cd": cd}


def grid_sky(sky: LocalSky) -> LocalSky:
    """The sky of a picture on the display grid that is centred on the target of `sky`."""
    return {"ra": sky["ra"], "dec": sky["dec"], "cd": [-PIXEL_DEG, 0.0, 0.0, PIXEL_DEG]}


class Grid(NamedTuple):
    """A stamp on the display grid. `sx` and `sy` hold, for each output pixel, the column and row of the source
    pixel it was taken from, or -1 in both when it fell outside the stamp."""

    data: np.ndarray  # float32 (size, size)
    flags: Optional[np.ndarray]  # int32 (size, size), or None when the stamp had none
    sx: np.ndarray  # int32 (size, size)
    sy: np.ndarray  # int32 (size, size)


def source_pixels(sky: LocalSky, tx: float, ty: float, w: int, h: int, size: int) -> tuple[np.ndarray, np.ndarray]:
    """For each pixel of a size by size display grid, the column and row of the stamp pixel that holds its centre
    (-1 and -1 outside the w by h stamp). `sky` is the stamp's own; (tx, ty) its target pixel."""
    c = size // 2
    cd0, cd1, cd2, cd3 = sky["cd"]
    det = cd0 * cd3 - cd1 * cd2
    if not det or not math.isfinite(det):
        raise ValueError("the sky transform of the stamp cannot be inverted")
    j, i = np.mgrid[0:size, 0:size]
    east = (c - i) * PIXEL_DEG
    north = (j - c) * PIXEL_DEG
    dx = (cd3 * east - cd1 * north) / det
    dy = (cd0 * north - cd2 * east) / det
    sx = np.floor(tx + dx + 0.5).astype(np.int64)
    sy = np.floor(ty + dy + 0.5).astype(np.int64)
    inside = (sx >= 0) & (sx < w) & (sy >= 0) & (sy < h)
    return np.where(inside, sx, -1).astype(np.int32), np.where(inside, sy, -1).astype(np.int32)


def to_display_grid(stamp, size: int) -> Grid:
    """The stamp (CT-4, with `sky`) on the display grid, size by size, by nearest neighbour."""
    if stamp.sky is None:
        raise ValueError("the stamp has no sky transform")
    sx, sy = source_pixels(stamp.sky, stamp.tx, stamp.ty, stamp.w, stamp.h, size)
    inside = sx >= 0
    data = np.full((size, size), np.nan, np.float32)
    data[inside] = np.asarray(stamp.data, np.float32)[sy[inside], sx[inside]]
    flags = None
    if stamp.flags is not None:
        flags = np.zeros((size, size), np.int32)
        flags[inside] = np.asarray(stamp.flags, np.int32)[sy[inside], sx[inside]]
    return Grid(data, flags, sx, sy)
