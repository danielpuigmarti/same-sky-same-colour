"""The match rule (CT-6). Same rule, same output as site/js/lib/match.js; tests/vectors/match.json holds the cases.

Two lists of frames, one for each visit, are paired so that the two frames of a pair were taken at the same
colour: same detector, one to one, the closest colours first, accepted when the colours at the target pixel differ
by at most MATCH_BANDWIDTH_FRACTION of the smaller of the two bandwidths, and at most MATCH_MAX_PAIRS pairs.
"""
from __future__ import annotations

from typing import Optional, Sequence

import numpy as np

from .contracts import MATCH_BANDWIDTH_FRACTION, MATCH_MAX_PAIRS, Matchable, Pair

BAD_ROWS_D1_BELOW = 150
"""In detector 1 the rows below this have background structure that changes between visits."""
BAD_ROWS_D2_ABOVE = 1960
"""The same, in detector 2, for the rows above this."""


def reaches_bad_rows(det: int, y0: float, h: float) -> bool:
    """True when a stamp of h rows starting at full-frame row y0 reaches the rows that are never used."""
    if det == 1:
        return y0 < BAD_ROWS_D1_BELOW
    if det == 2:
        return y0 + h - 1 > BAD_ROWS_D2_ABOVE
    return False


def usable(m: Matchable) -> bool:
    """A frame can be paired unless its stamp (`y0` and `h`, when given) reaches the unused rows of its detector."""
    y0, h = m.get("y0"), m.get("h")  # type: ignore[attr-defined]
    if y0 is None or h is None:
        return True
    return not reaches_bad_rows(m["det"], y0, h)


def match_pairs(a: Sequence[Matchable], b: Sequence[Matchable]) -> list[Pair]:
    """Pairs (position in a, position in b), the closest colours first."""
    cand: list[tuple[float, int, int]] = []
    for i, p in enumerate(a):
        if not usable(p):
            continue
        for j, q in enumerate(b):
            if p["det"] != q["det"] or not usable(q):
                continue
            d = abs(p["lam"] - q["lam"])
            if d <= MATCH_BANDWIDTH_FRACTION * min(p["bw"], q["bw"]):
                cand.append((d, i, j))
    cand.sort()
    used_a: set[int] = set()
    used_b: set[int] = set()
    out: list[Pair] = []
    for _, i, j in cand:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        out.append((i, j))
        if len(out) == MATCH_MAX_PAIRS:
            break
    return out


def matched_mask(maps: Sequence[dict], n: Optional[int] = None) -> np.ndarray:
    """The pixels that are within tolerance in every pair: uint8, 1 = matched, 0 = veiled.

    `maps` has one entry for each pair, with four arrays of the same length n (one value for each pixel of the grid
    that is being compared): lamA and bwA, the colour and bandwidth of the first frame of the pair there; lamB and
    bwB, the same for the second frame at the same place on the sky. A pixel is within tolerance in a pair when
    |lamA - lamB| <= MATCH_BANDWIDTH_FRACTION * min(bwA, bwB); a missing value (NaN) is never within tolerance.
    Without pairs nothing is matched."""
    if n is None:
        n = len(maps[0]["lamA"]) if maps else 0
    ok = np.ones(n, dtype=bool) if maps else np.zeros(n, dtype=bool)
    for m in maps:
        la, ba, lb, bb = (np.asarray(m[k], dtype=np.float64) for k in ("lamA", "bwA", "lamB", "bwB"))
        with np.errstate(invalid="ignore"):
            ok &= np.abs(la - lb) <= MATCH_BANDWIDTH_FRACTION * np.minimum(ba, bb)
    return ok.astype(np.uint8)
