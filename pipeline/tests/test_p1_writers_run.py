"""checks.py, numbers.py, frozen.py, irsa.py (parsing) and run.py."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

from sx import checks, frozen, numbers, run
from sx import contracts as C

ROOT = Path(__file__).resolve().parents[2]


def make_row(**kw):
    base = dict(id="T1", title="t", claim="c", test="t", pass_rule="r", status="UNVERIFIED", plain="p")
    base.update(kw)
    return checks.row(**base)


def test_row_has_every_field_of_the_contract_in_order():
    r = make_row()
    assert list(r) == list(C.CheckRow.__annotations__)
    assert C.check_checks([r]) == []


def test_image_ref_is_relative_to_checks_and_hashes_the_file(tmp_path, monkeypatch):
    img = checks.DATA / "checks" / "img" / "k1-lines.png"
    if not img.exists():
        pytest.skip("run the lines job first")
    rel, sha = checks.image_ref(img)
    assert rel == "img/k1-lines.png" and sha == hashlib.sha256(img.read_bytes()).hexdigest()


def test_write_rows_refuses_a_pass_without_a_reviewer(tmp_path):
    with pytest.raises(ValueError, match="PASS"):
        checks.write_rows("t", [make_row(status="PASS")], tmp_path)
    p = checks.write_rows("t", [make_row(status="PASS", reviewer_role="science", reviewed_on="2026-11-15")], tmp_path)
    assert json.loads(p.read_text())[0]["reviewer_role"] == "science"
    assert p.read_text().endswith("\n")


def test_write_rows_refuses_a_picture_without_its_hash(tmp_path):
    with pytest.raises(ValueError):
        checks.write_rows("t", [make_row(image=("img/x.png", None))], tmp_path)


def test_numbers_text_and_merge(tmp_path):
    assert numbers.text(60000) == "60,000" and numbers.text(1.28184, 5) == "1.28184"
    e = numbers.entry(1200, 0, check=None)
    assert e == {"value": 1200, "err": None, "unit": None, "text": "1,200", "check": None}
    numbers.write("t", {"b.x": e}, tmp_path)
    numbers.write("t", {"a.y": numbers.entry(2.5, 1, err=0.1, unit="µm")}, tmp_path)
    got = json.loads((tmp_path / "t.json").read_text(encoding="utf-8"))
    assert list(got) == ["a.y", "b.x"] and got["a.y"]["err"] == 0.1
    numbers.write("t", {"b.x": numbers.entry(3, 0)}, tmp_path)
    assert json.loads((tmp_path / "t.json").read_text(encoding="utf-8"))["b.x"]["value"] == 3


def test_numbers_refuse_a_bad_key(tmp_path):
    with pytest.raises(ValueError):
        numbers.write("t", {"bad key": numbers.entry(1)}, tmp_path)


def test_frozen_list_records_loads_and_keeps_other_jobs(tmp_path):
    f = tmp_path / "obs_ids.json"
    assert frozen.load("a", f) is None
    assert frozen.record("a", ["k2", "k1", "k2"], f) == ["k1", "k2"]
    frozen.record("b", ["z"], f)
    frozen.record("a", ["k3"], f)
    assert frozen.load("a", f) == ["k3"] and frozen.load("b", f) == ["z"]
    assert list(json.loads(f.read_text())) == ["a", "b"]


def test_frames_for_finds_once_then_reads_the_record(tmp_path):
    f = tmp_path / "obs_ids.json"
    calls = []

    def find():
        calls.append(1)
        return ["b", "a"]

    assert frozen.frames_for("j", find, f) == ["a", "b"]
    assert frozen.frames_for("j", find, f) == ["a", "b"]
    assert len(calls) == 1


def test_the_frozen_file_of_the_repository_is_sorted_and_holds_real_keys():
    data = json.loads(frozen.FILE.read_text())
    assert data, "no job has recorded frames yet"
    for job, keys in data.items():
        assert keys == sorted(set(keys)), job
        assert all(C.KEY_REGEX.fullmatch(k) for k in keys), job


def test_sia_row_parsing_keeps_only_level2_keys(monkeypatch, tmp_path):
    from sx import irsa

    monkeypatch.setenv("SX_CACHE", str(tmp_path))
    votable = """<?xml version="1.0"?><VOTABLE version="1.3" xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
<FIELD name="access_url" datatype="char" arraysize="*"/><FIELD name="obs_id" datatype="char" arraysize="*"/>
<FIELD name="t_min" datatype="double"/><FIELD name="t_max" datatype="double"/><DATA><TABLEDATA>
<TR><TD>https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W23_2B/l2b-v27-2026-201/5/level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits</TD><TD>2025W23_2B_0441_4</TD><TD>60833.5</TD><TD>60833.6</TD></TR>
<TR><TD>https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/other/thing.fits</TD><TD>x</TD><TD>1</TD><TD>2</TD></TR>
</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>"""

    class R:
        status_code = 200
        content = votable.encode()

    monkeypatch.setattr(irsa.requests, "get", lambda *a, **k: R())
    out = irsa.sia_frames(10.0, 20.0)
    assert out == [{"key": "dr1/level2/2025W23_2B/l2b-v27-2026-201/5/level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits",
                    "det": 5, "obs_id": "2025W23_2B_0441_4", "tmin": 60833.5, "tmax": 60833.6}]


# -- run.py ----------------------------------------------------------------------------------------


def test_jobs_are_listed_in_the_given_order():
    n = run.names()
    assert n.index("wave_tables") < n.index("lines")
    assert {"wave_tables", "lines", "placement"} <= set(n)


def test_unknown_job_is_an_error(capsys):
    assert run.main(["nosuchjob"]) == 2
    assert "no job" in capsys.readouterr().err


def test_all_runs_every_job_and_reports_failures(monkeypatch, capsys):
    seen = []

    def fake(name, argv):
        seen.append(name)
        if name == "lines":
            return 1
        return 0

    monkeypatch.setattr(run, "run_job", fake)
    monkeypatch.setattr(run, "names", lambda: ["wave_tables", "lines", "placement"])
    assert run.main(["all"]) == 1
    assert seen == ["wave_tables", "lines", "placement"]
    assert "failed: lines" in capsys.readouterr().err


def test_a_job_module_runs_through_run_job(monkeypatch, tmp_path):
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / "dummy.py").write_text("def main(argv):\n    return 7 if argv == ['x'] else 0\n")
    monkeypatch.setattr(run, "PIPELINE", tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    for m in [m for m in sys.modules if m == "jobs" or m.startswith("jobs.")]:
        monkeypatch.delitem(sys.modules, m)
    assert run.run_job("dummy", ["x"]) == 7
    assert run.run_job("dummy", []) == 0
    for m in [m for m in sys.modules if m == "jobs" or m.startswith("jobs.")]:
        sys.modules.pop(m, None)
