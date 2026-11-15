"""The false-positive job's pure parts (no network): the flag tiers agree with the page's table, the names of flag words,
the separation in pixels, and the pair-of-visits logic of twins() and pairs_at() on a small fake plan."""
import math
import re
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _p4lib as L  # noqa: E402
from jobs import falsepos as FP  # noqa: E402
from sx.fits import FLAG  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def js_tier_mask(tier: str) -> int:
    text = (ROOT / "site" / "js" / "lib" / "flags.js").read_text(encoding="utf-8")
    word = 0
    for m in re.finditer(r"\{ bit: (\d+), name: '(\w+)', label: '[^']*', tier: '(\w+)' \}", text):
        if m.group(3) == tier:
            word |= 1 << int(m.group(1))
    return word


def test_tiers_are_the_ones_of_the_page():
    assert FP.SAT == js_tier_mask("saturation")
    assert FP.DEFECT == js_tier_mask("defect")
    assert FP.FLAGGED == FP.SAT | FP.DEFECT
    assert FP.FLAGGED & FLAG["SOURCE"] == 0 and FP.FLAGGED & FLAG["FULLSAMPLE"] == 0


def test_names_of_a_flag_word_leave_out_fullsample():
    word = FLAG["FULLSAMPLE"] | FLAG["SOURCE"] | FLAG["GHOST"]
    assert FP.names_of(word) == ["SOURCE", "GHOST"]
    assert FP.names_of(FLAG["FULLSAMPLE"]) == []


def test_separation_in_pixels():
    d = FP.sep_px(10.0, 0.0, [10.0, 10.0 + 6.15 / 3600], [6.15 / 3600, 0.0])
    assert d[0] == pytest.approx(1.0, rel=1e-6)
    assert d[1] == pytest.approx(1.0, rel=1e-3)


PREFIX = "dr1/level2/w/v/4/"


def info(name, mjd, lam, bw=0.02):
    return {"key": PREFIX + name, "det": 4, "tmid": mjd, "mjd": mjd, "px": 500.0, "py": 500.0, "lam": lam, "bw": bw, "y0": 452, "h": L.STAMP}


def fake_plan(monkeypatch):
    a = [info(f"a{i}", 100.0 + i, 3.0 + 0.1 * i) for i in range(4)]
    b = [info(f"b{i}", 300.0 + i, 3.0 + 0.1 * i + 0.001) for i in range(4)]
    c = [info(f"c{i}", 500.0 + i, 3.2 + 0.1 * i + 0.001) for i in range(4)]
    allinfo = {x["key"]: x for x in a + b + c}
    vk = [[x["key"] for x in v] for v in (a, b, c)]
    vis = [{"n": 4, "first": 100.0, "last": 103.0, "short": False}, {"n": 4, "first": 300.0, "last": 303.0, "short": False},
           {"n": 4, "first": 500.0, "last": 503.0, "short": False}]

    def fake(ra, dec, det, min_pairs=3, visit_pair=None):
        p = L.Plan(ra, dec, det, True, info=allinfo, visit_keys=vk, visits=vis)
        if visit_pair is not None:
            from sx import match

            va, vb = visit_pair
            ia, ib = [allinfo[k] for k in vk[va]], [allinfo[k] for k in vk[vb]]
            p.visit_pair, p.infos_a, p.infos_b = visit_pair, ia, ib
            p.pairs = [(int(i), int(j)) for i, j in match.match_pairs(ia, ib)]
        return p

    monkeypatch.setattr(L, "plan", fake)


def test_twins_matches_a_photo_with_one_of_each_other_visit(monkeypatch):
    fake_plan(monkeypatch)
    out = FP.twins(PREFIX + "a1", 1.0, 2.0)
    assert [(a, b, vp) for (a, b), vp in out] == [(PREFIX + "a1", PREFIX + "b1", (0, 1))]  # no photo of visit c has the colour of a1
    out = FP.twins(PREFIX + "c1", 1.0, 2.0)
    assert [(a, b, vp) for (a, b), vp in out] == [(PREFIX + "a3", PREFIX + "c1", (0, 2)), (PREFIX + "b3", PREFIX + "c1", (1, 2))]
    assert FP.twins(PREFIX + "zz", 1.0, 2.0) == []


def test_pairs_at_puts_the_chosen_pair_first_and_does_not_use_its_photos_twice(monkeypatch):
    fake_plan(monkeypatch)
    p, pairs = FP.pairs_at(1.0, 2.0, 4, PREFIX + "a1", PREFIX + "b1", (0, 1), limit=3)
    assert (pairs[0][0]["key"], pairs[0][1]["key"]) == (PREFIX + "a1", PREFIX + "b1")
    assert len(pairs) == 3
    used = [x["key"] for pr in pairs for x in pr]
    assert len(used) == len(set(used))


def test_rules_of_the_four_questions_are_stated():
    assert FP.RULES["radius_px"] == 2.0 and FP.RULES["bright_g_max"] == 14.0 and FP.RULES["fast_mas_per_year"] == 500.0
    assert FP.RULES["flag_tiers"] == ["saturation", "defect"] and FP.RULES["min_pairs"] == 2 and FP.RULES["residual_units"] == 3.0
