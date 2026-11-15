"""The Python reader of the frame index gives the frames the fixture expects, and agrees with the full index."""
import json
from pathlib import Path

import pytest

from sx import index

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures" / "idx"


def _expected():
    return json.loads((FIX / "expected.json").read_text(encoding="utf-8"))


def test_fixture_tile_gives_the_expected_frames():
    e = _expected()
    got = index.frames_covering(e["ra"], e["dec"], FIX)
    assert [f["key"] for f in got] == [f["key"] for f in e["frames"]]
    assert got[0]["det"] == e["frames"][0]["det"]
    assert got[0]["tmid"] == pytest.approx(e["frames"][0]["tmid"], abs=1e-6)


def test_tile_names_and_indexed_flags_match_the_fixture():
    e = _expected()
    meta = json.loads((FIX / "meta.json").read_text(encoding="utf-8"))
    for c in e["indexed"]:
        assert index.tile_of(c["ra"], c["dec"], meta) == c["tile"]
        assert index.is_indexed(c["ra"], c["dec"], FIX) == c["indexed"]


@pytest.mark.skipif(not (index.INDEX_DIR / "meta.json").exists(), reason="the full index is not in the tree")
def test_full_index_holds_the_fixture_frames_and_is_complete():
    e = _expected()
    full = {f["key"] for f in index.frames_covering(e["ra"], e["dec"])}
    assert {f["key"] for f in e["frames"]} <= full
    assert index.is_indexed(e["ra"], e["dec"])
    meta = json.loads((index.INDEX_DIR / "meta.json").read_text(encoding="utf-8"))
    assert meta["n_frames"] == 1179406
    assert len(meta["complete"]) == 1654


def test_a_point_on_the_far_side_is_outside():
    square = [(10.0, -1.0), (12.0, -1.0), (12.0, 1.0), (10.0, 1.0)]
    assert index.inside(11.0, 0.0, square)
    assert not index.inside(191.0, 0.0, square)
    assert not index.inside(13.0, 0.0, square)
