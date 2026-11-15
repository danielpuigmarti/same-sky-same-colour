"""wcs.py and wave.py: positions on the fixtures, and the wavelength tables against the fixtures' reference values."""
import json

import numpy as np
import pytest

from sx import s3, wave
from sx import wcs as W
from sx.fits import FrameFile
from test_p1_support import FIX, FRAME_IDS, load_frame, needs_network, recorded_source


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_target_pixel_is_the_all_world2pix_pixel(id_):
    meta, _, _, _ = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = FrameFile.open(meta["key"])
        t = meta["target"]
        x, y = W.sky_to_pixel(ff.wcs, t["ra"], t["dec"])
    assert float(x) == pytest.approx(meta["pixel"]["x"], abs=1e-8)
    assert float(y) == pytest.approx(meta["pixel"]["y"], abs=1e-8)


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_pixel_sky_round_trip(id_):
    meta, _, _, _ = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = FrameFile.open(meta["key"])
        rs = np.random.default_rng(3)
        px, py = rs.uniform(-0.5, 2039.5, 200), rs.uniform(-0.5, 2039.5, 200)
        ra, dec = W.pixel_to_sky(ff.wcs, px, py)
        x, y = W.sky_to_pixel(ff.wcs, ra, dec)
    assert np.abs(x - px).max() < 1e-5 and np.abs(y - py).max() < 1e-5


def test_the_distortion_matters_and_all_world2pix_is_the_one_used():
    """The version without the SIP terms differs from all_world2pix by pixels at the edge of the detector."""
    meta, _, _, _ = load_frame("eps-indi-d5")
    with s3.use(recorded_source("eps-indi-d5")):
        ff = FrameFile.open(meta["key"])
        ra, dec = W.pixel_to_sky(ff.wcs, 30.0, 2000.0)
        x, y = W.sky_to_pixel(ff.wcs, ra, dec)
        lx, ly = ff.wcs.wcs_world2pix(ra, dec, 0)
    assert abs(float(x) - 30.0) < 1e-5
    assert np.hypot(float(lx) - float(x), float(ly) - float(y)) > 0.5


def test_corners_and_area():
    meta, _, _, _ = load_frame("barnard-d2")
    with s3.use(recorded_source("barnard-d2")):
        ff = FrameFile.open(meta["key"])
        c = W.corners(ff.wcs, ff.nx, ff.ny)
        area = W.pixel_area_sr(ff.wcs)
    assert len(c) == 4
    # each side is about 2040 pixels of 6.15 arcsec = 3.5 degrees
    r0, d0 = c[0]
    for r1, d1 in (c[1], c[3]):
        sep = np.hypot((r1 - r0) * np.cos(np.radians(d0)), d1 - d0)
        assert 3.3 < sep < 3.7
    assert np.sqrt(area) * 206264.806 == pytest.approx(6.15, abs=0.1)


def test_stamp_origin_and_on_frame():
    assert W.stamp_origin(100.2, 50.5, 64, 64) == (68, 19)
    assert W.stamp_origin(100.49, 50.49, 64, 64) == (68, 18)
    assert W.on_frame(2039.4, 0.0, 2040, 2040) and not W.on_frame(2039.5, 0.0, 2040, 2040)
    assert not W.on_frame(1000.0, -0.6, 2040, 2040)


# -- wavelength --------------------------------------------------------------------------------------

REF = json.loads((FIX / "wave" / "reference.json").read_text())


def test_site_tables_equal_the_fixture_tables():
    assert wave.load_tables() == json.loads((FIX / "wave" / "tables.json").read_text())


@pytest.mark.parametrize("det", range(1, 7))
def test_tables_give_the_reference_wavelengths(det):
    r = REF[str(det)]
    out = wave.wavelength_at(det, np.array(r["x"], float), np.array(r["y"], float))
    assert np.abs(out["lam"] - np.array(r["lam"])).max() < 1e-9
    assert np.abs(out["bw"] - np.array(r["bw"])).max() < 1e-9


def test_scalar_and_array_calls_agree_and_colour_varies_across_the_detector():
    a = wave.wavelength_at(5, 1304.5, 482.4)
    b = wave.wavelength_at(5, np.array([1304.5]), np.array([482.4]))
    assert a["lam"] == pytest.approx(float(b["lam"][0]), abs=1e-15)
    assert abs(wave.wavelength_at(1, 1000.0, 100.0)["lam"] - wave.wavelength_at(1, 1000.0, 1900.0)["lam"]) > 0.05


def test_value_at_a_node_is_the_table_value_and_between_nodes_it_is_bilinear():
    t = wave.default_tables()["2"]
    j, i = 3, 4
    x, y = t["X"][j] - 1, t["Y"][i] - 1
    lam, bw = wave.lam_bw(t, x, y)
    assert float(lam) == pytest.approx(t["lam"][i][j], abs=1e-12)
    assert float(bw) == pytest.approx(t["bw"][i][j], abs=1e-12)
    x2 = (t["X"][j] + t["X"][j + 1]) / 2 - 1
    mid, _ = wave.lam_bw(t, x2, y)
    assert float(mid) == pytest.approx((t["lam"][i][j] + t["lam"][i][j + 1]) / 2, abs=1e-12)


def test_spans_are_the_extremes_of_the_tables():
    t = wave.default_tables()
    for det in "123456":
        lo, hi = wave.span(t[det])
        g = np.array(t[det]["lam"])
        assert lo == g.min() and hi == g.max() and lo < hi
    assert wave.span(t["1"])[0] < 0.8 and wave.span(t["6"])[1] > 4.9


@needs_network
@pytest.mark.parametrize("det", range(1, 7))
def test_table_read_from_a_frame_equals_the_site_file(det):
    seeded = wave.default_tables()[str(det)]
    assert wave.read_table(seeded["src"]) == seeded


@needs_network
def test_sip_off_reading_equals_the_table():
    meta, _, _, _ = load_frame("eps-indi-d5")
    ff = FrameFile.open(meta["key"])
    tab = ff.wave_hdu()
    x, y = np.array([300.0, 1300.0]), np.array([1900.0, 480.0])
    lam_off, _ = wave.astropy_wave(ff.header, tab, x, y)
    out = wave.wavelength_at(5, x, y)
    assert np.abs(lam_off - out["lam"]).max() < 1e-9
