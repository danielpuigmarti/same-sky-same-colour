"""Byte-range reads from the public bucket of the SPHEREx archive, with retries and a local cache.

Everything the pipeline reads from a frame goes through get_range(): the bytes of one inclusive range of one key.
Ranges are kept in a cache folder outside the repository (SX_CACHE, or <system temp>/sx-cache), so a rerun
reads the same bytes without asking again. Tests replace the network with recorded bytes through use().
"""
from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional, TypeVar

import requests

from .contracts import BUCKET_URLS

T = TypeVar("T")
R = TypeVar("R")

MAX_PER_HOST = 6
"""At most this many requests in flight (the page keeps the same limit)."""

TRIES = 5

STATS = {"requests": 0, "bytes": 0, "cache_hits": 0, "retries": 0}
_lock = threading.Lock()
_local = threading.local()
_gate = threading.BoundedSemaphore(MAX_PER_HOST)
_source: Optional[Callable[[str, int, int], bytes]] = None


def cache_dir() -> Path:
    """The folder of cached ranges. Never inside the repository."""
    root = os.environ.get("SX_CACHE")
    path = Path(root) if root else Path(tempfile.gettempdir()) / "sx-cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def url(key: str, host: int = 0) -> str:
    """The address of a bucket key; host 0 is the virtual-host form, 1 the path form."""
    return BUCKET_URLS[host] + key


def _session() -> requests.Session:
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def _cache_file(key: str, a: int, b: int) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    return cache_dir() / f"{h}_{a}_{b}.bin"


def _fetch(key: str, a: int, b: int) -> bytes:
    """One range from the bucket. Tries both address forms, backs off between tries."""
    err: Exception = RuntimeError("no try made")
    for k in range(TRIES):
        try:
            with _gate:
                r = _session().get(url(key, k % 2), headers={"Range": f"bytes={a}-{b}"}, timeout=60)
            if r.status_code == 206 and len(r.content) == b - a + 1:
                with _lock:
                    STATS["requests"] += 1
                    STATS["bytes"] += len(r.content)
                return r.content
            err = RuntimeError(f"status {r.status_code}, {len(r.content)} bytes for {b - a + 1}")
        except requests.RequestException as e:
            err = e
        with _lock:
            STATS["retries"] += 1
        time.sleep(0.5 * 2**k)
    raise RuntimeError(f"range {a}-{b} of {key} failed after {TRIES} tries: {err}")


def get_range(key: str, a: int, b: int, cache: bool = True) -> bytes:
    """The bytes a to b, both included, of a bucket key."""
    if b < a:
        raise ValueError("empty range")
    if _source is not None:
        return _source(key, a, b)
    f = _cache_file(key, a, b)
    if cache and f.exists() and f.stat().st_size == b - a + 1:
        with _lock:
            STATS["cache_hits"] += 1
        return f.read_bytes()
    data = _fetch(key, a, b)
    if cache:
        tmp = f.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, f)
    return data


def get_suffix(key: str, n: int) -> bytes:
    """The last n bytes of a key (a 'bytes=-n' request); cached under the file's size."""
    size = file_size(key)
    return get_range(key, size - n, size - 1)


def file_size(key: str) -> int:
    """Size of a key in bytes, from a HEAD request; cached."""
    if _source is not None:
        size = getattr(_source, "sizes", {}).get(key)
        if size is None:
            raise RuntimeError(f"the recorded source does not know the size of {key}")
        return size
    f = cache_dir() / (hashlib.sha1(key.encode()).hexdigest()[:16] + "_size.txt")
    if f.exists():
        return int(f.read_text())
    err: Exception = RuntimeError("no try made")
    for k in range(TRIES):
        try:
            with _gate:
                r = _session().head(url(key, k % 2), timeout=60)
            if r.status_code == 200 and "Content-Length" in r.headers:
                f.write_text(r.headers["Content-Length"])
                return int(r.headers["Content-Length"])
            err = RuntimeError(f"status {r.status_code}")
        except requests.RequestException as e:
            err = e
        time.sleep(0.5 * 2**k)
    raise RuntimeError(f"size of {key} unknown: {err}")


@contextmanager
def use(source: Callable[[str, int, int], bytes]) -> Iterator[None]:
    """Read from `source(key, a, b)` instead of the network (tests). A source may carry a `sizes` dict."""
    global _source
    old, _source = _source, source
    try:
        yield
    finally:
        _source = old


def map_threads(fn: Callable[[T], R], items: Iterable[T], workers: int = MAX_PER_HOST) -> list[R]:
    """fn over items on a few threads, results in the order of the items. The request limit holds regardless."""
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))
