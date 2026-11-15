"""The shared vectors of the rules (visits, match, stack, coordinates, propagation): how they are made, and that the
Python rules still give them.

The files in tests/vectors/ are written by Python (this file, `python tests/test_d2_vectors.py --write` from
pipeline/) and read by the JavaScript tests (tests/unit/d2-*.test.mjs), so both languages are held to the same
numbers. match-from-js.json goes the other way: it is written by tests/unit/d2-match.test.mjs and checked here.
Coordinates and propagation vectors come from astropy.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sx import match as M  # noqa: E402
from sx import stack as S  # noqa: E402
from sx.flags import DEFECT_MASK, SATURATION_MASK  # noqa: E402
from sx.visits import default_pair, visits  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
VEC = ROOT / "tests" / "vectors"
FIX = ROOT / "tests" / "fixtures"


def load(name: str):
    return json.loads((VEC / name).read_text(encoding="utf-8"))


def clean(x):
    """JSON-safe: NaN and infinity become null, numpy numbers become plain numbers."""
    if isinstance(x, np.ndarray):
        return clean(x.tolist())
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, (np.floating, float)):
        return float(x) if np.isfinite(x) else None
    if isinstance(x, np.integer):
        return int(x)
    return x


def unclean(x):
    if isinstance(x, list):
        return np.array([np.nan if v is None else v for v in x], dtype=np.float64)
    return x


def b64(a: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode("ascii")


def unb64(s: str, dtype: str, shape=None) -> np.ndarray:
    a = np.frombuffer(base64.b64decode(s), dtype=dtype)
    return a.reshape(shape) if shape else a


# ---------------------------------------------------------------------------------------------------- visits


def fr(key: str, det: int, tmid: float) -> dict:
    return {"key": key, "det": det, "tmid": tmid}


def tile_frames() -> list[dict]:
    e = json.loads((FIX / "idx" / "expected.json").read_text(encoding="utf-8"))
    return [fr(f["key"], f["det"], f["tmid"]) for f in e["frames"]]


def visits_case(name: str, frames: list[dict], det=None) -> dict:
    vs = visits(frames, det)
    return {
        "name": name, "det": det, "frames": frames,
        "expected": {
            "visits": [{"keys": [f["key"] for f in v["frames"]], "short": v["short"]} for v in vs],
            "pair": None if default_pair(vs) is None else list(default_pair(vs)),
        },
    }


def build_visits() -> dict:
    cases = [visits_case("no frames", [])]
    cases.append(visits_case("one frame", [fr("a", 2, 60800.0)]))
    cases.append(visits_case("two frames, not sorted", [fr("b", 2, 60800.5), fr("a", 2, 60800.0)]))
    cases.append(visits_case("same time, ordered by key", [fr("c", 1, 60800.0), fr("a", 1, 60800.0), fr("b", 1, 60800.0)]))
    # a gap of exactly 10 days stays one visit; a hair more starts a new one
    cases.append(visits_case("gap of exactly 10 days", [fr(f"g{i}", 3, 60800.0 + t) for i, t in enumerate([0, 0.1, 0.2, 10.2, 10.3, 10.4])]))
    cases.append(visits_case("gap just over 10 days", [fr(f"g{i}", 3, 60800.0 + t) for i, t in enumerate([0, 0.1, 0.2, 10.3000001, 10.4, 10.5])]))
    three = [0, 0.2, 0.4, 0.6, 40, 40.2, 40.4, 120, 120.1, 120.3, 120.5, 120.6, 120.8, 200, 200.1]
    cases.append(visits_case("three visits and a short one", [fr(f"t{i}", 2, 60700.0 + t) for i, t in enumerate(three)]))
    mixed = [fr(f"m{i}", 1 + i % 2, 60700.0 + 0.1 * i) for i in range(10)] + [fr(f"n{i}", 1 + i % 2, 60800.0 + 0.1 * i) for i in range(4)]
    cases.append(visits_case("two detectors together", mixed))
    cases.append(visits_case("detector 1 only", mixed, 1))
    cases.append(visits_case("detector 2 only", mixed, 2))
    # near an ecliptic pole the telescope looks all the time: a run over 60 days is cut into 30-day bins from its first frame
    pole = [fr(f"p{i:03d}", 4, 60790.0 + 1.5 * i) for i in range(140)]
    cases.append(visits_case("ecliptic pole, run of 208 days", pole, 4))
    edge = [fr(f"e{i:02d}", 4, 60790.0 + t) for i, t in enumerate(
        [0, 5, 10, 15, 20, 25, 29.999999, 30.0, 35, 40, 45, 50, 55, 60.0])]
    cases.append(visits_case("run of exactly 60 days stays one visit", edge, 4))
    edge2 = edge + [fr("e99", 4, 60790.0 + 60.000001 - 0.0)]
    cases.append(visits_case("run just over 60 days is cut at 30", edge2, 4))
    sparse_pole = [fr(f"s{i:03d}", 5, 60790.0 + 9.5 * i) for i in range(30)]
    cases.append(visits_case("pole with a frame every 9.5 days", sparse_pole, 5))
    # default pair
    deep = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    mk = lambda starts, counts: [fr(f"v{v}_{i}", 6, 60000.0 + s + 0.1 * i) for v, (s, n) in enumerate(zip(starts, counts)) for i in range(n)]  # noqa: E731
    cases.append(visits_case("pair: earliest and latest of the deep visits", mk([0, 50, 100, 200], [8, 9, 10, 4]), 6))
    cases.append(visits_case("pair: only one deep visit, two deepest", mk([0, 50, 100], [3, 3, 20]), 6))
    cases.append(visits_case("pair: ties go to the earlier", mk([0, 50, 100, 150], [5, 5, 5, 5]), 6))
    cases.append(visits_case("pair: one visit is not enough", mk([0, 50], [10, 2]), 6))
    cases.append(visits_case("pair: short ones never count", mk([0, 50, 100], [2, 2, 2]), 6))
    # the frames of the fixture tile, by detector
    for det in range(1, 7):
        c = visits_case(f"index tile at 330.84 -56.79, detector {det}", tile_frames(), det)
        c["frames"], c["fixture"] = None, "idx/expected.json"
        cases.append(c)
    return {"about": "Visit rule (CT-5). Written by Python; tests/unit/d2-visits.test.mjs reads it.", "cases": cases}


# ----------------------------------------------------------------------------------------------------- match


def match_case(name: str, a: list[dict], b: list[dict]) -> dict:
    return {"name": name, "a": a, "b": b, "expected": [list(p) for p in M.match_pairs(a, b)]}


def mb(det: int, lam: float, bw: float, **kw) -> dict:
    return {"det": det, "lam": lam, "bw": bw, **kw}


def random_lists(rng: np.random.RandomState, det_choices: list[int], dense: bool = False) -> tuple[list[dict], list[dict]]:
    def one(n):
        out = []
        for _ in range(n):
            det = int(rng.choice(det_choices))
            lam = float(round(rng.uniform(1.2, 1.22) if dense else rng.uniform(0.75, 5.0), 4))
            bw = float(round(lam / rng.uniform(30, 120), 5))
            out.append(mb(det, lam, bw))
        return out

    return one(int(rng.randint(0, 22))), one(int(rng.randint(0, 22)))


def build_match() -> dict:
    cases = [
        match_case("empty", [], []),
        match_case("one pair", [mb(2, 1.0, 0.02)], [mb(2, 1.005, 0.02)]),
        match_case("outside half the bandwidth", [mb(2, 1.0, 0.02)], [mb(2, 1.011, 0.02)]),
        match_case("exactly half the bandwidth", [mb(2, 1.0, 0.5)], [mb(2, 1.125, 0.25)]),
        match_case("the smaller bandwidth rules", [mb(2, 1.0, 0.1)], [mb(2, 1.04, 0.02)]),
        match_case("other detector", [mb(2, 1.0, 0.02)], [mb(3, 1.0, 0.02)]),
        match_case("greedy: the closest pair first", [mb(1, 1.000, 0.1), mb(1, 1.04, 0.1)], [mb(1, 1.03, 0.1)]),
        match_case("two compete for one", [mb(1, 1.0, 0.1), mb(1, 1.001, 0.1)], [mb(1, 1.0005, 0.1)]),
        match_case("ties go to the lower positions", [mb(1, 1.0, 0.1), mb(1, 1.0, 0.1)], [mb(1, 1.0, 0.1), mb(1, 1.0, 0.1)]),
        match_case("not a number is never matched", [mb(1, float("nan"), 0.1), mb(1, 1.0, 0.1)], [mb(1, 1.0, 0.1), mb(1, 1.0, float("nan"))]),
        match_case("twelve candidates, eight kept", [mb(5, 1.0 + 0.01 * i, 0.5) for i in range(12)], [mb(5, 1.0 + 0.01 * i + 0.0001 * i, 0.5) for i in range(12)]),
    ]
    # the unused rows: detector 1 below row 150, detector 2 above row 1960
    cases += [
        match_case("detector 1 stamp starting at row 150", [mb(1, 1.0, 0.1, y0=150, h=64)], [mb(1, 1.0, 0.1, y0=500, h=64)]),
        match_case("detector 1 stamp starting at row 149", [mb(1, 1.0, 0.1, y0=149, h=64)], [mb(1, 1.0, 0.1, y0=500, h=64)]),
        match_case("detector 1 second side too low", [mb(1, 1.0, 0.1, y0=500, h=64)], [mb(1, 1.0, 0.1, y0=100, h=64)]),
        match_case("detector 2 stamp ending at row 1960", [mb(2, 1.0, 0.1, y0=1897, h=64)], [mb(2, 1.0, 0.1, y0=500, h=64)]),
        match_case("detector 2 stamp ending at row 1961", [mb(2, 1.0, 0.1, y0=1898, h=64)], [mb(2, 1.0, 0.1, y0=500, h=64)]),
        match_case("detector 3 is never skipped", [mb(3, 1.0, 0.1, y0=0, h=64)], [mb(3, 1.0, 0.1, y0=1990, h=64)]),
        match_case("without a position nothing is skipped", [mb(1, 1.0, 0.1)], [mb(1, 1.0, 0.1, y0=0, h=64)]),
        match_case("a skipped frame leaves its partner for another",
                   [mb(1, 1.0, 0.1, y0=10, h=64), mb(1, 1.02, 0.1, y0=300, h=64)], [mb(1, 1.001, 0.1, y0=400, h=64)]),
    ]
    rng = np.random.RandomState(20261114)
    for i in range(60):
        a, b = random_lists(rng, [1, 2] if i % 3 == 0 else [4, 5, 6], dense=i % 5 == 1)
        cases.append(match_case(f"random {i}", a, b))
    # per-pixel mask
    masks = []

    def mask_case(name: str, maps: list[dict], n=None) -> dict:
        m = S_mask(maps, n)
        return {"name": name, "n": n if n is not None else len(maps[0]["lamA"]) if maps else 0,
                "maps": clean(maps), "expected": m.tolist()}

    one = dict(lamA=[1.0, 1.0, 1.0, 1.0, float("nan"), 1.0], bwA=[0.02] * 6, lamB=[1.0, 1.01, 1.0100001, 0.99, 1.0, 1.0], bwB=[0.04, 0.04, 0.04, 0.04, 0.04, float("nan")])
    two = dict(lamA=[1.0] * 6, bwA=[0.02] * 6, lamB=[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], bwB=[0.02, 0.0001, 0.02, 0.02, 0.02, 0.02])
    masks.append(mask_case("one pair", [one]))
    masks.append(mask_case("two pairs", [one, two]))
    masks.append(mask_case("no pairs", [], 5))
    rng2 = np.random.RandomState(7)
    big = []
    for _ in range(3):
        la = rng2.uniform(1, 2, 200)
        big.append(dict(lamA=la, bwA=la / 40, lamB=la + rng2.normal(0, 0.012, 200), bwB=la / 41))
    masks.append(mask_case("three pairs, 200 pixels", big))
    return {"about": "Match rule (CT-6) and per-pixel matched mask. Written by Python; tests/unit/d2-match.test.mjs reads it.",
            "cases": clean(cases), "masks": masks}


def S_mask(maps, n=None):
    return M.matched_mask([{k: np.array([np.nan if v is None else v for v in m[k]]) if isinstance(m[k], list) else m[k] for k in m} for m in maps], n)


# ----------------------------------------------------------------------------------------------------- stack


def stamp_arrays_empty():
    D = FIX / "d2" / "empty"
    man = json.loads((D / "manifest.json").read_text(encoding="utf-8"))
    n = len(man["frames"])
    d = np.fromfile(D / "stamps.bin", dtype="<f4").reshape(n, 64, 64)
    f = np.fromfile(D / "flags.bin", dtype="<i4").reshape(n, 64, 64)
    return man, d, f


def stamp_arrays_showcase():
    D = FIX / "showcase" / "barnard-d5"
    man = json.loads((D / "manifest.json").read_text(encoding="utf-8"))
    n = len(man["frames"])
    d = np.fromfile(D / "stamps.bin", dtype="<f4").reshape(n, man["h"], man["w"])
    f = np.fromfile(D / "flags.bin", dtype="<i4").reshape(n, man["h"], man["w"])
    return man, d, f


def pack_coadd(co: dict) -> dict:
    return {
        "photos": co["photos"], "need": co["need"], "dropped": co["dropped"], "background": co["background"], "noise": co["noise"],
        "basis": co["basis"], "data": b64(co["data"], "<f4"), "valid": b64(co["valid"], "u1"), "quiet": b64(co["quiet"], "u1"),
        "n": b64(co["n"], "u1"),
    }


def coadd_case(name: str, data: np.ndarray, flags) -> dict:
    """Photos given as arrays (k, h, w) and flags (k, h, w) or None: the co-add of all of them."""
    st = [{"data": data[i], "flags": None if flags is None else flags[i]} for i in range(len(data))]
    return {"name": name, "w": int(data.shape[2]), "h": int(data.shape[1]),
            "data": [clean(d.ravel()) for d in data], "flags": None if flags is None else [f.ravel().tolist() for f in flags],
            "expected": pack_coadd(S.coadd(st))}


def hand_made_photos() -> tuple[np.ndarray, np.ndarray]:
    """Three photos of 12 by 12 pixels, 0 everywhere (so each background is 0) except a block of 4 by 4 in the
    corner that is written by hand: photo A is 1 there, B is 2, C is 4. The flags of the block, pixel by pixel:
        A: DICHROIC, PHANMISS, SOURCE, HOT, OVERFLOW, (not a number), 0 ...
        B: 0, 0, 0, HOT, NONLINEAR, 0, STREAK, ...
        C: 0, 0, 0, HOT, 0, 0, GHOST, (not a number), ...
    """
    full = 1 << 12
    data = np.zeros((3, 12, 12), dtype=np.float32)
    flags = np.full((3, 12, 12), full, dtype=np.int32)
    for k, v in enumerate((1.0, 2.0, 4.0)):
        data[k, :4, :4] = v
    bits = {0: {0: 1 << 7, 1: 1 << 14, 2: 1 << 21, 3: 1 << 10, 4: 1 << 1},
            1: {3: 1 << 10, 4: 1 << 15, 6: 1 << 25},
            2: {3: 1 << 10, 6: 1 << 22}}
    for k, d in bits.items():
        for i, b in d.items():
            flags[k, i // 4, i % 4] |= b
    data[0, 1, 1] = np.nan  # pixel 5 of A
    data[2, 1, 3] = np.nan  # pixel 7 of C
    return data, flags


def coadd_cases() -> list[dict]:
    rng = np.random.RandomState(2026)
    full = 1 << 12
    cases = [coadd_case("three photos, a block written by hand", *hand_made_photos())]
    pool = [1 << b for b in (0, 1, 2, 6, 7, 9, 10, 11, 14, 15, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28)]

    def photos(k: int, size: int, flagged: float, corners: bool, nans: float = 0.0):
        data = rng.normal(0.5, 0.1, (k, size, size)).astype(np.float32)
        data += rng.uniform(-0.3, 0.3, (k, 1, 1)).astype(np.float32)
        flags = np.full((k, size, size), full, dtype=np.int32)
        for i in range(k):
            hit = rng.uniform(size=(size, size)) < flagged
            flags[i] |= np.where(hit, rng.choice(pool, (size, size)), 0).astype(np.int32)
            data[i][rng.uniform(size=(size, size)) < nans] = np.nan
            if corners:  # an empty corner of its own, as a photo put on a north-up grid has
                a, b = int(rng.randint(2, 7)), int(rng.randint(2, 7))
                ys, xs = (slice(0, a), slice(0, b)) if i % 4 == 0 else (slice(size - a, size), slice(size - b, size)) if i % 4 == 1 else (slice(0, a), slice(size - b, size)) if i % 4 == 2 else (slice(size - a, size), slice(0, b))
                data[i][ys, xs] = np.nan
        return data, flags

    cases.append(coadd_case("eight photos, different empty corners, scattered flags", *photos(8, 24, 0.06, True, 0.01)))
    cases.append(coadd_case("one photo", *photos(1, 20, 0.05, False)))
    cases.append(coadd_case("two photos", *photos(2, 20, 0.08, False)))
    cases.append(coadd_case("five photos, no flags loaded", photos(5, 20, 0.0, True)[0], None))
    d, f = photos(4, 20, 0.05, False)
    d[2][:] = np.nan  # a photo with nothing to measure a background on is left out
    cases.append(coadd_case("four photos, one of them empty", d, f))
    d, f = photos(3, 20, 0.0, False)
    f[:, 4:8, 4:8] |= 1 << 21  # a source over a patch is no defect
    f[:, 10, :] |= (1 << 7) | (1 << 14)  # nor are DICHROIC and PHANMISS
    cases.append(coadd_case("three photos, source and the flags that do not exclude", d, f))
    return cases


def real_case(name: str, d: np.ndarray, f: np.ndarray, visit_of: list[int], matrix: list[float]) -> dict:
    """Stamps of two visits: co-add each, put the second on the grid of the first, difference."""
    stamps = [{"data": d[i], "flags": f[i]} for i in range(len(d))]
    stats = [S.stamp_stats(s["data"], s["flags"]) for s in stamps]
    cos = []
    for v in (0, 1):
        cos.append(S.coadd([stamps[i] for i in range(len(d)) if visit_of[i] == v]))
    mx, my = S.affine_map(d.shape[2], d.shape[1], matrix)
    rb = S.resample_coadd(cos[1], mx, my)
    diff = S.difference(cos[0], rb)
    return {
        "name": name, "w": int(d.shape[2]), "h": int(d.shape[1]), "visit_of": visit_of, "matrix": matrix,
        "stats": stats, "coadd": [pack_coadd(c) for c in cos], "resampled": pack_coadd(rb),
        "difference": {
            "diff": b64(diff["diff"], "<f4"), "units": b64(diff["units"], "<f4"), "valid": b64(diff["valid"], "u1"),
            "sigma": diff["sigma"], "sigmaA": diff["sigmaA"], "sigmaB": diff["sigmaB"], "scatter": diff["scatter"],
        },
    }


def build_stack() -> dict:
    rng = np.random.RandomState(42)
    # sigma-clipped median and robust noise on small arrays
    clip = []
    for name, v in [
        ("plain", rng.normal(5, 2, 300)),
        ("with outliers", np.r_[rng.normal(0, 1, 300), [40.0, 55.0, -30.0]]),
        ("with not-a-numbers", np.r_[rng.normal(1, 1, 120), [np.nan, np.inf, -np.inf]]),
        ("constant", np.full(10, 3.0)),
        ("skewed", rng.exponential(1.0, 400)),
        ("two values", np.array([1.0, 2.0])),
        ("empty", np.array([])),
    ]:
        clip.append({"name": name, "values": clean(v), "median": S.clipped_median(v), "noise": S.robust_noise(v)})
    # stamp statistics on synthetic stamps with flags
    syn = []
    for name, fl_frac, src_frac in [("no flags", 0.0, 0.0), ("some flags", 0.05, 0.0), ("source over half", 0.0, 0.7), ("all source", 0.0, 1.0), ("flags without source", 0.2, 0.0)]:
        data = rng.normal(0.3, 0.05, (20, 20)).astype(np.float32)
        data[5, 5] = 4.0
        data[7, 8] = np.nan
        flags = np.zeros((20, 20), dtype=np.int32)
        flags |= np.where(rng.uniform(size=(20, 20)) < 0.9, S.FLAG_FULLSAMPLE, 0).astype(np.int32)
        flags |= np.where(rng.uniform(size=(20, 20)) < fl_frac, 1 << 2, 0).astype(np.int32)
        flags |= np.where(rng.uniform(size=(20, 20)) < src_frac, S.FLAG_SOURCE, 0).astype(np.int32)
        syn.append({"name": name, "w": 20, "h": 20, "data": clean(data.ravel()), "flags": flags.ravel().tolist(),
                    "stats": S.stamp_stats(data, flags),
                    "quiet": S.quiet_mask(data, flags).ravel().tolist(), "valid": S.valid_mask(data, flags).ravel().tolist()})
    # bilinear resampling on a small image, with holes
    img = rng.normal(0, 1, (7, 9)).astype(np.float32)
    img[3, 4] = np.nan
    ok = np.ones((7, 9), dtype=np.uint8)
    ok[1, 1] = 0
    ys, xs = np.mgrid[0:6, 0:8].astype(np.float64)
    maps = {
        "shift": S.affine_map(8, 6, [1, 0, 0.37, 0, 1, -0.21]),
        "rotate 180": S.affine_map(8, 6, [-1, 0, 8, 0, -1, 6]),
        "turn and scale": S.affine_map(8, 6, [0.9, -0.3, 1.1, 0.3, 0.9, 0.2]),
        "far outside": S.affine_map(8, 6, [1, 0, 20, 0, 1, 20]),
        "on the last row and column": S.affine_map(8, 6, [1, 0, 0.0, 0, 1, 0.0]),
    }
    res = []
    for name, (mx, my) in maps.items():
        for with_ok in (False, True):
            d, o = S.resample(img, mx, my, ok if with_ok else None)
            res.append({"name": f"{name}{', with a mask' if with_ok else ''}", "w": 9, "h": 7, "src": clean(img.ravel()),
                        "ok": ok.ravel().tolist() if with_ok else None, "mapX": clean(mx.ravel()), "mapY": clean(my.ravel()),
                        "data": clean(d.ravel()), "ok_out": o.ravel().tolist()})
    last_x = np.array([8.0, 8.0, 0.0, 7.9999999999])
    last_y = np.array([6.0, 0.0, 6.0, 5.5])
    d, o = S.resample(img, last_x, last_y)
    res.append({"name": "the corners", "w": 9, "h": 7, "src": clean(img.ravel()), "ok": None, "mapX": clean(last_x), "mapY": clean(last_y),
                "data": clean(d), "ok_out": o.tolist()})
    # real stamps
    man, d, f = stamp_arrays_empty()
    c = (np.array([[fr_["tx"], fr_["ty"]] for fr_ in man["frames"] if fr_["visit"] == 0]).mean(axis=0)
         + np.array([[fr_["tx"], fr_["ty"]] for fr_ in man["frames"] if fr_["visit"] == 1]).mean(axis=0))
    real = [real_case("empty field, detector 2, two visits of three photos (rotated 180 degrees)", d, f,
                      [fr_["visit"] for fr_ in man["frames"]], [-1.0, 0.0, float(c[0]), 0.0, -1.0, float(c[1])])]
    man2, d2, f2 = stamp_arrays_showcase()
    real.append(real_case("Barnard's Star, detector 5, two visits of two photos, bright star, flags everywhere",
                          d2, f2, [fr_["visit"] for fr_ in man2["frames"]], [1.0, 0.0, 0.4, 0.0, 1.0, -0.3]))
    # the same stamps, no flags loaded
    nofl = real_case("empty field, flags not loaded", d, np.zeros_like(f), [fr_["visit"] for fr_ in man["frames"]], [-1.0, 0.0, float(c[0]), 0.0, -1.0, float(c[1])])
    nofl["flags"] = "zero"
    real.append(nofl)
    return {"about": "Background, noise, co-add, resampling and difference (CT-7). Written by Python (sx/stack.py); tests/unit/d2-stack.test.mjs reads it. "
                     "Arrays marked base64 are little-endian float32 (f4) or uint8 (u1); not-a-number is null in plain lists.",
            "constants": {"FLAG_FULLSAMPLE": S.FLAG_FULLSAMPLE, "FLAG_SOURCE": S.FLAG_SOURCE, "MIN_PIXELS": S.MIN_PIXELS,
                          "SATURATION_MASK": SATURATION_MASK, "DEFECT_MASK": DEFECT_MASK},
            "clip": clip, "synthetic_stamps": syn, "resample": res, "real": real, "coadd": coadd_cases()}


# ------------------------------------------------------------------------------------------ astropy vectors


COORD_CASES = [
    # text, RA text, RA unit, Dec text
    ("330.84 -56.79", "330.84", "deg", "-56.79"),
    ("330.84, -56.79", "330.84", "deg", "-56.79"),
    ("330.84,-56.79", "330.84", "deg", "-56.79"),
    ("  269.44636   +4.76706 ", "269.44636", "deg", "+4.76706"),
    ("133,7951 -7,2452", "133.7951", "deg", "-7.2452"),
    ("RA=133.7951 Dec=-7.2452", "133.7951", "deg", "-7.2452"),
    ("08h55m10.831s -7d14m42.53s", "08h55m10.831s", "hourangle", "-7d14m42.53s"),
    ("08h55m10.831s -07d14m42.53s", "08h55m10.831s", "hourangle", "-07d14m42.53s"),
    ("8h55m10.83s -7d14m42.5s", "8h55m10.83s", "hourangle", "-7d14m42.5s"),
    ("08h 55m 10.831s -07d 14m 42.53s", "08h55m10.831s", "hourangle", "-07d14m42.53s"),
    ("RA 08h55m10.831s Dec -07d14m42.53s", "08h55m10.831s", "hourangle", "-07d14m42.53s"),
    ("08h55m10.831s, -07°14′42.53″", "08h55m10.831s", "hourangle", "-07d14m42.53s"),
    ("08:55:10.831 -07:14:42.53", "08:55:10.831", "hourangle", "-07:14:42.53"),
    ("08:55:10.831, -07:14:42.53", "08:55:10.831", "hourangle", "-07:14:42.53"),
    ("08 55 10.831 -07 14 42.53", "08 55 10.831", "hourangle", "-07 14 42.53"),
    ("08 55 10.831 +07 14 42.53", "08 55 10.831", "hourangle", "+07 14 42.53"),
    ("08 55 10.831 07 14 42.53", "08 55 10.831", "hourangle", "07 14 42.53"),
    ("8 55 -7 14", "8 55", "hourangle", "-7 14"),
    ("08:55 -07:14", "08:55", "hourangle", "-07:14"),
    ("17h57m48.5s +04d41m36s", "17h57m48.5s", "hourangle", "+04d41m36s"),
    ("17:57:48.5 +04:41:36", "17:57:48.5", "hourangle", "+04:41:36"),
    ("22h04m21.60s -56d47m38.4s", "22h04m21.60s", "hourangle", "-56d47m38.4s"),
    ("00h00m00s +00d00m00s", "0h0m0s", "hourangle", "0d0m0s"),
    ("23h59m59.999s -89d59m59.9s", "23h59m59.999s", "hourangle", "-89d59m59.9s"),
    ("12h30m00s -0d14m42s", "12h30m00s", "hourangle", "-0d14m42s"),
    ("10h00m00s +90d00m00s", "10h0m0s", "hourangle", "90d0m0s"),
    ("133.7951d -7d14m42.5s", "133.7951", "deg", "-7d14m42.5s"),
    ("133.7951 deg -7.2452 deg", "133.7951", "deg", "-7.2452"),
    ("5h 34m 31.97s +22d 00m 52.1s", "5h34m31.97s", "hourangle", "22d0m52.1s"),
]
COORD_REJECT = [
    "", "   ", "hello", "Barnard's Star", "330.84", "330.84 -56.79 12", "25h00m00s +10d00m00s", "10h61m00s +10d00m00s",
    "10h30m61s +10d00m00s", "100 95", "360 10", "-10 20", "12h30m +91d00m", "1,2,3,4,5", "08h55m10.831s", "1e3 5",
    "1.2.3 4", "12.5h30m +20d", "10h 20m 30s +", "5 6 7", "ra dec",
]


def build_coords() -> dict:
    import astropy.units as u
    from astropy.coordinates import Angle

    cases = []
    for text, rtxt, runit, dtxt in COORD_CASES:
        ra = Angle(rtxt, unit=u.hourangle if runit == "hourangle" else u.deg).deg
        dec = Angle(dtxt, unit=u.deg).deg
        cases.append({"text": text, "ra": float(ra), "dec": float(dec)})
    return {"about": "Typed positions with the answer of astropy (Angle). tests/unit/d2-coords.test.mjs reads it.",
            "cases": cases, "reject": COORD_REJECT}


GAIA_EXTRA_IDS = [4810594479418041856, 6553614253923452800, 2306965202564744064, 1872046609345556480,
                  35227046884571776, 762815470562110464, 6412595290592307840]
GAIA_DATES_MJD = [60800.5, 60991.25, 61114.032669638, 61300.7]


def predict(c: dict, mjd: float) -> tuple[float, float]:
    """The astropy answer: proper motion and radial velocity (apply_space_motion), then the direction from the Earth
    (barycentric ephemeris of astropy), i.e. annual parallax included."""
    import astropy.units as u
    from astropy.coordinates import SkyCoord, get_body_barycentric
    from astropy.time import Time

    sc = SkyCoord(ra=c["ra"] * u.deg, dec=c["dec"] * u.deg, pm_ra_cosdec=c["pmra"] * u.mas / u.yr, pm_dec=c["pmdec"] * u.mas / u.yr,
                  distance=(1000 / c["parallax"]) * u.pc, radial_velocity=(c.get("rv") or 0.0) * u.km / u.s,
                  obstime=Time(c["epoch"], format="jyear", scale="tcb"), frame="icrs")
    t = Time(mjd, format="mjd", scale="tdb")
    p = sc.apply_space_motion(new_obstime=t).cartesian.xyz.to_value(u.au)
    v = p - get_body_barycentric("earth", t).xyz.to_value(u.au)
    ra = float(np.degrees(np.arctan2(v[1], v[0])) % 360)
    return ra, float(np.degrees(np.arcsin(v[2] / np.linalg.norm(v))))


def gaia_stars() -> list[dict]:
    """Ten stars: the three fast named targets from names.json, and seven fast Gaia DR3 stars (fetched once and kept in
    tests/vectors/gaia.json)."""
    names = json.loads((ROOT / "site" / "data" / "names.json").read_text(encoding="utf-8"))
    stars = []
    for e in names["entries"]:
        if e["id"] in ("barnard", "eps-indi-b", "wise0855"):
            c = e["catalogue"]
            stars.append({"name": e["name"], **{k: c[k] for k in ("ra", "dec", "epoch", "pmra", "pmdec", "parallax", "rv")}})
    have = VEC / "gaia.json"
    if have.exists():
        stars += [s for s in json.loads(have.read_text(encoding="utf-8"))["stars"] if s["name"].startswith("Gaia DR3 ")]
    else:
        import requests
        q = ("SELECT source_id, ra, dec, pmra, pmdec, parallax, ref_epoch, radial_velocity FROM gaiadr3.gaia_source WHERE source_id IN ("
             + ",".join(map(str, GAIA_EXTRA_IDS)) + ")")
        r = requests.post("https://gea.esac.esa.int/tap-server/tap/sync", data=dict(REQUEST="doQuery", LANG="ADQL", FORMAT="json", QUERY=q), timeout=120)
        r.raise_for_status()
        j = r.json()
        cols = [c["name"] for c in j["metadata"]]
        for row in j["data"]:
            g = dict(zip(cols, row))
            stars.append({"name": f"Gaia DR3 {g['source_id']}", "ra": g["ra"], "dec": g["dec"], "epoch": g["ref_epoch"], "pmra": g["pmra"],
                          "pmdec": g["pmdec"], "parallax": g["parallax"], "rv": g["radial_velocity"]})
    return stars


def build_gaia() -> dict:
    stars = gaia_stars()
    out = []
    for s in stars:
        out.append({**s, "at": [dict(zip(("ra", "dec"), predict(s, t))) | {"mjd": t} for t in GAIA_DATES_MJD]})
    return {"about": "Catalogue stars (Gaia DR3, WISE 0855 from Kirkpatrick et al. 2021) with astropy's position on four dates: proper motion, "
                     "radial velocity and annual parallax. tests/unit/d2-gaia.test.mjs reads it.",
            "dates_mjd": GAIA_DATES_MJD, "stars": out}


# ------------------------------------------------------------------------------------------ align fixture

ALIGN_SOURCES = [("frames/barnard-d2", None), ("frames/eps-indi-d5", None), ("showcase/barnard-d5", 0), ("showcase/barnard-d5", 2), ("showcase/barnard-d5", 3)]
ALIGN_SHIFTS = [(0.3, -0.2), (-0.45, 0.1), (0.12, 0.4), (-0.7, 0.25)]


def source_stamp(folder: str, idx):
    if idx is None:
        d = np.fromfile(FIX / folder / "image.f32", dtype="<f4").reshape(64, 64)
        f = np.fromfile(FIX / folder / "flags.i32", dtype="<i4").reshape(64, 64)
    else:
        d = np.fromfile(FIX / folder / "stamps.bin", dtype="<f4").reshape(4, 64, 64)[idx]
        f = np.fromfile(FIX / folder / "flags.bin", dtype="<i4").reshape(4, 64, 64)[idx]
    return d, f


def build_align_fixture() -> tuple[dict, bytes]:
    """Real stamps shifted by a fraction of a pixel with a cubic spline (scipy), the part of the stamp that was flagged
    carried along to the nearest whole pixel. Returns the description and the float32 bytes."""
    from scipy.ndimage import shift as ndshift

    items, blob = [], bytearray()
    for folder, idx in ALIGN_SOURCES:
        d, f = source_stamp(folder, idx)
        st = S.stamp_stats(d, f)
        v = S.valid_mask(d, f).astype(bool)
        a = np.where(v, d.astype(np.float64) - st["background"], 0.0)
        for sx, sy in ALIGN_SHIFTS:
            b = ndshift(a, (sy, sx), order=3, mode="nearest")
            mv = np.roll(np.roll(v, int(round(sy)), 0), int(round(sx)), 1)
            blob += np.where(mv, b, np.nan).astype("<f4").tobytes()
            items.append({"source": folder if idx is None else f"{folder}#{idx}", "dx": sx, "dy": sy})
    return {"w": 64, "h": 64, "items": items}, bytes(blob)


# -------------------------------------------------------------------------------------------------- writing


def write_all():
    (VEC / "visits.json").write_text(json.dumps(build_visits(), indent=None, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    (VEC / "match.json").write_text(json.dumps(build_match(), separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    (VEC / "stack.json").write_text(json.dumps(clean(build_stack()), separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    (VEC / "coords.json").write_text(json.dumps(build_coords(), indent=1, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    (VEC / "gaia.json").write_text(json.dumps(build_gaia(), indent=1, allow_nan=False) + "\n", encoding="utf-8")
    meta, blob = build_align_fixture()
    (FIX / "d2" / "align").mkdir(parents=True, exist_ok=True)
    (FIX / "d2" / "align" / "shifted.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    (FIX / "d2" / "align" / "shifted.bin").write_bytes(blob)


# ----------------------------------------------------------------------------------------------------- tests


def test_visits_vectors():
    v = load("visits.json")
    for c in v["cases"]:
        got = visits_case(c["name"], tile_frames() if c.get("fixture") else c["frames"], c["det"])
        assert got["expected"] == c["expected"], c["name"]


def test_visits_pole_run_is_cut_in_bins():
    c = next(c for c in load("visits.json")["cases"] if c["name"] == "ecliptic pole, run of 208 days")
    sizes = [len(v["keys"]) for v in c["expected"]["visits"]]
    assert len(sizes) == 7 and sum(sizes) == 140
    assert max(f["tmid"] for f in c["frames"]) - min(f["tmid"] for f in c["frames"]) > 60


def test_match_vectors():
    m = load("match.json")
    for c in m["cases"]:
        a = [{k: (np.nan if v is None else v) for k, v in x.items()} for x in c["a"]]
        b = [{k: (np.nan if v is None else v) for k, v in x.items()} for x in c["b"]]
        assert [list(p) for p in M.match_pairs(a, b)] == c["expected"], c["name"]
    for c in m["masks"]:
        assert S_mask(c["maps"], c["n"]).tolist() == c["expected"], c["name"]


def test_match_vectors_from_javascript():
    """The other direction: cases written by JavaScript (tests/unit/d2-match.test.mjs), pairs and masks checked here."""
    path = VEC / "match-from-js.json"
    if not path.exists():
        pytest.skip("match-from-js.json is written by the JavaScript tests")
    m = json.loads(path.read_text(encoding="utf-8"))
    assert len(m["cases"]) >= 50
    for c in m["cases"]:
        assert [list(p) for p in M.match_pairs(c["a"], c["b"])] == c["expected"]
    for c in m["masks"]:
        assert S_mask(c["maps"], c["n"]).tolist() == c["expected"]


def test_pairs_are_one_to_one_and_close():
    m = load("match.json")
    for c in m["cases"]:
        pairs = c["expected"]
        assert len({p[0] for p in pairs}) == len(pairs) == len({p[1] for p in pairs}) <= 8
        for i, j in pairs:
            a, b = c["a"][i], c["b"][j]
            assert a["det"] == b["det"]
            assert abs(a["lam"] - b["lam"]) <= 0.5 * min(a["bw"], b["bw"])


def test_stack_vectors():
    v = load("stack.json")
    built = clean(build_stack())
    assert built == v


def test_clipped_median_is_astropys():
    from astropy.stats import sigma_clipped_stats

    rng = np.random.RandomState(5)
    for _ in range(20):
        x = np.r_[rng.normal(2, 1, 400), rng.normal(2, 9, 6)]
        assert S.clipped_median(x) == pytest.approx(float(sigma_clipped_stats(x, sigma=3, maxiters=5, cenfunc="median", stdfunc="std")[1]), rel=1e-12, abs=1e-12)


def test_resample_conserves_a_shift():
    rng = np.random.RandomState(3)
    img = np.zeros((40, 40), dtype=np.float32)
    img[15:25, 15:25] = rng.uniform(1, 2, (10, 10))
    mx, my = S.affine_map(40, 40, [1, 0, 0.37, 0, 1, -0.21])
    d, ok = S.resample(img, mx, my)
    assert np.nansum(d) == pytest.approx(float(img.sum()), rel=1e-6)
    flat = np.full((10, 10), 2.5, dtype=np.float32)
    mx, my = S.affine_map(10, 10, [0.9, -0.3, 1.1, 0.3, 0.9, 0.2])
    d, ok = S.resample(flat, mx, my)
    assert np.allclose(d[ok == 1], 2.5)


def test_coords_vector_is_astropys():
    assert build_coords() == load("coords.json")


def _close(a, b):
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(_close(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(_close(x, y) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        return a == pytest.approx(b, rel=1e-9, abs=1e-12)
    return a == b


def test_gaia_vector_is_astropys():
    assert _close(build_gaia(), load("gaia.json"))


def test_align_fixture_is_what_scipy_gives():
    meta, blob = build_align_fixture()
    assert json.loads((FIX / "d2" / "align" / "shifted.json").read_text(encoding="utf-8")) == meta
    assert (FIX / "d2" / "align" / "shifted.bin").read_bytes() == blob


if __name__ == "__main__":
    if "--write" in sys.argv:
        write_all()
        print("written")
    else:
        print(__doc__)
