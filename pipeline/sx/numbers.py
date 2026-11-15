"""Numbers of the pages (CT-10), written as the fragment of one producer.

A page shows a number only through <span data-n="key">; the gate fills it with the entry's `text`. Several jobs
of one producer add to the same fragment, so write() merges into what is already there.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from . import contracts as C
from .checks import DATA, write_json

NUMBERS_DIR = DATA / "numbers"


def text(value: float, decimals: int = 0) -> str:
    """The number as a page shows it: fixed decimals and a comma between thousands (1,200)."""
    return f"{value:,.{decimals}f}"


def entry(value: float, decimals: int = 0, err: Optional[float] = None, unit: Optional[str] = None,
          check: Optional[str] = None, shown: Optional[str] = None) -> C.NumberEntry:
    """One number. `shown` overrides the text; by default it is the value with `decimals` decimals."""
    return {"value": value, "err": err, "unit": unit, "text": shown if shown is not None else text(value, decimals),
            "check": check}


def write(producer: str, entries: dict[str, C.NumberEntry], folder: Path = NUMBERS_DIR) -> Path:
    """Add entries to numbers/<producer>.json (keys already there are replaced), sorted by key."""
    path = folder / f"{producer}.json"
    have = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    have.update(entries)
    have = dict(sorted(have.items()))
    problems = C.check_numbers(have)
    if problems:
        raise ValueError("numbers break the contract: " + "; ".join(problems))
    write_json(path, have)
    return path
