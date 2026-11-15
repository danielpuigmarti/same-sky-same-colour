"""Rows of the Checks page (CT-9), written as the fragment of one producer.

A job builds its rows with row(), saves a picture with image_ref() and writes them with write_rows(); the gate
merges the fragments of all producers into site/data/checks/checks.json. Nothing here sets PASS on its own
authority: a row is PASS only when a reviewer's role and the date of the review are given (the contract's rule),
otherwise it stays UNVERIFIED with the measured value in it.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Optional, Union

from . import contracts as C

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "site" / "data"
ROWS_DIR = DATA / "checks" / "rows"
IMG_DIR = DATA / "checks" / "img"

Num = Union[float, str, None]


def row(id: str, title: str, claim: str, test: str, pass_rule: str, status: str, plain: str,
        value: Num = None, unit: Optional[str] = None, reference: Num = None, tolerance: Num = None,
        image: Optional[tuple[str, str]] = None, reviewer_role: Optional[str] = None,
        reviewed_on: Optional[str] = None, rerun: Optional[str] = None, rule_commit: Optional[str] = None) -> C.CheckRow:
    """One Checks row. `image` is what image_ref() returned."""
    return {
        "id": id, "title": title, "claim": claim, "test": test, "pass_rule": pass_rule, "rule_commit": rule_commit,
        "status": status, "plain": plain, "value": value, "unit": unit, "reference": reference,
        "tolerance": tolerance, "image": image[0] if image else None, "image_sha256": image[1] if image else None,
        "reviewer_role": reviewer_role, "reviewed_on": reviewed_on, "rerun": rerun,
    }


def sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def image_ref(path: Path) -> tuple[str, str]:
    """(path relative to site/data/checks/, SHA-256) of a picture that lies below site/data/checks/."""
    path = Path(path).resolve()
    return path.relative_to((DATA / "checks").resolve()).as_posix(), sha256(path)


def write_json(path: Path, value) -> None:
    """Write JSON the way the gate does (one space of indent, a final line break), in one step."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def write_rows(producer: str, rows: list[C.CheckRow], folder: Path = ROWS_DIR) -> Path:
    """Write the rows of one producer to rows/<producer>.json. Raises ValueError if the contract is broken."""
    problems = C.check_checks(rows)
    if problems:
        raise ValueError("Checks rows break the contract: " + "; ".join(problems))
    path = folder / f"{producer}.json"
    write_json(path, rows)
    return path
