"""The job spectra: its pieces on synthetic data, and the done-means on the files it wrote (run the job first)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import spectra  # noqa: E402

from sx.contracts import KEY_REGEX  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "data" / "spectra"
ROWS = ROOT / "site" / "data" / "checks" / "rows" / "p5.json"
NUMBERS = ROOT / "site" / "data" / "numbers" / "p5.json"


def gaussian_psf(sigma_px: float, n: int = 33) -> np.ndarray:
    off = (np.arange(n) - n // 2) / spectra.OVERSAMPLE
    p = np.exp(-(off[None, :] ** 2 + off[:, None] ** 2) / (2 * sigma_px**2))
    return p / p.sum()


def test_enclosed_fraction_of_a_centred_gaussian_follows_the_analytic_value():
    """A star at the centre of a pixel, aperture radius 1: the five pixels of a plus sign. For a Gaussian of width s the
    share is a * a + 2 * a * b with a = erf(0.5 / (s sqrt 2)) and b = erf(1.5 / (s sqrt 2)) - a."""
    sigma = 0.8
    a = math.erf(0.5 / (sigma * math.sqrt(2)))
    b = math.erf(1.5 / (sigma * math.sqrt(2))) - a
    got = spectra.epsf_fraction(gaussian_psf(sigma), 20.0, 20.0, 1.0)
    assert got == pytest.approx(a * a + 2 * a * b, abs=0.02)


def test_enclosed_fraction_depends_on_where_in_the_pixel_the_star_sits():
    psf = gaussian_psf(0.6)
    centred = spectra.epsf_fraction(psf, 20.0, 20.0, 1.0)
    offcentre = spectra.epsf_fraction(psf, 20.5, 20.5, 1.0)
    assert centred != pytest.approx(offcentre, abs=1e-3)
    assert 0.3 < min(centred, offcentre) <= max(centred, offcentre) < 1.0


def test_a_large_aperture_holds_everything_the_model_holds():
    assert spectra.epsf_fraction(gaussian_psf(0.8), 20.0, 20.0, 6.0) == pytest.approx(1.0, abs=1e-6)


def test_magnitude_to_flux_density():
    assert spectra.jy_to_mjy(0.0, "J") == pytest.approx(1594.0 * 1000)
    assert spectra.jy_to_mjy(5.0, "K") == pytest.approx(666.7 * 1000 * 1e-2)


def test_catalogue_ratio_is_the_measured_over_the_catalogue_flux_near_the_band():
    f = spectra.jy_to_mjy(11.0, "J")
    pts = [{"lam": 1.23, "flux": 0.9 * f, "snr": 50}, {"lam": 1.24, "flux": 0.9 * f, "snr": 50}, {"lam": 1.5, "flux": 1.0, "snr": 50}]
    r = spectra.catalogue_ratios(pts, {"J": 11.0, "H": 10.5, "K": 10.4})
    assert set(r) == {"J"}
    assert r["J"]["ratio"] == pytest.approx(0.9)


def test_scatter_about_neighbours_is_small_for_a_smooth_spectrum_and_large_for_a_noisy_one():
    rs = np.random.default_rng(1)
    lam = np.linspace(1, 5, 120)
    smooth = [{"lam": float(l), "f": 10.0 + 0.1 * l, "snr": 100.0} for l in lam]
    noisy = [{"lam": float(l), "f": (10.0 + 0.1 * l) * (1 + rs.normal(0, 0.1)), "snr": 100.0} for l in lam]
    assert spectra.sorted_scatter(smooth, "f") < 0.01
    assert spectra.sorted_scatter(noisy, "f") > 0.05


def test_a_point_inside_and_outside_an_outline():
    quad = [(10.0, 0.0), (10.0, 1.0), (11.0, 1.0), (11.0, 0.0)]
    assert spectra.inside_quad(10.5, 0.5, quad)
    assert not spectra.inside_quad(11.5, 0.5, quad)
    assert not spectra.inside_quad(10.5, 1.5, quad)


def test_the_index_lists_photos_that_cover_epsilon_indi_b():
    b = spectra.target_entry("eps-indi-b")
    keys = spectra.candidate_keys(b["cat"])
    assert len(keys) > 250
    assert all(KEY_REGEX.fullmatch(k) for k in keys)
    assert len(keys) == len(set(keys))


def test_the_target_comes_from_names_json():
    b = spectra.target_entry("eps-indi-b")
    assert b["name"] == "Epsilon Indi B"
    assert b["cat"]["pmra"] == pytest.approx(3981.9767, abs=1e-3)


def test_the_catalogue_position_is_moved_by_the_proper_motion():
    b = spectra.target_entry("eps-indi-b")
    ra1, de1 = spectra.star_position(b["cat"], 58000.0)
    ra2, de2 = spectra.star_position(b["cat"], 61041.0)
    assert (ra2 - ra1) * math.cos(math.radians(de1)) * 3600 == pytest.approx(3.98 * 3041 / 365.25, rel=0.02)
    assert (de2 - de1) * 3600 == pytest.approx(-2.4668 * 3041 / 365.25, rel=0.02)


# -- the files the job wrote -------------------------------------------------------------------------------------


def files():
    fs = sorted(f for f in OUT.glob("*.json") if f.name != "index.json") if OUT.exists() else []
    if not fs:
        pytest.skip("run the jobs first")
    return fs


def test_the_list_of_spectra_names_every_file():
    names = sorted(f.stem for f in files())
    listed = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    assert listed == {"ids": names}


def test_every_spectrum_file_has_the_agreed_form():
    for path in files():
        d = json.loads(path.read_text(encoding="utf-8"))
        assert d["id"] == path.stem
        assert d["label"].startswith(("relative only", "compared with IRSA"))
        assert d["aperture"]["radius_px"] == spectra.R_AP and d["aperture"]["ring_px"] == list(spectra.RING)
        assert d["mask"] == spectra.phot.BAD_MASK
        assert d["visits"]
        for v in d["visits"]:
            n = v["n"]
            for k in ("mjd", "lam", "bw", "flux", "err", "flags", "key"):
                assert len(v[k]) == n
            assert v["lam"] == sorted(v["lam"])
            assert all(0.7 < x < 5.1 for x in v["lam"])
            assert all(KEY_REGEX.fullmatch(k) for k in v["key"])
            assert all(e >= 0 for e in v["err"])


def test_epsilon_indi_b_and_three_stars_are_there():
    ids = [p.stem for p in files()]
    assert "eps-indi-b" in ids
    assert len([i for i in ids if i.startswith("gaia-")]) == 3


def test_the_stars_fluxes_are_of_the_order_of_their_catalogue_brightness():
    n = json.loads(NUMBERS.read_text(encoding="utf-8")) if NUMBERS.exists() else {}
    if "spectra.stars.catalogue_ratio" not in n:
        pytest.skip("run the job spectra first")
    assert 0.5 < n["spectra.stars.catalogue_ratio"]["value"] < 2.0


def test_row_k13_is_unverified_without_the_comparison_and_says_so():
    if not ROWS.exists():
        pytest.skip("run the jobs first")
    row = next((r for r in json.loads(ROWS.read_text(encoding="utf-8")) if r["id"] == "K13"), None)
    if row is None:
        pytest.skip("run the job spectra first")
    assert row["status"] in ("UNVERIFIED", "PASS", "LIMIT")
    assert (row["status"] == "PASS") == bool(row["reviewer_role"] and row["reviewed_on"])
    if row["status"] == "UNVERIFIED":
        assert "relative only" in row["test"]
    assert "0.9" in row["pass_rule"] and "1.1" in row["pass_rule"]
