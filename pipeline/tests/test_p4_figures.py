"""The drawing code of diffcheck, limits and falsepos on synthetic runs (no network): the pictures are made, are not empty
and go where the job says; nothing is written into the real output folders."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _p4lib as L  # noqa: E402
from jobs import diffcheck as D  # noqa: E402
from jobs import limits as LIM  # noqa: E402
from test_p4_lib import N, fake_inject, synthetic_plane  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]


def fake_run_with_images(seed: int, n_pairs: int = 3) -> dict:
    pa = [synthetic_plane(seed + i) for i in range(n_pairs)]
    pb = [synthetic_plane(seed + 50 + i) for i in range(n_pairs)]
    infos_a = [{"key": f"a{i}", "lam": 2.0 + 0.1 * i, "bw": 0.03, "mjd": 100.0 + i} for i in range(n_pairs)]
    infos_b = [{"key": f"b{i}", "lam": 2.0 + 0.1 * i, "bw": 0.03, "mjd": 300.0 + i} for i in range(n_pairs)]
    plan = L.Plan(1.0, 2.0, 2, True, infos_a=infos_a, infos_b=infos_b, pairs=[(i, i) for i in range(n_pairs)],
                  visits=[{"n": n_pairs, "first": 100.0, "last": 102.0, "short": False}] * 2, visit_pair=(0, 1))
    co = L.difference_of(pa, pb)
    flips = [L.difference_of([a], [b]) for a, b in zip(pa, pb)]
    return {"ra": 1.0, "dec": 2.0, "det": 2, "plan": plan, "ok": True, "why": "", "grid": L.sky_grid(1.0, 2.0), "pa": pa, "pb": pb,
            "used": [(i, i) for i in range(n_pairs)], "co": co, "flips": flips, "valid_by_pairs": [0.9, 0.7, 0.5][:n_pairs]}


def fake_result():
    positions, runs = [], {}
    names = ["ecl_000", "mid_p35", "hi_m65"] + [f"p{i}" for i in range(17)]
    for k, name in enumerate(names):
        r = fake_run_with_images(10 * k)
        runs[(name, 2)] = r
        positions.append({"name": name, "ra": 1.0, "dec": 2.0, "ecl_lat": float(k), "runs": [D.summarise(r)]})
    stars = []
    for k in range(20):
        r = fake_run_with_images(1000 + 10 * k)
        t = {"testable": True, "pair": k % 2 == 0, "peak_resid_pct": 30.0 + k, "flux_resid_pct": 1.0, "peak_units": 200.0}
        stars.append({"ok": True, "source_id": str(k), "G": 10.0 + 0.1 * k, "det": 4, "pairs": 3, "coadd": dict(t), "flips": [dict(t) for _ in range(3)],
                      "cx": 31.5, "cy": 31.5, "_run": r, "valid_by_pairs": r["valid_by_pairs"]})
    return {"positions": positions, "stars": stars, "inject": [dict(fake_inject(), name=f"p{i}") for i in range(10)], "_runs": runs}


@pytest.fixture
def folders(tmp_path, monkeypatch):
    monkeypatch.setattr(D, "IMG", tmp_path / "img")
    monkeypatch.setattr(D, "REVIEW", tmp_path / "review")
    monkeypatch.setattr(LIM, "IMG", tmp_path / "img")
    return tmp_path


def test_summarise_gives_plain_numbers():
    r = fake_run_with_images(1)
    s = D.summarise(r)
    assert s["ok"] and s["pairs"] == 3 and len(s["flips"]) == 3 and s["coadd"]["n"] > 0 and s["coadd"]["basis"] in ("quiet", "valid")
    import json

    json.dumps(s)  # plain JSON values only
    assert s["dt_days"] == pytest.approx(200.0)


def test_k8_flipbook_and_h8_pictures_are_made(folders):
    res = fake_result()
    rule = D.load_rule()
    ev = D.evaluate(res, rule)
    for p in (D.k8_figure(res, ev, rule), D.flipbook_figure(res)):
        assert p.exists() and p.stat().st_size > 5000 and str(p).startswith(str(folders))
    sheet, info = D.h8_sheet(res, ev, rule)
    assert sheet.exists() and sheet.stat().st_size > 20000
    assert set(info) == {"Barnard's Star", "R Draconis", "Comet Lemmon"}
    # the page's rule: saturation is hatched on Barnard's Star and R Draconis, SOURCE is counted and never hatched
    assert info["Barnard's Star"]["saturation"] > 0 and info["R Draconis"]["saturation"] > 0
    sn = D.star_numbers(res)
    text = D.h8_text(res, ev, rule, info, sn, "UNVERIFIED")
    assert "It passes if" in text and "Numbers to read" in text and "never hatched" in text


def test_limits_figure_is_made(folders):
    doc = {"speeds_arcsec_per_year": LIM.SPEEDS, "fluxes_mjy": LIM.FLUXES, "views": {"coadd": {}, "pair": {}}}
    for view in ("coadd", "pair"):
        for det in range(1, 7):
            frac = [[0.0 if j < 8 + k else 1.0 for j in range(len(LIM.FLUXES))] for k in range(len(LIM.SPEEDS))]
            doc["views"][view][str(det)] = {"positions": 3, "fraction": frac, "limit_mjy": [LIM.limit_flux(r) for r in frac]}
    p = LIM.figure(doc)
    assert p.exists() and p.stat().st_size > 5000 and str(p).startswith(str(folders))


def test_valid_table_and_star_numbers():
    res = fake_result()
    vt = D.valid_table(res)
    assert len(vt) == 3 and vt[0] > vt[-1]
    sn = D.star_numbers(res)
    assert sn["n"] == 20 and 30 <= sn["peak_median"] <= 50 and sn["flux_abs_median"] == pytest.approx(1.0)
    assert "Never say that stars cancel" in D.caption_text(sn, {})
    assert "do not say that stars cancel" in D.caption_text({"n": 0}, {})
