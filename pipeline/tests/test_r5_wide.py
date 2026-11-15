"""The pure functions of the lemmon_wide job: the grid position of a sky position, the size that all frames cover,
the filling of unusable pixels, the grey PNG, and the registration numbers. No network."""
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jobs import lemmon_wide as W  # noqa: E402
from sx import display  # noqa: E402


def test_grid_pixel_centre_and_directions():
    assert W.grid_pixel(10.0, -30.0, 10.0, -30.0, 512) == (256.0, 256.0)
    x, y = W.grid_pixel(10.0, 0.0, 10.0, 0.01, 512)  # north: up, the row grows
    assert x == pytest.approx(256.0) and y == pytest.approx(256.0 + 0.01 / display.PIXEL_DEG, rel=1e-6)
    x, y = W.grid_pixel(10.0, 0.0, 10.01, 0.0, 512)  # east: left, the column falls
    assert y == pytest.approx(256.0) and x == pytest.approx(256.0 - 0.01 / display.PIXEL_DEG, rel=1e-6)


def test_grid_pixel_inverts_source_pixels():
    sky = {"ra": 100.0, "dec": 20.0, "cd": [-display.PIXEL_DEG, 0.0, 0.0, display.PIXEL_DEG]}
    sx, sy = display.source_pixels(sky, 100.0, 100.0, 201, 201, 64)
    # a stamp with the grid's own orientation: the target pixel is the grid's centre
    x, y = W.grid_pixel(100.0, 20.0, 100.0, 20.0, 64)
    assert (x, y) == (32.0, 32.0) and sx[32, 32] == 100 and sy[32, 32] == 100


def test_covered_size():
    ok = np.ones((512, 512), bool)
    assert W.covered_size(ok) == 512
    ok[0, 0] = False
    assert W.covered_size(ok) == 384
    ok[64, 64] = False
    assert W.covered_size(ok) == 256
    ok[256, 256] = False
    assert W.covered_size(ok) is None


def test_crop_middle_keeps_the_centre():
    a = np.arange(512 * 512).reshape(512, 512)
    b = W.crop_middle(a, 384)
    assert b.shape == (384, 384) and b[192, 192] == a[256, 256]


def test_fill_unusable_takes_median_of_usable_neighbours():
    d = np.arange(25, dtype=np.float32).reshape(5, 5)
    bad = np.zeros((5, 5), bool)
    bad[2, 2] = True
    out = W.fill_unusable(d, bad)
    assert out[2, 2] == np.median([6, 7, 8, 11, 13, 16, 17, 18])
    assert np.array_equal(out[~bad], d[~bad])


def test_fill_unusable_grows_into_a_cluster_and_leaves_other_nan():
    d = np.full((7, 7), 5.0, np.float32)
    d[0, 0] = np.nan  # not flagged: stays NaN
    bad = np.zeros((7, 7), bool)
    bad[2:5, 2:5] = True
    out = W.fill_unusable(d, bad)
    assert np.isfinite(out[2:5, 2:5]).all() and (out[2:5, 2:5] == 5.0).all()
    assert np.isnan(out[0, 0])


def test_grey8_ends_and_order():
    rule = {"noise": 1.0, "black": -2.0, "white": 100.0, "soften": 3.0}
    g = W.grey8(np.array([-50.0, -2.0, 0.0, 10.0, 100.0, 500.0, np.nan]), rule)
    assert g.dtype == np.uint8 and g[0] == 0 and g[1] == 0 and g[4] == 255 and g[5] == 255 and g[6] == 0
    assert 0 < g[2] < g[3] < 255


def test_grey_png_round_trip_and_header():
    rng = np.random.default_rng(1)
    a = np.clip(rng.normal(40, 6, (64, 48)), 0, 255).astype(np.uint8)
    a[10:20, 5:9] = 255
    png = W.grey_png(a)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert png[16:24] == (48).to_bytes(4, "big") + (64).to_bytes(4, "big") and png[24:26] == bytes([8, 0])
    assert np.array_equal(W.read_grey_png(png), a)
    assert png == W.grey_png(a)


def test_registration_numbers():
    a = {"1": (10.0, 10.0), "2": (20.0, 20.0), "3": (30.0, 30.0), "4": (1.0, 1.0)}
    b = {"1": (10.3, 10.4), "2": (20.0, 21.5), "3": (30.1, 30.0)}
    off = W.offsets(a, b)
    assert sorted(off) == ["1", "2", "3"]
    r = W.registration(off)
    assert r["n"] == 3 and r["within"] == 2
    assert r["median"] == pytest.approx(0.5) and r["worst"] == pytest.approx(1.5)
    assert W.registration({})["median"] is None


def test_brightest_near_the_centre():
    img = np.zeros((41, 41))
    img[21, 19] = 5.0
    img[0, 0] = 9.0  # outside the search radius
    x, y, d = W.brightest_near(img, 20, 5)
    assert (x, y) == (19.0, 21.0) and d == pytest.approx(math.sqrt(2))
