"""The lemmon job: its pieces on synthetic data and on the recorded frame fixtures (no network), what it wrote to
disk, and its done-means on real data (network; the first run is slow, later runs read the cache)."""
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest
from astropy.wcs import WCS

from sx import checks, contracts, frozen, phot, s3, wave
from sx.fits import FLAG, FrameFile
from sx.stamp import cut as shared_cut

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import lemmon as L  # noqa: E402
from jobs import lemmon_draw as D  # noqa: E402
from test_p1_support import FRAME_IDS, load_frame, needs_network, recorded_source  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site" / "data"
NUMBERS = SITE / "numbers" / "p2.json"
ROWS = SITE / "checks" / "rows" / "p2.json"

EARLIER = {
    "2026W09_1A_0447_2": ("dr1/level2/2026W09_1A/l2b-v27-2026-228/5/level2_2026W09_1A_0447_2D5_spx_l2b-v27-2026-228.fits", 243.965277537, -59.431234804),
    "2026W09_1A_0459_2": ("dr1/level2/2026W09_1A/l2b-v27-2026-228/5/level2_2026W09_1A_0459_2D5_spx_l2b-v27-2026-228.fits", 243.912398903, -59.456225688),
    "2026W09_2A_0075_1": ("dr1/level2/2026W09_2A/l2b-v27-2026-229/5/level2_2026W09_2A_0075_1D5_spx_l2b-v27-2026-229.fits", 242.688162919, -60.012695294),
    "2026W09_2A_0075_2": ("dr1/level2/2026W09_2A/l2b-v27-2026-229/5/level2_2026W09_2A_0075_2D5_spx_l2b-v27-2026-229.fits", 242.686929495, -60.013380299),
    "2026W09_2A_0075_3": ("dr1/level2/2026W09_2A/l2b-v27-2026-229/5/level2_2026W09_2A_0075_3D5_spx_l2b-v27-2026-229.fits", 242.685707276, -60.014060325),
    "2026W09_2A_0075_4": ("dr1/level2/2026W09_2A/l2b-v27-2026-229/5/level2_2026W09_2A_0075_4D5_spx_l2b-v27-2026-229.fits", 242.684470726, -60.014748324),
}
"""Where the earlier measurements (other code) put the aperture: positions interpolated in a JPL Horizons table of
20-minute steps. The job asks Horizons for the middle of each exposure instead; the two differ by 0.03 to 0.52
arcsec for these frames."""
AUGUST = "dr1/level2/2025W32_2D/l2b-v27-2026-226/5/level2_2025W32_2D_0560_4D5_spx_l2b-v27-2026-226.fits"
"""The August 2025 template of the brightest frame; the earlier measurement found +0.4 mJy there (near ring)."""
MOVED = "2026W09_2A_0075_4"
"""The one reference frame whose flux depends on which of the two positions is used: one pixel on the edge of
the aperture is inside at the earlier position and outside at the job's."""


def synthetic_cut(rows=160, nx=400, level=1.0, flags=None, seed=3):
    """A flat, slightly noisy strip of detector 5 with a plain WCS: 6.15 arcsec pixels, no distortion."""
    rs = np.random.default_rng(seed)
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [150.0, 20.0]
    w.wcs.crpix = [200.5, 1000.5]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    data = (level + rs.normal(0, 0.01, (rows, nx))).astype(np.float32)
    fl = np.full((rows, nx), FLAG["FULLSAMPLE"], np.int32) if flags is None else flags
    y0 = 1000 - rows // 2
    om = (6.15 / 206264.806) ** 2
    return L.Cut(key="dr1/level2/2026W09_2A/v/5/level2_2026W09_2A_0001_1D5_spx_v.fits", det=5, mjd=61097.5, ra=150.0,
                 dec=20.0, px=199.5, py=999.5, y0=y0, data=data, flags=fl, var=np.full((rows, nx), 1e-4, np.float32),
                 wcs=w, nx=nx, ny=2040, omega=om, pix_arcsec=6.15)


def shot(obs, mjd, lam, flux, total=1.0, lo=None, hi=None):
    r = {"flux": flux, "total": total, "wide": 2 * flux, "lo": lo, "hi": hi}
    return {"obs": obs, "mjd": mjd, "lam": lam, "rings": {"ring40": r, "ring15": dict(r)}}


def toy():
    """Two nights, a band between 4.20 and 4.32: night 1 has one frame in the middle and one on the edge."""
    return [
        shot("a", 61096.3, 4.23, 160.0, 3.0, 150.0, 170.0), shot("b", 61096.4, 4.31, 50.0),
        shot("c", 61096.8, 4.38, 20.0, 1.5, 18.0, 21.0), shot("d", 61096.9, 4.05, 11.0),
        shot("e", 61097.4, 4.12, 29.0), shot("f", 61097.86, 4.19, 14.0, 2.5, 13.0, 15.0),
        shot("g", 61097.862, 4.23, 136.0), shot("h", 61097.864, 4.27, 263.0, 5.0, 230.0, 270.0),
        shot("i", 61097.866, 4.30, 72.0),
    ]


# -- reading ----------------------------------------------------------------------------------------


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_a_stamp_from_the_rows_equals_the_shared_stamp(id_):
    """Cut.stamp is the shared stamp (CT-4): bit for bit the fixture, and the fields of sx.stamp.cut."""
    meta, _, data, flags = load_frame(id_)
    t = meta["target"]
    with s3.use(recorded_source(id_)):
        ff = FrameFile.open(meta["key"])
        c = L.read_cut(ff, t["ra"], t["dec"], half=32, variance=False)
        want = shared_cut(ff, t["ra"], t["dec"], size=64)
    st = c.stamp(t["ra"], t["dec"], 64)
    assert st.data.tobytes() == data.tobytes() and np.array_equal(st.flags, flags)
    assert (st.x0, st.y0, st.w, st.h, st.det, st.key) == (want.x0, want.y0, 64, 64, want.det, want.key)
    assert (st.tx, st.ty, st.lam, st.bw, st.mjd) == (want.tx, want.ty, want.lam, want.bw, want.mjd)
    assert st.variance is None and c.rows == 64 and c.data.shape == (64, 2040)


def test_a_stamp_beyond_the_rows_or_the_detector_is_padded():
    c = synthetic_cut()
    ra, dec = (float(v) for v in c.wcs.all_pix2world(3.0, 1000.0, 0))
    st = c.stamp(ra, dec, 64)
    assert st.x0 == -29 and np.all(np.isnan(st.data[:, :29])) and np.all(st.flags[:, :29] == 0)
    assert np.isfinite(st.data[:, 29:]).all()


def test_obs_and_short_ids():
    key = EARLIER["2026W09_2A_0075_3"][0]
    assert L.obs_id(key) == "2026W09_2A_0075_3" and L.short_id(key) == "2a-0075-3"
    assert L.night_of(61096.3) == "feb25" and L.night_of(61097.86) == "feb26" and L.night_of(61098.0) is None


# -- photometry -------------------------------------------------------------------------------------


def test_aperture_is_the_shared_rule_on_the_part_that_holds_the_ring():
    c = synthetic_cut()
    c.data[80, 200] += 50.0
    x, y = 200.2, c.y0 + 80.3
    for ring in L.RINGS.values():
        got = L.aperture(c, x, y, L.R_AP, ring)
        want = phot.aperture(c.data, c.var, c.flags, x, y - c.y0, L.R_AP, ring, c.omega)
        assert got.flux == pytest.approx(want.flux, rel=1e-6) and got.err == pytest.approx(want.err, rel=1e-6)
        assert (got.n_ap, got.n_use, got.n_ring) == (want.n_ap, want.n_use, want.n_ring)
    assert L.aperture(c, x, y, L.R_AP, L.RINGS["ring15"]).flux == pytest.approx(50.0 * c.omega * 1e9, rel=0.02)


def test_source_pixels_leave_the_ring_when_enough_others_remain():
    """A ring half covered by the SOURCE flag and 3 MJy/sr brighter there: skipped, the background is the dark
    half. Wholly covered (as in the comet's field): all pixels count."""
    fl = np.full((160, 400), FLAG["FULLSAMPLE"], np.int32)
    fl[:, 200:] |= FLAG["SOURCE"]
    c = synthetic_cut(flags=fl)
    c.data[:, 200:] += 3.0
    half = L.aperture(c, 199.5, c.y0 + 80.0, L.R_AP, L.RINGS["ring15"])
    assert half.bkg == pytest.approx(1.0, abs=0.01)
    c2 = synthetic_cut(flags=np.full((160, 400), FLAG["FULLSAMPLE"] | FLAG["SOURCE"], np.int32))
    full = L.aperture(c2, 199.5, c2.y0 + 80.0, L.R_AP, L.RINGS["ring15"])
    assert full is not None and full.n_ring > 1000


def test_iso_points_keep_the_colour():
    t = wave.default_tables()
    for x, y in ((510.8, 513.2), (36.0, 660.8), (1700.0, 300.0)):
        lam0 = float(wave.lam_bw(t["5"], x, y)[0])
        pts = L.iso_points(5, x, y, tables=t)
        assert len(pts) == 2 * len(L.EMPTY_OFFSETS)
        for xe, ye, side, k in pts:
            assert xe == pytest.approx(x + side * L.EMPTY_OFFSETS[k])
            assert float(wave.lam_bw(t["5"], xe, ye)[0]) == pytest.approx(lam0, abs=1e-6)
        assert max(abs(ye - y) for _, ye, _, _ in pts) < 20


def test_field_scatter_of_a_flat_field_is_the_noise():
    c = synthetic_cut(rows=160, nx=400)
    s = L.field_scatter(c, 200.0, c.y0 + 80.0, L.R_AP, L.RINGS["ring15"])
    assert s["n"] == 20 and 0 < s["sd"] < 0.2 and s["mad"] is not None
    assert L.field_scatter(c, 200.0, c.y0 - 40.0, L.R_AP, L.RINGS["ring15"])["sd"] is None  # beyond the rows held


def test_measure_gives_both_rings_and_the_range_when_moved():
    c = synthetic_cut()
    c.data[80, 200] += 40.0
    ra, dec = (float(v) for v in c.wcs.all_pix2world(200.0, c.y0 + 80.0, 0))
    m = L.measure(c, ra, dec, jitter=True)
    r = m["rings"]["ring40"]
    assert set(m["rings"]) == {"ring40", "ring15"} and r["n_empty"] == 20 and m["beyond"] == pytest.approx(1.0, abs=0.01)
    assert r["lo"] <= r["flux"] <= r["hi"] and r["total"] == pytest.approx(math.hypot(r["err"], r["field"]))
    assert m["centre_offset"] < 0.2 and m["brightest"][0] < 0.01 and m["lam"] == pytest.approx(wave.wavelength_at(5, m["x"], m["y"])["lam"])


def test_an_aperture_with_too_many_flagged_pixels_has_no_flux():
    fl = np.full((160, 400), FLAG["FULLSAMPLE"], np.int32)
    fl[78:83, 198:201] |= FLAG["HOT"]
    c = synthetic_cut(flags=fl)
    ra, dec = (float(v) for v in c.wcs.all_pix2world(200.0, c.y0 + 80.0, 0))
    assert L.measure(c, ra, dec, scatter=False)["rings"]["ring40"] is None


# -- the contrast -----------------------------------------------------------------------------------


def test_contrast_takes_the_brightest_frame_of_the_night_and_the_nearest_neighbours():
    f = toy()
    c1, c2 = L.contrast(f, "feb25"), L.contrast(f, "feb26")
    assert (c1["peak"], c1["below"], c1["above"]) == ("a", "f", "c") and (c2["peak"], c2["below"], c2["above"]) == ("h", "f", "c")
    assert c1["contrast"] == pytest.approx(160.0 / 17.0) and c2["contrast"] == pytest.approx(263.0 / 17.0)
    e_mean = math.hypot(2.5, 1.5) / 2
    assert c2["err"] == pytest.approx(c2["contrast"] * math.hypot(5.0 / 263.0, e_mean / 17.0))
    assert L.contrast(f, "feb26", "ring40", "wide")["contrast"] == pytest.approx(c2["contrast"])
    assert L.contrast([m for m in f if m["lam"] < 4.32], "feb26") is None  # no frame above the band


def test_a_frame_without_a_flux_takes_no_part():
    f = toy()
    f[5]["rings"]["ring40"] = None
    assert L.contrast(f, "feb26")["below"] == "e"


def test_leave_one_out_names_roles_and_recomputes():
    rows = {r["left_out"]: r for r in L.leave_one_out(toy())}
    assert len(rows) == 9
    assert rows["a"]["role"] == "peak" and rows["h"]["role"] == "peak" and rows["f"]["role"] == "neighbour"
    assert rows["c"]["role"] == "neighbour" and rows["b"]["role"] == "other"
    assert rows["a"]["feb25"] == pytest.approx(50.0 / 17.0) and rows["a"]["feb25_peak"] == "b"
    assert rows["h"]["feb26"] == pytest.approx(136.0 / 17.0)
    assert rows["f"]["feb26"] == pytest.approx(263.0 / ((29.0 + 20.0) / 2))
    assert rows["b"]["feb25"] == pytest.approx(160.0 / 17.0)


def test_jitter_range_is_the_worst_and_the_best_case():
    lo, hi = L.jitter_range(toy(), "feb26")
    assert lo == pytest.approx(230.0 / ((15.0 + 21.0) / 2)) and hi == pytest.approx(270.0 / ((13.0 + 18.0) / 2))


def test_the_rules_of_the_two_rows():
    res = {"contrast": {"feb25": {"contrast": 9.6}, "feb26": {"contrast": 15.6}},
           "tests": [{"percent": 2.9, "sigma": 14.0, "peak": False}, {"percent": 0.2, "sigma": 1.0, "peak": True}]}
    assert L.rules_hold(res) == (True, True)
    res["contrast"]["feb25"]["contrast"] = 4.9
    res["tests"][0]["sigma"] = 4.0
    assert L.rules_hold(res) == (False, False)
    res["tests"] = [{"percent": 5.1, "sigma": 20.0, "peak": False}]
    assert L.rules_hold(res)[1] is False
    assert L.status_of(True, None) == "UNVERIFIED" and L.status_of(True, ("science reviewer", "2026-11-15")) == "PASS"
    assert L.status_of(False, None) == "FAIL" and L.status_of(False, ("science reviewer", "2026-11-15")) == "FAIL"


# -- placing, pictures ------------------------------------------------------------------------------


def test_one_frame_on_its_own_grid_is_itself_and_unusable_pixels_are_filled_for_pictures():
    fl = np.full((160, 400), FLAG["FULLSAMPLE"], np.int32)
    fl[80, 200] |= FLAG["TRANSIENT"]
    c = synthetic_cut(flags=fl)
    c.data[80, 200] = 500.0
    img, n = L.nearest_onto(c, 180, c.y0 + 60, 41, 41, c)
    assert n == 1 and img[20, 20] == pytest.approx(1.0, abs=0.05)  # the hit is drawn with its neighbours' median
    raw = c.window(c.data, 180, c.y0 + 60, 41, 41, np.nan)
    keep = np.ones((41, 41), bool)
    keep[20, 20] = False
    assert np.array_equal(img[keep], raw[keep]) and c.data[80, 200] == 500.0
    xs, ys = L.sky_map(c, 180, c.y0 + 60, 41, 41, c)
    assert np.allclose(xs[0], np.arange(180, 221), atol=1e-6) and np.allclose(ys[:, 0], c.y0 + 60 + np.arange(41), atol=1e-6)


def test_difference_of_a_frame_with_itself_is_zero_and_keeps_an_added_source():
    a, b = synthetic_cut(seed=5), synthetic_cut(seed=5)
    ra, dec = (float(v) for v in a.wcs.all_pix2world(200.0, a.y0 + 80.0, 0))
    d = L.difference_on(a, b, ra, dec)
    assert d["diff"].shape == (64, 64) and np.nanmax(np.abs(d["diff"])) < 5e-4  # the two backgrounds differ a little
    a.data[80, 200] += 2.0
    d = L.difference_on(a, b, ra, dec)
    assert d["diff"][32, 32] == pytest.approx(2.0, abs=0.01) and d["units"][32, 32] > 50


def test_display_rule_is_the_page_rule_and_ignores_a_flagged_peak():
    rs = np.random.default_rng(1)
    data = rs.normal(2.0, 0.1, (64, 64)).astype(np.float32)
    data[32, 32] = 55.0
    data[33, 32] = 300.0
    flags = np.zeros((64, 64), np.int32)
    flags[33, 32] = FLAG["TRANSIENT"]
    rule = D.display_rule([(data, flags, 32.2, 31.9)])
    sky, noise = D.sky_of(data, flags)
    assert rule["noise"] == pytest.approx(noise) and rule["black"] == pytest.approx(-2 * noise)
    assert rule["white"] == pytest.approx(55.0 - sky) and rule["soften"] == pytest.approx(3 * noise)
    assert D.display_rule([(data, None, 32.2, 31.9)])["white"] > 250  # without flags the hit would set white
    g = D.grey(np.array([rule["black"] - 1, rule["black"], 0.0, rule["white"], rule["white"] + 9, np.nan]), rule)
    assert g[0] == 0 and g[1] == 0 and g[3] == 1 and g[4] == 1 and 0 < g[2] < 0.5 and np.isnan(g[5])
    lo = math.asinh(rule["black"] / rule["soften"])
    assert g[2] == pytest.approx(-lo / (math.asinh(rule["white"] / rule["soften"]) - lo))


def test_projection_and_separation():
    e, n = L.project(np.array([150.0, 150.0, 150.1]), np.array([20.0, 20.5, 20.0]), 150.0, 20.0)
    assert e[0] == pytest.approx(0) and n[1] == pytest.approx(30.0, abs=0.01) and e[2] == pytest.approx(6 * math.cos(math.radians(20)), abs=0.01)
    assert L.separation_arcsec((150.0, 20.0), (150.0, 20.5)) == pytest.approx(1800.0, abs=1e-6)
    assert L.separation_arcsec((243.965226, -59.431252), (242.685679, -60.014159)) / 60 == pytest.approx(52.17, abs=0.01)


def test_visits_and_pairs_of_a_showcase_follow_the_shared_rules():
    mk = lambda mjd, lam: type("S", (), dict(key=f"k{mjd}", det=5, mjd=mjd, lam=lam, bw=0.037, y0=500, h=64))()
    stamps = [mk(60897.45, 4.273), mk(61097.860, 4.193), mk(61097.862, 4.229), mk(61097.864, 4.266)]
    vis = L.visit_numbers(stamps)
    assert vis == [0, 1, 1, 1] and L.matched_pairs(stamps, vis) == [(0, 3)]
    two_nights = [mk(61096.3, 4.23), mk(61097.86, 4.27)]
    assert L.visit_numbers(two_nights) == [0, 0] and L.matched_pairs(two_nights, [0, 0]) == []


def test_the_helper_module_is_not_a_job_that_does_anything():
    assert D.main([]) == 0


# -- what the job wrote -----------------------------------------------------------------------------


def on_disk():
    if not NUMBERS.exists() or not ROWS.exists():
        pytest.skip("run the lemmon job first")
    return json.loads(NUMBERS.read_text(encoding="utf-8")), {r["id"]: r for r in json.loads(ROWS.read_text(encoding="utf-8"))}


def test_numbers_on_disk():
    n, _ = on_disk()
    assert contracts.check_numbers(n) == []
    for k in ("lemmon.contrast.feb26", "lemmon.contrast.feb25", "lemmon.hero.aug", "lemmon.hero.off", "lemmon.hero.on"):
        assert k in n
    for night in ("feb25", "feb26"):
        c = n[f"lemmon.contrast.{night}"]
        assert c["value"] >= 5 and c["err"] > 0 and c["text"] == f"about {c['value']:.0f} times" and c["check"] == "K2"
        assert n[f"lemmon.contrast.{night}.ring2"]["value"] >= 5 and n[f"lemmon.contrast.{night}.wide"]["value"] >= 5
        assert n[f"lemmon.contrast.{night}.moved.low"]["value"] >= 5
    assert n["lemmon.contrast.feb26"]["value"] == pytest.approx(15.6, abs=0.1) and n["lemmon.contrast.feb25"]["value"] == pytest.approx(9.65, abs=0.1)
    assert n["lemmon.contrast.feb26.ring2"]["value"] == pytest.approx(16.7, abs=0.1) and n["lemmon.contrast.feb25.ring2"]["value"] == pytest.approx(10.2, abs=0.1)
    assert n["lemmon.contrast.lowest"]["value"] >= 5
    assert (n["lemmon.aperture.px"]["value"], n["lemmon.ring.inner.px"]["value"], n["lemmon.ring.outer.px"]["value"]) == (2, 40, 55)
    assert n["lemmon.aperture.arcsec"]["text"] == "12.3"
    assert n["lemmon.hero.on"]["value"] == pytest.approx(263.2, abs=0.1) and n["lemmon.hero.on.ring2"]["value"] == pytest.approx(260.2, abs=0.1)
    assert n["lemmon.hero.off.ring2"]["value"] == pytest.approx(12.6, abs=0.1) and n["lemmon.hero.off.lam"]["text"] == "4.193"
    assert n["lemmon.hero.aug.ring2"]["value"] == pytest.approx(0.4, abs=0.1) and n["lemmon.hero.aug"]["text"].startswith("+")
    assert n["lemmon.track.arcmin"]["value"] == pytest.approx(52.2, abs=0.05) and n["lemmon.track.hours"]["value"] == pytest.approx(37.5, abs=0.05)
    assert n["lemmon.track.offset.feb25"]["value"] < 0.45 and n["lemmon.track.offset.feb26"]["value"] < 0.45
    assert n["lemmon.above.day"]["text"] == "25 February" and n["lemmon.below.day"]["text"] == "26 February"
    assert n["lemmon.star.lam"]["text"] == "4.119" and n["lemmon.star.pixels"]["text"] == "1 to 2"
    assert n["lemmon.template.percent.largest"]["value"] < 5 and n["lemmon.template.sigma.smallest"]["value"] >= 5
    # the glow reaches the ring: the sky level keeps falling outwards round the comet and is level in August
    assert n["lemmon.glow.near"]["value"] > n["lemmon.glow.ring"]["value"] > n["lemmon.glow.beyond"]["value"]
    assert abs(n["lemmon.glow.aug.ring"]["value"] - n["lemmon.glow.aug.beyond"]["value"]) < 0.02


def test_reference_values_on_disk():
    """The in-band fluxes equal the earlier measurements within 0.1 mJy in both rings, but for the one frame
    whose aperture loses a pixel at the job's position (see MOVED)."""
    n, _ = on_disk()
    for ring, suffix in (("ring40", "flux"),):
        for obs, ref in L.REFERENCE[ring].items():
            v = n[f"lemmon.frame.{L.short_id(EARLIER[obs][0])}.{suffix}"]["value"]
            if obs == MOVED:
                assert v == pytest.approx(71.67, abs=0.1) and abs(v - ref) > 3
            else:
                assert v == pytest.approx(ref, abs=0.1), obs
    spec = json.loads((SITE / "lemmon" / "spectrum.json").read_text(encoding="utf-8"))
    by = {p["obs"]: p for p in spec["photos"]}
    for obs, ref in L.REFERENCE["ring15"].items():
        if obs == MOVED:
            assert by[obs]["flux_second_ring"] == pytest.approx(67.99, abs=0.1)
        else:
            assert by[obs]["flux_second_ring"] == pytest.approx(ref, abs=0.1), obs
    assert sum(p["flux"] is not None for p in spec["photos"]) == 15 and len(spec["photos"]) == 16
    assert all(p["pixels_used"] >= 0.6 * p["pixels_in_aperture"] for p in spec["photos"] if p["flux"] is not None)


def test_leave_one_out_on_disk():
    """5 or more on both nights whenever the frame left out is not a night's brightest; without the brightest
    frame of 26 February still above 5; without that of 25 February not (the next frame sits on the band's edge)."""
    spec = json.loads((SITE / "lemmon" / "spectrum.json").read_text(encoding="utf-8"))
    loo = spec["leave_one_out"]
    assert len(loo) == 15
    for r in loo:
        if r["role"] != "peak":
            assert r["feb25"] >= 5 and r["feb26"] >= 5, r
    peaks = {r["left_out"]: r for r in loo if r["role"] == "peak"}
    assert peaks["2026W09_2A_0075_3"]["feb26"] == pytest.approx(8.1, abs=0.1)
    assert peaks["2026W09_1A_0447_2"]["feb25"] == pytest.approx(3.1, abs=0.1)


def test_rows_on_disk():
    _, rows = on_disk()
    assert set(rows) == {"K2", "K3", "K3-corrected"}
    assert rows["K2"]["status"] in ("PASS", "UNVERIFIED") and rows["K3"]["status"] in ("PASS", "UNVERIFIED")
    assert rows["K3-corrected"]["status"] == "CORRECTED" and rows["K3-corrected"]["image"] is None
    for i in ("K2", "K3"):
        img = checks.DATA / "checks" / rows[i]["image"]
        assert img.name.startswith(i.lower() + "-") and hashlib.sha256(img.read_bytes()).hexdigest() == rows[i]["image_sha256"]
        assert rows[i]["rerun"] == "python -m sx.run lemmon"
    assert "40 to 55 pixels" in rows["K2"]["test"] and "12.3 arcsec" in rows["K2"]["test"] and "lower limits" in rows["K2"]["test"]
    for name in ("h1", "h2"):
        assert (ROOT / "review" / f"{name}.png").exists() and (ROOT / "review" / f"{name}.md").exists()


def test_showcases_on_disk_satisfy_the_contract():
    folder = SITE / "lemmon"
    if not (folder / "hero" / "manifest.json").exists():
        pytest.skip("run the lemmon job first")
    for name in ("hero", "strip", "templates"):
        assert contracts.check_showcase(folder / name) == [], name
    hero = json.loads((folder / "hero" / "manifest.json").read_text(encoding="utf-8"))
    lam = [round(f["lam"], 3) for f in hero["frames"]]
    assert lam == [4.273, 4.193, 4.229, 4.266, 4.302] and [f["visit"] for f in hero["frames"]] == [0, 1, 1, 1, 1]
    assert hero["pairs"] == [[0, 3]] and hero["det"] == 5 and (hero["w"], hero["h"]) == (64, 64)
    png = (folder / "hero" / "hero.png").read_bytes()
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 150_000
    assert int.from_bytes(png[16:20], "big") == 1000 and int.from_bytes(png[20:24], "big") == 328
    strip = json.loads((folder / "strip" / "manifest.json").read_text(encoding="utf-8"))
    assert len(strip["frames"]) == 11 and all(4.0 <= f["lam"] <= 4.45 for f in strip["frames"]) and strip["pairs"] == []
    tpl = json.loads((folder / "templates" / "manifest.json").read_text(encoding="utf-8"))
    assert len(tpl["pairs"]) == 5 and len(tpl["frames"]) == 10
    for a, b in tpl["pairs"]:
        fa, fb = tpl["frames"][a], tpl["frames"][b]
        assert fa["mjd"] < 60950 < fb["mjd"] and abs(fa["lam"] - fb["lam"]) <= 0.5 * min(fa["bw"], fb["bw"])
    track = json.loads((folder / "track.json").read_text(encoding="utf-8"))
    assert len(track["path"]) == 97 and len(track["places"]) == 2 and track["separation_arcmin"] == pytest.approx(52.2, abs=0.05)
    for p in track["places"]:
        pair = p["pair"]
        assert tpl["frames"][pair["late"]]["key"] == p["key"] and [pair["early"], pair["late"]] in tpl["pairs"]
    for name in ("strip/strip.png", "templates/templates.png", "track.png"):
        assert (folder / name).read_bytes()[:4] == b"\x89PNG"


def test_no_forbidden_word_in_what_the_job_wrote():
    n, rows = on_disk()
    texts = [v["text"] for v in n.values()] + [str(v) for r in rows.values() for v in r.values()]
    texts += [(ROOT / "review" / f).read_text(encoding="utf-8") for f in ("h1.md", "h2.md")]
    for t in texts:
        low = t.lower().replace('"only"', "").replace('"first"', "").replace('"discovery"', "")
        for word in ("only", "first", "discovery"):
            assert word not in low.replace("-", " ").split() and f" {word} " not in low, (word, t[:80])


# -- on real data -----------------------------------------------------------------------------------


@needs_network
def test_the_code_reproduces_the_earlier_fluxes_at_the_earlier_positions():
    """Done-means 1 in the sense that can hold for every value: at the positions the earlier measurements
    used, the shared readers and the shared aperture rule give their fluxes within 0.1 mJy, in both rings."""
    for obs, (key, ra, dec) in EARLIER.items():
        c = L.read_cut(key, ra, dec)
        x, y = c.pixel(ra, dec)
        for ring in ("ring15", "ring40"):
            if obs in L.REFERENCE[ring]:
                got = L.aperture(c, x, y, L.R_AP, L.RINGS[ring]).flux
                assert got == pytest.approx(L.REFERENCE[ring][obs], abs=0.1), (obs, ring)
    _, ra, dec = EARLIER["2026W09_2A_0075_3"]
    c = L.read_cut(AUGUST, ra, dec)
    x, y = c.pixel(ra, dec)
    assert L.aperture(c, x, y, L.R_AP, L.RINGS["ring15"]).flux == pytest.approx(0.4, abs=0.1)
    assert wave.wavelength_at(5, x, y)["lam"] == pytest.approx(4.273, abs=0.0005)


@needs_network
def test_the_job_measures_the_frozen_frames_as_reported():
    keys = frozen.load("lemmon")
    assert keys and len(keys) == 63
    ffs = s3.map_threads(FrameFile.open, keys)
    shots = L.comet_shots(ffs)
    assert len(shots) == 16 and sum(L.flux_of(m, "ring40") is not None for m in shots) == 15
    by = {m["obs"]: m for m in shots}
    for ring, ref in L.REFERENCE.items():
        for obs, want in ref.items():
            got = L.flux_of(by[obs], ring)
            if obs == MOVED:
                moved = L.separation_arcsec((by[obs]["ra"], by[obs]["dec"]), EARLIER[obs][1:])
                assert 0.4 < moved < 0.6 and abs(got - want) > 3 and by[obs]["rings"][ring]["n_ap"] == 13
            else:
                assert got == pytest.approx(want, abs=0.1), (obs, ring)
    assert by["2026W09_2A_0075_1"]["lam"] == pytest.approx(4.193, abs=0.0005)
    for night, want in (("feb26", 15.63), ("feb25", 9.65)):
        c = L.contrast(shots, night)
        assert c["contrast"] == pytest.approx(want, abs=0.05) and c["contrast"] >= 5 and 0.5 < c["err"] < 2.5
        assert (c["below"], c["above"]) == ("2026W09_2A_0075_1", "2026W09_1A_0550_1")
    tpl = L.template_shots(ffs, shots)
    assert {k: v["obs"] for k, v in tpl.items()} == {
        "2026W09_1A_0447_2": "2025W32_2D_0166_2", "2026W09_1A_0459_2": "2025W32_2D_0560_1",
        "2026W09_2A_0075_2": "2025W32_2D_0560_3", "2026W09_2A_0075_3": "2025W32_2D_0560_4",
        "2026W09_2A_0075_4": "2025W33_1B_0237_1"}
    tests = L.template_tests(shots, tpl)
    assert len(tests) == 5 and max(t["percent"] for t in tests) < 5 and min(t["sigma"] for t in tests if not t["peak"]) >= 5
    assert L.flux_of(tpl["2026W09_2A_0075_3"], "ring15") == pytest.approx(0.4, abs=0.1)
    assert all(abs(t["dlam"]) <= 0.5 * 0.0366 for t in tests)
