"""A stamp (CT-4): the cut-out of one frame around a sky position."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Union

import numpy as np

from . import wave as wavemod
from .contracts import Stamp, WaveTables
from .display import local_sky
from .fits import FrameFile
from .wcs import on_frame, sky_to_pixel, stamp_origin


@dataclass
class StampVar(Stamp):
    """A Stamp that also carries the variance of the same pixels, (MJy/sr) squared, when it was asked for."""

    variance: Optional[np.ndarray] = None


def cut(frame: Union[str, FrameFile], ra: float, dec: float, size: int = 64, flags: bool = True,
        variance: bool = False, tables: Optional[WaveTables] = None) -> Optional[StampVar]:
    """The size by size stamp of a frame around (ra, dec), degrees. The target pixel comes from
    all_world2pix (SIP on); the stamp starts at floor(pixel + 0.5) - size // 2 in x and y; parts outside the
    frame are NaN (image, variance) or 0 (flags). Returns None when the position is not on the detector.
    lam and bw are those of the tables at the target's unrounded pixel; `sky` is the flat sky around that pixel
    (sx.display.local_sky)."""
    ff = FrameFile.open(frame) if isinstance(frame, str) else frame
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    if not on_frame(px, py, ff.nx, ff.ny):
        return None
    x0, y0 = stamp_origin(px, py, size, size)
    data, fl, var = ff.box(x0, y0, size, size, flags=flags, variance=variance)
    wb = wavemod.wavelength_at(ff.det, px, py, tables)
    return StampVar(key=ff.key, det=ff.det, mjd=ff.mjd, w=size, h=size, x0=x0, y0=y0, tx=px - x0, ty=py - y0,
                    lam=wb["lam"], bw=wb["bw"], data=data, flags=fl, variance=var, sky=local_sky(ff.wcs, px, py))
