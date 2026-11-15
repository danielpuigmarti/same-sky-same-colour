"""Job limits: what the difference view can and cannot see (E5, Checks row K10).

    python -m sx.run limits [--reviewed "<role>" <YYYY-MM-DD>]

Synthetic movers are injected into the real matched co-adds (and, for the flipbook, into the real single pairs) at three
fixed positions of each detector, by the rule in pipeline/frozen/limits_rule.json, which was written before this job was
run. A mover shows when its dark-bright pair reaches 5 noise units in at least 80% of the injections. The table of the
speeds and brightnesses that show is written whatever it says.

Reads the positions of pipeline/frozen/pb6_rule.json and runs them as diffcheck does (the byte ranges are in the cache
after diffcheck). Writes site/data/checks/limits.json, the row K10 in site/data/checks/rows/p4.json, numbers
limits.* in site/data/numbers/p4.json and site/data/checks/img/k10-limits.png.

limits.json: {id, rule_sha256, psf_sigma_px, units, fraction, injections_per_cell, speeds_arcsec_per_year,
fluxes_mjy, runs: [{det, name, ra, dec, pairs, dt_days, shown_fraction: {coadd, pair}, noise_mjysr: {coadd, pair},
noise_mjy_per_pixel: {...}}], views: {coadd|pair: {det: {fraction: [speed][flux], limit_mjy: [speed]}}},
table: {coadd|pair: [{speed_arcsec_per_year, shift_px, limit_mjy: {det: number or null}}]}, summary}.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from sx import checks, numbers  # noqa: E402

from jobs import _p4lib as L  # noqa: E402
from jobs import diffcheck as D  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RULE_FILE = ROOT / "pipeline" / "frozen" / "limits_rule.json"
OUT = ROOT / "site" / "data" / "checks" / "limits.json"
IMG = checks.IMG_DIR
SIGMA = 1.0
UNITS = 5.0
FRACTION = 0.8
PER_CELL = 8
SEED = 20261114
SPEEDS = [0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0, 200.0]
FLUXES = [10 ** (k / 4.0) for k in range(-8, 13)]
MIN_PAIRS_FOR_LIMITS = 4
BLUE, ORANGE, GREY, INK = "#1f5fa8", "#c45a00", "#8a8f98", "#1b1f23"


def rule_sha() -> str:
    return hashlib.sha256(RULE_FILE.read_bytes()).hexdigest()


def draws(d: dict, shift_px: float, rng: np.random.Generator, n: int) -> list[tuple[float, float, float, float]] | None:
    """n injection geometries (xa, ya, xb, yb) for one run and one shift, or None when none can be found."""
    units, valid = d["units"], d["valid"].astype(bool)
    out = []
    tries = 0
    while len(out) < n and tries < 400 * n:
        tries += 1
        r, a = 20.0 * math.sqrt(rng.uniform()), rng.uniform(0, 2 * math.pi)
        xa, ya = 31.5 + r * math.cos(a), 31.5 + r * math.sin(a)
        t = rng.uniform(0, 2 * math.pi)
        xb, yb = xa + shift_px * math.cos(t), ya + shift_px * math.sin(t)
        if math.hypot(xb - 31.5, yb - 31.5) > 28.0:
            continue
        bad = False
        for x, y in ((xa, ya), (xb, yb)):
            m = L.disc(x, y, 5.0) & valid
            if np.any(np.abs(units[m]) >= 3.0):
                bad = True
        if bad:
            continue
        out.append((xa, ya, xb, yb))
    return out if len(out) == n else None


def shows(units: np.ndarray, valid: np.ndarray, g: tuple[float, float, float, float], amp_units: float) -> bool:
    """Does a mover of peak `amp_units` noise units (before the Gaussian is spread) show its pair in this difference?"""
    xa, ya, xb, yb = g
    gb = L.gaussian_image(xb, yb, amp_units, SIGMA)
    ga = L.gaussian_image(xa, ya, amp_units, SIGMA)
    u = units + gb - ga
    da, db = L.disc(xa, ya, 2.0) & valid, L.disc(xb, yb, 2.0) & valid
    if not da.any() or not db.any():
        return False
    return bool(u[da].min() <= -UNITS and u[db].max() >= UNITS)


def cell_table(d: dict, dt_years: float, seed: int) -> dict:
    """fraction[speed][flux] for one difference (one run, one view), and the noise that the fluxes are measured against."""
    units = np.where(np.isfinite(d["units"]), d["units"], 0.0)
    valid = d["valid"].astype(bool)
    sigma_mjysr = float(d["sigma"])
    frac = []
    shifts = []
    for k, v in enumerate(SPEEDS):
        shift_px = v * dt_years / L.PX_ARCSEC
        shifts.append(shift_px)
        g = draws(d, shift_px, np.random.default_rng(seed + 1000 * k), PER_CELL)
        row = []
        for f in FLUXES:
            if g is None:
                row.append(None)
                continue
            amp_mjysr = f / L.MJY_SR_PX_TO_MJY / (2.0 * math.pi * SIGMA * SIGMA)
            amp_units = amp_mjysr / sigma_mjysr
            row.append(float(np.mean([shows(units, valid, geo, amp_units) for geo in g])))
        frac.append(row)
    return {"fraction": frac, "shift_px": shifts, "noise_mjysr": sigma_mjysr, "noise_mjy_per_pixel": sigma_mjysr * L.MJY_SR_PX_TO_MJY}


def limit_flux(fracs: list[float | None]) -> float | None:
    """The lowest flux of the grid from which every higher flux also reaches the fraction."""
    best = None
    for f, v in zip(reversed(FLUXES), reversed(fracs)):
        if v is not None and v >= FRACTION:
            best = f
        else:
            break
    return best


def choose(rule: dict) -> dict[int, list[dict]]:
    """The positions of the PB6 list that were run in each detector, in the order of the list; main() takes the first
    three that give enough pairs."""
    by: dict[int, list[dict]] = {d: [] for d in range(1, 7)}
    for p in rule["positions"]:
        for det in p["dets"]:
            by[det].append({"name": p["name"], "ra": p["ra"], "dec": p["dec"], "det": det})
    return by


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    pb6 = D.load_rule()
    if len(pb6["positions"]) != pb6["tests"]["empty"]["positions"]:
        print("run diffcheck --select first")
        return 1
    chosen = choose(pb6)
    runs_out = []
    views: dict = {"coadd": {}, "pair": {}}
    for det in range(1, 7):
        acc = {"coadd": [], "pair": []}
        taken = 0
        for p in chosen[det]:
            if taken == 3:
                break
            r = D.run(p["ra"], p["dec"], det)
            if not r["ok"] or len(r["used"]) < MIN_PAIRS_FOR_LIMITS:
                print(f"D{det} {p['name']}: skipped ({r['why'] or str(len(r['used'])) + ' pairs'})")
                continue
            taken += 1
            dt = r["plan"].dt_days / 365.25
            for view, d in (("coadd", r["co"]), ("pair", r["flips"][0])):
                tab = cell_table(d, dt, SEED + 17 * det + taken)
                acc[view].append(tab)
            runs_out.append({"det": det, "name": p["name"], "ra": p["ra"], "dec": p["dec"], "pairs": len(r["used"]), "dt_days": r["plan"].dt_days,
                             "shown_fraction": {"coadd": float(r["co"]["valid"].mean()), "pair": float(r["flips"][0]["valid"].mean())},
                             "noise_mjy_per_pixel": {"coadd": acc["coadd"][-1]["noise_mjy_per_pixel"], "pair": acc["pair"][-1]["noise_mjy_per_pixel"]}})
            print(f"D{det} {p['name']}: {len(r['used'])} pairs, {dt * 365.25:.0f} days; noise per pixel {acc['coadd'][-1]['noise_mjy_per_pixel'] * 1000:.1f} and "
                  f"{acc['pair'][-1]['noise_mjy_per_pixel'] * 1000:.1f} microJy (co-add, pair); shown {runs_out[-1]['shown_fraction']['coadd']:.2f}, {runs_out[-1]['shown_fraction']['pair']:.2f}", flush=True)
        for view in ("coadd", "pair"):
            if not acc[view]:
                views[view][str(det)] = None
                continue
            frac = []
            for k in range(len(SPEEDS)):
                row = []
                for j in range(len(FLUXES)):
                    vals = [t["fraction"][k][j] for t in acc[view] if t["fraction"][k][j] is not None]
                    row.append(float(np.mean(vals)) if vals else None)
                frac.append(row)
            views[view][str(det)] = {"positions": len(acc[view]), "fraction": frac, "limit_mjy": [limit_flux(frac[k]) for k in range(len(SPEEDS))],
                                     "max_fraction": [max(x for x in frac[k] if x is not None) for k in range(len(SPEEDS))]}
    dts = [r["dt_days"] / 365.25 for r in runs_out]
    dt_med = float(np.median(dts)) if dts else float("nan")
    table = {}
    for view in ("coadd", "pair"):
        rows = []
        for k, v in enumerate(SPEEDS):
            rows.append({"speed_arcsec_per_year": v, "shift_px": v * dt_med / L.PX_ARCSEC,
                         "limit_mjy": {det: (views[view][det]["limit_mjy"][k] if views[view][det] else None) for det in views[view]}})
        table[view] = rows
    summary = {}
    for view in ("coadd", "pair"):
        med = {}
        for row in table[view]:
            vals = [x for x in row["limit_mjy"].values() if x is not None]
            med[str(row["speed_arcsec_per_year"])] = float(np.median(vals)) if len(vals) * 2 > len(row["limit_mjy"]) else None
        best = max((max(v["max_fraction"]) for v in views[view].values() if v), default=0.0)
        summary[view] = {"median_limit_mjy": med, "highest_share_reached": best,
                         "shown_fraction_median": float(np.median([r["shown_fraction"][view] for r in runs_out])) if runs_out else None}
    doc = {"id": "E5", "rule_sha256": rule_sha(), "psf_sigma_px": SIGMA, "units": UNITS, "fraction": FRACTION, "injections_per_cell": PER_CELL,
           "median_years_between_visits": dt_med, "speeds_arcsec_per_year": SPEEDS, "fluxes_mjy": FLUXES, "runs": runs_out, "views": views, "table": table,
           "summary": summary}
    checks.write_json(OUT, doc)
    img = figure(doc)
    write_row_and_numbers(doc, img, reviewer)
    print(json.dumps(summary, indent=1))
    print("limit, median over the detectors that have one (mJy); '-' when fewer than half of the detectors show:")
    for view in ("coadd", "pair"):
        print(view)
        for row in table[view]:
            print(f"  {row['speed_arcsec_per_year']:6g} arcsec/yr ({row['shift_px']:5.2f} px): " + "  ".join(
                f"D{d}:{'-' if v is None else format(v, '.3g')}" for d, v in row["limit_mjy"].items()))
    return 0


def figure(doc: dict) -> Path:
    fig, axs = plt.subplots(2, 6, figsize=(16, 5.6), sharex=True, sharey=True)
    sp = np.array(doc["speeds_arcsec_per_year"])
    fl = np.array(doc["fluxes_mjy"])
    for r, view in enumerate(("coadd", "pair")):
        for c in range(6):
            ax = axs[r][c]
            v = doc["views"][view].get(str(c + 1))
            if v is None:
                ax.text(0.5, 0.5, "not run", transform=ax.transAxes, ha="center")
                continue
            z = np.array([[np.nan if x is None else x for x in row] for row in v["fraction"]]).T
            ax.imshow(z, origin="lower", aspect="auto", vmin=0, vmax=1, cmap="viridis",
                      extent=(-0.5, len(sp) - 0.5, np.log10(fl[0]) - 0.125, np.log10(fl[-1]) + 0.125))
            ax.contour(np.arange(len(sp)), np.log10(fl), z, levels=[FRACTION], colors="white", linewidths=1.2)
            ax.set_title(f"detector {c + 1}, {'co-add of the pairs' if view == 'coadd' else 'one pair'}", fontsize=8)
            ax.set_xticks(range(len(sp)))
            ax.set_xticklabels([f"{s:g}" for s in sp], fontsize=6, rotation=90)
            if c == 0:
                ax.set_ylabel("flux of the mover, log10 mJy", fontsize=8)
            if r == 1:
                ax.set_xlabel("speed, arcsec a year", fontsize=7)
    fig.suptitle("Share of injected movers whose dark-bright pair reaches 5 noise units (white line: 80%)", fontsize=10)
    fig.tight_layout()
    return D._save(fig, IMG / "k10-limits.png")


def write_row_and_numbers(doc: dict, img: Path, reviewer) -> None:
    sentence = []
    for name, v in (("co-add", doc["summary"]["coadd"]), ("single pair", doc["summary"]["pair"])):
        med = v["median_limit_mjy"]
        part = ", ".join(f"{x:.3g} mJy at {k} arcsec a year" for k, x in med.items() if x is not None and k in ("1.0", "10.0", "100.0"))
        shown = f"; the view shows {100 * v['shown_fraction_median']:.0f}% of its pixels" if v["shown_fraction_median"] is not None else ""
        if part:
            sentence.append(f"{name}: flux needed (median of the detectors) {part}{shown}")
        else:
            sentence.append(f"{name}: no speed of the grid shows in 80% of the injections, even at {doc['fluxes_mjy'][-1]:.0f} mJy; the highest share reached is {100 * v['highest_share_reached']:.0f}%{shown}")
    row = checks.row(
        "K10", "What the difference view can and cannot see",
        "A moving object shows as a dark-bright pair in the difference of two visits only when it moves far enough and is bright enough. The table says where that starts, "
        "for each of the six detectors; what is not in it is not seen.",
        f"Synthetic movers (round Gaussian, sigma 1 pixel) injected into the real matched co-adds, and into real single pairs, at 3 fixed positions of each detector, "
        f"{PER_CELL} injections per position for each of {len(SPEEDS)} speeds and {len(FLUXES)} fluxes. The shift between visits is the speed times the time between them "
        f"(median {doc['median_years_between_visits'] * 365.25:.0f} days).",
        f"A mover shows when its dark-bright pair reaches {UNITS:g} noise units in at least {int(FRACTION * 100)}% of the injections. Rule written before the run "
        "(pipeline/frozen/limits_rule.json; the code in the column of the commit is the first 40 characters of the SHA-256 of that file). The table is shown whatever it says.",
        "PASS" if reviewer else "UNVERIFIED", "what the tool can and cannot see",
        "; ".join(sentence), "mJy and arcsec per year", None, None, checks.image_ref(img),
        reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run limits", doc["rule_sha256"][:40])
    L.put_rows([row])
    ent = {
        "limits.shift_years": numbers.entry(doc["median_years_between_visits"], 2, unit="years", check="K10"),
        "limits.injections": numbers.entry(sum(r["pairs"] > 0 for r in doc["runs"]) * PER_CELL, 0, check="K10"),
        "limits.runs": numbers.entry(len(doc["runs"]), 0, check="K10"),
        "limits.units": numbers.entry(UNITS, 0, check="K10"),
        "limits.fraction_pct": numbers.entry(FRACTION * 100, 0, unit="%", check="K10"),
    }
    for view in ("coadd", "pair"):
        v = doc["summary"][view]
        ent[f"limits.{view}.max_share_pct"] = numbers.entry(100 * v["highest_share_reached"], 0, unit="%", check="K10")
        ent[f"limits.{view}.shown_pct"] = numbers.entry(100 * v["shown_fraction_median"], 0, unit="%", check="K10")
        for k in ("1.0", "10.0", "100.0"):
            x = v["median_limit_mjy"].get(k)
            if x is not None:
                ent[f"limits.{view}.mjy_at_{int(float(k))}"] = numbers.entry(x, 2 if x < 10 else 0, unit="mJy", check="K10")
    numbers.write(L.PRODUCER, ent)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
