"""The visit rule (CT-5). Same rule, same output as site/js/lib/visits.js; tests/vectors/visits.json holds the cases.

Frames are sorted by mid-exposure time. A gap of more than VISIT_GAP_DAYS between two neighbours starts a new
visit. A visit that then spans more than VISIT_RUN_DAYS (near the ecliptic poles the telescope looks all the time)
is cut into bins of VISIT_BIN_DAYS counted from its first frame. A visit with fewer than VISIT_MIN_FRAMES frames is
short.
"""
from __future__ import annotations

import math
from typing import Optional

from .contracts import (
    VISIT_BIN_DAYS,
    VISIT_GAP_DAYS,
    VISIT_MIN_FRAMES,
    VISIT_RUN_DAYS,
    Frame,
    Visit,
)


def visits(frames: list[Frame], det: Optional[int] = None) -> list[Visit]:
    """Group frames into visits. With `det`, only the frames of that detector are used (and counted)."""
    use = [f for f in frames if det is None or f["det"] == det]
    use.sort(key=lambda f: (f["tmid"], f["key"]))
    groups: list[list[Frame]] = []
    for f in use:
        if groups and f["tmid"] - groups[-1][-1]["tmid"] <= VISIT_GAP_DAYS:
            groups[-1].append(f)
        else:
            groups.append([f])
    out: list[Visit] = []
    for g in groups:
        if g[-1]["tmid"] - g[0]["tmid"] > VISIT_RUN_DAYS:
            t0 = g[0]["tmid"]
            bins: dict[int, list[Frame]] = {}
            for f in g:
                bins.setdefault(math.floor((f["tmid"] - t0) / VISIT_BIN_DAYS), []).append(f)
            parts = [bins[k] for k in sorted(bins)]
        else:
            parts = [g]
        for p in parts:
            out.append({"frames": p, "short": len(p) < VISIT_MIN_FRAMES})
    return out


def default_pair(vs: list[Visit]) -> Optional[tuple[int, int]]:
    """The default two visits to compare, as positions in `vs`, the earlier first; None when there are fewer than two
    that are not short.

    Of the visits that are not short, those with at least half the frames of the deepest one count as deep. When
    two or more are deep, the pair is the earliest and the latest of them; otherwise the two deepest visits (ties:
    the earlier one), in time order."""
    ok = [i for i, v in enumerate(vs) if not v["short"]]
    if len(ok) < 2:
        return None
    deepest = max(len(vs[i]["frames"]) for i in ok)
    deep = [i for i in ok if 2 * len(vs[i]["frames"]) >= deepest]
    if len(deep) >= 2:
        return deep[0], deep[-1]
    top = sorted(ok, key=lambda i: (-len(vs[i]["frames"]), i))[:2]
    return min(top), max(top)
