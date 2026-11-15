"""Job wave_tables: the six WCS-WAVE tables for the page, and the proof that they give the wavelength of a pixel.

    python -m sx.run wave_tables [--maps DIR]

Writes site/data/wave/tables.json (CT-3) from the table in one frame of each detector, then checks it at 10,000
random sub-pixel positions of every detector against astropy's own reading of a different frame (SIP off), and
- when DIR holds lam_D1.npy to lam_D6.npy, the full per-pixel maps of the earlier probe - against those maps too.
Writes the numbers wave.tables.* to site/data/numbers/p1.json. Needs the network the first time (the answers
are cached afterwards).
"""
from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np

from sx import frozen, numbers, s3, wave
from sx.fits import FrameFile

SOURCES = {
    1: "dr1/level2/2025W35_1A/l2b-v27-2026-230/1/level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits",
    2: "dr1/level2/2025W34_2B/l2b-v27-2026-229/2/level2_2025W34_2B_0090_4D2_spx_l2b-v27-2026-229.fits",
    3: "dr1/level2/2025W33_2C/l2b-v27-2026-228/3/level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228.fits",
    4: "dr1/level2/2025W35_1A/l2b-v27-2026-230/4/level2_2025W35_1A_0432_4D4_spx_l2b-v27-2026-230.fits",
    5: "dr1/level2/2025W34_2B/l2b-v27-2026-229/5/level2_2025W34_2B_0090_4D5_spx_l2b-v27-2026-229.fits",
    6: "dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits",
}
"""The frame each table is copied from."""

CHECK_FRAMES = {
    1: "dr1/level2/2025W40_1A/l2b-v27-2026-239/1/level2_2025W40_1A_0441_1D1_spx_l2b-v27-2026-239.fits",
    2: "dr1/level2/2025W40_1A/l2b-v27-2026-239/2/level2_2025W40_1A_0529_4D2_spx_l2b-v27-2026-239.fits",
    3: "dr1/level2/2026W12_1A/l2b-v27-2026-235/3/level2_2026W12_1A_0598_4D3_spx_l2b-v27-2026-235.fits",
    4: "dr1/level2/2025W46_1A/l2b-v27-2026-206/4/level2_2025W46_1A_0287_1D4_spx_l2b-v27-2026-206.fits",
    5: "dr1/level2/2025W23_2B/l2b-v27-2026-201/5/level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits",
    6: "dr1/level2/2025W40_1A/l2b-v27-2026-239/6/level2_2025W40_1A_0067_1D6_spx_l2b-v27-2026-239.fits",
}
"""Another frame of each detector, whose own header and table are read by astropy for the check."""

N_PIXELS = 10_000
SEED = 20261114


def map_lookup(m: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear lookup in a full per-pixel map indexed [y, x]; positions outside the pixel centres are clamped."""
    x = np.clip(x, 0, 2039)
    y = np.clip(y, 0, 2039)
    i = np.minimum(y.astype(int), 2038)
    j = np.minimum(x.astype(int), 2038)
    fy, fx = y - i, x - j
    m = m.astype(np.float64)
    return (1 - fy) * ((1 - fx) * m[i, j] + fx * m[i, j + 1]) + fy * ((1 - fx) * m[i + 1, j] + fx * m[i + 1, j + 1])


def compare(tables: dict, maps: Path | None) -> dict:
    """Per detector: largest differences, in µm, between the tables and astropy's reading of another frame
    (and the probe's full maps when given), at N_PIXELS random positions."""
    rs = np.random.default_rng(SEED)
    out = {}
    for det in range(1, 7):
        x = rs.uniform(0, 2039, N_PIXELS)
        y = rs.uniform(0, 2039, N_PIXELS)
        ff = FrameFile.open(CHECK_FRAMES[det])
        lam_a, bw_a = wave.astropy_wave(ff.header, ff.wave_hdu(), x, y)
        lam_t, bw_t = wave.lam_bw(tables[str(det)], x, y)
        res = {"frame": CHECK_FRAMES[det], "lam_vs_astropy": float(np.abs(lam_t - lam_a).max()),
               "bw_vs_astropy": float(np.abs(bw_t - bw_a).max())}
        if maps is not None:
            m = np.load(Path(maps) / f"lam_D{det}.npy", mmap_mode="r")
            res["lam_vs_maps"] = float(np.abs(lam_t - map_lookup(np.asarray(m), x, y)).max())
        out[det] = res
    return out


def main(argv: list[str]) -> int:
    maps = Path(argv[argv.index("--maps") + 1]) if "--maps" in argv else None
    keys = frozen.record("wave_tables", list(SOURCES.values()) + list(CHECK_FRAMES.values()))
    print(f"{len(keys)} frames recorded in the frozen list")
    tables = {str(d): wave.read_table(k) for d, k in SOURCES.items()}
    text = json.dumps(tables, separators=(",", ":")) + "\n"
    wave.TABLES_PATH.parent.mkdir(parents=True, exist_ok=True)
    old = wave.TABLES_PATH.read_text(encoding="utf-8") if wave.TABLES_PATH.exists() else None
    wave.TABLES_PATH.write_text(text, encoding="utf-8", newline="\n")
    print("tables.json:", "identical to the file that was there" if old == text else "written (differs from the file that was there)" if old else "written")
    res = compare(tables, maps)
    worst = max(r["lam_vs_astropy"] for r in res.values())
    worst_bw = max(r["bw_vs_astropy"] for r in res.values())
    for d, r in res.items():
        print(d, json.dumps({k: v for k, v in r.items() if k != "frame"}))
    err_a = worst
    err_m = max((r["lam_vs_maps"] for r in res.values()), default=None)
    err = max(err_a, err_m or 0.0)
    print(f"largest wavelength difference over {6 * N_PIXELS} pixels: {err_a:.3g} um against astropy"
          + (f", {err_m:.3g} um against the full maps" if err_m is not None else "") + f" (bandwidth {worst_bw:.3g} um)")
    size = len(text.encode())
    entries = {
        "wave.tables.error_astropy": numbers.entry(err_a, 7, unit="µm", shown=f"{err_a:.1e}"),
        "wave.tables.pixels": numbers.entry(6 * N_PIXELS, 0),
        "wave.tables.bytes": numbers.entry(size, 0, unit="bytes"),
        "wave.tables.gzip_bytes": numbers.entry(len(gzip.compress(text.encode(), 9, mtime=0)), 0, unit="bytes"),
    }
    if err_m is not None:
        entries["wave.tables.error_maps"] = numbers.entry(err_m, 7, unit="µm", shown=f"{err_m:.1e}")
    numbers.write("p1", entries)
    return 0 if err <= 1e-5 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
