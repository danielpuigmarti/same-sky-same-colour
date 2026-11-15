"""Job diffcheck: pre-build check PB6 for the difference view and the same-colour flipbook (Checks row K8, review sheet
H8 and the empty-field part of H9).

    python -m sx.run diffcheck --select                     choose the ten new empty positions and write them into
                                                            pipeline/frozen/pb6_rule.json (nothing is judged here)
    python -m sx.run diffcheck [--reviewed "<role>" <YYYY-MM-DD>]

The rule is in pipeline/frozen/pb6_rule.json, written before anything was measured; this job reads every threshold from
it. Two views are judged separately: (a) the difference of per-visit co-adds on one sky grid, (b) single photos minus
their same-colour twin from the other visit (the flipbook). Three tests: the mean of an empty difference (20 positions),
the dark-bright pair at steady stars (the 20 comparison stars of RW Aurigae) and injected point sources (10).

Writes: site/data/checks/decisions/p4.json (S3), site/data/checks/rows/p4.json (row K8), site/data/numbers/p4.json,
site/data/checks/img/k8-pb6.png and k8-flipbooks.png, review/h8.md and review/h8.png.
Needs the network the first time (about 1 GB of byte ranges); the ranges are cached afterwards. Without --reviewed the
row stays UNVERIFIED.
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

from sx import checks, gaia, index, numbers, s3  # noqa: E402
from sx.fits import FLAG  # noqa: E402

from jobs import _p4lib as L  # noqa: E402
from jobs._rwaur_stars import STARS  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RULE_FILE = ROOT / "pipeline" / "frozen" / "pb6_rule.json"
DATA = ROOT / "site" / "data"
REVIEW = ROOT / "review"
DECISIONS = DATA / "checks" / "decisions" / "p4.json"
IMG = checks.IMG_DIR
INK, BLUE, ORANGE, GREY, GREEN, RED = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#2e7d32", "#b3261e"
PRODUCER = "p4"
STAR_EPOCH_MJD = 61000.0
"""The epoch the comparison stars are put at (about September 2025); at their motions the choice moves them by under 0.05 pixel."""

EARLIER = [
    ("ecl_000", 180.00355, -0.00154), ("ecl_p08", 201.33008, -0.77551), ("ecl_m06", 16.28296, 0.00377),
    ("ecl_m12", 147.2601, -0.08192), ("mid_p35", 212.40906, 24.87015), ("mid_m40", 49.91736, -23.32827),
    ("hi_p62", 214.35542, 56.00899), ("hi_p72", 218.7432, 78.83295), ("hi_m65", 39.96487, -56.54164),
    ("hi_m75", 50.99307, -71.22717),
]
"""The ten empty positions of the earlier background test (J2000, degrees), from the ecliptic to 75 degrees of latitude."""
NEW = [
    ("ecl_p03", 130.0, 3.0), ("ecl_m03", 220.0, -3.0), ("ecl_p15", 240.0, 15.0), ("ecl_m20", 20.0, -20.0),
    ("mid_p25", 330.0, 25.0), ("mid_p45", 150.0, 45.0), ("mid_m30", 75.0, -30.0), ("mid_m52", 40.0, -52.0),
    ("hi_p55", 250.0, 55.0), ("hi_m58", 10.0, -58.0),
]
"""The ten new positions: name, ecliptic longitude, ecliptic latitude (degrees). The search moves each in a fixed order
of offsets until Gaia, the index and the data say it is empty and testable."""
OFFS = sorted([(a, b) for a in np.arange(-2.5, 2.51, 0.5) for b in np.arange(-2.5, 2.51, 0.5)], key=lambda o: (math.hypot(*o), o))


def load_rule() -> dict:
    return json.loads(RULE_FILE.read_text(encoding="utf-8"))


def rule_sha() -> str:
    return hashlib.sha256(RULE_FILE.read_bytes()).hexdigest()


# -- one run: a position in one detector -----------------------------------------------------------------


def run(ra: float, dec: float, det: int, pl: L.Plan | None = None) -> dict:
    """Plan, stamps, planes, the difference of the co-adds and one difference for each pair."""
    pl = pl or L.plan(ra, dec, det)
    out: dict = {"ra": ra, "dec": dec, "det": det, "plan": pl, "ok": False, "why": pl.why}
    if not pl.ok:
        return out
    need = [pl.infos_a[i] for i, _ in pl.pairs] + [pl.infos_b[j] for _, j in pl.pairs]
    stamps = L.load_stamps(need, ra, dec)
    grid = L.sky_grid(ra, dec)
    pa, pb, used = [], [], []
    for i, j in pl.pairs:
        ka, kb = pl.infos_a[i]["key"], pl.infos_b[j]["key"]
        if ka not in stamps or kb not in stamps:
            continue
        a, b = L.make_plane(stamps[ka], grid), L.make_plane(stamps[kb], grid)
        if a is None or b is None:
            continue
        pa.append(a)
        pb.append(b)
        used.append((i, j))
    if len(pa) < L.MIN_PAIRS:
        out["why"] = f"{len(pa)} usable pairs"
        return out
    co = L.difference_of(pa, pb)
    flips = [L.difference_of([a], [b]) for a, b in zip(pa, pb)]
    vf = [float(L.difference_of(pa[:k], pb[:k])["valid"].mean()) for k in range(1, len(pa) + 1)]
    out.update(ok=True, why="", stamps=stamps, grid=grid, pa=pa, pb=pb, used=used, co=co, flips=flips, valid_by_pairs=vf)
    return out


def summarise(r: dict) -> dict:
    """The numbers of a run, as plain JSON values."""
    pl: L.Plan = r["plan"]
    base = {"det": r["det"], "ok": r["ok"], "why": r["why"], "frames_in_index": pl.n_index, "frames_with_stamp": pl.n_usable,
            "visits": [v["n"] for v in pl.visits]}
    if not r["ok"]:
        return base
    co = r["co"]
    mt = L.mean_test(co)
    base.update({
        "pairs": len(r["used"]), "dt_days": pl.dt_days,
        "lam_um": [float(np.mean([pl.infos_a[i]["lam"] for i, _ in r["used"]])), float(np.min([pl.infos_a[i]["lam"] for i, _ in r["used"]])),
                   float(np.max([pl.infos_a[i]["lam"] for i, _ in r["used"]]))],
        "coadd": {**mt, "matched_frac": float(co["matched"].mean()), "valid_frac": float(co["valid"].mean()),
                  "quiet_n": int(co["quiet"].sum())},
        "flips": [{**L.mean_test(f), "valid_frac": float(f["valid"].mean()), "matched_frac": float(f["matched"].mean())} for f in r["flips"]],
        "valid_by_pairs": r["valid_by_pairs"],
    })
    return base


def min_pixels(rule: dict) -> int:
    return int(rule["tests"]["empty"]["min_pixels"])


def run_passes(s: dict, rule: dict, view: str) -> bool | None:
    """Does the zero-mean test hold for one summarised run? None when it cannot be tested."""
    zmax = rule["tests"]["empty"]["z_max"]
    mp = min_pixels(rule)
    if not s["ok"]:
        return None
    if view == "difference":
        t = s["coadd"]
        return bool(t.get("ok") and t["n"] >= mp and abs(t["z"]) <= zmax)
    return all(t.get("ok") and t["n"] >= mp and abs(t["z"]) <= zmax for t in s["flips"])


def run_passes_clipped(s: dict, rule: dict, view: str) -> bool | None:
    """The same as run_passes with the mean taken after a 5-sigma clip (for comparison with the earlier test; not the rule)."""
    zmax = rule["tests"]["empty"]["z_max"]
    if not s["ok"]:
        return None
    if view == "difference":
        t = s["coadd"]
        return bool("z_clip" in t and abs(t["z_clip"]) <= zmax)
    return all("z_clip" in t and abs(t["z_clip"]) <= zmax for t in s["flips"])


# -- choosing the positions ------------------------------------------------------------------------------


def brightest_g(ra: float, dec: float, radius_arcmin: float = 5.0) -> float | None:
    g = [s["phot_g_mean_mag"] for s in gaia.cone(ra, dec, radius_arcmin / 60.0) if s["phot_g_mean_mag"] is not None]
    return float(min(g)) if g else None


def galactic_b(ra: float, dec: float) -> float:
    from astropy import units as u
    from astropy.coordinates import SkyCoord

    return float(SkyCoord(ra * u.deg, dec * u.deg).galactic.b.deg)


def ecliptic_lat(ra: float, dec: float) -> float:
    from astropy import units as u
    from astropy.coordinates import SkyCoord

    return float(SkyCoord(ra * u.deg, dec * u.deg).barycentrictrueecliptic.lat.deg)


def testable(ra: float, dec: float, dets: tuple, rule: dict) -> tuple[bool, str]:
    """Can the position be run in both detectors? Counts pairs and pixels only; no mean is looked at."""
    for det in dets:
        r = run(ra, dec, det)
        if not r["ok"]:
            return False, f"detector {det}: {r['why']}"
        n = int(L.used_pixels(r["co"])[0].sum())
        if n < min_pixels(rule) or any(int(L.used_pixels(f)[0].sum()) < min_pixels(rule) for f in r["flips"]):
            return False, f"detector {det}: too few pixels to test ({n})"
    return True, ""


def select(rule: dict) -> dict:
    """Ten earlier positions as they are, ten new ones chosen by the order of offsets. Written into the rule file."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord

    pos = []
    for name, ra, dec in EARLIER:
        g = brightest_g(ra, dec)
        pos.append({"name": name, "ra": ra, "dec": dec, "dets": [2, 5], "source": "earlier test", "ecl_lat": round(ecliptic_lat(ra, dec), 1),
                    "gal_b": round(galactic_b(ra, dec), 1), "brightest_g_5arcmin": g})
        print(pos[-1], flush=True)
    def search(k: int, name: str, lon: float, lat: float) -> dict:
        dets = [1, 4] if k % 2 == 0 else [3, 6]
        for dl, db in OFFS:
            la = lat + db
            e = SkyCoord((lon + dl / max(math.cos(math.radians(la)), 0.2)) * u.deg, la * u.deg, frame="barycentrictrueecliptic")
            c = e.icrs
            ra, dec = round(float(c.ra.deg), 5), round(float(c.dec.deg), 5)
            b = galactic_b(ra, dec)
            if abs(b) <= 20 or not index.is_indexed(ra, dec):
                continue
            g = brightest_g(ra, dec)
            if g is not None and g < 13:
                continue
            ok, why = testable(ra, dec, tuple(dets), rule)
            print(name, ra, dec, "b", round(b, 1), "brightest G", g, "ok" if ok else why, flush=True)
            if ok:
                return {"name": name, "ra": ra, "dec": dec, "dets": dets, "source": "selected by this job", "ecl_lat": round(float(e.lat.deg), 1),
                        "gal_b": round(b, 1), "brightest_g_5arcmin": g}
        raise SystemExit(f"no testable position found for {name}")

    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(4) as ex:
        pos += list(ex.map(lambda t: search(t[0], *t[1]), list(enumerate(NEW))))
    rule["positions"] = pos
    rule["positions_chosen"] = "by diffcheck --select, from Gaia DR3 (no star brighter than G = 13 within 5 arcmin, galactic latitude beyond 20 degrees), the frame index and the count of pairs and quiet pixels; no mean was looked at"
    RULE_FILE.write_text(json.dumps(rule, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return rule


# -- the injection test ----------------------------------------------------------------------------------


def fit_amp(diff: np.ndarray, valid: np.ndarray, cx: float, cy: float, sigma: float, r_ap: float) -> tuple[float, int]:
    """Least-squares peak of a round Gaussian of width sigma at (cx, cy) over the valid pixels within r_ap: the
    amplitude a that minimises the sum of (diff - a g)^2, g the unit Gaussian. Returns (a, number of pixels)."""
    n = diff.shape[0]
    yy, xx = np.mgrid[:n, :n]
    r2 = (xx - cx) ** 2 + (yy - cy) ** 2
    m = (r2 <= r_ap * r_ap) & valid & np.isfinite(diff)
    g = np.exp(-r2 / (2.0 * sigma * sigma))[m]
    if m.sum() == 0:
        return float("nan"), 0
    return float((g * diff[m]).sum() / (g * g).sum()), int(m.sum())


def inject_test(r: dict, rule: dict, seed: int) -> dict:
    cfg = rule["tests"]["injection"]
    sigma, r_ap = 1.0, float(cfg["aperture_radius_px"])
    co, flips, grid = r["co"], r["flips"], r["grid"]
    cvalid = co["valid"].astype(bool)
    rng = np.random.default_rng(seed)
    site = None
    for _ in range(2000):
        ang, dist = rng.uniform(0, 2 * math.pi), rng.uniform(8.0, 20.0)
        cx, cy = 31.5 + dist * math.cos(ang), 31.5 + dist * math.sin(ang)
        near = L.disc(cx, cy, 5.0)
        core = L.disc(cx, cy, 2.15)
        if (core & cvalid).sum() < 4:
            continue
        if any(np.any(np.abs(d["units"][near & d["valid"].astype(bool)]) >= 3) for d in [co] + flips):
            continue
        if any((core & f["valid"].astype(bool)).sum() < 6 for f in flips):
            continue
        site = (cx, cy)
        break
    if site is None:
        return {"ok": False, "why": "no clean site"}
    cx, cy = site
    n_ap = int(L.disc(cx, cy, r_ap).sum())
    total = 40.0 * co["scatter"] * math.sqrt(n_ap)
    amp = total / (2.0 * math.pi * sigma * sigma)
    ra_s, dec_s = (float(v) for v in grid.all_pix2world(cx, cy, 0))
    inj = {"ra": ra_s, "dec": dec_s, "amp": amp, "sigma": sigma}
    pbi = [L.make_plane(r["stamps"][r["plan"].infos_b[j]["key"]], grid, inject=inj) for _, j in r["used"]]
    d = L.difference_of(r["pa"], pbi)
    a_co, n_co = fit_amp(d["diff"], d["valid"].astype(bool), cx, cy, sigma, r_ap)
    ratios, ns = [], []
    for a, b in zip(r["pa"], pbi):
        f = L.difference_of([a], [b])
        a_f, n_f = fit_amp(f["diff"], f["valid"].astype(bool), cx, cy, sigma, r_ap)
        ratios.append(a_f / amp)
        ns.append(n_f)
    peak_native = amp / co["sigma"]
    return {"ok": True, "x": cx, "y": cy, "amp_mjysr": amp, "total_mjysr_px": total, "flux_mjy": total * L.MJY_SR_PX_TO_MJY, "units_expected": peak_native,
            "coadd_ratio": a_co / amp, "coadd_pixels": n_co, "flip_ratios": ratios, "flip_pixels": ns,
            "flip_median_ratio": float(np.median(ratios))}


# -- the comparison stars --------------------------------------------------------------------------------


STAR_DETECTORS = (4, 5, 3, 6, 2, 1)
"""The order in which a comparison star's detector is looked for (see the rule): the long-wavelength ones first."""


def star_detector(ra: float, dec: float) -> L.Plan | None:
    for det in STAR_DETECTORS:
        p = L.plan(ra, dec, det)
        if p.ok:
            return p
    return None


def star_run(star: dict, rule: dict) -> dict:
    cfg = rule["tests"]["stars"]
    thr, rad, minf = float(cfg["pair_units"]), float(cfg["disc_radius_px"]), float(cfg["min_disc_fraction"])
    ras, decs = gaia.propagate([star], STAR_EPOCH_MJD)
    ra, dec = float(ras[0]), float(decs[0])
    out = {"source_id": star["source_id"], "G": star["phot_g_mean_mag"], "ra": ra, "dec": dec}
    pl = star_detector(ra, dec)
    if pl is None:
        out.update(ok=False, why="fewer than 3 matched pairs in every detector")
        return out
    r = run(ra, dec, pl.det, pl)
    if not r["ok"]:
        out.update(ok=False, why=r["why"], det=pl.det)
        return out
    cx, cy = L.grid_xy(r["grid"], ra, dec)
    co = r["co"]
    flips = []
    for f in r["flips"]:
        t = L.pair_test(f["units"], cx, cy, rad, thr, minf)
        m = L.disc(cx, cy, rad) & np.isfinite(f["diff"]) & np.isfinite(f["coadd_a"]["data"])
        if t["testable"] and m.any():
            a = f["coadd_a"]["data"][m].astype(np.float64)
            dd = f["diff"][m].astype(np.float64)
            t["flux_resid_pct"] = float(100 * dd.sum() / a.sum()) if a.sum() != 0 else float("nan")
            t["peak_resid_pct"] = float(100 * np.max(np.abs(dd)) / np.max(a)) if np.max(a) > 0 else float("nan")
            t["peak_units"] = float(np.max(a) / f["sigmaA"])
        flips.append(t)
    ct = L.pair_test(co["units"], cx, cy, rad, thr, minf)
    m = L.disc(cx, cy, rad) & np.isfinite(co["diff"]) & np.isfinite(co["coadd_a"]["data"])
    if ct["testable"] and m.any():
        a = co["coadd_a"]["data"][m].astype(np.float64)
        dd = co["diff"][m].astype(np.float64)
        ct["flux_resid_pct"] = float(100 * dd.sum() / a.sum()) if a.sum() != 0 else float("nan")
        ct["peak_resid_pct"] = float(100 * np.max(np.abs(dd)) / np.max(a)) if np.max(a) > 0 else float("nan")
    out.update(ok=True, det=pl.det, pairs=len(r["used"]), coadd=ct, flips=flips, cx=cx, cy=cy,
               valid_by_pairs=r["valid_by_pairs"], _run=r)
    return out


def star_state(s: dict, view: str) -> str:
    """"pair" (a dark-bright pair is shown), "clean" (none is, and the star could be tested) or "hidden" (it could not be tested)."""
    if not s["ok"]:
        return "hidden"
    if view == "difference":
        t = s["coadd"]
        return "hidden" if not t["testable"] else ("pair" if t["pair"] else "clean")
    tested = [t for t in s["flips"] if t["testable"]]
    if 2 * len(tested) < len(s["flips"]):
        return "hidden"
    return "pair" if any(t["pair"] for t in tested) else "clean"


def star_passes(s: dict, view: str) -> bool:
    return star_state(s, view) == "clean"


# -- the whole measurement -------------------------------------------------------------------------------


def measure(rule: dict) -> dict:
    res: dict = {"positions": [], "stars": [], "inject": []}
    runs: dict = {}
    for k, pos in enumerate(rule["positions"]):
        entry = {"name": pos["name"], "ra": pos["ra"], "dec": pos["dec"], "ecl_lat": pos["ecl_lat"], "runs": []}
        for det in pos["dets"]:
            r = run(pos["ra"], pos["dec"], det)
            runs[(pos["name"], det)] = r
            s = summarise(r)
            entry["runs"].append(s)
            if r["ok"]:
                t = s["coadd"]
                print(f"{pos['name']:8s} D{det} pairs {s['pairs']} dt {s['dt_days']:.0f} d  co-add z {t.get('z', float('nan')):+.2f} (n {t['n']}, valid {t['valid_frac']:.2f})  "
                      f"flips z " + " ".join(f"{f['z']:+.1f}" for f in s["flips"] if f.get("ok")), flush=True)
            else:
                print(f"{pos['name']:8s} D{det} NOT RUN: {r['why']}", flush=True)
        res["positions"].append(entry)
        if pos["source"] == "earlier test":
            r = runs[(pos["name"], pos["dets"][0])]
            if r["ok"]:
                it = inject_test(r, rule, seed=20261114 + k)
                it["name"] = pos["name"]
                it["det"] = pos["dets"][0]
                res["inject"].append(it)
                if it["ok"]:
                    print(f"   injected source: co-add {it['coadd_ratio']:.3f}, flipbook median {it['flip_median_ratio']:.3f} (range {min(it['flip_ratios']):.2f} to {max(it['flip_ratios']):.2f})", flush=True)
            else:
                res["inject"].append({"name": pos["name"], "ok": False, "why": r["why"]})
    stars = []
    for st in STARS:
        s = star_run(st, rule)
        stars.append(s)
        if s["ok"]:
            f = [t for t in s["flips"] if t["testable"]]
            print(f"star G {s['G']:.1f} D{s['det']} pairs {s['pairs']}  co-add testable {s['coadd']['testable']} pair {s['coadd']['pair']}  flips testable {len(f)}/{len(s['flips'])} pair in "
                  f"{sum(t['pair'] for t in f)}  peak resid {np.nanmedian([t.get('peak_resid_pct', np.nan) for t in f]) if f else float('nan'):.0f}%", flush=True)
        else:
            print(f"star G {s['G']:.1f}: {s['why']}", flush=True)
    res["stars"] = stars
    res["_runs"] = runs
    return res


# -- the decision ----------------------------------------------------------------------------------------


def evaluate(res: dict, rule: dict) -> dict:
    t = rule["tests"]
    zmax = t["empty"]["z_max"]
    out: dict = {}
    for view in ("difference", "flipbook"):
        passes = []
        for p in res["positions"]:
            rs = [run_passes(s, rule, view) for s in p["runs"]]
            passes.append(bool(rs) and all(x is True for x in rs))
        n_empty = sum(passes)
        clip = [bool(p["runs"]) and all(run_passes_clipped(s, rule, view) is True for s in p["runs"]) for p in res["positions"]]
        stars = [star_passes(s, view) for s in res["stars"]]
        n_star = sum(stars)
        states = [star_state(s, view) for s in res["stars"]]
        tol = t["injection"]["tolerance"]
        inj = []
        for it in res["inject"]:
            if not it["ok"]:
                inj.append(False)
            elif view == "difference":
                inj.append(abs(it["coadd_ratio"] - 1) <= tol)
            else:
                inj.append(abs(it["flip_median_ratio"] - 1) <= tol)
        n_inj = sum(inj)
        out[view] = {"empty_clipped": sum(clip), "empty_clipped_by_position": clip, "empty": n_empty, "empty_needed": t["empty"]["needed"], "empty_of": len(res["positions"]), "empty_pass": n_empty >= t["empty"]["needed"],
                     "stars": n_star, "stars_needed": t["stars"]["needed"], "stars_of": len(res["stars"]), "stars_pass": n_star >= t["stars"]["needed"],
                     "inject": n_inj, "inject_needed": t["injection"]["needed"], "inject_of": len(res["inject"]), "inject_pass": n_inj >= t["injection"]["needed"],
                     "empty_by_position": passes, "stars_by_star": stars, "stars_with_pair": states.count("pair"), "stars_hidden": states.count("hidden"), "inject_untried": sum(1 for it in res["inject"] if not it["ok"]),
                     "inject_by_source": inj}
        out[view]["build"] = bool(out[view]["empty_pass"] and out[view]["stars_pass"] and out[view]["inject_pass"])
    return out


def star_numbers(res: dict) -> dict:
    """Medians over the stars that were tested in single pairs: the peak and the total flux left over in a pair."""
    peaks, fluxes, units = [], [], []
    for s in res["stars"]:
        if not s["ok"]:
            continue
        t = [x for x in s["flips"] if x["testable"] and "peak_resid_pct" in x]
        if t:
            peaks.append(float(np.median([x["peak_resid_pct"] for x in t])))
            fluxes.append(float(np.median([abs(x["flux_resid_pct"]) for x in t])))
            units.append(float(np.median([x["peak_units"] for x in t])))
    q = lambda v, p: float(np.percentile(v, p)) if v else float("nan")
    return {"n": len(peaks), "peak_median": q(peaks, 50), "peak_lo": q(peaks, 10), "peak_hi": q(peaks, 90), "flux_abs_median": q(fluxes, 50),
            "flux_abs_hi": q(fluxes, 90), "star_peak_units_median": q(units, 50)}


def valid_table(res: dict) -> list[float]:
    """Median over the runs of the share of the grid that is shown after k pairs, k = 1 to 8."""
    cols: dict = {}
    for p in res["positions"]:
        for s in p["runs"]:
            if s["ok"]:
                for k, v in enumerate(s["valid_by_pairs"]):
                    cols.setdefault(k + 1, []).append(v)
    return [float(np.median(cols[k])) for k in sorted(cols)]


def caption_text(sn: dict, ev: dict) -> str:
    if not sn["n"]:
        return ("Caption: no steady star could be measured in a single pair here, so nothing is known about how a star looks in the difference; "
                "do not say that stars cancel, and say that a pair at a star is not a change until the star has been checked against Gaia.")
    return (f"Caption: at a steady star the two photos do not cancel pixel by pixel: the pair leaves a dark and a bright patch, about "
            f"{sn['peak_median']:.0f}% of the star's peak in the middle of the range (middle 80% of stars: {sn['peak_lo']:.0f} to {sn['peak_hi']:.0f}%), "
            f"while the star's total light inside 3 pixels cancels to within about {sn['flux_abs_median']:.0f}% (90% of stars: under {sn['flux_abs_hi']:.0f}%). "
            f"A dark-bright pair at a star that Gaia lists is therefore the telescope's sampling and the turn of the sky between visits, not a change; "
            f"only a pair away from catalogued stars is worth a second look. Never say that stars cancel.")


def decisions(res: dict, ev: dict, rule: dict) -> dict:
    sn = star_numbers(res)
    cap = caption_text(sn, ev)
    out = {}
    for view, label in (("difference", "difference of co-adds"), ("flipbook", "flipbook of single photos")):
        e = ev[view]
        parts = [
            f"Empty fields: mean zero within {rule['tests']['empty']['z_max']} standard errors at {e['empty']} of {e['empty_of']} positions (rule: {e['empty_needed']} or more)",
            f"comparison stars with no dark-bright pair above {rule['tests']['stars']['pair_units']} noise units: {e['stars']} of {e['stars_of']} (rule: {e['stars_needed']} or more; "
            f"{e['stars_with_pair']} show a pair and {e['stars_hidden']} could not be tested because the view hides too many of their pixels)",
            f"injected sources recovered within {int(rule['tests']['injection']['tolerance'] * 100)}%: {e['inject']} of {e['inject_of']} (rule: {e['inject_needed']}"
            + (f"; {e['inject_untried']} could not be tried because the pixels the view shows left no clean place for a source)" if e["inject_untried"] else ")"),
        ]
        verdict = ("All three tests pass." if e["build"] else
                   "Not built at typed positions: " + ", ".join(n for n, ok in (("the empty-field test", e["empty_pass"]), ("the star test", e["stars_pass"]),
                                                                       ("the injection test", e["inject_pass"])) if not ok) + " failed. The view stays on prepared showcases and the stage says why.")
        extra = f" For comparison only, with the 5-sigma clip that the earlier background test used before taking the mean, {e['empty_clipped']} of {e['empty_of']} empty positions are within 3 standard errors."
        out[view] = {"build": bool(e["build"]), "why": f"{label[0].upper() + label[1:]}. " + "; ".join(parts) + "." + extra + " " + verdict + " " + cap}
    return out


def put_decision(dec: dict) -> Path:
    have = json.loads(DECISIONS.read_text(encoding="utf-8")) if DECISIONS.exists() else {}
    have["S3"] = dec
    checks.write_json(DECISIONS, dict(sorted(have.items())))
    return DECISIONS


# -- pictures --------------------------------------------------------------------------------------------

DIFF_CMAP = "RdBu_r"


def show_units(ax, units: np.ndarray, title: str = "", extent_px: int | None = None):
    u = np.where(np.isfinite(units), units, np.nan)
    cm = plt.get_cmap(DIFF_CMAP).copy()
    cm.set_bad("#d9d9d9")
    n = u.shape[0]
    if extent_px:
        c = (n - 1) / 2.0
        lo, hi = int(round(c - extent_px / 2)), int(round(c + extent_px / 2))
        u = u[lo:hi, lo:hi]
    ax.imshow(u, origin="lower", cmap=cm, vmin=-5, vmax=5, interpolation="nearest")
    ax.set_xticks([])
    ax.set_yticks([])
    if title:
        ax.set_title(title, fontsize=7)


def k8_figure(res: dict, ev: dict, rule: dict) -> Path:
    fig, axs = plt.subplots(1, 3, figsize=(15, 4.6))
    ax = axs[0]
    for i, p in enumerate(res["positions"]):
        for s in p["runs"]:
            if not s["ok"]:
                continue
            off = -0.15 if s["det"] in (2, 1, 3) else 0.15
            ax.plot([i + off], [s["coadd"].get("z", np.nan)], "o", color=BLUE, ms=5, label="difference of co-adds" if i == 0 and off < 0 else None)
            zs = [t["z"] for t in s["flips"] if t.get("ok")]
            ax.plot([i + off] * 2, [min(zs), max(zs)], "-", color=ORANGE, lw=2, label="flipbook pairs (range)" if i == 0 and off < 0 else None)
    for y in (-3, 3):
        ax.axhline(y, color=RED, lw=1)
    ax.axhline(0, color=GREY, lw=0.6)
    ax.set_xticks(range(len(res["positions"])))
    ax.set_xticklabels([p["name"] for p in res["positions"]], rotation=90, fontsize=6)
    ax.set_ylabel("mean of the empty difference, in standard errors")
    ax.set_title(f"Empty fields: {ev['difference']['empty']} of {ev['difference']['empty_of']} (co-adds), {ev['flipbook']['empty']} of {ev['flipbook']['empty_of']} (flipbook)", fontsize=9)
    ax.legend(fontsize=7, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax = axs[1]
    st = [s for s in res["stars"] if s["ok"]]
    xs = np.arange(len(st))
    pk, fx = [], []
    for s in st:
        t = [x for x in s["flips"] if x["testable"] and "peak_resid_pct" in x]
        pk.append(np.median([x["peak_resid_pct"] for x in t]) if t else np.nan)
        fx.append(np.median([abs(x["flux_resid_pct"]) for x in t]) if t else np.nan)
    ax.bar(xs - 0.2, pk, 0.4, color=ORANGE, label="largest pixel of the pair, % of the star's peak")
    ax.bar(xs + 0.2, fx, 0.4, color=BLUE, label="net light within 3 pixels, % of the star's")
    ax.set_xticks(xs)
    ax.set_xticklabels([f"G {s['G']:.1f}" for s in st], rotation=90, fontsize=6)
    ax.set_ylabel("left over in one pair of photos (%)")
    ax.set_title(f"Steady stars with no pair: {ev['flipbook']['stars']} of {len(res['stars'])} (flipbook), {ev['difference']['stars']} of {len(res['stars'])} (co-adds)", fontsize=9)
    ax.legend(fontsize=7, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax = axs[2]
    inj = [i for i in res["inject"] if i["ok"]]
    for k, it in enumerate(inj):
        ax.plot([k], [it["coadd_ratio"]], "o", color=BLUE, label="difference of co-adds" if k == 0 else None)
        ax.plot([k] * 2, [min(it["flip_ratios"]), max(it["flip_ratios"])], "-", color=ORANGE, lw=2, label="flipbook pairs (range)" if k == 0 else None)
        ax.plot([k], [it["flip_median_ratio"]], "s", color=ORANGE, ms=4)
    tol = rule["tests"]["injection"]["tolerance"]
    ax.axhspan(1 - tol, 1 + tol, color=GREEN, alpha=0.15)
    ax.axhline(1, color=GREY, lw=0.6)
    ax.set_xticks(range(len(inj)))
    ax.set_xticklabels([i["name"] for i in inj], rotation=90, fontsize=6)
    ax.set_ylabel("recovered / injected")
    ax.set_title(f"Injected point sources within {int(tol * 100)}%: {ev['difference']['inject']} of {ev['difference']['inject_of']} (co-adds), {ev['flipbook']['inject']} of {ev['flipbook']['inject_of']} (flipbook)"
                 + (f"\n{ev['difference']['inject_of'] - len(inj)} could not be tried: no clean site on the pixels shown" if len(inj) < ev['difference']['inject_of'] else ""), fontsize=8)
    ax.legend(fontsize=7, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    return _save(fig, IMG / "k8-pb6.png")


def _save(fig, path: Path, dpi: int = 120) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=dpi, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    return path


def flipbook_figure(res: dict) -> Path:
    """Three empty-field flipbooks: the pairs of one run each, in time order, on the fixed scale of 5 noise units."""
    names = ["ecl_000", "mid_p35", "hi_m65"]
    rows = []
    for nm in names:
        for p in res["positions"]:
            if p["name"] == nm:
                rows.append((nm, p["runs"][0]["det"]))
    runs = res["_runs"]
    n = max(len(runs[k]["flips"]) for k in rows if runs[k]["ok"])
    fig, axs = plt.subplots(len(rows), n + 1, figsize=(1.7 * (n + 1), 1.95 * len(rows)), squeeze=False)
    for i, key in enumerate(rows):
        r = runs[key]
        for j in range(n + 1):
            ax = axs[i][j]
            ax.axis("off")
            if not r["ok"]:
                continue
            if j == 0:
                show_units(ax, r["co"]["units"], f"{key[0]} D{key[1]}\nco-add of {len(r['used'])} pairs", None)
                ax.axis("on")
            elif j - 1 < len(r["flips"]):
                f = r["flips"][j - 1]
                pl = r["plan"]
                a, b = r["used"][j - 1]
                show_units(ax, f["units"], f"pair {j}: {pl.infos_a[a]['lam']:.3f} um", None)
                ax.axis("on")
    fig.suptitle("Empty fields: the same-colour differences, later minus earlier, +-5 noise units (grey: not used)", fontsize=9)
    fig.tight_layout()
    return _save(fig, IMG / "k8-flipbooks.png", dpi=110)


def tiers_panel(ax, folder: Path, title: str, pick: str = "saturation"):
    m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    k, h, w = len(m["frames"]), m["h"], m["w"]
    img = np.fromfile(folder / "stamps.bin", "<f4").reshape(k, h, w)
    fl = np.fromfile(folder / "flags.bin", "<i4").reshape(k, h, w)
    sat_mask = FLAG["OVERFLOW"] | FLAG["NONLINEAR"] | FLAG["BLOOM"]
    defect = 0
    for b in (0, 2, 6, 9, 10, 11, 17, 19, 20, 22, 23, 24, 25, 27, 28):
        defect |= 1 << b
    score = [((fl[i] & sat_mask) != 0).sum() if pick == "saturation" else np.nansum(np.clip(img[i] - np.nanmedian(img[i]), 0, None)) for i in range(k)]
    i = int(np.argmax(score))
    d, f = img[i], fl[i]
    lo = np.nanpercentile(d, 5)
    hi = np.nanpercentile(d, 99.5)
    g = np.arcsinh(10 * np.clip((d - lo) / (hi - lo), 0, 1)) / math.asinh(10)
    ax.imshow(g, origin="lower", cmap="gray", interpolation="nearest")
    sat = (f & sat_mask) != 0
    dfc = ((f & defect) != 0) & ~sat
    src = (f & FLAG["SOURCE"]) != 0
    for mask, hatch, col in ((sat, "////", "#ff7a00"), (dfc, "\\\\\\\\", "#2aa9ff")):
        if mask.any():
            with plt.rc_context({"hatch.color": col, "hatch.linewidth": 1.0}):
                ax.contourf(mask.astype(float), levels=[0.5, 1.5], colors="none", hatches=[hatch])
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title(f"{title}\nsaturation {int(sat.sum())} px (orange hatch)\ndefect {int(dfc.sum())} px (blue hatch)\nSOURCE {int(src.sum())} px (never hatched)", fontsize=7)
    return {"saturation": int(sat.sum()), "defect": int(dfc.sum()), "source": int(src.sum()), "frame": i}


def h8_sheet(res: dict, ev: dict, rule: dict) -> tuple[Path, dict]:
    fig = plt.figure(figsize=(13, 15.5))
    gs = fig.add_gridspec(5, 10, height_ratios=[1.5, 0.12, 0.8, 0.8, 1.6], hspace=0.45, wspace=0.12)
    runs = res["_runs"]
    r = runs[("ecl_000", 2)] if ("ecl_000", 2) in runs and runs[("ecl_000", 2)]["ok"] else next(v for v in runs.values() if v["ok"])
    ax = fig.add_subplot(gs[0, 0:3])
    show_units(ax, r["flips"][0]["units"], "An empty field, one pair (later minus earlier), +-5 noise units")
    ax = fig.add_subplot(gs[0, 3:6])
    show_units(ax, r["co"]["units"], f"The same field, co-add of {len(r['used'])} pairs (grey: not used)")
    ax = fig.add_subplot(gs[0, 6:10])
    allu, allc = [], []
    for rr in runs.values():
        if rr["ok"]:
            for f in rr["flips"]:
                allu.append(f["units"][np.isfinite(f["units"])])
            allc.append(rr["co"]["units"][np.isfinite(rr["co"]["units"])])
    u = np.concatenate(allu)
    c = np.concatenate(allc)
    bins = np.linspace(-6, 6, 97)
    ax.hist(u, bins=bins, density=True, histtype="step", color=ORANGE, label=f"single pairs ({len(u):,} pixels)")
    ax.hist(c, bins=bins, density=True, histtype="step", color=BLUE, label=f"co-adds ({len(c):,} pixels)")
    x = np.linspace(-6, 6, 400)
    ax.plot(x, np.exp(-x * x / 2) / math.sqrt(2 * math.pi), color=INK, lw=1, label="unit Gaussian")
    ax.set_yscale("log")
    ax.set_ylim(1e-5, 1)
    ax.set_xlabel("difference in noise units, all 20 empty fields")
    ax.legend(fontsize=7, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    ax.set_title("Histogram of the differences", fontsize=8)
    stars = [s for s in res["stars"] if s["ok"]]
    for k in range(20):
        ax = fig.add_subplot(gs[2 + k // 10, k % 10])
        if k < len(stars):
            s = stars[k]
            rr = s["_run"]
            j = 0
            show_units(ax, rr["flips"][j]["units"], None, extent_px=24)
            t = s["flips"][j]
            tag = "pair" if t["testable"] and t["pair"] else ("no pair" if t["testable"] else "not tested")
            ax.set_title(f"G {s['G']:.1f} D{s['det']}\n{tag}", fontsize=6, color=RED if tag == "pair" else INK)
        else:
            ax.axis("off")
    ax = fig.add_subplot(gs[1, :])
    ax.axis("off")
    ax.text(0.5, 0.0, "The 20 comparison stars of RW Aurigae: one matched pair each, 24 by 24 pixels round the star, +-5 noise units", ha="center", va="bottom", fontsize=8)
    info = {}
    base = DATA / "targets"
    spans = ((0, 3), (3, 6), (6, 10))
    for (a, b), (folder, title, pick) in zip(spans, ((base / "barnard", "Barnard's Star", "saturation"), (base / "r-dra", "R Draconis", "saturation"),
                                                    (DATA / "lemmon" / "strip", "Comet Lemmon", "flux"))):
        info[title] = tiers_panel(fig.add_subplot(gs[4, a:b]), folder, title, pick)
    return _save(fig, REVIEW / "h8.png", dpi=110), info


def h8_text(res: dict, ev: dict, rule: dict, info: dict, sn: dict, status: str) -> str:
    d, f = ev["difference"], ev["flipbook"]
    return "\n".join([
        "# H8: difference, background and flag tiers (PB6)",
        "",
        "Open `h8.png`. Top: one empty field as one pair and as the co-add of the pairs, and the histogram of all differences of the 20 empty",
        "fields in noise units against a unit Gaussian. Middle: the 20 comparison stars of RW Aurigae, one matched pair each. Bottom: the flag",
        "tiers drawn on stamps of Barnard's Star, R Draconis and the comet (saturation orange, defects blue, SOURCE never hatched).",
        "",
        "**Numbers to read**",
        "",
        f"- Empty fields, mean zero within 3 standard errors: co-adds {d['empty']} of {d['empty_of']}, flipbook {f['empty']} of {f['empty_of']} (rule: {d['empty_needed']} or more). "
        f"With the 5-sigma clip of the earlier test, for comparison only: {d['empty_clipped']} and {f['empty_clipped']}.",
        f"- Comparison stars without a dark-bright pair above 3 noise units: co-adds {d['stars']} of {d['stars_of']}, flipbook {f['stars']} of {f['stars_of']} (rule: {d['stars_needed']} or more).",
        f"- Injected sources within 20%: co-adds {d['inject']} of {d['inject_of']}, flipbook {f['inject']} of {f['inject_of']} (rule: {d['inject_needed']}).",
        f"- At a steady star one pair leaves {sn['peak_median']:.0f}% of the peak (middle 80%: {sn['peak_lo']:.0f} to {sn['peak_hi']:.0f}%) and its net light within 3 pixels is "
        f"{sn['flux_abs_median']:.0f}% (90% of stars under {sn['flux_abs_hi']:.0f}%).",
        f"- Flag tiers: " + "; ".join(f"{k}: {v['saturation']} saturation px, {v['defect']} defect px, {v['source']} SOURCE px" for k, v in info.items()) + ".",
        "",
        "**It passes if**",
        "",
        "1. The PB6 rule (pipeline/frozen/pb6_rule.json) is met by the co-add difference: the numbers above against the three needed counts.",
        "2. SOURCE pixels are not hatched in any of the three stamps; saturation is hatched on Barnard's Star and R Draconis.",
        "3. Epsilon Indi B's pair against Gaia is the card of the five targets (package P3); it is not on this sheet.",
        "",
        f"Status written by the job for row K8: {status}. Set the reviewer's role and the date with "
        "`python -m sx.run diffcheck --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ])


# -- the row and the numbers -----------------------------------------------------------------------------


def verify_earlier(res: dict, rule: dict, clipped: bool = False) -> dict:
    """The ten positions of the earlier test, run here in the same detectors: for each view how many have every run within 3
    standard errors (every pair of every detector for the flipbook), and the largest |z|. With `clipped` the mean is the one
    after a 5-sigma clip, which is how the earlier test took it (not the rule of PB6)."""
    zmax = rule["tests"]["empty"]["z_max"]
    key = "z_clip" if clipped else "z"
    out = {"positions": 0, "difference": {"pass": 0, "worst_z": 0.0}, "flipbook": {"pass": 0, "worst_z": 0.0}}
    for pos, p in zip(rule["positions"], res["positions"]):
        if pos["source"] != "earlier test":
            continue
        out["positions"] += 1
        for view in ("difference", "flipbook"):
            zs = []
            for s in p["runs"]:
                if not s["ok"]:
                    continue
                ts = [s["coadd"]] if view == "difference" else s["flips"]
                zs += [abs(t[key]) for t in ts if key in t]
            if zs and max(zs) <= zmax:
                out[view]["pass"] += 1
            out[view]["worst_z"] = max([out[view]["worst_z"]] + zs)
    return out


def write_outputs(res: dict, ev: dict, dec: dict, rule: dict, reviewer) -> None:
    sn = star_numbers(res)
    vt = valid_table(res)
    ver = verify_earlier(res, rule)
    verc = verify_earlier(res, rule, clipped=True)
    img = k8_figure(res, ev, rule)
    flipbook_figure(res)
    sheet, info = h8_sheet(res, ev, rule)
    d, f = ev["difference"], ev["flipbook"]
    bg_ok = d["empty_pass"] and f["empty_pass"]
    all_ok = d["build"] and f["build"]
    status = "PASS" if (all_ok and reviewer) else "UNVERIFIED" if all_ok else ("LIMIT" if bg_ok else "FAIL")
    tests = rule["tests"]
    row = checks.row(
        "K8", "Difference view and flipbook: do they show real change and nothing else?",
        "A difference of two visits taken at the same colour shows no change where there is none: an empty field averages to zero, and an injected source "
        "comes back at its true strength. Whether steady stars cancel is part of the same test, and the row says what it found.",
        f"{len(rule['positions'])} empty positions (no Gaia DR3 star brighter than G = 13 within 5 arcmin), each in two detectors, the ten of the earlier background test "
        f"among them; the 20 steady comparison stars of RW Aurigae; {d['inject_of']} injected point sources (round Gaussian, sigma 1 pixel). Two views are judged apart: the "
        "difference of the co-adds of the two visits (at most 8 matched pairs) and each photo minus its same-colour twin (the flipbook). All built with the shared rules "
        "(visits, match, stack) on one 64 by 64 grid of 6.15 arcsec pixels. The mean is taken over the pixels with no flag but FULLSAMPLE; standard errors count pixels as independent.",
        f"Mean of an empty difference within 3 standard errors at {tests['empty']['needed']} or more of {tests['empty']['positions']} positions; "
        f"{tests['stars']['needed']} or more of {tests['stars']['stars']} stars with no dark-bright pair above {tests['stars']['pair_units']} noise units within 3 pixels; "
        f"injected sources within {int(tests['injection']['tolerance'] * 100)}% ({tests['injection']['needed']} of {tests['injection']['sources']}). "
        "A view is built at typed positions only if all three hold. Written before any measurement (pipeline/frozen/pb6_rule.json; the code in the column of the commit is the first 40 characters of the SHA-256 of that file, the commit itself is made by the person who commits).",
        status, "difference view tested on empty sky and on steady stars",
        f"empty {d['empty']}/{f['empty']} of {d['empty_of']} (with the 5-sigma clip of the earlier test, for comparison: {d['empty_clipped']}/{f['empty_clipped']}), stars {d['stars']}/{f['stars']} of {d['stars_of']}, injected {d['inject']}/{f['inject']} of {d['inject_of']} (co-adds/flipbook)", "positions, stars, sources",
        f"{tests['empty']['needed']}, {tests['stars']['needed']}, {tests['injection']['needed']}", "3 standard errors; 3 noise units; 20%",
        checks.image_ref(img), reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run diffcheck",
        rule_sha()[:40])
    L.put_rows([row])
    put_decision(dec)
    ent = {
        "pb6.empty.positions": numbers.entry(len(res["positions"]), 0, check="K8"),
        "pb6.empty.coadd": numbers.entry(d["empty"], 0, check="K8"),
        "pb6.empty.flipbook": numbers.entry(f["empty"], 0, check="K8"),
        "pb6.stars.total": numbers.entry(len(res["stars"]), 0, check="K8"),
        "pb6.stars.coadd": numbers.entry(d["stars"], 0, check="K8"),
        "pb6.stars.flipbook": numbers.entry(f["stars"], 0, check="K8"),
        "pb6.inject.total": numbers.entry(d["inject_of"], 0, check="K8"),
        "pb6.inject.coadd": numbers.entry(d["inject"], 0, check="K8"),
        "pb6.inject.flipbook": numbers.entry(f["inject"], 0, check="K8"),
        "pb6.star.peak_left_pct": numbers.entry(sn["peak_median"], 0, unit="%", check="K8"),
        "pb6.star.light_left_pct": numbers.entry(sn["flux_abs_median"], 0, unit="%", check="K8"),
        "pb6.empty.coadd_clipped": numbers.entry(d["empty_clipped"], 0, check="K8"),
        "pb6.empty.flipbook_clipped": numbers.entry(f["empty_clipped"], 0, check="K8"),
        "pb6.earlier.positions": numbers.entry(ver["positions"], 0, check="K8"),
        "pb6.earlier.coadd": numbers.entry(ver["difference"]["pass"], 0, check="K8"),
        "pb6.earlier.flipbook": numbers.entry(ver["flipbook"]["pass"], 0, check="K8"),
        "pb6.earlier.coadd_clipped": numbers.entry(verc["difference"]["pass"], 0, check="K8"),
        "pb6.earlier.flipbook_clipped": numbers.entry(verc["flipbook"]["pass"], 0, check="K8"),
    }
    for k, v in enumerate(vt):
        ent[f"pb6.shown.pairs{k + 1}_pct"] = numbers.entry(100 * v, 0, unit="%", check="K8")
    numbers.write(PRODUCER, ent)
    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "h8.md").write_text(h8_text(res, ev, rule, info, sn, status), encoding="utf-8", newline="\n")
    print(f"K8 {status}")
    print(json.dumps({"S3": dec}, indent=1)[:3000])
    print("earlier ten, here (rule):", ver)
    print("earlier ten, here (5-sigma clip, as the earlier test):", verc)
    print("all 20, 5-sigma clip:", d["empty_clipped"], f["empty_clipped"])
    print("share of the grid shown after k pairs:", [round(v, 2) for v in vt])
    print("flag tiers:", info)


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    rule = load_rule()
    if "--select" in argv:
        if rule["positions"]:
            print("the rule already holds positions; remove them by hand to choose again")
            return 1
        select(rule)
        print("positions written to", RULE_FILE)
        return 0
    if len(rule["positions"]) != rule["tests"]["empty"]["positions"]:
        print("the rule has no positions: run `python -m sx.run diffcheck --select` first")
        return 1
    res = measure(rule)
    ev = evaluate(res, rule)
    dec = decisions(res, ev, rule)
    write_outputs(res, ev, dec, rule, reviewer)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
