"""Wavelength and bandwidth at a pixel (CT-3), from the six small WCS-WAVE tables.

Every frame of a detector carries the same table: a grid of control points (X and Y, counted from 1 as FITS
counts) with the wavelength and the bandwidth in µm at each node. Between nodes the value is bilinear in x and y
inside each cell, as the WAVE-TAB convention of FITS says. The sky-distortion (SIP) terms play no part: astropy
would otherwise apply them to this table as well, which moves the wavelength by up to 25 nm (and the line test
of K1 shows the reading without them is the right one).

Pixels are 0-based, whole numbers at pixel centres.
"""
from __future__ import annotations

import json
import warnings
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from .contracts import WAVE_TABLES_FILE, WaveTable, WaveTables
from .fits import FrameFile

warnings.simplefilter("ignore", FITSFixedWarning)

ROOT = Path(__file__).resolve().parents[2]
TABLES_PATH = ROOT / "site" / WAVE_TABLES_FILE


def read_table(key: str) -> WaveTable:
    """The WCS-WAVE table of one frame, as CT-3 writes it: X, Y, lam[row][column], bw[row][column], src."""
    ff = FrameFile.open(key)
    t = ff.wave_hdu()
    d = t.data
    values = np.asarray(d["VALUES"][0])
    X = np.asarray(d["X"][0], float)
    Y = np.asarray(d["Y"][0], float)
    if values.shape != (len(Y), len(X), 2):
        raise ValueError(f"{key}: WCS-WAVE values have shape {values.shape}, expected ({len(Y)}, {len(X)}, 2)")
    return {
        "X": [_num(v) for v in X],
        "Y": [_num(v) for v in Y],
        "lam": [[float(v) for v in row] for row in values[..., 0]],
        "bw": [[float(v) for v in row] for row in values[..., 1]],
        "src": key,
    }


def _num(v: float):
    return int(v) if float(v).is_integer() else float(v)


def load_tables(path: Optional[Path] = None) -> WaveTables:
    return json.loads(Path(path or TABLES_PATH).read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def default_tables() -> WaveTables:
    return load_tables()


def _index(knots: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Fractional position of p along a list of knots (linear between knots, clamped at the ends: the
    last cell is extended)."""
    k = np.clip(np.searchsorted(knots, p, side="right") - 1, 0, len(knots) - 2)
    return k + (p - knots[k]) / (knots[k + 1] - knots[k])


def _bilinear(grid: np.ndarray, fi: np.ndarray, fj: np.ndarray) -> np.ndarray:
    i = np.clip(np.floor(fi).astype(int), 0, grid.shape[0] - 2)
    j = np.clip(np.floor(fj).astype(int), 0, grid.shape[1] - 2)
    a, b = fi - i, fj - j
    return (1 - a) * ((1 - b) * grid[i, j] + b * grid[i, j + 1]) + a * ((1 - b) * grid[i + 1, j] + b * grid[i + 1, j + 1])


def lam_bw(table: WaveTable, x, y):
    """(lam, bw) in µm at 0-based pixels x, y (scalars or arrays) from one detector's table."""
    X, Y = np.asarray(table["X"], float), np.asarray(table["Y"], float)
    fj = _index(X, np.asarray(x, float) + 1.0)
    fi = _index(Y, np.asarray(y, float) + 1.0)
    return (_bilinear(np.asarray(table["lam"], float), fi, fj), _bilinear(np.asarray(table["bw"], float), fi, fj))


def wavelength_at(det: int, x, y, tables: Optional[WaveTables] = None) -> dict:
    """CT-3: {"lam", "bw"} in µm at the 0-based full-frame pixel (x, y) of detector det. Arrays give arrays."""
    t = (tables or default_tables())[str(det)]
    lam, bw = lam_bw(t, x, y)
    if np.ndim(lam) == 0:
        return {"lam": float(lam), "bw": float(bw)}
    return {"lam": lam, "bw": bw}


def span(table: WaveTable) -> tuple[float, float]:
    """Smallest and largest wavelength of the table's nodes (the extent of the detector's colour band)."""
    g = np.asarray(table["lam"], float)
    return float(g.min()), float(g.max())


# -- the reading by astropy that the tables are checked against ---------------------------------------


def astropy_wave(header: fits.Header, table_hdu, x, y):
    """(lam, bw) in µm by astropy's reading of the frame's spectral coordinates, SIP switched off. This is
    the reference the tables are checked against; the pipeline itself reads the tables."""
    h = header.copy()
    for k in list(h.keys()):
        if k.split("_")[0] in ("A", "B", "AP", "BP") and "_" in k:
            del h[k]
    ph = fits.HDUList([fits.PrimaryHDU(), fits.ImageHDU(header=h, name="IMAGE"), table_hdu])
    w = WCS(h, fobj=ph, key="W")
    lam, bw = w.pixel_to_world_values(np.asarray(x, float), np.asarray(y, float))
    k = 1e6 if w.wcs.cunit[0] == "m" else 1.0
    return lam * k, bw * k


def full_map(header: fits.Header, table_hdu, n: int = 2040) -> tuple[np.ndarray, np.ndarray]:
    """The wavelength and bandwidth of every pixel of a frame, (n, n) float32 arrays indexed [y, x]."""
    yy, xx = np.mgrid[:n, :n].astype(float)
    lam, bw = astropy_wave(header, table_hdu, xx, yy)
    return lam.astype(np.float32), bw.astype(np.float32)
