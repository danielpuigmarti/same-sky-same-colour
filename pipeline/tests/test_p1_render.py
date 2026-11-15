"""render.py: the stretch, the PNG writer, and the CT-8 showcase writer (against the showcase fixture)."""
import json
import math

import matplotlib.image as mpimg
import numpy as np
import pytest

from sx import contracts as C
from sx import render
from test_p1_support import FIX


def test_stretch_endpoints_and_monotone():
    x = np.array([-5.0, 0.0, 0.1, 1.0, 5.0, np.nan])
    g = render.stretch(x, 0.0, 1.0)
    assert g[0] == 0 and g[1] == 0 and g[3] == pytest.approx(1.0) and g[4] == pytest.approx(1.0)
    assert np.isnan(g[5])
    assert g[1] < g[2] < g[3]
    assert g[2] == pytest.approx(math.asinh(1.0) / math.asinh(10.0))  # u = 0.1


def test_rgb_marks_missing_values_and_flips_rows():
    a = np.array([[0.0, 1.0], [np.nan, 0.5]], np.float32)
    rgb = render.to_rgb(a, 0.0, 1.0)
    assert tuple(rgb[0, 0]) == render.NAN_RGB  # the second row of the stamp is drawn on top
    assert tuple(rgb[1, 1]) == (255, 255, 255) and tuple(rgb[1, 0]) == (0, 0, 0)
    assert tuple(render.to_rgb(a, 0.0, 1.0, flip=False)[1, 0]) == render.NAN_RGB


def test_png_is_valid_and_the_same_every_time(tmp_path):
    a = np.random.default_rng(0).uniform(0, 1, (16, 24)).astype(np.float32)
    p1 = render.asinh_png(tmp_path / "a.png", a, 0, 1)
    p2 = render.asinh_png(tmp_path / "b.png", a, 0, 1)
    assert p1.read_bytes() == p2.read_bytes()
    img = mpimg.imread(p1)
    assert img.shape[:2] == (16, 24)
    assert np.allclose(img[::-1, :, 0] * 255, (render.stretch(a, 0, 1) * 255 + 0.5).astype(np.uint8), atol=0.51)
    big = render.asinh_png(tmp_path / "c.png", a, 0, 1, scale=3)
    assert mpimg.imread(big).shape[:2] == (48, 72)


def test_strip_has_a_gap(tmp_path):
    a = np.zeros((8, 8), np.float32)
    p = render.strip_png(tmp_path / "s.png", [a, a], 0, 1, scale=2, gap=3)
    assert mpimg.imread(p).shape[:2] == (16, 16 + 3 + 16)


class Fake:
    def __init__(self, key, mjd, lam, data, flags):
        self.key, self.det, self.mjd, self.w, self.h = key, 5, mjd, 64, 64
        self.x0, self.y0, self.tx, self.ty, self.lam, self.bw = 1000, 900, 31.5, 32.5, lam, 0.04
        self.data, self.flags = data, flags


def fixture_stamps():
    m = json.loads((FIX / "showcase" / "barnard-d5" / "manifest.json").read_text())
    n = m["w"] * m["h"]
    data = np.fromfile(FIX / "showcase" / "barnard-d5" / "stamps.bin", "<f4").reshape(len(m["frames"]), m["h"], m["w"])
    flags = np.fromfile(FIX / "showcase" / "barnard-d5" / "flags.bin", "<i4").reshape(len(m["frames"]), m["h"], m["w"])
    st = []
    for f, d, fl in zip(m["frames"], data, flags):
        s = Fake(f["key"], f["mjd"], f["lam"], d, fl)
        s.bw, s.x0, s.y0, s.tx, s.ty = f["bw"], f["x0"], f["y0"], f["tx"], f["ty"]
        st.append(s)
    return m, st


def test_showcase_written_from_the_fixture_stamps_equals_the_fixture(tmp_path):
    m, st = fixture_stamps()
    folder = tmp_path / m["id"]
    # shuffle the input: the writer sorts by time and maps the pairs
    order = [2, 0, 3, 1]
    new_pos = {old: i for i, old in enumerate(order)}
    out = render.write_showcase(folder, m["id"], m["name"], m["ra"], m["dec"], [st[i] for i in order],
                                [m["frames"][i]["visit"] for i in order],
                                [(new_pos[a], new_pos[b]) for a, b in m["pairs"]], m["refs"], m["numbers"],
                                display_grid=False)
    assert out == m
    for name in ("stamps.bin", "flags.bin"):
        assert (folder / name).read_bytes() == (FIX / "showcase" / "barnard-d5" / name).read_bytes()
    assert C.check_showcase(folder) == []


def test_showcase_without_flags_and_with_preview(tmp_path):
    m, st = fixture_stamps()
    folder = tmp_path / "x"
    out = render.write_showcase(folder, "x", "X", 1.0, 2.0, st, [f["visit"] for f in m["frames"]], m["pairs"],
                                with_flags=False, preview=(-1.0, 20.0), display_grid=False)
    assert out["flags"] is None and not (folder / "flags.bin").exists()
    assert (folder / "pair.png").exists()
    assert C.check_showcase(folder) == []


def test_showcase_refuses_what_breaks_the_contract(tmp_path):
    m, st = fixture_stamps()
    vis = [f["visit"] for f in m["frames"]]
    with pytest.raises(ValueError, match="folder is named"):
        render.write_showcase(tmp_path / "a", "b", "B", 1, 2, st, vis, m["pairs"])
    with pytest.raises(ValueError, match="contract"):
        render.write_showcase(tmp_path / "c", "c", "C", 1, 2, st, vis, [(1, 0)], display_grid=False)  # later visit first
    st[0].det = 4
    with pytest.raises(ValueError, match="one detector"):
        render.write_showcase(tmp_path / "d", "d", "D", 1, 2, st, vis, m["pairs"], display_grid=False)
