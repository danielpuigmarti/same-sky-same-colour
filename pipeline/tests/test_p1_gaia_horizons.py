"""gaia.py (placement on the fixture stamp with a recorded catalogue; the cone search and propagation) and
horizons.py (assembly of answers; one live question)."""
import json

import numpy as np
import pytest

from sx import gaia, horizons, s3
from sx.fits import FrameFile
from sx.stamp import cut
from test_p1_support import DATA, load_frame, needs_network, recorded_source


def test_placement_on_the_recorded_stamp_is_within_0_3_pixel():
    meta, _, _, _ = load_frame("barnard-d2")
    stars = json.loads((DATA / "gaia_barnard_d2.json").read_text())["stars"]
    with s3.use(recorded_source("barnard-d2")):
        ff = FrameFile.open(meta["key"])
        t = meta["target"]
        st = cut(ff, t["ra"], t["dec"], size=64, flags=False)
        res = gaia.placement(st, ff.wcs, stars)
    assert len(res) >= 3
    assert max(r["offset"] for r in res) < 0.3
    assert np.median([r["offset"] for r in res]) < 0.1
    assert all(r["snr"] >= 30 and 7 < r["G"] < 14.5 for r in res)


def test_propagation_moves_barnards_star_by_its_proper_motion():
    """Barnard's Star moves 10 arcsec a year: propagated to 2026 it has moved 105 arcsec (17 pixels)."""
    stars = json.loads((DATA / "gaia_barnard_d2.json").read_text())["stars"]
    b = max(stars, key=lambda s: abs(s["pmra"] or 0) + abs(s["pmdec"] or 0))
    assert abs(b["pmdec"]) > 9000
    ra, dec = gaia.propagate([b], 61115.0)
    moved = np.hypot((ra[0] - b["ra"]) * np.cos(np.radians(b["dec"])), dec[0] - b["dec"]) * 3600
    years = (61115.0 - gaia.GAIA_EPOCH_MJD) / 365.25
    assert moved == pytest.approx(np.hypot(b["pmra"], b["pmdec"]) / 1000 * years, rel=1e-3)


def test_propagate_matches_straight_line_motion_for_a_distant_star():
    s = {"ra": 100.0, "dec": 20.0, "pmra": 50.0, "pmdec": -30.0}
    ra, dec = gaia.propagate([s], gaia.GAIA_EPOCH_MJD + 365.25 * 10)
    assert (dec[0] - 20.0) * 3.6e6 == pytest.approx(-300.0, abs=0.5)
    assert (ra[0] - 100.0) * np.cos(np.radians(20.0)) * 3.6e6 == pytest.approx(500.0, abs=1.0)


def test_centroid_finds_a_gaussian_and_refuses_edges_and_missing_values():
    yy, xx = np.mgrid[:64, :64]
    img = 5 + 400 * np.exp(-((xx - 30.4) ** 2 + (yy - 20.7) ** 2) / (2 * 1.2**2))
    c = gaia.centroid(img + np.random.default_rng(2).normal(0, 1, img.shape), 30.0, 21.0)
    assert c is not None and abs(c[0] - 30.4) < 0.05 and abs(c[1] - 20.7) < 0.05 and c[2] > 30
    assert gaia.centroid(img, 2.0, 20.0) is None
    bad = img.copy()
    bad[20, 30] = np.nan
    assert gaia.centroid(bad, 30.0, 21.0) is None


@needs_network
def test_cone_search_pages_and_caches(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CACHE", str(tmp_path))
    stars = gaia.cone(269.44636, 4.76706, 0.01)
    assert 5 < len(stars) < 500
    assert set(stars[0]) == set(gaia.FIELDS) and isinstance(stars[0]["source_id"], str)
    assert any(f.name.startswith("gaia_") for f in tmp_path.iterdir())
    assert gaia.cone(269.44636, 4.76706, 0.01) == stars


# -- Horizons ------------------------------------------------------------------------------------


def test_positions_assembles_chunks_and_checks_the_times(monkeypatch):
    calls = []

    def fake(command, center, mjds):
        calls.append(len(mjds))
        return [[m + 2400000.5, 100.0 + m * 0.001, 20.0, 4.5, 3.8] for m in mjds]

    monkeypatch.setattr(horizons, "_query", fake)
    mjds = [61000.0 + i * 0.1 for i in range(95)]
    e = horizons.positions("C/2025 N1", mjds)
    assert calls == [40, 40, 15] and len(e.ra) == 95
    assert e.ra[3] == pytest.approx(100.0 + mjds[3] * 0.001)
    monkeypatch.setattr(horizons, "_query", lambda c, ce, m: [[1.0, 0, 0, 0, 0] for _ in m])
    with pytest.raises(RuntimeError, match="other times"):
        horizons.positions("C/2025 N1", [61000.0])
    monkeypatch.setattr(horizons, "_query", lambda c, ce, m: [])
    with pytest.raises(RuntimeError, match="rows"):
        horizons.positions("C/2025 N1", [61000.0])


def test_the_observer_is_spherex():
    assert horizons.SPHEREX == "-163182"


@needs_network
def test_horizons_live_spacecraft_and_geocentre_differ_by_parallax(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CACHE", str(tmp_path))
    mjd = [61097.5 + k * 0.006 for k in range(12)]  # one orbit of the spacecraft is about 0.067 d
    sc = horizons.positions("C/2025 N1", mjd)
    geo = horizons.positions("C/2025 N1", mjd, center="500@399")
    assert 3.0 < sc.delta_au[0] < 5.0 and 4.0 < sc.r_au[0] < 5.0
    sep = np.hypot((sc.ra - geo.ra) * np.cos(np.radians(sc.dec)), sc.dec - geo.dec) * 3600
    assert 1.0 < sep.max() < 10  # an orbit about 7000 km from the Earth's centre, seen from 4 au: a few arcseconds
