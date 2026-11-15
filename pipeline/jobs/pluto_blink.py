"""Job pluto_blink: Pluto as a blink comparator finds it (check K-pluto-blink, rule PB6b).

    python -m sx.run pluto_blink [--reviewed "<role>" <YYYY-MM-DD>]

The rule is in pipeline/frozen/pluto_blink_rule.json, written after the difference test of the job pluto had failed and
before any plain photo was measured for this test. The photos and their same-colour twins are those of the job pluto.
Nothing is subtracted: in each photo there should be a light within 1 pixel of where JPL Horizons puts Pluto, at least
5 noise units high, and in the twin from another visit nothing at that place (below 3 noise units). If at least 80
percent of the pairs of a detector pass both, a showcase is written: the photos with a ring at Horizons' place.

Writes always: the row K-pluto-blink (rows/p6.json) with its picture k-pluto-blink.png, the numbers pluto.blink.*
(numbers/p6.json) and the entry S5b of site/data/checks/decisions/p6.json. When it passes also site/data/pluto/ (a
CT-8 showcase, card.json, flip.png) and review/h9-pluto.png and .md.
"""
from __future__ import annotations

import math
import shutil
import sys
from datetime import date

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.ndimage import gaussian_filter  # noqa: E402

from jobs import _gallery_lib as L  # noqa: E402
from jobs import pluto as P  # noqa: E402
from sx import checks, frozen, numbers, render, stack, visits  # noqa: E402
from sx.checks import write_json  # noqa: E402
from sx.stamp import cut  # noqa: E402
from sx.wcs import sky_to_pixel  # noqa: E402

RULE = L.read_rule("pluto_blink_rule.json")
DATA = L.DATA
REVIEW = L.REVIEW
IMG = checks.IMG_DIR
PRODUCER = "p6"
SIZE = P.SIZE
SHOW = 4.0
"""The flipbook picture is drawn from -1 to SHOW times the noise of each photo."""


def pair_stamps(photo: dict, twin: dict) -> dict | None:
    """The photo and its twin cut round Pluto's place in the photo, each with its background removed, the twin resampled
    onto the photo's pixels. Values are MJy/sr; NaN where a pixel may not be used."""
    ra, dec = photo["ra"], photo["dec"]
    sa = cut(photo["key"], ra, dec, size=SIZE, flags=True)
    sb = cut(twin["key"], ra, dec, size=SIZE, flags=True)
    if sa is None or sb is None:
        return None
    co_a = stack.coadd([{"data": sa.data, "flags": sa.flags}])
    co_b = stack.coadd([{"data": sb.data, "flags": sb.flags}])
    if co_a["photos"] == 0 or co_b["photos"] == 0:
        return None
    ffa, ffb = L.frame(photo["key"]), L.frame(twin["key"])
    yy, xx = np.mgrid[:SIZE, :SIZE].astype(float)
    r, d = ffa.wcs.all_pix2world(xx + sa.x0, yy + sa.y0, 0)
    bx, by = sky_to_pixel(ffb.wcs, r, d)
    rb = stack.resample_coadd(co_b, bx - sb.x0, by - sb.y0)
    a = np.where(co_a["valid"].astype(bool), co_a["data"], np.nan).astype(float)
    b = np.where(rb["valid"].astype(bool), rb["data"], np.nan).astype(float)
    return {"photo": sa, "twin": sb, "a": a, "b": b}


def smoothed_units(img: np.ndarray) -> np.ndarray:
    """The stamp smoothed with a Gaussian of 1 pixel (over the usable pixels), in units of its own robust noise."""
    ok = np.isfinite(img)
    num = gaussian_filter(np.where(ok, img, 0.0), 1.0)
    den = gaussian_filter(ok.astype(float), 1.0)
    sm = np.where(den > 0.5, num / np.maximum(den, 1e-9), np.nan)
    noise = stack.robust_noise(sm[np.isfinite(sm)])
    return sm / noise if noise > 0 else np.full_like(sm, np.nan)


def highest_within(img: np.ndarray, x: float, y: float, r: float) -> float:
    h, w = img.shape
    yy, xx = np.mgrid[:h, :w]
    m = np.isfinite(img) & (np.hypot(xx - x, yy - y) <= r)
    return float(np.max(img[m])) if m.any() else math.nan


def judge(ps: dict) -> dict:
    """The two tests of the rule on one pair."""
    st = ps["photo"]
    tx, ty = st.tx, st.ty
    peak = highest_within(smoothed_units(ps["a"]), tx, ty, RULE["search_px"])
    g = L.fit_gauss(ps["a"], tx, ty, search=RULE["search_px"], half=3, sigma0=1.0)
    x, y = (g["x"], g["y"]) if g else (math.nan, math.nan)
    dist = math.hypot(x - tx, y - ty) if g else math.inf
    found = bool(g is not None and math.isfinite(peak) and peak >= RULE["peak_noise_units"] and dist <= RULE["radius_px"])
    cx, cy = (x, y) if g else (tx, ty)
    twin_peak = highest_within(smoothed_units(ps["b"]), cx, cy, RULE["radius_px"])
    empty = bool(math.isfinite(twin_peak) and twin_peak < RULE["empty_noise_units"])
    return {"peak": peak, "x": x, "y": y, "dist": dist, "found": found, "twin_peak": twin_peak, "empty": empty,
            "both": found and empty}


def put_decision(entry: dict) -> None:
    import json

    have = json.loads(P.DECISIONS.read_text(encoding="utf-8")) if P.DECISIONS.exists() else {}
    have["S5b"] = entry
    write_json(P.DECISIONS, dict(sorted(have.items())))


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    m0, m1 = P.window()
    track = P.Track(m0, m1)
    frames = P.holding_frames(track)
    print(f"Pluto between MJD {m0:.0f} and {m1:.0f}: {len(frames)} frames hold it")
    by_det = {d: [f for f in frames if f["det"] == d] for d in range(1, 7)}
    covered = {d: len([v for v in visits.visits(frames, d) if not v["short"]]) for d in range(1, 7)}
    results: dict[int, dict] = {}
    for d in range(1, 7):
        if covered[d] < 2:
            continue
        used: set[str] = set()
        pairs = []
        for f in by_det[d]:
            t = P.twin_for(f, track, used)
            if t is None:
                continue
            used.add(t["key"])
            pairs.append((f, t))
        sel = L.thin(pairs, RULE["max_per_detector"])
        rows = []
        for f, t in sel:
            ps = pair_stamps(f, t)
            if ps is None:
                rows.append({"pf": f, "tf": t, "ps": None, "found": False, "empty": False, "both": False,
                             "peak": math.nan, "dist": math.inf, "twin_peak": math.nan, "x": math.nan, "y": math.nan})
                continue
            rows.append({"pf": f, "tf": t, "ps": ps, **judge(ps)})
        n = len(rows)
        nb = sum(r["both"] for r in rows)
        results[d] = {"n": n, "judged": n >= RULE["min_per_detector"], "rows": rows, "both": nb,
                      "found": sum(r["found"] for r in rows), "empty": sum(r["empty"] for r in rows),
                      "fraction": nb / n if n else 0.0, "photos": len(by_det[d]), "twins": len(pairs)}
        print(f"detector {d}: {n} pairs; found {results[d]['found']}, empty twin {results[d]['empty']}, both {nb}", flush=True)
    keys = sorted({r["pf"]["key"] for v in results.values() for r in v["rows"]} | {r["tf"]["key"] for v in results.values() for r in v["rows"]})
    if keys:
        frozen.record("pluto_blink", keys)
    judged = {d: r for d, r in results.items() if r["judged"]}
    passing = [d for d, r in judged.items() if r["fraction"] >= RULE["fraction"]]
    tally = "; ".join(f"D{d} {r['both']} of {r['n']}" for d, r in judged.items())
    parts = "; ".join(f"D{d} {r['found']} and {r['empty']}" for d, r in judged.items())
    summary = (f"JPL Horizons (observer SPHEREx) puts Pluto on {len(frames)} frames of the release. With nothing subtracted, "
               f"Pluto found within 1 pixel of Horizons and gone from that place in the same-colour photo of another visit: {tally}. "
               f"For information, the two tests apart (a light at the place in the photo, of {RULE['max_per_detector']} pairs at most; "
               f"the place empty in the twin): {parts}. ")
    best = sorted(passing, key=lambda d: (-judged[d]["n"], d))[0] if passing else max(judged, key=lambda d: (judged[d]["fraction"], -d)) if judged else None
    if best is None:
        why = summary + "No detector has enough pairs to be judged. Not shown."
        _clean()
        put_decision({"build": False, "why": why})
        print(why)
        return 0
    if passing:
        why = summary + f"Rule met (at least 80 percent of the pairs); the showcase is detector {best}."
        showcase(best, judged[best], reviewer, frames)
    else:
        why = summary + "No detector reaches 80 percent. Not shown."
        _clean()
    picture(best, judged)
    write_row_and_numbers(best, judged, bool(passing), reviewer, len(frames))
    put_decision({"build": bool(passing), "why": why})
    print(why)
    return 0


def _clean() -> None:
    if (DATA / "pluto").exists():
        shutil.rmtree(DATA / "pluto")
    for f in (REVIEW / "h9-pluto.png", REVIEW / "h9-pluto.md"):
        f.unlink(missing_ok=True)


def picture(best: int, judged: dict) -> None:
    """The Checks picture: where the fitted lights fall round Horizons' place, and the share of pairs per detector."""
    r = judged[best]
    fig, axs = plt.subplots(1, 2, figsize=(9, 4.2))
    ax = axs[0]
    for x in r["rows"]:
        if math.isfinite(x["x"]):
            tx, ty = x["ps"]["photo"].tx, x["ps"]["photo"].ty
            ax.plot(x["x"] - tx, x["y"] - ty, "o", ms=4, color=L.BLUE if x["both"] else L.ORANGE)
    t = np.linspace(0, 2 * np.pi, 200)
    ax.plot(np.cos(t), np.sin(t), color=L.INK, lw=1)
    ax.set_aspect("equal")
    ax.set_xlim(-3, 3)
    ax.set_ylim(-3, 3)
    ax.set_xlabel("fitted light minus Horizons, x (pixels)")
    ax.set_ylabel("y (pixels)")
    ax.set_title(f"Detector {best}: blue both tests ({r['both']} of {r['n']}), orange not", fontsize=9)
    ax = axs[1]
    for d, x in sorted(judged.items()):
        ax.bar(d, 100 * x["fraction"], color=L.BLUE if x["fraction"] >= RULE["fraction"] else L.ORANGE)
        ax.text(d, 100 * x["fraction"] + 2, f"{x['both']}/{x['n']}", ha="center", fontsize=8)
    ax.axhline(100 * RULE["fraction"], color=L.INK, lw=1, ls="--")
    ax.set_ylim(0, 115)
    ax.set_xlabel("detector")
    ax.set_ylabel("pairs: Pluto at the place, then gone (%)")
    ax.set_title("Per detector; dashed: the rule", fontsize=9)
    fig.tight_layout()
    fig.savefig(IMG / "k-pluto-blink.png", dpi=110, metadata={"Software": None}, facecolor="white")
    plt.close(fig)


def write_row_and_numbers(best: int, judged: dict, passed: bool, reviewer, nframes: int) -> None:
    r = judged[best]
    dist = [x["dist"] for x in r["rows"] if x["both"]]
    med = float(np.median(dist)) if dist else math.nan
    status = ("PASS" if reviewer else "UNVERIFIED") if passed else "FAIL"
    value = (f"detector {best}: {r['both']} of {r['n']} pairs" + (f"; median distance {med:.2f} px" if passed and dist else "")
             + ("" if passed else "; best detector for the light alone: " + max(
                 (f"D{d} {x['found']} of {x['n']}, its twins empty in {x['empty']}" for d, x in judged.items()),
                 key=lambda s: int(s.split()[1]))))
    row = checks.row(
        "K-pluto-blink", "Pluto in plain photos, blinked against another visit",
        "In plain SPHEREx photos, with nothing subtracted, Pluto is a point of light where JPL Horizons says it should be, and that "
        "place is empty in a photo of the same colour taken at another visit.",
        "The photos and their same-colour twins are those of row K-pluto: JPL Horizons gives Pluto's place as SPHEREx saw it at each "
        "photo's time, the frame index gives the photos that hold it, and the shared match rule gives each a twin from another visit "
        "in which Pluto is at least 12 pixels away. At most 24 pairs per detector, evenly spaced in time. In the photo, background "
        "removed and smoothed with a Gaussian of 1 pixel, the brightest pixel within 1.5 pixels of the predicted place is measured and "
        "a round Gaussian is fitted there; in the twin, resampled onto the photo's pixels and treated the same way, the brightest pixel "
        "within 1 pixel of that fit. Position only: no brightness, spectrum or ice is claimed.",
        "In at least one detector at least 80 percent of the pairs show a light of at least 5 noise units whose fitted centre is within "
        "1 pixel (6.15 arcsec) of the Horizons place, with nothing of 3 noise units or more there in the twin. The rule is in "
        "pipeline/frozen/pluto_blink_rule.json; it was written after the difference test of row K-pluto had failed and before any "
        "plain photo was measured for it.",
        status, "position checked against JPL Horizons" if passed else "did not meet its rule",
        value, "pairs", "at least 80 percent", "1 pixel", checks.image_ref(IMG / "k-pluto-blink.png"),
        reviewer[0] if reviewer and passed else None, reviewer[1] if reviewer and passed else None, "python -m sx.run pluto_blink")
    checks.write_rows(PRODUCER, [row])
    ent = {"pluto.blink.frames": numbers.entry(nframes, 0, check="K-pluto-blink"),
           "pluto.blink.pairs": numbers.entry(r["n"], 0, check="K-pluto-blink"),
           "pluto.blink.both": numbers.entry(r["both"], 0, check="K-pluto-blink"),
           "pluto.blink.fraction": numbers.entry(100 * r["both"] / r["n"], 0, unit="percent", check="K-pluto-blink"),
           "pluto.blink.detector": numbers.entry(best, 0, check="K-pluto-blink")}
    if dist:
        ent["pluto.blink.median_offset_px"] = numbers.entry(med, 2, unit="pixel", check="K-pluto-blink")
        ent["pluto.blink.median_offset_arcsec"] = numbers.entry(med * RULE["pixel_arcsec"], 1, unit="arcsec", check="K-pluto-blink")
    numbers.write(PRODUCER, ent)


def showcase(det: int, res: dict, reviewer, frames: list[dict]) -> None:
    rows = [x for x in res["rows"] if x["ps"] is not None]
    items = []
    for k, x in enumerate(rows):
        items.append((x["ps"]["photo"], "photo", k))
        items.append((x["ps"]["twin"], "twin", k))
    order = sorted(range(len(items)), key=lambda i: items[i][0].mjd)
    st_sorted = [items[i][0] for i in order]
    pos = {i: n for n, i in enumerate(order)}
    vis = visits.visits([{"key": s.key, "det": s.det, "tmid": s.mjd} for s in st_sorted], det)
    vnum = {}
    for n, v in enumerate(vis):
        for f in v["frames"]:
            vnum[(f["key"], f["tmid"])] = n
    visit_of = [vnum[(s.key, s.mjd)] for s in st_sorted]
    pairs, pair_info = [], []
    for k, x in enumerate(rows):
        ip, it = pos[2 * k], pos[2 * k + 1]
        a, b = (it, ip) if visit_of[it] < visit_of[ip] else (ip, it)
        if visit_of[a] >= visit_of[b]:
            continue
        pairs.append((a, b))
        pair_info.append({"photo": ip, "twin": it, "pluto_in": "second" if b == ip else "first",
                          "horizons": P.uv_in_stamp(x["ps"]["photo"].tx, x["ps"]["photo"].ty),
                          "found": x["found"], "empty": x["empty"], "peak": x["peak"], "twin_peak": x["twin_peak"],
                          "dist_px": x["dist"] if math.isfinite(x["dist"]) else None})
    remap = {v: n for n, v in enumerate(sorted(set(visit_of)))}
    render.write_showcase(DATA / "pluto", "pluto", "Pluto", float(frames[0]["ra"]), float(frames[0]["dec"]), st_sorted,
                          [remap[v] for v in visit_of], pairs, refs=P.REFS,
                          numbers=["pluto.blink.both", "pluto.blink.pairs"], with_flags=True, preview=None)
    # the flipbook picture: each photo as it is, with a ring where Horizons puts Pluto
    n = len(rows)
    cols = min(6, n)
    nrow = math.ceil(n / cols)
    fig, axs = plt.subplots(nrow, cols, figsize=(1.9 * cols, 2.1 * nrow))
    axs = np.atleast_1d(axs).ravel()
    for ax in axs:
        ax.axis("off")
    for ax, x in zip(axs, rows):
        a = x["ps"]["a"]
        noise = stack.robust_noise(a[np.isfinite(a)])
        ax.imshow(np.where(np.isfinite(a), a, 0.0), origin="lower", cmap="gray", vmin=-1.0 * noise, vmax=SHOW * noise,
                  interpolation="nearest")
        st = x["ps"]["photo"]
        ax.plot(st.tx, st.ty, "o", mfc="none", mec="#ffd54f", ms=16, mew=1.0)
        ax.set_title(f"{P.L_day(st.mjd)}  {st.lam:.2f} µm", fontsize=6)
        ax.axis("off")
    fig.tight_layout()
    REVIEW.mkdir(parents=True, exist_ok=True)
    fig.savefig(REVIEW / "h9-pluto.png", dpi=90, metadata={"Software": None}, facecolor="white")
    fig.savefig(DATA / "pluto" / "flip.png", dpi=90, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    nb = res["both"]
    write_json(DATA / "pluto" / "card.json", {
        "id": "pluto", "name": "Pluto", "detector": det, "showcase": "manifest.json", "kind": "flipbook", "check": "K-pluto-blink",
        "plain": "position checked against JPL Horizons", "preview": "flip.png",
        "verdict": "In {{pluto.blink.both}} of {{pluto.blink.pairs}} pairs of photos Pluto is a point of light where JPL Horizons "
                   "puts it, and the place is empty in the photo of the same colour from another visit.",
        "north_up": False, "stamp_pixels": SIZE, "arcsec_per_pixel": RULE["pixel_arcsec"],
        "reference": {"text": "JPL Horizons on-line ephemeris, target 999, observer SPHEREx (-163182), astrometric ICRS", "unverified": False},
        "pairs": pair_info, "note": "Position only. Each small picture is one SPHEREx photo as it was taken, nothing subtracted, in the "
        "detector's own pixels (not rotated); the ring is where JPL Horizons puts Pluto at that moment.",
        "refs": P.REFS, "numbers": ["pluto.blink.both", "pluto.blink.pairs"]})
    lines = ["# H9 (Pluto part): Pluto in plain photos, with the Horizons ring", "",
             "Open `h9-pluto.png`: the photos of one detector in time order, as they were taken, nothing subtracted. The yellow "
             "ring is where JPL Horizons puts Pluto at that moment.", "",
             "**Number to read**", "",
             f"- Detector {det}: Pluto at the ring and gone from it in the twin in {nb} of {res['n']} pairs "
             f"({100 * nb / res['n']:.0f}%).", "",
             "**It passes if**", "", "1. A point of light sits in the ring in at least 80% of the photos.",
             "2. Nothing else in the photos reads as Pluto.", "3. The page says position only: no spectrum, no label of any ice.", ""]
    (REVIEW / "h9-pluto.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
