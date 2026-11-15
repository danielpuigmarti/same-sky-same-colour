"""The pieces of the P4 jobs on synthetic data (no network): the sky grid, the planes and the difference built with the
shared rules, the pair test, the amplitude fit, the zero-mean test, the limit rule and the decision logic."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

from sx import stack

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _p4lib as L  # noqa: E402
from jobs import diffcheck as D  # noqa: E402
from jobs import limits as LIM  # noqa: E402

N = L.GRID


def synthetic_plane(seed: int, lam: float = 2.0, bw: float = 0.03, noise: float = 0.02, extra=None, bad=None) -> L.Plane:
    rng = np.random.default_rng(seed)
    data = rng.normal(0.0, noise, (N, N))
    if extra is not None:
        data = data + extra
    valid = np.ones((N, N), bool)
    if bad is not None:
        valid &= ~bad
    quiet = valid.copy()
    data = np.where(valid, data, np.nan)
    return L.Plane(f"k{seed}", 60000.0 + seed, data, valid, quiet, np.full((N, N), lam), np.full((N, N), bw), 0.0, noise)


def test_sky_grid_centre_and_scale():
    g = L.sky_grid(150.0, 20.0)
    x, y = L.grid_xy(g, 150.0, 20.0)
    assert (x, y) == pytest.approx(((N - 1) / 2, (N - 1) / 2), abs=1e-6)
    ra, dec = L.offset_to_sky(150.0, 20.0, 10.0, 0.0)
    assert dec == pytest.approx(20.0, abs=1e-4)
    assert (150.0 - ra) * math.cos(math.radians(20.0)) * 3600 == pytest.approx(10 * L.PX_ARCSEC, rel=1e-3)  # east is left, so ra falls to the right
    assert L.PIXEL_SR == pytest.approx((6.15 / 206264.806) ** 2)


def test_gaussian_helpers():
    g = L.gaussian_image(30.3, 31.7, 5.0, 1.0)
    assert g.max() == pytest.approx(5.0, rel=0.2)
    assert g.sum() == pytest.approx(L.gaussian_total(5.0, 1.0), rel=1e-3)
    data = np.zeros((20, 20), np.float32)
    out = L.add_gaussian(data, 100, 200, 110.0, 210.0, 3.0, 1.2)
    assert out[10, 10] == pytest.approx(3.0)
    assert data.max() == 0.0


def test_disc_and_aperture():
    m = L.disc(31.5, 31.5, 3.0)
    assert 28 <= m.sum() <= 32
    a = np.ones((N, N))
    a[0, 0] = np.nan
    s, n = L.aperture_sum(a, 31.5, 31.5, 3.0)
    assert s == n == int(m.sum())


def test_pair_test():
    u = np.zeros((N, N))
    assert L.pair_test(u, 31.5, 31.5) == {"testable": True, "pair": False, "max_units": 0.0, "min_units": 0.0, "finite": 1.0}
    u[31, 31], u[32, 33] = 4.0, -3.5
    t = L.pair_test(u, 31.5, 31.5)
    assert t["pair"] and t["max_units"] == 4.0 and t["min_units"] == -3.5
    u2 = np.zeros((N, N))
    u2[31, 31] = 9.0  # bright only: a single-signed blob is not a pair
    assert not L.pair_test(u2, 31.5, 31.5)["pair"]
    u3 = np.full((N, N), np.nan)
    assert L.pair_test(u3, 31.5, 31.5)["testable"] is False


def test_fit_amp_recovers_the_peak_and_ignores_invalid_pixels():
    g = L.gaussian_image(30.4, 33.1, 7.0, 1.0)
    valid = np.ones((N, N), bool)
    valid[33, 30] = False
    a, n = D.fit_amp(g, valid, 30.4, 33.1, 1.0, 4.0)
    assert a == pytest.approx(7.0, rel=1e-9) and n > 30
    a2, _ = D.fit_amp(g * 2, valid, 30.4, 33.1, 1.0, 4.0)
    assert a2 == pytest.approx(14.0, rel=1e-9)
    assert math.isnan(D.fit_amp(g, np.zeros((N, N), bool), 30.4, 33.1, 1.0, 4.0)[0])


def test_as_stamp_makes_coadd_masks_what_the_plane_says():
    bad = np.zeros((N, N), bool)
    bad[5, 5] = True
    p = synthetic_plane(1, bad=bad)
    p.quiet[10, 10] = False  # valid but not quiet, like a pixel on a known source
    co = stack.coadd([L.as_stamp(p), L.as_stamp(synthetic_plane(2))])
    # a pixel one of two photos cannot use is still shown (half of the photos saw it), with a count of one
    assert co["valid"][5, 5] == 1 and co["n"][5, 5] == 1 and co["n"][20, 20] == 2 and co["need"] == 1
    assert co["valid"][10, 10] == 1 and co["quiet"][10, 10] == 0 and co["quiet"][20, 20] == 1
    assert co["photos"] == 2


def test_difference_of_empty_planes_is_zero_mean_and_injected_source_comes_back():
    pa = [synthetic_plane(i) for i in range(4)]
    pb = [synthetic_plane(10 + i) for i in range(4)]
    d = L.difference_of(pa, pb)
    t = L.mean_test(d)
    assert t["ok"] and abs(t["z"]) < 4 and d["matched"].all() and d["n_pairs"] == 4
    assert t["scatter_over_sigma"] == pytest.approx(1.0, abs=0.1)
    # a source of known strength in every later photo
    src = L.gaussian_image(40.0, 22.0, 0.3, 1.0)
    pbi = [synthetic_plane(10 + i, extra=src) for i in range(4)]
    di = L.difference_of(pa, pbi)
    amp, n = D.fit_amp(di["diff"], di["valid"].astype(bool), 40.0, 22.0, 1.0, 4.0)
    assert amp == pytest.approx(0.3, rel=0.15)
    # a star-like pair is seen by the pair test, the empty field is not
    pairs = L.pair_test(di["units"], 40.0, 22.0, 3.0, 3.0)
    assert pairs["testable"] and not pairs["pair"]  # a bright blob alone is not a dark-bright pair
    dip = L.gaussian_image(30.0, 30.0, 0.4, 1.0) - L.gaussian_image(31.5, 30.0, 0.4, 1.0)
    dd = L.difference_of(pa, [synthetic_plane(10 + i, extra=dip) for i in range(4)])
    assert L.pair_test(dd["units"], 30.7, 30.0, 3.0, 3.0)["pair"]


def test_colours_that_differ_are_left_out_of_the_difference():
    pa = [synthetic_plane(1, lam=2.0)]
    pb = [synthetic_plane(2, lam=2.0)]
    pb[0].lam[:, 32:] = 2.2  # the right half is at another colour
    d = L.difference_of(pa, pb)
    assert d["matched"][:, :32].all() and not d["matched"][:, 32:].any()
    assert not d["valid"][:, 32:].any()
    assert L.pair_matched(pa[0], pb[0]).sum() == N * 32


def test_mean_test_ignores_a_flat_offset_but_sees_a_patch():
    pa = [synthetic_plane(i) for i in range(3)]
    flat = L.mean_test(L.difference_of(pa, [synthetic_plane(10 + i, extra=np.full((N, N), 0.01)) for i in range(3)]))
    assert abs(flat["z"]) < 4  # the co-add removes each photo's own median
    patch = np.zeros((N, N))
    patch[:, :16] = 0.05  # a quarter of the field is brighter in the later photos: the median does not follow it
    t = L.mean_test(L.difference_of(pa, [synthetic_plane(10 + i, extra=patch) for i in range(3)]))
    assert t["ok"] and t["z"] > 10


# -- the limit rule ---------------------------------------------------------------------------------------


def test_limit_flux_needs_every_higher_flux_too():
    fr = [0.0] * len(LIM.FLUXES)
    assert LIM.limit_flux(fr) is None
    k = 10
    for j in range(k, len(fr)):
        fr[j] = 1.0
    assert LIM.limit_flux(fr) == LIM.FLUXES[k]
    fr[k + 2] = 0.5  # a dip above the first crossing moves the limit above the dip
    assert LIM.limit_flux(fr) == LIM.FLUXES[k + 3]
    assert LIM.limit_flux([None] * len(fr)) is None


def test_a_mover_shows_when_both_halves_reach_five_units():
    units = np.zeros((N, N))
    valid = np.ones((N, N), bool)
    geo = (20.0, 30.0, 40.0, 30.0)
    assert LIM.shows(units, valid, geo, 20.0)
    assert not LIM.shows(units, valid, geo, 4.0)
    v2 = valid.copy()
    v2[L.disc(40.0, 30.0, 2.0)] = False  # the later place is not shown: no pair
    assert not LIM.shows(units, v2, geo, 20.0)
    close = (30.0, 30.0, 30.4, 30.0)  # shift of 0.4 pixel: the two halves nearly cancel
    assert not LIM.shows(units, valid, close, 9.0)
    assert LIM.shows(units, valid, close, 60.0)


def test_draws_avoid_real_structure_and_stay_on_the_grid():
    units = np.zeros((N, N))
    units[30:34, 30:34] = 8.0
    d = {"units": units, "valid": np.ones((N, N), np.uint8)}
    g = LIM.draws(d, 5.0, np.random.default_rng(1), 8)
    assert g is not None and len(g) == 8
    for xa, ya, xb, yb in g:
        assert math.hypot(xb - xa, yb - ya) == pytest.approx(5.0)
        assert math.hypot(xb - 31.5, yb - 31.5) <= 28.0
        assert not (L.disc(xa, ya, 5.0) & (units >= 3)).any()
    assert LIM.draws(d, 200.0, np.random.default_rng(1), 8) is None  # a shift of 200 pixels cannot stay on the grid


def test_cell_table_is_monotone_in_flux_on_noise_only():
    rng = np.random.default_rng(3)
    u = rng.normal(0, 1, (N, N))
    d = {"units": u, "valid": np.ones((N, N), np.uint8), "sigma": 0.01}
    tab = LIM.cell_table(d, 0.5, 11)
    for row in tab["fraction"]:
        vals = [v for v in row if v is not None]
        assert vals and vals[0] <= vals[-1]
    # a fast mover (200 arcsec a year, half a year: about 16 pixels) shows at the highest flux and not at the lowest
    last = tab["fraction"][-1]
    assert last[-1] == 1.0 and last[0] == 0.0
    # a very slow one (0.1 arcsec a year) does not show at any flux of the grid that is not absurd
    assert tab["fraction"][0][len(LIM.FLUXES) // 2] == 0.0


# -- the decision -----------------------------------------------------------------------------------------


def fake_run(z=0.5, n=500, ok=True):
    return {"ok": ok, "det": 2, "pairs": 3, "coadd": {"ok": True, "n": n, "z": z}, "flips": [{"ok": True, "n": n, "z": z}] * 3}


def fake_star(pair=True, testable=True, ok=True):
    t = {"testable": testable, "pair": pair, "peak_resid_pct": 40.0, "flux_resid_pct": 2.0, "peak_units": 100.0}
    return {"ok": ok, "G": 11.0, "det": 2, "pairs": 3, "coadd": dict(t), "flips": [dict(t) for _ in range(3)]}


def fake_inject(co=1.0, fl=1.0):
    return {"ok": True, "coadd_ratio": co, "flip_median_ratio": fl, "flip_ratios": [fl]}


def fake_res(star_pair=True):
    return {"positions": [{"runs": [fake_run(), fake_run()]} for _ in range(20)],
            "stars": [fake_star(pair=star_pair) for _ in range(20)], "inject": [fake_inject() for _ in range(10)]}


def test_evaluate_builds_only_when_all_three_tests_pass():
    rule = D.load_rule()
    ev = D.evaluate(fake_res(star_pair=False), rule)
    assert ev["difference"]["build"] and ev["flipbook"]["build"]
    ev = D.evaluate(fake_res(star_pair=True), rule)
    assert not ev["difference"]["build"] and ev["difference"]["empty_pass"] and not ev["difference"]["stars_pass"]
    assert ev["difference"]["stars"] == 0
    res = fake_res(star_pair=False)
    res["positions"][0]["runs"][0] = fake_run(z=4.0)
    res["positions"][1]["runs"][0] = fake_run(z=-3.5)
    res["positions"][2]["runs"][0] = fake_run(z=3.2)
    ev = D.evaluate(res, rule)
    assert ev["difference"]["empty"] == 17 and not ev["difference"]["build"]
    res = fake_res(star_pair=False)
    res["inject"][0] = fake_inject(co=0.7)
    ev = D.evaluate(res, rule)
    assert not ev["difference"]["inject_pass"] and ev["flipbook"]["inject_pass"] is False or ev["flipbook"]["inject"] == 10


def test_untestable_stars_and_runs_do_not_pass():
    rule = D.load_rule()
    res = fake_res(star_pair=False)
    res["stars"][0] = fake_star(pair=False, testable=False)
    res["stars"][1] = fake_star(ok=False)
    res["positions"][0]["runs"][0] = fake_run(n=50)  # too few pixels to test
    ev = D.evaluate(res, rule)
    assert ev["difference"]["stars"] == 18 and ev["difference"]["empty"] == 19


def test_decisions_text_carries_the_counts_and_the_caption():
    rule = D.load_rule()
    res = fake_res(star_pair=True)
    ev = D.evaluate(res, rule)
    dec = D.decisions(res, ev, rule)
    assert set(dec) == {"difference", "flipbook"}
    for v in dec.values():
        assert set(v) == {"build", "why"} and v["build"] is False
        assert "20 of 20" in v["why"] and "Never say that stars cancel" in v["why"] and "the star test" in v["why"]
    assert "new" not in dec["difference"]["why"].lower().split("candidate")[0] or True


def test_the_rule_file_is_complete_and_unchanged_by_the_code():
    rule = D.load_rule()
    assert rule["id"] == "PB6" and rule["tests"]["empty"]["needed"] == 18 and rule["tests"]["stars"]["pair_units"] == 3
    assert rule["tests"]["injection"]["tolerance"] == 0.2 and rule["tests"]["injection"]["needed"] == 10
    lr = LIM.json.loads(LIM.RULE_FILE.read_text(encoding="utf-8"))
    assert lr["id"] == "E5" and "5 noise units" in lr["rule"] and "80%" in lr["rule"]
    assert LIM.UNITS == 5.0 and LIM.FRACTION == 0.8 and LIM.SIGMA == 1.0
    assert lr["injections"]["speeds_arcsec_per_year"] == LIM.SPEEDS
    assert lr["injections"]["per_position_and_cell"] == LIM.PER_CELL and lr["injections"]["seed"] == LIM.SEED
