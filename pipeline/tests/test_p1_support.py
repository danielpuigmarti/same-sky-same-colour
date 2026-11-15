"""Helpers shared by the P1 tests (this file holds no tests): the recorded bytes of the frame fixtures as a
byte-range source, so that frames can be read with no network."""
import json
import os
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "tests" / "fixtures"
DATA = Path(__file__).resolve().parent / "p1_data"
FRAME_IDS = ["barnard-d2", "eps-indi-d4", "eps-indi-d5"]

needs_network = pytest.mark.skipif(os.environ.get("SX_OFFLINE") == "1", reason="SX_OFFLINE=1")


def load_frame(id_):
    meta = json.loads((FIX / "frames" / id_ / "frame.json").read_text())
    ranges = [(r["start"], r["end"], (FIX / "frames" / id_ / r["file"]).read_bytes()) for r in meta["ranges"]]
    data = np.fromfile(FIX / "frames" / id_ / meta["expected"]["data"], "<f4").reshape(64, 64)
    flags = np.fromfile(FIX / "frames" / id_ / meta["expected"]["flags"], "<i4").reshape(64, 64)
    return meta, ranges, data, flags


def recorded_source(*ids):
    """A byte-range source answering from the recorded ranges of the frame fixtures; raises for any other
    range, so a test fails if the reader asks for bytes that were not recorded."""
    book = {}
    sizes = {}
    for i in ids:
        meta, ranges, _, _ = load_frame(i)
        book[meta["key"]] = ranges
        sizes[meta["key"]] = meta["size"]

    def source(key, a, b):
        for s, e, blob in book[key]:
            if s <= a and b <= e:
                return blob[a - s : b - s + 1]
        raise AssertionError(f"range {a}-{b} of {key} was not recorded")

    source.sizes = sizes
    return source
