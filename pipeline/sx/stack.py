"""Background, noise, co-add, resampling and difference (CT-7). Same rules, same numbers as site/js/lib/stack.js.

What changed in the co-add, and why. It used to keep a pixel only if it was valid in every photo of the visit, and
"valid" counted every flag except FULLSAMPLE and SOURCE as a defect. Measured on real stamps that left 69% of the
picture after one pair of photos, 20% after six and 13% after eight, so the main view would have been mostly empty.
Two causes: flags that say nothing about the quality of a pixel (DICHROIC, PHANMISS) counted against it, and an
intersection over many photos, each with its own empty corners, shrinks towards nothing. Now each photo may be used
at a pixel if the value is finite and no bit of the saturation or defect tiers of flags.py is set (SOURCE,
FULLSAMPLE, DICHROIC and PHANMISS never exclude); the co-add is the mean of the photos that may be used there, with
their count `n`, and the pixel is shown when `n` reaches `need`, half of the photos (rounded up, at least 1). Two
visits are compared only where both co-adds show the pixel.

Arrays are numpy arrays of shape (h, w), the first row at the lowest y, as in a Stamp. Everything is computed in
float64 and stored as float32 where an array is returned.

Flags (bits of the FLAGS extension of a frame, from its header): FULLSAMPLE = bit 12 ("pixel full sample history is
available", set almost everywhere and not a defect) and SOURCE = bit 21 ("pixel mapped to a known source").

  quiet  no flag other than FULLSAMPLE: the pixels that say what the sky background is.
  valid  no flag other than FULLSAMPLE and SOURCE: the pixels that may be shown. A star is not a defect.

Next to a bright star the SOURCE flag can cover the whole stamp. Background and noise are then taken over the valid
pixels (the sigma-clipping drops the star): a stamp or co-add whose quiet pixels number fewer than MIN_PIXELS
uses its valid pixels instead, and says so in `basis`.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from .contracts import CLIP_PASSES, CLIP_SIGMA, MAD_TO_SIGMA
from .flags import DEFECT_MASK, SATURATION_MASK

FLAG_FULLSAMPLE = 1 << 12
FLAG_SOURCE = 1 << 21
MIN_PIXELS = 100
"""Fewest pixels that background and noise are measured on."""

_NOT_FULLSAMPLE = np.int32(~FLAG_FULLSAMPLE)
_NOT_FULLSAMPLE_SOURCE = np.int32(~(FLAG_FULLSAMPLE | FLAG_SOURCE))
_UNUSABLE = np.int32(SATURATION_MASK | DEFECT_MASK)


def quiet_mask(data: np.ndarray, flags: Optional[np.ndarray] = None) -> np.ndarray:
    """uint8, 1 where the value is finite and the flag word has no bit other than FULLSAMPLE (all finite when flags is None)."""
    ok = np.isfinite(data)
    if flags is not None:
        ok &= (np.asarray(flags, dtype=np.int32) & _NOT_FULLSAMPLE) == 0
    return ok.astype(np.uint8)


def valid_mask(data: np.ndarray, flags: Optional[np.ndarray] = None) -> np.ndarray:
    """uint8, 1 where the value is finite and the flag word has no bit other than FULLSAMPLE and SOURCE."""
    ok = np.isfinite(data)
    if flags is not None:
        ok &= (np.asarray(flags, dtype=np.int32) & _NOT_FULLSAMPLE_SOURCE) == 0
    return ok.astype(np.uint8)


def usable_mask(data: np.ndarray, flags: Optional[np.ndarray] = None) -> np.ndarray:
    """uint8, 1 where the value is finite and the flag word has no bit of the saturation or defect tiers of flags.py
    (all finite when flags is None): the pixels of a photo that may go into a co-add."""
    ok = np.isfinite(data)
    if flags is not None:
        ok &= (np.asarray(flags, dtype=np.int32) & _UNUSABLE) == 0
    return ok.astype(np.uint8)


def basis_mask(quiet: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, str]:
    """The pixels that background and noise are measured on: the quiet ones when there are MIN_PIXELS or more,
    else the valid ones. Returns (boolean mask, "quiet" or "valid")."""
    q = np.asarray(quiet).astype(bool)
    if int(q.sum()) >= MIN_PIXELS:
        return q, "quiet"
    return np.asarray(valid).astype(bool), "valid"


def clipped_median(values: np.ndarray, sigma: float = CLIP_SIGMA, passes: int = CLIP_PASSES) -> float:
    """Sigma-clipped median: up to `passes` times, drop the values farther than `sigma` standard deviations from the
    median (standard deviation of what is left), stopping when nothing is dropped. NaN when no value is left."""
    v = np.asarray(values, dtype=np.float64).ravel()
    v = v[np.isfinite(v)]
    for _ in range(passes):
        if v.size == 0:
            break
        keep = np.abs(v - np.median(v)) <= sigma * np.std(v)
        if keep.all():
            break
        v = v[keep]
    return float(np.median(v)) if v.size else float("nan")


def robust_noise(values: np.ndarray) -> float:
    """MAD_TO_SIGMA times the median absolute deviation from the median. NaN for no values."""
    v = np.asarray(values, dtype=np.float64).ravel()
    v = v[np.isfinite(v)]
    if v.size == 0:
        return float("nan")
    return float(MAD_TO_SIGMA * np.median(np.abs(v - np.median(v))))


def stamp_stats(data: np.ndarray, flags: Optional[np.ndarray] = None) -> dict:
    """Background and noise of one stamp: {background, noise, n, basis}.

    background is the sigma-clipped median of the quiet pixels (the valid ones when quiet pixels number fewer than
    MIN_PIXELS; see the top of the file); noise is robust_noise of the stamp after the background is subtracted.
    NaN and n = 0 when fewer than MIN_PIXELS pixels are left."""
    d = np.asarray(data, dtype=np.float64)
    m, basis = basis_mask(quiet_mask(d, flags), valid_mask(d, flags))
    vals = d[m]
    if vals.size < MIN_PIXELS:
        return {"background": float("nan"), "noise": float("nan"), "n": 0, "basis": basis}
    bg = clipped_median(vals)
    return {"background": bg, "noise": robust_noise(vals - bg), "n": int(vals.size), "basis": basis}


def coadd(stamps: Sequence[dict]) -> dict:
    """Mean of the stamps taken in one visit, each with its own background subtracted first, at each pixel over the
    stamps that may be used there (usable_mask). `n` counts them; the pixel is shown (`valid`) when `n` reaches
    `need`, half of the stamps used rounded up and at least 1, and the value is NaN elsewhere. `quiet` is a shown
    pixel where every stamp used is quiet.

    `stamps`: dicts with `data` (h, w) and `flags` ((h, w) or None), all the same shape. A stamp with too few pixels
    to measure a background on (see stamp_stats) is left out and counted in `dropped`.

    Returns {data float32 (h, w), valid uint8, quiet uint8, n uint8 (h, w), need, photos, dropped, background [per
    stamp used], noise, basis}, where noise is robust_noise of the co-add over its basis pixels (see basis_mask)."""
    h, w = np.asarray(stamps[0]["data"]).shape
    acc = np.zeros((h, w))
    count = np.zeros((h, w), dtype=np.int64)
    loud = np.zeros((h, w), dtype=bool)
    bgs: list[float] = []
    dropped = 0
    for s in stamps:
        d = np.asarray(s["data"], dtype=np.float64)
        st = stamp_stats(d, s.get("flags"))
        if st["n"] == 0:
            dropped += 1
            continue
        bgs.append(st["background"])
        u = usable_mask(d, s.get("flags")).astype(bool)
        q = quiet_mask(d, s.get("flags")).astype(bool)
        acc = acc + np.where(u, d - st["background"], 0.0)
        count += u
        loud |= u & ~q
    photos = len(bgs)
    need = max(1, -(-photos // 2))
    if photos == 0:
        nan = np.full((h, w), np.nan, dtype=np.float32)
        return {"data": nan, "valid": np.zeros((h, w), np.uint8), "quiet": np.zeros((h, w), np.uint8),
                "n": count.astype(np.uint8), "need": need, "photos": 0, "dropped": dropped, "background": [],
                "noise": float("nan"), "basis": "valid"}
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = acc / count
    valid = (count >= need) & np.isfinite(mean)
    quiet = valid & ~loud
    out = np.where(valid, mean, np.nan).astype(np.float32)
    m, basis = basis_mask(quiet, valid)
    return {
        "data": out, "valid": valid.astype(np.uint8), "quiet": quiet.astype(np.uint8),
        "n": count.astype(np.uint8), "need": need, "photos": photos, "dropped": dropped, "background": bgs,
        "noise": robust_noise(out[m]), "basis": basis,
    }


def affine_map(w_out: int, h_out: int, m: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    """Where each pixel (x, y) of a grid w_out by h_out falls in another image: x' = m0 x + m1 y + m2,
    y' = m3 x + m4 y + m5. Both arrays have shape (h_out, w_out)."""
    y, x = np.mgrid[0:h_out, 0:w_out].astype(np.float64)
    return m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]


def resample(
    src: np.ndarray, map_x: np.ndarray, map_y: np.ndarray, ok: Optional[np.ndarray] = None
) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear interpolation of an image at the positions (map_x, map_y), given in pixels of `src` (0-based, whole
    numbers at pixel centres). Returns (data float32, ok uint8) in the shape of the map.

    The value is the weighted mean of the four pixels around the position, the weights summing to 1: a surface
    brightness (MJy/sr) stays a surface brightness, a flat sky stays flat, and for a pure shift the flux of an
    object is conserved exactly (to its edge). Pixel areas are taken as equal, which holds between two frames of one
    detector. A position outside the centres of the first and last pixel, or one that needs a pixel that is not ok
    (not finite when `ok` is None), gives NaN and 0. A neighbour with weight exactly 0 is not looked at."""
    s = np.asarray(src, dtype=np.float64)
    h, w = s.shape
    good = np.isfinite(s) if ok is None else np.asarray(ok).astype(bool)
    x = np.asarray(map_x, dtype=np.float64)
    y = np.asarray(map_y, dtype=np.float64)
    with np.errstate(invalid="ignore"):
        inside = (x >= 0) & (x <= w - 1) & (y >= 0) & (y <= h - 1)
    x = np.where(inside, x, 0.0)
    y = np.where(inside, y, 0.0)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    acc = np.zeros(x.shape)
    okk = inside.copy()
    for wt, yy, xx in (
        ((1 - fx) * (1 - fy), y0, x0),
        (fx * (1 - fy), y0, x1),
        ((1 - fx) * fy, y1, x0),
        (fx * fy, y1, x1),
    ):
        used = wt != 0
        nb_ok = good[yy, xx]
        okk &= ~used | nb_ok
        acc = acc + np.where(used & nb_ok, wt * s[yy, xx], 0.0)
    return np.where(okk, acc, np.nan).astype(np.float32), okk.astype(np.uint8)


def resample_coadd(co: dict, map_x: np.ndarray, map_y: np.ndarray) -> dict:
    """A co-add on another grid: data, valid and quiet resampled by `resample`. Quiet is valid and quiet in
    every pixel that took part. The count `n` is that of the pixel nearest to each position (halves round up). The
    noise is measured again, on the new grid."""
    data, valid = resample(co["data"], map_x, map_y, co["valid"])
    _, quiet = resample(co["data"], map_x, map_y, co["quiet"])
    quiet = quiet & valid
    m, basis = basis_mask(quiet, valid)
    h, w = co["n"].shape
    xi = np.clip(np.floor(np.nan_to_num(np.asarray(map_x, dtype=np.float64)) + 0.5), 0, w - 1).astype(np.int64)
    yi = np.clip(np.floor(np.nan_to_num(np.asarray(map_y, dtype=np.float64)) + 0.5), 0, h - 1).astype(np.int64)
    n = np.where(valid.astype(bool), co["n"][yi, xi], 0).astype(np.uint8)
    return {
        "data": data, "valid": valid, "quiet": quiet,
        "n": n, "need": co["need"], "photos": co["photos"], "dropped": co.get("dropped", 0), "background": co.get("background", []),
        "noise": robust_noise(data[m]), "basis": basis,
    }


def difference(a: dict, b: dict) -> dict:
    """b minus a, for two co-adds on one grid (b resampled onto the grid of a), a the earlier visit.

    Returns {diff float32 (MJy/sr), units float32 (noise units), valid uint8, sigma, sigmaA, sigmaB, scatter}.
    The pixels shown are those that both co-adds show. The noise of each side is robust_noise of its co-add
    over the pixels that are quiet in both (the shown ones when those number fewer than MIN_PIXELS); sigma is the two
    added in quadrature, and units = diff / sigma.
    scatter is robust_noise of the difference over the same pixels, to compare with sigma."""
    da = np.asarray(a["data"], dtype=np.float64)
    db = np.asarray(b["data"], dtype=np.float64)
    ok = a["valid"].astype(bool) & b["valid"].astype(bool) & np.isfinite(da) & np.isfinite(db)
    q, _ = basis_mask(a["quiet"].astype(bool) & b["quiet"].astype(bool) & ok, ok)
    sa, sb = robust_noise(da[q]), robust_noise(db[q])
    sigma = float(np.sqrt(sa * sa + sb * sb))
    d = db - da
    return {
        "diff": np.where(ok, d, np.nan).astype(np.float32),
        "units": np.where(ok, d / sigma, np.nan).astype(np.float32),
        "valid": ok.astype(np.uint8),
        "sigma": sigma, "sigmaA": sa, "sigmaB": sb,
        "scatter": robust_noise(d[q]),
    }
