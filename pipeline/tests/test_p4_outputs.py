"""What the P4 jobs wrote, checked against the contracts and against each other (no network): the decisions of S3, the
limits table, the four false-positive showcases and their expected answers, the Checks rows and the numbers."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

from sx import checks, contracts as C

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
sys.path.insert(0, str(ROOT / "pipeline"))


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_the_rules_were_frozen_with_their_positions():
    rule = load(ROOT / "pipeline" / "frozen" / "pb6_rule.json")
    pos = rule["positions"]
    assert len(pos) == 20 == rule["tests"]["empty"]["positions"]
    assert sum(p["source"] == "earlier test" for p in pos) == 10
    assert all(p["brightest_g_5arcmin"] is None or p["brightest_g_5arcmin"] >= 13 for p in pos)
    assert all(abs(p["gal_b"]) > 15 for p in pos)
    dets = {d for p in pos for d in p["dets"]}
    assert dets == {1, 2, 3, 4, 5, 6}
    lats = sorted(abs(p["ecl_lat"]) for p in pos)
    assert lats[0] < 8 and lats[-1] > 55  # spread in ecliptic latitude


def test_decisions_of_s3_have_both_views_and_a_caption():
    d = load(DATA / "checks" / "decisions" / "p4.json")
    assert set(d) == {"S3"} and set(d["S3"]) == {"difference", "flipbook"}
    for view, v in d["S3"].items():
        assert set(v) == {"build", "why"} and isinstance(v["build"], bool) and isinstance(v["why"], str)
        assert "Caption:" in v["why"] and "standard errors" in v["why"] and "comparison stars" in v["why"]
        assert "candidate" not in v["why"].lower()
    # the decision follows the rule: a view that is built passes all three tests, one that is not names what failed
    for v in d["S3"].values():
        assert (" All three tests pass." in v["why"]) == v["build"]


def test_limits_table_is_complete_and_made_by_the_rule_on_disk():
    lim = load(DATA / "checks" / "limits.json")
    rule = ROOT / "pipeline" / "frozen" / "limits_rule.json"
    assert lim["rule_sha256"] == hashlib.sha256(rule.read_bytes()).hexdigest()
    assert lim["units"] == 5 and lim["fraction"] == 0.8
    assert len(lim["fluxes_mjy"]) == 21 and len(lim["speeds_arcsec_per_year"]) == 8
    for view in ("coadd", "pair"):
        assert len(lim["table"][view]) == 8
        for det in "123456":
            v = lim["views"][view][det]
            assert v is not None and len(v["fraction"]) == 8 and len(v["limit_mjy"]) == 8
            for row in v["fraction"]:
                assert len(row) == 21 and all(x is None or 0.0 <= x <= 1.0 for x in row)
            for k, limit in enumerate(v["limit_mjy"]):
                if limit is not None:  # the limit is a flux of the grid from which every higher flux shows
                    j = lim["fluxes_mjy"].index(limit)
                    assert all(x is not None and x >= 0.8 for x in v["fraction"][k][j:])
        for row in lim["table"][view]:
            assert set(row["limit_mjy"]) == set("123456")
    assert len(lim["runs"]) >= 12
    assert all(r["pairs"] >= 4 for r in lim["runs"])


def test_four_false_positive_cases_and_their_showcases():
    doc = load(DATA / "falsepos" / "cases.json")
    assert [c["id"] for c in doc["cases"]] == ["star-a", "star-b", "ghost", "persist"]
    for c in doc["cases"]:
        folder = DATA / c["showcase"]
        assert C.check_showcase(folder) == []
        m = load(folder / "manifest.json")
        assert m["id"] == c["id"] and len(m["pairs"]) >= 3 and m["flags"] == "flags.bin"
        assert {f["visit"] for f in m["frames"]} == {0, 1}
        a, b = c["residual"]["pair"]
        assert m["frames"][a]["mjd"] < m["frames"][b]["mjd"] and c["residual"]["pair"] in m["pairs"]
        for tag, fr in (("a", a), ("b", b)):
            click = c["residual"]["click"][tag]
            assert click["frame"] == fr and 0 <= click["x"] < m["w"] and 0 <= click["y"] < m["h"]
        e = c["expected"]
        assert set(e) == {"flagged", "more_than_one_pair", "bright_gaia_star_within_2px", "on_fast_star_ring"}
        assert abs(c["residual"]["units"]) >= doc["rules"]["residual_units"]
        assert e["on_fast_star_ring"]["answer"] is False
    by = {c["id"]: c["expected"] for c in doc["cases"]}
    for cid in ("star-a", "star-b"):
        assert by[cid]["bright_gaia_star_within_2px"]["answer"] is True and by[cid]["more_than_one_pair"]["answer"] is True
        assert by[cid]["flagged"]["answer"] is False
    assert by["ghost"]["flagged"]["answer"] is True and "GHOST" in by["ghost"]["flagged"]["flags"]
    assert by["persist"]["flagged"]["answer"] is True and "PERSIST" in by["persist"]["flagged"]["flags"]
    for cid in ("ghost", "persist"):
        assert by[cid]["more_than_one_pair"]["answer"] is False and by[cid]["bright_gaia_star_within_2px"]["answer"] is False


def test_rows_k8_and_k10_have_one_image_each():
    rows = load(DATA / "checks" / "rows" / "p4.json")
    assert [r["id"] for r in rows] == ["K8", "K10"]
    assert C.check_checks(rows) == []
    for r in rows:
        assert r["image"] and r["image_sha256"]
        path = DATA / "checks" / r["image"]
        assert checks.sha256(path) == r["image_sha256"]
        assert r["status"] in ("UNVERIFIED", "PASS", "FAIL", "LIMIT") and (r["status"] != "PASS" or (r["reviewer_role"] and r["reviewed_on"]))
        assert len(r["rule_commit"]) == 40 and all(c in "0123456789abcdef" for c in r["rule_commit"])
    assert (DATA / "checks" / "img" / "k8-pb6.png").exists() and (DATA / "checks" / "img" / "k10-limits.png").exists()


def test_numbers_of_p4_are_valid_and_name_their_checks():
    n = load(DATA / "numbers" / "p4.json")
    assert C.check_numbers(n) == []
    assert {v["check"] for v in n.values()} <= {"K8", "K10", None}
    for k in ("pb6.empty.positions", "pb6.empty.coadd", "pb6.empty.flipbook", "pb6.stars.total", "pb6.stars.coadd", "pb6.inject.total", "limits.runs"):
        assert k in n
    assert n["pb6.empty.positions"]["value"] == 20 and n["pb6.stars.total"]["value"] == 20 and n["pb6.inject.total"]["value"] == 10


def test_review_sheets_exist():
    for name in ("h8.md", "h8.png", "h9.md", "h9.png"):
        assert (ROOT / "review" / name).exists()
    text = (ROOT / "review" / "h8.md").read_text(encoding="utf-8")
    assert "It passes if" in text and "Numbers to read" in text
    t9 = (ROOT / "review" / "h9.md").read_text(encoding="utf-8")
    assert "new" not in t9.replace("no wording says 'new' or 'candidate'", "").lower().split("numbers to read")[1].split("it passes if")[0]
