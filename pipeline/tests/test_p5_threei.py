"""The job threei: its pieces on synthetic data, and the done-means on the files it wrote (run the job first)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _threei_frames, threei  # noqa: E402

from sx.contracts import KEY_REGEX  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NUMBERS = ROOT / "site" / "data" / "numbers" / "p5.json"
ROWS = ROOT / "site" / "data" / "checks" / "rows" / "p5.json"

RERUN_RATIO, RERUN_ERR = 2.18, 0.09
"""What an earlier run by different code gave for the December over August ratio at 2 pixels."""


def numbers_on_disk():
    if not NUMBERS.exists():
        pytest.skip("run the jobs first")
    return json.loads(NUMBERS.read_text(encoding="utf-8"))


def synthetic_pass(area_scale: float, r: float, delta: float, seed: int, n_out: int = 14) -> list[dict]:
    """A pass: a continuum of 0.4 mJy with noise and a Gaussian line of the given strength at 4.26 um, seen at
    colours between 3.9 and 4.4 um with a few of them inside the line."""
    rs = np.random.default_rng(seed)
    lam = np.sort(np.concatenate([np.linspace(3.9, 4.15, n_out // 2), np.linspace(4.2, 4.32, 6), np.linspace(4.36, 4.42, n_out // 2)]))
    rows = []
    for l in lam:
        f = 0.4 + area_scale * math.exp(-0.5 * ((l - 4.26) / 0.025) ** 2) + rs.normal(0, 0.08)
        rows.append({"lam": float(l), "r": r, "delta": delta, "f": {2: (float(f), 0.08)}, "cen_off": 0.1})
    return rows


def test_band_fit_returns_the_area_of_the_line_scaled_by_distance():
    rows = synthetic_pass(30.0, 2.0, 1.8, 1)
    fit = threei.band_fit(rows)
    expected = 30.0 * 0.025 * math.sqrt(2 * math.pi) * 2.0**2 * 1.8
    assert fit["area"] == pytest.approx(expected, rel=0.08)
    assert fit["mu"] == pytest.approx(4.26, abs=0.005)
    assert fit["n_in"] == 6


def test_the_ratio_of_two_passes_follows_the_production_not_the_distance():
    """The same production seen from two distances: the fluxes differ by the distance factors, the ratio is 1."""
    a = synthetic_pass(10.0, 3.4, 2.8, 2)
    d = synthetic_pass(10.0 * (3.4**2 * 2.8) / (2.1**2 * 1.8), 2.1, 1.8, 3)
    r, e = threei.ratio(threei.band_fit(d), threei.band_fit(a))
    assert r == pytest.approx(1.0, abs=3 * e + 0.05)


def test_a_doubled_production_gives_a_ratio_of_two():
    a = synthetic_pass(10.0, 3.0, 2.5, 4)
    d = synthetic_pass(2 * 10.0 * (3.0**2 * 2.5) / (2.0**2 * 1.8), 2.0, 1.8, 5)
    r, e = threei.ratio(threei.band_fit(d), threei.band_fit(a))
    assert r == pytest.approx(2.0, abs=3 * e + 0.05)


def test_moving_the_fit_window_by_a_hundredth_of_a_micron_keeps_a_fitted_ratio_steady():
    a = synthetic_pass(10.0, 3.0, 2.5, 6)
    d = synthetic_pass(25.0, 2.0, 1.8, 7)
    base = threei.ratio(threei.band_fit(d), threei.band_fit(a))[0]
    for sh in (0.01, -0.01):
        assert threei.ratio(threei.band_fit(d, shift=sh), threei.band_fit(a, shift=sh))[0] == pytest.approx(base, rel=0.1)


def spring_rows(excess: float) -> list[dict]:
    rs = np.random.default_rng(8)
    lam = np.concatenate([np.linspace(3.6, 4.15, 8), [4.22, 4.26, 4.30], np.linspace(4.4, 4.55, 4)])
    rows = []
    for l in lam:
        e = [{"off": o, "f": float(rs.normal(0, 0.5))} for o in threei.OFFS]
        rows.append({"lam": float(l), "r": 5.2, "delta": 4.6, "f2": float(rs.normal(0.3, 0.5) + (excess if 4.2 <= l <= 4.32 else 0)),
                     "e2": 0.5, "empty": e, "emp_std": 0.5})
    return rows


TEMPLATE = {"lam": np.array([4.17, 4.21, 4.25, 4.29, 4.33, 4.36]), "flux": np.array([0, 35.0, 410.0, 280.0, 24.0, 0]),
            "r": 2.1, "delta": 1.8}


def test_no_band_in_spring_gives_a_limit_and_excludes_a_constant_production():
    res = threei.spring_solve(spring_rows(0.0), TEMPLATE)
    assert abs(res["excess"]) < 3 * res["err"]
    assert res["limit"] == pytest.approx(max(res["excess"], 0) + 3 * res["err"])
    assert res["expected"] > 5 * res["limit"] / 3
    assert res["excluded"] > 5


def test_a_band_as_strong_as_expected_is_not_excluded():
    base = threei.spring_solve(spring_rows(0.0), TEMPLATE)
    res = threei.spring_solve(spring_rows(base["expected"]), TEMPLATE)
    assert abs(res["excluded"]) < 3


def test_the_empty_places_have_unit_scatter_when_the_noise_is_right():
    n = threei.spring_nulls(spring_rows(0.0), TEMPLATE)
    assert n["n"] == len(threei.OFFS)
    assert 0.4 < n["std"] < 1.8


def test_the_frame_lists_are_bucket_keys_split_by_pass():
    keys = threei.find_frames()
    by = threei.passes(keys)
    assert {k: len(v) for k, v in by.items()} == {"aug": 27, "dec": 47, "apr": 49}
    assert all(KEY_REGEX.fullmatch(k) for k in keys)
    assert len(keys) == len(set(keys))
    assert all(k.split("/")[-2] in "456" for k in keys)


def test_a_key_gives_the_obs_id_and_detector_of_irsas_table():
    assert threei.key_obs("dr1/level2/2025W31_2A/l2b-v27-2026-225/5/level2_2025W31_2A_0219_1D5_spx_l2b-v27-2026-225.fits") == ("2025W31_2A_0219_1", 5)


def test_the_centroid_finds_a_point_source_and_gives_nan_for_none():
    yy, xx = np.mgrid[:41, :41]
    img = 50.0 * np.exp(-((xx - 20.6) ** 2 + (yy - 19.7) ** 2) / 2.0)
    xc, yc = threei.centroid(img, np.zeros_like(img, dtype=np.int32), 20.0, 20.0, 0.0)
    assert (xc, yc) == pytest.approx((20.6, 19.7), abs=0.05)
    assert math.isnan(threei.centroid(np.zeros((41, 41)), np.zeros((41, 41), dtype=np.int32), 20.0, 20.0, 1.0)[0])


# -- the files the job wrote ----------------------------------------------------------------------------------


def test_the_ratio_reproduces_the_earlier_run_within_005():
    n = numbers_on_disk()
    assert n["threei.ratio"]["value"] == pytest.approx(RERUN_RATIO, abs=0.05)
    assert n["threei.ratio"]["err"] == pytest.approx(RERUN_ERR, abs=0.03)
    assert (n["threei.aug.n_band"]["value"], n["threei.dec.n_band"]["value"]) == (6, 3)


def test_the_hard_edged_band_swings_as_the_earlier_run_found():
    n = numbers_on_disk()
    assert n["threei.ratio.hard_low"]["value"] == pytest.approx(1.25, abs=0.1)
    assert n["threei.ratio.hard_high"]["value"] == pytest.approx(3.04, abs=0.15)


def test_the_spring_pass_shows_no_band_and_excludes_a_constant_production():
    n = numbers_on_disk()
    assert abs(n["threei.spring.excess"]["value"]) < 3 * n["threei.spring.excess"]["err"]
    assert n["threei.spring.limit"]["value"] < 6
    assert n["threei.spring.excluded"]["value"] > 10
    assert n["threei.spring.excluded_constant_speed"]["value"] > 10


def test_row_k4_is_honest_about_what_it_tests():
    if not ROWS.exists():
        pytest.skip("run the jobs first")
    row = next(r for r in json.loads(ROWS.read_text(encoding="utf-8")) if r["id"] == "K4")
    assert row["status"] in ("LIMIT", "FAIL")
    assert (row["status"] == "PASS") == bool(row["reviewer_role"] and row["reviewed_on"])
    text = row["test"] + " " + row["pass_rule"]
    for needle in ("weak", "20%", "r_h² x Δ", "same kind", "cannot say whether the two quantities are the same"):
        assert needle in text
    assert "not independent" in row["title"]
    assert row["image"] == "img/k4-bands.png" or row["image"].endswith("k4-bands.png")
    assert "3I" in row["claim"]
