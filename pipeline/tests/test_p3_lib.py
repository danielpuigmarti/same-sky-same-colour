"""The pieces of the jobs targets, motion, rwaur and gaia_fast on made-up data and known answers. No network."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest
from scipy.special import erf

from sx import gaia, match, phot

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402
from jobs import gaia_fast, motion, rwaur, targets  # noqa: E402
from jobs._rwaur_stars import STARS  # noqa: E402


def star(shape, x, y, sigma=0.7, amp=100.0, bg=2.0):
    """A Gaussian star integrated over each pixel, on a flat background: what a detector records."""
    yy, xx = np.mgrid[: shape[0], : shape[1]].astype(float)
    k = sigma * math.sqrt(2)
    gx = 0.5 * (erf((xx + 0.5 - x) / k) - erf((xx - 0.5 - x) / k))
    gy = 0.5 * (erf((yy + 0.5 - y) / k) - erf((yy - 0.5 - y) / k))
    return bg + amp * 2 * math.pi * sigma * sigma * gx * gy


# -- where the catalogue puts a star -------------------------------------------------------------------


def gcrs_reading(cat, mjd):
    """The same position a second way: the direction of the star seen from the Earth's centre (GCRS) minus that of
    a star in the same direction infinitely far away. Aberration and light bending cancel; the parallax stays."""
    from astropy import units as u
    from astropy.coordinates import GCRS, SkyCoord
    from astropy.time import Time

    kw = {"radial_velocity": cat["rv"] * u.km / u.s} if cat.get("rv") is not None else {}
    c = SkyCoord(ra=cat["ra"] * u.deg, dec=cat["dec"] * u.deg, distance=(1000 / cat["parallax"]) * u.pc,
                 pm_ra_cosdec=cat["pmra"] * u.mas / u.yr, pm_dec=cat["pmdec"] * u.mas / u.yr,
                 obstime=Time(cat["epoch"], format="jyear", scale="tcb"), **kw)
    t = Time(np.asarray(mjd, float), format="mjd", scale="utc")
    s = c.apply_space_motion(new_obstime=t)
    near = SkyCoord(ra=s.ra, dec=s.dec, distance=s.distance).transform_to(GCRS(obstime=t))
    far = SkyCoord(ra=s.ra, dec=s.dec, distance=1e9 * u.pc).transform_to(GCRS(obstime=t))
    return s.ra.deg + ((near.ra - far.ra).deg + 180) % 360 - 180, s.dec.deg + (near.dec - far.dec).deg


@pytest.mark.parametrize("tid", ["barnard", "eps-indi-b", "wise0855"])
def test_predict_agrees_with_a_second_reading_by_astropy(tid):
    cat = T.targets()[tid]["catalogue"]
    mjd = np.array([55400.0, 60800.0, 60990.0, 61041.0, 61160.0])
    ra, dec = T.predict(cat, mjd)
    ra2, dec2 = gcrs_reading(cat, mjd)
    off = np.hypot(*T.offset_arcsec(ra, dec, ra2, dec2))
    assert off.max() < 0.001  # arcsec


@pytest.mark.parametrize("tid", ["barnard", "eps-indi-b", "wise0855"])
def test_predict_at_2026_is_the_listed_position_moved_by_the_parallax(tid):
    e = T.targets()[tid]
    ra, dec = T.predict(e["catalogue"], e["mjd"])
    off = float(np.hypot(*T.offset_arcsec(e["ra"], e["dec"], ra, dec)))
    assert off <= e["catalogue"]["parallax"] / 1000 * 1.02 + 0.002


def test_predict_takes_a_number_or_an_array():
    cat = T.targets()["barnard"]["catalogue"]
    one = T.predict(cat, 61000.0)
    many = T.predict(cat, [61000.0, 61001.0])
    assert isinstance(one[0], float) and many[0].shape == (2,) and one[0] == pytest.approx(many[0][0], abs=1e-12)


def test_barnard_moves_about_ten_arcsec_a_year_northwards():
    cat = T.targets()["barnard"]["catalogue"]
    a, b = T.predict(cat, 60000.0), T.predict(cat, 60000.0 + 365.25)
    east, north = T.offset_arcsec(*a, *b)
    assert north == pytest.approx(10.36, abs=0.05) and east == pytest.approx(-0.80, abs=0.05)


def test_offset_arcsec():
    assert T.offset_arcsec(10.0, 20.0, 10.0, 20.0 + 1 / 3600) == pytest.approx((0.0, 1.0), abs=1e-9)
    east, north = T.offset_arcsec(10.0, 60.0, 10.0 + 2 / 3600, 60.0)
    assert east == pytest.approx(1.0, abs=1e-6) and abs(north) < 1e-4


# -- centroids -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("x,y", [(20.0, 20.0), (20.31, 19.62), (19.5, 20.5), (20.49, 20.02)])
def test_fit_gauss_finds_a_star_between_pixels(x, y):
    g = T.fit_gauss(star((41, 41), x, y), 20.0, 20.0)
    assert g["x"] == pytest.approx(x, abs=0.05) and g["y"] == pytest.approx(y, abs=0.05)


def test_fit_gauss_agrees_with_the_shared_centroid():
    img = star((41, 41), 20.3, 19.7)
    g, c = T.fit_gauss(img, 20.0, 20.0), gaia.centroid(img, 20.0, 20.0)
    assert g["x"] == pytest.approx(c[0], abs=0.01) and g["y"] == pytest.approx(c[1], abs=0.01)


def test_fit_gauss_leaves_out_missing_pixels_and_gives_up_without_enough():
    img = star((41, 41), 20.3, 19.7)
    holes = img.copy()
    holes[18, 22] = holes[21, 18] = np.nan
    g = T.fit_gauss(holes, 20.0, 20.0)
    assert g["n"] == 47 and g["x"] == pytest.approx(20.3, abs=0.06)
    holes[17:21, 17:24] = np.nan
    assert T.fit_gauss(holes, 20.0, 20.0) is None
    assert T.fit_gauss(np.full((41, 41), np.nan), 20.0, 20.0) is None
    assert T.fit_gauss(img, 2.0, 2.0) is None  # too near the edge for the box


def test_fit_gauss_with_a_fixed_neighbour_is_not_pulled_by_it():
    img = star((41, 41), 20.2, 20.1, amp=100) + star((41, 41), 21.4, 20.1, amp=40, bg=0)
    alone = T.fit_gauss(img, 20.2, 20.1, half=2)
    both = T.fit_gauss(img, 20.2, 20.1, half=2, fixed=[(21.4, 20.1)])
    assert abs(both["x"] - 20.2) < 0.1 < abs(alone["x"] - 20.2)
    assert both["fixed_amp"][0] / both["amp"] == pytest.approx(0.4, abs=0.15)


def saturated_star(x, y, shape=(121, 121)):
    """A bright star whose core is spoiled the way a saturated one is: wide wings round (x, y), and a core that is
    flat with its brightest part a few pixels to one side."""
    yy, xx = np.mgrid[: shape[0], : shape[1]].astype(float)
    r = np.hypot(xx - x, yy - y)
    img = 3.0 + 4000.0 / (1.0 + (r / 4.0) ** 2) ** 1.5
    core = r < 7
    img[core] = 600.0 + 250.0 * np.exp(-0.5 * ((xx[core] - x) ** 2 + (yy[core] - y - 4.5) ** 2) / 2.0**2)
    return img


def test_the_wings_give_the_centre_of_a_star_whose_core_is_spoiled():
    img = saturated_star(60.3, 59.6)
    g = T.fit_gauss(img, 60.3, 59.6, search=4.0, half=5, sigma0=2.0)
    assert math.hypot(g["x"] - 60.3, g["y"] - 59.6) > 1.5  # the fit is pulled to the bright side of the core
    sky = (46.0, 58.0)
    x, y, steps = T.wings_centre(img, g["x"], g["y"], 9.0, 18.0, sky)
    assert (x, y) == pytest.approx((60.3, 59.6), abs=0.1) and steps < 20
    # from another start it settles at the same place
    x2, y2, _ = T.wings_centre(img, 66.0, 54.0, 9.0, 18.0, sky)
    assert (x2, y2) == pytest.approx((x, y), abs=0.05)


def test_the_wings_give_nothing_where_there_is_no_light_or_no_settling():
    assert T.wings_centre(np.full((81, 81), 5.0), 40.0, 40.0, 9.0, 18.0, (30.0, 38.0)) is None
    assert T.wings_centre(np.full((81, 81), np.nan), 40.0, 40.0, 9.0, 18.0, (30.0, 38.0)) is None
    assert T.wings_centre(saturated_star(60.3, 59.6), 20.0, 20.0, 9.0, 18.0, (46.0, 58.0), max_steps=2) is None


def test_clipped_mean_drops_what_stands_far_out():
    mean, err, n = T.clipped_mean([1.0, 1.1, 0.9, 1.05, 0.95, 9.0])
    assert n == 5 and mean == pytest.approx(1.0, abs=0.01) and 0 < err < 0.1
    assert T.clipped_mean([])[2] == 0 and math.isnan(T.clipped_mean([2.0])[1])


def test_visit_position_needs_three_frames():
    rows = [{"dE": 0.1, "dN": -0.2, "mjd": 61000.0 + i} for i in range(2)]
    assert T.visit_position(rows) is None
    v = T.visit_position(rows + [{"dE": 0.3, "dN": -0.4, "mjd": 61002.0}])
    assert v["dE"] == pytest.approx(0.5 / 3) and v["mjd"] == 61001.0 and v["n"] == 3


# -- sky grid and co-adds ------------------------------------------------------------------------------


def test_sky_grid_has_north_up_and_east_to_the_left():
    g = T.sky_grid(100.0, -30.0, 11, 6.15)
    assert g.all_pix2world(5, 5, 0) == pytest.approx((100.0, -30.0))
    east, north = T.offset_arcsec(100.0, -30.0, *g.all_pix2world(5, 6, 0))
    assert (east, north) == pytest.approx((0.0, 6.15), abs=1e-6)
    east, north = T.offset_arcsec(100.0, -30.0, *g.all_pix2world(4, 5, 0))
    assert (east, north) == pytest.approx((6.15, 0.0), abs=1e-4)


def test_coadd_centroid_takes_every_plane_by_the_shared_rule_or_only_the_clean_ones_and_recovers_a_shift():
    rs = np.random.default_rng(3)

    def visit(x, y, n, holes):
        planes = []
        for i in range(n):
            p = star((31, 31), x, y, amp=30, bg=0.0) + rs.normal(0, 1.0, (31, 31))
            if i < holes:
                p[int(round(y)), int(round(x)) + 1] = np.nan
            planes.append(p)
        return planes

    with_holes = visit(15.2, 15.1, 12, 4)
    a = T.coadd_centroid(with_holes, 15.2, 15.1, n_boot=60)
    b = T.coadd_centroid(visit(15.9, 15.3, 12, 0), 15.9, 15.3, n_boot=60)
    assert a["n"] == 12 and b["n"] == 12  # a plane with a hole still gives its other pixels
    assert (b["x"] - a["x"]) == pytest.approx(0.7, abs=0.12) and (b["y"] - a["y"]) == pytest.approx(0.2, abs=0.12)
    assert 0 < a["ex"] < 0.2 and a["snr"] > 20
    strict = T.coadd_centroid(with_holes, 15.2, 15.1, n_boot=60, clean=True)
    assert strict["n"] == 8 and (strict["x"], strict["y"]) == pytest.approx((a["x"], a["y"]), abs=0.1)
    assert T.coadd_centroid(visit(15.2, 15.1, 6, 3), 15.2, 15.1, n_boot=20, clean=True) is None  # three clean planes: too few
    assert T.coadd_centroid(visit(15.2, 15.1, 6, 3), 15.2, 15.1, n_boot=20)["n"] == 6


# -- the rule of the motion check ----------------------------------------------------------------------

RULE = {"nonzero_sigma": 3, "within_sigma": 3}
CONTROL = {"n": 12, "mean_E": 0.05, "mean_N": -0.02, "sem_E": 0.05, "sem_N": 0.05, "scatter_E": 0.2, "scatter_N": 0.2}


def test_judge_builds_when_the_shift_is_clear_and_agrees():
    j = motion.judge((4.0, -2.5), (0.1, 0.1), (3.97, -2.45), CONTROL, RULE)
    assert j["build"] and j["significance"] > 10 and all(abs(o) < 1 for o in j["off_sigma"])
    assert j["err"][0] == pytest.approx(math.hypot(0.1, 0.2))


def test_judge_does_not_build_a_shift_that_is_not_clear_or_does_not_agree_or_has_no_control():
    assert not motion.judge((0.5, 0.1), (0.3, 0.3), (0.6, 0.1), CONTROL, RULE)["build"]  # not 3 sigma from zero
    assert not motion.judge((4.0, -2.5), (0.1, 0.1), (3.0, -2.5), CONTROL, RULE)["build"]  # east is 4.5 sigma off
    none = motion.control_summary([(0.1, 0.1), (0.0, 0.2)])
    assert math.isnan(none["scatter_E"]) and not motion.judge((4.0, -2.5), (0.1, 0.1), (3.97, -2.45), none, RULE)["build"]
    moved = dict(CONTROL, mean_E=2.0)
    assert not motion.judge((4.0, -2.5), (0.1, 0.1), (3.97, -2.45), moved, RULE)["build"]


def test_control_summary_gives_the_scatter_both_ways():
    c = motion.control_summary([(0.1, 0.0), (-0.1, 0.1), (0.0, -0.1), (0.05, 0.05), (-0.05, 0.0), (8.0, 0.0)])
    assert c["n"] == 6 and c["scatter_E"] < 0.3 < 3 < c["plain_E"]  # one wild star: the robust scatter holds, the plain one does not
    assert c["plain_N"] == pytest.approx(np.std([0.0, 0.1, -0.1, 0.05, 0.0, 0.0], ddof=1))


def test_judge_builds_only_if_the_rule_holds_with_the_plain_scatter_too():
    args = ((4.0, -2.5), (0.1, 0.1), (3.97, -2.45))
    mild = motion.judge(*args, dict(CONTROL, plain_E=0.5, plain_N=0.3), RULE)
    assert mild["build"] and mild["plain"]["significance"] < mild["significance"]
    wild = motion.judge(*args, dict(CONTROL, plain_E=2.5, plain_N=0.2), RULE)
    assert wild["nonzero"] and wild["within"] and not wild["plain"]["nonzero"] and not wild["build"]
    # the numbers given stay those of the robust scatter
    assert wild["err"] == mild["err"] and wild["significance"] == mild["significance"]


def test_good_star_needs_a_tenth_of_a_pixel():
    assert motion.good_star({"eE": 0.3, "eN": 0.5}) and not motion.good_star({"eE": 0.3, "eN": 0.7})
    assert not motion.good_star(None) and not motion.good_star({"eE": math.nan, "eN": 0.1})


# -- RW Aurigae ----------------------------------------------------------------------------------------

OMEGA = 8.9e-10


def source(x=13.0, y=13.0, amp=400.0, flagged=(), sigma=0.75):
    sub = star((27, 27), x, y, sigma=sigma, amp=amp, bg=5.0).astype(np.float32)
    sf = np.zeros((27, 27), np.int32)
    for fx, fy in flagged:
        sf[fy, fx] = phot.FLAG["OVERFLOW"]
    return rwaur.measure_source(sub, sf, x, y, OMEGA)


def test_ring_from_zero_holds_the_whole_star():
    rec = source()
    total = 400.0 * 2 * math.pi * 0.75**2 * OMEGA * 1e9
    assert rwaur.ring_flux(rec, 0.0) == pytest.approx(total, rel=0.01)
    assert rec["f_all"] == pytest.approx(total, rel=0.02) and rec["n_core"] == 0 and rec["r_flag"] == 0.0


def test_ring_flux_changes_by_a_few_percent_with_where_the_star_sits_in_its_pixel():
    # a pixel counts by the share of its area in the ring, as if the light were even across it. Near a star it is
    # not, so the ring flux depends on where the star sits in its pixel: noise in a pair, a few percent, no bias
    for radius in (0.75, 1.5, 2.5):
        v = np.array([rwaur.ring_flux(source(13.0 + dx, 13.0 + dy), radius) for dx in (-0.4, 0.0, 0.4) for dy in (-0.4, 0.0, 0.4)])
        assert v.std() / v.mean() < 0.05 and v.max() / v.min() < 1.2


def test_mask_radius_holds_every_flagged_pixel_of_either_aperture():
    clean, hit = source(), source(flagged=[(13, 13), (14, 13)])
    assert rwaur.mask_radius(clean, clean) == 0.0
    r = rwaur.mask_radius(clean, hit)
    assert r == rwaur.mask_radius(hit, clean) == pytest.approx(1.0 + rwaur.EDGE, abs=0.05) and r >= 1.0 + rwaur.EDGE
    # with that radius the flagged pixels have no share in the ring, and the ring can be measured
    assert np.isfinite(rwaur.ring_flux(hit, r))
    assert math.isnan(rwaur.ring_flux(hit, 0.0))  # a flagged pixel of the aperture inside the ring


def test_a_brighter_star_gives_the_same_ratio_with_or_without_the_mask():
    a, b = source(13.2, 12.9, amp=400.0), source(12.8, 13.3, amp=520.0)
    assert b["f_all"] / a["f_all"] == pytest.approx(1.3, abs=0.03)
    assert rwaur.ring_flux(b, 1.5) / rwaur.ring_flux(a, 1.5) == pytest.approx(1.3, abs=0.1)


def test_a_flagged_pixel_outside_the_aperture_is_left_out_and_made_up_for():
    plain, hit = source(), source(flagged=[(17, 13)])  # 4 pixels from the star: in the ring, not in the aperture
    assert hit["n_core"] == 0
    assert rwaur.ring_flux(hit, 1.5) == pytest.approx(rwaur.ring_flux(plain, 1.5), rel=0.05)


def frames(lams, bw=0.02, det=3):
    return [{"det": det, "lam": l, "bw": bw} for l in lams]


def test_all_pairs_is_the_match_rule_without_its_limit():
    a = frames([1.700 + 0.03 * i for i in range(12)])
    b = frames([1.702 + 0.03 * i for i in range(12)][::-1])
    capped, every = match.match_pairs(a, b), rwaur.all_pairs(a, b)
    assert len(capped) == 8 and len(every) == 12 and every[:8] == capped
    assert len({i for i, _ in every}) == 12 and len({j for _, j in every}) == 12
    assert all(abs(a[i]["lam"] - b[j]["lam"]) <= 0.01 for i, j in every)
    assert rwaur.all_pairs(a, frames([3.0])) == []


def test_median_change_and_its_error():
    med, err, n = rwaur.median_change([1.2, 1.25, 1.3, 1.22, 1.28, math.nan, -1.0])
    assert n == 5 and med == pytest.approx(1.25) and 0 < err < 0.05
    assert rwaur.median_change([]) == pytest.approx((math.nan, math.nan, 0), nan_ok=True)
    assert rwaur.median_change([1.1])[2] == 1 and math.isnan(rwaur.median_change([1.1])[1])


def band(all_=(1.25, 0.03, 16), mask=(1.22, 0.05, 12), comp=(0.996, 0.01, 150), clean=(1.5, 0.1, 4)):
    return {"n": all_[2], "all": all_, "mask": mask, "clean": clean, "comp_mask": comp, "comp_stars": 14, "radius": 1.5}


def test_decide_follows_the_written_rule():
    assert rwaur.decide(band(), 1.0)[0]
    build, why = rwaur.decide(band(mask=(0.97, 0.05, 12)), 1.0)
    assert not build and "sign does not hold" in why and "too bright to measure reliably" in why.lower()
    build, why = rwaur.decide(band(comp=(0.985, 0.01, 150)), 1.0)
    assert not build and "comparison stars are not flat" in why
    assert not rwaur.decide(band(mask=(1.3, math.nan, 1)), 1.0)[0]  # too few pairs under the mask
    assert not rwaur.decide(band(all_=(math.nan, math.nan, 0)), 1.0)[0]


def test_swing_and_meter():
    assert rwaur.swing([2.0, 4.0, 3.0, 1.0, 2.5]) == 4.0 and math.isnan(rwaur.swing([1.0, 2.0]))
    assert rwaur.meter({"target": 50.0, "a": 2.0, "b": 4.0, "c": math.nan}) == (3.0, 2)


def test_the_comparison_stars_are_twenty_gaia_stars_near_rw_aurigae():
    e = T.targets()["rw-aur"]
    assert len(STARS) == 20 and len({s["source_id"] for s in STARS}) == 20
    for s in STARS:
        sep = float(np.hypot(*T.offset_arcsec(e["ra"], e["dec"], s["ra"], s["dec"]))) / 60
        assert 4 < sep < 130 and 9 < s["phot_g_mean_mag"] < 14 and set(s) >= {"pmra", "pmdec"}


# -- the fast stars ------------------------------------------------------------------------------------


def test_fast_star_selection_keeps_real_movers_only():
    rows = [
        {"source_id": 2, "ra": 20.123456789, "dec": -5.0, "pmra": 400.0, "pmdec": 400.0, "parallax": 50.0, "phot_g_mean_mag": 12.345, "parallax_over_error": 200.0},
        {"source_id": 1, "ra": 10.0, "dec": 5.0, "pmra": -600.0, "pmdec": 10.0, "parallax": 20.0, "phot_g_mean_mag": None, "parallax_over_error": 50.0},
        {"source_id": 3, "ra": 30.0, "dec": 5.0, "pmra": 900.0, "pmdec": 0.0, "parallax": 0.3, "phot_g_mean_mag": 20.0, "parallax_over_error": 0.8},
        {"source_id": 4, "ra": 40.0, "dec": 5.0, "pmra": 300.0, "pmdec": 300.0, "parallax": 30.0, "phot_g_mean_mag": 10.0, "parallax_over_error": 99.0},
        {"source_id": 5, "ra": 50.0, "dec": 5.0, "pmra": 700.0, "pmdec": 0.0, "parallax": None, "phot_g_mean_mag": 10.0, "parallax_over_error": None},
    ]
    stars = gaia_fast.select(rows)
    assert [s[0] for s in stars] == ["1", "2"]
    assert stars[1] == ["2", 20.1234568, -5.0, 400.0, 400.0, 50.0, 12.35] and stars[0][6] is None
    doc = gaia_fast.document(stars, len(rows))
    assert doc["count"] == 2 and doc["in_catalogue_above_speed"] == 5 and doc["columns"][0] == "source_id" and doc["epoch"] == 2016.0


def test_the_fast_star_questions_miss_no_motion_above_the_speed():
    # a motion above 500 mas a year has a component above 500 / sqrt(2): the four questions together miss none
    assert gaia_fast.PART < gaia_fast.MIN_PM / math.sqrt(2) and len(gaia_fast.QUERIES) == len(gaia_fast.CHECK_QUERIES) == 4
    for q, c, part in zip(gaia_fast.QUERIES, gaia_fast.CHECK_QUERIES, ("pmra >", "pmra < -", "pmdec >", "pmdec < -")):
        assert part in q and part in c and "pm > 500" in q and "pmra*pmra + pmdec*pmdec > 250000" in c
    rs = np.random.default_rng(5)
    for angle in rs.uniform(0, 2 * math.pi, 500):
        pmra, pmdec = 500.01 * math.cos(angle), 500.01 * math.sin(angle)
        assert pmra > gaia_fast.PART or pmra < -gaia_fast.PART or pmdec > gaia_fast.PART or pmdec < -gaia_fast.PART


def test_two_copies_of_the_catalogue_are_compared_source_by_source():
    a = {1: {"ra": 10.0, "dec": 5.0, "pmra": 600.0, "pmdec": 10.0, "parallax": 20.0},
         2: {"ra": 20.0, "dec": -5.0, "pmra": 400.0, "pmdec": 400.0, "parallax": 50.0}}
    same = {k: dict(v, pmra=v["pmra"] + 3e-4) for k, v in a.items()}  # single precision in the second copy
    assert gaia_fast.compare(a, same) == []
    assert "only in the first copy" in gaia_fast.compare(a, {1: a[1]})[0]
    assert "only in the second copy" in gaia_fast.compare({1: a[1]}, a)[0]
    moved = {1: a[1], 2: dict(a[2], dec=-5.001)}
    assert gaia_fast.compare(a, moved) == ["dec differs by up to 0.001 (allowed 1e-07)"]


def test_an_empty_cell_of_an_answer_becomes_none():
    assert gaia_fast.plain(np.ma.masked, "phot_g_mean_mag") is None and gaia_fast.plain(np.float32("nan"), "parallax") is None
    assert gaia_fast.plain(np.int64(4472832130942575872), "source_id") == 4472832130942575872
    assert gaia_fast.plain(np.float32(8.5), "phot_g_mean_mag") == 8.5


# -- writers shared by the jobs ------------------------------------------------------------------------


def row(id_, status="UNVERIFIED"):
    from sx import checks

    return checks.row(id_, "t", "c", "t", "r", status, "p")


def test_put_rows_replaces_by_id_and_keeps_one_order(tmp_path):
    T.put_rows([row("K7"), row("K5")], tmp_path)
    T.put_rows([row("K6"), row("K5", "LIMIT"), row("Z1")], tmp_path)
    rows = json.loads((tmp_path / "p3.json").read_text())
    assert [r["id"] for r in rows] == ["K5", "K6", "K7", "Z1"] and rows[0]["status"] == "LIMIT"


def test_put_decision_keeps_the_other_part_and_checks_the_form(tmp_path):
    f = tmp_path / "p3.json"
    T.put_decision("S2", {"1": {"build": False, "why": "x"}}, f)
    T.put_decision("S1", {"eps-indi-b": {"build": True, "why": "y"}}, f)
    assert json.loads(f.read_text()) == {"S1": {"eps-indi-b": {"build": True, "why": "y"}}, "S2": {"1": {"build": False, "why": "x"}}}
    with pytest.raises(ValueError):
        T.put_decision("S1", {"a": {"build": "yes", "why": "y"}}, f)
    with pytest.raises(ValueError):
        T.put_decision("S9", {}, f)


def test_update_card_adds_fields_and_keeps_the_rest(tmp_path):
    T.update_card("x", {"a": 1, "b": 2}, tmp_path)
    T.update_card("x", {"b": 3, "motion": {"build": True}}, tmp_path)
    assert json.loads((tmp_path / "x" / "card.json").read_text()) == {"a": 1, "b": 3, "motion": {"build": True}}


def test_reviewer_argument():
    assert T.reviewer_from([]) is None and T.reviewer_from(["--reviewed", "physicist", "2026-11-15"]) == ("physicist", "2026-11-15")
    with pytest.raises(ValueError):
        T.reviewer_from(["--reviewed", "physicist", "tomorrow"])


def test_the_tolerance_of_a_shift_is_the_sum_its_rule_names():
    tol = targets.tolerances()
    for tid in targets.MOVERS:
        m = tol["movers"][tid]
        want = targets.SPHEREX_TOL_PX * tol["pixel_arcsec"] + m["allwise_half_spread_arcsec"] + m["allwise_saturated_arcsec"]
        assert m["shift_arcsec"] == pytest.approx(want, abs=0.002) and m["position_px"] == 0.5
        # half of what the catalogue moves the object between the first and last photo of the 2010 image
        cat = T.targets()[tid]["catalogue"]
        a, b = T.predict(cat, m["allwise"]["first_mjd"]), T.predict(cat, m["allwise"]["last_mjd"])
        assert m["allwise_half_spread_arcsec"] == pytest.approx(0.5 * float(np.hypot(*T.offset_arcsec(*a, *b))), abs=0.002)
    assert tol["movers"]["barnard"]["allwise_saturated_arcsec"] == 6.4 and tol["movers"]["wise0855"]["allwise_saturated_arcsec"] == 0
    assert tol["motion"]["nonzero_sigma"] == 3 and tol["rw-aur"]["comparison_median_pct"] == 1.0
