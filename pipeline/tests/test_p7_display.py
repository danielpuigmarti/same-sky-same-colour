"""The display grid: sx.display against tests/vectors/display.json, and the grid in a written showcase.

The vector file is made from real stamps by `python tests/test_p7_display.py --write` (run in pipeline/, needs the
network or the download cache); the tests read it and never ask the network. The browser's twin,
site/js/lib/display.js, is tested against the same file.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sx import contracts as C  # noqa: E402
from sx import display, render, s3  # noqa: E402
from sx.fits import FrameFile  # noqa: E402
from sx.stamp import StampVar  # noqa: E402
from test_p1_support import FRAME_IDS, load_frame, recorded_source  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VECTORS = ROOT / "tests" / "vectors" / "display.json"

ABOUT = (
    "Cases for the display grid. Each case holds a real stamp cut from a frame of SPHEREx (key, the turn of north on "
    "the detector) and what to_display_grid must give for it; null stands for NaN. size is the side of the display "
    "grid; its target pixel is (size // 2, size // 2), 0-based, first row at the lowest y; east is to the left and "
    "north is up, PIXEL_ARCSEC (6.15) arcsec per pixel. For the output pixel (i, j): east = (c - i) * pixelDeg, "
    "north = (j - c) * pixelDeg, c = size // 2; with [a, b, c2, d] = sky.cd and det = a*d - b*c2: "
    "dx = (d*east - b*north) / det, dy = (a*north - c2*east) / det; the source pixel is "
    "(floor(tx + dx + 0.5), floor(ty + dy + 0.5)), and it is -1, -1 (data NaN, flags 0) when outside the stamp. "
    "data, flags, sx, sy are row by row, first row at the lowest y. gridSky is the sky of the display grid. "
    "localSky holds, for pixels of recorded frames (the folders of tests/fixtures/frames), what local_sky must give: "
    "x and y are full-frame pixels, 0-based."
)

# (frame found among the showcases, or a bucket key) and where to cut; the turn of north is measured, not assumed
CASES = [
    ("turn near 0", "2026W11_2A/l2b-v27-2026-234", 501, 3, 5, "pos", (269.44636, 4.76706), 24, 24),
    ("turn near 70", "2025W50_2A/l2b-v27-2026-210", 333, 3, 2, "pos", None, 24, 24),
    ("turn near 90", "2025W51_1A/l2b-v27-2026-210", 20, 1, 3, "pos", (271.2132, 70.39155), 24, 24),
    ("turn near 147", "2025W39_2A/l2b-v27-2026-239", 436, 1, 2, "pos", (274.135825, 70.926575), 24, 24),
    ("turn near 176", "2026W10_1A/l2b-v27-2026-229", 445, 1, 4, "pos", None, 24, 24),
    ("turn near 181", "2025W35_1A/l2b-v27-2026-230", 146, 1, 5, "pos", (269.44636, 4.76706), 24, 24),
    ("turn near 251", "2025W27_1A/l2b-v27-2026-214", 555, 1, 2, "pos", None, 24, 24),
    ("target near the edge of the detector, larger grid", "2025W39_2A/l2b-v27-2026-239", 436, 1, 2, "edge", (4.0, 1000.0), 24, 33),
    ("odd size and a smaller grid, turn near 147", "2025W39_2A/l2b-v27-2026-239", 436, 2, 2, "pos", None, 25, 15),
]


def _key(week_ver, obs, exp, det):
    week, ver = week_ver.split("/")
    return C.KEY_PATTERN.format(week=week, ver=ver, det=det, obs=obs, exp=exp)


def turn_of(sky):
    """The angle, degrees, at which north lies from the +y direction of the detector, towards east."""
    cd = sky["cd"]
    return math.degrees(math.atan2(cd[1], cd[3])) % 360.0


def _clean(a):
    return [None if isinstance(v, float) and math.isnan(v) else v for v in np.asarray(a).ravel().tolist()]


def _stamp_from(case):
    s = case["stamp"]
    data = np.array([float("nan") if v is None else v for v in s["data"]], np.float32).reshape(s["h"], s["w"])
    flags = np.array(s["flags"], np.int32).reshape(s["h"], s["w"])
    return StampVar(key=case["key"], det=0, mjd=0.0, w=s["w"], h=s["h"], x0=0, y0=0, tx=s["tx"], ty=s["ty"], lam=1.0,
                    bw=0.1, data=data, flags=flags, sky=s["sky"])


def _expected(grid):
    return {"data": _clean(grid.data), "flags": grid.flags.ravel().tolist(), "sx": grid.sx.ravel().tolist(),
            "sy": grid.sy.ravel().tolist()}


def make_vectors():
    """Cut the stamps and write the vector file. Raises when a source coordinate lies too close to a tie."""
    cases = []
    for name, wv, obs, exp, det, how, where, stamp_size, size in CASES:
        key = _key(wv, obs, exp, det)
        ff = FrameFile.open(key)
        if how == "edge":
            ra, dec = (float(v) for v in ff.wcs.all_pix2world(where[0], where[1], 0))
        elif where is None:
            ra, dec = (float(v) for v in ff.wcs.all_pix2world(1020.3, 1010.7, 0))
        else:
            ra, dec = where
        from sx import stamp as S
        st = S.cut(ff, ra, dec, size=stamp_size)
        assert st is not None and st.sky is not None, name
        grid = display.to_display_grid(st, size)
        # a tie is a source coordinate within 1e-6 of a half: a twin with another order of operations could differ
        c = size // 2
        j, i = np.mgrid[0:size, 0:size]
        cd0, cd1, cd2, cd3 = st.sky["cd"]
        det_ = cd0 * cd3 - cd1 * cd2
        e, n = (c - i) * display.PIXEL_DEG, (j - c) * display.PIXEL_DEG
        for v in (st.tx + (cd3 * e - cd1 * n) / det_, st.ty + (cd0 * n - cd2 * e) / det_):
            assert np.abs((v + 0.5) - np.round(v + 0.5)).min() > 1e-6, name
        cases.append({
            "name": name, "key": key, "turn": round(turn_of(st.sky), 2), "size": size,
            "stamp": {"w": st.w, "h": st.h, "tx": st.tx, "ty": st.ty, "sky": st.sky,
                      "data": _clean(st.data), "flags": st.flags.ravel().tolist()},
            "expect": _expected(grid),
        })
    local = []
    for id_ in FRAME_IDS:
        meta, _, _, _ = load_frame(id_)
        with s3.use(recorded_source(id_)):
            ff = FrameFile.open(meta["key"])
            for x, y in ((meta["pixel"]["x"], meta["pixel"]["y"]), (3.0, 2030.0), (1020.5, 1019.5), (1999.2, 15.8)):
                local.append({"frame": id_, "x": x, "y": y, "sky": display.local_sky(ff.wcs, x, y)})
    out = {"about": ABOUT, "pixelArcsec": display.PIXEL_ARCSEC, "pixelDeg": display.PIXEL_DEG,
           "gridSky": {"ra": 10.0, "dec": -20.0, "cd": [-display.PIXEL_DEG, 0.0, 0.0, display.PIXEL_DEG]},
           "cases": cases, "localSky": local}
    VECTORS.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    return out


def vectors():
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_the_vectors_cover_the_turns_the_telescope_makes():
    cases = vectors()["cases"]
    assert len(cases) >= 6
    turns = [c["turn"] for c in cases]
    for want in (0, 90, 147, 180):
        assert min(abs((t - want + 180) % 360 - 180) for t in turns) < 12, want


@pytest.mark.parametrize("i", range(9))
def test_to_display_grid_gives_the_vector(i):
    case = vectors()["cases"][i]
    g = display.to_display_grid(_stamp_from(case), case["size"])
    want = case["expect"]
    got = _expected(g)
    assert got["sx"] == want["sx"] and got["sy"] == want["sy"]
    assert got["flags"] == want["flags"]
    assert got["data"] == want["data"]


@pytest.mark.parametrize("i", range(9))
def test_a_display_pixel_and_its_source_are_at_the_same_place_on_the_sky(i):
    """Independent of the way the source is found: the sky position of each output pixel, and of the source pixel
    it took, lie within the half-diagonal of a pixel of each other, and north is up and east is left."""
    case = vectors()["cases"][i]
    st = _stamp_from(case)
    size = case["size"]
    g = display.to_display_grid(st, size)
    c = size // 2
    cd = np.array(st.sky["cd"]).reshape(2, 2)  # [[east per x, east per y], [north per x, north per y]]
    worst = 0.0
    for j in range(size):
        for k in range(size):
            if g.sx[j, k] < 0:
                continue
            east, north = (c - k) * display.PIXEL_DEG, (j - c) * display.PIXEL_DEG
            es, ns = cd @ np.array([g.sx[j, k] - st.tx, g.sy[j, k] - st.ty])
            worst = max(worst, math.hypot(east - es, north - ns) / display.PIXEL_DEG)
    assert worst <= math.sqrt(2) / 2 + 1e-9
    assert (g.sx >= 0).sum() > size * size * 0.3


def test_the_target_pixel_of_the_grid_is_the_pixel_of_the_target():
    for case in vectors()["cases"]:
        st = _stamp_from(case)
        g = display.to_display_grid(st, case["size"])
        c = case["size"] // 2
        assert g.sx[c, c] == math.floor(st.tx + 0.5) and g.sy[c, c] == math.floor(st.ty + 0.5)


def test_grid_sky_is_east_left_north_up():
    v = vectors()
    s = display.grid_sky({"ra": 10.0, "dec": -20.0, "cd": [1.0, 2.0, 3.0, 4.0]})
    assert s == v["gridSky"]
    assert display.PIXEL_DEG * 3600 == pytest.approx(6.15)


def test_a_stamp_without_a_sky_is_refused():
    st = _stamp_from(vectors()["cases"][0])
    st.sky = None
    with pytest.raises(ValueError):
        display.to_display_grid(st, 24)


@pytest.mark.parametrize("n", range(12))
def test_local_sky_gives_the_vector(n):
    case = vectors()["localSky"][n]
    meta, _, _, _ = load_frame(case["frame"])
    with s3.use(recorded_source(case["frame"])):
        ff = FrameFile.open(meta["key"])
        got = display.local_sky(ff.wcs, case["x"], case["y"])
    assert got["ra"] == pytest.approx(case["sky"]["ra"], abs=1e-12)
    assert got["dec"] == pytest.approx(case["sky"]["dec"], abs=1e-12)
    assert got["cd"] == pytest.approx(case["sky"]["cd"], rel=1e-9)
    # one pixel is 6.15 arcsec across, and the pixel scale of the frame is the length of the columns of cd
    cd = got["cd"]
    assert math.hypot(cd[0], cd[2]) * 3600 == pytest.approx(6.15, abs=0.1)
    assert math.hypot(cd[1], cd[3]) * 3600 == pytest.approx(6.15, abs=0.1)


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_stamp_cut_carries_the_sky_of_its_target_pixel(id_):
    from sx import stamp as S

    meta, _, _, _ = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = FrameFile.open(meta["key"])
        st = S.cut(ff, meta["target"]["ra"], meta["target"]["dec"])
        want = display.local_sky(ff.wcs, meta["pixel"]["x"], meta["pixel"]["y"])
    assert st.sky == want
    assert st.sky["ra"] == pytest.approx(meta["target"]["ra"], abs=1e-9)
    assert st.sky["dec"] == pytest.approx(meta["target"]["dec"], abs=1e-9)


def test_write_showcase_writes_the_display_grid(tmp_path):
    cases = vectors()["cases"]
    stamps = []
    for n, i in enumerate((0, 5)):
        st = _stamp_from(cases[i])
        st.key = cases[i]["key"]
        st.mjd = 61000.0 + n * 100
        st.lam, st.bw, st.det = 1.5, 0.05, 2
        stamps.append(st)
    folder = tmp_path / "grid-test"
    m = render.write_showcase(folder, "grid-test", "Grid test", 10.0, 20.0, stamps, [0, 1], [(0, 1)])
    assert m["grid"] == "north-up"
    assert C.check_showcase(folder) == []
    for f in m["frames"]:
        assert f["sky"]["cd"] == [-display.PIXEL_DEG, 0.0, 0.0, display.PIXEL_DEG]
        assert f["tx"] == f["ty"] == stamps[0].w // 2
    data = np.fromfile(folder / "stamps.bin", "<f4").reshape(2, 24, 24)
    want = display.to_display_grid(stamps[0], 24).data
    assert np.array_equal(data[0], want, equal_nan=True)
    # the old way is still there, and says so by saying nothing
    plain = render.write_showcase(tmp_path / "plain", "plain", "Plain", 10.0, 20.0, stamps, [0, 1], [(0, 1)],
                                  display_grid=False)
    assert "grid" not in plain and all("sky" not in f for f in plain["frames"])
    assert np.array_equal(np.fromfile(tmp_path / "plain" / "stamps.bin", "<f4").reshape(2, 24, 24)[0],
                          np.asarray(stamps[0].data), equal_nan=True)


if __name__ == "__main__":
    if "--write" in sys.argv:
        v = make_vectors()
        print(f"wrote {VECTORS}: {len(v['cases'])} cases, turns {[c['turn'] for c in v['cases']]}")
    else:
        print("run with --write to make tests/vectors/display.json")
