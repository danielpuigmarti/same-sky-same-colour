"""Job threei: a published ratio reproduced from the same photos (Checks row K4, review sheet H4).

    python -m sx.run threei [--reviewed "<role>" <YYYY-MM-DD>]

Interstellar comet 3I/ATLAS gives off carbon dioxide, which glows at 4.26 um. SPHEREx saw it in August 2025 and
December 2025 and again in spring 2026. The job measures the comet in every photo of those passes in a 2-pixel
aperture with a background ring of 40 to 55 pixels, then:

  1. fits a Gaussian over 4.15 to 4.40 um to flux against colour (detector 5) in each of the two passes, scales
     each point by r_h^2 * Delta (see F_SCALING) and divides the December line area by the August one. The result is
     compared with the ratio of production rates published for the same photos (3.0e27 / 1.6e27 = 1.88 +- 0.34).
     A hard-edged band is not used for the row: the job also shows what it would give when the edges move.
  2. in spring 2026 the comet is far and faint: it measures the three photos in the band, takes the noise from
     empty apertures at the same colour in the same photos, and compares the band with what December's profile
     predicts if the production rate had stayed the same.

Writes: site/data/checks/rows/p5.json (row K4; job spectra adds row K13), site/data/checks/img/k4-bands.png,
site/data/numbers/p5.json (keys threei.*), review/h4.md and review/h4.png, and the frozen list ("threei").
Needs the network the first time (about 200 MB of byte ranges); answers are cached afterwards. Without --reviewed
the row is a LIMIT, never a PASS: see the verdict in main().
"""
from __future__ import annotations

import json
import math
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.optimize import curve_fit  # noqa: E402

from sx import checks, frozen, horizons, numbers, phot, s3, wave  # noqa: E402
from sx.contracts import KEY_REGEX  # noqa: E402
from sx.fits import FrameFile  # noqa: E402
from sx.wcs import on_frame, pixel_area_sr, sky_to_pixel  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _threei_frames  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / "review"
IMG = checks.IMG_DIR

COMET = "C/2025 N1"
"""Horizons name of 3I/ATLAS."""

APERTURES = (2, 5, 10)
"""Aperture radii in pixels; the row uses the first. 2 pixels is 12.3 arcsec."""
RING = (40.0, 55.0)
"""Background ring in pixels, round the comet. Wide on purpose: the carbon-dioxide coma reaches 3 arcmin."""
HALF = 62
"""Half-size of the stamp, pixels (the ring reaches 55)."""

IN_BAND = (4.20, 4.32)
EXCL = (4.18, 4.34)
WIN = (4.15, 4.40)
CONT = (3.60, 4.55)
"""Colour windows, um: the frames counted as in the band, the band that the continuum leaves out, the window of the
Gaussian fit, and the range of the straight-line continuum of the spring template."""

F_SCALING = (2.0, 1.0)
"""Powers of r_h and Delta: flux in a fixed angular aperture F is proportional to Q / (r_h^a * Delta^b), with
(a, b) = (2, 1). Gas leaves the nucleus at constant speed v; the number of molecules inside an aperture of fixed
angle then grows with Delta (it holds Q * Delta * theta / v), the glow per molecule falls as r_h^-2 and the flux at
the telescope as Delta^-2, so F ~ Q / (r_h^2 * Delta). Q = F * r_h^2 * Delta."""

PUBLISHED = (1.88, 0.34)
"""3.0e27 +- 15% (December) over 1.6e27 +- 10% (August): the production rates of carbon dioxide in the two papers."""
REPRODUCE = (2.18, 0.09)
"""What an earlier run by different code gave (2.18 +- 0.09 at 2 pixels); the job's ratio should agree within 0.05."""
REPRO_TOL = 0.05
SPRING_RERUN = {"limit": 5.0, "sigma": 12.3}
"""The earlier run's 3-sigma limit (mJy) and the significance with which constant production is excluded."""

OFFS = [s * o for o in (15, 25, 35, 45, 55, 65, 75, 85) for s in (1, -1)]
"""Distances (pixels) of the empty apertures from the comet, along the line of constant colour, either side."""
SPRING_HALF = (150, 64)
"""Half-size in x and y of the spring stamp: the empty apertures lie in x, the ring reaches 55."""
SEED = 20261114

INK, BLUE, ORANGE, GREY, GREEN = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#2d7d46"


# -- photos -------------------------------------------------------------------------------------------


def find_frames() -> list[str]:
    return sorted(set(_threei_frames.keys("aug") + _threei_frames.keys("dec") + _threei_frames.keys("apr")))


def passes(keys: list[str]) -> dict[str, list[str]]:
    """The frozen keys split by pass, by the week in the key."""
    def week(k: str) -> str:
        return k.split("/")[2]
    return {"aug": [k for k in keys if week(k).startswith("2025W3")],
            "dec": [k for k in keys if week(k).startswith("2025W50")],
            "apr": [k for k in keys if week(k).startswith("2026W")]}


def comet_positions(frames: dict[str, FrameFile]) -> dict[str, dict]:
    """Horizons position, r_h and Delta of the comet seen from SPHEREx at the time of each photo."""
    keys = sorted(frames, key=lambda k: frames[k].mjd)
    eph = horizons.positions(COMET, [frames[k].mjd for k in keys])
    return {k: {"ra": float(eph.ra[i]), "dec": float(eph.dec[i]), "r": float(eph.r_au[i]), "delta": float(eph.delta_au[i])}
            for i, k in enumerate(keys)}


def open_all(keys: list[str]) -> dict[str, FrameFile]:
    return dict(zip(keys, s3.map_threads(FrameFile.open, keys)))


def cut_box(ff: FrameFile, px: float, py: float, hx: int, hy: int):
    x0, y0 = int(math.floor(px + 0.5)) - hx, int(math.floor(py + 0.5)) - hy
    data, fl, var = ff.box(x0, y0, 2 * hx + 1, 2 * hy + 1, flags=True, variance=True)
    return x0, y0, data, fl, var


def centroid(img: np.ndarray, flg: np.ndarray, x0: float, y0: float, bkg: float, rbox: float = 4, it: int = 5):
    """The flux-weighted centre (stamp pixels) after five rounds inside 4 pixels of (x0, y0), bad pixels left out;
    (nan, nan) when there is no flux."""
    yy, xx = np.mgrid[: img.shape[0], : img.shape[1]]
    xc, yc = x0, y0
    for _ in range(it):
        m = (np.hypot(xx - xc, yy - yc) <= rbox) & np.isfinite(img) & ((flg & phot.BAD_MASK) == 0)
        w = np.clip(img[m] - bkg, 0, None)
        if w.sum() <= 0:
            return math.nan, math.nan
        xc, yc = float(np.sum(w * xx[m]) / w.sum()), float(np.sum(w * yy[m]) / w.sum())
    return xc, yc


IRSA_TABLE = "https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/obscore_3I_Atlas.vot"
"""IRSA's table of the SPHEREx observations of the comet in August and December 2025: one row per photo, with the
comet's predicted position (comet_ra, comet_dec). Public, linked from IRSA's page on the comet."""


def irsa_positions() -> dict[tuple[str, int], tuple[float, float]]:
    """{(obs_id, detector): (ra, dec)} of IRSA's table; the file is kept in the cache folder."""
    import warnings

    from astropy.io.votable import parse_single_table
    import requests

    path = s3.cache_dir() / "obscore_3I_Atlas.vot"
    if not path.exists():
        r = requests.get(IRSA_TABLE, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = parse_single_table(str(path)).to_table(use_names_over_ids=True)
    return {(str(r["obs_id"]), int(str(r["spherex_detector"]).strip("D"))): (float(r["comet_ra"]), float(r["comet_dec"]))
            for r in t}


def key_obs(key: str) -> tuple[str, int]:
    """(obs_id as IRSA's table writes it, detector) of a bucket key."""
    m = KEY_REGEX.fullmatch(key)
    return f"{m.group(1)}_{m.group(4)}_{m.group(5)}", int(m.group(3))


def measure_comet(ff: FrameFile, pos: dict, irsa: tuple[float, float] | None, aps=APERTURES) -> dict[str, dict]:
    """The comet in one photo, measured in one stamp at up to three centres, {label: record}. Labels: "irsa" (the
    position of IRSA's table), "horizons" (JPL Horizons, seen from SPHEREx) and "centred" (the Horizons stamp's own
    centre of light, used only when the comet is bright, signal-to-noise above 10, and within 1 pixel). A record is
    {key, det, mjd, lam, bw, r, delta, f{radius: (flux, err)}, cen_off}, fluxes in mJy."""
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, pos["ra"], pos["dec"]))
    if not (3 <= px < ff.nx - 3 and 3 <= py < ff.ny - 3):
        return {}
    x0, y0, data, fl, var = cut_box(ff, px, py, HALF, HALF)
    omega = pixel_area_sr(ff.wcs)

    def at(cx: float, cy: float) -> dict | None:
        f, bkg = {}, math.nan
        for r in aps:
            p = phot.aperture(data, var, fl, cx - x0, cy - y0, r, RING, omega)
            if p is None or not math.isfinite(p.flux):
                return None
            f[r] = (p.flux, p.err)
            bkg = p.bkg
        xc, yc = centroid(data, fl, cx - x0, cy - y0, bkg)
        wb = wave.wavelength_at(ff.det, cx, cy)
        return {"key": ff.key, "det": ff.det, "mjd": ff.mjd, "lam": wb["lam"], "bw": wb["bw"], "r": pos["r"],
                "delta": pos["delta"], "f": f, "cen_off": math.hypot(xc - (cx - x0), yc - (cy - y0)),
                "cen": (x0 + xc, y0 + yc)}

    out: dict[str, dict] = {}
    h = at(px, py)
    if h is None:
        return out
    out["horizons"] = h
    if irsa is not None:
        ix, iy = (float(v) for v in sky_to_pixel(ff.wcs, *irsa))
        if abs(ix - px) < 7 and abs(iy - py) < 7:
            i = at(ix, iy)
            if i is not None:
                out["irsa"] = i
    flux, err = h["f"][APERTURES[0]]
    if flux / err > 10 and h["cen_off"] <= 1.0:
        c = at(*h["cen"])
        out["centred"] = c if c is not None else h
    else:
        out["centred"] = h
    return out


def measure_spring(ff: FrameFile, pos: dict) -> dict | None:
    """As measure_comet at 2 pixels, plus the same measurement at empty places of the same colour in the same photo."""
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, pos["ra"], pos["dec"]))
    if not (3 <= px < ff.nx - 3 and 3 <= py < ff.ny - 3):
        return None
    lam0 = wave.wavelength_at(ff.det, px, py)
    if not CONT[0] <= lam0["lam"] <= CONT[1]:
        return None
    x0, y0, data, fl, var = cut_box(ff, px, py, *SPRING_HALF)
    omega = pixel_area_sr(ff.wcs)
    c = phot.aperture(data, var, fl, px - x0, py - y0, 2, RING, omega)
    if c is None or not math.isfinite(c.flux) or c.n_ring < 50:
        return None
    lam = lambda x, y: wave.wavelength_at(ff.det, x, y)["lam"]
    gx = (lam(px + 10, py) - lam(px - 10, py)) / 20
    gy = (lam(px, py + 10) - lam(px, py - 10)) / 20
    gn = math.hypot(gx, gy)
    g = (gx / gn, gy / gn)
    perp = (-g[1], g[0])
    empty = []
    for o in OFFS:
        qx, qy = px + o * perp[0], py + o * perp[1]
        for _ in range(2):  # move along the colour gradient onto the colour of the comet
            dl = lam(qx, qy) - lam0["lam"]
            qx, qy = qx - dl / gn * g[0], qy - dl / gn * g[1]
        sx, sy = qx - x0, qy - y0
        if not (3 <= qx < ff.nx - 3 and 3 <= qy < ff.ny - 3 and RING[1] <= sx < data.shape[1] - RING[1]
                and RING[1] <= sy < data.shape[0] - RING[1]):
            continue
        e = phot.aperture(data, var, fl, sx, sy, 2, RING, omega)
        if e is None or not math.isfinite(e.flux) or e.n_ring < 50:
            continue
        empty.append({"off": o, "f": e.flux, "lam": lam(qx, qy)})
    f = np.array([e["f"] for e in empty])
    return {"key": ff.key, "det": ff.det, "mjd": ff.mjd, "lam": lam0["lam"], "bw": lam0["bw"], "r": pos["r"],
            "delta": pos["delta"], "f2": c.flux, "e2": c.err, "empty": empty, "n_empty": len(empty),
            "emp_std": float(np.std(f, ddof=1)) if len(f) > 2 else math.nan}


# -- the ratio ------------------------------------------------------------------------------------------


def gauss(x, a, mu, s):
    return a * np.exp(-0.5 * ((x - mu) / s) ** 2)


def band_fit(rows: list[dict], ap: int = 2, shift: float = 0.0, scaling=F_SCALING) -> dict:
    """The line area of one pass. Continuum: median of the points outside the band, which stands in for the dust.
    Points inside the fit window are scaled by r_h^a * Delta^b, a Gaussian is fitted with the points' errors (the
    continuum's error added), and the covariance is widened when the reduced chi-square is above 1. The line area
    is the Gaussian's area, A * sigma * sqrt(2 pi), in mJy um au^3."""
    ex, win = (EXCL[0] + shift, EXCL[1] + shift), (WIN[0] + shift, WIN[1] + shift)
    lam = np.array([r["lam"] for r in rows])
    f = np.array([r["f"][ap][0] for r in rows])
    e = np.array([r["f"][ap][1] for r in rows])
    geo = np.array([r["r"] ** scaling[0] * r["delta"] ** scaling[1] for r in rows])
    oob = (lam < ex[0]) | (lam > ex[1])
    cont = float(np.median(f[oob]))
    cont_err = float(1.2533 * np.std(f[oob]) / math.sqrt(oob.sum()))
    w = (lam > win[0]) & (lam < win[1])
    y = (f[w] - cont) * geo[w]
    ye = np.sqrt(e[w] ** 2 + cont_err**2) * geo[w]
    p, cov = curve_fit(gauss, lam[w], y, p0=[y.max(), 4.26, 0.025], sigma=ye, absolute_sigma=True, maxfev=20000)
    chi2r = float(np.sum(((y - gauss(lam[w], *p)) / ye) ** 2) / max(w.sum() - 3, 1))
    cov = cov * max(chi2r, 1.0)
    area = float(p[0] * abs(p[2]) * math.sqrt(2 * math.pi))
    jac = np.array([abs(p[2]) * math.sqrt(2 * math.pi), 0.0, p[0] * math.sqrt(2 * math.pi) * np.sign(p[2])])
    in_band = (lam >= IN_BAND[0]) & (lam <= IN_BAND[1])
    return {"area": area, "err": float(math.sqrt(jac @ cov @ jac)), "mu": float(p[1]), "sigma": float(abs(p[2])),
            "chi2r": chi2r, "cont": cont, "cont_err": cont_err, "n_win": int(w.sum()), "n_cont": int(oob.sum()),
            "n_in": int(in_band.sum()), "params": [float(v) for v in p], "lam": lam[w], "y": y, "ye": ye,
            "in_lam": sorted(float(v) for v in lam[in_band])}


def ratio(dec: dict, aug: dict) -> tuple[float, float]:
    r = dec["area"] / aug["area"]
    return float(r), float(r * math.hypot(dec["err"] / dec["area"], aug["err"] / aug["area"]))


def hard_fit(rows: list[dict], shift: float, ap: int = 2) -> dict:
    """What a hard-edged band would give, to show why it is not used: the weighted mean excess of the frames inside
    the band over a straight-line continuum fitted to the frames outside it (3.6 to 4.55 um), times r_h^2 * Delta of
    the frames in the band. Frames whose centre of light lies more than 1 pixel from the comet are dropped unless
    they are in the band."""
    lo, hi = IN_BAND[0] + shift, IN_BAND[1] + shift
    ex = (EXCL[0] + shift, EXCL[1] + shift)
    good = [r for r in rows if (not r["cen_off"] > 1.0) or (lo <= r["lam"] <= hi)]
    lam = np.array([r["lam"] for r in good])
    f = np.array([r["f"][ap][0] for r in good])
    e = np.array([r["f"][ap][1] for r in good])
    oob = (lam >= CONT[0]) & (lam <= CONT[1]) & ~((lam > ex[0]) & (lam < ex[1]))
    inb = (lam >= lo) & (lam <= hi)
    x = lam - 4.26
    a = np.vander(x[oob], 2)
    w = 1 / e[oob] ** 2
    cov = np.linalg.inv(a.T @ (a * w[:, None]))
    p = cov @ (a.T @ (w * f[oob]))
    chi2r = float(np.sum((f[oob] - a @ p) ** 2 * w) / max(oob.sum() - 2, 1))
    ai = np.vander(x[inb], 2)
    res = f[inb] - ai @ p
    s = max(chi2r, 1.0)
    c = np.diag(e[inb] ** 2 * s) + ai @ cov @ ai.T * s
    ci = np.linalg.inv(c)
    one = np.ones(inb.sum())
    mean, err = float(one @ ci @ res / (one @ ci @ one)), float(1 / math.sqrt(one @ ci @ one))
    geo = float(np.mean([r["r"] ** 2 * r["delta"] for r, b in zip(good, inb) if b]))
    return {"excess": mean * geo, "err": err * geo, "n_in": int(inb.sum())}


def hard_ratio(dec_all: list[dict], aug: list[dict], shift: float) -> dict:
    d, a = hard_fit(dec_all, shift), hard_fit(aug, shift)
    r = d["excess"] / a["excess"]
    return {"ratio": float(r), "err": float(r * math.hypot(d["err"] / d["excess"], a["err"] / a["excess"])),
            "n_dec": d["n_in"], "n_aug": a["n_in"]}


# -- spring: no band -----------------------------------------------------------------------------------------


def dec_template(dec_all: list[dict]) -> dict:
    """December's band as a profile: the straight-line continuum fitted to the photos outside the band (all
    detectors, 3.6 to 4.55 um) is taken off, what remains inside the band is the profile, with zero at 4.17 and
    4.36 um. Also the mean r_h and Delta of December's photos in the band."""
    p_ = [r for r in dec_all if CONT[0] <= r["lam"] <= CONT[1]]
    lam = np.array([r["lam"] for r in p_])
    f = np.array([r["f"][APERTURES[0]][0] for r in p_])
    e = np.array([r["f"][APERTURES[0]][1] for r in p_])
    oob = (lam >= CONT[0]) & (lam <= CONT[1]) & ~((lam > EXCL[0]) & (lam < EXCL[1]))
    x = lam - 4.26
    a = np.vander(x[oob], 2)
    w = 1 / e[oob] ** 2
    cov = np.linalg.inv(a.T @ (a * w[:, None]))
    p = cov @ (a.T @ (w * f[oob]))
    res = f - np.polyval(p, x)
    o = np.argsort(lam)
    lam_s, res_s = lam[o], res[o]
    m = (lam_s > EXCL[0]) & (lam_s < EXCL[1])
    ib = [r for r in p_ if IN_BAND[0] <= r["lam"] <= IN_BAND[1]]
    return {"lam": np.concatenate([[4.17], lam_s[m], [4.36]]), "flux": np.concatenate([[0.0], res_s[m], [0.0]]),
            "r": float(np.mean([r["r"] for r in ib])), "delta": float(np.mean([r["delta"] for r in ib]))}


def spring_solve(rows: list[dict], tpl: dict, f: np.ndarray | None = None, power: float = 1.5) -> dict:
    """The comet's band in the spring photos. Per photo: the noise is the scatter (standard deviation) of the empty
    apertures. The continuum is the median of the photos outside the band, its error 1.2533 x 1.4826 x MAD / sqrt(n);
    the excess is the weighted mean of the photos in the band minus the continuum (the continuum's error is common to
    them). The expectation is December's profile at the colour of each photo, scaled to the distances of the photo.
    `power`: the flux of a fixed angular aperture follows production Q as r_h^-power * Delta^-1; 1.5 is for gas whose
    speed falls as r_h^-0.5 (v ~ r_h^-0.5), 2.0 for constant speed."""
    lam = np.array([r["lam"] for r in rows])
    sig = np.array([r["emp_std"] for r in rows])
    f = np.array([r["f2"] for r in rows]) if f is None else f
    oob = ~((lam > EXCL[0]) & (lam < EXCL[1]))
    inb = (lam >= IN_BAND[0]) & (lam <= IN_BAND[1])
    rr = np.array([r["r"] for r in rows])
    dd = np.array([r["delta"] for r in rows])
    k = (rr / tpl["r"]) ** -power * (dd / tpl["delta"]) ** -1
    expected = k * np.interp(lam, tpl["lam"], tpl["flux"], left=0, right=0)
    c = float(np.median(f[oob]))
    ce = float(1.2533 * 1.4826 * np.median(np.abs(f[oob] - c)) / math.sqrt(oob.sum()))
    res = f[inb] - c
    cm = np.diag(sig[inb] ** 2) + ce**2
    ci = np.linalg.inv(cm)
    one = np.ones(inb.sum())
    mean, err = float(one @ ci @ res / (one @ ci @ one)), float(1 / math.sqrt(one @ ci @ one))
    wv = one @ ci / (one @ ci @ one)
    exp = float(wv @ expected[inb])
    return {"excess": mean, "err": err, "sigma": mean / err, "expected": exp, "limit": max(mean, 0.0) + 3 * err,
            "excluded": (exp - mean) / err, "n_in": int(inb.sum()), "n_out": int(oob.sum()), "continuum": c,
            "continuum_err": ce}


def spring_nulls(rows: list[dict], tpl: dict) -> dict:
    """The same measurement at each of the empty places in turn: if the noise is right, the significances scatter by about 1."""
    offs = sorted({e["off"] for r in rows for e in r["empty"]})
    lam = np.array([r["lam"] for r in rows])
    inb = (lam >= IN_BAND[0]) & (lam <= IN_BAND[1])
    oob = ~((lam > EXCL[0]) & (lam < EXCL[1]))
    sig = []
    for o in offs:
        fn = np.array([next((e["f"] for e in r["empty"] if e["off"] == o), math.nan) for r in rows])
        if np.isnan(fn[inb]).any() or np.isnan(fn[oob]).sum() > 3:
            continue
        fn = np.where(np.isnan(fn), np.nanmedian(fn[oob]), fn)
        sig.append(spring_solve(rows, tpl, fn)["sigma"])
    s = np.array(sig)
    return {"n": len(s), "std": float(np.std(s, ddof=1)) if len(s) > 2 else math.nan, "max_abs": float(np.abs(s).max())}


# -- pictures -----------------------------------------------------------------------------------------------


def draw_band(ax, fit: dict, title: str) -> None:
    ax.axvspan(IN_BAND[0], IN_BAND[1], color="#e8eef6", lw=0)
    ax.errorbar(fit["lam"], fit["y"], yerr=fit["ye"], fmt="o", ms=4, color=BLUE, ecolor=GREY, elinewidth=0.8,
                label=f"{fit['n_win']} photos")
    x = np.linspace(4.15, 4.40, 300)
    ax.plot(x, gauss(x, *fit["params"]), color=ORANGE, lw=1.6, label=f"fit: area {fit['area']:.2f} +- {fit['err']:.2f}")
    ax.axhline(0, color=INK, lw=0.6)
    ax.set_title(f"{title}: {fit['n_in']} photos in the shaded band", fontsize=9)
    ax.set_xlabel("colour: wavelength of the pixel (µm)")
    ax.set_ylabel("flux above the sky, scaled by distance (mJy x au³)")
    ax.legend(fontsize=8, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)


def save(fig, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    return path


def draw_spring(ax, rows: list[dict], tpl: dict, res: dict) -> None:
    lam = np.array([r["lam"] for r in rows])
    f = np.array([r["f2"] for r in rows])
    e = np.array([r["emp_std"] for r in rows])
    rr = np.array([r["r"] for r in rows])
    dd = np.array([r["delta"] for r in rows])
    k = (rr / tpl["r"]) ** -1.5 * (dd / tpl["delta"]) ** -1
    ax.axvspan(IN_BAND[0], IN_BAND[1], color="#e8eef6", lw=0)
    ax.errorbar(lam, f - res["continuum"], yerr=e, fmt="o", ms=4, color=BLUE, ecolor=GREY, elinewidth=0.8,
                label=f"measured, {len(rows)} photos")
    o = np.argsort(lam)
    ax.plot(lam[o], (k * np.interp(lam, tpl["lam"], tpl["flux"], left=0, right=0))[o], "-", color=ORANGE, lw=1.6,
            label="expected if production had stayed the same")
    ax.axhline(0, color=INK, lw=0.6)
    ax.set_xlim(3.55, 4.6)
    ax.set_title(f"Spring 2026: {res['n_in']} photos in the band, limit {res['limit']:.1f} mJy", fontsize=9)
    ax.set_xlabel("colour: wavelength of the pixel (µm)")
    ax.set_ylabel("flux above the sky level (mJy)")
    ax.legend(fontsize=8, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)


# -- main -------------------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    keys = frozen.frames_for("threei", find_frames)
    by = passes(keys)
    print(f"{len(keys)} photos in the frozen list: " + ", ".join(f"{k} {len(v)}" for k, v in by.items()))
    frames = open_all(keys)
    pos = comet_positions(frames)
    irsa = irsa_positions()

    both = by["aug"] + by["dec"]
    res = dict(zip(both, s3.map_threads(lambda k: measure_comet(frames[k], pos[k], irsa.get(key_obs(k))), both)))
    pick = lambda ks, label: [res[k][label] for k in ks if label in res[k]]
    rows = {lab: {"aug": pick(by["aug"], lab), "dec": pick(by["dec"], lab)} for lab in ("irsa", "horizons", "centred")}
    d5 = lambda lab, ep: [r for r in rows[lab][ep] if r["det"] == 5]
    aug5, dec5 = d5("irsa", "aug"), d5("irsa", "dec")
    print(f"measured with IRSA's positions: August {len(aug5)} photos of detector 5, December {len(dec5)} "
          f"(of {len(rows['irsa']['dec'])} in detectors 4 to 6)")

    fa, fd = band_fit(aug5), band_fit(dec5)
    rat, rat_e = ratio(fd, fa)
    print(f"August: in band {fa['n_in']}, window {fa['n_win']}, centre {fa['mu']:.4f}, area {fa['area']:.3f} +- {fa['err']:.3f}")
    print(f"December: in band {fd['n_in']}, window {fd['n_win']}, centre {fd['mu']:.4f}, area {fd['area']:.3f} +- {fd['err']:.3f}")
    print(f"ratio {rat:.3f} +- {rat_e:.3f} (earlier run {REPRODUCE[0]} +- {REPRODUCE[1]})")
    centres = {}
    for lab in ("horizons", "centred"):
        centres[lab] = ratio(band_fit(d5(lab, "dec")), band_fit(d5(lab, "aug")))
        print(f"aperture centred by {lab}: ratio {centres[lab][0]:.3f} +- {centres[lab][1]:.3f}")
    shifted = {sh: ratio(band_fit(dec5, shift=sh), band_fit(aug5, shift=sh)) for sh in (0.01, -0.01)}
    others = {ap: ratio(band_fit(dec5, ap), band_fit(aug5, ap)) for ap in APERTURES[1:]}
    scal = {"distance squared": (2.0, 2.0), "speed falling with distance": (1.5, 1.0), "no distance scaling": (0.0, 0.0)}
    alt = {n: ratio(band_fit(dec5, scaling=sc), band_fit(aug5, scaling=sc)) for n, sc in scal.items()}
    hard = {sh: hard_ratio(rows["irsa"]["dec"], rows["irsa"]["aug"], sh) for sh in (0.0, 0.01, -0.01)}
    for sh, h in hard.items():
        print(f"hard-edged band moved {sh:+.2f}: ratio {h['ratio']:.2f} +- {h['err']:.2f} (December {h['n_dec']} photos, August {h['n_aug']})")
    hard_lo = min(h["ratio"] for h in hard.values())
    hard_hi = max(h["ratio"] for h in hard.values())
    for ap, (r_, e_) in others.items():
        print(f"aperture {ap} px: ratio {r_:.2f} +- {e_:.2f}")
    for name, (r_, e_) in alt.items():
        print(f"scaling {name}: ratio {r_:.2f} +- {e_:.2f}")

    # spring: the comet's position is Horizons', as seen from SPHEREx (IRSA's table has no spring photos)
    tpl = dec_template(rows["horizons"]["dec"])
    spring = [r for r in s3.map_threads(lambda k: measure_spring(frames[k], pos[k]), by["apr"]) if r]
    spring = [r for r in spring if r["n_empty"] >= 8]
    sp = spring_solve(spring, tpl)
    sp_const = spring_solve(spring, tpl, power=2.0)
    nulls = spring_nulls(spring, tpl)
    print(f"spring: {len(spring)} photos, {sp['n_in']} in the band; excess {sp['excess']:+.2f} +- {sp['err']:.2f} mJy; "
          f"limit {sp['limit']:.2f}; expected {sp['expected']:.1f}; excluded at {sp['excluded']:.1f} sigma "
          f"(constant-speed scaling: expected {sp_const['expected']:.1f}, {sp_const['excluded']:.1f} sigma); "
          f"empty places: {nulls['n']}, scatter of significance {nulls['std']:.2f}")

    # pictures
    fig, axs = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    draw_band(axs[0], fa, "August 2025")
    draw_band(axs[1], fd, "December 2025")
    fig.tight_layout()
    img = save(fig, IMG / "k4-bands.png")
    fig, axs = plt.subplots(1, 3, figsize=(15, 4.2))
    draw_band(axs[0], fa, "August 2025")
    draw_band(axs[1], fd, "December 2025")
    draw_spring(axs[2], spring, tpl, sp)
    fig.tight_layout()
    sheet_png = save(fig, REVIEW / "h4.png")

    # verdicts
    comb = math.hypot(rat_e, PUBLISHED[1])
    diff = rat - PUBLISHED[0]
    within = abs(diff) <= comb
    repro_ok = abs(rat - REPRODUCE[0]) <= REPRO_TOL
    n_dec_in, n_aug_in = fd["n_in"], fa["n_in"]
    # The team reads this row as a limit, not as a pass (decided on 15 November 2026): the ratio lies within the
    # combined error only with the aperture on IRSA's positions, not on those of JPL Horizons. A ratio outside
    # the combined error would still be a failure.
    status = "LIMIT" if within else "FAIL"
    a2, a2e = alt["distance squared"]
    alt_verdict = ("still within the combined error of the published ratio"
                   if abs(a2 - PUBLISHED[0]) <= math.hypot(a2e, PUBLISHED[1]) else "outside the combined error of the published ratio")
    hz, hze = centres["horizons"]
    hz_verdict = "would pass" if abs(hz - PUBLISHED[0]) <= math.hypot(hze, PUBLISHED[1]) else "would not pass"
    ce, cee = centres["centred"]
    a5, a5e = others[5]
    a5_verdict = "would pass" if abs(a5 - PUBLISHED[0]) <= math.hypot(a5e, PUBLISHED[1]) else "would not pass"
    k4 = checks.row(
        "K4", "Agrees with a published ratio only within a wide margin, on the same photos (not independent)",
        "Interstellar comet 3I/ATLAS gave off more carbon dioxide in December 2025 than in August 2025. From the same "
        "SPHEREx photos, the December over August ratio of the band at 4.26 µm, corrected for distance, comes out as "
        "the published ratio within the combined error.",
        f"Flux of the comet in a {APERTURES[0]}-pixel aperture (12.3 arcsec) with a background ring of {RING[0]:g} to "
        f"{RING[1]:g} pixels, in the photos of detector 5 ({len(aug5)} in August, {len(dec5)} in December), the aperture "
        f"centred on the position in IRSA's table of the comet's observations; {n_aug_in} and {n_dec_in} of the photos "
        "lie inside 4.20 to 4.32 µm. For each pass, a Gaussian is fitted to the flux above the "
        "continuum between 4.15 and 4.40 µm, and its area is the band. A band with hard edges is not used: moving its "
        f"edges by 0.01 µm swings the ratio from {hard_lo:.2f} to {hard_hi:.2f}. "
        "Scaling: the flux F in a fixed angle on the sky is proportional to Q / (r_h² x Δ), where Q is the number of "
        "molecules the nucleus gives off each second, r_h the distance from the Sun and Δ the distance from the "
        "telescope (gas leaving at a constant speed); so each photo is multiplied by r_h² x Δ before the fit. The "
        "published ratio is 3.0e27 over 1.6e27 molecules a second (Lisse et al.): a ratio of two production rates "
        "that those papers derive from their own model of the coma. The parts of the two papers read for this check "
        "do not say how, so this test cannot say whether the two quantities are the same; "
        "they are the same kind of quantity (carbon dioxide in a 2-pixel aperture on the same photos) and both are "
        "scaled to the same distances. With the scaling Δ² in place of Δ the ratio would be "
        f"{a2:.2f}, {alt_verdict}. "
        "The ratio also depends on where the aperture sits: centred on the position from JPL Horizons as seen from "
        f"SPHEREx (0.3 to 3 arcsec from IRSA's) it is {hz:.2f} ± {hze:.2f}, which {hz_verdict}; centred on the light of "
        f"each bright photo it is {ce:.2f} ± {cee:.2f}; with a 5-pixel aperture, which hardly depends on the centring, it is "
        f"{a5:.2f} ± {a5e:.2f}, which {a5_verdict}. "
        f"In spring 2026 the band is not there: {sp['n_in']} photos in the band give {sp['excess']:+.1f} ± {sp['err']:.1f} mJy "
        f"(3-sigma limit {sp['limit']:.1f} mJy) against {sp['expected']:.0f} mJy expected if production had stayed what "
        f"it was in December; that is excluded at {sp['excluded']:.0f} sigma.",
        "PASS if the ratio lies within the combined error of the published ratio (1.88 ± 0.34): "
        f"|{rat:.2f} - 1.88| <= {comb:.2f}. The test is weak: the photos are the same ones, a result 20% away "
        "would also pass, and the centring of the aperture moves the result by more than its stated error. For that "
        "last reason the row is read as a limit, not as a pass.",
        status, "reproduces a published ratio on the same photos (not independent)",
        f"{rat:.2f} ± {rat_e:.2f}", "times", "1.88 ± 0.34", f"combined error {comb:.2f}", checks.image_ref(img),
        reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run threei")
    rows_path = ROOT / "site" / "data" / "checks" / "rows" / "p5.json"
    keep = []
    if rows_path.exists():
        keep = [r for r in json.loads(rows_path.read_text(encoding="utf-8")) if r["id"] != "K4"]
    checks.write_rows("p5", [k4] + keep)

    ent = {
        "threei.ratio": numbers.entry(rat, 2, err=rat_e, check="K4"),
        "threei.ratio.published": numbers.entry(PUBLISHED[0], 2, err=PUBLISHED[1], check="K4"),
        "threei.ratio.combined": numbers.entry(comb, 2, check="K4"),
        "threei.ratio.difference": numbers.entry(diff, 2, check="K4"),
        "threei.ratio.hard_low": numbers.entry(hard_lo, 2, check="K4"),
        "threei.ratio.hard_high": numbers.entry(hard_hi, 2, check="K4"),
        "threei.ratio.delta_squared": numbers.entry(a2, 2, err=a2e, check="K4"),
        "threei.ratio.horizons_centre": numbers.entry(hz, 2, err=hze, check="K4"),
        "threei.ratio.light_centre": numbers.entry(ce, 2, err=cee, check="K4"),
        "threei.ratio.aperture5": numbers.entry(a5, 2, err=a5e, check="K4"),
        "threei.aug.n_band": numbers.entry(n_aug_in, 0, check="K4"),
        "threei.dec.n_band": numbers.entry(n_dec_in, 0, check="K4"),
        "threei.aug.n_fit": numbers.entry(fa["n_win"], 0, check="K4"),
        "threei.dec.n_fit": numbers.entry(fd["n_win"], 0, check="K4"),
        "threei.aug.centre": numbers.entry(fa["mu"], 4, unit="µm", check="K4"),
        "threei.dec.centre": numbers.entry(fd["mu"], 4, unit="µm", check="K4"),
        "threei.spring.n_band": numbers.entry(sp["n_in"], 0, check="K4"),
        "threei.spring.excess": numbers.entry(sp["excess"], 1, err=sp["err"], unit="mJy", check="K4"),
        "threei.spring.limit": numbers.entry(sp["limit"], 1, unit="mJy", check="K4"),
        "threei.spring.expected": numbers.entry(sp["expected"], 1, unit="mJy", check="K4"),
        "threei.spring.excluded": numbers.entry(sp["excluded"], 0, unit="sigma", check="K4"),
        "threei.spring.excluded_constant_speed": numbers.entry(sp_const["excluded"], 0, unit="sigma", check="K4"),
    }
    numbers.write("p5", ent)

    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "h4.md").write_text(
        sheet_text(fa, fd, rat, rat_e, comb, within, repro_ok, shifted, others, alt, hard, sp, sp_const, nulls, len(spring),
                   centres, status),
        encoding="utf-8", newline="\n")
    print(f"K4 {status}; sheet {sheet_png}")
    return 0 if within and repro_ok else 1


def sheet_text(fa, fd, rat, rat_e, comb, within, repro_ok, shifted, others, alt, hard, sp, sp_const, nulls, n_spring,
               centres, status) -> str:
    L = [
        "# H4: the 3I/ATLAS reproduction",
        "",
        "Open `h4.png`. Left and centre: flux above the sky against colour for August and December 2025, scaled by",
        "distance, with the fitted Gaussian; the shaded band is the one counted for \"photos in the band\". Right: the",
        "spring 2026 photos against what December's profile predicts if production had not changed.",
        "",
        "**Numbers to read**",
        "",
        f"- Photos in the band 4.20 to 4.32 µm: August {fa['n_in']}, December {fd['n_in']} (fit windows hold {fa['n_win']} and {fd['n_win']}).",
        f"- December over August: {rat:.2f} ± {rat_e:.2f}. Published: 1.88 ± 0.34. Difference {rat - PUBLISHED[0]:+.2f}, combined error {comb:.2f}.",
        f"- Earlier run by different code: {REPRODUCE[0]} ± {REPRODUCE[1]}; this run differs by {rat - REPRODUCE[0]:+.3f} (allowed {REPRO_TOL}).",
        "- Where the aperture sits (the row uses IRSA's table): "
        + "; ".join(f"{n}: {r:.2f} ± {e:.2f}" for n, (r, e) in centres.items())
        + ". The position of IRSA's table and the one from JPL Horizons as seen from SPHEREx differ by 0.3 to 3 arcsec;"
        " the median distance of the light's centre from the nominal position is smaller for Horizons' (0.21 against 0.26 pixel in the check made while writing the job).",
        "- Edges moved by 0.01 µm, fitted band: "
        + ", ".join(f"{sh:+.2f} µm: {r:.2f} ± {e:.2f}" for sh, (r, e) in shifted.items()) + ".",
        "- Hard-edged band (not used): "
        + ", ".join(f"{sh:+.2f} µm: {h['ratio']:.2f}" for sh, h in hard.items()) + ".",
        "- Larger apertures: " + ", ".join(f"{ap} px: {r:.2f} ± {e:.2f}" for ap, (r, e) in others.items()) + ".",
        "- Other scalings (not the row's): " + "; ".join(f"{n}: {r:.2f} ± {e:.2f}" for n, (r, e) in alt.items()) + ".",
        f"- Spring 2026: {n_spring} photos measured, {sp['n_in']} in the band; excess {sp['excess']:+.2f} ± {sp['err']:.2f} mJy; "
        f"3-sigma limit {sp['limit']:.1f} mJy; expected {sp['expected']:.1f} mJy if production stayed the same "
        f"(gas speed falling as r_h^-0.5); excluded at {sp['excluded']:.1f} sigma "
        f"({sp_const['excluded']:.1f} sigma with constant gas speed, expected {sp_const['expected']:.1f} mJy). "
        f"Empty places of the same colour in the same photos: {nulls['n']}, scatter of their significance {nulls['std']:.2f} (about 1 if the noise is right). "
        f"The earlier run gave limit {SPRING_RERUN['limit']} mJy and {SPRING_RERUN['sigma']} sigma; it put its empty places on lines of constant colour read with the distortion terms on.",
        "",
        "**What the published value is**",
        "",
        "The published 1.88 is 3.0e27 divided by 1.6e27 molecules a second, the carbon-dioxide production rates in the",
        "December paper (arXiv 2601.06759) and the August paper (arXiv 2512.07318). Our number is the ratio of the",
        "areas of the 4.26 µm band, scaled by r_h² x Δ, which stands in for the ratio of production rates if the gas",
        "leaves at constant speed. The December paper says its photometry uses a 2-pixel aperture with an annulus and is",
        "\"corrected to rh=Delta=1au\" (the power of each distance is not stated in the part read). The August",
        "paper's full text and the model behind either Q were not read. So the two quantities are of the",
        "same kind and not shown to be identical. The reviewer decides whether that wording on the row is enough.",
        "",
        "**It passes if**",
        "",
        f"1. The ratio is within the combined error of 1.88 ± 0.34 ({'yes' if within else 'NO'}: difference {rat - PUBLISHED[0]:+.2f}, allowed {comb:.2f}).",
        f"2. It agrees with the earlier run to {REPRO_TOL} ({'yes' if repro_ok else 'NO'}).",
        "3. The row says that the test is weak (the same photos; a 20% error would also pass), that the definitions may differ and that the centring of the aperture moves the ratio.",
        "4. The comet appears on the Checks page only.",
        "",
        f"Status written by the job: {status}. Reviewer's role and date are set with",
        "`python -m sx.run threei --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ]
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
