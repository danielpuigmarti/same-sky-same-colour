"""What the jobs targets, motion, rwaur and gaia_fast left on disk: the contracts, the written rules applied again
to the numbers, and the numbers that have a reference. The last tests read a few frames again (network or cache)."""
import hashlib
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pytest

from sx import contracts, display, frozen
from sx.stamp import cut

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jobs import _targets_lib as T  # noqa: E402
from jobs import gaia_fast, motion, rwaur, targets  # noqa: E402
from test_p1_support import needs_network  # noqa: E402

DATA = T.DATA
TARGETS = ["eps-indi-b", "barnard", "wise0855", "rw-aur", "r-dra"]
POSITION_ONLY = ["barnard", "r-dra", "wise0855"]
BRIGHTNESS_UNITS = {"mJy", "MJy/sr", "Jy", "mag", "%", "times"}
PLACEHOLDER = re.compile(r"\{\{([^{}]+)\}\}")


def read(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def numbers() -> dict:
    return read(DATA / "numbers" / "p3.json")


def rows() -> list:
    return read(DATA / "checks" / "rows" / "p3.json")


def manifest(folder: str) -> dict:
    return read(DATA / folder / "manifest.json")


def det_of(key: str) -> int:
    return int(contracts.KEY_REGEX.fullmatch(key).group(3))


def on_the_display_grid(m: dict) -> bool:
    """North up, east to the left, one SPHEREx pixel per pixel, the target at the centre of every frame."""
    want = [-display.PIXEL_DEG, 0.0, 0.0, display.PIXEL_DEG]
    return m.get("grid") == "north-up" and all(
        f["tx"] == m["w"] // 2 and f["ty"] == m["h"] // 2 and f["sky"]["cd"] == pytest.approx(want)
        and abs(f["sky"]["ra"] - m["ra"]) < 1e-6 and abs(f["sky"]["dec"] - m["dec"]) < 1e-6 for f in m["frames"])


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


# -- showcases -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("folder", [f"targets/{t}" for t in TARGETS] + ["lie"])
def test_every_showcase_meets_the_contract(folder):
    assert contracts.check_showcase(DATA / folder) == []


@pytest.mark.parametrize("tid", TARGETS)
def test_a_target_showcase_is_one_detector_in_two_visits_paired_at_the_same_colour(tid):
    m = manifest(f"targets/{tid}")
    f = m["frames"]
    assert m["det"] == targets.DET[tid] and {det_of(x["key"]) for x in f} == {m["det"]}
    assert (m["w"], m["h"]) == (targets.SIZE, targets.SIZE) and {x["visit"] for x in f} == {0, 1}
    assert on_the_display_grid(m)
    assert 1 <= len(m["pairs"]) <= contracts.MATCH_MAX_PAIRS and len(f) == 2 * len(m["pairs"])
    for i, j in m["pairs"]:
        assert abs(f[i]["lam"] - f[j]["lam"]) <= contracts.MATCH_BANDWIDTH_FRACTION * min(f[i]["bw"], f[j]["bw"])
        assert f[j]["mjd"] - f[i]["mjd"] > contracts.VISIT_GAP_DAYS
    frozen_keys = set(frozen.load("targets"))
    assert all(x["key"] in frozen_keys for x in f)
    assert (DATA / "targets" / tid / "pair.png").stat().st_size > 500


@pytest.mark.parametrize("tid", TARGETS)
def test_a_showcase_holds_real_pictures_of_the_target(tid):
    m = manifest(f"targets/{tid}")
    n = len(m["frames"])
    data = np.fromfile(DATA / "targets" / tid / "stamps.bin", "<f4").reshape(n, m["h"], m["w"])
    flags = np.fromfile(DATA / "targets" / tid / "flags.bin", "<i4").reshape(n, m["h"], m["w"])
    # the photos are turned to north up, so the corners of the square may fall outside what was cut
    assert np.isfinite(data).mean() > 0.75 and (flags != 0).any()
    for k, f in enumerate(m["frames"]):
        x, y = int(round(f["tx"])), int(round(f["ty"]))
        box = data[k, y - 2 : y + 3, x - 2 : x + 3]
        sky = np.nanmedian(data[k])
        if tid == "r-dra":  # saturated: the pixels at the star hold no value at all
            assert np.isnan(box).any()
        elif tid != "wise0855":  # too faint for one photo; the others stand well above the sky
            assert np.nanmax(box) > sky + 5 * 1.4826 * np.nanmedian(np.abs(data[k] - sky))


def test_the_slider_stage_is_one_showcase_of_all_detectors_then_matched_pairs():
    m, stops = manifest("lie"), read(DATA / "lie" / "stops.json")
    f = m["frames"]
    first = [x for x in f if x["visit"] == 0]
    assert m["id"] == "lie" and m["det"] == rwaur.LIE_DET and (m["w"], m["h"]) == (rwaur.LIE_SIZE, rwaur.LIE_SIZE)
    assert on_the_display_grid(m)
    assert {det_of(x["key"]) for x in first} == {1, 2, 3, 4, 5, 6}
    assert {det_of(x["key"]) for x in f if x["visit"] == 1} == {m["det"]}
    for i, j in m["pairs"]:
        assert det_of(f[i]["key"]) == det_of(f[j]["key"]) == m["det"]
        assert abs(f[i]["lam"] - f[j]["lam"]) <= contracts.MATCH_BANDWIDTH_FRACTION * min(f[i]["bw"], f[j]["bw"])
    by = {s["id"]: s for s in stops["stops"]}
    assert list(by) == ["all", "detector", "matched"] and stops["detector"] == m["det"]
    assert by["all"]["frames"] == list(range(len(first)))
    assert by["detector"]["frames"] == [k for k, x in enumerate(first) if det_of(x["key"]) == m["det"]]
    assert sorted(map(tuple, by["matched"]["pairs"])) == sorted(map(tuple, m["pairs"]))
    assert len(stops["background"]) == len(f) and stops["stretch"]["black"] < stops["stretch"]["white"]
    n = numbers()
    assert n["lie.photos.all"]["value"] == len(first) and n["lie.photos.detector"]["value"] == len(by["detector"]["frames"])
    assert n["lie.pairs"]["value"] == len(m["pairs"])
    for s in stops["stops"]:
        assert s["meter"] in n and s["target"] in n
    frozen_keys = set(frozen.load("rwaur"))
    assert all(x["key"] in frozen_keys for x in f)


# -- cards ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("tid", TARGETS)
def test_a_card_types_no_number_and_names_only_numbers_that_exist(tid):
    card, n = read(DATA / "targets" / tid / "card.json"), numbers()
    assert card["id"] == tid and card["showcase"] == "manifest.json" and card["detector"] == targets.DET[tid]
    assert card["check"] in {r["id"] for r in rows()}
    named = [k for s in strings(card) for k in PLACEHOLDER.findall(s)]
    listed = card["numbers"] + [k for b in card.get("bands", []) for k in b["numbers"]] + card.get("motion", {}).get("numbers", [])
    assert named or tid == "rw-aur"
    for key in named + listed:
        assert key in n, key
    for text in (card["verdict"], card.get("motion", {}).get("line", ""), card.get("beside", {}).get("line", "")):
        assert not re.search(r"\d", PLACEHOLDER.sub("", text).replace("2010", "").replace("0855", "")), text


@pytest.mark.parametrize("tid", ["eps-indi-b", "barnard", "wise0855"])
def test_a_mover_card_shows_the_2010_image_and_both_epochs(tid):
    card = read(DATA / "targets" / tid / "card.json")
    j = card["jump"]
    assert card["kind"] == "mover" and [p["label"][:4] for p in j["panels"]] == ["WISE", "SPHE"]
    assert j["panels"][0]["year"] == pytest.approx(2010.6, abs=0.3) and 2025.3 < j["panels"][1]["year"] < 2026.5
    assert "AllWISE Atlas image, band W2" in j["panels"][0]["what"]
    for name in ("jump.png", "wise2010.png", "spherex.png"):
        assert (DATA / "targets" / tid / name).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    for q in j["catalogue"] + j["measured"] + j["track"]:
        assert 0 <= q["u"] <= 1 and 0 <= q["v"] <= 1
    # the catalogue track runs from the 2010 place to the SPHEREx place
    assert math.hypot(j["track"][-1]["u"] - j["catalogue"][1]["u"], j["track"][-1]["v"] - j["catalogue"][1]["v"]) < 0.01
    assert card["reference"]["unverified"] == (tid == "wise0855")
    assert ("Gaia DR3" in card["reference"]["text"]) == (tid != "wise0855")


def test_the_star_beside_wise_0855_is_named_and_was_found_where_gaia_puts_it():
    n, card = numbers(), read(DATA / "targets" / "wise0855" / "card.json")
    k5 = next(x for x in rows() if x["id"] == "K5")
    star = card["beside"]["source"]
    assert re.fullmatch(r"Gaia DR3 \d+", star) and star in k5["test"] and card["beside"]["is_catalogue_source"]
    assert [q["source"] for q in card["jump"]["neighbours"]] == [star]
    assert n["targets.wise0855.beside.off_px"]["value"] <= targets.BESIDE_TOL_PX
    assert n["targets.wise0855.beside.off"]["value"] == pytest.approx(n["targets.wise0855.beside.off_px"]["value"] * T.PX_ARCSEC)
    assert 0 < n["targets.wise0855.beside.away"]["value"] < T.NEIGHBOUR_ARCSEC
    assert all("beside" not in read(DATA / "targets" / t / "card.json") for t in ("eps-indi-b", "barnard"))


@pytest.mark.parametrize("tid", POSITION_ONLY)
def test_no_brightness_for_a_target_that_is_position_only(tid):
    n, card = numbers(), read(DATA / "targets" / tid / "card.json")
    own = {k: v for k, v in n.items() if k.split(".")[1:2] == [tid]}
    assert own and all(v["unit"] not in BRIGHTNESS_UNITS for v in own.values()), [k for k, v in own.items() if v["unit"] in BRIGHTNESS_UNITS]
    assert not any(w in k for k in own for w in ("flux", "change", "swing", "spectrum", "curve", "brightness"))
    assert "bands" not in card and "no brightness is given" in card["verdict"]
    if tid == "wise0855":  # shown only where it can be seen: the reddest detector, from 4.4 µm
        assert all(f["lam"] >= 4.4 for f in manifest("targets/wise0855")["frames"])


def test_r_draconis_reads_too_bright_to_measure_with_the_count_of_photos_checked():
    n, card = numbers(), read(DATA / "targets" / "r-dra" / "card.json")
    assert card["kind"] == "saturated" and card["plain"] == "too bright to measure"
    assert n["targets.r-dra.saturated"]["value"] == n["targets.r-dra.frames"]["value"] >= 400
    assert {"targets.r-dra.saturated", "targets.r-dra.frames"} <= set(PLACEHOLDER.findall(card["verdict"]))
    k6 = next(x for x in rows() if x["id"] == "K6-rdra")
    assert k6["value"] == f"{n['targets.r-dra.saturated']['text']} of {n['targets.r-dra.frames']['text']}"


def test_the_saturation_flags_of_r_draconis_sit_at_the_star_and_not_all_over_the_photo():
    # the verdict rests on these flags: at the star every pixel carries one, far from it almost none does
    m = manifest("targets/r-dra")
    n = len(m["frames"])
    flags = np.fromfile(DATA / "targets" / "r-dra" / "flags.bin", "<i4").reshape(n, m["h"], m["w"])
    yy, xx = np.mgrid[: m["h"], : m["w"]]
    for k, f in enumerate(m["frames"]):
        r = np.hypot(xx - f["tx"], yy - f["ty"])
        sat = (flags[k] & T.SAT_MASK) != 0
        assert sat[r <= targets.RDRA_RADIUS].mean() > 0.9 and sat[r > 20].mean() < 0.01


# -- rows, numbers, decisions --------------------------------------------------------------------------


def test_the_rows_meet_the_contract_and_none_passes_without_a_reviewer():
    r, n = rows(), numbers()
    assert contracts.check_checks(r) == [] and contracts.check_numbers(n) == []
    assert contracts.check_numbers_have_checks(n, r) == []
    assert {"K5", "K6", "K7"} <= {x["id"] for x in r} and [x["id"] for x in r] == [i for i in T.ROW_ORDER if i in {x["id"] for x in r}]
    for x in r:
        assert x["status"] != "PASS" or (x["reviewer_role"] and x["reviewed_on"])
        assert x["rerun"].startswith("python -m sx.run ") and x["value"] and x["pass_rule"]


def test_every_row_has_its_picture_unchanged():
    for x in rows():
        path = DATA / "checks" / x["image"]
        assert path.name.startswith(x["id"].lower()[:2] + "-") and path.exists()
        assert hashlib.sha256(path.read_bytes()).hexdigest() == x["image_sha256"]


def test_the_review_sheets_are_there():
    for h in ("h5", "h6", "h7"):
        text = (T.REVIEW / f"{h}.md").read_text(encoding="utf-8")
        assert text.startswith(f"# {h.upper()}") and "**It passes if**" in text
        assert (T.REVIEW / f"{h}.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_the_tolerances_were_written_first_and_are_the_ones_applied():
    tol, n = targets.tolerances(), numbers()
    k5 = next(x for x in rows() if x["id"] == "K5")
    for tid in targets.MOVERS:
        m = tol["movers"][tid]
        assert n[f"targets.{tid}.shift.tolerance"]["value"] == m["shift_arcsec"]
        assert n[f"targets.{tid}.position.tolerance_px"]["value"] == m["position_px"]
        within = (n[f"targets.{tid}.shift.diff"]["value"] <= m["shift_arcsec"]
                  and n[f"targets.{tid}.position.off_px"]["value"] <= m["position_px"])
        assert read(DATA / "targets" / tid / "card.json")["within_tolerance"] == within
        # the difference is not above what the two shifts allow, and the shifts are those of a fast mover
        d = abs(n[f"targets.{tid}.shift.measured"]["value"] - n[f"targets.{tid}.shift.catalogue"]["value"])
        assert d <= n[f"targets.{tid}.shift.diff"]["value"] + 1e-9 and n[f"targets.{tid}.shift.catalogue"]["value"] > 60
        assert m["allwise"]["tile"] in read(DATA / "targets" / tid / "card.json")["jump"]["panels"][0]["what"]
    all_within = all(read(DATA / "targets" / t / "card.json")["within_tolerance"] for t in targets.MOVERS)
    assert (k5["status"] in ("UNVERIFIED", "PASS")) == all_within
    # the star that saturates WISE: the row says how it was measured and which value was dropped, and it does not
    # need the beam width that its tolerance holds
    assert "Barnard's Star saturates WISE" in k5["pass_rule"] and "That value is not used" in k5["pass_rule"]
    b = tol["movers"]["barnard"]
    assert n["targets.barnard.shift.diff"]["value"] <= b["shift_arcsec"] - b["allwise_saturated_arcsec"]


def test_the_catalogue_shift_of_each_mover_is_what_astropy_gives():
    # the number on the card against a reading of the catalogue that does not pass through the job
    tol, n = targets.tolerances(), numbers()
    for tid in targets.MOVERS:
        cat, aw = T.targets()[tid]["catalogue"], tol["movers"][tid]["allwise"]
        a, b = T.predict(cat, aw["first_mjd"]), T.predict(cat, aw["last_mjd"])
        then = (0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1]))
        now = T.predict(cat, n[f"targets.{tid}.spherex.month"]["value"])
        shift = float(np.hypot(*T.offset_arcsec(*then, *now)))
        assert n[f"targets.{tid}.shift.catalogue"]["value"] == pytest.approx(shift, abs=0.01)
        years = (n[f"targets.{tid}.spherex.month"]["value"] - 0.5 * (aw["first_mjd"] + aw["last_mjd"])) / 365.25
        pm = math.hypot(cat["pmra"], cat["pmdec"]) / 1000
        assert shift / years == pytest.approx(pm, rel=0.02)


def test_the_decisions_have_the_agreed_form():
    d = read(T.DECISIONS_FILE)
    assert set(d) == {"S1", "S2"} and set(d["S1"]) == set(motion.TARGETS) and set(d["S2"]) == {"1", "2", "3", "4", "5", "6"}
    for part in d.values():
        for entry in part.values():
            assert set(entry) == {"build", "why"} and isinstance(entry["build"], bool) and len(entry["why"]) > 40


def test_motion_is_built_only_where_the_written_rule_holds():
    d, n, rule = read(T.DECISIONS_FILE)["S1"], numbers(), targets.tolerances()["motion"]
    for tid in motion.TARGETS:
        sig, meas, err, cat = (n[f"motion.{tid}.{k}"]["value"] for k in ("significance", "measured", "error", "catalogue"))
        if d[tid]["build"]:
            assert sig >= rule["nonzero_sigma"] and abs(meas - cat) <= rule["within_sigma"] * err * math.sqrt(2)
            assert n[f"motion.{tid}.stars"]["value"] >= 3
        assert f"{meas:.2f} +- {err:.2f} arcsec" in d[tid]["why"]
        # the field stars' scatter is given both ways, and what the rule says with the larger one
        assert "with every star counted fully" in d[tid]["why"] and ("met that way too" in d[tid]["why"]) == d[tid]["build"]
        assert read(DATA / "targets" / tid / "card.json")["motion"]["build"] == d[tid]["build"]
        assert 100 < n[f"motion.{tid}.days"]["value"] < 400
    assert "May 2025" not in (n["motion.wise0855.first"]["text"], n["motion.wise0855.last"]["text"])


def test_the_motion_agrees_with_a_first_separate_measurement():
    # reference values: the same photos measured earlier with other code (east, north, error in arcsec). Kept as a
    # guard: a change in the code that moves the result beyond the errors fails here
    n = numbers()
    for tid, (east, north, err) in {"eps-indi-b": (3.97, -2.56, 0.14), "wise0855": (-3.56, 1.08, 0.47)}.items():
        mine, mine_err = n[f"motion.{tid}.measured"]["value"], n[f"motion.{tid}.error"]["value"]
        assert abs(mine - math.hypot(east, north)) <= 2 * math.hypot(err, mine_err)


def test_a_band_of_rw_aurigae_is_shown_only_where_the_written_rule_holds():
    d, n, tol = read(T.DECISIONS_FILE)["S2"], numbers(), targets.tolerances()["rw-aur"]
    card = read(DATA / "targets" / "rw-aur" / "card.json")
    for det in range(1, 7):
        k = f"rwaur.d{det}"
        has_mask = f"{k}.masked" in n and n[f"{k}.masked.pairs"]["value"] >= rwaur.MIN_PAIRS
        rule = (has_mask and n[f"{k}.masked"]["value"] * n[f"{k}.change"]["value"] > 0
                and abs(n[f"{k}.stars.median"]["value"]) <= tol["comparison_median_pct"])
        assert d[str(det)]["build"] == rule, det
        band = card["bands"][det - 1]
        assert band["detector"] == det and band["shown"] == rule
        assert (band["text"] == "too bright to measure reliably") == (not rule)
        if has_mask:  # the count of comparison stars is printed with the band
            assert n[f"{k}.stars"]["value"] >= 10 and f"{n[f'{k}.stars']['text']} stars" in d[str(det)]["why"]
    assert card["outside_comparison"] == "no outside comparison shown"
    assert PLACEHOLDER.findall(card["verdict"]) == ["rwaur.first", "rwaur.last"]
    assert n["rwaur.first"]["text"] == "September 2025" and n["rwaur.last"]["text"] == "February to March 2026"


def test_rw_aurigae_before_masking_is_near_the_reference_values():
    # the reference values come from another pairing of the same photos (colours within 1%), so the two differ by
    # more than rounding: the sign is the same in every band, and the values agree within three errors
    n, ref = numbers(), targets.tolerances()["rw-aur"]["reference_before_masking_pct"]
    for det, want in zip(range(1, 7), ref):
        got = n[f"rwaur.d{det}.change"]
        assert got["value"] * want > 0 and abs(got["value"] - want) <= 3 * got["err"], det


def test_false_flicker_falls_as_the_colour_is_matched():
    n = numbers()
    a, b, c = (n[f"lie.swing.{k}"]["value"] for k in ("all", "detector", "matched"))
    assert a > b > c >= 1 and c < 1.10
    assert n["lie.swing.matched.percent"]["value"] == pytest.approx(100 * (c - 1))
    assert n["lie.stars.all"]["value"] == 20 and n["lie.stars.detector"]["value"] >= 10 and n["lie.stars.matched"]["value"] >= 10
    # reference values of a first, separate measurement of the same photos
    assert (a, b, c) == pytest.approx((11.8, 2.18, 1.02), rel=0.01)
    assert n["lie.rwaur.all"]["value"] == pytest.approx(49.8, rel=0.01)
    assert n["lie.rwaur.detector"]["value"] == pytest.approx(2.71, rel=0.01)
    k7 = next(x for x in rows() if x["id"] == "K7")
    assert k7["status"] in ("UNVERIFIED", "PASS")


def test_the_frozen_lists_hold_every_frame_the_jobs_read():
    for job in ("targets", "motion", "rwaur"):
        keys = frozen.load(job)
        assert keys and len(set(keys)) == len(keys) and all(contracts.KEY_REGEX.fullmatch(k) for k in keys)
    assert {det_of(k) for k in frozen.load("motion")} == {motion.DET}
    assert {det_of(k) for k in frozen.load("rwaur")} == {1, 2, 3, 4, 5, 6}


# -- the fast stars ------------------------------------------------------------------------------------


def test_the_fast_stars_file():
    path = DATA / "gaia" / "fast.json"
    doc = read(path)
    stars = doc["stars"]
    assert path.stat().st_size < 1_000_000
    assert doc["columns"] == ["source_id", "ra", "dec", "pmra", "pmdec", "parallax", "g"] and doc["epoch"] == 2016.0
    assert doc["count"] == len(stars) == numbers()["gaia.fast.count"]["value"] and 500 < len(stars) < 20000
    assert "CC BY-SA 3.0 IGO" in doc["licence"]
    ids = [s[0] for s in stars]
    assert len(set(ids)) == len(ids) and all(isinstance(i, str) and i.isdigit() for i in ids)
    assert [s[1] for s in stars] == sorted(s[1] for s in stars)
    for s in stars:
        assert len(s) == 7 and 0 <= s[1] < 360 and -90 <= s[2] <= 90 and math.hypot(s[3], s[4]) > gaia_fast.MIN_PM and s[5] > 0
    by = {s[0]: s for s in stars}
    # Barnard's Star, the fastest star of the sky, and the two named movers that Gaia holds, as names.json has them
    fastest = max(stars, key=lambda s: math.hypot(s[3], s[4]))
    assert fastest[0] == "4472832130942575872" and math.hypot(fastest[3], fastest[4]) == pytest.approx(10393, abs=5)
    for tid in ("barnard", "eps-indi-b"):
        cat = T.targets()[tid]["catalogue"]
        sid = re.search(r"Gaia DR3 (\d+)", cat["source"]).group(1)
        assert by[sid][1:6] == pytest.approx([cat["ra"], cat["dec"], cat["pmra"], cat["pmdec"], cat["parallax"]], abs=2e-3)


# -- a few frames read again ---------------------------------------------------------------------------


@needs_network
def test_r_draconis_is_saturated_in_frames_read_again():
    # the first and the last photo of its showcase, read again with the shared stamp cutter in the detector's own
    # pixels instead of the job's rows
    e = T.targets()["r-dra"]
    m = manifest("targets/r-dra")
    for f in (m["frames"][0], m["frames"][-1]):
        st = cut(T.frame(f["key"]), e["ra"], e["dec"], size=9)
        yy, xx = np.mgrid[:9, :9]
        near = np.hypot(xx - st.tx, yy - st.ty) <= targets.RDRA_RADIUS
        assert ((st.flags & T.SAT_MASK) != 0)[near].any(), f["key"]


@needs_network
def test_the_star_beside_wise_0855_is_at_its_gaia_position_in_the_other_band_of_2010():
    # the job measures the star in the 2010 image of band W2; this is the image of band W1 of the same tile, which
    # the job never reads
    n, card = numbers(), read(DATA / "targets" / "wise0855" / "card.json")
    cat = T.targets()["wise0855"]["catalogue"]
    aw = targets.tolerances()["movers"]["wise0855"]["allwise"]
    now = T.predict(cat, n["targets.wise0855.spherex.month"]["value"])
    mid = 0.5 * (aw["first_mjd"] + aw["last_mjd"])
    star = next(q for q in T.neighbours_of(*now, mid) if f"Gaia DR3 {q['source_id']}" == card["beside"]["source"])
    tile = next(t for t in targets.allwise_tiles(*T.predict(cat, targets.ALLWISE_MID_MJD)) if t["band"] == "W1" and t["tile"] == aw["tile"])
    img, ww = targets.allwise_cutout(tile["url"], star["ra"], star["dec"], 120)
    x, y = (float(v) for v in ww.all_world2pix(star["ra"], star["dec"], 0))
    g = T.fit_gauss(img, x, y, search=2.0, half=4, sigma0=targets.ALLWISE_FWHM / 2.355 / targets.ALLWISE_PIXEL)
    assert g is not None
    off = float(np.hypot(*T.offset_arcsec(star["ra"], star["dec"], *(float(v) for v in ww.all_pix2world(g["x"], g["y"], 0)))))
    assert off < 1.0 < targets.BESIDE_TOL_PX * T.PX_ARCSEC  # arcsec: a sixth of a SPHEREx pixel at most


@needs_network
def test_the_wings_of_barnards_star_give_its_catalogue_place_in_the_other_band_of_2010():
    # the job takes the centre of the wings in band W2; this is the image of band W1 of the same tile, which the job
    # never reads. The search is started 8 arcsec away from the catalogue place
    cat = T.targets()["barnard"]["catalogue"]
    aw = targets.tolerances()["movers"]["barnard"]["allwise"]
    tile = next(t for t in targets.allwise_tiles(*T.predict(cat, targets.ALLWISE_MID_MJD)) if t["band"] == "W1" and t["tile"] == aw["tile"])
    a, b = T.predict(cat, tile["t_min"]), T.predict(cat, tile["t_max"])
    ra, dec = 0.5 * (a[0] + b[0]), 0.5 * (a[1] + b[1])
    img, ww = targets.allwise_cutout(tile["url"], ra, dec, targets.WINGS_CUT_ARCSEC)
    x, y = (float(v) for v in ww.all_world2pix(ra, dec, 0))
    beam = targets.ALLWISE_FWHM / targets.ALLWISE_PIXEL
    c = T.wings_centre(img, x + 4.0, y - 4.0, targets.WINGS_BEAMS[0] * beam, targets.WINGS_BEAMS[1] * beam,
                       (targets.WINGS_SKY[0] * beam, targets.WINGS_SKY[1] * beam))
    assert c is not None
    off = float(np.hypot(*T.offset_arcsec(ra, dec, *(float(v) for v in ww.all_pix2world(c[0], c[1], 0)))))
    assert off < 1.5  # arcsec; the Gaussian on the spoiled core of band W2 is 6.4 arcsec off


@needs_network
def test_epsilon_indi_b_lies_where_gaia_puts_it_in_its_first_and_last_photo():
    # the brown dwarf in the first and the last photo of its showcase, each against Gaia at that date
    e = T.targets()["eps-indi-b"]
    m = manifest("targets/eps-indi-b")
    for f in (m["frames"][0], m["frames"][-1]):
        ff = T.frame(f["key"])
        st = cut(ff, e["ra"], e["dec"], size=64)
        ra, dec = T.predict(e["catalogue"], ff.mjd)
        got = T.star_in_frame(ff, st.data.astype(float), st.x0, st.y0, ra, dec)
        assert got is not None and math.hypot(got["dE"], got["dN"]) < 0.5 * T.PX_ARCSEC
    # between those two photos the catalogue moves it by most of a pixel
    a, b = T.predict(e["catalogue"], m["frames"][0]["mjd"]), T.predict(e["catalogue"], m["frames"][-1]["mjd"])
    assert 0.6 * T.PX_ARCSEC < float(np.hypot(*T.offset_arcsec(*a, *b))) < T.PX_ARCSEC
