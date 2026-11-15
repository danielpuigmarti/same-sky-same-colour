"""Job targets: the five named targets (Checks rows K5 and K6-rdra, review sheet H5).

    python -m sx.run targets --tolerances                          once, before anything is measured
    python -m sx.run targets [--reviewed "<role>" <YYYY-MM-DD>]

For each target the job writes a showcase (CT-8) under site/data/targets/<id>/: the frames of one detector in the
two visits that the visit rule picks, paired at the same colour by the match rule. Beside it goes card.json, what a
card of the page needs beyond the showcase.

Three targets move across the sky (Epsilon Indi B, Barnard's Star, WISE 0855-0714). For each, the job fetches the
image the WISE telescope took in 2010 (AllWISE Atlas, band W2), measures where the object is in it and where it is
in SPHEREx's latest visit, and compares the shift between the two with the shift its catalogue astrometry gives
(Gaia DR3 for the two stars, the published astrometry in names.json for WISE 0855). The tolerances are read from
site/data/targets/tolerances.json, which `--tolerances` writes from the catalogue and the dates of the 2010 images
alone; a normal run never writes that file and stops if it is missing.

Where the object was in 2010 is the centre of a Gaussian fitted to it, except for a star that saturates WISE
(Barnard's Star): the core of such an image is spoiled, and the Gaussian lands on its brighter side, 6 arcsec off.
Its centre is taken from the wings instead (the centroid of the light 2 to 4 beam widths out, repeated from the
centre found until it settles). The first value is kept in the row and in the review sheet, said to be unused. A
star that sits beside a target in SPHEREx's photos (one does, beside WISE 0855) is looked for in the 2010 image,
where the target was elsewhere, and its distance from its Gaia position is given.

R Draconis is checked for saturation in every frame of the list: a frame counts as saturated when a pixel within
3 pixels of the star carries a saturation flag. No brightness is produced for it, for Barnard's Star or for WISE 0855.

Writes: site/data/targets/<id>/ (manifest.json, stamps.bin, flags.bin, pair.png, card.json; for the movers also
wise2010.png, spherex.png, jump.png), site/data/numbers/p3.json (keys targets.*), site/data/checks/rows/p3.json (rows
K5 and K6-rdra), site/data/checks/img/k5-movers.png and k6-rdra.png, review/h5.md and h5.png, and the frozen list.
Needs the network the first time; frames and catalogue answers are cached afterwards.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import sys
import time
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import requests  # noqa: E402

from sx import checks, frozen, irsa, match, numbers, render, s3, stack, visits, wave  # noqa: E402
from sx.wcs import sky_to_pixel, stamp_origin  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402

JOB = "targets"
DET = {"eps-indi-b": 6, "barnard": 6, "wise0855": 6, "rw-aur": 1, "r-dra": 2}
"""The detector each target is shown in. The three movers: detector 6, the reddest (4.4 to 5.0 µm), where the two
brown dwarfs are brightest, WISE 0855 is seen at all and Barnard's Star saturates least. RW Aurigae: detector 1,
where the fewest of its pixels are flagged. R Draconis: detector 2, the one a typed position opens with."""
ORDER = ["eps-indi-b", "barnard", "wise0855", "rw-aur", "r-dra"]
MOVERS = ["eps-indi-b", "barnard", "wise0855"]
METHOD = {"eps-indi-b": "frames", "barnard": "frames", "wise0855": "coadd"}
"""How a mover is measured in a visit: in every frame (bright) or in the co-add of the visit (too faint for one frame)."""
SIZE = 64
SEARCH_DEG = 0.002

TOL_FILE = T.DATA / "targets" / "tolerances.json"
SPHEREX_TOL_PX = 0.5
ALLWISE_SIA = "https://irsa.ipac.caltech.edu/SIA"
ALLWISE_BAND = "W2"
ALLWISE_MID_MJD = 55400.0
ALLWISE_PIXEL = 1.375
ALLWISE_FWHM = 6.4
ALLWISE_SATURATED = ("barnard",)
WINGS_BEAMS = (2.0, 4.0)
WINGS_SKY = (10.0, 13.0)
WINGS_CUT_ARCSEC = 240
"""A star that saturates WISE has a spoiled core, so its 2010 centre is the centroid of its wings: the light between
2 and 4 beam widths from the centre, above the sky measured 10 to 13 beam widths out, in a cut 240 arcsec wide."""
BESIDE_TOL_PX = 1.0
"""The rule of review H5 for a fixed star that sits beside a target: it counts as the catalogue source if the 2010
image shows it within one SPHEREx pixel of where Gaia puts it."""
RDRA_RADIUS = 3
REFS = ["SPHEREx Level 2 spectral images, data release 1, NASA/IPAC Infrared Science Archive"]
ALLWISE_REF = "AllWISE Atlas image, band W2, NASA/IPAC Infrared Science Archive (doi:10.26131/IRSA153)"
IMG = checks.IMG_DIR


def find() -> list[str]:
    """The first answer to "which frames": IRSA's image search at each target's position, the detector of its
    showcase (every detector for R Draconis). The answer is frozen."""
    names = T.targets()
    keys: list[str] = []
    for tid, det in DET.items():
        got = irsa.sia_frames(names[tid]["ra"], names[tid]["dec"], SEARCH_DEG)
        keys += [f["key"] for f in got if tid == "r-dra" or f["det"] == det]
    return keys


# -- the 2010 image ------------------------------------------------------------------------------------


def _get(url: str, params: dict | None = None, tries: int = 5) -> bytes:
    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.get(url, params=params, timeout=180)
            if r.status_code == 200:
                return r.content
            err = RuntimeError(f"status {r.status_code}")
        except requests.RequestException as e:
            err = e
        time.sleep(3 * (k + 1))
    raise RuntimeError(f"{url} failed: {err}")


def allwise_tiles(ra: float, dec: float) -> list[dict]:
    """The AllWISE Atlas images (the science image of each band and tile) that hold a position:
    {band, tile, url, t_min, t_max, ra, dec}; the times are those of the first and last photo in the image."""
    cache = s3.cache_dir() / f"allwise_sia_{ra:.5f}_{dec:.5f}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    from astropy.io.votable import parse_single_table

    raw = _get(ALLWISE_SIA, {"COLLECTION": "wise_allwise", "POS": f"CIRCLE {ra:.6f} {dec:.6f} 0.001"})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        table = parse_single_table(io.BytesIO(raw)).to_table(use_names_over_ids=True)
    out = []
    for row in table:
        url = str(row["access_url"])
        if url.endswith("-int-3.fits"):
            out.append({"band": str(row["energy_bandpassname"]), "tile": str(row["obs_id"]), "url": url,
                        "t_min": float(row["t_min"]), "t_max": float(row["t_max"]), "ra": float(row["s_ra"]),
                        "dec": float(row["s_dec"])})
    out.sort(key=lambda t: (t["band"], t["tile"]))
    cache.write_text(json.dumps(out))
    return out


def pick_tile(tiles: list[dict], ra: float, dec: float) -> dict:
    """The tile of ALLWISE_BAND whose centre is nearest the position."""
    cand = [t for t in tiles if t["band"] == ALLWISE_BAND]
    if not cand:
        raise RuntimeError("no AllWISE image of band " + ALLWISE_BAND + " holds the position")
    return min(cand, key=lambda t: (float(np.hypot(*T.offset_arcsec(ra, dec, t["ra"], t["dec"]))), t["tile"]))


def allwise_cutout(url: str, ra: float, dec: float, size_arcsec: int):
    """(image, WCS) of a square cut of an AllWISE Atlas image, from IRSA's cutout service; cached."""
    from astropy.io import fits
    from astropy.wcs import WCS

    full = f"{url}?center={ra:.6f},{dec:.6f}&size={size_arcsec:d}arcsec&gzip=false"
    cache = s3.cache_dir() / ("allwise_" + hashlib.sha1(full.encode()).hexdigest()[:16] + ".fits")
    if not cache.exists():
        cache.write_bytes(_get(full))
    with fits.open(io.BytesIO(cache.read_bytes())) as h:
        return h[0].data.astype(np.float64), WCS(h[0].header)


# -- tolerances, written before anything is measured ----------------------------------------------------


def write_tolerances() -> int:
    if TOL_FILE.exists():
        print(f"{TOL_FILE} is already there and is not written again")
        return 1
    names = T.targets()
    movers = {}
    for tid in MOVERS:
        cat = names[tid]["catalogue"]
        ra, dec = T.predict(cat, ALLWISE_MID_MJD)
        tile = pick_tile(allwise_tiles(ra, dec), ra, dec)
        first, last = T.predict(cat, tile["t_min"]), T.predict(cat, tile["t_max"])
        half = 0.5 * float(np.hypot(*T.offset_arcsec(*first, *last)))
        sat = ALLWISE_FWHM if tid in ALLWISE_SATURATED else 0.0
        movers[tid] = {
            "allwise": {"band": ALLWISE_BAND, "tile": tile["tile"], "first_mjd": tile["t_min"], "last_mjd": tile["t_max"]},
            "allwise_half_spread_arcsec": round(half, 3),
            "allwise_saturated_arcsec": sat,
            "position_px": SPHEREX_TOL_PX,
            "shift_arcsec": round(SPHEREX_TOL_PX * T.PX_ARCSEC + half + sat, 3),
        }
    doc = {
        "about": "Tolerances and pass rules of the checks on the five targets. Written from the catalogue values in "
                 "names.json and the dates of the 2010 images alone, before the jobs measured any position or brightness. "
                 "One term was chosen with a result in hand: a trial measurement had put the 2010 centre of Barnard's "
                 "Star about 6 arcsec from the catalogue, and the beam width added for a star that saturates WISE was "
                 "set knowing it. The jobs read this file and never write it.",
        "written_on": time.strftime("%Y-%m-%d"),
        "pixel_arcsec": T.PX_ARCSEC,
        "movers": {
            "rule": "The shift from the 2010 image to SPHEREx's latest visit, measured, differs from the shift the "
                    "catalogue gives by at most shift_arcsec. shift_arcsec = half a SPHEREx pixel, plus half the distance "
                    "the catalogue moves the object between the first and the last photo of the 2010 image (that image is "
                    "a mean over about six months, and the object moved meanwhile), plus one beam width of WISE (6.4 "
                    "arcsec in W2) for a star that saturates WISE, whose centre is known only from the wings of its image. "
                    "The position in SPHEREx alone lies within position_px of the catalogue position at that date.",
            "saturates_wise": {"barnard": "Barnard's Star is near magnitude 4.5 at 2 µm (2MASS); the W2 band of WISE "
                                          "saturates near magnitude 7 (Explanatory Supplement to the AllWISE Data Release Products, section II.2)."},
            **movers,
        },
        "motion": {
            "rule": "Motion within SPHEREx's own year is shown for a target if its measured shift between two visits is "
                    "at least nonzero_sigma times its error away from zero, and each of its two components (east, north) "
                    "is within within_sigma times its error of the catalogue shift, parallax included. The error is the "
                    "target's own, with the scatter of the field stars' shifts between the same visits added in "
                    "quadrature. Epsilon Indi B: first against last deep visit of detector 6. WISE 0855: the co-adds of "
                    "November 2025 and April to May 2026 of detector 6; May 2025 is left out.",
            "nonzero_sigma": 3, "within_sigma": 3,
        },
        "rw-aur": {
            "rule": "A colour band shows RW Aurigae's change if the sign of the change is the same with the common mask "
                    "as without it, and the comparison stars of that band, measured with the same mask, have a median "
                    "ratio within comparison_median_pct of 1.",
            "comparison_median_pct": 1.0,
            "reference_before_masking_pct": [26.8, 40.7, 9.0, -8.8, -15.2, -29.1],
        },
        "r-dra": {
            "rule": "A frame is saturated at the star when at least one pixel within radius_px pixels of its position "
                    "carries one of the flags OVERFLOW, NONLINEAR or BLOOM.",
            "radius_px": RDRA_RADIUS,
        },
    }
    checks.write_json(TOL_FILE, doc)
    print(f"wrote {TOL_FILE}")
    for tid, m in movers.items():
        print(f"  {tid}: 2010 image {m['allwise']['tile']} ({T.day_of(m['allwise']['first_mjd'])} to "
              f"{T.day_of(m['allwise']['last_mjd'])}), half spread {m['allwise_half_spread_arcsec']} arcsec, "
              f"tolerance of the shift {m['shift_arcsec']} arcsec")
    return 0


def tolerances() -> dict:
    if not TOL_FILE.exists():
        raise SystemExit(f"{TOL_FILE} is missing: run `python -m sx.run targets --tolerances` first, and keep that file")
    return json.loads(TOL_FILE.read_text(encoding="utf-8"))


# -- showcases -----------------------------------------------------------------------------------------


def matchables(frames: list[dict], ra: float, dec: float) -> list[dict]:
    """What the match rule reads from each frame at a position: detector, colour and bandwidth at the target pixel,
    and the rows its stamp would take (the rule skips stamps that reach the unused rows of detectors 1 and 2)."""
    out = []
    for f in frames:
        px, py = T.pixel_of(f["key"], ra, dec) or (math.nan, math.nan)
        if not np.isfinite(px):
            continue
        wb = wave.wavelength_at(f["det"], px, py)
        out.append({"key": f["key"], "det": f["det"], "lam": wb["lam"], "bw": wb["bw"], "tmid": f["tmid"],
                    "y0": stamp_origin(px, py, SIZE, SIZE)[1], "h": SIZE})
    return out


def pair_visits(frames: list[dict], det: int):
    """(visit table, the two visits the visit rule compares, as positions in the table)."""
    vt = T.visit_table(frames, det)
    pair = visits.default_pair(vt)
    if pair is None:
        raise RuntimeError(f"detector {det}: fewer than two visits that are not short")
    return vt, pair


def build_showcase(tid: str, entry: dict, frames: list[dict], number_keys: list[str], refs: list[str]) -> dict:
    """Write the showcase of one target and return what the rest of the job needs from it."""
    det = DET[tid]
    ra, dec = entry["ra"], entry["dec"]
    vt, (ia, ib) = pair_visits(frames, det)
    a, b = matchables(vt[ia]["frames"], ra, dec), matchables(vt[ib]["frames"], ra, dec)
    pairs = match.match_pairs(a, b)
    if not pairs:
        raise RuntimeError(f"{tid}: no pair of frames at the same colour")
    stamps, vis, pp = [], [], []
    for i, j in pairs:
        sa, sb = T.stamp_at(a[i]["key"], ra, dec, SIZE), T.stamp_at(b[j]["key"], ra, dec, SIZE)
        pp.append((len(stamps), len(stamps) + 1))
        stamps += [sa, sb]
        vis += [0, 1]
    both = np.concatenate([stamps[0].data.ravel(), stamps[1].data.ravel()])
    both = both[np.isfinite(both)]
    black, white = (float(v) for v in np.percentile(both, [0.5, 99.5]))
    folder = T.DATA / "targets" / tid
    manifest = render.write_showcase(folder, tid, entry["name"], ra, dec, stamps, vis, pp, refs=refs,
                                     numbers=number_keys, with_flags=True, preview=(black, white))
    lam = [f["lam"] for f in manifest["frames"]]
    return {"manifest": manifest, "visits": vt, "pair": (ia, ib), "stamps": stamps, "pairs": pp, "black": black,
            "white": white, "lam": (min(lam), max(lam)),
            "worst": max(abs(a[i]["lam"] - b[j]["lam"]) / min(a[i]["bw"], b[j]["bw"]) for i, j in pairs)}


# -- the movers ----------------------------------------------------------------------------------------


def measure_spherex(tid: str, entry: dict, visit_frames: list[dict]) -> dict:
    """Where a mover is in one visit: {ra, dec, cat_ra, cat_dec, dE, dN, eE, eN, n, mjd, method}; dE and dN are the
    measured position minus the catalogue position, arcsec."""
    cat = entry["catalogue"]
    if METHOD[tid] == "frames":
        rows = T.mover_frames(visit_frames, cat, entry["ra"], entry["dec"])
        v = T.visit_position(rows)
        if v is None:
            raise RuntimeError(f"{tid}: fewer than 3 frames could be measured")
        cra, cdec = T.predict(cat, v["mjd"])
        east, north = v["dE"], v["dN"]
        # the measured position: the catalogue position at the mean time, moved by the mean offset
        ra = cra + east / 3600.0 / math.cos(math.radians(cdec))
        dec = cdec + north / 3600.0
        return {**v, "ra": ra, "dec": dec, "cat_ra": cra, "cat_dec": cdec, "method": "mean of the positions in each photo",
                "snr": float(np.median([r["snr"] for r in rows])), "neighbours": []}
    c = T.mover_coadd(visit_frames, cat, entry["ra"], entry["dec"])
    if c is None or not c.get("measured"):
        raise RuntimeError(f"{tid}: the co-add of the visit could not be measured")
    return {**{k: c[k] for k in ("dE", "dN", "eE", "eN", "n", "frames", "mjd", "ra", "dec", "cat_ra", "cat_dec", "snr",
                                 "neighbours")}, "method": "position in the co-add of the visit"}


def median_image(visit_frames: list[dict], entry: dict, grid, n: int, width: int = 192) -> np.ndarray:
    """The picture of a visit for a card: every frame, its background subtracted, read on a sky grid (north up);
    each pixel is the median over the frames. Flags are not applied: the median drops what one frame alone shows."""
    yy, xx = np.mgrid[:n, :n].astype(float)
    gra, gdec = grid.all_pix2world(xx, yy, 0)

    def one(f: dict):
        st = T.stamp_at(f["key"], entry["ra"], entry["dec"], SIZE)
        if st is None:
            return None
        stats = stack.stamp_stats(st.data, st.flags)
        if stats["n"] == 0:
            return None
        box = T.Box(st, width)
        fx, fy = sky_to_pixel(T.frame(f["key"]).wcs, gra, gdec)
        data, _ = stack.resample(box.data.astype(np.float64) - stats["background"], fx - box.x0, fy - box.y0,
                                 np.isfinite(box.data))
        return data

    planes = [p for p in s3.map_threads(one, visit_frames) if p is not None]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmedian(np.array(planes), axis=0)


def display_range(img: np.ndarray) -> tuple[float, float]:
    """Black and white points of a card picture: two noise widths below the median, and the 99.7th percentile (at
    least ten noise widths above the median)."""
    v = img[np.isfinite(img)]
    med = float(np.median(v))
    noise = stack.robust_noise(v) or 1e-9
    return med - 2 * noise, max(float(np.percentile(v, 99.7)), med + 10 * noise)


def uv(grid, n: int, ra: float, dec: float) -> dict:
    """A sky position as fractions of a picture drawn north up: u from the left edge, v from the top edge."""
    x, y = (float(q) for q in grid.all_world2pix(ra, dec, 0))
    return {"u": round((x + 0.5) / n, 5), "v": round(1 - (y + 0.5) / n, 5)}


def do_mover(tid: str, entry: dict, frames: list[dict], show: dict, tol: dict) -> dict:
    cat = entry["catalogue"]
    vt, (ia, ib) = show["visits"], show["pair"]
    sp = measure_spherex(tid, entry, vt[ib]["frames"])

    # the 2010 image
    aw = tol["allwise"]
    ra10, dec10 = T.predict(cat, ALLWISE_MID_MJD)
    tile = next((t for t in allwise_tiles(ra10, dec10) if t["band"] == aw["band"] and t["tile"] == aw["tile"]), None)
    if tile is None:
        raise RuntimeError(f"{tid}: the 2010 image named in the tolerances is not in the archive's answer")
    first, last = T.predict(cat, tile["t_min"]), T.predict(cat, tile["t_max"])
    wra, wdec = 0.5 * (first[0] + last[0]), 0.5 * (first[1] + last[1])
    jump = float(np.hypot(*T.offset_arcsec(wra, wdec, sp["cat_ra"], sp["cat_dec"])))
    mra, mdec = 0.5 * (wra + sp["cat_ra"]), 0.5 * (wdec + sp["cat_dec"])
    half = max(100.0, jump / 2 + 40.0)
    img, ww = allwise_cutout(tile["url"], mra, mdec, int(math.ceil(2 * half / 10.0) * 10 + 40))
    x, y = (float(v) for v in ww.all_world2pix(wra, wdec, 0))
    g = T.fit_gauss(img, x, y, search=4.0, half=5, sigma0=ALLWISE_FWHM / 2.355 / ALLWISE_PIXEL)
    if g is None:
        raise RuntimeError(f"{tid}: nothing to fit in the 2010 image at the catalogue position")
    gra, gdec = (float(v) for v in ww.all_pix2world(g["x"], g["y"], 0))
    core = None
    if tol["allwise_saturated_arcsec"] > 0:
        # a star that saturates WISE: the fit above sits on the spoiled core. Its centre is that of its wings, taken in
        # a cut of the image centred on the star and started from the fit, so that the catalogue plays no part in it
        core = [float(v) for v in T.offset_arcsec(wra, wdec, gra, gdec)]
        wide, w2 = allwise_cutout(tile["url"], wra, wdec, WINGS_CUT_ARCSEC)
        beam = ALLWISE_FWHM / ALLWISE_PIXEL
        c = T.wings_centre(wide, *(float(v) for v in w2.all_world2pix(gra, gdec, 0)), WINGS_BEAMS[0] * beam,
                           WINGS_BEAMS[1] * beam, (WINGS_SKY[0] * beam, WINGS_SKY[1] * beam))
        if c is None:
            raise RuntimeError(f"{tid}: the centre of the wings of the 2010 image did not settle")
        gra, gdec = (float(v) for v in w2.all_pix2world(c[0], c[1], 0))
    w_off = T.offset_arcsec(wra, wdec, gra, gdec)

    # the shift, measured and by the catalogue
    m_e, m_n = (float(v) for v in T.offset_arcsec(gra, gdec, sp["ra"], sp["dec"]))
    c_e, c_n = (float(v) for v in T.offset_arcsec(wra, wdec, sp["cat_ra"], sp["cat_dec"]))
    diff = math.hypot(m_e - c_e, m_n - c_n)
    years = (sp["mjd"] - 0.5 * (tile["t_min"] + tile["t_max"])) / 365.25
    off_px = math.hypot(sp["dE"], sp["dN"]) / T.PX_ARCSEC
    res = {
        "id": tid, "name": entry["name"], "spherex": sp, "tile": tile, "years": years,
        "wise": {"ra": gra, "dec": gdec, "cat_ra": wra, "cat_dec": wdec, "dE": float(w_off[0]), "dN": float(w_off[1]),
                 "amp": g["amp"], "sigma_arcsec": g["sigma"] * ALLWISE_PIXEL, "core": core},
        "measured": math.hypot(m_e, m_n), "catalogue": math.hypot(c_e, c_n), "m_en": (m_e, m_n), "c_en": (c_e, c_n),
        "diff": diff, "tol": tol["shift_arcsec"], "tol_beam": tol["allwise_saturated_arcsec"], "off_px": off_px,
        "tol_px": tol["position_px"],
        "ok_shift": diff <= tol["shift_arcsec"], "ok_position": off_px <= tol["position_px"],
    }

    # a star that sits beside the object in SPHEREx's photos: in 2010 the object was elsewhere, so what the 2010
    # image shows at that place is the star alone. Is it where Gaia puts it?
    mid = 0.5 * (tile["t_min"] + tile["t_max"])
    res["beside"] = []
    for o in sp["neighbours"]:
        then = next((q for q in T.neighbours_of(o["ra"], o["dec"], mid, radius_arcsec=3.0) if q["source_id"] == o["source_id"]), None)
        if then is None:
            continue
        sx_, sy_ = (float(v) for v in ww.all_world2pix(then["ra"], then["dec"], 0))
        gs = T.fit_gauss(img, sx_, sy_, search=2.0, half=4, sigma0=ALLWISE_FWHM / 2.355 / ALLWISE_PIXEL)
        if gs is None:
            res["beside"].append({**o, "seen": False})
            continue
        s_off = T.offset_arcsec(then["ra"], then["dec"], *(float(v) for v in ww.all_pix2world(gs["x"], gs["y"], 0)))
        away = float(np.hypot(*T.offset_arcsec(then["ra"], then["dec"], wra, wdec)))
        res["beside"].append({**o, "seen": True, "off_arcsec": float(np.hypot(*s_off)), "object_away_2010": away,
                              "snr": gs["amp"] / (stack.robust_noise(img[np.isfinite(img)] - np.nanmedian(img)) or math.inf)})
    res["ok_beside"] = all(b["seen"] and b["off_arcsec"] <= BESIDE_TOL_PX * T.PX_ARCSEC for b in res["beside"])

    # the two pictures of the card, on one sky grid
    ns = 2 * int(math.ceil(half / T.PX_ARCSEC)) + 1
    sgrid, n = T.sky_grid(mra, mdec, ns), 3 * ns
    pgrid = T.sky_grid(mra, mdec, n, T.PX_ARCSEC / 3)
    sp_img = np.kron(median_image(vt[ib]["frames"], entry, sgrid, ns), np.ones((3, 3)))
    yy, xx = np.mgrid[:n, :n].astype(float)
    pra, pdec = pgrid.all_pix2world(xx, yy, 0)
    wx, wy = ww.all_world2pix(pra, pdec, 0)
    w_img, _ = stack.resample(img, wx, wy)
    filled = []
    for other in allwise_tiles(ra10, dec10):
        # the picture only: where the tile that is measured ends, a neighbouring tile of the same band fills in
        if other["band"] == aw["band"] and other["tile"] != tile["tile"] and np.isnan(w_img).any():
            img2, ww2 = allwise_cutout(other["url"], mra, mdec, int(math.ceil(2 * half / 10.0) * 10 + 40))
            more, _ = stack.resample(img2, *ww2.all_world2pix(pra, pdec, 0))
            both = np.isfinite(w_img) & np.isfinite(more)
            if both.sum() > 100:  # the two tiles have their own zero levels
                more = more + float(np.median(w_img[both] - more[both]))
            if (np.isnan(w_img) & np.isfinite(more)).any():
                w_img = np.where(np.isnan(w_img), more, w_img).astype(np.float32)
                filled.append(other["tile"])
    folder = T.DATA / "targets" / tid
    wb, sb = display_range(w_img), display_range(sp_img)
    render.asinh_png(folder / "wise2010.png", w_img, *wb, scale=2)
    render.asinh_png(folder / "spherex.png", sp_img, *sb, scale=2)
    tiles = [np.repeat(np.repeat(render.to_rgb(d, *r), 2, axis=0), 2, axis=1) for d, r in ((w_img, wb), (sp_img, sb))]
    gap = np.full((tiles[0].shape[0], 6, 3), 255, np.uint8)
    (folder / "jump.png").write_bytes(render.png_bytes(np.concatenate([tiles[0], gap, tiles[1]], axis=1)))
    tt = np.linspace(tile["t_min"], sp["mjd"], 60)
    tra, tdec = T.predict(cat, tt)
    res["pictures"] = {"w_img": w_img, "sp_img": sp_img, "wb": wb, "sb": sb, "grid": pgrid, "n": n}
    res["jump"] = {
        "picture": "jump.png",
        "panels": [
            {"file": "wise2010.png", "label": "WISE, 2010",
             "what": f"AllWISE Atlas image, band {aw['band']} (4.6 µm), tile {tile['tile']}: a mean of photos taken from "
                     f"{T.day_of(tile['t_min'])} to {T.day_of(tile['t_max'])}"
                     + (f"; beyond the edge of that tile the picture shows tile {' and '.join(filled)}" if filled else ""),
             "year": round(T.year_of(0.5 * (tile["t_min"] + tile["t_max"])), 3)},
            {"file": "spherex.png", "label": f"SPHEREx, {T.month_of(sp['mjd'])}",
             "what": f"median of the {vt[ib]['n']} photos of detector {DET[tid]} taken from {T.day_of(vt[ib]['first'])} to "
                     f"{T.day_of(vt[ib]['last'])}, drawn on the same sky grid",
             "year": round(T.year_of(sp["mjd"]), 3)},
        ],
        "north": "up", "east": "left", "arcsec_per_pixel": round(T.PX_ARCSEC / 3, 4), "pixels": n, "resampled": True,
        "catalogue": [uv(pgrid, n, wra, wdec), uv(pgrid, n, sp["cat_ra"], sp["cat_dec"])],
        "measured": [uv(pgrid, n, gra, gdec), uv(pgrid, n, sp["ra"], sp["dec"])],
        "track": [uv(pgrid, n, float(a), float(d)) for a, d in zip(tra, tdec)],
        "neighbours": [{"source": f"Gaia DR3 {o['source_id']}", "g_mag": round(o["G"], 2), **uv(pgrid, n, o["ra"], o["dec"]),
                        "arcsec_from_target": round(o["sep_arcsec"], 1)} for o in sp["neighbours"]],
    }
    return res


def mover_numbers(r: dict) -> dict:
    t, k = r["id"], "K5"
    sp, tile = r["spherex"], r["tile"]
    e = numbers.entry
    return {
        f"targets.{t}.shift.measured": e(r["measured"], 1, unit="arcsec", check=k),
        f"targets.{t}.shift.catalogue": e(r["catalogue"], 1, unit="arcsec", check=k),
        f"targets.{t}.shift.pixels": e(r["measured"] / T.PX_ARCSEC, 0, unit="pixels", check=k),
        f"targets.{t}.shift.diff": e(r["diff"], 1, unit="arcsec", check=k),
        f"targets.{t}.shift.diff_px": e(r["diff"] / T.PX_ARCSEC, 2, unit="pixels", check=k),
        f"targets.{t}.shift.tolerance": e(r["tol"], 1, unit="arcsec", check=k),
        f"targets.{t}.shift.years": e(r["years"], 1, unit="years", check=k),
        f"targets.{t}.speed.measured": e(r["measured"] / r["years"], 2, unit="arcsec per year", check=k),
        f"targets.{t}.position.off_px": e(r["off_px"], 2, unit="pixels", check=k),
        f"targets.{t}.position.tolerance_px": e(r["tol_px"], 1, unit="pixels", check=k),
        f"targets.{t}.spherex.photos": e(sp.get("frames", sp["n"]), 0, check=k),
        f"targets.{t}.spherex.month": e(sp["mjd"], shown=T.month_of(sp["mjd"]), check=k),
        f"targets.{t}.wise.first": e(tile["t_min"], shown=T.month_of(tile["t_min"]), check=k),
        f"targets.{t}.wise.last": e(tile["t_max"], shown=T.month_of(tile["t_max"]), check=k),
        **({f"targets.{t}.beside.away": e(b["sep_arcsec"], 1, unit="arcsec", check=k),
            f"targets.{t}.beside.off": e(b["off_arcsec"], 1, unit="arcsec", check=k),
            f"targets.{t}.beside.off_px": e(b["off_arcsec"] / T.PX_ARCSEC, 2, unit="pixels", check=k)}
           if (b := next((q for q in r["beside"] if q["seen"]), None)) else {}),
    }


def beside_note(movers: dict) -> str:
    """The fixed star beside a target, said plainly: which catalogue source it is and how that was checked."""
    out = []
    for r in movers.values():
        for b in r["beside"]:
            head = (f"Beside {r['name']} lies the star Gaia DR3 {b['source_id']} (G {b['G']:.1f}), {b['sep_arcsec']:.1f} arcsec from "
                    f"it at the date of the SPHEREx visit; it does not move and is fitted together with the target. ")
            if b["seen"]:
                out.append(head + f"In the 2010 image the target was {b['object_away_2010']:.0f} arcsec away, and what that image "
                           f"shows at the star's place lies {b['off_arcsec']:.2f} arcsec ({b['off_arcsec'] / T.PX_ARCSEC:.2f} of a "
                           f"SPHEREx pixel) from the star's Gaia position at that date (rule of the review: within "
                           f"{BESIDE_TOL_PX:g} pixel).")
            else:
                out.append(head + "The 2010 image shows nothing that can be measured at the star's place.")
    return " ".join(out)


def beam_note(movers: dict) -> str:
    """What the beam width in a tolerance decides, said plainly: for each star that saturates WISE, whether its
    difference would be within the tolerance without that term."""
    out = []
    for r in movers.values():
        if r["tol_beam"] > 0:
            w, bare = r["wise"], r["tol"] - r["tol_beam"]
            out.append(
                f"{r['name']} saturates WISE: the core of its 2010 image is spoiled, and a Gaussian fitted there lands "
                f"{math.hypot(*w['core']):.1f} arcsec from the catalogue, on the brighter side of the core. That value is not "
                f"used. Its 2010 centre is the centroid of the wings of its image ({WINGS_BEAMS[0]:g} to {WINGS_BEAMS[1]:g} beam "
                f"widths out, started from the fit and repeated until it settles), {math.hypot(w['dE'], w['dN']):.1f} arcsec "
                f"from the catalogue. The WISE beam in its tolerance ({r['tol_beam']:g} arcsec) was set when only the first "
                f"value was known; without it the tolerance would be {bare:.1f} arcsec and the difference of {r['diff']:.1f} "
                f"arcsec would be {'within it all the same' if r['diff'] <= bare else 'outside it'}.")
    return " ".join(out)


# -- R Draconis ----------------------------------------------------------------------------------------


def rdra_census(entry: dict, frames: list[dict]) -> dict:
    """For every frame that holds R Draconis: does a pixel within RDRA_RADIUS pixels of it carry a saturation flag?"""
    half = RDRA_RADIUS

    def one(f: dict):
        ff = T.frame(f["key"])
        px, py = T.pixel_of(f["key"], entry["ra"], entry["dec"])
        _, y0 = stamp_origin(px, py, 2 * half + 1, 2 * half + 1)
        rows = ff.flag_rows(y0, y0 + 2 * half + 1)
        ya = max(0, y0)
        yy, xx = np.mgrid[ya : ya + rows.shape[0], : ff.nx]
        near = np.hypot(xx - px, yy - py) <= half
        n = int(((rows & T.SAT_MASK) != 0)[near].sum())
        return {"key": f["key"], "det": f["det"], "mjd": f["tmid"], "n_sat": n, "n_px": int(near.sum())}

    rows = s3.map_threads(one, frames)
    by_det = {d: [r for r in rows if r["det"] == d] for d in range(1, 7)}
    return {"rows": rows, "n": len(rows), "saturated": sum(r["n_sat"] > 0 for r in rows),
            "clear": [r["key"] for r in rows if r["n_sat"] == 0],
            "by_det": {d: (len(v), sum(r["n_sat"] > 0 for r in v), float(np.median([r["n_sat"] for r in v])) if v else math.nan)
                       for d, v in by_det.items()},
            "first": min(r["mjd"] for r in rows), "last": max(r["mjd"] for r in rows)}


# -- pictures for the Checks rows and the sheet --------------------------------------------------------


def _show(ax, img, rng, title):
    cmap = plt.get_cmap("gray").copy()
    cmap.set_bad("#2e2650")
    ax.imshow(np.ma.masked_invalid(render.stretch(img, *rng)), origin="lower", cmap=cmap, vmin=0, vmax=1, interpolation="nearest")
    ax.set_title(title, fontsize=8)
    ax.set_xticks([])
    ax.set_yticks([])


def draw_mover(axw, axs, axt, r: dict) -> None:
    p, j = r["pictures"], r["jump"]
    n = p["n"]
    for ax, img, rng, panel in ((axw, p["w_img"], p["wb"], j["panels"][0]), (axs, p["sp_img"], p["sb"], j["panels"][1])):
        _show(ax, img, rng, f"{r['name']}: {panel['label']}")
        ax.plot([q["u"] * n - 0.5 for q in j["track"]], [(1 - q["v"]) * n - 0.5 for q in j["track"]], color=T.ORANGE, lw=0.8)
        for q, c in zip(j["catalogue"], ("#4fc3f7", "#ffd54f")):
            ax.plot(q["u"] * n - 0.5, (1 - q["v"]) * n - 0.5, "o", mfc="none", mec=c, ms=13, mew=1.1)
        for q, c in zip(j["measured"], ("#4fc3f7", "#ffd54f")):
            ax.plot(q["u"] * n - 0.5, (1 - q["v"]) * n - 0.5, "+", color=c, ms=9, mew=1.1)
        for q in j["neighbours"]:
            ax.plot(q["u"] * n - 0.5, (1 - q["v"]) * n - 0.5, "s", mfc="none", mec="#81c784", ms=8, mew=0.9)
    sp = r["spherex"]
    lines = [
        f"{r['name']}",
        f"2010 to {T.month_of(sp['mjd'])} ({r['years']:.1f} years)",
        f"measured shift   {r['measured']:.1f} arcsec ({r['measured'] / T.PX_ARCSEC:.1f} px)",
        f"catalogue shift  {r['catalogue']:.1f} arcsec",
        f"difference       {r['diff']:.1f} arcsec ({r['diff'] / T.PX_ARCSEC:.2f} px)",
        f"tolerance        {r['tol']:.1f} arcsec: {'within' if r['ok_shift'] else 'OUTSIDE'}",
        f"in SPHEREx alone {r['off_px']:.2f} px from the catalogue",
        f"  (tolerance {r['tol_px']:.1f} px: {'within' if r['ok_position'] else 'OUTSIDE'})",
        f"SPHEREx: {sp['method']},",
        f"  {sp['n']} photos" + (f" of {sp['frames']}" if sp.get("frames", sp["n"]) != sp["n"] else ""),
    ]
    for b in r["beside"][:2]:
        lines.append(f"star beside it: Gaia G {b['G']:.1f} at {b['sep_arcsec']:.1f} arcsec;")
        lines.append(f"  in 2010 {b['off_arcsec'] / T.PX_ARCSEC:.2f} px from Gaia" if b["seen"] else "  not seen in 2010")
    if r["wise"]["core"]:
        w = r["wise"]
        lines += ["2010: saturated in WISE; centre of the",
                  f"  wings, {math.hypot(w['dE'], w['dN']):.1f} arcsec from the catalogue",
                  f"  (a Gaussian on the core: {math.hypot(*w['core']):.1f} arcsec,", "  not used)"]
    axt.axis("off")
    axt.text(0, 0.98, "\n".join(lines), va="top", ha="left", fontsize=8, family="monospace", color=T.INK)


def legend_text() -> str:
    return ("rings: where the catalogue puts the object (blue 2010, yellow SPHEREx); crosses: where it was measured;\n"
            "orange line: the catalogue track; green squares: Gaia stars fitted beside a faint target. North up, east left.")


def draw_pair(axa, axb, show: dict, name: str, mark_saturation: bool) -> None:
    for ax, k, lab in ((axa, 0, "earlier visit"), (axb, 1, "later visit")):
        st = show["stamps"][show["pairs"][0][k]]
        g = T.north_up(st, st.w)  # as the showcase shows it
        _show(ax, g.data, (show["black"], show["white"]), f"{name}: {lab}, {T.day_of(st.mjd)}, {st.lam:.3f} µm")
        if mark_saturation:
            sat = (g.flags & T.SAT_MASK) != 0
            yy, xx = np.nonzero(sat)
            ax.plot(xx, yy, "s", mfc="none", mec=T.ORANGE, ms=2.5, mew=0.5)
        ax.plot(g.tx, g.ty, "o", mfc="none", mec="#ffd54f", ms=14, mew=0.9)


# -- the job -------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if "--tolerances" in argv:
        return write_tolerances()
    reviewer = T.reviewer_from(argv)
    tol = tolerances()
    names = T.targets()
    keys = frozen.frames_for(JOB, find)
    held = T.frames_holding(keys, {t: (names[t]["ra"], names[t]["dec"]) for t in ORDER})
    print({t: len(v) for t, v in held.items()}, "frames in the frozen list")

    shows, movers, entries = {}, {}, {}
    for tid in ORDER:
        e = names[tid]
        det_frames = [f for f in held[tid] if f["det"] == DET[tid]]
        refs = list(REFS)
        if "catalogue" in e:
            refs.append(e["catalogue"]["source"])
        if tid in MOVERS:
            refs.append(ALLWISE_REF)
        keys_n = [f"targets.{tid}.pairs", f"targets.{tid}.detector"]
        shows[tid] = s = build_showcase(tid, e, det_frames, keys_n, refs)
        vt, (ia, ib) = s["visits"], s["pair"]
        entries[f"targets.{tid}.pairs"] = numbers.entry(len(s["pairs"]), 0, check=None)
        entries[f"targets.{tid}.detector"] = numbers.entry(DET[tid], 0, check=None)
        print(f"{tid}: detector {DET[tid]}, visits {T.day_of(vt[ia]['first'])}..{T.day_of(vt[ia]['last'])} ({vt[ia]['n']}) and "
              f"{T.day_of(vt[ib]['first'])}..{T.day_of(vt[ib]['last'])} ({vt[ib]['n']}), {len(s['pairs'])} pairs, "
              f"{s['lam'][0]:.3f} to {s['lam'][1]:.3f} um, worst pair at {s['worst']:.2f} of a bandwidth")

    for tid in MOVERS:
        movers[tid] = r = do_mover(tid, names[tid], held[tid], shows[tid], tol["movers"][tid])
        entries.update(mover_numbers(r))
        sp, w = r["spherex"], r["wise"]
        print(f"{tid}: 2010 image {r['tile']['tile']}, measured minus catalogue ({w['dE']:+.2f}, {w['dN']:+.2f}) arcsec; "
              f"SPHEREx {T.month_of(sp['mjd'])} ({sp['method']}, {sp['n']} photos) measured minus catalogue "
              f"({sp['dE']:+.2f} +- {sp['eE']:.2f}, {sp['dN']:+.2f} +- {sp['eN']:.2f}) arcsec = {r['off_px']:.2f} px; shift measured "
              f"{r['measured']:.2f}, catalogue {r['catalogue']:.2f}, difference {r['diff']:.2f} arcsec "
              f"({r['diff'] / T.PX_ARCSEC:.2f} px), tolerance {r['tol']:.2f}: {'within' if r['ok_shift'] else 'OUTSIDE'}")

    census = rdra_census(names["r-dra"], held["r-dra"])
    print(f"r-dra: {census['saturated']} of {census['n']} frames saturated at the star; per detector (frames, saturated, "
          f"median flagged pixels): {census['by_det']}")
    entries["targets.r-dra.frames"] = numbers.entry(census["n"], 0, check="K6-rdra")
    entries["targets.r-dra.saturated"] = numbers.entry(census["saturated"], 0, check="K6-rdra")
    numbers.write(T.PRODUCER, entries)

    # pictures
    fig, axs = plt.subplots(3, 3, figsize=(10.5, 10.2), gridspec_kw={"width_ratios": [1, 1, 0.95]})
    for row, tid in zip(axs, MOVERS):
        draw_mover(*row, movers[tid])
    fig.text(0.01, 0.005, legend_text(), fontsize=7.5, color=T.INK)
    fig.tight_layout(rect=(0, 0.035, 1, 1))
    img_k5 = T.save_figure(fig, IMG / "k5-movers.png")

    fig, axs = plt.subplots(1, 3, figsize=(10.5, 3.7), gridspec_kw={"width_ratios": [1, 1, 0.95]})
    draw_pair(axs[0], axs[1], shows["r-dra"], names["r-dra"]["name"], True)
    axs[2].axis("off")
    axs[2].text(0, 0.98, "\n".join(
        [f"R Draconis: {census['saturated']} of {census['n']} photos saturated", "at the star (a saturation flag within",
         f"{RDRA_RADIUS} pixels of it).", "", "detector: photos, saturated,", "  median flagged pixels"]
        + [f"  {d}: {v[0]:3d}, {v[1]:3d}, {v[2]:.0f}" for d, v in census["by_det"].items()]
        + ["", "orange squares: pixels with a", "saturation flag"]), va="top", fontsize=8, family="monospace", color=T.INK)
    fig.tight_layout()
    img_rdra = T.save_figure(fig, IMG / "k6-rdra.png")

    fig, axs = plt.subplots(5, 3, figsize=(10.5, 17.2), gridspec_kw={"width_ratios": [1, 1, 0.95]})
    for row, tid in zip(axs, MOVERS):
        draw_mover(*row, movers[tid])
    for row, tid in zip(axs[3:], ("rw-aur", "r-dra")):
        draw_pair(row[0], row[1], shows[tid], names[tid]["name"], True)
        row[2].axis("off")
    s = shows["rw-aur"]
    axs[3][2].text(0, 0.98, "\n".join(
        ["RW Aurigae", f"detector {DET['rw-aur']}, {len(s['pairs'])} pairs at the same colour", "",
         "Its change per colour is measured", "by the job rwaur and reviewed on", "sheet H6. No number here.", "",
         "orange squares: pixels with a", "saturation flag"]), va="top", fontsize=8, family="monospace", color=T.INK)
    axs[4][2].text(0, 0.98, "\n".join(
        ["R Draconis", f"saturated in {census['saturated']} of {census['n']}", "photos checked", "",
         "verdict: too bright to measure", "No brightness is given."]), va="top", fontsize=8, family="monospace", color=T.INK)
    fig.text(0.01, 0.003, legend_text(), fontsize=7.5, color=T.INK)
    fig.tight_layout(rect=(0, 0.02, 1, 1))
    sheet = T.save_figure(fig, T.REVIEW / "h5.png")

    # rows
    ok = all(r["ok_shift"] and r["ok_position"] and r["ok_beside"] for r in movers.values())
    status = ("PASS" if reviewer else "UNVERIFIED") if ok else "FAIL"
    label = {t: names[t]["name"] for t in ORDER}
    k5 = checks.row(
        "K5", "Three moving targets land where their catalogues say",
        "From the image the WISE telescope took in 2010 to SPHEREx's latest visit, Epsilon Indi B, Barnard's Star and "
        "WISE 0855-0714 moved across the sky by the amount their catalogue astrometry gives.",
        f"The 2010 position is the centre of a Gaussian fitted in the AllWISE Atlas image of band {ALLWISE_BAND} (for a "
        "star that saturates WISE, the centroid of the wings of its image); the "
        "SPHEREx position is the mean over the photos of the latest deep visit of detector 6 (the two stars) or the "
        "centre in the co-add of that visit (WISE 0855, too faint for one photo; a Gaia star beside it is fitted with it). "
        "The catalogue position is Gaia DR3 for the two stars and the astrometry of Kirkpatrick et al. 2021 as served by "
        "SIMBAD for WISE 0855 (not in Gaia; the paper itself was not opened), moved to each date with proper motion and "
        "parallax. Position only: no brightness is produced for Barnard's Star or WISE 0855. " + beside_note(movers),
        "Each measured shift differs from the catalogue shift by at most the tolerance in site/data/targets/tolerances.json "
        "(written before the jobs measured: half a SPHEREx pixel, plus half of what the object moved while the 2010 image was "
        "taken, plus one WISE beam for a star that saturates WISE), and each SPHEREx position lies within half a pixel of "
        "the catalogue position at that date. A fixed star beside a target is seen in the 2010 image within one SPHEREx "
        "pixel of its Gaia position. " + beam_note(movers),
        status, "position checked against the catalogue",
        "; ".join(f"{label[t]} {movers[t]['diff']:.1f} arcsec ({movers[t]['off_px']:.2f} px in SPHEREx alone)" for t in MOVERS),
        "difference between measured and catalogue shift",
        "; ".join(f"{label[t]} {movers[t]['catalogue']:.1f} arcsec in {movers[t]['years']:.1f} years" for t in MOVERS),
        "; ".join(f"{label[t]} {movers[t]['tol']:.1f} arcsec" for t in MOVERS) + f"; {SPHEREX_TOL_PX} px in SPHEREx alone",
        checks.image_ref(img_k5), reviewer[0] if reviewer else None, reviewer[1] if reviewer else None,
        "python -m sx.run targets")
    all_sat = census["saturated"] == census["n"]
    rdra = checks.row(
        "K6-rdra", "R Draconis is too bright to measure",
        "R Draconis is saturated in every SPHEREx photo of this release that holds it, so the tool gives no brightness for it.",
        f"Every photo that holds the star, in all six detectors, from {T.day_of(census['first'])} to {T.day_of(census['last'])}: "
        f"the flags of the pixels within {RDRA_RADIUS} pixels of the star's position.",
        "A photo is saturated when at least one of those pixels carries the flag OVERFLOW, NONLINEAR or BLOOM. The verdict "
        "\"too bright to measure\" stands if every photo checked is saturated.",
        ("PASS" if reviewer else "UNVERIFIED") if all_sat else "FAIL", "too bright to measure",
        f"{census['saturated']} of {census['n']}", "photos saturated at the star", f"{census['n']} of {census['n']}", None,
        checks.image_ref(img_rdra), reviewer[0] if reviewer else None, reviewer[1] if reviewer else None,
        "python -m sx.run targets")
    T.put_rows([k5, rdra])

    # cards
    for tid in ORDER:
        e, s = names[tid], shows[tid]
        vt, (ia, ib) = s["visits"], s["pair"]
        card = {"id": tid, "name": e["name"], "detector": DET[tid], "showcase": "manifest.json", "preview": "pair.png",
                "visits": [T.month_of(vt[ia]["first"]), T.month_of(vt[ib]["first"])]}
        if tid in MOVERS:
            r = movers[tid]
            gaia_ref = not e["catalogue"]["unverified"]
            card.update({
                "kind": "mover", "check": "K5",
                "plain": "checked against Gaia" if gaia_ref else "checked against published astrometry",
                "within_tolerance": bool(r["ok_shift"] and r["ok_position"]),
                "verdict": f"Moved {{{{targets.{tid}.shift.measured}}}} arcsec since 2010; the catalogue gives "
                           f"{{{{targets.{tid}.shift.catalogue}}}} arcsec. Position only: no brightness is given."
                           if tid != "eps-indi-b" else
                           f"Moved {{{{targets.{tid}.shift.measured}}}} arcsec since 2010; the catalogue gives "
                           f"{{{{targets.{tid}.shift.catalogue}}}} arcsec.",
                "reference": {"text": e["catalogue"]["source"], "unverified": bool(e["catalogue"]["unverified"])},
                "jump": r["jump"],
                "numbers": sorted(mover_numbers(r)) + [f"targets.{tid}.pairs"],
            })
            if r["tol_beam"] > 0:
                card["note"] = ("Too bright for WISE: its 2010 position is read from the wings of a saturated image, so it "
                                "is known less well than the others.")
            seen = next((b for b in r["beside"] if b["seen"]), None)
            if seen:
                card["beside"] = {
                    "source": f"Gaia DR3 {seen['source_id']}", "is_catalogue_source": bool(r["ok_beside"]),
                    "line": f"A star that does not move lies {{{{targets.{tid}.beside.away}}}} arcsec from it in these photos. "
                            f"In the 2010 image, with the target elsewhere, that star sits "
                            f"{{{{targets.{tid}.beside.off_px}}}} of a pixel from where Gaia puts it.",
                }
        elif tid == "r-dra":
            card.update({
                "kind": "saturated", "check": "K6-rdra", "plain": "too bright to measure",
                "within_tolerance": bool(all_sat),
                "verdict": "Saturated in {{targets.r-dra.saturated}} of the {{targets.r-dra.frames}} photos checked: "
                           "no brightness is given.",
                "reference": {"text": e["catalogue"]["source"], "unverified": bool(e["catalogue"]["unverified"])},
                "numbers": ["targets.r-dra.frames", "targets.r-dra.saturated", "targets.r-dra.pairs"],
            })
        else:
            card.update({"kind": "variable", "check": "K6",
                         "reference": {"text": e["catalogue"]["source"], "unverified": bool(e["catalogue"]["unverified"])}})
        T.update_card(tid, card)

    T.write_text(T.REVIEW / "h5.md", sheet_text(movers, census, shows, names, status, rdra["status"]))
    print(f"K5 {status}; K6-rdra {rdra['status']}; sheet {sheet}")
    return 0 if ok and all_sat else 1


def sheet_text(movers: dict, census: dict, shows: dict, names: dict, k5: str, k6: str) -> str:
    out = [
        "# H5: the five target cards",
        "",
        "Open `h5.png`. Rows 1 to 3: the three moving targets, on the left as WISE saw them in 2010, in the middle as",
        "SPHEREx saw them in its latest visit, both on one sky grid. Rows 4 and 5: RW Aurigae and R Draconis, the first",
        "pair of photos of their showcase.",
        "",
        "**Numbers to read**",
        "",
        "| Target | Reference | Measured shift | Catalogue shift | Difference | Tolerance | In SPHEREx alone |",
        "|---|---|---|---|---|---|---|",
    ]
    for t in MOVERS:
        r = movers[t]
        out.append(f"| {r['name']} | {names[t]['catalogue']['source'].split(',')[0]} | {r['measured']:.1f} arcsec | "
                   f"{r['catalogue']:.1f} arcsec | {r['diff']:.1f} arcsec ({r['diff'] / T.PX_ARCSEC:.2f} px) | "
                   f"{r['tol']:.1f} arcsec | {r['off_px']:.2f} px (tolerance {r['tol_px']:.1f}) |")
    out += [
        "",
        f"- Each jump runs from the 2010 image (a mean of photos from {T.month_of(movers[MOVERS[0]]['tile']['t_min'])} to "
        f"{T.month_of(movers[MOVERS[0]]['tile']['t_max'])} for Epsilon Indi B; the dates of each are on its card) to "
        + ", ".join(f"{T.month_of(movers[t]['spherex']['mjd'])} ({movers[t]['name']})" for t in MOVERS) + ".",
    ]
    if beside_note(movers):
        out.append("- " + beside_note(movers) + " It is marked with a green square.")
    if beam_note(movers):
        out.append("- " + beam_note(movers))
    out += [
        f"- R Draconis: saturated in {census['saturated']} of {census['n']} photos checked.",
        f"- Showcases: " + "; ".join(f"{names[t]['name']} detector {DET[t]}, {len(shows[t]['pairs'])} pairs" for t in ORDER) + ".",
        "",
        "**It passes if**",
        "",
        "1. Every reference is Gaia DR3 or the named published astrometry (WISE 0855: Kirkpatrick et al. 2021 as served",
        "   by SIMBAD; `names.json` marks it unverified until the paper has been read).",
        "2. The tolerances are those of `site/data/targets/tolerances.json`, written before the jobs measured; its first",
        "   lines say what was known when the term for Barnard's Star was set, and the reviewer accepts that term.",
        "3. Each jump is labelled with its two epochs.",
        "4. The star beside WISE 0855 lies within 1 pixel of a catalogue source (the 2010 image, above) and is not taken",
        "   for the brown dwarf.",
        "5. No brightness appears for Barnard's Star, R Draconis or WISE 0855.",
        "",
        f"Status written by the job: K5 {k5}, K6-rdra {k6}. Reviewer's role and date are set with",
        "`python -m sx.run targets --reviewed \"<role>\" <YYYY-MM-DD>` after the review.",
        "",
    ]
    return "\n".join(out)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
