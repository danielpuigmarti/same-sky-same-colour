"""Job spectra: the spectrum of Epsilon Indi B from single photos, and three steady stars beside it (E3 showcase
spectra, Checks row K13, review sheet H11).

    python -m sx.run spectra [--reviewed "<role>" <YYYY-MM-DD> --ratio <median ratio against IRSA's tool>]

SPHEREx sees a position at a different colour in every photo, so the photos that cover one position are points of
its spectrum. The job takes every photo of the archive that covers Epsilon Indi B (the frame index lists them),
measures the flux of the brown-dwarf pair and of three steady, unsaturated stars within 4 arcmin of it by aperture
photometry on that one photo (a 2-pixel aperture, the sky from a ring of 6 to 10 pixels, the errors from the scatter
of the ring), and writes one spectrum per visit.

The aperture holds about 96 to 98% of the light of a point source. The model of the point-spread function that each
photo carries (the EPSF extension) says how much exactly, for the
sub-pixel position of the star (read from each photo's own table); the correction is applied only if it makes the spectra steadier from photo to photo
(the scatter of the three stars' fluxes about their neighbours in colour, which must be below 5% and not worse than
without the correction). Otherwise the spectra are labelled "relative, not aperture-corrected".

Every spectrum is labelled "relative only": the comparison with IRSA's SPHEREx Spectrophotometry Tool (row K13)
needs a person (the tool is a job-based web application with no script interface). The sheet review/h11.md has the
positions to type and our values. When the comparison has been made, pass its median ratio with --reviewed.

Writes: site/data/spectra/<id>.json (eps-indi-b and the stars), site/data/checks/rows/p5.json (row K13; the job
threei adds K4), site/data/checks/img/k13-spectra.png, site/data/numbers/p5.json (keys spectra.*), review/h11.md and
review/h11.png, and the frozen list ("spectra"). Needs the network the first time (about 300 MB of byte ranges).

File of one target: {id, name, kind, label, correction, aperture, mask, catalogue, visits: [{first_mjd, last_mjd, n,
mjd[], lam[], bw[], flux[], err[], flags[], key[]}]}. Wavelength and bandwidth in um, flux and error in mJy, flags
the OR of the FLAGS words of the aperture's pixels, `mask` the bits that make a point unusable. Points are sorted
by wavelength inside a visit.
"""
from __future__ import annotations

import gzip
import json
import math
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import requests  # noqa: E402

from sx import checks, frozen, gaia, numbers, phot, s3, visits  # noqa: E402
from sx import wave as wavemod  # noqa: E402
from sx.contracts import KEY_PATTERN  # noqa: E402
from sx.fits import BLOCK, FLAG, FrameFile, hdu_at  # noqa: E402
from sx.wcs import pixel_area_sr, sky_to_pixel  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / "review"
IMG = checks.IMG_DIR
OUT = ROOT / "site" / "data" / "spectra"
NAMES = ROOT / "site" / "data" / "names.json"

TARGET = "eps-indi-b"
R_AP = 2.0
RING = (6.0, 10.0)
"""Aperture radius and background ring, pixels (6.15 arcsec each). Within the aperture, whole pixels whose centre
lies within the radius."""
HALF = (60, 52)
"""Half-size in x and y of the stamp round Epsilon Indi B. Whole rows are read, so the height decides the bytes."""
STAR_RADIUS = 250.0
"""The comparison stars lie within this many arcsec of Epsilon Indi B, so that one stamp holds them all."""
STAR_G = (10.5, 14.5)
STAR_PM = 100.0
"""Gaia magnitude range and largest proper motion (mas/yr) of a comparison star."""
STAR_ISOLATION = 20.0
SNR_REFINE = 15.0
"""Above this peak signal-to-noise the aperture is centred on the star's measured centre (within 1 pixel)."""
STABLE = 0.05
N_STARS = 3

EPSF_ROW = 8752
EPSF_DT = np.dtype([("bx", ">i4"), ("by", ">i4"), ("xc", ">f4"), ("yc", ">f4"), ("xw", ">f4"), ("yw", ">f4"),
                    ("ns", ">i4"), ("neff", ">f4"), ("cw", ">f4"), ("cb", ">f4"), ("epsf", ">f8", (1089,))])
"""One row of the EPSF table of a photo: the point-spread function of one bin of the detector, 33 by 33 samples at 5
samples a pixel, summing to 1."""
OVERSAMPLE = 5

BANDS = {"J": (1.235, 1594.0), "H": (1.662, 1024.0), "K": (2.159, 666.7)}
"""Reference wavelength (um) and zero-point flux density (Jy) of the 2MASS bands, Vega system (Cohen, Wheaton and
Megeath 2003). The catalogue magnitudes of SIMBAD for these bands are the 2MASS ones."""
SIMBAD = "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
COLORS = (1.0, 1.25, 1.65, 2.2, 2.9, 3.4, 3.9, 4.3, 4.6, 4.9)
"""Colours (um) at which the sheet lists our values."""

BLUE, ORANGE, INK, GREY = "#1f5fa8", "#c45a00", "#1b1f23", "#8a8f98"
PALETTE = ["#1f5fa8", "#c45a00", "#2d7d46", "#7a3e9d", "#8a6d00", "#0b7285"]


# -- the index: which photos cover the position --------------------------------------------------------


def index_dir() -> Path:
    """The frame index of the site when it is built, else the tile kept with the tests."""
    for d in (ROOT / "site" / "idx", ROOT / "tests" / "fixtures" / "idx"):
        if (d / "meta.json").exists():
            return d
    raise FileNotFoundError("no frame index")


def tile_rows(ra: float, dec: float) -> tuple[list[list[float]], list[str]]:
    d = index_dir()
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    band = min(int((dec + 90.0) // meta["T"]), meta["nbands"] - 1)
    j = int(ra // (360.0 / meta["nra"][band])) % meta["nra"][band]
    path = d / "t" / f"{band}_{j}.json.gz"
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f), meta["wv"]


def inside_quad(ra: float, dec: float, corners: list[tuple[float, float]]) -> bool:
    """Is (ra, dec) inside the four-cornered outline, on the tangent plane at the position (small outlines)."""
    c0, d0 = math.radians(ra), math.radians(dec)
    pts = []
    for a, d in corners:
        a, d = math.radians(a), math.radians(d)
        cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(a - c0)
        pts.append((math.cos(d) * math.sin(a - c0) / cosc,
                    (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(a - c0)) / cosc))
    sign = 0
    for i in range(4):
        (x1, y1), (x2, y2) = pts[i], pts[(i + 1) % 4]
        cross = (x2 - x1) * (0 - y1) - (y2 - y1) * (0 - x1)
        s = 1 if cross > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return True


def star_position(cat: dict, mjd: float) -> tuple[float, float]:
    ra, dec = gaia.propagate([cat], mjd)
    return float(ra[0]), float(dec[0])


def candidate_keys(cat: dict) -> list[str]:
    rows, wv = tile_rows(cat["ra"], cat["dec"])
    out = []
    for r in rows:
        week, ver = wv[int(r[0])].split("/")
        key = KEY_PATTERN.format(week=week, ver=ver, det=int(r[3]), obs=int(r[1]), exp=int(r[2]))
        ra, dec = star_position(cat, float(r[4]))
        if inside_quad(ra, dec, [(r[5], r[6]), (r[7], r[8]), (r[9], r[10]), (r[11], r[12])]):
            out.append(key)
    return out


# -- catalogues -------------------------------------------------------------------------------------------


def cached_get(name: str, url: str, params: dict) -> str:
    path = s3.cache_dir() / f"spectra_{name}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8")
    err: Exception = RuntimeError("no try made")
    for _ in range(3):
        try:
            r = requests.get(url, params=params, timeout=90)
            if r.status_code == 200 and "QUERY_STATUS" not in r.text[:600].replace('value="OK"', ""):
                path.write_text(r.text, encoding="utf-8")
                return r.text
            err = RuntimeError(f"status {r.status_code}")
        except requests.RequestException as e:
            err = e
    raise RuntimeError(f"{url} failed: {err}")


def simbad_infrared(ra: float, dec: float, radius: float) -> list[dict]:
    """Objects of SIMBAD within `radius` degrees that have J, H and K magnitudes: {name, ra, dec, J, H, K}."""
    q = ("SELECT b.main_id, b.ra AS ra, b.dec AS de, f.\"filter\" AS band, f.flux AS mag FROM basic AS b JOIN flux AS f "
         f"ON f.oidref = b.oid WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', {ra}, {dec}, {radius})) = 1 "
         "AND f.\"filter\" IN ('J', 'H', 'K')")
    text = cached_get(f"simbad_{ra:.4f}_{dec:.4f}_{radius}", SIMBAD, {"REQUEST": "doQuery", "LANG": "ADQL",
                                                                      "FORMAT": "csv", "QUERY": q})
    import csv
    import io

    objs: dict[str, dict] = {}
    for r in csv.DictReader(io.StringIO(text)):
        o = objs.setdefault(r["main_id"], {"name": r["main_id"], "ra": float(r["ra"]), "dec": float(r["de"])})
        o[r["band"]] = float(r["mag"])
    return [o for o in objs.values() if all(b in o for b in "JHK")]


def gaia_flags(source_ids: list[str]) -> dict[str, dict]:
    """Gaia DR3 variability flag and RUWE of some sources, or {} when the archive does not answer."""
    q = ("SELECT source_id, phot_variable_flag, ruwe FROM gaiadr3.gaia_source WHERE source_id IN ("
         + ",".join(source_ids) + ")")
    try:
        text = cached_get("gaiaflags_" + "_".join(source_ids), GAIA_TAP, {"REQUEST": "doQuery", "LANG": "ADQL",
                                                                          "FORMAT": "csv", "QUERY": q})
    except RuntimeError:
        return {}
    import csv
    import io

    return {r["source_id"]: {"variable": r["phot_variable_flag"], "ruwe": float(r["ruwe"])} for r in
            csv.DictReader(io.StringIO(text))}


def tmass_for(source_ids: list[str]) -> dict[str, dict]:
    """2MASS J, H, Ks of Gaia DR3 sources, through the 2MASS best neighbours of the Gaia archive: {source_id: {J, H, K,
    quality, designation}}. Two questions (the archive's join of the two tables fails at times)."""
    import csv
    import io

    if not source_ids:
        return {}
    q1 = ("SELECT source_id, original_ext_source_id FROM gaiadr3.tmass_psc_xsc_best_neighbour WHERE source_id IN ("
          + ",".join(source_ids) + ")")
    r1 = list(csv.DictReader(io.StringIO(cached_get("tmassnb_" + "_".join(source_ids), GAIA_TAP, {
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q1}))))
    des = {r["original_ext_source_id"]: r["source_id"] for r in r1}
    if not des:
        return {}
    q2 = ("SELECT designation, j_m, h_m, ks_m, ph_qual FROM gaiadr1.tmass_original_valid WHERE designation IN ("
          + ",".join(f"'{d}'" for d in des) + ")")
    r2 = csv.DictReader(io.StringIO(cached_get("tmassmag_" + "_".join(sorted(des)), GAIA_TAP, {
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q2})))
    return {des[r["designation"]]: {"J": float(r["j_m"]), "H": float(r["h_m"]), "K": float(r["ks_m"]),
                                    "quality": r["ph_qual"], "designation": r["designation"]} for r in r2}


def pick_stars(b: dict) -> list[dict]:
    """Three comparison stars: Gaia stars of G 10.5 to 14.5 within 250 arcsec of Epsilon Indi B that move less than
    100 mas/yr, have no neighbour brighter than G + 2.5 within 20 arcsec, and have 2MASS J, H, K of quality A or B
    (nothing saturates at J = 10 or fainter); the brightest in J."""
    gs = gaia.cone(b["ra"], b["dec"], 0.12)
    cos = math.cos(math.radians(b["dec"]))
    cand = []
    for s in gs:
        g = s["phot_g_mean_mag"]
        if g is None or not STAR_G[0] <= g <= STAR_G[1]:
            continue
        pm = math.hypot(s["pmra"] or 0.0, s["pmdec"] or 0.0)
        d = math.hypot((s["ra"] - b["ra"]) * cos, s["dec"] - b["dec"]) * 3600
        if d > STAR_RADIUS or d < 5 or pm > STAR_PM:
            continue
        if any(o is not s and (o["phot_g_mean_mag"] or 99) < g + 2.5 and
               math.hypot((o["ra"] - s["ra"]) * cos, o["dec"] - s["dec"]) * 3600 < STAR_ISOLATION for o in gs):
            continue
        cand.append({**s, "distance": d})
    tm = tmass_for([s["source_id"] for s in cand])
    out = []
    for s in cand:
        m = tm.get(s["source_id"])
        if m and m["J"] >= 10.0 and all(c in "AB" for c in m["quality"][:3]):
            out.append({**s, "name": "2MASS J" + m["designation"], "cat": {k: m[k] for k in "JHK"}, "quality": m["quality"]})
    out.sort(key=lambda s: s["cat"]["J"])
    return out[:N_STARS]


# -- the point-spread function ---------------------------------------------------------------------------


def epsf_reader(ff: FrameFile):
    """A function (x, y) -> the 33 by 33 point-spread function of the bin of the detector that holds the pixel, read
    from this photo's own EPSF extension, one row at a time (8.7 kB). The grid of bins differs between versions of the
    processing (21 by 21 bins of 97 pixels, or 11 by 41 of 185 by 50), so it is worked out from the first row: the bins
    are equal and x runs fastest."""
    z = hdu_at(ff.key, ff.variance_hdu.next, BLOCK * 4)
    e = hdu_at(ff.key, z.next, BLOCK * 4)
    if e.name != "EPSF" or e.header["NAXIS1"] != EPSF_ROW:
        raise ValueError(f"{ff.key}: unexpected EPSF extension")
    n = e.header["NAXIS2"]

    def row(k: int):
        return np.frombuffer(s3.get_range(ff.key, e.doff + k * EPSF_ROW, e.doff + (k + 1) * EPSF_ROW - 1), EPSF_DT)[0]

    nbx = int(round(ff.nx / float(row(0)["xw"])))
    nby = n // nbx
    if nbx * nby != n:
        raise ValueError(f"{ff.key}: {n} EPSF bins do not form a grid with {nbx} columns")
    xw, yw = ff.nx / nbx, ff.ny / nby

    def get(x: float, y: float) -> np.ndarray:
        bx, by = min(max(int(x // xw), 0), nbx - 1), min(max(int(y // yw), 0), nby - 1)
        r = row(by * nbx + bx)
        if int(r["bx"]) != bx or int(r["by"]) != by:
            raise ValueError(f"{ff.key}: EPSF bin {bx},{by} is not where the grid puts it")
        return r["epsf"].reshape(33, 33).astype(float)

    return get


def epsf_fraction(psf: np.ndarray, cx: float, cy: float, r_ap: float) -> float:
    """The share of a star's light that falls on the pixels of the aperture, from the model: the pixels whose centre
    lies within r_ap of (cx, cy) (any origin of the pixel grid), the star at (cx, cy). The model covers a box of 6.6
    pixels; what lies outside it is not counted."""
    n = psf.shape[0]
    off = (np.arange(n) - n // 2) / OVERSAMPLE
    x = cx + off[None, :] + np.zeros((n, 1))
    y = cy + off[:, None] + np.zeros((1, n))
    inside = np.hypot(np.floor(x + 0.5) - cx, np.floor(y + 0.5) - cy) <= r_ap
    return float(psf[inside].sum() / psf.sum())


# -- measuring ---------------------------------------------------------------------------------------------


def centre_of_light(data: np.ndarray, flg: np.ndarray, cx: float, cy: float, bkg: float) -> tuple[float, float]:
    yy, xx = np.mgrid[: data.shape[0], : data.shape[1]]
    for _ in range(3):
        m = (np.hypot(xx - cx, yy - cy) <= 2.5) & np.isfinite(data) & ((flg & phot.BAD_MASK) == 0)
        w = np.clip(data[m] - bkg, 0, None)
        if w.sum() <= 0:
            return cx, cy
        cx, cy = float(np.sum(w * xx[m]) / w.sum()), float(np.sum(w * yy[m]) / w.sum())
    return cx, cy


def ring_photometry(data, var, flg, cx, cy, omega):
    """phot.aperture with the pixels flagged SOURCE left out of the ring; where that leaves fewer than 40 pixels (next to
    a very bright star the flag can cover the whole stamp) the flag is ignored for the ring and the clipping alone
    removes the stars in it."""
    p = phot.aperture(data, var, flg, cx, cy, R_AP, RING, omega)
    if p is None or p.n_ring < 40:
        p = phot.aperture(data, var, flg, cx, cy, R_AP, RING, omega, skip_source_in_ring=False)
    return p


def one_photometry(data: np.ndarray, flg: np.ndarray, cx: float, cy: float, omega: float):
    """Aperture photometry at (cx, cy): the sky from the ring, the error from the scatter of the ring (a variance
    map is not read: that would double the bytes). Returns (Photometry, centre used, peak signal-to-noise)."""
    p0 = ring_photometry(data, None, flg, cx, cy, omega)
    if p0 is None:
        return None
    sd = p0.bkg_sd
    peak = float(np.nanmax(data[int(round(cy)) - 1 : int(round(cy)) + 2, int(round(cx)) - 1 : int(round(cx)) + 2]) - p0.bkg)
    snr = peak / sd if sd > 0 else 0.0
    if snr > SNR_REFINE:
        nx_, ny_ = centre_of_light(data, flg, cx, cy, p0.bkg)
        if math.hypot(nx_ - cx, ny_ - cy) <= 1.0:
            cx, cy = nx_, ny_
    var = np.full(data.shape, sd * sd, dtype=np.float32)
    p = ring_photometry(data, var, flg, cx, cy, omega)
    return None if p is None else (p, cx, cy, snr)


def measure_frame(ff: FrameFile, targets: list[dict]) -> dict[str, dict]:
    """One photo: {target id: point} for the targets whose aperture and ring lie on the stamp. A point is
    {key, mjd, det, lam, bw, flux, err, flux_raw, frac, flags, snr}; flux in mJy."""
    tpos = {}
    for t in targets:
        ra, dec = star_position(t["cat"], ff.mjd)
        tpos[t["id"]] = tuple(float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    bx, by = tpos[TARGET]
    x0, y0 = int(math.floor(bx + 0.5)) - HALF[0], int(math.floor(by + 0.5)) - HALF[1]
    data, fl, _ = ff.box(x0, y0, 2 * HALF[0] + 1, 2 * HALF[1] + 1, flags=True, variance=False)
    omega = pixel_area_sr(ff.wcs)
    psf_at = epsf_reader(ff)
    out = {}
    for t in targets:
        px, py = tpos[t["id"]]
        cx, cy = px - x0, py - y0
        pad = RING[1] + 1
        if not (3 <= px < ff.nx - 3 and 3 <= py < ff.ny - 3 and pad <= cx < data.shape[1] - pad and pad <= cy < data.shape[0] - pad):
            continue
        r = one_photometry(data, fl, cx, cy, omega)
        if r is None or not math.isfinite(r[0].flux):
            continue
        p, cx, cy, snr = r
        wb = wavemod.wavelength_at(ff.det, x0 + cx, y0 + cy)
        yy, xx = np.mgrid[: data.shape[0], : data.shape[1]]
        ap = np.hypot(xx - cx, yy - cy) <= R_AP
        word = int(np.bitwise_or.reduce(fl[ap])) if ap.any() else 0
        frac = epsf_fraction(psf_at(x0 + cx, y0 + cy), cx, cy, R_AP)
        out[t["id"]] = {"key": ff.key, "mjd": ff.mjd, "det": ff.det, "lam": wb["lam"], "bw": wb["bw"],
                        "flux_raw": p.flux, "err_raw": p.err, "frac": frac, "flags": word, "snr": snr}
    return out


def sorted_scatter(points: list[dict], field: str) -> float:
    """Scatter of the points of one star about their neighbours in colour: for each point with signal-to-noise above
    30, flux over the median of its 6 nearest neighbours in colour; the scatter is 1.4826 x MAD of those ratios."""
    pts = sorted(points, key=lambda p: p["lam"])
    f = np.array([p[field] for p in pts])
    lam = np.array([p["lam"] for p in pts])
    snr = np.array([p["snr"] for p in pts])
    ratios = []
    for i in range(len(pts)):
        if snr[i] < 30 or f[i] <= 0:
            continue
        j = [k for k in np.argsort(np.abs(lam - lam[i])) if k != i][:6]
        m = np.median(f[j])
        if m > 0:
            ratios.append(f[i] / m)
    r = np.array(ratios)
    return float(1.4826 * np.median(np.abs(r - np.median(r)))) if len(r) > 5 else math.nan


# -- main ---------------------------------------------------------------------------------------------------


def target_entry(name_id: str) -> dict:
    d = json.loads(NAMES.read_text(encoding="utf-8"))
    e = next(x for x in d["entries"] if x["id"] == name_id)
    c = e["catalogue"]
    return {"id": e["id"], "name": e["name"], "kind": "brown dwarfs",
            "cat": {"ra": c["ra"], "dec": c["dec"], "pmra": c["pmra"], "pmdec": c["pmdec"]},
            "ra": e["ra"], "dec": e["dec"]}


def jy_to_mjy(mag: float, band: str) -> float:
    return BANDS[band][1] * 10 ** (-0.4 * mag) * 1000.0


def catalogue_ratios(pts: list[dict], cat: dict) -> dict[str, dict]:
    """Per band: the median measured flux of the photos within 0.06 um of the band's reference wavelength divided by
    the flux density that the magnitude gives. Not a calibration: the bands are wide and the colour of the star
    changes what 'the flux at the reference wavelength' means."""
    out = {}
    for b, (lam0, _) in BANDS.items():
        near = [p["flux"] for p in pts if abs(p["lam"] - lam0) <= 0.06 and p["snr"] > 5]
        if len(near) >= 2:
            f = jy_to_mjy(cat[b], b)
            out[b] = {"measured": float(np.median(near)), "catalogue": f, "ratio": float(np.median(near) / f), "n": len(near)}
    return out


def main(argv: list[str]) -> int:
    reviewer, ratio_irsa = None, None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
        if "--ratio" not in argv:
            raise SystemExit("--reviewed needs --ratio: the median ratio of our fluxes to IRSA's tool")
        ratio_irsa = float(argv[argv.index("--ratio") + 1])
    b = target_entry(TARGET)
    stars = pick_stars({"ra": b["ra"], "dec": b["dec"]})
    print("comparison stars: " + "; ".join(f"{s['name']} G={s['phot_g_mean_mag']:.1f} J={s['cat']['J']:.2f} at {s['distance']:.0f} arcsec" for s in stars))
    targets = [b] + [{"id": f"gaia-{s['source_id']}", "name": f"{s['name']} (Gaia DR3 {s['source_id']})", "kind": "star",
                      "cat": {"ra": s["ra"], "dec": s["dec"], "pmra": s["pmra"] or 0.0, "pmdec": s["pmdec"] or 0.0},
                      "ra": s["ra"], "dec": s["dec"], "star": s} for s in stars]

    def find() -> list[str]:
        keys = candidate_keys(b["cat"])
        out = []
        for k, ff in zip(keys, s3.map_threads(FrameFile.open, keys)):
            ra, dec = star_position(b["cat"], ff.mjd)
            px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
            if HALF[0] <= px < ff.nx - HALF[0] and 15 <= py < ff.ny - 15:
                out.append(k)
        return out

    keys = frozen.frames_for("spectra", find)
    print(f"{len(keys)} photos cover Epsilon Indi B")
    frames = s3.map_threads(FrameFile.open, keys)
    res = s3.map_threads(lambda ff: measure_frame(ff, targets), frames)
    series = {t["id"]: [r[t["id"]] for r in res if t["id"] in r] for t in targets}
    for t in targets:
        print(f"{t['id']}: {len(series[t['id']])} points")

    # the aperture correction: applied only if it makes the spectra steadier
    star_ids = [t["id"] for t in targets[1:]]
    raw_sc, cor_sc = [], []
    for sid in star_ids:
        pts = series[sid]
        for p in pts:
            p["flux_cor"] = p["flux_raw"] / p["frac"]
        raw_sc.append(sorted_scatter(pts, "flux_raw"))
        cor_sc.append(sorted_scatter(pts, "flux_cor"))
    sc_raw, sc_cor = float(np.nanmedian(raw_sc)), float(np.nanmedian(cor_sc))
    applied = bool(sc_cor <= STABLE and sc_cor <= sc_raw)
    fr = np.array([p["frac"] for sid in star_ids for p in series[sid]])
    print(f"scatter of the stars about their neighbours in colour: without correction {sc_raw:.4f}, with {sc_cor:.4f}; "
          f"share of the light in the aperture {fr.min():.3f} to {fr.max():.3f}; correction applied: {applied}")
    for t in targets:
        for p in series[t["id"]]:
            f = p["frac"] if applied else 1.0
            p["flux"], p["err"] = p["flux_raw"] / f, p["err_raw"] / f

    # the catalogue sanity check
    cat_res, ratios = {}, []
    for t in targets:
        cat = t["star"]["cat"] if "star" in t else json_cat(t)
        cat_res[t["id"]] = catalogue_ratios(series[t["id"]], cat) if cat else {}
    for sid in star_ids:
        ratios += [v["ratio"] for v in cat_res[sid].values()]
    med_cat = float(np.median(ratios)) if ratios else math.nan
    print("catalogue ratios (measured over 2MASS): " + "; ".join(
        f"{sid[-6:]} " + ", ".join(f"{k} {v['ratio']:.2f}" for k, v in cat_res[sid].items()) for sid in star_ids)
          + f"; median over the three stars {med_cat:.2f}")
    print("Epsilon Indi B: " + ", ".join(f"{k} {v['ratio']:.2f}" for k, v in cat_res[TARGET].items()))
    flags = gaia_flags([s["source_id"] for s in stars])

    # the files
    OUT.mkdir(parents=True, exist_ok=True)
    mask = int(phot.BAD_MASK)
    status_label = "relative only"
    corr_text = ("aperture-corrected from the point-spread-function model of each photo (EPSF), relative to the light inside "
                 "its 6.6-pixel box" if applied else "relative, not aperture-corrected")
    if ratio_irsa is not None and 0.9 <= ratio_irsa <= 1.1:
        status_label = "compared with IRSA's Spectrophotometry Tool: median ratio %.2f" % ratio_irsa
    for t in targets:
        pts = series[t["id"]]
        vs = visits.visits([{"key": p["key"], "det": p["det"], "tmid": p["mjd"], "corners": []} for p in pts])
        by_key = {p["key"]: p for p in pts}
        vlist = []
        for v in vs:
            vp = sorted((by_key[f["key"]] for f in v["frames"]), key=lambda p: p["lam"])
            vlist.append({"first_mjd": round(min(p["mjd"] for p in vp), 5), "last_mjd": round(max(p["mjd"] for p in vp), 5),
                          "n": len(vp), "short": bool(v["short"]), "mjd": [round(p["mjd"], 5) for p in vp],
                          "lam": [round(p["lam"], 5) for p in vp], "bw": [round(p["bw"], 5) for p in vp],
                          "flux": [round(p["flux"], 4) for p in vp], "err": [round(p["err"], 4) for p in vp],
                          "flags": [p["flags"] for p in vp], "key": [p["key"] for p in vp]})
        doc = {"id": t["id"], "name": t["name"], "kind": t["kind"], "label": status_label, "correction": corr_text,
               "aperture": {"radius_px": R_AP, "ring_px": list(RING), "sky": "median of the ring after clipping",
                            "error": "scatter of the ring, plus the background's own uncertainty"},
               "mask": mask, "units": {"lam": "um", "bw": "um", "flux": "mJy", "err": "mJy"},
               "catalogue": ({"source": "2MASS J, H, K magnitudes as listed by SIMBAD", "mag": t["star"]["cat"],
                              "ratios": cat_res[t["id"]], "gaia": flags.get(t["star"]["source_id"])} if "star" in t else
                             {"source": "2MASS J, H, K magnitudes as listed by SIMBAD (the pair, not resolved)",
                              "ratios": cat_res[t["id"]]}),
               "visits": vlist}
        path = OUT / f"{t['id']}.json"
        path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        print(f"wrote {path.name}: {len(pts)} points in {len(vlist)} visits, {path.stat().st_size / 1e3:.0f} kB")
    # the list of the files, so that the page asks only for a spectrum that exists
    (OUT / "index.json").write_text(json.dumps({"ids": sorted(t["id"] for t in targets)}, indent=1) + "\n",
                                    encoding="utf-8", newline="\n")

    # pictures, row, numbers, sheet
    fig = draw_spectra(targets, series, cat_res, applied)
    img = save(fig, IMG / "k13-spectra.png")
    fig2 = draw_spectra(targets, series, cat_res, applied)
    sheet_png = save(fig2, REVIEW / "h11.png")
    nb = len(series[TARGET])
    nv = len(visits.visits([{"key": p["key"], "det": p["det"], "tmid": p["mjd"], "corners": []} for p in series[TARGET]]))
    if ratio_irsa is None:
        status = "UNVERIFIED"
    else:
        status = "PASS" if 0.9 <= ratio_irsa <= 1.1 else "LIMIT"
    test = (f"The spectrum of Epsilon Indi B (a pair of brown dwarfs) and of three steady, unsaturated stars within 4 arcmin of it, "
            f"from {nb} photos in {nv} visits: flux in a {R_AP:g}-pixel aperture, sky from a ring of {RING[0]:g} to {RING[1]:g} pixels, "
            f"one point per photo. Compared with IRSA's SPHEREx Spectrophotometry Tool at the same positions and the same visit. "
            f"The tool is a web application that runs a job for each source (minutes to hours) and has no script interface, so the "
            f"comparison has to be made by hand: positions, our values and the rule are in the review sheet. Until it is made, "
            f"every spectrum is labelled \"relative only\". As a rough check of the shape, the three stars' fluxes at the 2MASS "
            f"bands are {med_cat:.2f} times their catalogue brightness (median over J, H, K and the three stars; not a calibration: "
            f"the bands are wide). The aperture correction from the point-spread-function model is "
            f"{'applied' if applied else 'not applied'}: the scatter of the stars about their neighbours in colour is {sc_cor * 100:.1f}% "
            f"with it and {sc_raw * 100:.1f}% without.")
    k13 = checks.row(
        "K13", "Spectra of a brown dwarf pair, compared with IRSA's own tool",
        "The spectrum that this tool builds from single SPHEREx photos for Epsilon Indi B and for three steady stars matches "
        "the one from IRSA's Spectrophotometry Tool to within 10%" + ("." if ratio_irsa is not None else "; this has not been compared yet."),
        test,
        "PASS if the median ratio of our fluxes to those of IRSA's tool, over the colours both have, lies between 0.9 and 1.1; "
        "otherwise the spectra stay labelled \"relative only\".",
        status, "spectra are relative only until compared with IRSA's tool",
        (f"{ratio_irsa:.2f}" if ratio_irsa is not None else None), "ratio to IRSA's tool" if ratio_irsa is not None else None,
        "0.9 to 1.1", "ratio between 0.9 and 1.1", checks.image_ref(img),
        reviewer[0] if reviewer else None, reviewer[1] if reviewer else None, "python -m sx.run spectra")
    rows_path = ROOT / "site" / "data" / "checks" / "rows" / "p5.json"
    keep = []
    if rows_path.exists():
        keep = [r for r in json.loads(rows_path.read_text(encoding="utf-8")) if r["id"] != "K13"]
    checks.write_rows("p5", keep + [k13])

    ent = {
        "spectra.epsb.n_photos": numbers.entry(nb, 0, check="K13"),
        "spectra.epsb.n_visits": numbers.entry(nv, 0, check="K13"),
        "spectra.aperture_px": numbers.entry(R_AP, 0, unit="pixels", check="K13"),
        "spectra.ring_in_px": numbers.entry(RING[0], 0, unit="pixels", check="K13"),
        "spectra.ring_out_px": numbers.entry(RING[1], 0, unit="pixels", check="K13"),
        "spectra.stars.scatter_raw": numbers.entry(sc_raw * 100, 1, unit="%", check="K13"),
        "spectra.stars.scatter_corrected": numbers.entry(sc_cor * 100, 1, unit="%", check="K13"),
        "spectra.epsf.fraction_min": numbers.entry(float(fr.min()) * 100, 1, unit="%", check="K13"),
        "spectra.epsf.fraction_max": numbers.entry(float(fr.max()) * 100, 1, unit="%", check="K13"),
    }
    if math.isfinite(med_cat):
        ent["spectra.stars.catalogue_ratio"] = numbers.entry(med_cat, 2, check="K13")
    if ratio_irsa is not None:
        ent["spectra.irsa_ratio"] = numbers.entry(ratio_irsa, 2, check="K13")
    numbers.write("p5", ent)
    REVIEW.mkdir(parents=True, exist_ok=True)
    (REVIEW / "h11.md").write_text(sheet_text(targets, series, cat_res, med_cat, sc_raw, sc_cor, applied, nb, nv, status),
                                   encoding="utf-8", newline="\n")
    print(f"K13 {status}; sheet {sheet_png}")
    return 0


def json_cat(t: dict) -> dict | None:
    """Catalogue J, H, K of Epsilon Indi B from SIMBAD (the object named "eps Ind B")."""
    ir = simbad_infrared(t["ra"], t["dec"], 0.12)
    best = next((o for o in ir if o["name"].endswith("eps Ind B")), None)
    return {k: best[k] for k in "JHK"} if best else None


def save(fig, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130, metadata={"Software": None}, facecolor="white")
    plt.close(fig)
    return path


def draw_spectra(targets, series, cat_res, applied: bool):
    fig, axs = plt.subplots(2, 2, figsize=(12, 8), sharex=True)
    for ax, t in zip(axs.ravel(), targets):
        pts = series[t["id"]]
        vs = visits.visits([{"key": p["key"], "det": p["det"], "tmid": p["mjd"], "corners": []} for p in pts])
        by_key = {p["key"]: p for p in pts}
        for i, v in enumerate(vs):
            vp = sorted((by_key[f["key"]] for f in v["frames"]), key=lambda p: p["lam"])
            ax.errorbar([p["lam"] for p in vp], [max(p["flux"], 1e-3) for p in vp], yerr=[p["err"] for p in vp], fmt=".", ms=3,
                        color=PALETTE[i % len(PALETTE)], ecolor=PALETTE[i % len(PALETTE)], elinewidth=0.5, alpha=0.8,
                        label=f"visit {i + 1}" if i < 6 else None)
        for b, v in cat_res[t["id"]].items():
            ax.plot(BANDS[b][0], v["catalogue"], "D", color=INK, ms=6, mfc="none")
        ax.set_yscale("log")
        ax.set_title(t["name"].split(" (")[0] + ("" if t["id"] == TARGET else ", steady star"), fontsize=9)
        ax.spines[["top", "right"]].set_visible(False)
    for ax in axs[1]:
        ax.set_xlabel("colour: wavelength of the pixel (µm)")
    for ax in axs[:, 0]:
        ax.set_ylabel("flux (mJy), " + ("aperture-corrected" if applied else "not aperture-corrected"))
    axs[0, 0].legend(fontsize=7, frameon=False, ncol=2)
    fig.suptitle("Relative only: not yet compared with IRSA's tool. Open diamonds: 2MASS brightness.", fontsize=9)
    fig.tight_layout()
    return fig


def sheet_text(targets, series, cat_res, med_cat, sc_raw, sc_cor, applied, nb, nv, status) -> str:
    L = [
        "# H11: spectra against IRSA's Spectrophotometry Tool",
        "",
        "Open `h11.png`: Epsilon Indi B and three steady stars, one dot per photo, one colour per visit; open diamonds are the",
        "stars' 2MASS brightnesses. The comparison with IRSA's tool is made by hand, because that tool is a web application",
        "that runs a job for each source and has no script interface.",
        "",
        "**What to do**",
        "",
        "1. Open IRSA's SPHEREx Data Explorer, Spectrophotometry Tool (https://irsa.ipac.caltech.edu/applications/spherex/tool-spectrophotometry).",
        "2. Enter each position below as a point source and run it (a few minutes to an hour per source; the limit is 20 sources a run).",
        "3. For each target, take the tool's flux (in µJy) at the colours of the table and divide ours by it. Epsilon Indi B moves",
        "   about 4.7 arcsec a year: the tool takes one fixed position, so use only photos of one visit (our `visits[i]` in",
        "   `site/data/spectra/eps-indi-b.json`) and the position for that visit's date, or accept the loss of flux for the others.",
        "4. The median of all the ratios is the number to enter: `python -m sx.run spectra --reviewed \"<role>\" <YYYY-MM-DD> --ratio <median>`.",
        "",
        "**Positions to type** (ICRS, degrees, at 2026.0; the file of each target has the catalogue motion)",
        "",
        "| Target | RA | Dec |",
        "|---|---|---|",
    ]
    for t in targets:
        L.append(f"| {t['name'].split(' (')[0]} | {t['ra']:.6f} | {t['dec']:.6f} |")
    L += ["", f"**Our values** (µJy; median of the photos within 0.03 µm of each colour, all visits; {'aperture-corrected' if applied else 'not aperture-corrected'}; '-' where no photo)", ""]
    L.append("| Colour (µm) | " + " | ".join(t["name"].split(" (")[0] for t in targets) + " |")
    L.append("|---|" + "---|" * len(targets))
    for c in COLORS:
        cells = []
        for t in targets:
            v = [p["flux"] * 1000.0 for p in series[t["id"]] if abs(p["lam"] - c) <= 0.03]
            cells.append(f"{np.median(v):.0f} (n {len(v)})" if v else "-")
        L.append(f"| {c:g} | " + " | ".join(cells) + " |")
    L += [
        "",
        "**Numbers**",
        "",
        f"- Epsilon Indi B: {nb} photos in {nv} visits.",
        f"- The three stars' fluxes at the 2MASS bands over their catalogue brightness: median {med_cat:.2f} (not a calibration).",
        f"- Scatter of the stars about their neighbours in colour: {sc_raw * 100:.1f}% without the aperture correction, {sc_cor * 100:.1f}% with; correction {'applied' if applied else 'not applied'}.",
        "",
        "**It passes if**",
        "",
        "The median ratio of our fluxes to IRSA's lies between 0.9 and 1.1. If it does not, every spectrum stays labelled \"relative only\".",
        "",
        f"Status written by the job: {status}.",
        "",
    ]
    return "\n".join(L)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
