"""The jobs wave_tables, lines and placement: their pieces on synthetic data, and the done-means on real data
(network; the first run is slow, later runs read the cache)."""
import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest

from sx import checks, frozen, wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import lines, placement, wave_tables  # noqa: E402
from test_p1_support import needs_network  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NUMBERS = ROOT / "site" / "data" / "numbers" / "p1.json"
ROWS = ROOT / "site" / "data" / "checks" / "rows" / "p1.json"


def numbers_on_disk():
    if not NUMBERS.exists():
        pytest.skip("run the jobs first")
    return json.loads(NUMBERS.read_text(encoding="utf-8"))


# -- wave_tables -----------------------------------------------------------------------------------


def test_map_lookup_is_bilinear_and_clamps():
    m = np.add.outer(np.arange(2040.0), 10 * np.arange(2040.0)).astype(np.float32)  # m[y, x] = y + 10 x
    assert wave_tables.map_lookup(m, np.array([3.5]), np.array([7.25]))[0] == pytest.approx(7.25 + 35.0)
    assert wave_tables.map_lookup(m, np.array([-4.0]), np.array([5000.0]))[0] == pytest.approx(2039.0)


def test_the_site_file_has_the_form_of_ct3():
    t = wave.load_tables()
    assert list(t) == ["1", "2", "3", "4", "5", "6"]
    for det, tab in t.items():
        assert set(tab) == {"X", "Y", "lam", "bw", "src"}
        assert len(tab["lam"]) == len(tab["Y"]) and len(tab["lam"][0]) == len(tab["X"])
        assert tab["X"][0] == 1 and tab["X"][-1] == 2040 and tab["Y"][0] == 1 and tab["Y"][-1] == 2040
        assert tab["src"] == wave_tables.SOURCES[int(det)]


@needs_network
def test_tables_reproduce_an_independent_reading_at_10000_pixels_per_detector():
    res = wave_tables.compare(wave.load_tables(), None)
    assert len(res) == 6
    for det, r in res.items():
        assert r["lam_vs_astropy"] < 1e-5 and r["bw_vs_astropy"] < 1e-5, det


@pytest.mark.skipif(not os.environ.get("SX_V6_MAPS"), reason="set SX_V6_MAPS to the folder of lam_D1.npy to lam_D6.npy")
def test_tables_reproduce_the_full_maps_at_10000_pixels_per_detector():
    res = wave_tables.compare(wave.load_tables(), Path(os.environ["SX_V6_MAPS"]))
    assert max(r["lam_vs_maps"] for r in res.values()) < 1e-5


def test_numbers_of_the_tables_job():
    n = numbers_on_disk()
    assert n["wave.tables.pixels"]["value"] == 60000
    assert n["wave.tables.error_astropy"]["value"] < 1e-5
    if "wave.tables.error_maps" in n:
        assert n["wave.tables.error_maps"]["value"] < 1e-5


# -- lines -----------------------------------------------------------------------------------------


def test_expected_wavelengths_are_those_of_the_specification():
    assert lines.expected(1.28216) == pytest.approx(1.28188, abs=6e-6)
    assert lines.expected(4.05226) == pytest.approx(4.05137, abs=6e-6)


def test_fit_line_recovers_a_known_centre():
    ln = lines.LINES[0]
    rs = np.random.default_rng(4)
    lam = np.sort(rs.uniform(ln["lab"] - ln["half"], ln["lab"] + ln["half"], 80))
    flux = lines.gauss(lam, 200, 5, 1000, 1.2810, 0.011) + rs.normal(0, 8, lam.size)
    rows = [{"lam": float(l), "bw": 0.03, "flux": float(f), "err": 8.0} for l, f in zip(lam, flux)]
    r = lines.fit_line(rows, ln)
    assert r["mu"] == pytest.approx(1.2810, abs=0.0005)
    assert r["dev_nm"] == pytest.approx((r["mu"] - lines.expected(ln["lab"])) * 1000)
    assert 0 < r["mu_err"] < 0.002 and r["n"] == 80


def test_the_ruler_spans_are_the_table_extremes_in_the_picture_data():
    t = wave.load_tables()
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots()
    lines.draw_ruler(ax, t)
    widths = sorted(round(p.get_width(), 9) for p in ax.patches if abs(p.get_height() - 0.6) < 1e-9 and p.get_width() > 0.1)
    plt.close(fig)
    want = sorted(round(wave.span(t[str(d)])[1] - wave.span(t[str(d)])[0], 9) for d in range(1, 7))
    assert widths == want


@needs_network
def test_line_centres_reproduce_the_probe_within_0_0002_um():
    keys = frozen.load("lines")
    assert keys, "run the lines job first"
    rows = lines.measure(keys)
    for ln in lines.LINES:
        r = lines.fit_line(rows[ln["id"]], ln)
        assert abs(r["mu"] - lines.REPRODUCE[ln["id"]]) < 0.0002, ln["id"]
        assert abs(r["mu"] - r["expected"]) < ln["tol"], ln["id"]
    assert len(rows["pab"]) == 76 and len(rows["bra"]) == 55


def test_check_rows_on_disk():
    if not ROWS.exists():
        pytest.skip("run the lines job first")
    rows = {r["id"]: r for r in json.loads(ROWS.read_text(encoding="utf-8"))}
    assert set(rows) == {"K1", "K1-limit"}
    assert rows["K1"]["status"] in ("PASS", "UNVERIFIED") and rows["K1-limit"]["status"] == "LIMIT"
    for r in rows.values():
        img = checks.DATA / "checks" / r["image"]
        assert hashlib.sha256(img.read_bytes()).hexdigest() == r["image_sha256"]
    n = numbers_on_disk()
    assert abs(n["lines.pab.fit"]["value"] - 1.28184) < 0.0002 and abs(n["lines.bra.fit"]["value"] - 4.04989) < 0.0002
    assert abs(n["lines.pab.dev_nm"]["value"]) < 5 and abs(n["lines.bra.dev_nm"]["value"]) < 15
    assert (ROOT / "review" / "h3.png").exists() and (ROOT / "review" / "h3.md").exists()


# -- placement -------------------------------------------------------------------------------------


@needs_network
def test_gaia_stars_land_within_0_3_px_on_six_detectors():
    keys = frozen.load("placement")
    assert keys and len(keys) == 6
    rows = placement.measure(keys)
    assert sorted(r["det"] for r in rows) == [1, 2, 3, 4, 5, 6]
    for r in rows:
        assert r["n"] >= 3, r
        assert r["max"] <= 0.3, r
