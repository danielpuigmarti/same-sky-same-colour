"""Job gallery: stars that visibly moved between 2010 and 2026, and the "Can you spot it?" set (check PB7, S4).

    python -m sx.run gallery [--reviewed "<role>" <YYYY-MM-DD>] [--decide-only]

The rule is in pipeline/frozen/pb7_rule.json, written before any photo was measured; this job reads every
threshold from it. In short: Gaia DR3 stars moving more than 1 arcsec a year, not saturated in SPHEREx, with two
visits in detector 6, are tested in a seeded order. A star passes when, in each of the two visits, its measured
position is within one pixel (6.15 arcsec) of where Gaia puts it at the time of each photo, and in the AllWISE W2
image of 2010 within one AllWISE pixel of where Gaia puts it then. With 8 stars that pass and 6 empty fields of
matched star density the gallery and the spot-it set are built, otherwise nothing but the decision is written.

Writes (when built): site/data/gallery/<id>/ (a CT-8 showcase of detector 6 photos around the middle of the star's
path, wise2010.png, spherex.png, jump.png, card.json), site/data/gallery/index.json, site/data/spotit/ (12 blinks,
set.json and answers.json), review/h12.*; always: site/data/checks/decisions/p6.json (key S4), the rows and
numbers of producer p6, the picture k-gallery-offsets.png and the frozen frame list "gallery". Needs the network
the first time; answers and byte ranges are cached afterwards. Without --reviewed the Checks row stays UNVERIFIED.
"""
from __future__ import annotations

import json
import math
import random
import shutil
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from jobs import _gallery_lib as L  # noqa: E402
from sx import checks, frozen, index, match, numbers, render, s3, stack, wave  # noqa: E402
from sx.checks import write_json  # noqa: E402
from sx.stamp import cut  # noqa: E402
from sx.wcs import corners, pixel_area_sr, sky_to_pixel  # noqa: E402

RULE = L.read_rule("pb7_rule.json")
DATA = L.DATA
REVIEW = L.REVIEW
IMG = checks.IMG_DIR
DECISIONS = DATA / "checks" / "decisions" / "p6.json"
PRODUCER = "p6"

MATCH_DET, PLAIN_DET = 6, 2
SIZE = 48
"""Side of a photo cut, pixels (295 arcsec): the middle of a star's path is its centre, and a jump of 15 arcsec a
year over 16 years still fits."""
EDGE = 12
CORE_R = 2.0
GRID_N, GRID_SCALE = 120, 2.05
"""The sky grid of the pictures: 120 pixels of 2.05 arcsec (246 arcsec), north up, east left."""
MJD_2026 = 61041.0
MJD_2010 = 55400.0
MIN_FIT, MIN_PEAK = 3, 10.0
PER_VISIT = 12
FIELD_RADIUS = 123.0
SEED = RULE["seed"]
HIGH_ENOUGH = 8
"""Testing goes on past the 12 stars of the gallery until this many that passed lie 30 degrees or more from the ecliptic
(the spot-it set is drawn from them; see the amendment in pb7_rule.json)."""
PX = RULE["pixel_arcsec"]
WPX = RULE["allwise_pixel_arcsec"]
SCALE = 3
REFS = ["SPHEREx Level 2 spectral images, data release 1, NASA/IPAC Infrared Science Archive",
        "AllWISE Atlas image, band W2, NASA/IPAC Infrared Science Archive (doi:10.26131/IRSA153)",
        "Gaia DR3, ESA Gaia archive (gaiadr3.gaia_source), epoch J2016.0"]


def sid(star: dict) -> str:
    return "g" + star["source_id"]


# -- candidates ----------------------------------------------------------------------------------------


def candidates() -> list[dict]:
    """Gaia stars of the rule that detector 6 covers with two visits that are not short, in the seeded order."""
    c = RULE["candidates"]
    out = []
    for s in L.gaia_fast(c["proper_motion_mas_per_year_above"], c["g_mag_between"][0], c["g_mag_between"][1]):
        if L.pm_total(s) <= c["proper_motion_mas_per_year_above"] or s["parallax"] / s["parallax_error"] < c["parallax_over_error_at_least"]:
            continue
        if not (s["ruwe"] < c["ruwe_below"]):
            continue
        out.append(s)
    meta = json.loads((index.INDEX_DIR / "meta.json").read_text(encoding="utf-8"))
    placed = []
    for s in out:
        ra, dec = L.propagate(s, MJD_2026)
        placed.append((index.tile_of(ra, dec, meta), ra, dec, s))
    placed.sort(key=lambda t: t[0])
    kept = []
    for _, ra, dec, s in placed:
        if not index.is_indexed(ra, dec):
            continue
        frames = index.frames_covering(ra, dec)
        if L.deep_pair(frames, MATCH_DET) is None:
            continue
        s = dict(s)
        s["frames"] = frames
        s["ra26"], s["dec26"] = ra, dec
        kept.append(s)
    kept.sort(key=lambda s: s["source_id"])
    random.Random(SEED).shuffle(kept)
    return kept


def star_positions(s: dict) -> dict:
    """The star in 2010 and 2026 and the centre of its pictures."""
    ra10, dec10 = L.propagate(s, MJD_2010)
    ra26, dec26 = L.propagate(s, MJD_2026)
    ra0, dec0 = L.midpoint(ra10, dec10, ra26, dec26)
    e, n = L.offset_arcsec(ra10, dec10, ra26, dec26)
    return {"ra10": ra10, "dec10": dec10, "ra26": ra26, "dec26": dec26, "ra0": ra0, "dec0": dec0,
            "jump": float(math.hypot(e, n))}


def isolated(s: dict, pos: dict) -> bool:
    """No other Gaia source brighter than the star plus 2.5 magnitudes within 20 arcsec of its place in 2010 or 2026."""
    r = 20.0
    near = L.neighbours(pos["ra0"], pos["dec0"], pos["jump"] / 2 + r + 5)
    for o in near:
        if o["source_id"] == s["source_id"] or o["phot_g_mean_mag"] is None:
            continue
        if o["phot_g_mean_mag"] >= s["g"] + 2.5:
            continue
        for ra, dec in ((pos["ra10"], pos["dec10"]), (pos["ra26"], pos["dec26"])):
            if math.hypot(*L.offset_arcsec(ra, dec, o["ra"], o["dec"])) < r:
                return False
    return True


# -- photos ----------------------------------------------------------------------------------------------


def photo_cuts(frames: list[dict], ra0: float, dec0: float, det: int, margin_at=None):
    """The cuts of SIZE pixels round (ra0, dec0) of at most PER_VISIT frames of one visit, flags included.
    `margin_at(mjd)` gives a sky position that must lie at least EDGE pixels from the detector edge (the star at the
    photo's time); None for no such condition. Returns a list of {key, ff, st, mjd}."""
    out = []
    for f in L.thin(frames, PER_VISIT):
        ff = L.frame(f["key"])
        if margin_at is not None:
            ra, dec = margin_at(ff.mjd)
            px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
            if not L.inside_margin(ff, px, py, EDGE):
                continue
        st = cut(ff, ra0, dec0, size=SIZE, flags=True)
        if st is None or match.reaches_bad_rows(st.det, st.y0, SIZE):
            continue
        out.append({"key": f["key"], "ff": ff, "st": st, "mjd": ff.mjd})
    return out


def matchables(photos: list[dict]) -> list[dict]:
    return [{"det": p["st"].det, "lam": p["st"].lam, "bw": p["st"].bw, "y0": p["st"].y0, "h": SIZE} for p in photos]


def coadd_on_grid(photos: list[dict], grid) -> dict | None:
    planes = []
    for p in photos:
        a = L.photo_on_grid(p["ff"], p["st"].data, p["st"].flags, p["st"].x0, p["st"].y0, grid, GRID_N)
        if a is not None:
            planes.append({"data": a, "flags": None})
    return stack.coadd(planes) if planes else None


# -- one star --------------------------------------------------------------------------------------------


def wise_image(ra0: float, dec0: float, ra: float, dec: float):
    """The AllWISE W2 cutout (image, WCS, tile) round (ra0, dec0) from the tile that holds (ra, dec), or None."""
    tile = L.pick_tile(L.allwise_tiles(ra, dec), ra, dec)
    if tile is None:
        return None
    try:
        img, w = L.allwise_cutout(tile["url"], ra0, dec0, 250)
    except Exception:
        return None
    if np.isfinite(img).mean() < 0.8:
        return None
    return img, w, tile


def test_star(s: dict, pos: dict) -> dict:
    """Every test of the rule for one star. Returns a dict with the verdict and the measurements; an accepted star
    also carries `_photos`, `_wise` for the pictures."""
    r = {"id": sid(s), "source_id": s["source_id"], "g": s["g"], "pm": L.pm_total(s) / 1000.0, **{k: pos[k] for k in ("jump",)},
         "ok": False, "why": []}
    a, b = L.deep_pair(s["frames"], MATCH_DET)
    ra0, dec0 = pos["ra0"], pos["dec0"]
    at = lambda mjd: L.propagate(s, mjd)  # noqa: E731
    photos = []
    for v, fr in ((0, a), (1, b)):
        for p in photo_cuts(fr, ra0, dec0, MATCH_DET, at):
            p["visit"] = v
            photos.append(p)
    r["n_photos"] = [sum(1 for p in photos if p["visit"] == v) for v in (0, 1)]
    r["visit_dates"] = [[min(p["mjd"] for p in photos if p["visit"] == v), max(p["mjd"] for p in photos if p["visit"] == v)]
                        for v in (0, 1) if any(p["visit"] == v for p in photos)]
    if min(r["n_photos"]) < MIN_FIT:
        r["why"].append("fewer than 3 usable photos in a visit")
        return r
    # saturation: the flags in the core, in every photo used
    ras, decs = L.propagate(s, [p["mjd"] for p in photos])
    sat = 0
    for p, ra, dec in zip(photos, ras, decs):
        px, py = (float(v) for v in sky_to_pixel(p["ff"].wcs, ra, dec))
        p["ra_t"], p["dec_t"] = float(ra), float(dec)
        fl = L.core_flags(p["st"].flags, px - p["st"].x0, py - p["st"].y0, CORE_R)
        p["sat"] = bool(fl & L.SAT_MASK)
        sat += p["sat"]
    r["saturated_photos"] = int(sat)
    if sat:
        r["why"].append(f"saturation flags in the core of {sat} of {len(photos)} photos")
        return r
    # positions
    rows = {0: [], 1: []}
    for p in photos:
        m = L.star_in_photo(p["ff"], p["st"].data, p["st"].x0, p["st"].y0, p["ra_t"], p["dec_t"])
        p["fit"] = m
        if m is not None and m["peak"] >= MIN_PEAK:
            rows[p["visit"]].append(m)
    r["n_fit"] = [len(rows[0]), len(rows[1])]
    if min(r["n_fit"]) < MIN_FIT:
        r["why"].append("the star is fitted in fewer than 3 photos of a visit")
        return r
    off = []
    for v in (0, 1):
        e, _ = L.clipped_mean([m["dE"] for m in rows[v]])
        n, _ = L.clipped_mean([m["dN"] for m in rows[v]])
        off.append({"dE": e, "dN": n, "px": math.hypot(e, n) / PX})
    r["spherex_offset"] = off
    if max(o["px"] for o in off) > 1.0:
        r["why"].append(f"SPHEREx position {max(o['px'] for o in off):.2f} px from Gaia")
    # AllWISE 2010
    w = wise_image(ra0, dec0, pos["ra26"], pos["dec26"])
    if w is None:
        r["why"].append("no usable AllWISE W2 image")
        return r
    img, wcs_w, tile = w
    t_mid = 0.5 * (tile["t_min"] + tile["t_max"])
    ra_w, dec_w = L.propagate(s, t_mid)
    wx, wy = (float(v) for v in wcs_w.all_world2pix(ra_w, dec_w, 0))
    g = L.fit_gauss(img, wx, wy, search=3.0, half=4, sigma0=2.0)
    if g is None:
        r["why"].append("the star is not found in the AllWISE image")
        return r
    mra, mdec = (float(v) for v in wcs_w.all_pix2world(g["x"], g["y"], 0))
    de, dn = L.offset_arcsec(ra_w, dec_w, mra, mdec)
    r["wise"] = {"tile": tile["tile"], "t_min": tile["t_min"], "t_max": tile["t_max"], "mjd": t_mid, "dE": float(de), "dN": float(dn),
                 "px": math.hypot(de, dn) / WPX, "ra": ra_w, "dec": dec_w, "mra": mra, "mdec": mdec}
    if r["wise"]["px"] > 1.0:
        r["why"].append(f"AllWISE position {r['wise']['px']:.2f} AllWISE pixels from Gaia")
    r["ok"] = not r["why"]
    r["_photos"], r["_wise"] = photos, (img, wcs_w, tile)
    return r


def field_control(s: dict, pos: dict, photos: list[dict]) -> list[dict]:
    """Field stars measured in the same photos: Gaia G 11 to 15, proper motion under 50 mas/yr, no brighter star
    within 25 arcsec. Returns one {dE, dN} per star and visit (mean over the photos where it is fitted)."""
    near = L.neighbours(pos["ra0"], pos["dec0"], 140.0)
    out = []
    for o in near:
        g = o["phot_g_mean_mag"]
        if g is None or not (11.0 <= g <= 15.0) or o["pmra"] is None or math.hypot(o["pmra"], o["pmdec"]) > 50.0:
            continue
        if o["source_id"] == s["source_id"]:
            continue
        if any(q is not o and q["phot_g_mean_mag"] is not None and q["phot_g_mean_mag"] < g + 2.5
               and 0.01 < math.hypot(*L.offset_arcsec(o["ra"], o["dec"], q["ra"], q["dec"])) < 25.0 for q in near):
            continue
        ra, dec = L.propagate({"ra": o["ra"], "dec": o["dec"], "pmra": o["pmra"], "pmdec": o["pmdec"], "parallax": 10.0},
                              [p["mjd"] for p in photos])
        rows = {0: [], 1: []}
        for p, a, d in zip(photos, ra, dec):
            px, py = (float(v) for v in sky_to_pixel(p["ff"].wcs, a, d))
            if not L.inside_margin(p["ff"], px, py, EDGE):
                continue
            if L.core_flags(p["st"].flags, px - p["st"].x0, py - p["st"].y0, CORE_R) & L.SAT_MASK:
                continue
            m = L.star_in_photo(p["ff"], p["st"].data, p["st"].x0, p["st"].y0, float(a), float(d))
            if m is not None and m["peak"] >= MIN_PEAK:
                rows[p["visit"]].append(m)
        for v in (0, 1):
            if len(rows[v]) >= MIN_FIT:
                out.append({"visit": v, "dE": L.clipped_mean([m["dE"] for m in rows[v]])[0],
                            "dN": L.clipped_mean([m["dN"] for m in rows[v]])[0], "g": g})
    return out


# -- pictures and files of one star ------------------------------------------------------------------------


def uv(grid, ra: float, dec: float) -> dict:
    x, y = L.grid_xy(grid, ra, dec)
    return {"u": round((x + 0.5) / GRID_N, 5), "v": round(1 - (y + 0.5) / GRID_N, 5)}


def grid_images(r: dict, pos: dict, photos_later: list[dict]):
    """(grid, wise image on the grid, SPHEREx co-add of the later visit on the grid)."""
    grid = L.sky_grid(pos["ra0"], pos["dec0"], GRID_N, GRID_SCALE)
    img, wcs_w, _ = r["_wise"]
    wimg = L.wise_on_grid(img, wcs_w, grid, GRID_N)
    co = coadd_on_grid(photos_later, grid)
    return grid, wimg, co


def draw_panel(ax, img, rng, title, rings=(), crosses=()):
    rgb = render.to_rgb(img, *rng)
    ax.imshow(rgb, interpolation="nearest")
    ax.set_title(title, fontsize=7)
    ax.set_xticks([])
    ax.set_yticks([])
    for u, v, c in rings:
        ax.plot(u * GRID_N - 0.5, v * GRID_N - 0.5, "o", mfc="none", mec=c, ms=15, mew=1.2)
    for u, v, c in crosses:
        ax.plot(u * GRID_N - 0.5, v * GRID_N - 0.5, "+", color=c, ms=9, mew=1.1)


def write_star(r: dict, s: dict, pos: dict, control: list[dict]) -> dict:
    """The showcase and pictures of one accepted star; returns its entry for index.json."""
    sid_ = r["id"]
    folder = DATA / "gallery" / sid_
    photos = r["_photos"]
    later = [p for p in photos if p["visit"] == 1]
    grid, wimg, co = grid_images(r, pos, later)
    sp = co["data"]
    wb, sb = L.display_range(wimg), L.display_range(sp)
    folder.mkdir(parents=True, exist_ok=True)
    render.asinh_png(folder / "wise2010.png", wimg, *wb, scale=SCALE)
    render.asinh_png(folder / "spherex.png", sp, *sb, scale=SCALE)
    # showcase of the photos
    a = [p for p in photos if p["visit"] == 0]
    pa = match.match_pairs(matchables(a), matchables(later))
    order = sorted(range(len(photos)), key=lambda i: photos[i]["mjd"])
    sorted_photos = [photos[i] for i in order]
    pos_of = {id(p): i for i, p in enumerate(sorted_photos)}
    pairs = [(pos_of[id(a[i])], pos_of[id(later[j])]) for i, j in pa]
    manifest = render.write_showcase(folder, sid_, f"Gaia DR3 {r['source_id']}", pos["ra0"], pos["dec0"],
                                     [p["st"] for p in sorted_photos], [p["visit"] for p in sorted_photos], pairs,
                                     refs=REFS, numbers=[f"gallery.{sid_}.pm", f"gallery.{sid_}.jump"], with_flags=True,
                                     preview=None)
    ring10, ring26 = uv(grid, r["wise"]["ra"], r["wise"]["dec"]), uv(grid, pos["ra26"], pos["dec26"])
    ras, decs = L.propagate(s, np.linspace(MJD_2010, MJD_2026, 9))
    track = [uv(grid, a_, d_) for a_, d_ in zip(ras, decs)]
    w10 = uv(grid, r["wise"]["mra"], r["wise"]["mdec"])
    ctrl = control
    ok_rows = [p["fit"] for p in later if p.get("fit") and p["fit"]["peak"] >= MIN_PEAK]
    e, n = np.mean([m["dE"] for m in ok_rows]), np.mean([m["dN"] for m in ok_rows])
    ra_m, dec_m = L.move(pos["ra26"], pos["dec26"], float(e), float(n))
    m26 = uv(grid, ra_m, dec_m)
    fig, axs = plt.subplots(1, 2, figsize=(8, 4.2))
    draw_panel(axs[0], wimg, wb, "WISE 2010 (band W2)", [(ring10["u"], ring10["v"], "#4fc3f7")], [(w10["u"], w10["v"], "#4fc3f7")])
    draw_panel(axs[1], sp, sb, "SPHEREx, latest visit", [(ring26["u"], ring26["v"], "#ffd54f")], [(m26["u"], m26["v"], "#ffd54f")])
    fig.tight_layout()
    fig.savefig(folder / "jump.png", dpi=110, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    dates = r["visit_dates"]
    card = {
        "id": sid_, "name": f"Gaia DR3 {r['source_id']}", "detector": MATCH_DET, "showcase": "manifest.json",
        "kind": "gallery", "check": "K-gallery", "plain": "position checked against Gaia",
        "reference": {"text": f"Gaia DR3 {r['source_id']}, ESA Gaia archive (gaiadr3.gaia_source), epoch J2016.0", "unverified": False},
        "g_mag": s["g"], "pm_arcsec_per_year": r["pm"], "jump_arcsec": pos["jump"], "jump_pixels": pos["jump"] / PX,
        "verdict": "Moved {{gallery." + sid_ + ".jump}} arcsec between 2010 and 2026; Gaia puts it there to within one pixel.",
        "panels": [
            {"file": "wise2010.png", "label": "WISE, 2010",
             "what": f"AllWISE Atlas image, band W2 (4.6 µm), tile {r['wise']['tile']}", "mjd": r["wise"]["mjd"]},
            {"file": "spherex.png", "label": "SPHEREx, latest visit",
             "what": f"mean of the {len(later)} photos of detector 6 (4.4 to 5.0 µm), each with its own background removed, drawn on the same sky grid",
             "mjd": float(np.mean([p["mjd"] for p in later]))},
        ],
        "picture": "jump.png", "north": "up", "east": "left", "arcsec_per_pixel": GRID_SCALE, "pixels": GRID_N, "resampled": True,
        "rings": [{"label": "2010", **ring10}, {"label": "SPHEREx", **ring26}],
        "measured": [{"label": "2010", **w10}, {"label": "SPHEREx", **m26}],
        "track": track,
        "offsets": {"spherex_px": [o["px"] for o in r["spherex_offset"]], "wise_px": r["wise"]["px"]},
        "visits": [{"first": d[0], "last": d[1], "photos": r["n_fit"][i]} for i, d in enumerate(dates)],
        "control_field_stars": len(ctrl),
        "refs": REFS, "numbers": [f"gallery.{sid_}.pm", f"gallery.{sid_}.jump"],
        "pairs": len(pairs),
    }
    write_json(folder / "card.json", card)
    return {"id": sid_, "name": card["name"], "g": s["g"], "pm": r["pm"], "jump": pos["jump"], "detector": MATCH_DET,
            "preview": "jump.png", "card": "card.json", "ra": pos["ra0"], "dec": pos["dec0"]}


# -- empty fields and the spot-it set -----------------------------------------------------------------------


def field_density(ra: float, dec: float) -> tuple[int, list[dict]]:
    near = L.neighbours(ra, dec, FIELD_RADIUS)
    n = sum(1 for o in near if o["phot_g_mean_mag"] is not None and o["phot_g_mean_mag"] < 17.0
            and math.hypot(*L.offset_arcsec(ra, dec, o["ra"], o["dec"])) <= FIELD_RADIUS)
    return n, near


def truly_empty(near: list[dict]) -> bool:
    """No source with G below 19 that has a proper motion of 150 mas/yr or more, or none at all."""
    for o in near:
        g = o["phot_g_mean_mag"]
        if g is None or g >= 19.0:
            continue
        if o["pmra"] is None or o["pmdec"] is None or math.hypot(o["pmra"], o["pmdec"]) >= 150.0:
            return False
    return True


def find_empty(slot: int, ra0: float, dec0: float, n_ref: int, taken: list[tuple[float, float]]) -> dict | None:
    """An empty field for a mover's field: the first of 60 seeded trial positions that meets the field rule."""
    rng = random.Random(SEED + 1000 + slot)
    for _ in range(60):
        dist, pa = rng.uniform(0.5, 3.0), rng.uniform(0, 2 * math.pi)
        ra, dec = L.move(ra0, dec0, dist * 3600 * math.sin(pa), dist * 3600 * math.cos(pa))
        if abs(L.ecliptic_latitude(ra, dec)) < 30.0 or not index.is_indexed(ra, dec):
            continue
        if any(math.hypot(*L.offset_arcsec(ra, dec, a, d)) < 600 for a, d in taken):
            continue
        frames = index.frames_covering(ra, dec)
        d6, d2 = L.deep_pair(frames, MATCH_DET), L.deep_pair(frames, PLAIN_DET)
        if d6 is None or d2 is None:
            continue
        n, near = field_density(ra, dec)
        if abs(n - n_ref) > max(3, 0.25 * n_ref) or not truly_empty(near):
            continue
        tile = L.pick_tile(L.allwise_tiles(ra, dec), ra, dec)
        if tile is None:
            continue
        return {"ra": ra, "dec": dec, "n": n, "frames": frames, "tile": tile, "near": near}
    return None


def later_photos(frames: list[dict], ra0: float, dec0: float, det: int, star: dict | None, sat_sources: list[dict]) -> tuple[list[dict], int]:
    """Photos of the later visit of the pair of one detector that pass the saturation rule: no OVERFLOW, NONLINEAR or
    BLOOM pixel within 2 pixels of the star (at the photo's time) or of a Gaia source of G below 17 in the field.
    Returns (photos kept, photos dropped)."""
    pair = L.deep_pair(frames, det)
    if pair is None:
        return [], 0
    at = (lambda mjd: L.propagate(star, mjd)) if star else None
    kept, dropped = [], 0
    for p in photo_cuts(pair[1], ra0, dec0, det, at):
        bad = False
        for o in sat_sources:
            if o["phot_g_mean_mag"] is None or o["phot_g_mean_mag"] >= 17.0:
                continue
            px, py = (float(v) for v in sky_to_pixel(p["ff"].wcs, o["ra"], o["dec"]))
            if L.core_flags(p["st"].flags, px - p["st"].x0, py - p["st"].y0, CORE_R) & L.SAT_MASK:
                bad = True
                break
        if not bad and star is not None:
            ra, dec = L.propagate(star, p["mjd"])
            px, py = (float(v) for v in sky_to_pixel(p["ff"].wcs, ra, dec))
            bad = bool(L.core_flags(p["st"].flags, px - p["st"].x0, py - p["st"].y0, CORE_R) & L.SAT_MASK)
        if bad:
            dropped += 1
        else:
            kept.append(p)
    return kept, dropped


def stimulus_images(ra0: float, dec0: float, wise, photos: list[dict], ring_points: list[tuple[float, float]]):
    """(A, B, rings) of one blink: the 2010 image and the SPHEREx co-add on the grid, and the ring positions."""
    grid = L.sky_grid(ra0, dec0, GRID_N, GRID_SCALE)
    img, wcs_w, _ = wise
    wimg = L.wise_on_grid(img, wcs_w, grid, GRID_N)
    co = coadd_on_grid(photos, grid)
    return grid, wimg, None if co is None else co["data"]


def build_spotit(accepted: list[dict], stars: dict, rng_seed: int) -> dict:
    """The 12 blinks. Returns {"ok", "why", "set": [...], "answers": {...}, "figs": [...]}."""
    movers, fields = [], []
    taken: list[tuple[float, float]] = []
    slot_modes = {"mover": ["plain"] * 3 + ["matched"] * 3, "empty": ["plain"] * 3 + ["matched"] * 3}
    rng = random.Random(rng_seed)
    rng.shuffle(slot_modes["mover"])
    rng.shuffle(slot_modes["empty"])
    log = []
    for r in accepted:
        if len(movers) == 6:
            break
        s, pos = stars[r["id"]]
        k = len(movers)
        frames = s["frames"]
        if L.deep_pair(frames, PLAIN_DET) is None:
            log.append(f"{r['id']}: no two visits in detector {PLAIN_DET}")
            continue
        if abs(L.ecliptic_latitude(pos["ra0"], pos["dec0"])) < 30.0:
            log.append(f"{r['id']}: less than 30 degrees from the ecliptic")
            continue
        mode = slot_modes["mover"][k]
        n_ref, near = field_density(pos["ra0"], pos["dec0"])
        e = find_empty(k, pos["ra0"], pos["dec0"], n_ref, taken)
        if e is None:
            log.append(f"{r['id']}: no empty field of matched density in 60 trials")
            continue
        # the mover's blink
        photos_m = r["_later"]
        if mode == "plain":
            photos_m, dropped = later_photos(frames, pos["ra0"], pos["dec0"], PLAIN_DET, s, near)
            if len(photos_m) < 3:
                log.append(f"{r['id']}: fewer than 3 clean photos in detector {PLAIN_DET}")
                continue
        # the empty field's blink
        emode = slot_modes["empty"][k]
        det_e = MATCH_DET if emode == "matched" else PLAIN_DET
        photos_e, dropped_e = later_photos(e["frames"], e["ra"], e["dec"], det_e, None, e["near"])
        if len(photos_e) < 3:
            log.append(f"empty field {k}: fewer than 3 clean photos in detector {det_e}")
            continue
        wise_e = wise_image(e["ra"], e["dec"], e["ra"], e["dec"])
        if wise_e is None:
            log.append(f"empty field {k}: no usable AllWISE image")
            continue
        movers.append({"r": r, "s": s, "pos": pos, "mode": mode, "photos": photos_m, "density": n_ref})
        fields.append({"e": e, "mode": emode, "det": det_e, "photos": photos_e, "wise": wise_e, "n": e["n"]})
        taken.append((e["ra"], e["dec"]))
    if len(movers) < 6:
        return {"ok": False, "why": "; ".join(log) or "fewer than 6 movers could be paired with an empty field", "log": log}
    items = []
    for k in range(6):
        items.append(("mover", movers[k]))
        items.append(("empty", fields[k]))
    random.Random(rng_seed + 7).shuffle(items)
    out_set, answers, figs = [], {}, []
    folder = DATA / "spotit"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    for i, (kind, it) in enumerate(items):
        sid_ = f"s{i + 1:02d}"
        if kind == "mover":
            pos, r = it["pos"], it["r"]
            grid, wimg, sp = stimulus_images(pos["ra0"], pos["dec0"], r["_wise"], it["photos"], [])
            mode = it["mode"]
            ring10, ring26 = uv(grid, r["wise"]["ra"], r["wise"]["dec"]), uv(grid, pos["ra26"], pos["dec26"])
            ans = {"mover": True, "ring2010": ring10, "ring2026": ring26, "jump_arcsec": pos["jump"],
                   "jump_pixels_spherex": pos["jump"] / PX, "gaia": r["source_id"]}
            ra_c, dec_c, dens = pos["ra0"], pos["dec0"], it["density"]
        else:
            e = it["e"]
            grid, wimg, sp = stimulus_images(e["ra"], e["dec"], it["wise"], it["photos"], [])
            mode = it["mode"]
            ans = {"mover": False, "ring2010": None, "ring2026": None}
            ra_c, dec_c, dens = e["ra"], e["dec"], it["n"]
        det = MATCH_DET if mode == "matched" else PLAIN_DET
        wb, sb = L.display_range(wimg), L.display_range(sp)
        render.asinh_png(folder / f"{sid_}-a.png", wimg, *wb, scale=SCALE)
        render.asinh_png(folder / f"{sid_}-b.png", sp, *sb, scale=SCALE)
        out_set.append({"id": sid_, "mode": mode, "a": f"{sid_}-a.png", "b": f"{sid_}-b.png", "pixels": GRID_N * SCALE,
                        "detector": det, "photos": len(it["photos"]), "arcsec_per_pixel": GRID_SCALE / SCALE})
        answers[sid_] = {**ans, "mode": mode, "sources_g17_in_field": dens}
        figs.append((sid_, wimg, wb, sp, sb, ans, mode, det))
    write_json(folder / "set.json", {"about": "Twelve blinks of a field seen by WISE in 2010 and by SPHEREx in its latest visit; "
                                    "six hold a star that moved, six hold none. `mode` is plain (SPHEREx photos of detector 2, "
                                    "1.1 to 1.7 µm, a different colour from the 2010 image) or matched (detector 6, 4.4 to 5.0 µm, "
                                    "the colour of the 2010 image). North up, east left; the pictures are drawn on one sky grid.",
                                    "seed": SEED, "items": out_set})
    write_json(folder / "answers.json", {"about": "Where the star that moved is, as fractions of the picture (u from the left edge, "
                                         "v from the top edge), in the 2010 image and in the SPHEREx image. No ring for an empty field.",
                                         "answers": answers})
    used = {p["key"] for m in movers for p in m["photos"]} | {p["key"] for f in fields for p in f["photos"]}
    return {"ok": True, "set": out_set, "answers": answers, "figs": figs, "log": log, "keys": sorted(used)}


# -- the job ---------------------------------------------------------------------------------------------


def contact_sheet(entries: list[dict], path: Path) -> None:
    n = len(entries)
    fig, axs = plt.subplots(n, 2, figsize=(5.2, 2.6 * n))
    axs = np.atleast_2d(axs)
    for k, e in enumerate(entries):
        wimg, wb, sp, sb, rings, title = e["wimg"], e["wb"], e["sp"], e["sb"], e["rings"], e["title"]
        draw_panel(axs[k][0], wimg, wb, title + " | 2010", [(rings[0]["u"], rings[0]["v"], "#4fc3f7")] if rings[0] else [])
        draw_panel(axs[k][1], sp, sb, "SPHEREx", [(rings[1]["u"], rings[1]["v"], "#ffd54f")] if rings[1] else [])
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=80, metadata={"Software": None}, facecolor="white")
    plt.close(fig)


def offsets_picture(tested: list[dict], path: Path) -> None:
    fig, axs = plt.subplots(1, 2, figsize=(9, 4.2))
    ax = axs[0]
    for r in tested:
        if "spherex_offset" not in r:
            continue
        for o in r["spherex_offset"]:
            ax.plot(o["dE"] / PX, o["dN"] / PX, "o", ms=4, color=L.BLUE if r["ok"] else L.ORANGE, alpha=0.8)
    t = np.linspace(0, 2 * np.pi, 200)
    ax.plot(np.cos(t), np.sin(t), color=L.INK, lw=1)
    ax.axhline(0, color=L.GREY, lw=0.5)
    ax.axvline(0, color=L.GREY, lw=0.5)
    ax.set_aspect("equal")
    lim = max([1.2] + [abs(o[k]) / PX for r in tested if "spherex_offset" in r for o in r["spherex_offset"] for k in ("dE", "dN")])
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    ax.set_xlabel("measured minus Gaia, east (SPHEREx pixels)")
    ax.set_ylabel("north (SPHEREx pixels)")
    ax.set_title("SPHEREx: one dot per star and visit (blue: star passed)", fontsize=9)
    ax = axs[1]
    for r in tested:
        if "wise" in r:
            ax.plot(r["wise"]["dE"] / WPX, r["wise"]["dN"] / WPX, "o", ms=4, color=L.BLUE if r["ok"] else L.ORANGE, alpha=0.8)
    ax.plot(np.cos(t), np.sin(t), color=L.INK, lw=1)
    ax.axhline(0, color=L.GREY, lw=0.5)
    ax.axvline(0, color=L.GREY, lw=0.5)
    ax.set_aspect("equal")
    ws = [abs(r["wise"][k]) / WPX for r in tested if "wise" in r for k in ("dE", "dN")]
    lim = max([1.2] + ws)
    ax.set_xlim(-lim, lim)
    ax.set_ylim(-lim, lim)
    ax.set_xlabel("measured minus Gaia, east (WISE pixels)")
    ax.set_ylabel("north (WISE pixels)")
    ax.set_title("WISE 2010, band W2: one dot per star", fontsize=9)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=110, metadata={"Software": None}, facecolor="white")
    plt.close(fig)


def put_decision(key: str, entry: dict) -> None:
    have = json.loads(DECISIONS.read_text(encoding="utf-8")) if DECISIONS.exists() else {}
    have[key] = entry
    write_json(DECISIONS, dict(sorted(have.items())))


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    cands = candidates()
    print(f"{len(cands)} Gaia stars pass the cuts and have two visits in detector {MATCH_DET}")
    tested, accepted, stars, n_iso = [], [], {}, 0
    for s in cands:
        high = sum(1 for r in accepted if abs(L.ecliptic_latitude(stars[r["id"]][1]["ra0"], stars[r["id"]][1]["dec0"])) >= 30.0)
        if len(tested) >= RULE["max_tested"] or (len(accepted) >= RULE["max_accepted"] and high >= HIGH_ENOUGH):
            break
        pos = star_positions(s)
        if not isolated(s, pos):
            n_iso += 1
            continue
        r = test_star(s, pos)
        tested.append(r)
        stars[r["id"]] = (s, pos)
        print(f"{r['id']} G {s['g']:.1f} pm {r['pm']:.2f}\"/yr: {'PASS' if r['ok'] else 'no: ' + '; '.join(r['why'])}"
              + (f" (SPHEREx {r['spherex_offset'][0]['px']:.2f}, {r['spherex_offset'][1]['px']:.2f} px; WISE {r['wise']['px']:.2f} px)" if r["ok"] else ""), flush=True)
        if r["ok"]:
            accepted.append(r)
        else:
            r.pop("_photos", None)
            r.pop("_wise", None)
    n_pass = len(accepted)
    keys = sorted({p["key"] for r in accepted for p in r["_photos"]})
    for r in accepted:
        r["_later"] = [p for p in r["_photos"] if p["visit"] == 1]
    # empty fields and the spot-it set
    spot = {"ok": False, "why": f"only {n_pass} stars passed (rule: {RULE['min_stars']})"} if n_pass < RULE["min_stars"] else build_spotit(accepted, stars, SEED)
    build = n_pass >= RULE["min_stars"] and spot["ok"]
    controls = []
    entries = []
    contact = []
    if build:
        for r in accepted[: RULE["max_accepted"]]:
            s, pos = stars[r["id"]]
            ctrl = field_control(s, pos, r["_photos"])
            controls += ctrl
            e = write_star(r, s, pos, ctrl)
            entries.append(e)
            grid, wimg, co = grid_images(r, pos, r["_later"])
            card = json.loads((DATA / "gallery" / r["id"] / "card.json").read_text())
            contact.append({"wimg": wimg, "wb": L.display_range(wimg), "sp": co["data"], "sb": L.display_range(co["data"]),
                            "rings": (card["rings"][0], card["rings"][1]), "title": f"{r['id']} G {s['g']:.1f}"})
        write_json(DATA / "gallery" / "index.json", {"about": "Stars that moved between 2010 and 2026: Gaia DR3 stars moving more than "
                                                    "1 arcsec a year, not saturated in SPHEREx.", "items": entries})
        keys += spot["keys"]
    else:
        for sub in ("gallery", "spotit"):
            if (DATA / sub).exists():
                shutil.rmtree(DATA / sub)
        for f in (REVIEW / "h12.png", REVIEW / "h12-spotit.png"):
            f.unlink(missing_ok=True)
        why = (f"{len(cands)} Gaia stars moving over 1 arcsec a year (G 11 to 16, two visits in detector 6); {n_iso} not isolated; "
               f"{len(tested)} tested in the seeded order; {n_pass} passed every test (rule: at least {RULE['min_stars']}). "
               + (spot.get("why") or "") + " Not built.")
        put_decision("S4", {"build": False, "why": why, "stars": n_pass})
        print(why)
        return 0
    offsets_picture(tested, IMG / "k-gallery-offsets.png")
    if contact:
        contact_sheet(contact, REVIEW / "h12.png")
    cd = np.array([[c["dE"], c["dN"]] for c in controls]) if controls else np.zeros((0, 2))
    pm_all = [r["pm"] for r in accepted]
    why_fail = {}
    for r in tested:
        for w in r["why"]:
            k = w.split(" ")[0] if not w.startswith("S") and not w.startswith("A") else " ".join(w.split(" ")[:2])
            why_fail[k] = why_fail.get(k, 0) + 1
    summary = (f"{len(cands)} Gaia stars moving over 1 arcsec a year, between G 11 and 16, with two visits in detector 6; "
               f"{n_iso} dropped as not isolated; {len(tested)} tested in the seeded order; {n_pass} passed every test. ")
    if build:
        summary += (f"Spot-it set: 12 blinks (6 movers, 6 empty fields), seed {SEED}. Control: {len(cd)} field-star visits measured in the "
                    f"same photos are off Gaia by a median of ({np.median(cd[:, 0]) :+.2f}, {np.median(cd[:, 1]):+.2f}) arcsec (east, north).")
    else:
        summary += "Not built: " + (spot.get("why") or "") + "."
    put_decision("S4", {"build": bool(build), "why": summary, "stars": n_pass})
    # rows and numbers
    status = "FAIL" if not build else ("PASS" if reviewer else "UNVERIFIED")
    s_off = [o["px"] for r in tested if "spherex_offset" in r for o in r["spherex_offset"]]
    row = checks.row(
        "K-gallery", "Fast stars land where Gaia says, 2010 to 2026",
        "Stars that moved more than 1 arcsec a year can be seen to have moved between a WISE image of 2010 and SPHEREx, and "
        "Gaia puts each one where the pictures show it at both dates.",
        f"Gaia DR3 stars with a proper motion over 1 arcsec a year, G 11 to 16, isolated, with two visits in detector 6, tested in a seeded "
        f"order ({len(tested)} tested). Each is measured in up to {PER_VISIT} photos of each of the two visits (a Gaussian fitted to every "
        "photo, averaged over the visit) and in the AllWISE W2 image of 2010; a star with a saturation flag in its core in any photo is "
        "rejected. Gaia is moved to each date with proper motion and parallax (astropy). Six empty fields of matched star density, from "
        "Gaia, are the control for the \"Can you spot it?\" set; field stars measured in the same photos are the control for the "
        "positions.",
        f"At least {RULE['min_stars']} stars within 1 detector pixel (6.15 arcsec) in each visit and within 1 AllWISE pixel (1.375 arcsec) in "
        "2010, none saturated in any photo used, and 6 empty fields of matched density. The rule is in pipeline/frozen/pb7_rule.json, "
        "written before any photo was measured.",
        status, "positions checked against Gaia",
        f"{n_pass} of {len(tested)} stars tested pass" + (f"; worst SPHEREx offset of those that pass {max(o['px'] for r in accepted for o in r['spherex_offset']):.2f} px" if accepted else ""),
        "stars", f"at least {RULE['min_stars']} stars", "1 pixel", checks.image_ref(IMG / "k-gallery-offsets.png"),
        reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run gallery")
    if not build:
        row["status"] = "FAIL"
        row["reviewer_role"] = row["reviewed_on"] = None
    checks.write_rows(PRODUCER + "-gallery", [row])
    ent = {"gallery.shown": numbers.entry(len(entries), 0, check="K-gallery"),
           "gallery.candidates": numbers.entry(len(cands), 0, check="K-gallery"),
           "gallery.tested": numbers.entry(len(tested), 0, check="K-gallery"),
           "gallery.passed": numbers.entry(n_pass, 0, check="K-gallery")}
    if accepted:
        ent["gallery.pm_min"] = numbers.entry(min(pm_all), 2, unit="arcsec per year", check="K-gallery")
        ent["gallery.pm_max"] = numbers.entry(max(pm_all), 2, unit="arcsec per year", check="K-gallery")
        ent["gallery.offset_max_px"] = numbers.entry(max(o["px"] for r in accepted for o in r["spherex_offset"]), 2, unit="pixel", check="K-gallery")
    if build:
        for e, r in zip(entries, accepted[: RULE["max_accepted"]]):
            ent[f"gallery.{r['id']}.pm"] = numbers.entry(r["pm"], 2, unit="arcsec per year", check="K-gallery")
            ent[f"gallery.{r['id']}.jump"] = numbers.entry(r["jump"], 0, unit="arcsec", check="K-gallery")
        ent["spotit.items"] = numbers.entry(12, 0, check="K-gallery")
    numbers.write(PRODUCER + "-gallery", ent)
    frozen.record("gallery", keys)
    (REVIEW / "h12.md").write_text(sheet_text(build, tested, accepted, entries, spot, summary), encoding="utf-8", newline="\n")
    print(summary)
    return 0


def sheet_text(build: bool, tested, accepted, entries, spot, summary: str) -> str:
    lines = ["# H12: movers gallery and spot-it set", ""]
    if not build:
        lines += ["PB7 did not pass, so no gallery and no set were built.", "", summary, ""]
        return "\n".join(lines)
    lines += ["Open `h12.png` (one row for each gallery star: the 2010 image with its ring, the SPHEREx image with its ring) and",
              "`h12-spotit.png` (the 12 blinks, with the rings that the page shows after the tap).", "",
              "**Number to read**", "",
              f"- {len(accepted)} stars passed; the worst distance from Gaia in SPHEREx is "
              f"{max(o['px'] for r in accepted for o in r['spherex_offset']):.2f} pixels, in the 2010 image "
              f"{max(r['wise']['px'] for r in accepted):.2f} AllWISE pixels.", "",
              "| Star | G | motion (arcsec/yr) | jump 2010 to 2026 (arcsec) | SPHEREx offsets (px) | WISE offset (px) |", "|---|---|---|---|---|---|"]
    for r in accepted:
        lines.append(f"| {r['id']} | {r['g']:.1f} | {r['pm']:.2f} | {r['jump']:.0f} | "
                     f"{r['spherex_offset'][0]['px']:.2f}, {r['spherex_offset'][1]['px']:.2f} | {r['wise']['px']:.2f} |")
    lines += ["", "**It passes if**", "",
              "1. Each mover is on its ring within 1 pixel in both images and none is saturated.",
              "2. Each of the six empty fields is truly empty: no star moves between its two images.",
              "3. The plain blinks use detector 2 photos and the matched blinks detector 6 photos, three of each among the movers and "
              "among the empty fields (`site/data/spotit/set.json`).", "", summary, ""]
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
