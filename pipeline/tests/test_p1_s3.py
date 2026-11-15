"""s3.py: ranges, retries, the cache folder."""
import tempfile
from pathlib import Path

import pytest

from sx import s3

KEY = "dr1/level2/2025W23_2B/l2b-v27-2026-201/5/level2_2025W23_2B_0441_4D5_spx_l2b-v27-2026-201.fits"


@pytest.fixture
def cache(tmp_path, monkeypatch):
    monkeypatch.setenv("SX_CACHE", str(tmp_path / "c"))
    return tmp_path / "c"


def test_default_cache_is_outside_the_repository(monkeypatch):
    monkeypatch.delenv("SX_CACHE", raising=False)
    root = Path(__file__).resolve().parents[2]
    folder = s3.cache_dir().resolve()
    assert root not in folder.parents and folder != root
    assert Path(tempfile.gettempdir()).resolve() in folder.parents


def test_urls_are_the_two_bucket_forms():
    assert s3.url(KEY, 0) == "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/" + KEY
    assert s3.url(KEY, 1) == "https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/" + KEY


def test_a_range_is_fetched_once_then_read_from_the_cache(cache, monkeypatch):
    calls = []

    def fake(key, a, b):
        calls.append((key, a, b))
        return bytes(range(256))[: b - a + 1]

    monkeypatch.setattr(s3, "_fetch", fake)
    assert s3.get_range(KEY, 0, 9) == bytes(range(10))
    assert s3.get_range(KEY, 0, 9) == bytes(range(10))
    assert calls == [(KEY, 0, 9)]
    assert any(cache.iterdir())


def test_retries_on_a_bad_status_and_alternates_hosts(cache, monkeypatch):
    seen = []

    class R:
        def __init__(self, code, content):
            self.status_code, self.content = code, content

    class S:
        def get(self, url, headers, timeout):
            seen.append(url)
            return R(500, b"") if len(seen) < 3 else R(206, b"x" * 10)

    monkeypatch.setattr(s3, "_session", lambda: S())
    monkeypatch.setattr(s3.time, "sleep", lambda s: None)
    before = s3.STATS["retries"]
    assert s3.get_range(KEY, 100, 109) == b"x" * 10
    assert s3.STATS["retries"] - before == 2
    assert seen[0].startswith("https://nasa-irsa-spherex.s3") and seen[1].startswith("https://s3.us-east-1")


def test_a_short_answer_is_not_accepted(cache, monkeypatch):
    class R:
        status_code, content = 206, b"abc"

    class S:
        def get(self, *a, **k):
            return R()

    monkeypatch.setattr(s3, "_session", lambda: S())
    monkeypatch.setattr(s3.time, "sleep", lambda s: None)
    with pytest.raises(RuntimeError, match="failed after"):
        s3.get_range(KEY, 0, 9)


def test_use_replaces_the_network_and_restores_it():
    with s3.use(lambda key, a, b: b"z" * (b - a + 1)):
        assert s3.get_range(KEY, 5, 7) == b"zzz"
    assert s3._source is None


def test_empty_range_is_an_error():
    with pytest.raises(ValueError):
        s3.get_range(KEY, 5, 4)


def test_map_threads_keeps_order():
    assert s3.map_threads(lambda x: x * 2, range(20)) == [x * 2 for x in range(20)]
