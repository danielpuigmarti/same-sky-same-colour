"""Job pluto: Pluto, frame by frame (check PB6 Pluto rule, S5).

    python -m sx.run pluto [--reviewed "<role>" <YYYY-MM-DD>]

The rule is in pipeline/frozen/pluto_rule.json, written before any photo was read. In short: JPL Horizons gives
Pluto's place as SPHEREx saw it; the frame index lists the photos that hold it; each photo is subtracted from its
same-colour twin of another visit (the shared match rule) at the sky position where Pluto was in the photo; the
difference should show Pluto, within 1 pixel of Horizons, in at least 80 percent of the difference frames of a
detector. If so a showcase is written (position only: no spectrum, no label of any ice).

Writes (when it passes): site/data/pluto/ (a CT-8 showcase, card.json, flip.png); always: site/data/checks/
decisions/p6.json (key S5). When it passes also the rows and numbers of producer p6-pluto, the picture
k-pluto-found.png, review/h9-pluto.png and .md. Needs the network the first time; answers are cached afterwards.
"""
from __future__ import annotations

import json
import math
import re
import shutil
import sys
from datetime import date, timedelta

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from scipy.ndimage import gaussian_filter  # noqa: E402

from jobs import _gallery_lib as L  # noqa: E402
from sx import checks, frozen, horizons, index, match, numbers, render, stack, visits, wave  # noqa: E402
from sx.checks import write_json  # noqa: E402
from sx.stamp import cut  # noqa: E402
from sx.wcs import on_frame, sky_to_pixel  # noqa: E402

RULE = L.read_rule("pluto_rule.json")
DATA = L.DATA
REVIEW = L.REVIEW
IMG = checks.IMG_DIR
DECISIONS = DATA / "checks" / "decisions" / "p6.json"
PRODUCER = "p6-pluto"
TARGET = "999"
SIZE = 48
EDGE = 12
EXCLUDE_PX = 12
SEARCH = RULE["search_px"]
NEAR_PX = 3
"""Not part of the rule: how many frames would count if the peak were looked for only within this many pixels of the
predicted place (reported beside the verdict so that a reader can see how much the strict search costs)."""
PX = RULE["pixel_arcsec"]
REFS = ["SPHEREx Level 2 spectral images, data release 1, NASA/IPAC Infrared Science Archive",
        "JPL Horizons on-line ephemeris, NASA/JPL (observer SPHEREx, id -163182)"]
MJD0 = 40587.0  # 1970-01-01


def window() -> tuple[float, float]:
    """The first and last day of the data release as MJD, from the week names in the index (YYYYWnn), padded."""
    meta = json.loads((index.INDEX_DIR / "meta.json").read_text(encoding="utf-8"))
    weeks = sorted({m.group(1) for w in meta["wv"] if (m := re.match(r"(\d{4}W\d{2})", w))})
    def day(w: str) -> float:
        y, n = int(w[:4]), int(w[5:7])
        return (date.fromisocalendar(y, n, 1) - date(1970, 1, 1)).days + MJD0
    return day(weeks[0]) - 7, day(weeks[-1]) + 14


def unit(ra, dec):
    ra, dec = np.radians(ra), np.radians(dec)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], -1)


class Track:
    """Pluto's place at any time, interpolated between daily Horizons nodes (enough to say which frames hold it and
    whether another visit has Pluto near a position; the places that are measured come from Horizons at the frame's own
    time)."""

    def __init__(self, m0: float, m1: float):
        self.mjd = np.arange(math.floor(m0), math.ceil(m1) + 1, 1.0)
        e = horizons.positions(TARGET, self.mjd)
        self.v = unit(e.ra, e.dec)

    def at(self, mjd):
        m = np.atleast_1d(np.asarray(mjd, float))
        v = np.stack([np.interp(m, self.mjd, self.v[:, k]) for k in range(3)], -1)
        v /= np.linalg.norm(v, axis=-1, keepdims=True)
        ra = np.degrees(np.arctan2(v[:, 1], v[:, 0])) % 360.0
        dec = np.degrees(np.arcsin(v[:, 2]))
        return (float(ra[0]), float(dec[0])) if np.ndim(mjd) == 0 else (ra, dec)


def holding_frames(track: Track) -> list[dict]:
    """The frames of the index whose outline holds Pluto at their own time, each with Horizons' position at that time
    and the pixel there; kept when Pluto is at least EDGE pixels from the detector edge."""
    seen: dict[str, dict] = {}
    for m in track.mjd:
        ra, dec = track.at(float(m))
        for f in index.frames_covering(ra, dec):
            seen.setdefault(f["key"], f)
    cand = []
    for f in seen.values():
        ra, dec = track.at(f["tmid"])
        if index.inside(ra, dec, [tuple(c) for c in f["corners"]]):
            cand.append(f)
    cand.sort(key=lambda f: (f["tmid"], f["key"]))
    eph = horizons.positions(TARGET, [f["tmid"] for f in cand]) if cand else None
    out = []
    for f, ra, dec in zip(cand, eph.ra if eph else [], eph.dec if eph else []):
        ff = L.frame(f["key"])
        px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
        if on_frame(px, py, ff.nx, ff.ny) and L.inside_margin(ff, px, py, EDGE):
            out.append({**f, "tmid": ff.mjd, "ra": float(ra), "dec": float(dec), "px": px, "py": py})
    return out


def approx_pixel(corners, nx: int, ny: int, ra: float, dec: float) -> tuple[float, float]:
    """Where a position falls on a frame, from the four corners alone (good to a few pixels): used to tell cheaply
    which frames are worth opening."""
    c = [L.offset_arcsec(ra, dec, a, d) for a, d in corners]
    p0, p1, p3 = np.array(c[0]), np.array(c[1]), np.array(c[3])
    m = np.stack([p1 - p0, p3 - p0], 1)
    x, y = np.linalg.solve(m, -p0)
    return float(x * nx - 0.5), float(y * ny - 0.5)


def twin_for(photo: dict, track: Track, used: set[str]) -> dict | None:
    """The same-colour twin of a photo from another visit, by the shared match rule, or None."""
    ra, dec = photo["ra"], photo["dec"]
    cover = [f for f in index.frames_covering(ra, dec) if f["det"] == photo["det"]]
    vs = visits.visits(cover, photo["det"])
    others = []
    for v in vs:
        if v["short"] or any(f["key"] == photo["key"] for f in v["frames"]):
            continue
        others += v["frames"]
    ff0 = L.frame(photo["key"])
    me = {"det": photo["det"], "lam": 0.0, "bw": 0.0}
    wb = wave.wavelength_at(photo["det"], photo["px"], photo["py"])
    me.update(lam=wb["lam"], bw=wb["bw"], y0=cut_origin(photo["px"], photo["py"])[1], h=SIZE)
    cand = []
    for f in others:
        if f["key"] in used:
            continue
        x, y = approx_pixel(f["corners"], 2040, 2040, ra, dec)
        w = wave.wavelength_at(f["det"], min(max(x, 0), 2039), min(max(y, 0), 2039))
        if abs(w["lam"] - me["lam"]) > 1.5 * max(w["bw"], me["bw"]):
            continue
        pra, pdec = track.at(f["tmid"])
        if math.hypot(*L.offset_arcsec(ra, dec, pra, pdec)) < EXCLUDE_PX * PX:
            continue
        cand.append(f)
    if not cand:
        return None
    ms = []
    keep = []
    for f in cand:
        ff = L.frame(f["key"])
        px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
        if not on_frame(px, py, ff.nx, ff.ny) or not L.inside_margin(ff, px, py, EDGE // 2):
            continue
        w = wave.wavelength_at(ff.det, px, py)
        ms.append({"det": ff.det, "lam": w["lam"], "bw": w["bw"], "y0": cut_origin(px, py)[1], "h": SIZE})
        keep.append(f)
    pairs = match.match_pairs([me], ms)
    if not pairs:
        return None
    f = keep[pairs[0][1]]
    return {**f, "lam_twin": ms[pairs[0][1]]["lam"], "lam_photo": me["lam"],
            "dlam_bw": abs(ms[pairs[0][1]]["lam"] - me["lam"]) / min(ms[pairs[0][1]]["bw"], me["bw"])}


def cut_origin(px: float, py: float) -> tuple[int, int]:
    from sx.wcs import stamp_origin

    return stamp_origin(px, py, SIZE, SIZE)


def difference_frame(photo: dict, twin: dict) -> dict | None:
    """The photo minus its twin on the photo's pixels, in noise units, with both stamps. Both are cut round Pluto's
    place in the photo."""
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
    diff = stack.difference(rb, co_a)
    return {"photo": sa, "twin": sb, "units": diff["units"], "sigma": diff["sigma"], "valid": diff["valid"]}


def detect(units: np.ndarray, tx: float, ty: float, search: int = SEARCH) -> dict:
    """The strongest positive peak of the difference, smoothed with a Gaussian of 1 pixel, in the box of
    (2 SEARCH + 1) squared pixels round (tx, ty), and the position fitted there. Returns {peak (the smoothed height in
    units of the smoothed image's own robust noise), x, y, dist (pixels from (tx, ty)), found}."""
    ok = np.isfinite(units)
    num = gaussian_filter(np.where(ok, units, 0.0), 1.0)
    den = gaussian_filter(ok.astype(float), 1.0)
    sm = np.where(den > 0.5, num / np.maximum(den, 1e-9), np.nan)
    noise = stack.robust_noise(sm[np.isfinite(sm)])
    h, w = units.shape
    cx, cy = int(round(tx)), int(round(ty))
    y0, y1, x0, x1 = max(0, cy - search), min(h, cy + search + 1), max(0, cx - search), min(w, cx + search + 1)
    box = sm[y0:y1, x0:x1]
    if not np.isfinite(box).any() or not noise > 0:
        return {"peak": math.nan, "x": math.nan, "y": math.nan, "dist": math.inf, "found": False}
    iy, ix = np.unravel_index(int(np.nanargmax(box)), box.shape)
    peak = float(box[iy, ix] / noise)
    g = L.fit_gauss(units, x0 + ix, y0 + iy, search=1.5, half=3, sigma0=1.0)
    if g is None:
        return {"peak": peak, "x": math.nan, "y": math.nan, "dist": math.inf, "found": False}
    dist = math.hypot(g["x"] - tx, g["y"] - ty)
    return {"peak": peak, "x": g["x"], "y": g["y"], "dist": dist,
            "found": bool(peak >= RULE["peak_noise_units"] and dist <= RULE["radius_px"])}


def miss(r: dict) -> tuple[int, int, int]:
    """How the frames that were not found were missed: (a stronger peak elsewhere, a peak 1 to 3 pixels from the place, the rest)."""
    far = near = rest = 0
    for x in r["rows"]:
        if x["found"]:
            continue
        if x["df"] is not None and math.isfinite(x["dist"]) and x["peak"] >= RULE["peak_noise_units"]:
            far += x["dist"] > NEAR_PX
            near += x["dist"] <= NEAR_PX
        else:
            rest += 1
    return far, near, rest


def put_decision(entry: dict) -> None:
    have = json.loads(DECISIONS.read_text(encoding="utf-8")) if DECISIONS.exists() else {}
    have["S5"] = entry
    write_json(DECISIONS, dict(sorted(have.items())))


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    m0, m1 = window()
    track = Track(m0, m1)
    frames = holding_frames(track)
    print(f"Pluto between MJD {m0:.0f} and {m1:.0f}: {len(frames)} frames hold it")
    by_det = {d: [f for f in frames if f["det"] == d] for d in range(1, 7)}
    judged, covered = {}, {}
    for d in range(1, 7):
        vs = [v for v in visits.visits(frames, d) if not v["short"]]
        covered[d] = len(vs)
    cover_ok = any(c >= 2 for c in covered.values())
    print("visits that are not short, by detector:", covered)
    results = {}
    if cover_ok:
        for d in range(1, 7):
            if covered[d] < 2:
                continue
            used: set[str] = set()
            pairs = []
            for f in by_det[d]:
                t = twin_for(f, track, used)
                if t is None:
                    continue
                used.add(t["key"])
                pairs.append((f, t))
            sel = L.thin(pairs, RULE["max_per_detector"])
            print(f"detector {d}: {len(by_det[d])} photos, {len(pairs)} with a twin, {len(sel)} difference frames", flush=True)
            if len(sel) < RULE["min_per_detector"]:
                results[d] = {"n": len(sel), "judged": False, "photos": len(by_det[d]), "twins": len(pairs)}
                continue
            rows = []
            for f, t in sel:
                df = difference_frame(f, t)
                if df is None:
                    rows.append({"photo": f, "twin": t, "found": False, "near": False, "peak": math.nan, "dist": math.inf, "df": None})
                    continue
                st = df["photo"]
                det = detect(df["units"], st.tx, st.ty)
                det["near"] = detect(df["units"], st.tx, st.ty, NEAR_PX)["found"]
                rows.append({"photo": f, "twin": t, "df": df, **det})
            nf = sum(r["found"] for r in rows)
            results[d] = {"n": len(rows), "found": nf, "fraction": nf / len(rows), "judged": True, "rows": rows,
                          "near": sum(r["near"] for r in rows),
                          "photos": len(by_det[d]), "twins": len(pairs)}
            print(f"detector {d}: found {nf} of {len(rows)} ({100 * nf / len(rows):.0f}%)", flush=True)
    passing = [d for d, r in results.items() if r["judged"] and r["fraction"] >= RULE["fraction"]]
    keys = sorted({r["photo"]["key"] for v in results.values() if v["judged"] for r in v["rows"]}
                  | {r["twin"]["key"] for v in results.values() if v["judged"] for r in v["rows"]})
    if keys:
        frozen.record("pluto", keys)
    summary = (f"JPL Horizons (observer SPHEREx) puts Pluto on {len(frames)} frames of the release; visits that are not short by "
               f"detector: " + ", ".join(f"D{d} {c}" for d, c in covered.items()) + ". ")
    if not cover_ok:
        why = summary + "Pluto is not covered in two visits that are not short in any detector. Not shown."
        _clean()
        put_decision({"build": False, "why": why})
        print(why)
        return 0
    summary += "Found within 1 pixel of Horizons in " + "; ".join(
        f"D{d} {r['found']} of {r['n']}" if r["judged"] else f"D{d} not judged ({r['n']} difference frames)"
        for d, r in results.items()) + ". "
    if not passing:
        why = (summary + "No detector reaches 80 percent. Not shown. For information, not the rule: with the peak looked for only "
               f"within {NEAR_PX} pixels of the Horizons place, " + "; ".join(f"D{d} {r['near']} of {r['n']}" for d, r in results.items() if r["judged"])
               + ". Frames missed by the rule, by detector (stronger peak elsewhere in the box / peak 1 to 3 pixels from the place / "
               "peak too weak, none fitted or no valid pixels): "
               + "; ".join(f"D{d} {miss(r)[0]} / {miss(r)[1]} / {miss(r)[2]}" for d, r in results.items() if r["judged"]) + ".")
        _clean()
        put_decision({"build": False, "why": why})
        print(why)
        return 0
    best = sorted(passing, key=lambda d: (-results[d]["n"], d))[0]
    why = summary + f"Rule met (at least 80 percent of the difference frames); the showcase is detector {best}."
    r = results[best]
    write_all(best, r, reviewer, why, results, frames, covered)
    put_decision({"build": True, "why": why})
    print(why)
    return 0


def _clean() -> None:
    for p in (DATA / "pluto",):
        if p.exists():
            shutil.rmtree(p)
    for f in (REVIEW / "h9-pluto.png", REVIEW / "h9-pluto.md"):
        f.unlink(missing_ok=True)


def uv_in_stamp(x: float, y: float) -> dict:
    return {"u": round((x + 0.5) / SIZE, 5), "v": round(1 - (y + 0.5) / SIZE, 5)}


def write_all(det: int, res: dict, reviewer, why: str, results: dict, frames: list[dict], covered: dict) -> None:
    rows = [x for x in res["rows"] if x["df"] is not None]
    # frames of the showcase: every photo and its twin, in time order, numbered by visits of the showcase's own frames
    items = []
    for k, x in enumerate(rows):
        items.append((x["df"]["photo"], "photo", k))
        items.append((x["df"]["twin"], "twin", k))
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
                          "horizons": uv_in_stamp(x["df"]["photo"].tx, x["df"]["photo"].ty),
                          "found": x["found"], "peak": x["peak"], "dist_px": x["dist"] if math.isfinite(x["dist"]) else None})
    # visit numbers must count up from 0 without gaps
    remap = {v: n for n, v in enumerate(sorted(set(visit_of)))}
    manifest = render.write_showcase(DATA / "pluto", "pluto", "Pluto", float(frames[0]["ra"]), float(frames[0]["dec"]), st_sorted,
                                     [remap[v] for v in visit_of], pairs, refs=REFS,
                                     numbers=["pluto.found", "pluto.difference_frames"], with_flags=True, preview=None)
    nf = sum(1 for x in rows if x["found"])
    dist = [x["dist"] for x in rows if x["found"]]
    # flipbook picture
    n = len(rows)
    cols = min(6, n)
    nrow = math.ceil(n / cols)
    fig, axs = plt.subplots(nrow, cols, figsize=(1.9 * cols, 2.1 * nrow))
    axs = np.atleast_1d(axs).ravel()
    for ax in axs:
        ax.axis("off")
    for ax, x in zip(axs, rows):
        u = x["df"]["units"]
        ax.imshow(np.where(np.isfinite(u), u, 0.0), origin="lower", cmap="gray", vmin=-RULE_RANGE, vmax=RULE_RANGE, interpolation="nearest")
        st = x["df"]["photo"]
        ax.plot(st.tx, st.ty, "o", mfc="none", mec="#ffd54f", ms=16, mew=1.0)
        ax.set_title(f"{L_day(st.mjd)}  {st.lam:.2f} µm", fontsize=6)
        ax.axis("off")
    fig.tight_layout()
    REVIEW.mkdir(parents=True, exist_ok=True)
    fig.savefig(REVIEW / "h9-pluto.png", dpi=90, metadata={"Software": None}, facecolor="white")
    fig.savefig(DATA / "pluto" / "flip.png", dpi=90, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    # check picture: where the peaks fall
    fig, axs = plt.subplots(1, 2, figsize=(9, 4.2))
    ax = axs[0]
    for x in rows:
        if math.isfinite(x["x"]):
            tx, ty = x["df"]["photo"].tx, x["df"]["photo"].ty
            ax.plot(x["x"] - tx, x["y"] - ty, "o", ms=4, color=L.BLUE if x["found"] else L.ORANGE)
    t = np.linspace(0, 2 * np.pi, 200)
    ax.plot(np.cos(t), np.sin(t), color=L.INK, lw=1)
    ax.set_aspect("equal")
    ax.set_xlim(-6, 6)
    ax.set_ylim(-6, 6)
    ax.set_xlabel("fitted minus Horizons, x (pixels)")
    ax.set_ylabel("y (pixels)")
    ax.set_title(f"Detector {det}: blue found ({nf} of {n}), orange not", fontsize=9)
    ax = axs[1]
    for d, r in sorted(results.items()):
        if r["judged"]:
            ax.bar(d, 100 * r["fraction"], color=L.BLUE if r["fraction"] >= RULE["fraction"] else L.ORANGE)
            ax.text(d, 100 * r["fraction"] + 2, f"{r['found']}/{r['n']}", ha="center", fontsize=8)
    ax.axhline(100 * RULE["fraction"], color=L.INK, lw=1, ls="--")
    ax.set_ylim(0, 115)
    ax.set_xlabel("detector")
    ax.set_ylabel("difference frames with Pluto found (%)")
    ax.set_title("Per detector; dashed: the rule", fontsize=9)
    fig.tight_layout()
    fig.savefig(IMG / "k-pluto-found.png", dpi=110, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    # card
    write_json(DATA / "pluto" / "card.json", {
        "id": "pluto", "name": "Pluto", "detector": det, "showcase": "manifest.json", "kind": "flipbook", "check": "K-pluto",
        "plain": "position checked against JPL Horizons", "preview": "flip.png",
        "verdict": "Pluto is found at the predicted place in {{pluto.found}} of {{pluto.difference_frames}} difference frames.",
        "north_up": False, "stamp_pixels": SIZE, "arcsec_per_pixel": PX,
        "reference": {"text": "JPL Horizons on-line ephemeris, target 999, observer SPHEREx (-163182), astrometric ICRS", "unverified": False},
        "pairs": pair_info, "note": "Position only. Each difference is a photo minus its same-colour twin from another visit; the "
        "stamps are in the detector's own pixels (not rotated), centred on where Horizons puts Pluto in the photo.",
        "refs": REFS, "numbers": ["pluto.found", "pluto.difference_frames"]})
    status = "PASS" if reviewer else "UNVERIFIED"
    judged = [(d, r) for d, r in sorted(results.items()) if r["judged"]]
    row = checks.row(
        "K-pluto", "Pluto lands where JPL Horizons says",
        "In SPHEREx's same-colour flipbook of Pluto's field, Pluto appears where JPL Horizons says it should be.",
        "JPL Horizons gives Pluto's place as SPHEREx saw it at each photo's time. The photos that hold it come from the frame index. Each "
        "photo is subtracted from its same-colour twin from another visit (the shared match rule) at the sky position of Pluto in the "
        "photo, each with its own background removed; the difference is smoothed with a Gaussian of 1 pixel and the strongest positive "
        f"peak within {SEARCH} pixels of the predicted place is fitted. At most {RULE['max_per_detector']} difference frames of each "
        "detector, evenly spaced in time. Position only: no brightness, spectrum or ice is claimed.",
        "Pluto is on photos of two visits that are not short, and in at least one detector at least 80 percent of the difference frames "
        "show a peak of at least 5 noise units within 1 pixel (6.15 arcsec) of the Horizons place. The rule is in "
        "pipeline/frozen/pluto_rule.json, written before any photo was read.",
        status, "position checked against JPL Horizons",
        f"detector {det}: {nf} of {n} difference frames; median distance {np.median(dist):.2f} px", "frames",
        "at least 80 percent", "1 pixel", checks.image_ref(IMG / "k-pluto-found.png"),
        reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run pluto")
    checks.write_rows(PRODUCER, [row])
    ent = {"pluto.frames": numbers.entry(len(frames), 0, check="K-pluto"),
           "pluto.difference_frames": numbers.entry(n, 0, check="K-pluto"),
           "pluto.found": numbers.entry(nf, 0, check="K-pluto"),
           "pluto.fraction": numbers.entry(100 * nf / n, 0, unit="percent", check="K-pluto"),
           "pluto.median_offset_px": numbers.entry(float(np.median(dist)), 2, unit="pixel", check="K-pluto"),
           "pluto.detector": numbers.entry(det, 0, check="K-pluto")}
    numbers.write(PRODUCER, ent)
    lines = ["# H9 (Pluto part): Pluto's flipbook with the Horizons ticks", "",
             "Open `h9-pluto.png`: the difference frames of one detector in time order, each photo minus its same-colour twin, "
             "on a fixed scale of plus and minus 5 noise units. The yellow ring is where JPL Horizons puts Pluto.", "",
             "**Number to read**", "",
             f"- Detector {det}: Pluto found within 1 pixel of Horizons in {nf} of {n} difference frames "
             f"({100 * nf / n:.0f}%), median distance {np.median(dist):.2f} pixels.", "",
             "| Detector | photos holding Pluto | with a twin | difference frames | found |", "|---|---|---|---|---|"]
    for d, r in sorted(results.items()):
        lines.append(f"| {d} | {r['photos']} | {r['twins']} | {r['n']} | " + (f"{r['found']} ({100 * r['fraction']:.0f}%)" if r["judged"] else "not judged") + " |")
    lines += ["", "**It passes if**", "", "1. Pluto is within 1 pixel of the ring in at least 80% of the frames.",
              "2. Nothing else in the frames reads as a mover.", "3. The page says position only: no spectrum, no label of any ice.", "", why, ""]
    (REVIEW / "h9-pluto.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


RULE_RANGE = 5.0


def L_day(mjd: float) -> str:
    return (date(1970, 1, 1) + timedelta(days=int(mjd - MJD0))).isoformat()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
