"""The jobs gallery and pluto: their pieces on synthetic data, the rules on disk, and the done-means on the files the
jobs wrote (run the jobs first; those tests are skipped when nothing was written)."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _gallery_lib as L  # noqa: E402
from jobs import gallery, pluto  # noqa: E402

from sx import contracts as C  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"


def test_rules_are_written_and_consistent():
    pb7 = L.read_rule("pb7_rule.json")
    assert pb7["min_stars"] == 8 and pb7["empty_fields"]["count"] == 6 and pb7["candidates"]["proper_motion_mas_per_year_above"] == 1000
    assert pb7["pixel_arcsec"] == 6.15 and pb7["seed"] == 20261114
    pl = L.read_rule("pluto_rule.json")
    assert pl["fraction"] == 0.8 and pl["radius_px"] == 1.0 and pl["max_per_detector"] == 24


def test_propagate_against_plain_astropy():
    """With a parallax of 1 mas the Earth's offset is 1 mas at most: the star follows astropy's own space motion."""
    from astropy import units as u
    from astropy.coordinates import SkyCoord
    from astropy.time import Time

    s = {"ra": 330.0, "dec": -56.0, "pmra": 3000.0, "pmdec": -1500.0, "parallax": 1.0}
    c = SkyCoord(ra=s["ra"] * u.deg, dec=s["dec"] * u.deg, pm_ra_cosdec=3000 * u.mas / u.yr, pm_dec=-1500 * u.mas / u.yr,
                 distance=1000 * u.pc, obstime=Time(2016.0, format="jyear", scale="tcb"))
    for mjd in (55400.0, 61041.0):
        want = c.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="utc"))
        ra, dec = L.propagate(s, mjd)
        e, n = L.offset_arcsec(want.ra.deg, want.dec.deg, ra, dec)
        assert math.hypot(e, n) < 0.005
    ra0, dec0 = L.propagate(s, 55400.0)
    ra1, dec1 = L.propagate(s, 61041.0)
    e, n = L.offset_arcsec(ra0, dec0, ra1, dec1)
    assert math.hypot(e, n) == pytest.approx(3.354 * 15.4, rel=0.03)  # 3.35 arcsec a year over 15.4 years


def test_move_and_offset_are_inverses():
    for ra, dec, e, n in ((10.0, 60.0, 80.0, -40.0), (200.0, -30.0, -300.0, 150.0), (359.9, 5.0, 12.0, 0.0)):
        ra2, dec2 = L.move(ra, dec, e, n)
        e2, n2 = L.offset_arcsec(ra, dec, ra2, dec2)
        assert (e2, n2) == pytest.approx((e, n), abs=1e-6)
        mra, mdec = L.midpoint(ra, dec, ra2, dec2)
        e3, n3 = L.offset_arcsec(ra, dec, mra, mdec)
        assert (e3, n3) == pytest.approx((e / 2, n / 2), abs=1e-3)


def test_ecliptic_latitude():
    assert L.ecliptic_latitude(0.0, 0.0) == pytest.approx(0.0, abs=1e-9)
    assert L.ecliptic_latitude(270.0, 66.5607) == pytest.approx(90.0, abs=1e-3)
    assert L.ecliptic_latitude(90.0, 23.4393) == pytest.approx(0.0, abs=1e-3)


def test_thin_keeps_ends_and_spacing():
    xs = list(range(100))
    t = L.thin(xs, 12)
    assert len(t) == 12 and t[0] == 0 and t[-1] == 99
    assert max(np.diff(t)) - min(np.diff(t)) <= 1
    assert L.thin(xs[:5], 12) == xs[:5]


def star_image(n=40, x=20.3, y=18.7, amp=100.0, sigma=1.1, noise=1.0, seed=3, bg=5.0):
    rs = np.random.default_rng(seed)
    yy, xx = np.mgrid[:n, :n]
    return bg + amp * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma**2)) + rs.normal(0, noise, (n, n))


def test_fit_gauss_recovers_a_star():
    img = star_image()
    g = L.fit_gauss(img, 20, 19, search=2.5)
    assert g["x"] == pytest.approx(20.3, abs=0.05) and g["y"] == pytest.approx(18.7, abs=0.05)
    assert g["amp"] == pytest.approx(100, rel=0.05)
    assert L.fit_gauss(np.full((20, 20), np.nan), 10, 10) is None


def test_detect_finds_a_planted_source_and_rejects_an_offset_one():
    n = 48
    rs = np.random.default_rng(5)
    base = rs.normal(0, 1, (n, n))
    yy, xx = np.mgrid[:n, :n]
    src = lambda x, y, a: a * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.0**2))  # noqa: E731
    on = pluto.detect(base + src(24.2, 23.8, 12.0), 24.0, 24.0)
    assert on["found"] and on["dist"] < 0.8 and on["peak"] > 5
    off = pluto.detect(base + src(30.0, 24.0, 12.0), 24.0, 24.0)
    assert not off["found"] and off["dist"] > 3
    none = pluto.detect(base, 24.0, 24.0)
    assert not none["found"]


def test_approx_pixel_on_a_flat_frame():
    ra0, dec0, s = 100.0, 20.0, 6.15
    nx = ny = 2040
    pts = [L.move(ra0, dec0, ex, ny_) for ex, ny_ in ((0, 0), (nx * s, 0), (nx * s, ny * s), (0, ny * s))]
    # a frame whose pixel x grows towards the east and y towards the north from the first corner
    corners = [list(p) for p in pts]
    ra, dec = L.move(ra0, dec0, 500 * s, 1200 * s)
    x, y = pluto.approx_pixel(corners, nx, ny, ra, dec)
    assert (x + 0.5, y + 0.5) == pytest.approx((500, 1200), abs=1.0)


def test_sky_grid_is_north_up_east_left():
    g = L.sky_grid(150.0, 10.0, 120, 2.05)
    x0, y0 = L.grid_xy(g, 150.0, 10.0)
    assert (x0, y0) == pytest.approx((59.5, 59.5), abs=1e-6)
    ra_e, dec_e = L.move(150.0, 10.0, 20.0, 0.0)
    xe, ye = L.grid_xy(g, ra_e, dec_e)
    assert xe < x0 and ye == pytest.approx(y0, abs=0.01)
    ra_n, dec_n = L.move(150.0, 10.0, 0.0, 20.0)
    xn, yn = L.grid_xy(g, ra_n, dec_n)
    assert yn > y0 and xn == pytest.approx(x0, abs=0.01)


def test_photo_on_grid_keeps_a_flat_sky_flat():
    """A frame read through a grid: a constant image has background removed and gives zeros where it is covered."""
    from astropy.io import fits as afits
    from astropy.wcs import WCS

    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [150.0, 10.0]
    w.wcs.cdelt = [-6.15 / 3600, 6.15 / 3600]
    w.wcs.crpix = [100.0, 100.0]

    class FF:
        wcs = w

    data = np.full((64, 64), 7.0, dtype=np.float32) + np.random.default_rng(1).normal(0, 0.01, (64, 64)).astype(np.float32)
    flags = np.zeros((64, 64), np.int32)
    grid = L.sky_grid(150.0, 10.0, 40, 6.15)
    out = L.photo_on_grid(FF, data, flags, 68, 68, grid, 40)
    assert np.nanmax(np.abs(out)) < 0.05 and np.isfinite(out).sum() > 100
    assert afits is not None


def test_display_range_is_the_same_rule_for_both_images():
    rs = np.random.default_rng(2)
    a = rs.normal(0, 1, (60, 60))
    a[30, 30] = 500
    b, w = L.display_range(a)
    assert b == pytest.approx(-2.0, abs=0.3) and w >= 20 * 0.9


# -- the done-means on what the jobs wrote ----------------------------------------------------------------


def decisions():
    f = DATA / "checks" / "decisions" / "p6.json"
    if not f.exists():
        pytest.skip("run the jobs first")
    return json.loads(f.read_text(encoding="utf-8"))


def test_decisions_have_the_form():
    d = decisions()
    if "S4" in d:
        assert set(d["S4"]) == {"build", "why", "stars"} and isinstance(d["S4"]["build"], bool) and isinstance(d["S4"]["stars"], int)
    if "S5" in d:
        assert isinstance(d["S5"]["build"], bool) and d["S5"]["why"]


def test_gallery_files_when_built():
    d = decisions().get("S4")
    if not d or not d["build"]:
        pytest.skip("the gallery was not built")
    idx = json.loads((DATA / "gallery" / "index.json").read_text(encoding="utf-8"))
    assert len(idx["items"]) == d["stars"] >= 8
    for it in idx["items"]:
        folder = DATA / "gallery" / it["id"]
        assert C.check_showcase(folder) == []
        card = json.loads((folder / "card.json").read_text(encoding="utf-8"))
        assert max(card["offsets"]["spherex_px"]) <= 1.0 and card["offsets"]["wise_px"] <= 1.0
        for f in ("wise2010.png", "spherex.png", "jump.png"):
            assert (folder / f).exists()
        assert it["pm"] > 1.0


def test_spotit_set_when_built():
    d = decisions().get("S4")
    if not d or not d["build"]:
        pytest.skip("the set was not built")
    s = json.loads((DATA / "spotit" / "set.json").read_text(encoding="utf-8"))
    a = json.loads((DATA / "spotit" / "answers.json").read_text(encoding="utf-8"))["answers"]
    assert len(s["items"]) == 12 and set(a) == {i["id"] for i in s["items"]}
    movers = [k for k, v in a.items() if v["mover"]]
    assert len(movers) == 6
    for kind in (True, False):
        modes = [a[k]["mode"] for k in a if a[k]["mover"] == kind]
        assert modes.count("plain") == 3 and modes.count("matched") == 3
    for k in movers:
        r = a[k]["ring2010"], a[k]["ring2026"]
        assert all(0 < q["u"] < 1 and 0 < q["v"] < 1 for q in r)
    for i in s["items"]:
        assert (DATA / "spotit" / i["a"]).exists() and (DATA / "spotit" / i["b"]).exists()


def test_pluto_files_when_built():
    d = decisions().get("S5")
    if not d or not d["build"]:
        pytest.skip("Pluto was not shown")
    assert C.check_showcase(DATA / "pluto") == []
    card = json.loads((DATA / "pluto" / "card.json").read_text(encoding="utf-8"))
    assert "spectrum" not in json.dumps(card).lower()
    found = sum(1 for p in card["pairs"] if p["found"])
    assert found / len(card["pairs"]) >= 0.8
