"""Job falsepos: the four known false positives of the "Is it real?" panel (Checks row K9, the cases; review sheet H9).

    python -m sx.run falsepos

A residual in a difference is not always a change in the sky. Four real cases are prepared, each a showcase (CT-8) of
real photos with the pairs the stage would blink, and the answers the panel has to give for the residual in it:

    star-a, star-b   a dark-bright pair at a steady, bright, catalogued star (the two brightest of the comparison stars of
                     RW Aurigae that are not saturated and show a pair in at least three pairs of photos)
    ghost            a residual at pixels flagged GHOST (the reflection of a very bright star)
    persist          a residual at pixels flagged PERSIST (the after-image of something bright seen just before); of the residuals
                     found, one that appears in a single pair is preferred, and the strongest is taken when none does

Writes site/data/falsepos/<id>/ (manifest.json, stamps.bin, flags.bin, pair.png) for each, site/data/falsepos/cases.json,
review/h9.png and review/h9.md (this part of the sheet: the three empty-field flipbooks and the four cases; Pluto's flipbook
is added to the sheet by whoever builds it), numbers falsepos.* and the frozen list of the frames used. Needs the network the
first time. The four questions are the panel's:

    flagged                     the flag word of the residual's pixel, in either photo of the pair, holds a flag of the tier
                                "saturation" or "defect" (site/js/lib/flags.js); SOURCE alone is not a flag
    more_than_one_pair          the residual is at 3 noise units or beyond, with the same sign, within one pixel of the same
                                place in at least two of the pairs of the showcase
    bright_gaia_star_within_2px a Gaia DR3 star of G 14 or brighter lies within 2 pixels of the residual at the date of one of
                                the two photos
    on_fast_star_ring           a Gaia DR3 star that moves 0.5 arcsec a year or more is predicted within 2 pixels of the residual
                                at the date of one of the two photos

cases.json holds the rules used, and for each case where to click (the pixel in the first photo of its pair and in the second)
and the expected answer to each question, with the facts behind it.
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

from sx import checks, frozen, gaia, match, numbers, render, s3, stack, visits, wave  # noqa: E402
from sx.fits import FLAG, FLAG_NAMES, FrameFile  # noqa: E402
from sx.stamp import cut  # noqa: E402
from sx.wcs import pixel_to_sky, sky_to_pixel  # noqa: E402

from jobs import _p4lib as L  # noqa: E402
from jobs import diffcheck as D  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
OUT = DATA / "falsepos"
REVIEW = ROOT / "review"
PX = L.PX_ARCSEC
RULES = {"residual_units": 3.0, "radius_px": 2.0, "bright_g_max": 14.0, "fast_mas_per_year": 500.0, "flag_tiers": ["saturation", "defect"],
         "same_place_px": 1.0, "min_pairs": 2}
SAT = FLAG["OVERFLOW"] | FLAG["NONLINEAR"] | FLAG["BLOOM"]
DEFECT = 0
for _b in (0, 2, 6, 9, 10, 11, 17, 19, 20, 22, 23, 24, 25, 27, 28):
    DEFECT |= 1 << _b
FLAGGED = SAT | DEFECT
"""The bits of the tiers "saturation" and "defect" of site/js/lib/flags.js."""
MAX_PAIRS = 5
INK, BLUE, ORANGE, GREY, RED = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#b3261e"

GHOST_FRAME = "dr1/level2/2025W25_2A/l2b-v27-2026-213/4/level2_2025W25_2A_0378_1D4_spx_l2b-v27-2026-213.fits"
PERSIST_FRAMES = [
    "dr1/level2/2025W25_1B/l2b-v27-2026-213/2/level2_2025W25_1B_0253_1D2_spx_l2b-v27-2026-213.fits",
    "dr1/level2/2025W24_2D/l2b-v27-2026-202/3/level2_2025W24_2D_0125_2D3_spx_l2b-v27-2026-202.fits",
    "dr1/level2/2025W25_2A/l2b-v27-2026-213/1/level2_2025W25_2A_0378_1D1_spx_l2b-v27-2026-213.fits",
]
"""Frames of the field of Arcturus, a very bright star in a sparse part of the sky: their whole FLAGS were read once and
hold GHOST (detector 4) and thousands of PERSIST pixels (the others). The job searches them in this order."""


def names_of(word: int) -> list[str]:
    return [FLAG_NAMES[b] for b in sorted(FLAG_NAMES) if (word >> b) & 1 and b != 12]


# -- finding a residual in the native pixels of two photos -----------------------------------------------


def region_units(key_a: str, key_b: str, box: tuple[int, int, int, int]):
    """B minus A over a box (x0, x1, y0, y1) of the pixels of A, B read onto them with sx.stack.resample, each with its own
    background (the sigma-clipped median of the pixels that are valid) removed; in noise units of the difference. Returns
    (units, flags of A, flags of B at the same pixels, X, Y, noise in MJy/sr, ra, dec)."""
    fa, fb = FrameFile.open(key_a), FrameFile.open(key_b)
    x0, x1, y0, y1 = box
    Y, X = np.mgrid[y0:y1, x0:x1]
    ra, dec = pixel_to_sky(fa.wcs, X.astype(float), Y.astype(float))
    tx, ty = sky_to_pixel(fb.wcs, ra, dec)
    r0, r1 = int(np.floor(ty.min())) - 2, int(np.ceil(ty.max())) + 3
    ia = fa.image_rows(y0, y1)[:, x0:x1].astype(np.float64)
    fl_a = fa.flag_rows(y0, y1)[:, x0:x1]
    ib = fb.image_rows(r0, r1).astype(np.float64)
    fl_b = fb.flag_rows(r0, r1)
    tb, okb = stack.resample(ib, tx, ty - r0, stack.valid_mask(ib, fl_b))
    nb = fl_b[np.clip(np.rint(ty - r0).astype(int), 0, fl_b.shape[0] - 1), np.clip(np.rint(tx).astype(int), 0, fb.nx - 1)]
    qa = stack.valid_mask(ia, fl_a).astype(bool)
    qb = stack.valid_mask(tb, nb).astype(bool) & (okb > 0)
    d = (tb - stack.clipped_median(tb[qb])) - (ia - stack.clipped_median(ia[qa]))
    sig = stack.robust_noise(d[qa & qb])
    return d / sig, fl_a, nb, X, Y, sig, ra, dec


def twins(key: str, ra: float, dec: float) -> list[tuple[tuple[str, str], tuple[int, int]]]:
    """The photo `key` matched with a photo of each other visit that has at least three photos, by the shared match rule
    (sx.match.match_pairs with the photo alone on its side): ((key of the earlier photo, key of the later one), (the two
    visits as positions in the visits of the detector, the earlier first))."""
    det = int(key.split("/")[-2])
    p = L.plan(ra, dec, det, min_pairs=0)
    me = [k for k, keys in enumerate(p.visit_keys) if key in keys]
    found = []
    if not me:
        return found
    me = me[0]
    for k, keys in enumerate(p.visit_keys):
        if k == me or p.visits[k]["short"]:
            continue
        mine, other = p.info[key], [p.info[x] for x in keys]
        if me < k:
            got = match.match_pairs([mine], other)
            pair = (key, keys[got[0][1]]) if got else None
        else:
            got = match.match_pairs(other, [mine])
            pair = (keys[got[0][0]], key) if got else None
        if pair:
            found.append((pair, (me, k) if me < k else (k, me)))
    return found


def gaia_near(ra: float, dec: float, radius_deg: float, mjd: float) -> list[dict]:
    """Gaia DR3 stars near a position, at the date mjd: dict(source_id, G, ra, dec, pm_mas)."""
    st = gaia.cone(round(ra, 2), round(dec, 2), radius_deg + 0.01)
    if not st:
        return []
    sra, sdec = gaia.propagate(st, mjd)
    out = []
    for s, a, d in zip(st, sra, sdec):
        pm = math.hypot(s["pmra"] or 0.0, s["pmdec"] or 0.0)
        out.append({"source_id": s["source_id"], "G": s["phot_g_mean_mag"], "ra": float(a), "dec": float(d), "pm_mas": pm})
    return out


def sep_px(ra1: float, dec1: float, ra2, dec2):
    e = (np.asarray(ra2) - ra1) * math.cos(math.radians(dec1)) * 3600.0
    n = (np.asarray(dec2) - dec1) * 3600.0
    return np.hypot(e, n) / PX


def find_artefacts(kind: str) -> list[dict]:
    """The residuals that sit on pixels flagged `kind` ("GHOST" or "PERSIST"), one for each flagged patch that was looked
    at, the strongest first: a residual is a local extremum of at least 5 noise units, not within 3 pixels of a Gaia star of
    G 15 or brighter, on a pixel whose flag word holds `kind` (and, in the photo, no other flag than SOURCE and FULLSAMPLE),
    in a photo of a pair where the twin has no flag there."""
    bit = FLAG[kind]
    keys = [GHOST_FRAME] if kind == "GHOST" else PERSIST_FRAMES
    recs = []
    for key in keys:
        ff = FrameFile.open(key)
        fl = ff.flag_rows(0, ff.ny)
        m = ((fl & bit) != 0) & ((fl & (FLAG["GHOST"] if kind == "PERSIST" else FLAG["PERSIST"])) == 0)
        from scipy import ndimage

        lab, n = ndimage.label(m)
        if n == 0:
            continue
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        order = [int(k) for k in np.argsort(sizes)[::-1][: (1 if kind == "GHOST" else 6)]]
        for k in order:
            ys, xs = np.nonzero(lab == k + 1)
            if sizes[k] < 20:
                continue
            cx, cy = int(xs.mean()), int(ys.mean())
            ra, dec = (float(v) for v in pixel_to_sky(ff.wcs, cx, cy))
            for (ka, kb), vp in twins(key, ra, dec):
                other = kb if ka == key else ka
                x0, x1 = max(40, int(xs.min()) - 6), min(ff.nx - 40, int(xs.max()) + 7)
                y0, y1 = max(40, int(ys.min()) - 6), min(ff.ny - 40, int(ys.max()) + 7)
                if kind == "GHOST":  # the patch is big: look at all of it, in steps the memory allows
                    x1, y1 = min(x1, x0 + 140), min(y1, y0 + 140)
                try:
                    U, fa, fb, X, Y, sig, rr, dd = region_units(key, other, (x0, x1, y0, y1))
                except Exception as e:  # a twin that does not cover the box
                    print(f"  {kind} {key.split('/')[-1][:30]} box {x0}-{x1}, {y0}-{y1}: {e}", flush=True)
                    continue
                if not np.isfinite(sig):
                    continue
                plain = FLAG["FULLSAMPLE"] | FLAG["SOURCE"]
                inmask = ((fa & bit) != 0) & ((fa & ~(plain | bit)) == 0) & ((fb & ~plain) == 0)
                if not inmask.any():
                    continue
                st = gaia_near(float(np.mean(rr)), float(np.mean(dd)), 0.12, ff.mjd)
                sx_, sy_ = sky_to_pixel(ff.wcs, [s["ra"] for s in st], [s["dec"] for s in st])
                bright = np.array([s["G"] is not None and s["G"] <= 15.0 for s in st])
                near_star = np.zeros(U.shape, bool)
                for x, y, b in zip(sx_, sy_, bright):
                    if b and x0 - 4 <= x < x1 + 4 and y0 - 4 <= y < y1 + 4:
                        near_star |= np.hypot(X - x, Y - y) <= 3.0
                from scipy.ndimage import uniform_filter

                clean = uniform_filter(((fl & ~plain) == 0).astype(np.float32), size=L.STAMP, mode="constant")
                room = clean[Y, X] >= 0.25  # a stamp round the pixel holds clean pixels to measure the background on
                cand = inmask & ~near_star & room & np.isfinite(U) & (np.abs(U) >= 5)
                # the pixel itself must be the extremum of its 3 by 3 neighbourhood, so that the residual is one thing
                from scipy.ndimage import maximum_filter

                a = np.abs(np.where(np.isfinite(U), U, 0.0))
                cand &= a >= maximum_filter(a, size=3)
                if not cand.any():
                    continue
                yy, xx = np.nonzero(cand)
                j = int(np.argmax(a[cand]))
                rec = {"kind": kind, "key_a": ka, "key_b": kb, "visit_pair": list(vp), "flagged_key": key, "x": int(X[yy[j], xx[j]]), "y": int(Y[yy[j], xx[j]]), "units": float(U[yy[j], xx[j]]),
                       "ra": float(rr[yy[j], xx[j]]), "dec": float(dd[yy[j], xx[j]]), "n_candidates": int(cand.sum()), "flags_a": int(fa[yy[j], xx[j]]), "flags_b": int(fb[yy[j], xx[j]])}
                print(f"  {kind}: {key.split('/')[-1][:34]} candidate at ({rec['x']}, {rec['y']}) {rec['units']:+.1f} units, {rec['n_candidates']} candidates", flush=True)
                recs.append(rec)
    if not recs:
        raise SystemExit(f"no residual found on {kind} pixels")
    return sorted(recs, key=lambda r: -abs(r["units"]))


# -- the showcase and the four answers -------------------------------------------------------------------


def pairs_at(ra: float, dec: float, det: int, key_a: str, key_b: str, vp: tuple[int, int], limit: int = MAX_PAIRS) -> tuple[L.Plan, list[tuple[dict, dict]]]:
    """The pairs a showcase holds at a position and detector: the pair (key_a, key_b) first, then the matched pairs between the
    visits `vp` that use neither of its photos, up to `limit` in all."""
    p = L.plan(ra, dec, det, visit_pair=tuple(vp))
    first = (p.info[key_a], p.info[key_b])
    rest = [(p.infos_a[i], p.infos_b[j]) for i, j in p.pairs
            if p.infos_a[i]["key"] != key_a and p.infos_b[j]["key"] != key_b]
    return p, ([first] + rest)[:limit]


def analyse(ra_s: float, dec_s: float, det: int, pair_infos: list[tuple[dict, dict]], first: int = 0) -> dict:
    """Everything the four questions need, for the residual at the sky position (ra_s, dec_s) and the pair `first`.

    The photos are read as 96 by 96 stamps round the position and put on one sky grid (see _p4lib), flagged pixels kept (the
    stage draws them hatched, it does not remove them). The residual is the
    pixel of the grid with the largest |units| within 1.5 pixels of the position in the first pair; the other pairs are
    looked at within one pixel of it."""
    infos = [i for pr in pair_infos for i in pr]
    stamps = L.load_stamps(infos, ra_s, dec_s)
    grid = L.sky_grid(ra_s, dec_s)
    cx0, cy0 = L.grid_xy(grid, ra_s, dec_s)
    units = []
    for a, b in pair_infos:
        pa = L.make_plane(stamps[a["key"]], grid, show_flagged=True)
        pb = L.make_plane(stamps[b["key"]], grid, show_flagged=True)
        if pa is None or pb is None:
            units.append(None)
            continue
        d = L.difference_of([pa], [pb])
        units.append(np.where(d["valid"].astype(bool), d["units"], np.nan))
    u0 = units[first]
    if u0 is None:
        raise SystemExit("the first pair has too few pixels")
    win = L.disc(cx0, cy0, 1.5)
    a0 = np.where(win & np.isfinite(u0), np.abs(u0), -1.0)
    if a0.max() < 0:
        raise SystemExit("the first pair shows no pixel within 1.5 pixels of the residual")
    cy, cx = np.unravel_index(int(np.argmax(a0)), a0.shape)
    sign = math.copysign(1.0, u0[cy, cx])
    ra_r, dec_r = (float(v) for v in grid.all_pix2world(cx, cy, 0))
    per_pair = []
    for k, u in enumerate(units):
        if u is None:
            per_pair.append({"pair": k, "units": None})
            continue
        w = L.disc(cx, cy, RULES["same_place_px"] + 0.01)
        v = np.where(w & np.isfinite(u), u * sign, -1e9)
        m = float(v.max()) if (w & np.isfinite(u)).any() else float("nan")
        per_pair.append({"pair": k, "units": m * sign, "shows": bool(m >= RULES["residual_units"])})
    a, b = pair_infos[first]
    fl = {}
    pix = {}
    for tag, info in (("a", a), ("b", b)):
        st = stamps[info["key"]]
        ff = L.open_frame(info["key"])
        px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra_r, dec_r))
        j, i = int(round(px)) - st.x0, int(round(py)) - st.y0
        word = int(st.flags[i, j])
        fl[tag] = word
        pix[tag] = (px, py)
    flagged_word = fl["a"] | fl["b"]
    gs = []
    for tag, info in (("a", a), ("b", b)):
        gs += [dict(s, epoch=tag) for s in gaia_near(ra_r, dec_r, 0.02, info["mjd"])]
    for s in gs:
        s["sep_px"] = float(sep_px(ra_r, dec_r, s["ra"], s["dec"]))
    near = [s for s in gs if s["G"] is not None and s["sep_px"] <= RULES["radius_px"] and s["G"] <= RULES["bright_g_max"]]
    near.sort(key=lambda s: s["sep_px"])
    nearest_any = min(gs, key=lambda s: s["sep_px"]) if gs else None
    fast = []
    for tag, info in (("a", a), ("b", b)):
        for s in gaia_near(ra_r, dec_r, 0.05, info["mjd"]):
            if s["pm_mas"] >= RULES["fast_mas_per_year"]:
                fast.append(dict(s, epoch=tag, sep_px=float(sep_px(ra_r, dec_r, s["ra"], s["dec"]))))
    fast_on = [s for s in fast if s["sep_px"] <= RULES["radius_px"]]
    shown = sum(1 for p in per_pair if p.get("shows"))
    return {
        "ra": ra_r, "dec": dec_r, "grid_xy": [float(cx), float(cy)], "units": float(u0[cy, cx]), "pairs": per_pair, "stamps": stamps, "grid": grid, "unit_images": units,
        "click": {"a": {"x": None, "y": None}, "b": {"x": None, "y": None}}, "native_px": pix,
        "flags": {"a": fl["a"], "b": fl["b"]},
        "expected": {
            "flagged": {"answer": bool(flagged_word & FLAGGED), "flags": names_of(flagged_word), "tiers_hit": [n for n, m in (("saturation", SAT), ("defect", DEFECT)) if flagged_word & m]},
            "more_than_one_pair": {"answer": shown >= RULES["min_pairs"], "pairs_with_residual": shown, "pairs": len(per_pair)},
            "bright_gaia_star_within_2px": {"answer": bool(near), "star": ({"source_id": near[0]["source_id"], "G": near[0]["G"], "sep_px": near[0]["sep_px"]} if near else None),
                                            "nearest_any": ({"source_id": nearest_any["source_id"], "G": nearest_any["G"], "sep_px": nearest_any["sep_px"]} if nearest_any else None)},
            "on_fast_star_ring": {"answer": bool(fast_on), "fast_stars_within_3_arcmin": len({s["source_id"] for s in fast}),
                                  "nearest_ring_px": (min(s["sep_px"] for s in fast) if fast else None)},
        },
    }


def write_case(cid: str, title: str, what: str, ra: float, dec: float, det: int, pair_infos: list[tuple[dict, dict]], an: dict) -> dict:
    """The showcase of a case (64 by 64 stamps of every photo of its pairs, flags included) and its entry of cases.json."""
    a0, b0 = pair_infos[0]
    keys, vis = [], []
    for a, b in pair_infos:
        for info, v in ((a, 0), (b, 1)):
            if info["key"] not in keys:
                keys.append(info["key"])
                vis.append(v)
    stamps = [cut(L.open_frame(k), ra, dec, size=64, flags=True) for k in keys]
    pairs = [(keys.index(a["key"]), keys.index(b["key"])) for a, b in pair_infos]
    lo = [float(np.nanpercentile(s.data, 5)) for s in stamps]
    hi = [float(np.nanpercentile(s.data, 99.5)) for s in stamps]
    manifest = render.write_showcase(OUT / cid, cid, title, ra, dec, stamps, vis, pairs, refs=[
        "SPHEREx Level 2 spectral images, data release 1, NASA/IPAC Infrared Science Archive",
        "Gaia DR3, ESA Gaia archive (gaiadr3.gaia_source), epoch J2016.0"], numbers=[], preview=(float(np.median(lo)), float(np.median(hi))))
    new_of = {i: n for n, i in enumerate(sorted(range(len(stamps)), key=lambda i: stamps[i].mjd))}
    ia, ib = keys.index(a0["key"]), keys.index(b0["key"])
    click = {}
    for tag, idx, info in (("a", ia, a0), ("b", ib, b0)):
        st = stamps[idx]
        ff = L.open_frame(info["key"])
        px, py = (float(v) for v in sky_to_pixel(ff.wcs, an["ra"], an["dec"]))
        click[tag] = {"frame": new_of[idx], "x": px - st.x0, "y": py - st.y0}
    return {"id": cid, "showcase": f"falsepos/{cid}", "title": title, "what_it_is": what, "ra": an["ra"], "dec": an["dec"], "detector": det,
            "residual": {"pair": [new_of[ia], new_of[ib]], "pair_index": manifest["pairs"].index([new_of[ia], new_of[ib]]), "click": click, "units": an["units"],
                         "per_pair": an["pairs"], "flags": {"a": names_of(an["flags"]["a"]), "b": names_of(an["flags"]["b"])}},
            "expected": an["expected"], "frames": len(keys)}


# -- the two cases at steady stars -----------------------------------------------------------------------


def star_cases(rule: dict) -> list[tuple[dict, dict, L.Plan, list]]:
    """The two brightest comparison stars of RW Aurigae whose pairs of photos are not saturated and show a dark-bright
    pair in at least three of them (the flipbook test of diffcheck). Returns (star, run summary, plan, pairs) for each."""
    from jobs._rwaur_stars import STARS

    found = []
    for st in sorted(STARS, key=lambda s: s["phot_g_mean_mag"]):
        s = D.star_run(st, rule)
        if not s["ok"]:
            continue
        r = s["_run"]
        n_pair = sum(1 for t in s["flips"] if t["testable"] and t["pair"])
        sat = False
        for k, stp in r["stamps"].items():
            ff = L.open_frame(k)
            px, py = (float(v) for v in sky_to_pixel(ff.wcs, s["ra"], s["dec"]))
            j, i = int(round(px)) - stp.x0, int(round(py)) - stp.y0
            sat |= bool((stp.flags[max(0, i - 4): i + 5, max(0, j - 4): j + 5] & SAT).any())
        print(f"  star G {st['phot_g_mean_mag']:.1f}: D{s['det']}, pairs with a dark-bright pair {n_pair} of {len(s['flips'])}, saturated {sat}", flush=True)
        if n_pair >= 3 and not sat:
            infos = [(r["plan"].infos_a[i], r["plan"].infos_b[j]) for i, j in r["used"]]
            found.append((st, s, r["plan"], infos))
        if len(found) == 2:
            break
    if len(found) < 2:
        raise SystemExit("fewer than two comparison stars qualify")
    return found


# -- the sheet -------------------------------------------------------------------------------------------


def case_panel(ax_row, case: dict, an: dict, pair_infos):
    a0, b0 = pair_infos[0]
    st_a, st_b = an["stamps"][a0["key"]], an["stamps"][b0["key"]]
    u = an["unit_images"][0]
    cx, cy = an["grid_xy"]
    for ax in ax_row:
        ax.set_xticks([])
        ax.set_yticks([])
    lo, hi = np.nanpercentile(st_a.data, [5, 99.5])
    ax_row[0].imshow(np.arcsinh(10 * np.clip((st_a.data - lo) / (hi - lo), 0, 1)), origin="lower", cmap="gray")
    ax_row[0].set_title("earlier photo", fontsize=7)
    ax_row[1].imshow(np.arcsinh(10 * np.clip((st_b.data - lo) / (hi - lo), 0, 1)), origin="lower", cmap="gray")
    ax_row[1].set_title("later photo", fontsize=7)
    cm = plt.get_cmap("RdBu_r").copy()
    cm.set_bad("#d9d9d9")
    ax_row[2].imshow(u, origin="lower", cmap=cm, vmin=-5, vmax=5, interpolation="nearest")
    ax_row[2].plot([cx], [cy], "o", mfc="none", mec="k", ms=14)
    ax_row[2].set_title(f"later minus earlier, {case['residual']['units']:+.1f} units", fontsize=7)
    e = case["expected"]
    txt = (f"{case['title']}\nflagged: {'yes ' + '+'.join(e['flagged']['flags']) if e['flagged']['answer'] else 'no'}\n"
           f"in more than one pair: {'yes' if e['more_than_one_pair']['answer'] else 'no'} ({e['more_than_one_pair']['pairs_with_residual']} of {e['more_than_one_pair']['pairs']})\n"
           f"bright Gaia star within 2 px: {'yes, G ' + format(e['bright_gaia_star_within_2px']['star']['G'], '.1f') if e['bright_gaia_star_within_2px']['answer'] else 'no'}\n"
           f"on a fast star's ring: {'yes' if e['on_fast_star_ring']['answer'] else 'no'}")
    ax_row[3].axis("off")
    ax_row[3].text(0.0, 0.95, txt, va="top", fontsize=7, family="monospace", wrap=True)


def h9_sheet(cases: list[dict], analyses: list[dict], infos: list) -> Path:
    fig = plt.figure(figsize=(13, 14))
    gs = fig.add_gridspec(5, 4, height_ratios=[3.3, 1, 1, 1, 1], hspace=0.3, wspace=0.12)
    ax = fig.add_subplot(gs[0, :])
    ax.axis("off")
    p = checks.IMG_DIR / "k8-flipbooks.png"
    if p.exists():
        ax.imshow(plt.imread(p))
        ax.set_title("Three empty fields, the same-colour differences in time order, +-5 noise units (nothing may read as a mover)", fontsize=9)
    else:
        ax.text(0.5, 0.5, "run `python -m sx.run diffcheck` to draw the empty-field flipbooks", ha="center")
    for k, (c, an, pi) in enumerate(zip(cases, analyses, infos)):
        case_panel([fig.add_subplot(gs[1 + k, j]) for j in range(4)], c, an, pi)
    path = REVIEW / "h9.png"
    return D._save(fig, path, dpi=110)


def h9_text(cases: list[dict]) -> str:
    lines = [
        "# H9: flipbook and 'Is it real?' (this part)",
        "",
        "Open `h9.png`. Top: three empty fields as flipbooks of their pairs, later minus earlier, on the fixed scale of 5 noise units. Below: the four known",
        "false positives, each with the earlier and the later photo, the difference (the ring marks the residual) and the answers the panel has to give.",
        "Pluto's flipbook belongs to this sheet too and is added by the part that builds it.",
        "",
        "**What the empty-field flipbooks show**",
        "",
        "Three fields with no Gaia star brighter than G = 13 within 5 arcmin, every pair of the default visits, later minus earlier. Most of the field is",
        "flat, and dark-bright pairs sit at the faint stars (the pixels the archive flags SOURCE). Whether any of them could be taken for a mover is the",
        "question of this review; the zero-mean test and the star test are on sheet H8 and in row K8.",
        "",
        "**Numbers to read**",
        "",
    ]
    for c in cases:
        e = c["expected"]
        lines.append(f"- {c['id']}: {c['residual']['units']:+.1f} noise units; flagged {e['flagged']['answer']} ({', '.join(e['flagged']['flags']) or 'no flag'}); "
                     f"in {e['more_than_one_pair']['pairs_with_residual']} of {e['more_than_one_pair']['pairs']} pairs; bright Gaia star within 2 pixels {e['bright_gaia_star_within_2px']['answer']}; "
                     f"on a fast star's ring {e['on_fast_star_ring']['answer']}.")
    lines += [
        "",
        "**It passes if**",
        "",
        "1. No residual in the three empty-field flipbooks reads as a mover.",
        "2. Each panel flags its case: the two star cases say 'bright Gaia star' and appear in more than one pair, the GHOST and PERSIST cases say 'flagged'.",
        "3. No wording says 'new' or 'candidate'. Pluto: within 1 pixel of Horizons in at least 80% of its frames (not on this part of the sheet).",
        "",
    ]
    return "\n".join(lines)


# -- the job ---------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    rule = D.load_rule()
    cases, analyses, infos, used = [], [], [], []
    print("steady stars")
    for k, (st, s, plan, pair_infos) in enumerate(star_cases(rule)):
        det = plan.det
        pair_infos = pair_infos[:MAX_PAIRS]
        an = analyse(s["ra"], s["dec"], det, pair_infos)
        cid = "star-a" if k == 0 else "star-b"
        what = (f"A steady star of magnitude {st['phot_g_mean_mag']:.1f} (Gaia DR3 {st['source_id']}). The photos of two visits were taken at the same colour, "
                "but the telescope samples a star with few pixels and the sky has turned between the visits, so the star never cancels pixel by pixel: it leaves a dark and a bright patch, "
                "in every pair.")
        c = write_case(cid, f"A steady bright star (G {st['phot_g_mean_mag']:.1f})", what, s["ra"], s["dec"], det, pair_infos, an)
        cases.append(c), analyses.append(an), infos.append(pair_infos)
        used += [i["key"] for pr in pair_infos for i in pr]
    for kind, cid, title, what in (
        ("GHOST", "ghost", "A reflection of a very bright star (GHOST)",
         "A residual on pixels flagged GHOST: the archive marks light there as a reflection of a very bright star inside the telescope, not something in the sky, so nothing at these pixels can be trusted."),
        ("PERSIST", "persist", "An after-image (PERSIST)",
         "A residual on pixels flagged PERSIST: the archive says these pixels may still carry the after-image of something bright seen just before, so their values cannot be trusted."),
    ):
        print(kind)
        chosen = None
        for rec in find_artefacts(kind):
            det = int(rec["flagged_key"].split("/")[-2])
            plan, pair_infos = pairs_at(rec["ra"], rec["dec"], det, rec["key_a"], rec["key_b"], rec["visit_pair"])
            try:
                an = analyse(rec["ra"], rec["dec"], det, pair_infos)
            except SystemExit as e:
                print(f"  candidate at ({rec['x']}, {rec['y']}): {e}", flush=True)
                continue
            one = an["expected"]["more_than_one_pair"]["pairs_with_residual"] <= 1
            print(f"  candidate at ({rec['x']}, {rec['y']}): {an['units']:+.1f} units, in {an['expected']['more_than_one_pair']['pairs_with_residual']} of {len(pair_infos)} pairs, "
                  f"flags {an['expected']['flagged']['flags']}", flush=True)
            if chosen is None or (one and not chosen[0]):
                chosen = (one, rec, det, pair_infos, an)
            if one:
                break
        if chosen is None:
            raise SystemExit(f"no usable residual on {kind} pixels")
        one, rec, det, pair_infos, an = chosen
        n_with = an["expected"]["more_than_one_pair"]["pairs_with_residual"]
        what += (f" In this showcase it appears in {n_with} of {len(pair_infos)} pairs"
                 + (": that points to the photo and not to the sky." if one else ": something is at that place in every photo, so the flag has to be read with the other answers."))
        c = write_case(cid, title, what, rec["ra"], rec["dec"], det, pair_infos, an)
        cases.append(c), analyses.append(an), infos.append(pair_infos)
        used += [i["key"] for pr in pair_infos for i in pr]
    frozen.record("falsepos", used + [GHOST_FRAME] + PERSIST_FRAMES)
    doc = {"version": 1, "rules": RULES, "about": "Four real false positives of the 'Is it real?' panel. `expected` is the answer to each of the panel's four questions for the residual at `residual.click`.",
           "cases": cases}
    checks.write_json(OUT / "cases.json", doc)
    h9_sheet(cases, analyses, infos)
    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "h9.md").write_text(h9_text(cases), encoding="utf-8", newline="\n")
    ent = {"falsepos.cases": numbers.entry(len(cases), 0)}
    numbers.write(L.PRODUCER, ent)
    for c in cases:
        e = c["expected"]
        print(c["id"], json.dumps({k: v["answer"] for k, v in e.items()}), f"units {c['residual']['units']:+.1f}", "pairs", e["more_than_one_pair"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
