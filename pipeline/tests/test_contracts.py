"""The shared contracts in Python: sx/contracts.py against the one list in tests/vectors/contracts.json, and
the checks of the three JSON contracts against the same cases and fixture files as the JavaScript checks."""
import copy
import dataclasses
import json
from pathlib import Path

import numpy as np
import pytest

from sx import contracts as C

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


LIST = load("tests/vectors/contracts.json")
CASES = load("tests/vectors/contract-cases.json")


def plain(value):
    """A constant as the list writes it."""
    if hasattr(value, "pattern"):
        return value.pattern
    return list(value) if isinstance(value, tuple) else value


def test_constants_are_those_of_the_list():
    for name, want in LIST["constants"].items():
        assert plain(getattr(C, name)) == want, name
    upper = {n for n in vars(C) if n.isupper() and not n.startswith("_")} - {"SCHEMA_DIR", "TYPE_CHECKING"}
    assert upper == set(LIST["constants"])


def test_records_have_the_fields_of_the_list_in_order():
    for name, fields in LIST["records"].items():
        t = getattr(C, name)
        got = [f.name for f in dataclasses.fields(t)] if dataclasses.is_dataclass(t) else list(t.__annotations__)
        assert got == fields, name


def test_every_other_name_of_the_list_exists():
    for name in LIST["others"]:
        assert hasattr(C, name), name


def test_schemas_hold_the_fields_of_the_contracts():
    numbers, checks, manifest = C.load_schema("numbers"), C.load_schema("checks"), C.load_schema("manifest")
    for schema, record in (
        (numbers["$defs"]["entry"], "NumberEntry"),
        (checks["$defs"]["row"], "CheckRow"),
        (manifest, "Manifest"),
        (manifest["$defs"]["frame"], "ShowcaseFrame"),
    ):
        optional = LIST.get("optional", {}).get(record, [])
        assert schema["required"] == [f for f in LIST["records"][record] if f not in optional]
        assert list(schema["properties"]) == LIST["records"][record]
        assert schema["additionalProperties"] is False
    assert checks["$defs"]["row"]["properties"]["status"]["enum"] == list(C.CHECK_STATUSES)


def test_key_regex_and_key_pattern_agree_on_real_keys():
    keys = [f["key"] for f in load("tests/fixtures/idx/expected.json")["frames"]]
    assert len(keys) == 342
    for key in keys:
        m = C.KEY_REGEX.fullmatch(key)
        assert m, key
        week, ver, det, obs, exp = m.groups()
        assert C.KEY_PATTERN.format(week=week, ver=ver, det=det, obs=int(obs), exp=exp) == key
    key = keys[0]
    for bad in ("", "level2.fits", key + "\n", " " + key, key.replace("dr1", "dr2"), key.replace("_spx_", "_spx_x")):
        assert C.KEY_REGEX.fullmatch(bad) is None, bad


def test_the_index_fixture_states_the_same_key_pattern_and_row_layout():
    meta = load("tests/fixtures/idx/meta.json")
    assert meta["key"] == C.KEY_PATTERN
    assert meta["row"] == "[" + ", ".join(C.INDEX_ROW) + "]"
    assert list(meta) == LIST["records"]["IndexMeta"]


def apply(doc, ops):
    out = copy.deepcopy(doc)
    for op in ops:
        kind, at = op[0], op[1]
        if not at:
            out = copy.deepcopy(op[2])
            continue
        o = out
        for k in at[:-1]:
            o = o[k]
        if kind == "set":
            o[at[-1]] = copy.deepcopy(op[2])
        elif kind == "del":
            del o[at[-1]]
        else:
            raise ValueError(kind)
    return out


CHECK = {"numbers": C.check_numbers, "checks": C.check_checks, "manifest": C.check_manifest}


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: f"{c['kind']}: {c['name']}")
def test_checks_agree_with_every_case(case):
    doc = apply(load("tests/" + CASES["bases"][case["kind"]]), case["ops"])
    problems = CHECK[case["kind"]](doc)
    assert (not problems) == case["valid"], problems


def test_fixture_files_of_the_three_contracts_are_valid():
    numbers, rows = load("tests/fixtures/contracts/numbers.json"), load("tests/fixtures/contracts/checks.json")
    assert C.check_numbers(numbers) == []
    assert C.check_checks(rows) == []
    assert C.check_numbers_have_checks(numbers, rows) == []
    assert C.check_numbers_have_checks({"x": {"check": "nowhere"}}, rows) == ['number "x": there is no Checks row "nowhere"']
    for folder in sorted((FIXTURES / "showcase").iterdir()):
        assert C.check_showcase(folder) == [], folder.name
    assert len(C.check_showcase(FIXTURES / "showcase" / "nowhere")) == 1


def test_a_showcase_with_a_binary_file_of_the_wrong_size_is_refused():
    manifest = load("tests/fixtures/showcase/barnard-d5/manifest.json")
    size = len(manifest["frames"]) * manifest["w"] * manifest["h"] * 4
    assert C.check_manifest(manifest, size, size) == []
    assert len(C.check_manifest(manifest, size - 4, size)) == 1
    assert len(C.check_manifest(manifest, size, 0)) == 1


def test_the_data_of_the_site_is_valid():
    numbers, rows = load("site/" + C.NUMBERS_FILE), load("site/" + C.CHECKS_FILE)
    assert C.check_numbers(numbers) == []
    assert C.check_checks(rows) == []
    assert C.check_numbers_have_checks(numbers, rows) == []
    tables = load("site/" + C.WAVE_TABLES_FILE)
    assert list(tables) == ["1", "2", "3", "4", "5", "6"]
    for det, t in tables.items():
        assert list(t) == LIST["records"]["WaveTable"]
        assert np.asarray(t["lam"]).shape == np.asarray(t["bw"]).shape == (len(t["Y"]), len(t["X"]))
        assert C.KEY_REGEX.fullmatch(t["src"])


def test_the_schema_checker_refuses_a_keyword_it_does_not_know():
    with pytest.raises(ValueError):
        C.validate(1, {"type": "number", "multipleOf": 2})
    with pytest.raises(ValueError):
        C.validate(1, {"$ref": "other.json"})
    assert C.validate(1, {"type": "number"}) == []
    assert len(C.validate(True, {"type": "number"})) == 1
    assert len(C.validate(1.5, {"type": "integer"})) == 1
    assert C.validate(2.0, {"type": "integer"}) == []
    assert C.validate(None, {"type": ["string", "null"], "minLength": 1}) == []
    assert len(C.validate("a\n", {"type": "string", "pattern": "^a$"})) == 1


@pytest.mark.parametrize("frame_id", ["barnard-d2", "eps-indi-d4", "eps-indi-d5"])
def test_a_frame_fixture_reads_as_a_stamp(frame_id):
    """The binary layout of the expected arrays, and that astropy reads the recorded header."""
    from astropy.io import fits

    folder = FIXTURES / "frames" / frame_id
    meta = json.loads((folder / "frame.json").read_text(encoding="utf-8"))
    s = meta["stamp"]
    data = np.fromfile(folder / meta["expected"]["data"], dtype="<f4").reshape(s["h"], s["w"])
    flags = np.fromfile(folder / meta["expected"]["flags"], dtype="<i4").reshape(s["h"], s["w"])
    stamp = C.Stamp(**s, data=data, flags=flags)
    assert [f.name for f in dataclasses.fields(stamp)] == LIST["records"]["Stamp"]
    assert int((~np.isfinite(stamp.data)).sum()) == meta["counts"]["nonfinite"]
    assert int((stamp.flags != 0).sum()) == meta["counts"]["flags_nonzero"]

    image = meta["hdus"][1]
    head = (folder / "bytes-0-28799.bin").read_bytes()
    header = fits.Header.fromstring(head[image["hdrLoc"]:image["datLoc"]].decode("ascii"))
    assert header["EXTNAME"] == "IMAGE" and header["NAXIS1"] == header["NAXIS2"] == 2040
    assert header["BUNIT"] == "MJy / sr" and header["DETECTOR"] == s["det"]
    assert abs(header["MJD-AVG"] - s["mjd"]) < 1e-9

    # the IMAGE rows of the stamp, straight from the recorded bytes
    start = image["datLoc"] + s["y0"] * 2040 * 4
    rows = np.frombuffer((folder / f"bytes-{start}-{start + s['h'] * 2040 * 4 - 1}.bin").read_bytes(), dtype=">f4")
    cut = rows.reshape(s["h"], 2040)[:, s["x0"]:s["x0"] + s["w"]]
    assert np.array_equal(cut.astype("<f4").view("<u4"), stamp.data.view("<u4"))
