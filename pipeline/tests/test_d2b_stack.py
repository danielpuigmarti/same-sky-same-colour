"""The flag table twin, and the co-add rule: the mean of the photos that may be used at each pixel, shown where half of
the photos saw it. The shared vectors with JavaScript are in test_d2_vectors.py (the "coadd" cases)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sx import flags as F  # noqa: E402
from sx import stack as S  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FULL = 1 << 12


def js_table() -> list[tuple[int, str, str]]:
    text = (ROOT / "site" / "js" / "lib" / "flags.js").read_text(encoding="utf-8")
    return [(int(b), n, t) for b, n, t in re.findall(r"\{ bit: (\d+), name: '(\w+)', label: '[^']*', tier: '(\w+)' \}", text)]


def test_flag_table_agrees_with_javascript():
    js = js_table()
    assert len(js) == 22
    assert list(F.FLAG_TABLE) == js


def test_masks_of_the_tiers():
    sat = sum(1 << b for b in (1, 15, 26))
    defect = sum(1 << b for b in (0, 2, 6, 9, 10, 11, 17, 19, 20, 22, 23, 24, 25, 27, 28))
    assert (F.SATURATION_MASK, F.DEFECT_MASK) == (sat, defect)
    assert F.SOURCE_MASK == 1 << 21


def test_usable_mask():
    one = np.ones(1, dtype=np.float32)
    for bit, name, tier in F.FLAG_TABLE:
        want = 0 if tier in ("saturation", "defect") else 1
        assert S.usable_mask(one, np.array([1 << bit], dtype=np.int32))[0] == want, name
    assert S.usable_mask(np.array([np.nan]), np.array([FULL], dtype=np.int32))[0] == 0
    assert S.usable_mask(one, None)[0] == 1


def hand_made():
    data = np.zeros((3, 12, 12), dtype=np.float32)
    flags = np.full((3, 12, 12), FULL, dtype=np.int32)
    for k, v in enumerate((1.0, 2.0, 4.0)):
        data[k, :4, :4] = v
    for k, d in {0: {0: 1 << 7, 1: 1 << 14, 2: 1 << 21, 3: 1 << 10, 4: 1 << 1}, 1: {3: 1 << 10, 4: 1 << 15, 6: 1 << 25},
                 2: {3: 1 << 10, 6: 1 << 22}}.items():
        for p, b in d.items():
            flags[k, p // 4, p % 4] |= b
    data[0, 1, 1] = np.nan
    data[2, 1, 3] = np.nan
    return data, flags


def test_three_photos_written_by_hand():
    d, f = hand_made()
    co = S.coadd([{"data": d[i], "flags": f[i]} for i in range(3)])
    assert co["background"] == [0.0, 0.0, 0.0] and co["need"] == 2 and co["photos"] == 3
    third = 7 / 3
    want = [(3, third, 0), (3, third, 0), (3, third, 0), (0, None, 0),
            (1, None, 0), (2, 3.0, 1), (1, None, 0), (2, 1.5, 1)] + [(3, third, 1)] * 8
    for p, (n, v, q) in enumerate(want):
        y, x = divmod(p, 4)
        assert co["n"][y, x] == n, p
        assert co["valid"][y, x] == (1 if n >= 2 else 0), p
        assert co["quiet"][y, x] == q, p
        if v is None:
            assert np.isnan(co["data"][y, x]), p
        else:
            assert abs(float(co["data"][y, x]) - v) < 1e-6, p
    assert co["n"].dtype == np.uint8 and co["n"][5, 5] == 3 and co["data"][5, 5] == 0


def test_need_is_half_rounded_up_and_at_least_one():
    rng = np.random.RandomState(1)
    for k, need in [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (8, 4)]:
        st = [{"data": rng.normal(0, 1, (12, 12)).astype(np.float32), "flags": None} for _ in range(k)]
        assert S.coadd(st)["need"] == need


def test_the_share_shown_does_not_shrink_with_more_photos():
    rng = np.random.RandomState(9)
    shares = []
    for k in (2, 4, 8):
        st = []
        for i in range(k):
            d = rng.normal(0, 1, (30, 30)).astype(np.float32)
            a, b = int(rng.randint(2, 8)), int(rng.randint(2, 8))
            d[:a, :b] = np.nan if i % 2 else d[:a, :b]
            d[30 - b:, 30 - a:] = np.nan if i % 2 == 0 else d[30 - b:, 30 - a:]
            f = np.full((30, 30), FULL, dtype=np.int32) | np.where(rng.uniform(size=(30, 30)) < 0.05, 1 << 10, 0).astype(np.int32)
            st.append({"data": d, "flags": f})
        shares.append(float(S.coadd(st)["valid"].mean()))
    assert min(shares) > 0.9, shares


def test_pair_is_compared_only_where_both_show_the_pixel():
    rng = np.random.RandomState(4)
    d = rng.normal(0, 1, (12, 12)).astype(np.float32)
    ok = np.full((12, 12), FULL, dtype=np.int32)
    hot = ok.copy()
    hot[0, :] |= 1 << 10
    a = S.coadd([{"data": d, "flags": ok}])
    b = S.coadd([{"data": d + 1, "flags": hot}])
    assert b["valid"][0].sum() == 0 and a["valid"].all()
    diff = S.difference(a, b)
    assert diff["valid"][0].sum() == 0 and diff["valid"][1:].all()
