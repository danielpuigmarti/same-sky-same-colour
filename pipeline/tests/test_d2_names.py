"""site/data/names.json: its positions at 2026.0 are what astropy gives from the catalogue astrometry in the same file."""
import json
from pathlib import Path

import astropy.units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time

NAMES = json.loads((Path(__file__).resolve().parents[2] / "site" / "data" / "names.json").read_text(encoding="utf-8"))


def test_positions_at_2026_follow_from_the_catalogue():
    stars = [e for e in NAMES["entries"] if "catalogue" in e]
    assert [e["id"] for e in stars] == ["barnard", "eps-indi-b", "wise0855", "rw-aur", "r-dra"]
    for e in stars:
        c = e["catalogue"]
        sc = SkyCoord(ra=c["ra"] * u.deg, dec=c["dec"] * u.deg, pm_ra_cosdec=c["pmra"] * u.mas / u.yr, pm_dec=c["pmdec"] * u.mas / u.yr,
                      distance=(1000 / c["parallax"]) * u.pc, radial_velocity=(c["rv"] or 0) * u.km / u.s,
                      obstime=Time(c["epoch"], format="jyear", scale="tcb"))
        n = sc.apply_space_motion(new_obstime=Time(2026.0, format="jyear", scale="tcb"))
        assert n.separation(SkyCoord(e["ra"] * u.deg, e["dec"] * u.deg)).arcsec < 0.001, e["id"]


def test_fast_stars_and_sources():
    by = {e["id"]: e for e in NAMES["entries"]}
    assert [i for i, e in by.items() if e["fast"]] == ["barnard", "eps-indi-b", "wise0855"]
    assert by["wise0855"]["catalogue"]["unverified"] is True and "Kirkpatrick" in by["wise0855"]["catalogue"]["source"]
    assert "Gaia DR3 4472832130942575872" in by["barnard"]["catalogue"]["source"]
    assert abs(by["barnard"]["catalogue"]["speed_arcsec_per_year"] - 10.4) < 0.06
    assert by["lemmon"]["when"].startswith("2026-02-26") and "Horizons" in by["lemmon"]["source"]
    assert "Horizons" in by["pluto"]["source"]
