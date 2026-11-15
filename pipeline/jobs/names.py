"""Writes site/data/names.json: the named targets of the site with their positions in 2025-26.

Stars: Gaia DR3 astrometry (ESA archive, TAP), moved to 2026.0 with proper motion, parallax and radial velocity.
WISE 0855-0714 is not in Gaia: its astrometry is Kirkpatrick et al. 2021 as served by SIMBAD.
Comet and Pluto: JPL Horizons, astrometric ICRS, seen from SPHEREx (geocentre when Horizons does not answer).

usage (from pipeline/):  python jobs/names.py [output file]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import astropy.units as u
import requests
from astropy.coordinates import SkyCoord
from astropy.time import Time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "data" / "names.json"

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
SIMBAD_TAP = ("https://simbad.cfa.harvard.edu/simbad/sim-tap/sync", "https://simbad.u-strasbg.fr/simbad/sim-tap/sync")
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"

EPOCH = 2026.0
FAST_MAS_PER_YEAR = 500.0
"""A star that moves more than this is a fast star: a position typed from an old catalogue is snapped to it."""

GAIA_COLUMNS = "source_id, ra, dec, pmra, pmdec, parallax, ref_epoch, radial_velocity, phot_g_mean_mag, ruwe"

STARS = [
    dict(
        id="barnard", name="Barnard's Star", kind="star", source="gaia", gaia=4472832130942575872,
        aliases=["Barnard's Star", "Barnards Star", "Barnard Star", "GJ 699", "GL 699", "V2500 Oph", "HIP 87937"],
        note="The fastest star in the sky: about 10.4 arcsec a year.",
    ),
    dict(
        id="eps-indi-b", name="Epsilon Indi B", kind="star", source="gaia", gaia=6412596012146801152,
        aliases=["Epsilon Indi B", "Eps Indi B", "Epsilon Indi Ba", "Eps Ind B", "eps Ind B", "ε Indi B", "ε Ind B"],
        note="A pair of brown dwarfs, Ba and Bb, about 0.4 degrees from Epsilon Indi A. Gaia lists the two as one "
             "source whose fit is poor (RUWE above 4): the position is that of the pair.",
    ),
    dict(
        id="wise0855", name="WISE 0855-0714", kind="star", source="simbad",
        simbad="WISEA J085510.74-071442.5",
        aliases=["WISE 0855-0714", "WISE 0855", "WISE J0855-0714", "WISE J085510.83-071442.5", "WISEA J0855-0714",
                 "WISEA J085510.74-071442.5"],
        note="The coldest brown dwarf known, about 8.1 arcsec a year. Not in Gaia.",
    ),
    dict(
        id="rw-aur", name="RW Aurigae", kind="star", source="gaia", gaia=156430822114424576,
        aliases=["RW Aurigae", "RW Aur", "RW Aur A", "V* RW Aur"],
        note="A young star that dims irregularly. Gaia DR3 lists the two stars of the pair apart; this is the brighter, A.",
    ),
    dict(
        id="r-dra", name="R Draconis", kind="star", source="gaia", gaia=1648328016354496384,
        aliases=["R Draconis", "R Dra", "V* R Dra"],
        note="A pulsating red giant, bright and saturated in SPHEREx.",
    ),
]


def tap(url: str, query: str) -> list[dict]:
    r = requests.post(url, data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="json", QUERY=query), timeout=120)
    r.raise_for_status()
    j = r.json()
    names = [c["name"] for c in j["metadata"]]
    return [dict(zip(names, row)) for row in j["data"]]


def gaia_row(source_id: int) -> dict:
    rows = tap(GAIA_TAP, f"SELECT {GAIA_COLUMNS} FROM gaiadr3.gaia_source WHERE source_id = {source_id}")
    if len(rows) != 1:
        raise RuntimeError(f"Gaia DR3 {source_id}: {len(rows)} rows")
    return rows[0]


def simbad_row(main_id: str) -> dict:
    last: Exception | None = None
    for url in SIMBAD_TAP:
        try:
            rows = tap(
                url,
                "SELECT main_id, ra, dec, pmra, pmdec, plx_value, plx_err, coo_bibcode, pm_bibcode, plx_bibcode "
                f"FROM basic WHERE main_id = '{main_id}'",
            )
            if len(rows) == 1:
                return rows[0]
        except Exception as e:  # try the other mirror
            last = e
    raise RuntimeError(f"SIMBAD {main_id}: {last}")


def propagate(cat: dict, jyear: float) -> tuple[float, float]:
    """Position at `jyear`: proper motion and radial velocity, seen from the solar-system barycentre."""
    c = SkyCoord(
        ra=cat["ra"] * u.deg, dec=cat["dec"] * u.deg,
        pm_ra_cosdec=cat["pmra"] * u.mas / u.yr, pm_dec=cat["pmdec"] * u.mas / u.yr,
        distance=(1000.0 / cat["parallax"]) * u.pc, radial_velocity=(cat["rv"] or 0.0) * u.km / u.s,
        obstime=Time(cat["epoch"], format="jyear", scale="tcb"), frame="icrs",
    )
    n = c.apply_space_motion(new_obstime=Time(jyear, format="jyear", scale="tcb"))
    return float(n.ra.deg), float(n.dec.deg)


def star_entry(spec: dict) -> dict:
    if spec["source"] == "gaia":
        g = gaia_row(spec["gaia"])
        cat = dict(
            ra=g["ra"], dec=g["dec"], epoch=g["ref_epoch"], pmra=g["pmra"], pmdec=g["pmdec"],
            parallax=g["parallax"], rv=g["radial_velocity"],
            source=f"Gaia DR3 {spec['gaia']}, ESA Gaia archive (gaiadr3.gaia_source), epoch J{g['ref_epoch']:.1f}",
            unverified=False,
        )
        extra = dict(g_mag=g["phot_g_mean_mag"], ruwe=g["ruwe"])
    else:
        s = simbad_row(spec["simbad"])
        cat = dict(
            ra=s["ra"], dec=s["dec"], epoch=2000.0, pmra=s["pmra"], pmdec=s["pmdec"], parallax=s["plx_value"], rv=None,
            source=(f"Kirkpatrick et al. 2021, ApJS 253, 7 ({s['coo_bibcode']}), as served by SIMBAD for "
                    f"{s['main_id']}; the position is given at epoch J2000.0 there. Not in Gaia."),
            unverified=True,
            unverified_why="Values read from SIMBAD; the paper itself was not opened and the epoch of the position "
                           "was not read from it.",
        )
        extra = {}
    ra, dec = propagate(cat, EPOCH)
    speed = (cat["pmra"] ** 2 + cat["pmdec"] ** 2) ** 0.5
    return dict(
        id=spec["id"], name=spec["name"], aliases=spec["aliases"], kind=spec["kind"],
        ra=round(ra, 8), dec=round(dec, 8), epoch=EPOCH, mjd=Time(EPOCH, format="jyear").mjd,
        fast=bool(speed > FAST_MAS_PER_YEAR),
        catalogue=dict(
            ra=round(cat["ra"], 9), dec=round(cat["dec"], 9), epoch=cat["epoch"],
            pmra=round(cat["pmra"], 4), pmdec=round(cat["pmdec"], 4), parallax=round(cat["parallax"], 4),
            rv=None if cat["rv"] is None else round(cat["rv"], 3),
            speed_arcsec_per_year=round(speed / 1000.0, 4),
            source=cat["source"], unverified=cat["unverified"],
            **({"unverified_why": cat["unverified_why"]} if cat["unverified"] else {}),
        ),
        note=spec["note"], **extra,
    )


def horizons_radec(command: str, jd_utc: float) -> tuple[float, float, str]:
    """Astrometric ICRS position at one time, seen from SPHEREx (Horizons body -163182), else from the geocentre."""
    for centre, label in (("500@-163182", "seen from SPHEREx"), ("500@399", "seen from the geocentre")):
        p = dict(
            format="json", COMMAND=f"'{command}'", OBJ_DATA="NO", MAKE_EPHEM="YES", EPHEM_TYPE="OBSERVER",
            CENTER=f"'{centre}'", TLIST=f"'{jd_utc:.8f}'", QUANTITIES="'1'", ANG_FORMAT="DEG",
            EXTRA_PREC="YES", CAL_FORMAT="JD", CSV_FORMAT="YES",
        )
        try:
            txt = requests.get(HORIZONS, params=p, timeout=120).json().get("result", "")
        except Exception:
            continue
        if "$$SOE" not in txt:
            continue
        row = [x.strip() for x in txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()[0].split(",")]
        nums = [x for x in row[1:] if x and x[0] in "+-0123456789"]
        return float(nums[0]), float(nums[1]), label
    raise RuntimeError(f"Horizons gave no position for {command}")


def comet_entry() -> dict:
    t = Time("2026-02-26T20:41:00", scale="utc")
    ra, dec, label = horizons_radec("DES=C/2025 A6;CAP;NOFRAG", t.jd)
    return dict(
        id="lemmon", name="Comet C/2025 A6 (Lemmon)", kind="comet",
        aliases=["C/2025 A6", "C/2025 A6 (Lemmon)", "Comet Lemmon", "Lemmon", "Comet C/2025 A6", "2025 A6"],
        ra=round(ra, 8), dec=round(dec, 8), epoch=None, when="2026-02-26T20:41:00Z", mjd=round(t.mjd, 6),
        fast=False,
        source=f"JPL Horizons, astrometric ICRS position {label}, at 2026-02-26 20:41 UTC, "
               "between the two SPHEREx exposures of that night",
        note="A moving target: this is its position on the night of 26 February 2026 only. It moves about 52 "
             "arcmin in 37.5 hours.",
    )


def pluto_entry() -> dict:
    t = Time(EPOCH, format="jyear")
    ra, dec, label = horizons_radec("999", t.utc.jd)
    return dict(
        id="pluto", name="Pluto", kind="planet", aliases=["Pluto", "134340 Pluto", "(134340) Pluto"],
        ra=round(ra, 8), dec=round(dec, 8), epoch=EPOCH, mjd=t.mjd, fast=False,
        source=f"JPL Horizons, astrometric ICRS position {label}, at 2026.0",
        note="Moves slowly against the stars: about 0.04 arcsec an hour.",
    )


def build() -> dict:
    entries = [star_entry(s) for s in STARS] + [comet_entry(), pluto_entry()]
    return dict(
        version=1, epoch=EPOCH,
        about="Named targets. ra, dec in degrees (ICRS) at `epoch` (stars, Pluto) or at `when` (the comet). "
              "A `fast` star also carries its catalogue astrometry: position and epoch, proper motion in mas/yr "
              "(pmra is the motion in RA times cos(dec)), parallax in mas, radial velocity in km/s.",
        entries=entries,
    )


def main(out: Path = OUT) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else OUT)
