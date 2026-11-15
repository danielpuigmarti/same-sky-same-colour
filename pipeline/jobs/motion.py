"""Job motion: can motion be measured within SPHEREx's own year? (the check that decides part S1; row K5-motion)

    python -m sx.run motion [--reviewed "<role>" <YYYY-MM-DD>]

Two of the targets move enough to try: Epsilon Indi B (4.7 arcsec a year) and WISE 0855-0714 (8.2 arcsec a year).
Both are measured in detector 6, between the two visits the visit rule compares.

  Epsilon Indi B   bright enough for one photo: its position is measured in every photo of every visit, and a
                   visit's position is the mean. The check is on the first against the last deep visit (a year
                   apart); the visits between are reported with it.
  WISE 0855-0714   too faint for one photo: its position is measured in the co-add of November 2025 and in the
                   co-add of April to May 2026, made by the shared rule (at each pixel the mean of the photos that
                   may be used there). May 2025 is left out. Most photos have a flagged pixel within a few pixels
                   of the target, and which photos are taken moves the answer by more than a second of arc, so it
                   is measured a second time from only the photos with no unusable pixel round the target.

The catalogue shift comes from Gaia DR3 (Epsilon Indi B) or the published astrometry in names.json (WISE 0855),
with proper motion and parallax. Field stars are the control: Gaia stars near the target, measured the same way in
the same photos, should not move beyond their own small proper motion; the scatter of their shifts is added to the
target's error. The rule that decides, written before the run, is in site/data/targets/tolerances.json ("motion").
The rule does not say which scatter of the field stars, nor which photos of WISE 0855: it is applied with the
robust scatter and with the plain one, and with both choices of photos, and motion is shown only if it holds
every way.

Writes: site/data/checks/decisions/p3.json (part "S1"), site/data/numbers/p3.json (keys motion.*), the row K5-motion
with site/data/checks/img/k5-motion.png, the field "motion" of the two targets' card.json, and the frozen list.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from sx import checks, frozen, irsa, numbers, s3, visits  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402
from jobs.targets import tolerances  # noqa: E402

JOB = "motion"
DET = 6
TARGETS = ["eps-indi-b", "wise0855"]
METHOD = {"eps-indi-b": "frames", "wise0855": "coadd"}
FIELD_RADIUS = {"frames": 0.45, "coadd": 0.45}
"""Radius of the Gaia cone for the control stars, degrees: they are looked for along the rows already read for the
target, up to 256 pixels to either side of it."""
STAR_GMAX = 17.5
STAR_ISOLATION_ARCSEC = 25.0
"""A control star is brighter than G = 17.5 and has no star within 2.5 magnitudes of it closer than 4 pixels."""
MIN_STAR_SNR = {"frames": 15.0, "coadd": 8.0}
"""Faintest control star: its peak over the noise, in one photo (per-photo method) or in the co-add."""
STRIP_WIDTH = 512
"""Per-photo method: control stars are looked for in this many columns of the rows already read for the target."""
MAX_STAR_ERR_ARCSEC = 0.1 * T.PX_ARCSEC
"""A control star counts in a visit only if its own position there is known to a tenth of a pixel, east and north."""
IMG = checks.IMG_DIR


def find() -> list[str]:
    names = T.targets()
    keys: list[str] = []
    for tid in TARGETS:
        keys += [f["key"] for f in irsa.sia_frames(names[tid]["ra"], names[tid]["dec"], 0.002) if f["det"] == DET]
    return keys


def robust_std(a) -> float:
    a = np.asarray(a, float)
    return float(1.4826 * np.median(np.abs(a - np.median(a)))) if a.size > 2 else math.nan


def good_star(p) -> bool:
    """True when a control star's position in a visit is known well enough to count."""
    return p is not None and np.isfinite(p["eE"]) and np.isfinite(p["eN"]) and max(p["eE"], p["eN"]) <= MAX_STAR_ERR_ARCSEC


def control_summary(shifts: list[tuple[float, float]]) -> dict:
    """What the field stars did between the two visits: {n, mean_E, mean_N, sem_E, sem_N, scatter_E, scatter_N,
    plain_E, plain_N}. `scatter` is the robust one (from the median absolute deviation: a few stars that went wrong
    do not widen it); `plain` is the standard deviation with every star counted fully."""
    if len(shifts) < 3:
        return {"n": len(shifts), "mean_E": math.nan, "mean_N": math.nan, "sem_E": math.nan, "sem_N": math.nan,
                "scatter_E": math.nan, "scatter_N": math.nan, "plain_E": math.nan, "plain_N": math.nan}
    a = np.array(shifts)
    sc = [robust_std(a[:, 0]), robust_std(a[:, 1])]
    return {"n": len(a), "mean_E": float(a[:, 0].mean()), "mean_N": float(a[:, 1].mean()),
            "sem_E": sc[0] / math.sqrt(len(a)), "sem_N": sc[1] / math.sqrt(len(a)), "scatter_E": sc[0], "scatter_N": sc[1],
            "plain_E": float(a[:, 0].std(ddof=1)), "plain_N": float(a[:, 1].std(ddof=1))}


def _apply(meas, stat, cat_shift, floor, rule: dict) -> dict:
    """The two tests of the rule with one choice of the field stars' scatter as the floor of the error."""
    err = [math.hypot(s, f) for s, f in zip(stat, floor)]
    size = math.hypot(*meas)
    err_along = math.hypot(meas[0] * err[0], meas[1] * err[1]) / size if size > 0 else math.inf
    significance = size / err_along if err_along > 0 else math.inf
    off = [(m - c) / e for m, c, e in zip(meas, cat_shift, err)]
    return {"err": err, "size": size, "err_size": err_along, "significance": significance, "off_sigma": off,
            "nonzero": significance >= rule["nonzero_sigma"], "within": all(abs(o) <= rule["within_sigma"] for o in off)}


def judge(meas: tuple[float, float], stat: tuple[float, float], cat_shift: tuple[float, float], control: dict, rule: dict) -> dict:
    """Apply the written rule to one target. `meas`: measured shift (east, north), arcsec; `stat`: its own errors;
    `cat_shift`: the catalogue shift; `control`: control_summary of the field stars.

    The rule adds "the scatter of the field stars" to the error and does not say which scatter. The numbers given
    are those with the robust scatter; `plain` holds the same two tests with the plain standard deviation, which is
    larger when a few stars went wrong. A target is built only if the rule holds both ways."""
    floor = [control["scatter_E"], control["scatter_N"]]
    have_control = all(np.isfinite(v) for v in floor)
    out = _apply(meas, stat, cat_shift, floor if have_control else [0.0, 0.0], rule)
    wide = [control.get("plain_E", floor[0]), control.get("plain_N", floor[1])]
    plain = _apply(meas, stat, cat_shift, wide, rule) if have_control and all(np.isfinite(v) for v in wide) else None
    gross = have_control and any(abs(control[f"mean_{k}"]) > 3 * e for k, e in zip("EN", out["err"]))
    both = out["nonzero"] and out["within"] and plain is not None and plain["nonzero"] and plain["within"]
    return {**out, "plain": plain, "have_control": have_control, "control_gross": gross,
            "build": bool(both and have_control and not gross)}


# -- Epsilon Indi B: every photo ----------------------------------------------------------------------


def measure_frames(tid: str, entry: dict, frames: list[dict]) -> dict:
    cat = entry["catalogue"]
    vt = [v for v in T.visit_table(frames, DET)]
    pair = visits.default_pair(vt)
    if pair is None:
        raise RuntimeError(f"{tid}: fewer than two visits that are not short")
    # where the target is during the release, so that no control star is taken near it
    track = [T.predict(cat, m) for m in np.linspace(vt[0]["first"], vt[-1]["last"], 8)]
    stars = T.field_stars(entry["ra"], entry["dec"], FIELD_RADIUS["frames"], gmax=STAR_GMAX,
                          isolation_arcsec=STAR_ISOLATION_ARCSEC, skip=track)
    out_visits = []
    for i, v in enumerate(vt):
        if v["short"]:
            continue
        rows = T.mover_frames(v["frames"], cat, entry["ra"], entry["dec"])
        pos = T.visit_position(rows)
        if pos is None:
            continue
        cra, cdec = T.predict(cat, pos["mjd"])
        sf = T.stars_frames(v["frames"], stars, entry["ra"], entry["dec"], width=STRIP_WIDTH, min_snr=MIN_STAR_SNR["frames"])
        spos = {sid: p for sid, p in ((sid, T.visit_position(r)) for sid, r in sf.items()) if good_star(p)}
        out_visits.append({"index": i, **pos, "cat_ra": cra, "cat_dec": cdec, "first": v["first"], "last": v["last"],
                           "photos": v["n"], "stars": spos, "snr": float(np.median([r["snr"] for r in rows]))})
    by = {v["index"]: v for v in out_visits}
    if pair[0] not in by or pair[1] not in by:
        raise RuntimeError(f"{tid}: one of the two visits could not be measured")
    return {"visits": out_visits, "a": by[pair[0]], "b": by[pair[1]], "n_stars": len(stars),
            "method": "mean of the positions in each photo"}


# -- WISE 0855: the co-adds of two visits -------------------------------------------------------------


def measure_coadd(tid: str, entry: dict, frames: list[dict]) -> dict:
    cat = entry["catalogue"]
    vt = T.visit_table(frames, DET)
    pair = visits.default_pair(vt)
    if pair is None:
        raise RuntimeError(f"{tid}: fewer than two visits that are not short")
    track = [T.predict(cat, m) for m in np.linspace(vt[pair[0]]["first"], vt[pair[1]]["last"], 8)]
    stars = T.field_stars(entry["ra"], entry["dec"], FIELD_RADIUS["coadd"], gmax=STAR_GMAX,
                          isolation_arcsec=STAR_ISOLATION_ARCSEC, skip=track)
    # only the stars that lie in the rows read for the target in enough photos of both visits are worth measuring
    enough = [T.stars_in_rows(vt[i]["frames"], stars, entry["ra"], entry["dec"]) >= T.COADD_MIN_PLANES for i in pair]
    stars = [s for s, a, b in zip(stars, *enough) if a and b]
    out_visits = []
    for i in pair:
        v = vt[i]
        c = T.mover_coadd(v["frames"], cat, entry["ra"], entry["dec"], n_boot=300)
        if c is None or not c.get("measured"):
            raise RuntimeError(f"{tid}: the co-add of the visit of {T.day_of(v['first'])} could not be measured "
                               f"({c['n'] if c else 0} photos that can be used at the target)")
        # the same again from only the photos that have no unusable pixel round the target
        cl = T.mover_coadd(v["frames"], cat, entry["ra"], entry["dec"], n_boot=300, clean=True)
        clean = ({k: cl[k] for k in ("dE", "dN", "eE", "eN", "n", "mjd", "cat_ra", "cat_dec")} if cl and cl.get("measured")
                 else None)
        spos = {}
        for s, m in zip(stars, s3.map_threads(lambda q: T.star_coadd(v["frames"], q, entry["ra"], entry["dec"]), stars)):
            if good_star(m) and m["snr"] >= MIN_STAR_SNR["coadd"]:
                spos[s["source_id"]] = m
        out_visits.append({"index": i, **{k: c[k] for k in ("dE", "dN", "eE", "eN", "n", "mjd", "cat_ra", "cat_dec", "snr",
                                                             "neighbours", "image")},
                           "frames": c["frames"], "first": v["first"], "last": v["last"], "photos": v["n"], "stars": spos,
                           "clean": clean, "clean_n": cl["n"] if cl else 0})
    return {"visits": out_visits, "a": out_visits[0], "b": out_visits[1], "n_stars": len(stars),
            "method": "position in the co-add of each visit", "second": True,
            "left_out": [f"{T.month_of(v['first'])} ({v['n']} photos)" for i, v in enumerate(vt) if i not in pair]}


# -- both ---------------------------------------------------------------------------------------------


def shift_between(a: dict, b: dict) -> dict:
    """Measured and catalogue shift from visit a to visit b, arcsec (east, north)."""
    cat_e, cat_n = (float(v) for v in T.offset_arcsec(a["cat_ra"], a["cat_dec"], b["cat_ra"], b["cat_dec"]))
    meas = (cat_e + b["dE"] - a["dE"], cat_n + b["dN"] - a["dN"])
    stat = (math.hypot(a["eE"], b["eE"]), math.hypot(a["eN"], b["eN"]))
    common = sorted(set(a["stars"]) & set(b["stars"]))
    stars = [(b["stars"][s]["dE"] - a["stars"][s]["dE"], b["stars"][s]["dN"] - a["stars"][s]["dN"]) for s in common]
    out = {"meas": meas, "stat": stat, "cat": (cat_e, cat_n), "stars": stars, "days": b["mjd"] - a["mjd"], "clean": None}
    if a.get("clean") and b.get("clean"):
        again = shift_between({**a["clean"], "stars": {}}, {**b["clean"], "stars": {}})
        out["clean"] = {"meas": again["meas"], "stat": again["stat"], "cat": again["cat"], "n": (a["clean"]["n"], b["clean"]["n"])}
    return out


def why(name: str, m: dict, s: dict, j: dict, c: dict) -> str:
    a, b = m["a"], m["b"]
    text = (f"{name}, detector {DET}, {T.month_of(a['mjd'])} to {T.month_of(b['mjd'])} ({s['days']:.0f} days; {a['n']} and {b['n']} "
            f"photos; {m['method']}): measured shift {j['size']:.2f} +- {j['err_size']:.2f} arcsec (east {s['meas'][0]:+.2f} +- "
            f"{j['err'][0]:.2f}, north {s['meas'][1]:+.2f} +- {j['err'][1]:.2f}); catalogue {math.hypot(*s['cat']):.2f} arcsec "
            f"(east {s['cat'][0]:+.2f}, north {s['cat'][1]:+.2f}), parallax included. The shift is {j['significance']:.1f} times "
            f"its error from zero (rule: at least 3) and differs from the catalogue by {j['off_sigma'][0]:+.1f} and "
            f"{j['off_sigma'][1]:+.1f} times its error in east and north (rule: within 3). ")
    if j["have_control"]:
        text += (f"Control: {c['n']} field stars moved by ({c['mean_E']:+.2f} +- {c['sem_E']:.2f}, {c['mean_N']:+.2f} +- "
                 f"{c['sem_N']:.2f}) arcsec on average between the same visits, scatter ({c['scatter_E']:.2f}, "
                 f"{c['scatter_N']:.2f}) arcsec, which is in the error.")
        p = j["plain"]
        if p is not None:
            first, second = j["nonzero"] and j["within"], p["nonzero"] and p["within"]
            text += (f" That scatter is the robust one; with every star counted fully it is ({c['plain_E']:.2f}, "
                     f"{c['plain_N']:.2f}) arcsec, and then the shift is {p['significance']:.1f} times its error from zero and "
                     f"{p['off_sigma'][0]:+.1f} and {p['off_sigma'][1]:+.1f} times from the catalogue: the rule is "
                     + {(True, True): "met that way too.",
                        (True, False): "not met that way, so the motion is not shown.",
                        (False, True): "met that way but not with the robust scatter, so the motion is not shown.",
                        (False, False): "not met that way either."}[(first, second)])
        if j["control_gross"]:
            text += " The field stars themselves moved by more than three times the target's error: not shown."
    else:
        text += f"Control: only {c['n']} field stars could be measured in both visits, too few for a scatter: not shown."
    if m.get("second"):
        k, q = s["clean"], j.get("clean")
        if k is None or q is None:
            text += (f" From only the photos with no unusable pixel round the target ({a['clean_n']} and {b['clean_n']}) the "
                     "shift cannot be measured: too few.")
        else:
            text += (f" Measured again from only the photos with no unusable pixel round the target ({k['n'][0]} and {k['n'][1]}): "
                     f"{q['size']:.2f} +- {q['err_size']:.2f} arcsec (east {k['meas'][0]:+.2f} +- {q['err'][0]:.2f}, north "
                     f"{k['meas'][1]:+.2f} +- {q['err'][1]:.2f}), {q['significance']:.1f} times its error from zero and "
                     f"{q['off_sigma'][0]:+.1f} and {q['off_sigma'][1]:+.1f} times from the catalogue: the rule is "
                     + ("met with those photos too." if q["build"] else "not met with those photos, so the motion is not shown."))
    return text


def draw(axs, name: str, m: dict, s: dict, j: dict, c: dict, cat: dict) -> None:
    ax, bx, tx = axs
    a = m["a"]
    tt = np.linspace(m["visits"][0]["mjd"] - 15, m["visits"][-1]["mjd"] + 15, 200)
    tra, tdec = T.predict(cat, tt)
    te, tn = T.offset_arcsec(a["cat_ra"], a["cat_dec"], tra, tdec)
    ax.plot(te, tn, color=T.ORANGE, lw=1, label="catalogue track (with parallax)")
    for v in m["visits"]:
        ce, cn = (float(q) for q in T.offset_arcsec(a["cat_ra"], a["cat_dec"], v["cat_ra"], v["cat_dec"]))
        judged = v is m["a"] or v is m["b"]
        ax.plot(ce, cn, "o", mfc="none", mec=T.ORANGE, ms=9)
        ax.errorbar(ce + v["dE"] - a["dE"], cn + v["dN"] - a["dN"], xerr=v["eE"], yerr=v["eN"], fmt="s" if judged else ".",
                    color=T.BLUE if judged else T.GREY, ms=5, capsize=2)
        ax.annotate(T.month_of(v["mjd"]), (ce, cn), textcoords="offset points", xytext=(8, 6), fontsize=7, color=T.INK)
    ax.plot([], [], "s", color=T.BLUE, label="measured, the two visits judged")
    ax.plot([], [], ".", color=T.GREY, label="measured, other visits")
    ax.plot([], [], "o", mfc="none", mec=T.ORANGE, label="catalogue at the visit")
    ax.invert_xaxis()
    ax.set_aspect("equal", adjustable="datalim")
    ax.set_xlabel("east (arcsec), from the first visit")
    ax.set_ylabel("north (arcsec)")
    ax.set_title(f"{name}: positions per visit", fontsize=9)
    ax.legend(fontsize=6.5, frameon=False)
    ax.spines[["top", "right"]].set_visible(False)

    if s["stars"]:
        st = np.array(s["stars"])
        bx.plot(st[:, 0], st[:, 1], ".", color=T.GREY, ms=5, label=f"{len(st)} field stars")
    bx.errorbar(s["meas"][0] - s["cat"][0], s["meas"][1] - s["cat"][1], xerr=j["err"][0], yerr=j["err"][1], fmt="s",
                color=T.BLUE, ms=5, capsize=2, label="target, measured minus catalogue")
    bx.axhline(0, color=T.INK, lw=0.6)
    bx.axvline(0, color=T.INK, lw=0.6)
    lim = max(1.5, 1.2 * float(np.max(np.abs(np.array(s["stars"])))) if s["stars"] else 1.5)
    bx.set_xlim(lim, -lim)
    bx.set_ylim(-lim, lim)
    bx.set_aspect("equal")
    bx.set_xlabel("shift minus catalogue, east (arcsec)")
    bx.set_ylabel("north (arcsec)")
    bx.set_title("control: stars that should not move", fontsize=9)
    bx.legend(fontsize=6.5, frameon=False)
    bx.spines[["top", "right"]].set_visible(False)

    tx.axis("off")
    lines = [name, f"{T.month_of(m['a']['mjd'])} to {T.month_of(m['b']['mjd'])}, {s['days']:.0f} days",
             f"photos used: {m['a']['n']} and {m['b']['n']}", "",
             f"measured   {j['size']:.2f} +- {j['err_size']:.2f} arcsec",
             f"           ({j['size'] / T.PX_ARCSEC:.2f} pixels)",
             f"  east     {s['meas'][0]:+.2f} +- {j['err'][0]:.2f}", f"  north    {s['meas'][1]:+.2f} +- {j['err'][1]:.2f}",
             f"catalogue  {math.hypot(*s['cat']):.2f} arcsec", f"  east     {s['cat'][0]:+.2f}", f"  north    {s['cat'][1]:+.2f}", "",
             f"from zero:      {j['significance']:.1f} sigma (rule: 3 or more)",
             f"from catalogue: {j['off_sigma'][0]:+.1f}, {j['off_sigma'][1]:+.1f} sigma (rule: within 3)",
             f"field stars: {c['n']}, mean ({c['mean_E']:+.2f}, {c['mean_N']:+.2f}),",
             f"  scatter ({c['scatter_E']:.2f}, {c['scatter_N']:.2f}) arcsec (robust),",
             f"  ({c['plain_E']:.2f}, {c['plain_N']:.2f}) with every star counted"]
    if j["plain"] is not None:
        lines += [f"  with that: {j['plain']['significance']:.1f} sigma from zero,",
                  f"  {j['plain']['off_sigma'][0]:+.1f}, {j['plain']['off_sigma'][1]:+.1f} sigma from catalogue"]
    if j.get("clean"):
        q, k = j["clean"], s["clean"]
        lines += [f"photos with a clean box only ({k['n'][0]} and {k['n'][1]}):",
                  f"  {q['size']:.2f} +- {q['err_size']:.2f} arcsec, {q['significance']:.1f} sigma from zero,",
                  f"  {q['off_sigma'][0]:+.1f}, {q['off_sigma'][1]:+.1f} sigma from catalogue"]
    lines += ["", "S1: " + ("shown (rule met every way)" if j["build"] else "not shown (rule not met)")]
    tx.text(0, 0.98, "\n".join(lines), va="top", fontsize=8, family="monospace", color=T.INK)


def main(argv: list[str]) -> int:
    reviewer = T.reviewer_from(argv)
    rule = tolerances()["motion"]
    names = T.targets()
    keys = frozen.frames_for(JOB, find)
    held = T.frames_holding(keys, {t: (names[t]["ra"], names[t]["dec"]) for t in TARGETS})
    res, decisions, entries = {}, {}, {}
    for tid in TARGETS:
        e = names[tid]
        frames = [f for f in held[tid] if f["det"] == DET]
        m = measure_frames(tid, e, frames) if METHOD[tid] == "frames" else measure_coadd(tid, e, frames)
        s = shift_between(m["a"], m["b"])
        c = control_summary(s["stars"])
        j = judge(s["meas"], s["stat"], s["cat"], c, rule)
        if s["clean"] is not None:  # a second choice of photos: the motion is shown only if the rule holds with both
            j["clean"] = judge(s["clean"]["meas"], s["clean"]["stat"], s["clean"]["cat"], c, rule)
            j["build"] = bool(j["build"] and j["clean"]["build"])
        res[tid] = (m, s, j, c)
        decisions[tid] = {"build": j["build"], "why": why(e["name"], m, s, j, c)}
        print(decisions[tid]["why"])
        for v in m["visits"]:
            print(f"   visit {T.day_of(v['first'])}..{T.day_of(v['last'])}: {v['n']} photos used of {v['photos']}, measured minus "
                  f"catalogue ({v['dE']:+.2f} +- {v['eE']:.2f}, {v['dN']:+.2f} +- {v['eN']:.2f}) arcsec, {len(v['stars'])} field stars")
        if m.get("left_out"):
            print("   visits left out:", ", ".join(m["left_out"]))
        n = numbers.entry
        k = f"motion.{tid}"
        entries.update({
            f"{k}.measured": n(j["size"], 1, err=j["err_size"], unit="arcsec", check="K5-motion"),
            f"{k}.error": n(j["err_size"], 1, unit="arcsec", check="K5-motion"),
            f"{k}.catalogue": n(math.hypot(*s["cat"]), 1, unit="arcsec", check="K5-motion"),
            f"{k}.pixels": n(j["size"] / T.PX_ARCSEC, 2, unit="pixels", check="K5-motion"),
            f"{k}.significance": n(j["significance"], 0, unit="times its error", check="K5-motion"),
            f"{k}.days": n(s["days"], 0, unit="days", check="K5-motion"),
            f"{k}.first": n(m["a"]["mjd"], shown=T.month_of(m["a"]["mjd"]), check="K5-motion"),
            f"{k}.last": n(m["b"]["mjd"], shown=T.month_of(m["b"]["mjd"]), check="K5-motion"),
            f"{k}.stars": n(c["n"], 0, check="K5-motion"),
        })
    numbers.write(T.PRODUCER, entries)
    T.put_decision("S1", decisions)

    fig, axs = plt.subplots(len(TARGETS), 3, figsize=(11.5, 4.6 * len(TARGETS)), gridspec_kw={"width_ratios": [1.25, 1, 0.9]})
    for row, tid in zip(axs, TARGETS):
        draw(row, names[tid]["name"], *res[tid], names[tid]["catalogue"])
    fig.tight_layout()
    img = T.save_figure(fig, IMG / "k5-motion.png")

    built = [t for t in TARGETS if decisions[t]["build"]]
    status = ("PASS" if reviewer else "UNVERIFIED") if len(built) == len(TARGETS) else "LIMIT"
    label = {t: names[t]["name"] for t in TARGETS}
    row = checks.row(
        "K5-motion", "Motion within SPHEREx's own year",
        "Between two SPHEREx visits months apart, Epsilon Indi B and WISE 0855-0714 are seen to move, by the amount "
        "their catalogue astrometry gives with parallax included.",
        "Detector 6. Epsilon Indi B: its position in every photo, averaged over each visit; first against last deep visit. "
        "WISE 0855: its position in the co-add of each of two visits (at each pixel the mean of the photos that may be "
        "used there; a Gaia star beside it is fitted with it); May 2025 is left out. It is measured a second time from "
        "only the photos with no unusable pixel round the target. Field stars measured the same way in the same photos "
        "are the control; the scatter of their shifts is added to the target's error.",
        "Per target: the measured shift is at least 3 times its error from zero, and its east and north components are "
        "each within 3 times their error of the catalogue shift. The rule is applied with the robust scatter of the field "
        "stars in the error (the value given) and again with their plain standard deviation, and for WISE 0855 with "
        "both choices of photos; a target is shown only if it holds every way. A target that does not meet the rule "
        "gets its measured shift and error stated, and no motion view.",
        status, "motion seen within SPHEREx's own year" if len(built) == len(TARGETS) else "measured shift stated",
        "; ".join(f"{label[t]} {res[t][2]['size']:.2f} +- {res[t][2]['err_size']:.2f} arcsec"
                  + ("" if decisions[t]["build"] else " (rule not met)") for t in TARGETS),
        "measured shift between two visits",
        "; ".join(f"{label[t]} {math.hypot(*res[t][1]['cat']):.2f} arcsec" for t in TARGETS),
        "3 times the error", checks.image_ref(img), reviewer[0] if reviewer and status == "PASS" else None,
        reviewer[1] if reviewer and status == "PASS" else None, "python -m sx.run motion")
    T.put_rows([row])

    for tid in TARGETS:
        m, s, j, c = res[tid]
        k = f"motion.{tid}"
        line = (f"Within SPHEREx's own data, from {{{{{k}.first}}}} to {{{{{k}.last}}}}, it moved "
                f"{{{{{k}.measured}}}} arcsec, give or take {{{{{k}.error}}}}; the catalogue gives {{{{{k}.catalogue}}}} arcsec."
                if j["build"] else
                f"Within SPHEREx's own data, from {{{{{k}.first}}}} to {{{{{k}.last}}}}: measured shift "
                f"{{{{{k}.measured}}}} arcsec with an error of {{{{{k}.error}}}} arcsec; the catalogue gives "
                f"{{{{{k}.catalogue}}}} arcsec. Position only.")
        T.update_card(tid, {"motion": {"build": j["build"], "check": "K5-motion", "line": line,
                                       "visits": [T.month_of(m["a"]["mjd"]), T.month_of(m["b"]["mjd"])],
                                       "numbers": sorted(x for x in entries if x.startswith(k + "."))}})
    print(f"K5-motion {status}; S1: " + ", ".join(f"{t} {'build' if decisions[t]['build'] else 'do not build'}" for t in TARGETS))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
