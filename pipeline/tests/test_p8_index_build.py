"""The job index: rows and tiles built from saved headers, against the rows of the same photos in the installed index.

Everything here runs offline. tests/fixtures/index holds the part of the header that the job reads of a few dozen real
photos, and the row and the tiles of each in the installed index on the day they were recorded.
"""
import gzip
import json
import math
from pathlib import Path

import pytest

from jobs import index_build as J
from sx import contracts as C
from sx import index, run, s3

ROOT = Path(__file__).resolve().parents[2]
FIX = Path(__file__).resolve().parent / "fixtures" / "index"
DOC = json.loads((FIX / "headers.json").read_text(encoding="utf-8"))
PHOTOS = DOC["photos"]
BLOB = (FIX / "headers.bin").read_bytes()
CARDS = {p["key"]: BLOB[i * DOC["bytes_each"] : (i + 1) * DOC["bytes_each"]] for i, p in enumerate(PHOTOS)}
BY_KEY = {p["key"]: p for p in PHOTOS}
WEEK = "2025W46_1A"
WEEKS = sorted({p["key"].split("/")[2] for p in PHOTOS})
SEARCHED = [p["key"] for p in PHOTOS if p["rounded_as"] == "search"]


def bucket(calls=None, broken=()):
    """The fixture in place of the archive: a range of a photo is given only if it is the one that was recorded."""

    def source(key, a, b):
        if calls is not None:
            calls.append((key, a, b))
        p = BY_KEY[key]
        if key in broken or (a, b) != (p["start"], p["end"]):
            raise RuntimeError(f"bytes {a}-{b} of {key} are not to be had")
        return CARDS[key]

    return source


def keys_of(week):
    return sorted(k for k in BY_KEY if k.split("/")[2] == week)


def files(folder):
    """Every file of a folder with its bytes and the time it was written."""
    return {p.relative_to(folder).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(folder.rglob("*")) if p.is_file()}


def content(folder):
    """What an index holds, whatever the order of its list of weeks: {tile: rows with the week spelled out}."""
    wv = json.loads((folder / "meta.json").read_text())["wv"]
    return {name: [[wv[r[0]]] + r[1:] for r in J.read_tile(folder, name)] for name in J.tile_names(folder)}


def as_installed(folder):
    """A small index that holds the photos of the fixture exactly as the installed index held them."""
    meta = {**J.scheme(), "wv": [], "complete": [], "key": C.KEY_PATTERN, "row": f"[{', '.join(C.INDEX_ROW)}]",
            "n_frames": len(PHOTOS), "sources": {"sia": len(SEARCHED), "header": len(PHOTOS) - len(SEARCHED)}}
    meta["complete"] = J.all_tiles(meta)
    tiles = {}
    for p in PHOTOS:
        wv, obs, exp, det = J.photo(p["key"])
        if wv not in meta["wv"]:
            meta["wv"].append(wv)
        for t in p["tiles"]:
            tiles.setdefault(t, []).append([meta["wv"].index(wv), obs, exp, det] + p["row"])
    for name, rows in tiles.items():
        data = json.dumps(sorted(rows, key=lambda r: r[4]), separators=(",", ":")).encode()
        J.put(folder / "t" / f"{name}.json.gz", gzip.compress(data, 9, mtime=0))
    J.put(folder / "meta.json", json.dumps(meta, separators=(",", ":")).encode())
    return folder


@pytest.fixture
def offline(tmp_path, monkeypatch):
    """No network: the listing comes from the fixture, the cache and the output lie in a temporary folder."""
    monkeypatch.setenv("SX_CACHE", str(tmp_path / "cache"))
    monkeypatch.setattr(J, "OUT", tmp_path / "out")
    monkeypatch.setattr(J, "ROWS_DIR", tmp_path / "rows")
    monkeypatch.setattr(J, "photos_of", keys_of)
    monkeypatch.setattr(J, "weeks_of_release", lambda: WEEKS)

    def no_listing(params):
        raise AssertionError("the bucket was asked for a listing")

    monkeypatch.setattr(J, "_page", no_listing)
    index._meta.cache_clear()
    index._tile.cache_clear()
    return tmp_path


# -- one photo -------------------------------------------------------------------------------------------


def test_the_fixture_is_a_few_dozen_real_headers_of_every_kind():
    assert 24 <= len(PHOTOS) <= 48 and len(BLOB) == len(PHOTOS) * J.SPAN
    assert {J.photo(k)[3] for k in BY_KEY} == {1, 2, 3, 4, 5, 6}
    assert any("retry" in k for k in BY_KEY) and len(WEEKS) >= 2
    assert {p["start"] for p in PHOTOS} == {12960, 13360, 14160, 14560}
    for p in PHOTOS:
        assert CARDS[p["key"]].startswith(J.FIRST) and CARDS[p["key"]][-80:].startswith(J.LAST)
        assert p["start"] == J.start_of(p["key"]) and p["end"] - p["start"] + 1 == J.SPAN


def test_saved_headers_give_the_rows_of_the_installed_index():
    """Same photos, mid-times equal, corners within 0.000001 degree: the rows that differ are those, and only those,
    that the installed index took from the archive's image search, and they are its rows once rounded its way."""
    calls, differ = [], []
    with s3.use(bucket(calls)):
        for p in PHOTOS:
            r = J.reading(J.read_cards(p["key"], {}))
            mine, theirs = J.values(r), p["row"]
            if mine[0] != theirs[0] or max(abs(a - b) for a, b in zip(mine[1:], theirs[1:])) > 1e-6:
                differ.append(p["key"])
                assert J.values_as_searched(r) == theirs
                assert abs(mine[0] - theirs[0]) < 1.5e-6 and max(abs(a - b) for a, b in zip(mine[1:], theirs[1:])) < 1.5e-4
            assert J.tiles_of([round(x, 7) for x in r[3:]], J.scheme()) == p["tiles"]
    assert len(calls) == len(PHOTOS), "one range request for each photo"
    assert differ == SEARCHED and 0 < len(differ) < len(PHOTOS) / 4, f"{len(PHOTOS)} rows compared, {len(differ)} differ"


@pytest.mark.skipif(not (index.INDEX_DIR / "meta.json").exists(), reason="the full index is not in the tree")
def test_the_installed_index_holds_the_rows_the_fixture_recorded():
    meta = json.loads((index.INDEX_DIR / "meta.json").read_text(encoding="utf-8"))
    assert {k: meta[k] for k in ("T", "nbands", "nra")} == J.scheme()
    for p in PHOTOS:
        wv, obs, exp, det = J.photo(p["key"])
        name = [meta["wv"].index(wv), obs, exp, det]
        for tile in p["tiles"]:
            assert name + p["row"] in J.read_tile(index.INDEX_DIR, tile), (p["key"], tile)


def by_hand(cards):
    """The four corners from the cards by the formulas themselves (pixel offsets, SIP polynomials, the PC matrix, the
    gnomonic projection), without astropy: a second way to the numbers of reading()."""
    d = {}
    for i in range(0, len(cards), 80):
        card = cards[i : i + 80].decode("latin-1")
        if card[8:10] == "= ":
            d[card[:8].strip()] = card[10:].split("/")[0].strip()
    assert d["CTYPE1"] == "'RA---TAN-SIP'" and d["CTYPE2"] == "'DEC--TAN-SIP'" and float(d["LONPOLE"]) == 180

    def poly(name, u, v):
        order = int(d[f"{name}_ORDER"])
        return sum(float(d[f"{name}_{p}_{q}"]) * u**p * v**q for p in range(order + 1) for q in range(order + 1 - p)
                   if f"{name}_{p}_{q}" in d)

    ra0, dec0 = math.radians(float(d["CRVAL1"])), math.radians(float(d["CRVAL2"]))
    out = []
    for px, py in ((0.5, 0.5), (2040.5, 0.5), (2040.5, 2040.5), (0.5, 2040.5)):  # FITS counts pixels from 1
        u, v = px - float(d["CRPIX1"]), py - float(d["CRPIX2"])
        u, v = u + poly("A", u, v), v + poly("B", u, v)
        x = math.radians(float(d["CDELT1"]) * (float(d["PC1_1"]) * u + float(d["PC1_2"]) * v))
        y = math.radians(float(d["CDELT2"]) * (float(d["PC2_1"]) * u + float(d["PC2_2"]) * v))
        den = math.cos(dec0) - y * math.sin(dec0)
        out.append((math.degrees(ra0 + math.atan2(x, den)) % 360,
                    math.degrees(math.atan2(math.sin(dec0) + y * math.cos(dec0), math.hypot(x, den)))))
    return out


def test_the_corners_are_those_of_a_second_method():
    worst = 0.0
    for p in PHOTOS:
        r = J.reading(CARDS[p["key"]])
        for (ra, dec), (ra2, dec2) in zip(zip(r[3::2], r[4::2]), by_hand(CARDS[p["key"]])):
            a = index._vec(ra, dec)
            b = index._vec(ra2, dec2)
            worst = max(worst, math.degrees(math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))))
    assert worst < 1e-9, f"{worst} degree"


def test_a_position_inside_a_photo_finds_the_photo_in_its_own_tile():
    meta = J.scheme()
    assert meta == {k: v for k, v in json.loads((ROOT / "tests/fixtures/idx/meta.json").read_text()).items() if k in meta}
    n = 0
    for p in PHOTOS:
        c = [index._vec(a, d) for a, d in zip(p["row"][1::2], p["row"][2::2])]
        for i in range(7):
            for j in range(7):
                s, t = i / 6, j / 6  # across the photo, corners and edges included
                v = [(1 - s) * (1 - t) * c[0][k] + s * (1 - t) * c[1][k] + s * t * c[2][k] + (1 - s) * t * c[3][k] for k in range(3)]
                ra, dec = math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.atan2(v[2], math.hypot(v[0], v[1])))
                assert index.tile_of(ra, dec, meta) in p["tiles"], (p["key"], ra, dec)
                n += 1
    assert n == 49 * len(PHOTOS)


def test_cards_in_another_place_are_found_once_and_the_place_is_kept():
    keys = [k for k in keys_of(WEEK) if J.photo(k)[3] == 5 and "retry" not in k][:2]
    calls = []

    def moved(key, a, b):  # a header with ten cards more before CRPIX1
        calls.append((a, b))
        whole = b" " * (J.start_of(key) + 800) + CARDS[key] + b" " * 28800
        return whole[a : b + 1]

    found = {}
    with s3.use(moved):
        assert [J.read_cards(k, found) for k in keys] == [CARDS[k] for k in keys]
    start = J.start_of(keys[0])
    assert calls == [(start, start + J.SPAN - 1), (0, 28799), (start + 800, start + 800 + J.SPAN - 1)]
    with s3.use(lambda key, a, b: b" " * (b - a + 1)), pytest.raises(ValueError, match="no cards"):
        J.read_cards(keys[0], {})
    with pytest.raises(ValueError, match="no sky transform"):
        J.reading(CARDS[keys[0]].replace(b"RA---TAN-SIP", b"PIXEL       ").replace(b"DEC--TAN-SIP", b"PIXEL       "))


# -- the listing -----------------------------------------------------------------------------------------


def test_the_listing_follows_its_pages_and_names_folders(monkeypatch):
    ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'
    key = keys_of(WEEK)[0]
    pages = {
        None: f"<ListBucketResult {ns}><IsTruncated>true</IsTruncated><Contents><Key>{key}</Key></Contents>"
              f"<NextContinuationToken>t1</NextContinuationToken></ListBucketResult>",
        "t1": f"<ListBucketResult {ns}><IsTruncated>false</IsTruncated><Contents><Key>dr1/level2/{WEEK}/notes.txt</Key>"
              f"</Contents></ListBucketResult>",
    }
    asked = []

    def page(params):
        asked.append(dict(params))
        if "delimiter" in params:
            return J.ET.fromstring(f"<ListBucketResult {ns}><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>dr1/level2/"
                                   f"2026W01_1A/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>dr1/level2/2025W52_2A/</Prefix>"
                                   f"</CommonPrefixes></ListBucketResult>")
        return J.ET.fromstring(pages[params.get("continuation-token")])

    monkeypatch.setattr(J, "_page", page)
    assert J.listing(f"dr1/level2/{WEEK}/") == [key, f"dr1/level2/{WEEK}/notes.txt"]
    assert J.photos_of(WEEK) == [key], "what is not named as a photo is left out"
    assert [a.get("continuation-token") for a in asked[:2]] == [None, "t1"] and asked[0]["prefix"] == f"dr1/level2/{WEEK}/"
    assert J.weeks_of_release() == ["2025W52_2A", "2026W01_1A"]
    monkeypatch.setattr(J, "_page", lambda params: J.ET.fromstring(f"<ListBucketResult {ns}><IsTruncated>true</IsTruncated></ListBucketResult>"))
    with pytest.raises(RuntimeError, match="cut short"):
        J.listing("dr1/level2/")


# -- an index --------------------------------------------------------------------------------------------


def test_the_command_writes_an_index_that_the_reader_reads(offline):
    out = offline / "idx"
    with s3.use(bucket()):
        assert J.main(["--all", "--into", str(out)]) == 0
    meta = json.loads((out / "meta.json").read_text())
    assert list(meta) == ["T", "nbands", "nra", "wv", "complete", "key", "row", "n_frames", "sources"]
    assert meta["n_frames"] == len(PHOTOS) and meta["sources"] == {"sia": 0, "header": len(PHOTOS)}
    assert meta["complete"] == J.all_tiles(meta) and len(meta["complete"]) == 1654
    assert meta["wv"] == sorted({J.photo(k)[0] for k in BY_KEY}) and meta["key"] == C.KEY_PATTERN
    assert not (out / "meta.json").read_bytes().endswith(b"\n")
    assert set(J.tile_names(out)) == {t for p in PHOTOS for t in p["tiles"]}
    for name in J.tile_names(out):
        raw = (out / "t" / f"{name}.json.gz").read_bytes()
        assert raw[:2] == b"\x1f\x8b" and raw[4:8] == bytes(4), "gzip, with no time of writing in it"
        text = gzip.decompress(raw).decode()
        rows = json.loads(text)
        assert text == json.dumps(rows, separators=(",", ":")) and [r[4] for r in rows] == sorted(r[4] for r in rows)
        assert all(len(r) == len(C.INDEX_ROW) and all(isinstance(x, int) for x in r[:4]) for r in rows)
    for p in PHOTOS:  # the Python twin of site/js/lib/tiles.js finds every photo at its own centre
        c = [index._vec(a, d) for a, d in zip(p["row"][1::2], p["row"][2::2])]
        v = [sum(x[k] for x in c) for k in range(3)]
        ra, dec = math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.atan2(v[2], math.hypot(v[0], v[1])))
        got = [f for f in index.frames_covering(ra, dec, out) if f["key"] == p["key"]]
        assert len(got) == 1 and index.is_indexed(ra, dec, out)
        if p["rounded_as"] == "header":
            assert [got[0]["tmid"]] + [x for c2 in got[0]["corners"] for x in c2] == p["row"]


def test_the_same_command_twice_changes_nothing_and_asks_for_nothing(offline):
    out, calls = offline / "idx", []
    with s3.use(bucket(calls)):
        assert J.main(["--all", "--into", str(out)]) == 0
        before, asked = files(out), len(calls)
        assert J.main(["--all", "--into", str(out)]) == 0, "the readings come from the cache"
        for f in (offline / "cache").glob("index_*"):
            f.unlink()
        assert J.main(["--all", "--into", str(out)]) == 0, "the index holds the photos: they are not read again"
    assert asked == len(PHOTOS) == len(calls) and files(out) == before
    assert not list(out.rglob("*.tmp"))


def test_weeks_added_one_by_one_give_what_they_give_together(offline):
    with s3.use(bucket()):
        assert J.main(["--all", "--into", str(offline / "together")]) == 0
        for week in WEEKS:
            assert J.main(["--week", week, "--into", str(offline / "by-week")]) == 0
        for week in reversed(WEEKS):
            assert J.main(["--week", week, "--into", str(offline / "backwards")]) == 0
        assert J.main(["--since", WEEKS[0], "--into", str(offline / "since")]) == 0
    assert files(offline / "by-week").keys() == files(offline / "together").keys()
    assert {k: v[0] for k, v in files(offline / "by-week").items()} == {k: v[0] for k, v in files(offline / "together").items()}
    assert content(offline / "backwards") == content(offline / "together")
    later = {J.photo(k)[0] for k in BY_KEY if k.split("/")[2] > WEEKS[0]}
    assert set(json.loads((offline / "since" / "meta.json").read_text())["wv"]) == later


def test_rows_that_an_index_holds_stay_as_they_are(offline):
    out = as_installed(offline / "idx")
    before = files(out)
    with s3.use(bucket()):
        assert J.main(["--all", "--into", str(out)]) == 0
    assert files(out) == before, "every photo was there: nothing is written, and no row is put right"
    # take one week out of the tiles; the command puts it back, and leaves the other rows alone
    meta = json.loads((out / "meta.json").read_text())
    gone = [i for i, wv in enumerate(meta["wv"]) if wv.split("/")[0] == WEEK]
    for name in J.tile_names(out):
        rows = [r for r in J.read_tile(out, name) if r[0] not in gone]
        if rows:
            (out / "t" / f"{name}.json.gz").write_bytes(gzip.compress(json.dumps(rows, separators=(",", ":")).encode(), 9, mtime=0))
        else:
            (out / "t" / f"{name}.json.gz").unlink()
    with s3.use(bucket()):
        assert J.main(["--week", WEEK, "--into", str(out)]) == 0
    meta = json.loads((out / "meta.json").read_text())
    assert meta["n_frames"] == len(PHOTOS) and meta["sources"] == {"sia": len(SEARCHED), "header": len(PHOTOS) - len(SEARCHED)}
    for p in PHOTOS:
        wv, obs, exp, det = J.photo(p["key"])
        name = [meta["wv"].index(wv), obs, exp, det]
        want = p["row"] if p["key"].split("/")[2] != WEEK else J.values(J.reading(CARDS[p["key"]]))
        for tile in p["tiles"]:
            assert name + want in J.read_tile(out, tile)


def test_a_week_that_cannot_be_read_whole_is_left_out_and_is_finished_by_the_next_run(offline, capsys):
    out, calls = offline / "idx", []
    bad = keys_of(WEEK)[3]
    with s3.use(bucket(broken={bad})):
        assert J.main(["--all", "--into", str(out)]) == 1
    assert "left out, 1 photo could not be read" in capsys.readouterr().err
    assert {wv.split("/")[0] for wv in json.loads((out / "meta.json").read_text())["wv"]} == set(WEEKS) - {WEEK}
    with s3.use(bucket(calls)):
        assert J.main(["--all", "--into", str(out)]) == 0
    assert [c[0] for c in calls] == [bad], "only the photo that was missing is asked for"
    with s3.use(bucket()):
        J.main(["--all", "--into", str(offline / "whole")])
    assert content(out) == content(offline / "whole")


def test_the_archive_is_left_alone_once_it_stops_answering(offline, monkeypatch):
    calls = []
    monkeypatch.setattr(J, "GIVE_UP", 3)
    monkeypatch.setattr(J.s3, "MAX_PER_HOST", 1)
    with s3.use(bucket(calls, broken=set(BY_KEY))):
        assert J.main(["--week", WEEK, "--into", str(offline / "idx")]) == 1
    assert len(calls) == 3 and not (offline / "idx").exists()


def test_without_a_week_the_command_only_says_what_the_index_holds(offline, capsys):
    as_installed(offline / "idx")
    J.describe(offline / "idx")
    said = capsys.readouterr().out
    assert f"{len(PHOTOS)} photos of {len(WEEKS)} weeks, {WEEKS[0]} to {WEEKS[-1]}" in said and f"--since {WEEKS[-1]}" in said
    with s3.use(bucket(broken=set(BY_KEY))):
        assert run.main(["index"]) == 0
    assert "index" in run.names() and "index_build" not in run.names()
    with pytest.raises(SystemExit):
        J.main(["--week", "../site"])


def test_without_a_folder_the_index_is_written_outside_the_site():
    assert J.OUT == ROOT / "pipeline" / "out" and "pipeline/out/" in (ROOT / ".gitignore").read_text().split()


# -- the check -------------------------------------------------------------------------------------------


def test_the_check_on_the_saved_headers_counts_what_differs(offline, monkeypatch, capsys):
    """The check of the Checks row K-index, on the photos of the fixture's week in place of the whole week."""
    monkeypatch.setattr(J, "INDEX_DIR", as_installed(offline / "installed"))
    week, searched = keys_of(WEEK), [k for k in SEARCHED if k in keys_of(WEEK)]
    with s3.use(bucket()):
        assert J.main(["--week", WEEK, "--check"]) == 0
    (row,) = json.loads((offline / "rows" / "p8.json").read_text(encoding="utf-8"))
    assert C.check_checks([row]) == [] and row["id"] == "K-index"
    assert row["value"] == f"{len(week)} rows compared, {len(searched)} differ" and row["status"] == "LIMIT"
    assert f"{len(searched)} of the {len(searched)} rows are the installed rows digit for digit; 0 are not explained" in row["test"]
    assert row["rerun"] == f"python -m sx.run index --week {WEEK} --check" and row["reviewer_role"] is None
    assert f"{len(week)} rows compared, {len(searched)} differ" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        J.main(["--week", WEEK, "--check", "--into", str(offline / "idx")])


def test_the_check_fails_when_a_photo_a_time_a_corner_or_a_tile_is_not_the_same(offline):
    with s3.use(bucket()):
        J.build([WEEK], offline / "built")
    readings = J.cached(WEEK)
    same = J.compare(WEEK, offline / "built", offline / "built", readings)
    week = keys_of(WEEK)
    assert same["compared"] == same["built"] == len(week) and same["differ"] == same["other_tiles"] == 0
    assert J.verdict(same, len(week)) == "same" and J.verdict(same, len(week) + 1) == "fail", "the listing counts too"
    assert J.check_row(same, len(week), None)["status"] == "UNVERIFIED"
    passed = J.check_row(same, len(week), ("a physics student", "2026-11-15"))
    assert passed["status"] == "PASS" and C.check_checks([passed]) == []

    def spoilt(change):
        """A copy of the built index with one thing changed in every tile that holds the first photo of the week."""
        folder = offline / f"spoilt-{change}"
        J.shutil.copytree(offline / "built", folder)
        first = min(r for name in J.tile_names(folder) for r in J.read_tile(folder, name))[:4]
        names = [name for name in J.tile_names(folder) if any(r[:4] == first for r in J.read_tile(folder, name))]
        assert len(names) > 1
        for name in names[:1] if change == "tile" else names:
            rows = J.read_tile(folder, name)
            for r in [r for r in rows if r[:4] == first]:
                if change == "time":
                    r[4] = round(r[4] + 0.000002, 6)
                elif change == "corner":
                    r[5] = round(r[5] + 0.0001, 4)
                else:
                    rows.remove(r)
            (folder / "t" / f"{name}.json.gz").write_bytes(gzip.compress(json.dumps(rows, separators=(",", ":")).encode(), 9, mtime=0))
        return J.compare(WEEK, offline / "built", folder, readings)

    time, corner, photo, tile = spoilt("time"), spoilt("corner"), spoilt("photo"), spoilt("tile")
    assert (time["differ"], time["differ_time"], time["differ_corner"], time["as_searched"]) == (1, 1, 0, 0)
    assert (corner["differ"], corner["differ_time"], corner["differ_corner"]) == (1, 0, 1)
    assert (photo["only_built"], photo["compared"], photo["differ"]) == (1, len(week) - 1, 0)
    assert (tile["other_tiles"], tile["differ"], tile["only_built"]) == (1, 0, 0)
    for c in (time, corner, photo, tile):
        assert J.verdict(c, len(week)) == "fail"
        row = J.check_row(c, len(week), ("a physics student", "2026-11-15"))
        assert row["status"] == "FAIL" and row["reviewer_role"] is None and C.check_checks([row]) == []
