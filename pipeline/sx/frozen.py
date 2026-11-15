"""The frozen list of frames: pipeline/frozen/obs_ids.json.

Every job that picks frames records the bucket keys it used here, through record(); a rerun asks load() for the
same keys and so reads exactly the same frames, whatever the search services answer today. The file is one JSON
object, {job: [key, ...]}, keys sorted, written the same way every time.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Iterable

FILE = Path(__file__).resolve().parents[1] / "frozen" / "obs_ids.json"


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def record(job: str, keys: Iterable[str], path: Path = FILE) -> list[str]:
    """Write the keys a job used. Replaces what was recorded for that job and keeps the other jobs' lists."""
    keys = sorted(set(keys))
    data = _read(path)
    data[job] = keys
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(dict(sorted(data.items())), indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return keys


def load(job: str, path: Path = FILE) -> list[str] | None:
    """The keys recorded for a job, or None if it has none yet."""
    return _read(path).get(job)


def frames_for(job: str, find: Callable[[], Iterable[str]], path: Path = FILE) -> list[str]:
    """The recorded keys of a job; when there are none, call find(), record what it gives and return that."""
    got = load(job, path)
    return got if got is not None else record(job, find(), path)
