"""Job gaia_fast: the stars that move fast enough to leave their catalogue position behind.

    python -m sx.run gaia_fast

Asks for every source of Gaia DR3 whose proper motion is above 0.5 arcsec a year and whose parallax is measured to
better than a fifth of its value, and writes them to site/data/gaia/fast.json with what a page needs to say where
each star is on a given date: position at the catalogue epoch, proper motion, parallax and G magnitude.

The catalogue is asked twice, at two archives that each hold a copy of it: the table gaia_source at MAST, which
gives the list, and the table gaia.dr3lite at the GAVO Data Center, which checks it. The job writes the file only
if both give the same sources above the speed, with positions, proper motions and parallaxes that agree. A search
on the total proper motion alone reads the whole catalogue and takes too long at any archive; a motion above the
speed has a component above the speed over the square root of two, and the components are indexed, so each
archive is asked four questions, one per sign of each component.

The cut on the parallax keeps out sources whose large motion is an artefact of a poor solution: a star that really
moves half an arcsec a year is near (within a few hundred parsec), so its parallax is several mas and well measured.
The count before and after the cut is printed and written into the file.

Needs the network the first time; the answers are cached, so a rerun writes the same file.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import sys
import time
import warnings
from pathlib import Path

import requests

from sx import numbers, s3

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402

MAST = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync"
GAVO = "https://dc.g-vo.org/tap/sync"
MIN_PM = 500.0
"""mas a year: 0.5 arcsec a year."""
MIN_PARALLAX_OVER_ERROR = 5.0
EPOCH = 2016.0
PART = MIN_PM / math.sqrt(2) - 0.05
"""A motion above MIN_PM has a component above MIN_PM / sqrt(2); the archives look components up quickly."""
PARTS = (f"pmra > {PART:.2f}", f"pmra < -{PART:.2f}", f"pmdec > {PART:.2f}", f"pmdec < -{PART:.2f}")
QUERIES = [
    "SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, parallax_over_error "
    f"FROM dbo.gaia_source WHERE {part} AND pm > {MIN_PM:g}" for part in PARTS
]
CHECK_QUERIES = [
    "SELECT source_id, ra, dec, pmra, pmdec, parallax, parallax_error "
    f"FROM gaia.dr3lite WHERE {part} AND pmra*pmra + pmdec*pmdec > {MIN_PM * MIN_PM:.0f}" for part in PARTS
]
MAX_ROWS = 50000
"""Asked of each archive as the most rows of one answer; an answer that long is taken as cut short."""
AGREE = {"ra": 1e-7, "dec": 1e-7, "pmra": 2e-3, "pmdec": 2e-3, "parallax": 2e-3}
"""How closely the two copies must agree: degrees, mas a year, mas (the second copy stores motions in single precision)."""
OUT = T.DATA / "gaia" / "fast.json"
MAX_BYTES = 1_000_000


def ask(url: str, query: str, tries: int = 4) -> list[dict]:
    """Rows of a query to a table service, as dicts of plain numbers (None where the catalogue has no value). The
    answer is cached."""
    cache = s3.cache_dir() / ("tap_" + hashlib.sha1((url + "\n" + query).encode()).hexdigest()[:16] + ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    from astropy.io.votable import parse_single_table

    err: Exception = RuntimeError("no try made")
    for k in range(tries):
        try:
            r = requests.post(url, data={"REQUEST": "doQuery", "LANG": "ADQL", "MAXREC": str(MAX_ROWS), "QUERY": query}, timeout=300)
            if r.status_code != 200:
                raise RuntimeError(f"status {r.status_code}: {r.text[:200]}")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                table = parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
            rows = [{c: plain(row[c], c) for c in table.colnames} for row in table]
            if len(rows) >= MAX_ROWS:
                raise RuntimeError(f"{len(rows)} rows: the answer was cut short")
            cache.write_text(json.dumps(rows))
            return rows
        except (requests.RequestException, ValueError, KeyError, RuntimeError) as e:
            err = e
        time.sleep(5 * (k + 1))
    raise RuntimeError(f"{url} did not answer: {err}")


def plain(value, column: str):
    """A table cell as a plain number: None for an empty cell; source_id stays a whole number."""
    if getattr(value, "mask", False):
        return None
    if column == "source_id":
        return int(value)
    v = float(value)
    return v if math.isfinite(v) else None


def gather(url: str, queries: list[str]) -> dict[int, dict]:
    """The answers to the four questions, one row per source."""
    by: dict[int, dict] = {}
    for rows in s3.map_threads(lambda q: ask(url, q), queries):
        for r in rows:
            by[r["source_id"]] = r
    return by


def speed(r: dict) -> float:
    return math.hypot(r["pmra"], r["pmdec"])


def compare(first: dict[int, dict], second: dict[int, dict]) -> list[str]:
    """What differs between the two copies; empty when they agree."""
    out = []
    only_a, only_b = sorted(set(first) - set(second)), sorted(set(second) - set(first))
    if only_a:
        out.append(f"{len(only_a)} sources only in the first copy, e.g. {only_a[:3]}")
    if only_b:
        out.append(f"{len(only_b)} sources only in the second copy, e.g. {only_b[:3]}")
    for name, tol in AGREE.items():
        worst = max((abs(first[s][name] - second[s][name]) for s in set(first) & set(second)
                     if first[s][name] is not None and second[s][name] is not None), default=0.0)
        if worst > tol:
            out.append(f"{name} differs by up to {worst:g} (allowed {tol:g})")
    return out


def select(rows: list[dict]) -> list[list]:
    """The rows that pass the cut on the parallax, as [source_id, ra, dec, pmra, pmdec, parallax, G], sorted by
    right ascension. source_id is text: it does not fit the numbers of a page."""
    out = []
    for r in rows:
        if r["parallax"] is None or r["parallax_over_error"] is None or r["parallax_over_error"] <= MIN_PARALLAX_OVER_ERROR:
            continue
        if r["pmra"] is None or r["pmdec"] is None or speed(r) <= MIN_PM:
            continue
        g = r["phot_g_mean_mag"]
        out.append([str(r["source_id"]), round(r["ra"], 7), round(r["dec"], 7), round(r["pmra"], 3), round(r["pmdec"], 3),
                    round(r["parallax"], 3), None if g is None else round(g, 2)])
    out.sort(key=lambda s: (s[1], s[0]))
    return out


def document(stars: list[list], n_asked: int) -> dict:
    return {
        "about": "Gaia DR3 stars that move more than 0.5 arcsec a year. A row is [source_id, ra, dec, pmra, pmdec, "
                 "parallax, g]: position in degrees (ICRS) at `epoch`; proper motion in mas a year, pmra being the motion in "
                 "right ascension times cos(dec); parallax in mas; G magnitude (null when Gaia gives none). Sorted by ra.",
        "source": "Gaia DR3, table gaia_source, as served by the Mikulski Archive for Space Telescopes (MAST)",
        "licence": "CC BY-SA 3.0 IGO (ESA/Gaia/DPAC)",
        "selection": f"pm > {MIN_PM:g} mas/yr and parallax_over_error > {MIN_PARALLAX_OVER_ERROR:g}",
        "checked": f"A second copy of the catalogue (table gaia.dr3lite of the GAVO Data Center) gives the same {n_asked} "
                   f"sources above the speed; positions agree within {AGREE['ra']:g} degree, proper motions and parallaxes "
                   f"within {AGREE['pmra']:g} mas a year and mas.",
        "epoch": EPOCH,
        "min_arcsec_per_year": MIN_PM / 1000.0,
        "in_catalogue_above_speed": n_asked,
        "count": len(stars),
        "columns": ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "g"],
        "stars": stars,
    }


def main(argv: list[str]) -> int:
    first = {s: r for s, r in gather(MAST, QUERIES).items() if speed(r) > MIN_PM}
    second = {s: r for s, r in gather(GAVO, CHECK_QUERIES).items() if speed(r) > MIN_PM}
    problems = compare(first, second)
    if problems:
        raise RuntimeError("the two copies of Gaia DR3 do not agree, nothing was written: " + "; ".join(problems))
    rows = list(first.values())
    stars = select(rows)
    doc = document(stars, len(rows))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n"
    size = len(text.encode("utf-8"))
    if size >= MAX_BYTES:
        raise RuntimeError(f"fast.json would be {size} bytes, over the limit of {MAX_BYTES}")
    T.write_text(OUT, text)
    fastest = max(stars, key=lambda s: math.hypot(s[3], s[4]))
    dropped = sorted(set(first) - {int(s[0]) for s in stars})
    print(f"{len(rows)} sources above {MIN_PM / 1000:g} arcsec a year in Gaia DR3, the same in both copies; {len(stars)} with a "
          f"parallax measured to better than a fifth (left out: {', '.join(str(s) for s in dropped) or 'none'}); {size} bytes; "
          f"{sum(s[6] is None for s in stars)} without a G magnitude; fastest: Gaia DR3 {fastest[0]} at "
          f"{math.hypot(fastest[3], fastest[4]) / 1000:.2f} arcsec a year")
    numbers.write(T.PRODUCER, {
        "gaia.fast.count": numbers.entry(len(stars), 0),
        "gaia.fast.catalogue": numbers.entry(len(rows), 0),
        "gaia.fast.speed": numbers.entry(MIN_PM / 1000.0, 1, unit="arcsec per year"),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
