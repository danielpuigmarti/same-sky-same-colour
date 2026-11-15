"""Job places: the pure functions that turn SIMBAD's rows into site/data/places.json, and the file as it is on disk.
Nothing here asks the network."""
import json
from pathlib import Path

import pytest

from jobs import places as P

SITE = Path(__file__).resolve().parents[2] / "site" / "data"
FILE = json.loads((SITE / "places.json").read_text(encoding="utf-8"))


def obj(**kw):
    base = {"oid": 1, "main_id": "x", "otype": "*", "nbref": 100, "ra": 10.0, "dec": 20.0, "ra_prec": 6, "dec_prec": 6,
            "pmra": None, "pmdec": None, "plx_value": None, "rvz_radvel": None, "rvz_type": None, "ids": [], "vmag": None}
    base.update(kw)
    return base


def test_key_ignores_case_accents_and_everything_but_letters_and_digits():
    assert P.key("Barnard's Star") == "barnardsstar"
    assert P.key("Boötis") == "bootis"
    assert P.key("NGC  7293") == "ngc7293"


def test_natural_sorts_numbers_by_value():
    assert sorted(["NGC 6543", "NGC 650"], key=P.natural) == ["NGC 650", "NGC 6543"]


def test_tidy_squeezes_the_padding_of_simbad():
    assert P.tidy("M   1") == "M 1"
    assert P.tidy("NAME  Crab Nebula ") == "NAME Crab Nebula"


@pytest.mark.parametrize("given, written", [
    ("alf Lyr", "Alpha Lyrae"),
    ("omi02 Eri", "Omicron2 Eridani"),
    ("61 Cyg A", "61 Cygni A"),
    ("V2500 Oph", "V2500 Ophiuchi"),
    ("R Dra", "R Draconis"),
    ("eps Ind", "Epsilon Indi"),
])
def test_spell_writes_a_designation_out(given, written):
    assert P.spell(given) == written


@pytest.mark.parametrize("given", ["HD 172167", "NGC 7293", "Sirius", "alf Xyz"])
def test_spell_leaves_what_does_not_end_in_a_constellation(given):
    assert P.spell(given) is None


def test_the_short_form_of_a_survey_name():
    assert P.short_survey_name("WISE J085510.83-071442.5") == "WISE 0855-0714"
    assert P.short_survey_name("NGC 7293") is None


def test_legacy_names_in_capitals_are_dropped_but_acronyms_stay():
    assert P.is_legacy("CRAB NEB") and not P.is_legacy("LMC") and not P.is_legacy("Crab Nebula")


def test_short_forms_are_told_from_names():
    assert P.is_short_form("Ori Nebula") and P.is_short_form("LMC") and not P.is_short_form("Orion Nebula")


def test_common_names_put_the_one_word_name_of_a_star_first():
    full, short = P.common_names(["NAME Polaris", "NAME North Star"], "NAME Polaris", "star")
    assert full[0] == "Polaris" and "North Star" in full and short == []


def test_kinds_in_plain_words():
    assert P.kind_of("PN") == "planetary nebula"
    assert P.kind_of("nonsense-type") == "object"
    assert P.kind_in_list({"otype": "err"}) == "group of stars"


def test_which_objects_are_listed():
    m1 = obj(ids=["M   1", "NAME Crab Nebula"], otype="SNR", nbref=10)
    assert P.group_of(m1) == "messier"
    assert P.group_of(obj(ids=["NAME Vega", "* alf Lyr"], main_id="NAME Vega")) == "named star"
    assert P.group_of(obj(ids=["NAME Some Galaxy"], otype="G", main_id="NAME Some Galaxy", nbref=10)) is None
    assert P.group_of(obj(ids=["NAME Some Galaxy"], otype="G", main_id="NAME Some Galaxy", nbref=60)) == "named"
    assert P.group_of(obj(ids=["GJ 1"], plx_value=300.0)) == "near"
    assert P.group_of(obj(ids=["V* R Dra"], nbref=900, otype="Mi*")) == "variable"
    assert P.group_of(obj(ra=None)) is None
    assert P.group_of(obj(ids=["NAME Vega", "* alf Lyr"], ra_prec=1)) is None


def test_a_proper_motion_moves_a_star_to_the_epoch_and_a_still_object_stays():
    still, moving = obj(), obj(ra=269.4520, dec=4.6933, pmra=-798.58, pmdec=10328.12, plx_value=546.98)
    (ra0, dec0), (ra1, dec1) = P.moved([still, moving])
    assert (ra0, dec0) == (10.0, 20.0)
    # Barnard's Star in 2026: about 26 years at 10.3 arcsec a year to the north
    assert dec1 - 4.6933 == pytest.approx(26 * 10.33 / 3600, abs=0.01)
    assert 0 <= ra1 < 360


def test_velocity_is_taken_only_when_it_is_a_velocity():
    assert P.velocity(obj(rvz_radvel=-110.5, rvz_type="v")) == -110.5
    assert P.velocity(obj(rvz_radvel=0.03, rvz_type="z")) is None
    assert P.speed(obj(pmra=3.0, pmdec=4.0)) == 5.0 and P.speed(obj()) == 0.0


def test_a_bright_star_carries_its_magnitude_and_a_faint_one_or_a_galaxy_does_not():
    rows = [
        obj(oid=1, ids=["NAME Vega", "* alf Lyr"], main_id="NAME Vega", vmag=0.03, nbref=9000),
        obj(oid=2, ids=["NAME Dim Star", "* 5 Cyg"], main_id="NAME Dim Star", vmag=6.2, nbref=800),
        obj(oid=3, ids=["M  31", "NAME Andromeda Galaxy"], main_id="M  31", otype="G", vmag=3.4, nbref=7000),
        obj(oid=4, ids=["NAME Unmeasured", "* 6 Cyg"], main_id="NAME Unmeasured", vmag=None, nbref=700),
    ]
    by = {e["name"]: e for e in P.entries(rows)}
    assert by["Vega"]["vmag"] == 0.03
    assert "vmag" not in by["Dim Star"] and "vmag" not in by["Unmeasured"]
    assert not any("vmag" in e for e in by.values() if e["kind"] == "galaxy")


def test_entries_come_most_cited_first_and_a_name_is_never_given_twice():
    rows = [obj(oid=2, ids=["NAME Alpha One", "* alf Lyr"], main_id="NAME Alpha One", nbref=10),
            obj(oid=1, ids=["NAME Alpha One", "* alf Lyr"], main_id="NAME Alpha One", nbref=900)]
    out = P.entries(rows)
    # the less cited of two objects that would share a name takes its next name
    assert [e["name"] for e in out] == ["Alpha One", "Alpha Lyrae"]


def test_a_fast_star_carries_its_catalogue_astrometry():
    barnard = obj(ids=["NAME Barnard's star", "* alf Ser"], main_id="NAME Barnard's star", ra=269.452, dec=4.6933,
                  pmra=-798.58, pmdec=10328.12, plx_value=546.98, rvz_radvel=-110.5, rvz_type="v", nbref=2000)
    e = P.entries([barnard])[0]
    assert e["fast"] is True and e["catalogue"]["epoch"] == 2000.0 and e["catalogue"]["rv"] == -110.5
    assert e["catalogue"]["pmdec"] == 10328.12 and e["catalogue"]["parallax"] == 546.98


def test_the_file_is_text_with_one_entry_a_line_and_reads_back_the_same():
    doc = P.document([{"name": "A", "aliases": [], "kind": "star", "ra": 1.0, "dec": 2.0}])
    text = P.text_of(doc)
    assert json.loads(text) == doc
    assert text.count('{"name"') == 1 and text.endswith("\n")
    assert doc["count"] == 1 and "vmag" in doc["about"] and set(doc["letters"]) >= {"alf", "mu", "ome"}


def test_rows_of_an_answer_are_dicts_by_column_name():
    answer = {"metadata": [{"name": "oidref"}, {"name": "flux"}], "data": [[1, 0.03], [2, None]]}
    assert P.rows_of(answer) == [{"oidref": 1, "flux": 0.03}, {"oidref": 2, "flux": None}]


# -- the file as it is on disk ---------------------------------------------------------------------------


def test_the_file_on_disk_is_what_the_job_writes_for_its_own_places():
    assert FILE["count"] == len(FILE["places"]) >= 800
    assert P.text_of(FILE) == (SITE / "places.json").read_text(encoding="utf-8")
    assert len((SITE / "places.json").read_bytes()) < P.MAX_BYTES


def test_every_place_has_what_a_row_needs_and_a_magnitude_only_when_it_is_a_bright_star():
    names = set()
    for p in FILE["places"]:
        assert p["name"] and p["kind"] and isinstance(p["aliases"], list) and len(p["aliases"]) <= P.MAX_ALIASES
        assert 0 <= p["ra"] < 360 and -90 <= p["dec"] <= 90
        assert P.key(p["name"]) not in names
        names.add(P.key(p["name"]))
        if "vmag" in p:
            assert p["vmag"] < P.BRIGHT_MAG
            assert p["kind"] in {"star", "variable star", "double star", "brown dwarf", "white dwarf", "neutron star",
                                 "pulsar", "young star", "X-ray binary star", "nova", "supernova"} or p["kind"] in P.STARS


def test_the_bright_stars_of_the_sky_say_so():
    by = {p["name"]: p for p in FILE["places"]}
    assert by["Sirius"]["vmag"] < 0 and by["Vega"]["vmag"] < 0.1 and by["Polaris"]["vmag"] < 2.5
    assert sum(1 for p in FILE["places"] if p.get("vmag", 9) < 4) >= 150
