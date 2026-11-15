"""Job lines: the colour axis tested on two known lines (Checks row K1, review sheet H3).

    python -m sx.run lines [--reviewed "<role>" <YYYY-MM-DD>]

NGC 6543 (a planetary nebula near the north ecliptic pole) shines in hydrogen lines. SPHEREx covers it in many
frames; in each frame the line falls at a different colour. For Paschen-beta (detector 2) and Brackett-alpha
(detector 5) the job measures the nebula in every frame whose wavelength at the nebula lies near the line, fits a
Gaussian plus a straight continuum to flux against wavelength, and compares the centre with the laboratory
wavelength moved by the nebula's velocity. For all six detectors it also compares the tables with the CWAVE layer
of IRSA's Spectral WCS product, the wavelength map IRSA recommends for science.

Writes: site/data/checks/rows/p1.json (rows K1 and K1-limit), site/data/checks/img/k1-lines.png and k1-cwave.png,
site/data/numbers/p1.json (keys lines.* and wave.cwave.*), review/h3.md and review/h3.png, and the frozen list.
Needs the network the first time; answers and byte ranges are cached afterwards. Without --reviewed the row K1
stays UNVERIFIED (a PASS needs a reviewer's role and the date).
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.optimize import curve_fit  # noqa: E402

from sx import checks, frozen, irsa, numbers, phot, s3, wave  # noqa: E402
from sx.fits import BLOCK, FrameFile, hdu_at  # noqa: E402
from sx.stamp import cut  # noqa: E402
from sx.wcs import on_frame, pixel_area_sr, sky_to_pixel  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RA, DEC = 269.63917, 66.63306
"""NGC 6543, J2000, as used in the earlier probe (rounded to 0.00001 degree, 0.04 arcsec)."""

C_KMS = 299792.458
RV_KMS = -66.0
"""Radial velocity of the nebula, from the specification; the source is to be cited before review. The check does
not depend on it at the level of the tolerances: 10 km/s moves the 4 µm line by 0.14 nm."""

LINES = [
    {"id": "pab", "name": "Paschen-beta", "det": 2, "lab": 1.28216, "half": 0.11, "tol": 0.005},
    {"id": "bra", "name": "Brackett-alpha", "det": 5, "lab": 4.05226, "half": 0.10, "tol": 0.015},
]
"""Laboratory (vacuum) wavelengths in µm: NIST Atomic Spectra Database, H I, n = 3 to 5 and n = 4 to 5. `half`:
frames within this many µm of the line are measured. `tol`: the pass rule, µm (5 and 15 nm)."""

R_AP, RING, HALF_BOX = 3, (8.0, 13.5), 14
"""Aperture radius, background ring (pixels) and half-size of the stamp. The ring is far from the nebula
(20 arcsec across) and a 3-pixel aperture holds all of it. FLAGS is not used here, on purpose: the nebula is bright,
so its own pixels carry the SOURCE and NONLINEAR bits, and in detector 5 the source mask covers so much of this field
that too few ring pixels would be left. Only finite pixels count. Without the mask the centres agree with the
earlier probe to 0.00001 µm; with it they moved by 0.001 to 0.002 µm."""

SWCS = "dr1/spectral_wcs/cal-swcs-v5-2026-191/{d}/spectral_wcs_D{d}_spx_cal-swcs-v5-2026-191.fits"
N_CWAVE = 10_000
SEED = 20261114
REPRODUCE = {"pab": 1.28184, "bra": 4.04989}
"""What the earlier probe (different code) found; the job's centres should agree within 0.0002 µm."""

IMG = checks.IMG_DIR
REVIEW = ROOT / "review"
INK, BLUE, ORANGE, GREY = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98"


def expected(lab: float) -> float:
    return lab * (1 + RV_KMS / C_KMS)


def find_frames() -> list[str]:
    """Frames of detectors 2 and 5 that hold the nebula and whose wavelength there lies near a line."""
    tables = wave.default_tables()
    found = irsa.sia_frames(RA, DEC)
    cand = [f["key"] for f in found if f["det"] in (2, 5)]

    def one(key: str):
        ff = FrameFile.open(key)
        px, py = (float(v) for v in sky_to_pixel(ff.wcs, RA, DEC))
        if not (HALF_BOX <= round(px) < ff.nx - HALF_BOX and HALF_BOX <= round(py) < ff.ny - HALF_BOX):
            return None
        lam = wave.wavelength_at(ff.det, px, py, tables)["lam"]
        for ln in LINES:
            if ff.det == ln["det"] and abs(lam - ln["lab"]) < ln["half"]:
                return key
        return None

    return [k for k in s3.map_threads(one, cand) if k]


def measure(keys: list[str]) -> dict[str, list[dict]]:
    """Per line: one dict per frame, {key, lam, bw, mjd, flux, err}, flux in mJy in a 3-pixel aperture."""
    tables = wave.default_tables()

    def one(key: str):
        ff = FrameFile.open(key)
        st = cut(ff, RA, DEC, size=2 * HALF_BOX + 1, flags=False, variance=True, tables=tables)
        if st is None:
            return None
        p = phot.aperture(st.data, st.variance, None, st.tx, st.ty, R_AP, RING, pixel_area_sr(ff.wcs))
        if p is None or not np.isfinite(p.flux):
            return None
        return {"key": key, "det": st.det, "lam": st.lam, "bw": st.bw, "mjd": st.mjd, "flux": p.flux, "err": p.err}

    rows = [r for r in s3.map_threads(one, keys) if r]
    return {ln["id"]: sorted((r for r in rows if r["det"] == ln["det"]), key=lambda r: r["lam"]) for ln in LINES}


def gauss(l, c0, c1, a, mu, s):
    return c0 + c1 * (l - mu) + a * np.exp(-0.5 * ((l - mu) / s) ** 2)


def fit_line(rows: list[dict], ln: dict) -> dict:
    """Gaussian plus straight continuum, unweighted, on the frames within ln["half"] of the line. The error is the
    scatter of the centre over 300 resamplings of the frames (seeded)."""
    sel = [r for r in rows if abs(r["lam"] - ln["lab"]) < ln["half"]]
    l = np.array([r["lam"] for r in sel])
    f = np.array([r["flux"] for r in sel])
    p0 = [np.median(f), 0.0, f.max() - np.median(f), l[np.argmax(f)], 0.4 * np.median([r["bw"] for r in sel])]
    p, cov = curve_fit(gauss, l, f, p0=p0, maxfev=20000)
    rs = np.random.default_rng(1)
    boot = []
    for _ in range(300):
        i = rs.integers(0, len(l), len(l))
        try:
            boot.append(curve_fit(gauss, l[i], f[i], p0=p, maxfev=5000)[0][3])
        except RuntimeError:
            pass
    exp = expected(ln["lab"])
    return {"n": len(sel), "mu": float(p[3]), "mu_err_fit": float(np.sqrt(cov[3, 3])), "mu_err": float(np.std(boot)),
            "sigma": float(abs(p[4])), "params": [float(v) for v in p], "expected": exp,
            "dev_nm": float((p[3] - exp) * 1000), "lam": l, "flux": f, "err": np.array([r["err"] for r in sel]),
            "n_boot": len(boot)}


def swcs_cwave(det: int) -> np.ndarray:
    """The CWAVE layer of the Spectral WCS product of one detector, (2040, 2040) float32 indexed [y, x]."""
    key = SWCS.format(d=det)
    off = 0
    while True:
        h = hdu_at(key, off, BLOCK * 4)
        if h.name == "CWAVE":
            nx, ny = h.header["NAXIS1"], h.header["NAXIS2"]
            raw = s3.get_range(key, h.doff, h.doff + nx * ny * 4 - 1)
            return np.frombuffer(raw, ">f4").reshape(ny, nx).astype(np.float32)
        off = h.next


def compare_cwave(tables: dict) -> dict:
    rs = np.random.default_rng(SEED)
    out = {}
    for det in range(1, 7):
        cw = swcs_cwave(det)
        x = rs.integers(0, 2040, N_CWAVE)
        y = rs.integers(0, 2040, N_CWAVE)
        lam, _ = wave.lam_bw(tables[str(det)], x.astype(float), y.astype(float))
        d = (lam - cw[y, x]) * 1000.0
        out[det] = {"rms_nm": float(np.sqrt(np.mean(d**2))), "max_nm": float(np.abs(d).max()),
                    "mean_nm": float(d.mean()), "d": d, "lam": cw[y, x]}
    return out


# -- pictures ---------------------------------------------------------------------------------------


def draw_lines(axs, fits_: dict) -> None:
    for ax, ln in zip(axs, LINES):
        r = fits_[ln["id"]]
        ax.errorbar(r["lam"], r["flux"], yerr=r["err"], fmt="o", ms=3.5, color=BLUE, ecolor=GREY, elinewidth=0.8,
                    label=f"{r['n']} photos")
        x = np.linspace(r["lam"].min(), r["lam"].max(), 400)
        ax.plot(x, gauss(x, *r["params"]), color=ORANGE, lw=1.6, label=f"fit, centre {r['mu']:.5f}")
        ax.axvline(r["expected"], color=INK, lw=1.2, ls="--", label=f"expected {r['expected']:.5f}")
        ax.set_title(f"{ln['name']}, detector {ln['det']}\ncentre {r['dev_nm']:+.2f} nm from expected "
                     f"(allowed {ln['tol'] * 1000:.0f} nm)", fontsize=9)
        ax.set_xlabel("colour: wavelength of the pixel (µm)")
        ax.set_ylabel("flux of NGC 6543 in a 3-pixel aperture (mJy)")
        ax.legend(fontsize=8, frameon=False)
        ax.spines[["top", "right"]].set_visible(False)


def wavelength_rgb(w_um: float) -> tuple[float, float, float]:
    """A rough colour for 0.4 to 0.7 µm, for the strip that shows visible light on the ruler."""
    nm = w_um * 1000
    r = g = b = 0.0
    if 400 <= nm < 440: r, b = (440 - nm) / 40, 1.0
    elif 440 <= nm < 490: g, b = (nm - 440) / 50, 1.0
    elif 490 <= nm < 510: g, b = 1.0, (510 - nm) / 20
    elif 510 <= nm < 580: r, g = (nm - 510) / 70, 1.0
    elif 580 <= nm < 645: r, g = 1.0, (645 - nm) / 65
    elif 645 <= nm <= 700: r = 1.0
    f = 0.3 + 0.7 * min(1, (700 - nm) / 60) if nm > 645 else 1.0
    return (r * f, g * f, b * f)


def draw_ruler(ax, tables: dict) -> None:
    """The colour ruler as the sheet checks it: 0.4 to 5 µm, visible light for scale, the six detector spans taken
    from the tables' extremes, and the carbon-dioxide band mark."""
    n = 60
    for i in range(n):
        a = 0.4 + 0.3 * i / n
        ax.barh(7, 0.3 / n, left=a, height=0.6, color=wavelength_rgb(a), lw=0)
    ax.text(0.74, 7, "visible light, 0.4 to 0.7 µm", va="center", fontsize=8, color=INK)
    shades = ["#1f5fa8", "#4f8fd1"]
    for det in range(1, 7):
        lo, hi = wave.span(tables[str(det)])
        ax.barh(6 - det + 0.0, hi - lo, left=lo, height=0.6, color=shades[det % 2])
        ax.text(hi + 0.04, 6 - det, f"detector {det}: {lo:.3f} to {hi:.3f} µm", va="center", fontsize=8, color=INK)
    ax.plot([4.2571, 4.2571], [-0.6, 7.6], color=ORANGE, lw=1.4)
    ax.text(4.2571, 7.75, "carbon dioxide band, 4.26 µm", color=ORANGE, fontsize=8, ha="center", va="bottom")
    ax.set_xlim(0.4, 6.0)
    ax.set_ylim(-0.7, 8.4)
    ax.set_yticks([])
    ax.set_xlabel("colour: wavelength (µm)")
    ax.spines[["top", "right", "left"]].set_visible(False)


def save(fig, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    return path


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    tables = wave.default_tables()
    keys = frozen.frames_for("lines", find_frames)
    print(f"{len(keys)} frames in the frozen list")
    rows = measure(keys)
    fits_ = {ln["id"]: fit_line(rows[ln["id"]], ln) for ln in LINES}
    for ln in LINES:
        r = fits_[ln["id"]]
        print(f"{ln['name']}: n={r['n']} centre {r['mu']:.5f} +- {r['mu_err']:.5f} (fit {r['mu_err_fit']:.5f}), "
              f"expected {r['expected']:.5f}, deviation {r['dev_nm']:+.3f} nm; probe value {REPRODUCE[ln['id']]:.5f}, "
              f"difference {r['mu'] - REPRODUCE[ln['id']]:+.5f} um")
    cw = compare_cwave(tables)
    for d, r in cw.items():
        print(f"detector {d} against CWAVE: rms {r['rms_nm']:.3f} nm, largest {r['max_nm']:.3f} nm, mean {r['mean_nm']:+.3f} nm")

    # pictures
    fig, axs = plt.subplots(1, 2, figsize=(11, 4.2))
    draw_lines(axs, fits_)
    fig.tight_layout()
    img1 = save(fig, IMG / "k1-lines.png")
    fig, axs = plt.subplots(2, 3, figsize=(11, 5), sharey=True)
    for det, ax in zip(range(1, 7), axs.ravel()):
        ax.hist(np.clip(cw[det]["d"], -3, 3), bins=40, range=(-3, 3), color=BLUE)
        tag = "test: line" if det in (2, 5) else "limit"
        ax.set_title(f"detector {det} ({tag}): rms {cw[det]['rms_nm']:.2f} nm, largest {cw[det]['max_nm']:.1f} nm", fontsize=9)
        ax.set_xlabel("tables minus IRSA map (nm); beyond ±3 nm in the end bars")
        ax.spines[["top", "right"]].set_visible(False)
    axs[0, 0].set_ylabel("pixels")
    axs[1, 0].set_ylabel("pixels")
    fig.tight_layout()
    img2 = save(fig, IMG / "k1-cwave.png")
    fig = plt.figure(figsize=(11, 8.6))
    gs = fig.add_gridspec(2, 2, height_ratios=[1, 0.95], hspace=0.38)
    draw_lines([fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])], fits_)
    draw_ruler(fig.add_subplot(gs[1, :]), tables)
    sheet = save(fig, REVIEW / "h3.png")

    # row K1 and K1-limit
    ok = all(abs(fits_[ln["id"]]["dev_nm"]) / 1000 <= ln["tol"] for ln in LINES)
    status = ("PASS" if reviewer else "UNVERIFIED") if ok else "FAIL"
    pab, bra = fits_["pab"], fits_["bra"]
    k1 = checks.row(
        "K1", "Colour axis: two hydrogen lines in their right place",
        "Read with the sky-distortion terms off, the wavelength tables put the Paschen-beta and Brackett-alpha lines "
        "of the planetary nebula NGC 6543 at their known colours.",
        f"NGC 6543 in every photo of detector 2 within {LINES[0]['half']} µm of Paschen-beta and of detector 5 within "
        f"{LINES[1]['half']} µm of Brackett-alpha ({pab['n']} and {bra['n']} photos). Flux in a {R_AP}-pixel aperture, "
        f"background from a ring of {RING[0]:g} to {RING[1]:g} pixels; a Gaussian on a straight line is fitted to flux "
        "against the wavelength the tables give at the nebula. Expected: the laboratory vacuum wavelength moved by the "
        f"nebula's velocity of {RV_KMS:g} km/s (source of the velocity to be cited before review).",
        "The fitted centre lies within 5 nm of the expected Paschen-beta wavelength and within 15 nm of the expected "
        "Brackett-alpha wavelength.",
        status, "colour checked on two known lines",
        f"{pab['mu']:.5f} and {bra['mu']:.5f}", "µm", f"{pab['expected']:.5f} and {bra['expected']:.5f}",
        "0.005 and 0.015 µm", checks.image_ref(img1), reviewer[0] if reviewer else None,
        reviewer[1] if reviewer else None, "python -m sx.run lines")
    lim = checks.row(
        "K1-limit", "Colour axis: the other four detectors",
        "In detectors 1, 3, 4 and 6 no line of known colour is available to this tool, so the tables are only "
        "compared with IRSA's own science wavelength maps. The check rests on IRSA's code and calibration.",
        f"The tables against the CWAVE layer of IRSA's Spectral WCS product (version cal-swcs-v5-2026-191) at "
        f"{N_CWAVE:,} random pixels of each detector.",
        "Not a pass or fail test: the largest difference is reported.", "LIMIT", "colour rests on IRSA's own maps",
        "; ".join(f"D{d} {cw[d]['max_nm']:.1f} nm" for d in (1, 3, 4, 6)), "largest difference", "IRSA CWAVE", None,
        checks.image_ref(img2), None, None, "python -m sx.run lines")
    checks.write_rows("p1", [k1, lim])

    entries = {}
    for ln in LINES:
        r = fits_[ln["id"]]
        i = ln["id"]
        entries[f"lines.{i}.fit"] = numbers.entry(r["mu"], 5, err=r["mu_err"], unit="µm", check="K1")
        entries[f"lines.{i}.expected"] = numbers.entry(r["expected"], 5, unit="µm", check="K1")
        entries[f"lines.{i}.dev_nm"] = numbers.entry(r["dev_nm"], 2, unit="nm", check="K1")
        entries[f"lines.{i}.n"] = numbers.entry(r["n"], 0, check="K1")
    for d, r in cw.items():
        entries[f"wave.cwave.d{d}.rms_nm"] = numbers.entry(r["rms_nm"], 2, unit="nm", check="K1-limit")
        entries[f"wave.cwave.d{d}.max_nm"] = numbers.entry(r["max_nm"], 1, unit="nm", check="K1-limit")
    entries["wave.cwave.pixels"] = numbers.entry(N_CWAVE, 0, check="K1-limit")
    numbers.write("p1", entries)

    maps_err = None
    p = ROOT / "site" / "data" / "numbers" / "p1.json"
    have = json.loads(p.read_text(encoding="utf-8"))
    if "wave.tables.error_maps" in have:
        maps_err = have["wave.tables.error_maps"]["value"]
    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "h3.md").write_text(sheet_text(fits_, cw, maps_err, status), encoding="utf-8", newline="\n")
    print(f"K1 {status}; K1-limit LIMIT; sheet {sheet}")
    return 0 if ok else 1


def sheet_text(f: dict, cw: dict, maps_err, status: str) -> str:
    pab, bra = f["pab"], f["bra"]
    return "\n".join([
        "# H3: wavelength card and colour ruler",
        "",
        "Open `h3.png`. Top: the two hydrogen lines of NGC 6543, flux against colour, with the fitted centre and the",
        "expected one. Bottom: the colour ruler as drawn from the tables, with visible light for scale and the",
        "carbon-dioxide mark.",
        "",
        "**Number to read**",
        "",
        f"- Paschen-beta, detector 2: centre {pab['mu']:.5f} µm, expected {pab['expected']:.5f} µm, "
        f"{pab['dev_nm']:+.2f} nm.",
        f"- Brackett-alpha, detector 5: centre {bra['mu']:.5f} µm, expected {bra['expected']:.5f} µm, "
        f"{bra['dev_nm']:+.2f} nm.",
        f"- Tables against the full per-pixel maps: largest difference "
        + (f"{maps_err:.1e} µm" if maps_err is not None else "not measured in this run (run `python -m sx.run wave_tables --maps <folder>`)")
        + " (the browser reader's own error against the same maps comes from its unit test and is added by the "
        "evidence package).",
        "",
        "**It passes if**",
        "",
        "1. Both lines are within 5 nm (Paschen-beta) and 15 nm (Brackett-alpha) of the expected colour.",
        "2. The browser reader differs from the maps by at most 0.00001 µm.",
        "3. Detectors 1, 3, 4 and 6 are labelled LIMIT (row K1-limit): no line test, only IRSA's own maps.",
        "4. The detector spans on the ruler equal the extremes of the tables.",
        "5. The carbon-dioxide mark has its citation (NIST Chemistry WebBook, carbon dioxide: asymmetric stretch "
        "near 2349 cm⁻¹, 4.26 µm). The value is not yet checked against the page.",
        "",
        f"Status written by the job: {status}. Reviewer's role and date are set with "
        "`python -m sx.run lines --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
