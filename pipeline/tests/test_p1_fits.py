"""fits.py and stamp.py on the recorded bytes of the three frame fixtures (no network), and on the network for
VARIANCE, which the fixtures do not hold."""
import numpy as np
import pytest

from sx import fits as F
from sx import s3
from sx.stamp import cut
from test_p1_support import FRAME_IDS, load_frame, needs_network, recorded_source


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_stamp_equals_the_fixture_bit_for_bit(id_):
    meta, _, data, flags = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = F.FrameFile.open(meta["key"])
        t = meta["target"]
        st = cut(ff, t["ra"], t["dec"], size=64)
    want = meta["stamp"]
    assert (st.det, st.w, st.h, st.x0, st.y0) == (want["det"], 64, 64, want["x0"], want["y0"])
    assert st.mjd == pytest.approx(want["mjd"], abs=1e-9)
    assert st.tx == pytest.approx(want["tx"], abs=1e-6) and st.ty == pytest.approx(want["ty"], abs=1e-6)
    assert st.lam == pytest.approx(want["lam"], abs=1e-6) and st.bw == pytest.approx(want["bw"], abs=1e-6)
    assert st.data.dtype == np.float32 and st.flags.dtype == np.int32
    assert st.data.tobytes() == data.tobytes()  # NaN included
    assert np.array_equal(st.flags, flags)


@pytest.mark.parametrize("id_", FRAME_IDS)
def test_layout_is_found_from_the_headers(id_):
    meta, _, _, _ = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = F.FrameFile.open(meta["key"])
        hdus = {h["name"]: h for h in meta["hdus"]}
        assert ff.image.hoff == hdus["IMAGE"]["hdrLoc"] and ff.image.doff == hdus["IMAGE"]["datLoc"]
        assert ff.flags_hdu.hoff == hdus["FLAGS"]["hdrLoc"] and ff.flags_hdu.doff == hdus["FLAGS"]["datLoc"]
        assert ff.flags_hdu.doff + ff.flags_hdu.header["NAXIS1"] * ff.flags_hdu.header["NAXIS2"] == meta["flags_layout"]["heap"]
        assert (ff.nx, ff.ny, ff.det) == (2040, 2040, meta["stamp"]["det"])


def test_a_box_that_crosses_the_edge_is_padded():
    id_ = "barnard-d2"
    meta, _, data, flags = load_frame(id_)
    with s3.use(recorded_source(id_)):
        ff = F.FrameFile.open(meta["key"])
        # shift the box 40 columns beyond the left edge of the frame: rows are the recorded ones
        x0 = -40
        y0 = meta["stamp"]["y0"]
        d, f, _ = ff.box(x0, y0, 64, 64, flags=True)
    assert np.all(np.isnan(d[:, :40])) and np.all(f[:, :40] == 0)
    assert d[:, 40:].shape == (64, 24)
    assert not np.all(np.isnan(d[:, 40:]))


def test_rows_outside_the_frame_are_left_out():
    meta, _, _, _ = load_frame("barnard-d2")
    with s3.use(recorded_source("barnard-d2")):
        ff = F.FrameFile.open(meta["key"])
        assert ff.image_rows(-5, 0).shape == (0, 2040)
        assert ff.flag_rows(2040, 2050).shape == (0, 2040)


def test_flag_names_are_those_of_the_frame_header():
    meta, ranges, _, _ = load_frame("eps-indi-d5")
    with s3.use(recorded_source("eps-indi-d5")):
        ff = F.FrameFile.open(meta["key"])
        table = F.flag_table(ff.flags_hdu.header)
    assert {b: n for b, (n, _) in table.items()} == F.FLAG_NAMES
    assert F.FLAG["SOURCE"] == 1 << 21 and F.FLAG["FULLSAMPLE"] == 1 << 12


def test_parse_header_needs_the_end_card():
    blob = b"SIMPLE  =                    T".ljust(80) + b"END".ljust(80)
    assert F.parse_header(blob.ljust(2880)) is not None
    assert F.parse_header(b"SIMPLE  =                    T".ljust(2880)) is None


@needs_network
def test_variance_rows_on_the_network():
    """VARIANCE is uncompressed like IMAGE: the rows are float32, non-negative where finite, and the stamp
    carries them."""
    meta, _, _, _ = load_frame("barnard-d2")
    ff = F.FrameFile.open(meta["key"])
    assert ff.variance_hdu.name == "VARIANCE"
    t = meta["target"]
    st = cut(ff, t["ra"], t["dec"], size=32, flags=True, variance=True)
    assert st.variance.shape == (32, 32) and st.variance.dtype == np.float32
    v = st.variance[np.isfinite(st.variance)]
    assert v.size > 900 and (v >= 0).all()
    assert np.array_equal(np.isfinite(st.variance), np.isfinite(st.data))


@needs_network
def test_wave_hdu_is_the_last_extension():
    meta, _, _, _ = load_frame("eps-indi-d4")
    ff = F.FrameFile.open(meta["key"])
    t = ff.wave_hdu()
    assert t.name == "WCS-WAVE" and t.data["VALUES"][0].shape[-1] == 2
