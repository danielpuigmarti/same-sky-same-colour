"""Job rwaur: RW Aurigae's change per colour, and what a plain blink does to steady stars (rows K6 and K7).

    python -m sx.run rwaur [--reviewed "<role>" <YYYY-MM-DD>]

RW Aurigae was seen in two visits about half a year apart, in all six detectors. The job measures it, and
twenty steady comparison stars that lie in the same rows of the same frames, in every frame.

The check that decides part S2. Within each detector (a colour band), frames of the two visits are paired at the same
colour by the match rule: every one-to-one pair the rule accepts, not only the 8 closest that the page loads. The
change of RW Aurigae from the first visit to the second is the median ratio of its pairs, measured three ways:

  all pairs      flux in a 3-pixel aperture, every pixel counted, flagged or not;
  common mask    RW Aurigae is close to saturation, so pixels at its centre are flagged. In both frames of a pair
                 everything within one radius of the star is left out: the radius that holds every flagged pixel of
                 the aperture of either frame. The flux is that of the ring from there out to 4.5 pixels, each pixel
                 counted by the share of it that lies in the ring;
  clean pairs    the pairs in which no pixel of the aperture is flagged in either frame, measured as in "all pairs".

A band is shown only if the sign of its change is the same with the common mask as without it, and that band's
comparison stars, measured with the same mask (the radius of the RW Aurigae pair nearest in colour), have a median
ratio within 1% of 1. Otherwise the band reads "too bright to measure reliably".

False flicker (row K7): the swing of a star is its brightest flux over its faintest among the photos that are
flipped through. The job gives the median swing of the comparison stars, and RW Aurigae's own, at the three stops
of the slider: all photos of the first visit in time order, the photos of one detector, and matched pairs.

Writes: site/data/checks/decisions/p3.json (part "S2"), site/data/numbers/p3.json (keys rwaur.* and lie.*), the rows
K6 and K7 with site/data/checks/img/k6-rwaur.png and k7-flicker.png, site/data/lie/ (the showcase of the slider and
stops.json), the card of RW Aurigae, review/h6.* and h7.*, and the frozen list. No data of other observers are used.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from sx import checks, frozen, gaia, irsa, match, numbers, phot, render, s3, stack, visits, wave  # noqa: E402
from sx.fits import FLAG  # noqa: E402
from sx.wcs import pixel_area_sr, stamp_origin  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402
from jobs._rwaur_stars import STARS  # noqa: E402
from jobs.targets import tolerances  # noqa: E402

JOB = "rwaur"
TARGET = "rw-aur"
R_AP, RING = 3, (7.0, 12.0)
"""Aperture radius and background ring, pixels: the same for RW Aurigae and for the comparison stars."""
R_OUT = 4.5
"""Outer radius of the ring that is measured with the common mask."""
R_MAX = 2.5
"""A pair whose common mask reaches farther than this from the star has too little ring left and is not used."""
EDGE = 0.71
"""Half the diagonal of a pixel: leaving out everything within (distance of a pixel's centre + EDGE) leaves out all of that pixel."""
MASK = phot.BAD_MASK | FLAG["BLOOM"]
"""A flagged pixel: every flag that photometry leaves out, and BLOOM, which the page draws as saturation."""
ROWS, HALF, SUB = 64, 13, 5
"""Rows read round RW Aurigae; half-size of the cut round a source; sub-points per pixel side for shares of a pixel."""
MIN_SNR = 5.0
MIN_PHOTOS = 5
"""A star's swing over a sequence needs at least this many photos."""
MIN_PAIRS = 3
"""A band's change needs at least this many pairs."""
LIE_DET = 1
LIE_SIZE = 48
BOOT, SEED = 1000, 7
IMG = checks.IMG_DIR
BAND_NAMES = {d: f"detector {d}" for d in range(1, 7)}


def find() -> list[str]:
    e = T.targets()[TARGET]
    return [f["key"] for f in irsa.sia_frames(e["ra"], e["dec"], 0.0005)]


# -- one source in one frame ----------------------------------------------------------------------------


def measure_source(sub: np.ndarray, sf: np.ndarray, cx: float, cy: float, omega: float):
    """What the three ways need from a cut round a source at (cx, cy): the plain aperture flux, the flagged pixels
    of the aperture, and the pixels of the ring zone with the distances of their sub-points. None when the
    background ring cannot be measured."""
    p_all = phot.aperture(sub, None, None, cx, cy, R_AP, RING, omega)
    # the background for the ring: flagged pixels left out; pixels marked SOURCE stay, because round a bright star
    # the source mask covers the whole background ring
    p_bg = phot.aperture(sub, None, sf, cx, cy, R_AP, RING, omega, skip_source_in_ring=False)
    if p_all is None or p_bg is None:
        return None
    yy, xx = np.mgrid[: sub.shape[0], : sub.shape[1]]
    r = np.hypot(xx - cx, yy - cy)
    bad = ~np.isfinite(sub) | ((sf & MASK) != 0)
    core = r <= R_AP
    n_core = int(bad[core].sum())
    zone = r <= R_OUT + EDGE
    off = (np.arange(SUB) + 0.5) / SUB - 0.5
    sx = (xx[zone][:, None, None] + off[None, None, :]) - cx
    sy = (yy[zone][:, None, None] + off[None, :, None]) - cy
    return {
        "f_all": p_all.flux if p_all.n_use == p_all.n_ap else math.nan, "err": p_all.err, "bkg": p_bg.bkg,
        "n_core": n_core, "r_flag": float(r[bad & core].max()) if n_core else 0.0,
        "zr": np.hypot(sx, sy).reshape(int(zone.sum()), -1), "zv": sub[zone].astype(np.float64) - p_bg.bkg,
        "zbad": bad[zone], "zrc": r[zone], "omega": omega,
    }


def ring_flux(rec: dict, radius: float) -> float:
    """Flux in mJy of the ring from `radius` to R_OUT round a source: each pixel counts by the share of it that
    lies in the ring. A flagged pixel beyond the aperture is left out and the sum scaled up for it (at least 80% of
    the ring must be usable); a flagged pixel of the aperture inside the ring makes the flux NaN."""
    w = ((rec["zr"] > radius) & (rec["zr"] <= R_OUT)).mean(axis=1)
    use = w > 0
    if (rec["zbad"] & use & (rec["zrc"] <= R_AP)).any():
        return math.nan
    good = use & ~rec["zbad"]
    wt, wg = float(w[use].sum()), float(w[good].sum())
    if wt <= 0 or wg < 0.8 * wt:
        return math.nan
    return float((w[good] * rec["zv"][good]).sum() * wt / wg * rec["omega"] * phot.MJY_TO_MJY)


def mask_radius(a: dict, b: dict) -> float:
    """The radius of the common mask of a pair: 0 when no pixel of either aperture is flagged, else the distance of
    the farthest flagged pixel of either aperture plus EDGE, rounded up to a twentieth of a pixel."""
    if not (a["n_core"] or b["n_core"]):
        return 0.0
    return math.ceil((max(a["r_flag"], b["r_flag"]) + EDGE) * 20 - 1e-9) / 20


def measure_frame(f: dict, target: tuple[float, float], stars: list[dict]) -> list[dict]:
    """RW Aurigae and every comparison star that lies in the rows read round RW Aurigae, measured in one frame."""
    ff = T.frame(f["key"])
    p = T.pixel_of(f["key"], *target)
    if p is None:
        return []
    _, y0 = stamp_origin(p[0], p[1], ROWS, ROWS)
    ya = max(0, y0)
    img, flg = ff.image_rows(y0, y0 + ROWS), ff.flag_rows(y0, y0 + ROWS)
    omega = pixel_area_sr(ff.wcs)
    sra, sdec = gaia.propagate(stars, ff.mjd)
    places = [("target", target[0], target[1])] + [(s["source_id"], float(a), float(d)) for s, a, d in zip(stars, sra, sdec)]
    out = []
    for sid, ra, dec in places:
        q = T._pixel(ff, ra, dec)
        if q is None:
            continue
        x, y = q
        ix, iy = int(math.floor(x + 0.5)), int(math.floor(y + 0.5)) - ya
        if not (HALF <= ix < ff.nx - HALF and HALF <= iy < img.shape[0] - HALF):
            continue
        sl = (slice(iy - HALF, iy + HALF + 1), slice(ix - HALF, ix + HALF + 1))
        rec = measure_source(img[sl], flg[sl], x - (ix - HALF), y - ya - (iy - HALF), omega)
        if rec is None:
            continue
        wb = wave.wavelength_at(ff.det, x, y)
        rec.update(sid=sid, key=f["key"], det=ff.det, mjd=ff.mjd, lam=wb["lam"], bw=wb["bw"],
                   y0=int(math.floor(y + 0.5)) - 32, h=64)
        out.append(rec)
    return out


# -- pairs ----------------------------------------------------------------------------------------------


def all_pairs(a: list[dict], b: list[dict]) -> list[tuple[int, int]]:
    """Every one-to-one pair the match rule accepts, the closest colours first: the rule is applied again and again
    to the frames it has not paired yet, which is the rule without its limit of 8 pairs."""
    ia, ib, out = list(range(len(a))), list(range(len(b))), []
    while ia and ib:
        got = match.match_pairs([a[i] for i in ia], [b[j] for j in ib])
        if not got:
            break
        out += [(ia[i], ib[j]) for i, j in got]
        ua, ub = {i for i, _ in got}, {j for _, j in got}
        ia = [v for k, v in enumerate(ia) if k not in ua]
        ib = [v for k, v in enumerate(ib) if k not in ub]
    return out


def usable(rec: dict) -> bool:
    return bool(np.isfinite(rec["f_all"]) and rec["f_all"] > 0 and rec["f_all"] >= MIN_SNR * rec["err"])


def pairs_of(recs: list[dict], first: set[str], second: set[str]) -> list[tuple[dict, dict]]:
    """The pairs of one source: per detector, its usable frames of the first visit against those of the second."""
    out = []
    for det in range(1, 7):
        a = sorted((r for r in recs if r["det"] == det and r["key"] in first and usable(r)), key=lambda r: r["mjd"])
        b = sorted((r for r in recs if r["det"] == det and r["key"] in second and usable(r)), key=lambda r: r["mjd"])
        out += [(a[i], b[j]) for i, j in all_pairs(a, b)]
    return out


def median_change(ratios) -> tuple[float, float, int]:
    """(median ratio, its error, count). The error is the scatter of the median over BOOT redraws of the pairs."""
    r = np.asarray([v for v in ratios if np.isfinite(v) and v > 0], float)
    if r.size == 0:
        return math.nan, math.nan, 0
    if r.size < 2:
        return float(r[0]), math.nan, 1
    rs = np.random.default_rng(SEED)
    boot = np.median(r[rs.integers(0, r.size, (BOOT, r.size))], axis=1)
    return float(np.median(r)), float(np.std(boot)), int(r.size)


def robust_scatter(ratios) -> float:
    r = np.log(np.asarray([v for v in ratios if np.isfinite(v) and v > 0], float))
    return float(1.4826 * np.median(np.abs(r - np.median(r)))) if r.size > 2 else math.nan


def pct(ratio: float) -> float:
    return 100.0 * (ratio - 1.0)


def span(mjds) -> str:
    """The months a set of dates covers, in words: "September 2025", "February to March 2026"."""
    mjds = list(mjds)
    a, b = T.month_of(min(mjds)), T.month_of(max(mjds))
    if a == b:
        return a
    (ma, ya), (mb, yb) = a.split(), b.split()
    return f"{ma} to {mb} {yb}" if ya == yb else f"{a} to {b}"


def analyse(by: dict[str, list[dict]], first: set[str], second: set[str]) -> dict:
    """The three ways, per detector, for RW Aurigae and for the comparison stars."""
    tp = pairs_of(by.get("target", []), first, second)
    target = []
    for a, b in tp:
        radius = mask_radius(a, b)
        ok = radius <= R_MAX
        fa, fb = (ring_flux(a, radius), ring_flux(b, radius)) if ok else (math.nan, math.nan)
        target.append({"det": a["det"], "lam": 0.5 * (a["lam"] + b["lam"]), "r_all": b["f_all"] / a["f_all"], "radius": radius,
                       "r_mask": fb / fa if ok and fa > 0 and fb > 0 else math.nan,
                       "clean": a["n_core"] == 0 and b["n_core"] == 0, "ka": a["key"], "kb": b["key"],
                       "dl": abs(a["lam"] - b["lam"]) / min(a["bw"], b["bw"])})
    comps = []
    for sid, recs in by.items():
        if sid == "target":
            continue
        for a, b in pairs_of(recs, first, second):
            lam = 0.5 * (a["lam"] + b["lam"])
            near = [t for t in target if t["det"] == a["det"] and np.isfinite(t["r_mask"])]
            forced = min(near, key=lambda t: abs(t["lam"] - lam))["radius"] if near else math.nan
            own = mask_radius(a, b)
            radius = max(forced, own) if np.isfinite(forced) else math.nan
            ok = np.isfinite(radius) and radius <= R_MAX
            fa, fb = (ring_flux(a, radius), ring_flux(b, radius)) if ok else (math.nan, math.nan)
            f0a, f0b = ring_flux(a, 0.0), ring_flux(b, 0.0)
            comps.append({"sid": sid, "det": a["det"], "lam": lam, "r_all": b["f_all"] / a["f_all"], "radius": radius,
                          "r_mask": fb / fa if ok and fa > 0 and fb > 0 else math.nan,
                          "r_ring0": f0b / f0a if f0a > 0 and f0b > 0 else math.nan,
                          "clean": a["n_core"] == 0 and b["n_core"] == 0})
    bands = {}
    for det in range(1, 7):
        t = [p for p in target if p["det"] == det]
        c = [p for p in comps if p["det"] == det]
        cm = [p for p in c if np.isfinite(p["r_mask"])]
        bands[det] = {
            "n": len(t), "lam": (min(p["lam"] for p in t), max(p["lam"] for p in t)) if t else (math.nan, math.nan),
            "all": median_change([p["r_all"] for p in t]),
            "mask": median_change([p["r_mask"] for p in t]),
            "clean": median_change([p["r_all"] for p in t if p["clean"]]),
            "unusable": sum(1 for p in t if not np.isfinite(p["r_mask"])),
            "radius": float(np.median([p["radius"] for p in t])) if t else math.nan,
            "flagged": sum(1 for p in t if not p["clean"]),
            "comp_all": median_change([p["r_all"] for p in c]), "comp_all_scatter": robust_scatter([p["r_all"] for p in c]),
            "comp_mask": median_change([p["r_mask"] for p in cm]), "comp_mask_scatter": robust_scatter([p["r_mask"] for p in cm]),
            "comp_ring0": median_change([p["r_ring0"] for p in c]),
            "comp_stars": len({p["sid"] for p in cm}), "comp_stars_all": len({p["sid"] for p in c}),
        }
    return {"target": target, "comps": comps, "bands": bands}


def decide(b: dict, limit_pct: float) -> tuple[bool, str]:
    """The written rule for one band: (build, why)."""
    a, m, c = b["all"], b["mask"], b["comp_mask"]
    if b["n"] == 0:
        return False, "No pair of frames at the same colour in this band."
    head = (f"All {a[2]} pairs: {pct(a[0]):+.1f} +- {100 * a[1]:.1f} %. ")
    if m[2] < MIN_PAIRS:
        return False, head + (f"With the common mask only {m[2]} of the pairs can be measured (in the others the flagged pixels "
                              f"reach beyond {R_MAX} pixels from the star): too few to say. Too bright to measure reliably.")
    text = head + (f"Common mask ({m[2]} pairs, median radius {b['radius']:.2f} px): {pct(m[0]):+.1f} +- {100 * m[1]:.1f} %. "
                   f"Comparison stars with the same mask: {b['comp_stars']} stars, {c[2]} pairs, median {pct(c[0]):+.2f} "
                   f"+- {100 * c[1]:.2f} % (rule: within {limit_pct:g} %). ")
    same_sign = (m[0] - 1) * (a[0] - 1) > 0
    flat = c[2] > 0 and abs(pct(c[0])) <= limit_pct
    if b["clean"][2] >= 2:
        text += f"Clean pairs ({b['clean'][2]}): {pct(b['clean'][0]):+.1f} +- {100 * b['clean'][1]:.1f} %. "
    else:
        text += f"Clean pairs: {b['clean'][2]}. "
    if same_sign and flat:
        weak = abs(m[0] - 1) < 2 * m[1]
        return True, text + "The sign holds and the comparison stars stay flat: shown." + (
            " The masked change is less than twice its own error from zero." if weak else "")
    why = []
    if not same_sign:
        why.append("the sign does not hold under the mask")
    if not flat:
        why.append("the comparison stars are not flat within the rule under the same mask")
    return False, text + "Not shown: " + " and ".join(why) + ". Too bright to measure reliably."


# -- false flicker --------------------------------------------------------------------------------------


def swing(values) -> float:
    v = np.asarray(values, float)
    return float(v.max() / v.min()) if v.size >= MIN_PHOTOS else math.nan


def flicker(by: dict[str, list[dict]], visit0: set[str], first: set[str], second: set[str]) -> dict:
    """The swing of every source at the three stops: {"all", "detector", "matched"} -> {source: swing}."""
    out = {"all": {}, "detector": {}, "matched": {}, "n_all": {}, "n_detector": {}, "n_matched": {}}
    for sid, recs in by.items():
        seq = sorted((r for r in recs if r["key"] in visit0 and usable(r)), key=lambda r: r["mjd"])
        out["all"][sid] = swing([r["f_all"] for r in seq])
        out["n_all"][sid] = len(seq)
        one = [r for r in seq if r["det"] == LIE_DET]
        out["detector"][sid] = swing([r["f_all"] for r in one])
        out["n_detector"][sid] = len(one)
        ratios = [b["f_all"] / a["f_all"] for a, b in pairs_of([r for r in recs if r["det"] == LIE_DET], first, second)]
        out["matched"][sid] = float(np.median([max(q, 1 / q) for q in ratios])) if ratios else math.nan
        out["n_matched"][sid] = len(ratios)
    return out


def meter(sw: dict[str, float]) -> tuple[float, int]:
    """(median swing of the comparison stars, how many stars it rests on)."""
    v = [x for sid, x in sw.items() if sid != "target" and np.isfinite(x)]
    return (float(np.median(v)), len(v)) if v else (math.nan, 0)


# -- the stage of the slider ----------------------------------------------------------------------------


def write_stage(entry: dict, frames: list[dict], visit0: set[str], number_keys: list[str]) -> dict:
    """site/data/lie/: the showcase of the slider, and stops.json, which says what each stop shows.

    The showcase holds every photo of the first visit, of all six detectors, in time order (visit 0), and the photos
    of the second visit that pair at the same colour with photos of detector LIE_DET (visit 1). Its `det` names
    LIE_DET and its pairs are the pairs the match rule gives in that detector. The detector of a frame is in its
    key. The stamps are on the display grid (north up, as every showcase), LIE_SIZE pixels wide."""
    from sx import contracts as C

    ra, dec = entry["ra"], entry["dec"]
    folder = T.DATA / "lie"
    vt = T.visit_table(frames, LIE_DET)
    pair = visits.default_pair(vt)

    def mt(fs):
        out = []
        for f in fs:
            px, py = T.pixel_of(f["key"], ra, dec)
            wb = wave.wavelength_at(LIE_DET, px, py)
            out.append({"key": f["key"], "det": LIE_DET, "lam": wb["lam"], "bw": wb["bw"], "y0": stamp_origin(px, py, 64, 64)[1], "h": 64})
        return out

    ma, mb = mt(vt[pair[0]]["frames"]), mt(vt[pair[1]]["frames"])
    pairs = [(i, j) for i, j in match.match_pairs(ma, mb) if ma[i]["key"] in visit0]
    keys = [f["key"] for f in frames if f["key"] in visit0] + [mb[j]["key"] for _, j in pairs]
    stamps = sorted((T.north_up(T.stamp_at(k, ra, dec, 64), LIE_SIZE) for k in keys), key=lambda q: q.mjd)
    pos = {q.key: i for i, q in enumerate(stamps)}
    manifest = {
        "id": "lie", "name": entry["name"], "ra": ra, "dec": dec, "det": LIE_DET, "w": LIE_SIZE, "h": LIE_SIZE,
        "frames": [{"key": q.key, "mjd": q.mjd, "lam": q.lam, "bw": q.bw, "x0": q.x0, "y0": q.y0, "tx": q.tx, "ty": q.ty,
                    "visit": 0 if q.key in visit0 else 1, "sky": q.sky} for q in stamps],
        "pairs": [[pos[ma[i]["key"]], pos[mb[j]["key"]]] for i, j in pairs],
        "stamps": C.STAMPS_FILE, "flags": C.FLAGS_FILE,
        "refs": ["SPHEREx Level 2 spectral images, data release 1, NASA/IPAC Infrared Science Archive"],
        "numbers": number_keys, "grid": "north-up",
    }
    folder.mkdir(parents=True, exist_ok=True)
    (folder / C.STAMPS_FILE).write_bytes(b"".join(np.ascontiguousarray(q.data, "<f4").tobytes() for q in stamps))
    (folder / C.FLAGS_FILE).write_bytes(b"".join(np.ascontiguousarray(q.flags, "<i4").tobytes() for q in stamps))
    T.write_text(folder / C.MANIFEST_FILE, json.dumps(manifest, indent=1) + "\n")
    problems = C.check_showcase(folder)
    if problems:
        raise ValueError("the showcase of the slider breaks the contract: " + "; ".join(problems))

    backgrounds, values = [], []
    for q, fr in zip(stamps, manifest["frames"]):
        st = stack.stamp_stats(q.data, q.flags)
        backgrounds.append(None if st["n"] == 0 else round(st["background"], 5))
        if fr["visit"] == 0 and st["n"]:
            values.append((q.data - st["background"]).ravel())
    v = np.concatenate(values)
    v = v[np.isfinite(v)]
    black, white = (float(x) for x in np.percentile(v, [0.5, 99.5]))
    everything = [i for i, fr in enumerate(manifest["frames"]) if fr["visit"] == 0]
    one = [i for i in everything if stamps[i].det == LIE_DET]
    stops = {
        "about": "What each stop of the slider shows, as positions in the frames of manifest.json beside this file. "
                 "`background` gives the sky level of each frame in MJy/sr; `stretch` is one display rule for all stops, "
                 "in MJy/sr above that level (the 0.5th and 99.5th percentile of the photos of the first stop).",
        "detector": LIE_DET,
        "stretch": {"black": round(black, 5), "white": round(white, 5)},
        "background": backgrounds,
        "stops": [
            {"id": "all", "label": "every photo of one visit, in time order", "frames": everything,
             "meter": "lie.swing.all", "target": "lie.rwaur.all"},
            {"id": "detector", "label": "one detector only", "frames": one,
             "meter": "lie.swing.detector", "target": "lie.rwaur.detector"},
            {"id": "matched", "label": "same colour", "pairs": manifest["pairs"],
             "meter": "lie.swing.matched", "target": "lie.rwaur.matched"},
        ],
    }
    checks.write_json(folder / "stops.json", stops)
    return {"stops": stops, "manifest": manifest, "stamps": stamps, "black": black, "white": white}


# -- pictures -------------------------------------------------------------------------------------------


def draw_change(fig, res: dict, decisions: dict, when: tuple[str, str]) -> None:
    gs = fig.add_gridspec(1, 2, width_ratios=[1.55, 1], wspace=0.05)
    ax, tx = fig.add_subplot(gs[0]), fig.add_subplot(gs[1])
    c = res["comps"]
    ax.plot([p["lam"] for p in c], [p["r_all"] for p in c], ".", color="#c9ccd1", ms=3, zorder=1, label="comparison stars, each pair")
    t = res["target"]
    cl = [p for p in t if p["clean"]]
    fl = [p for p in t if not p["clean"]]
    ax.plot([p["lam"] for p in fl], [p["r_all"] for p in fl], "o", mfc="none", mec=T.BLUE, ms=5, zorder=3,
            label="RW Aurigae, pair with a flagged pixel in the aperture")
    ax.plot([p["lam"] for p in cl], [p["r_all"] for p in cl], "o", color=T.BLUE, ms=5, zorder=3, label="RW Aurigae, clean pair")
    first = True
    for det, b in res["bands"].items():
        if not b["n"]:
            continue
        x = 0.5 * (b["lam"][0] + b["lam"][1])
        for (med, err, n), dx, col, mk, lab in ((b["all"], -0.06, T.BLUE, "s", "band median, all pairs"),
                                                (b["mask"], 0.0, T.ORANGE, "D", "band median, common mask"),
                                                (b["clean"], 0.06, T.GREEN, "^", "band median, clean pairs")):
            if n >= 2:
                ax.errorbar(x + dx, med, yerr=err, fmt=mk, color=col, ms=7, capsize=3, mec="white", zorder=5, label=lab if first else None)
        m = b["comp_mask"]
        if m[2]:
            ax.plot(x, m[0], "_", color=T.INK, ms=16, mew=1.6, zorder=4, label="comparison stars, same mask, median" if first else None)
        first = False
    ax.axhline(1, color=T.INK, lw=0.6, ls=":")
    ax.set_yscale("log")
    ax.set_ylim(0.45, 2.3)
    ax.set_yticks([0.5, 0.7, 1, 1.4, 2])
    ax.set_yticklabels(["0.5", "0.7", "1", "1.4", "2"])
    ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    ax.set_xlabel("colour: wavelength of the pair (µm)")
    ax.set_ylabel(f"flux in {when[1]} over {when[0]}")
    ax.set_title("RW Aurigae at matched colours, three ways", fontsize=10, loc="left")
    ax.legend(fontsize=6.5, frameon=False, loc="upper right", ncol=2)
    ax.spines[["top", "right"]].set_visible(False)
    lines = ["band   all pairs      common mask    clean pairs", ""]
    for det, b in res["bands"].items():
        f = lambda s: f"{pct(s[0]):+6.1f}±{100 * s[1]:4.1f} ({s[2]:2d})" if s[2] >= 2 else f"     -     ({s[2]:2d})"
        lines.append(f"D{det}   {f(b['all'])} {f(b['mask'])} {f(b['clean'])}")
    lines += ["", "comparison stars with the same mask", "band   stars pairs  median ± error    scatter"]
    for det, b in res["bands"].items():
        m = b["comp_mask"]
        lines.append(f"D{det}     {b['comp_stars']:2d}  {m[2]:4d}  {pct(m[0]):+6.2f} ± {100 * m[1]:4.2f} %  {100 * b['comp_mask_scatter']:5.1f} %"
                     if m[2] else f"D{det}      -")
    lines += ["", "shown (rule met)?"]
    for det in res["bands"]:
        lines.append(f"D{det}   {'yes' if decisions[str(det)]['build'] else 'no: too bright to measure reliably'}")
    lines += ["", "changes in %, with the number of pairs", "in brackets"]
    tx.axis("off")
    tx.text(0.02, 0.98, "\n".join(lines), va="top", fontsize=7.6, family="monospace", color=T.INK)


def draw_flicker(fig, by: dict, fl: dict, stage: dict, visit0: set[str], first: set[str], second: set[str], vals: dict) -> None:
    gs = fig.add_gridspec(2, 3, height_ratios=[0.45, 1], hspace=0.12, wspace=0.34, left=0.065, right=0.985, top=0.95, bottom=0.12)
    black, white = stage["black"], stage["white"]

    def strip(ax, items, title):
        tiles = []
        for s in items:
            st = stack.stamp_stats(s.data, s.flags)
            tiles.append(render.to_rgb(s.data - (st["background"] if st["n"] else 0.0), black, white))
        gap = np.full((tiles[0].shape[0], 2, 3), 255, np.uint8)
        row = np.concatenate([q for t in tiles for q in (t, gap)][:-1], axis=1)
        ax.imshow(row, interpolation="nearest")
        ax.set_title(title, fontsize=8)
        ax.set_xticks([])
        ax.set_yticks([])

    st, stops = stage["stamps"], stage["stops"]["stops"]
    every, one, pr = stops[0]["frames"], stops[1]["frames"], stops[2]["pairs"][:3]
    spread = lambda idx, k=6: [idx[int(round(i))] for i in np.linspace(0, len(idx) - 1, min(k, len(idx)))]
    strip(fig.add_subplot(gs[0, 0]), [st[i] for i in spread(every)],
          f"stop 1: every photo of the visit, in time order\n(6 of {len(every)} shown)")
    strip(fig.add_subplot(gs[0, 1]), [st[i] for i in spread(one)], f"stop 2: detector {LIE_DET} only (6 of {len(one)} shown)")
    strip(fig.add_subplot(gs[0, 2]), [st[i] for p_ in pr for i in p_],
          f"stop 3: same colour ({len(pr)} of {len(stops[2]['pairs'])} pairs shown)")

    def seq(ax, keep, title, value, n):
        for sid, recs in by.items():
            s = sorted((r for r in recs if r["key"] in visit0 and usable(r) and keep(r)), key=lambda r: r["mjd"])
            if len(s) < MIN_PHOTOS:
                continue
            f = np.array([r["f_all"] for r in s])
            tgt = sid == "target"
            ax.plot(np.arange(len(f)), f / np.median(f), "-", color=T.BLUE if tgt else "#b4b8bf", lw=1.4 if tgt else 0.7, zorder=3 if tgt else 1)
        ax.set_yscale("log")
        ax.set_xlabel("photo, in time order")
        ax.set_ylabel("flux over the star's own median")
        ax.set_title(f"{title}\nmedian swing of {n} comparison stars: x {value:.2f}", fontsize=8)
        ax.spines[["top", "right"]].set_visible(False)

    seq(fig.add_subplot(gs[1, 0]), lambda r: True, "every photo of the visit", vals["all"][0], vals["all"][1])
    seq(fig.add_subplot(gs[1, 1]), lambda r: r["det"] == LIE_DET, f"detector {LIE_DET} only", vals["detector"][0], vals["detector"][1])
    ax = fig.add_subplot(gs[1, 2])
    for sid, recs in by.items():
        pr_ = pairs_of([r for r in recs if r["det"] == LIE_DET], first, second)
        tgt = sid == "target"
        ax.plot([0.5 * (a["lam"] + b["lam"]) for a, b in pr_], [b["f_all"] / a["f_all"] for a, b in pr_], "o" if tgt else ".",
                color=T.BLUE if tgt else "#9aa0a8", ms=5 if tgt else 3, zorder=3 if tgt else 1)
    ax.axhline(1, color=T.INK, lw=0.6, ls=":")
    ax.set_yscale("log")
    ax.set_ylim(0.5, 2.0)
    ax.set_yticks([0.5, 0.7, 1, 1.4, 2])
    ax.set_yticklabels(["0.5", "0.7", "1", "1.4", "2"])
    ax.yaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    ax.set_xlabel("colour: wavelength of the pair (µm)")
    ax.set_ylabel("second photo over first photo of a pair")
    ax.set_title(f"same colour\nmedian swing of {vals['matched'][1]} comparison stars: x {vals['matched'][0]:.3f}", fontsize=8)
    ax.spines[["top", "right"]].set_visible(False)
    fig.text(0.01, 0.01, f"grey: comparison stars; blue: RW Aurigae. All pictures: one display rule, black {black:.2f}, white {white:.2f} MJy/sr "
                         "above each photo's background.", fontsize=7.5, color=T.INK)


# -- the job --------------------------------------------------------------------------------------------


def measure_all(frames: list[dict], target: tuple[float, float]) -> dict[str, list[dict]]:
    by: dict[str, list[dict]] = {}
    for recs in s3.map_threads(lambda f: measure_frame(f, target, STARS), frames):
        for r in recs:
            by.setdefault(r["sid"], []).append(r)
    return by


def visit_sets(frames: list[dict]) -> tuple[set[str], set[str], set[str]]:
    """(the frames of the first visit of all detectors together; per detector, the frames of the two visits the
    visit rule compares: first, second)."""
    vs = visits.visits(frames)
    visit0 = {f["key"] for f in vs[0]["frames"]}
    first, second = set(), set()
    for det in range(1, 7):
        vt = T.visit_table(frames, det)
        pair = visits.default_pair(vt)
        if pair:
            first |= {f["key"] for f in vt[pair[0]]["frames"]}
            second |= {f["key"] for f in vt[pair[1]]["frames"]}
    return visit0, first, second


def main(argv: list[str]) -> int:
    reviewer = T.reviewer_from(argv)
    rule = tolerances()["rw-aur"]
    entry = T.targets()[TARGET]
    keys = frozen.frames_for(JOB, find)
    frames = T.frames_holding(keys, {TARGET: (entry["ra"], entry["dec"])})[TARGET]
    visit0, first, second = visit_sets(frames)
    print(f"{len(frames)} frames; first visit {len(visit0)} frames ({T.day_of(min(f['tmid'] for f in frames if f['key'] in visit0))} to "
          f"{T.day_of(max(f['tmid'] for f in frames if f['key'] in visit0))}); paired visits {len(first)} and {len(second)} frames")
    by = measure_all(frames, (entry["ra"], entry["dec"]))
    res = analyse(by, first, second)
    when = [[f["tmid"] for f in frames if f["key"] in part] for part in (first, second)]

    decisions, entries = {}, {}
    n = numbers.entry
    entries["rwaur.first"] = n(min(when[0]), shown=span(when[0]), check="K6")
    entries["rwaur.last"] = n(max(when[1]), shown=span(when[1]), check="K6")
    for det, b in res["bands"].items():
        build, text = decide(b, rule["comparison_median_pct"])
        decisions[str(det)] = {"build": build, "why": text}
        ref = rule["reference_before_masking_pct"][det - 1]
        print(f"D{det} ({b['lam'][0]:.3f}-{b['lam'][1]:.3f} um): {text}  [reference before masking, another pairing: {ref:+.1f} %; "
              f"comparison stars, all pairs: {b['comp_stars_all']} stars, {b['comp_all'][2]} pairs, median {pct(b['comp_all'][0]):+.2f} %, "
              f"scatter {100 * b['comp_all_scatter']:.1f} %; ring from 0: {pct(b['comp_ring0'][0]):+.2f} %; masked scatter "
              f"{100 * b['comp_mask_scatter']:.1f} %; pairs not usable under the mask: {b['unusable']}]")
        k = f"rwaur.d{det}"
        sg = lambda s: n(pct(s[0]), 1, err=100 * s[1] if np.isfinite(s[1]) else None, unit="%", check="K6", shown=f"{pct(s[0]):+.1f}")
        entries[f"{k}.pairs"] = n(b["all"][2], 0, check="K6")
        if b["all"][2]:
            entries[f"{k}.change"] = sg(b["all"])
            entries[f"{k}.colour.from"] = n(b["lam"][0], 2, unit="µm", check="K6")
            entries[f"{k}.colour.to"] = n(b["lam"][1], 2, unit="µm", check="K6")
        entries[f"{k}.masked.pairs"] = n(b["mask"][2], 0, check="K6")
        if b["mask"][2] >= 2:
            entries[f"{k}.masked"] = sg(b["mask"])
            entries[f"{k}.masked.error"] = n(100 * b["mask"][1], 1, unit="%", check="K6")
        entries[f"{k}.clean.pairs"] = n(b["clean"][2], 0, check="K6")
        if b["clean"][2] >= 2:
            entries[f"{k}.clean"] = sg(b["clean"])
        entries[f"{k}.stars"] = n(b["comp_stars"], 0, check="K6")
        if b["comp_mask"][2]:
            cm = b["comp_mask"]
            entries[f"{k}.stars.median"] = n(pct(cm[0]), 2, err=100 * cm[1] if np.isfinite(cm[1]) else None, unit="%", check="K6",
                                             shown=f"{pct(cm[0]):+.2f}")
    T.put_decision("S2", decisions)

    # false flicker
    fl = flicker(by, visit0, first, second)
    vals = {s: meter(fl[s]) for s in ("all", "detector", "matched")}
    own = {s: fl[s].get("target", math.nan) for s in ("all", "detector", "matched")}
    for s in ("all", "detector", "matched"):
        print(f"swing, {s}: comparison stars median x {vals[s][0]:.3f} over {vals[s][1]} stars; RW Aurigae x {own[s]:.3f} "
              f"({fl['n_' + s].get('target', 0)} photos or pairs)")
    dec = lambda v: 1 if v >= 10 else 2
    entries.update({
        "lie.swing.all": n(vals["all"][0], dec(vals["all"][0]), unit="times", check="K7"),
        "lie.swing.detector": n(vals["detector"][0], dec(vals["detector"][0]), unit="times", check="K7"),
        "lie.swing.matched": n(vals["matched"][0], 2, unit="times", check="K7"),
        "lie.swing.matched.percent": n(pct(vals["matched"][0]), 0, unit="%", check="K7"),
        "lie.stars.all": n(vals["all"][1], 0, check="K7"),
        "lie.stars.detector": n(vals["detector"][1], 0, check="K7"),
        "lie.stars.matched": n(vals["matched"][1], 0, check="K7"),
        "lie.detector": n(LIE_DET, 0, check="K7"),
        "lie.photos.all": n(len(visit0), 0, check="K7"),
        "lie.rwaur.all": n(own["all"], dec(own["all"]), unit="times", check="K7"),
        "lie.rwaur.detector": n(own["detector"], dec(own["detector"]), unit="times", check="K7"),
        "lie.rwaur.matched": n(own["matched"], 2, unit="times", check="K7"),
    })
    lie_keys = sorted(k for k in entries if k.startswith("lie."))
    stage = write_stage(entry, frames, visit0, lie_keys)
    entries["lie.photos.all"] = n(len(stage["stops"]["stops"][0]["frames"]), 0, check="K7")
    entries["lie.photos.detector"] = n(len(stage["stops"]["stops"][1]["frames"]), 0, check="K7")
    entries["lie.pairs"] = n(len(stage["stops"]["stops"][2]["pairs"]), 0, check="K7")
    numbers.write(T.PRODUCER, entries)

    # pictures and rows
    fig = plt.figure(figsize=(12.5, 5.6))
    draw_change(fig, res, decisions, (span(when[0]), span(when[1])))
    img_k6 = T.save_figure(fig, IMG / "k6-rwaur.png")
    fig = plt.figure(figsize=(12.5, 5.6))
    draw_change(fig, res, decisions, (span(when[0]), span(when[1])))
    T.save_figure(fig, T.REVIEW / "h6.png")
    fig = plt.figure(figsize=(13, 6.6))
    draw_flicker(fig, by, fl, stage, visit0, first, second, vals)
    img_k7 = T.save_figure(fig, IMG / "k7-flicker.png")
    fig = plt.figure(figsize=(13, 6.6))
    draw_flicker(fig, by, fl, stage, visit0, first, second, vals)
    T.save_figure(fig, T.REVIEW / "h7.png")

    built = [d for d in decisions if decisions[d]["build"]]
    status6 = ("PASS" if reviewer else "UNVERIFIED") if len(built) == 6 else "LIMIT"
    bands = res["bands"]
    k6 = checks.row(
        "K6", "RW Aurigae: its change per colour, with the saturated centre left out",
        f"Between {span(when[0])} and {span(when[1])} RW Aurigae changed by a different amount in each colour band; "
        "a band is shown only where the change does not rest on pixels close to saturation.",
        "Per detector, every one-to-one pair of frames the match rule accepts between the two visits. Three ways: all pairs "
        f"(aperture of {R_AP} pixels, every pixel); a common mask (in both frames everything within the radius that holds "
        f"every flagged pixel of either aperture is left out, and the flux is that of the ring from there to {R_OUT} pixels); "
        "clean pairs (no flagged pixel in either aperture). Twenty comparison stars in the same frames are measured the same "
        "way, with the mask radius of the RW Aurigae pair nearest in colour. No data of other observers are used.",
        "Per band: the sign of the change is the same with the common mask as with all pairs, and the comparison stars of "
        "that band, with the same mask, have a median ratio within 1% of 1. A band that fails reads \"too bright to measure "
        "reliably\".",
        status6, "change measured per colour" if built else "too bright to measure reliably",
        "; ".join(f"D{d} {pct(b['mask'][0]):+.1f}% ({b['mask'][2]} pairs)" + ("" if decisions[str(d)]["build"] else " not shown")
                  if b["mask"][2] >= 2 else f"D{d} not measurable" for d, b in bands.items()),
        "change with the common mask, per detector",
        "; ".join(f"D{d} {pct(b['all'][0]):+.1f}%" for d, b in bands.items() if b["all"][2]) + " with all pairs",
        "comparison stars within 1%: " + "; ".join(
            f"D{d} {pct(b['comp_mask'][0]):+.2f} +- {100 * b['comp_mask'][1]:.2f}% ({b['comp_stars']} stars)"
            for d, b in bands.items() if b["comp_mask"][2]),
        checks.image_ref(img_k6), reviewer[0] if reviewer and status6 == "PASS" else None,
        reviewer[1] if reviewer and status6 == "PASS" else None, "python -m sx.run rwaur")
    ok7 = vals["matched"][0] < 1.10 and vals["matched"][0] < vals["detector"][0] and vals["matched"][0] < vals["all"][0]
    status7 = ("PASS" if reviewer else "UNVERIFIED") if ok7 else "FAIL"
    k7 = checks.row(
        "K7", "A plain blink makes steady stars seem to change",
        "Flipping through SPHEREx photos that were taken at different colours makes steady stars seem to change in "
        "brightness; between photos of the same colour they hold.",
        f"Twenty steady comparison stars in the frames of RW Aurigae. The swing of a star is its brightest flux over its "
        f"faintest (aperture of {R_AP} pixels) among the photos flipped through: every photo of the first visit in time "
        f"order ({len(visit0)} photos, six detectors); the photos of detector {LIE_DET} in that visit; the two photos of a "
        f"pair matched at the same colour in detector {LIE_DET} (median over the star's pairs). The value is the median over "
        "the stars; RW Aurigae's own swing is given beside it.",
        "The median swing of the comparison stars between matched photos is below 1.10, and below their swing at the other "
        "two stops.",
        status7, "steady stars hold once the colour is matched",
        f"x {vals['all'][0]:.1f} (all photos), x {vals['detector'][0]:.2f} (one detector), x {vals['matched'][0]:.3f} (matched)",
        "median swing of the comparison stars",
        f"RW Aurigae itself: x {own['all']:.1f}, x {own['detector']:.2f}, x {own['matched']:.2f}", "matched below 1.10",
        checks.image_ref(img_k7), reviewer[0] if reviewer and ok7 else None, reviewer[1] if reviewer and ok7 else None,
        "python -m sx.run rwaur")
    T.put_rows([k6, k7])

    # the card
    card_bands = []
    for d, b in bands.items():
        k = f"rwaur.d{d}"
        shown = decisions[str(d)]["build"]
        card_bands.append({
            "detector": d, "shown": shown,
            "text": (f"{{{{{k}.masked}}}} % at {{{{{k}.colour.from}}}} to {{{{{k}.colour.to}}}} µm" if shown
                     else "too bright to measure reliably"),
            "numbers": sorted(x for x in entries if x.startswith(k + ".")),
        })
    T.update_card(TARGET, {
        "kind": "variable", "check": "K6",
        "plain": "change measured per colour" if built else "too bright to measure reliably",
        "within_tolerance": bool(built),
        "verdict": ("From {{rwaur.first}} to {{rwaur.last}} it changed by a different amount in each colour."
                    if built else "Too bright to measure reliably: no change is given."),
        "bands": card_bands, "outside_comparison": "no outside comparison shown",
        "numbers": sorted(x for x in entries if x.startswith("rwaur.")),
    })

    T.write_text(T.REVIEW / "h6.md", sheet_h6(res, decisions, status6))
    T.write_text(T.REVIEW / "h7.md", sheet_h7(vals, own, len(visit0), stage, status7))
    print(f"K6 {status6} (bands shown: {', '.join('D' + d for d in built) or 'none'}); K7 {status7}")
    return 0


def sheet_h6(res: dict, decisions: dict, status: str) -> str:
    out = [
        "# H6: RW Aurigae with a common mask",
        "",
        "Open `h6.png`. Left: every matched pair of RW Aurigae as the ratio of its two fluxes against colour; filled",
        "points are pairs with no flagged pixel in the aperture, hollow points have one. Squares, diamonds and triangles",
        "are the band medians the three ways; the black dashes are the comparison stars measured with the same mask.",
        "",
        "**Numbers to read** (change in %, error, pairs)",
        "",
        "| Band | All pairs | Common mask | Clean pairs | Comparison stars, same mask | Shown |",
        "|---|---|---|---|---|---|",
    ]
    f = lambda s: f"{pct(s[0]):+.1f} ± {100 * s[1]:.1f} ({s[2]})" if s[2] >= 2 else f"none ({s[2]})"
    for d, b in res["bands"].items():
        m = b["comp_mask"]
        out.append(f"| Detector {d}, {b['lam'][0]:.2f} to {b['lam'][1]:.2f} µm | {f(b['all'])} | {f(b['mask'])} | {f(b['clean'])} | "
                   + (f"{b['comp_stars']} stars, {m[2]} pairs, median {pct(m[0]):+.2f} ± {100 * m[1]:.2f} %" if m[2] else "none")
                   + f" | {'yes' if decisions[str(d)]['build'] else 'no'} |")
    out += [
        "",
        "**It passes if**",
        "",
        "1. Per band the written rule is applied: same sign with the common mask as with all pairs, and that band's",
        "   comparison stars within 1% with the same mask. A band that fails reads \"too bright to measure reliably\".",
        "2. The number of comparison stars is printed for every band.",
        "3. The result of the clean pairs is shown.",
        "",
        f"Status written by the job: K6 {status}. Reviewer's role and date are set with",
        "`python -m sx.run rwaur --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ]
    return "\n".join(out)


def sheet_h7(vals: dict, own: dict, n_all: int, stage: dict, status: str) -> str:
    return "\n".join([
        "# H7: the false-flicker meter",
        "",
        "Open `h7.png`. Top: photos of RW Aurigae's field at the three stops of the slider, all drawn with one display",
        "rule. Bottom: the flux of each comparison star (grey) and of RW Aurigae (blue) through the same photos.",
        "",
        "**Numbers to read**",
        "",
        "| Stop | Median swing of the comparison stars | Stars | RW Aurigae itself |",
        "|---|---|---|---|",
        f"| Every photo of the visit, in time order ({n_all} photos) | x {vals['all'][0]:.1f} | {vals['all'][1]} | x {own['all']:.1f} |",
        f"| Detector {LIE_DET} only | x {vals['detector'][0]:.2f} | {vals['detector'][1]} | x {own['detector']:.2f} |",
        f"| Same colour (matched pairs) | x {vals['matched'][0]:.3f} | {vals['matched'][1]} | x {own['matched']:.2f} |",
        "",
        f"One display rule for every picture: black {stage['black']:.2f}, white {stage['white']:.2f} MJy/sr above each photo's",
        "own background.",
        "",
        "**It passes if**",
        "",
        "1. The stretch is the same at every stop.",
        "2. The meter measures the comparison stars, not RW Aurigae.",
        "3. The values equal those of the Checks row K7 (the numbers `lie.swing.all`, `lie.swing.detector`,",
        "   `lie.swing.matched`).",
        "",
        f"Status written by the job: K7 {status}. Reviewer's role and date are set with",
        "`python -m sx.run rwaur --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
