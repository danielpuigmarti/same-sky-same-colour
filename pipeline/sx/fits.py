"""Reading one SPHEREx Level 2 frame by byte range.

Layout of a frame (checked on frames of all six detectors): the primary header, then IMAGE (2040 by 2040
big-endian float32, MJy/sr, uncompressed), FLAGS (tile-compressed, Rice, one row to a tile, a table of
8-byte row descriptors and then the heap), VARIANCE (uncompressed like IMAGE), more extensions, and WCS-WAVE
last. Both headers of the start fit in the first 28,800 bytes. A stamp is read as whole rows, as the page does.
"""
from __future__ import annotations

import struct
import warnings
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from astropy.io import fits

from . import s3
from .wcs import make_wcs

BLOCK = 2880
HEAD_BYTES = 28800
"""The first request of every frame: primary header and IMAGE header."""

FLAG_NAMES = {
    0: "TRANSIENT", 1: "OVERFLOW", 2: "SUR_ERROR", 6: "NONFUNC", 7: "DICHROIC", 9: "MISSING_DATA", 10: "HOT",
    11: "COLD", 12: "FULLSAMPLE", 14: "PHANMISS", 15: "NONLINEAR", 17: "PERSIST", 19: "OUTLIER", 20: "CROSSTALK",
    21: "SOURCE", 22: "GHOST", 23: "GHOST_FPA", 24: "GHOST_EXT", 25: "STREAK", 26: "BLOOM", 27: "SNOWBALL",
    28: "HALO",
}
"""Meaning of the bits of FLAGS, as the FLAGS header of a frame lists them (MSKN, MSKM, MSKD cards)."""

FLAG = {name: 1 << bit for bit, name in FLAG_NAMES.items()}
"""Bit mask by name."""


def flag_table(header: fits.Header) -> dict[int, tuple[str, str]]:
    """The mask planes a FLAGS header lists: {bit: (name, description)}."""
    out = {}
    for k in header:
        if k.startswith("MSKN"):
            n = k[4:]
            bit = int(n)
            assert header[f"MSKM{n}"] == 1 << bit
            out[bit] = (str(header[k]).strip(), str(header.get(f"MSKD{n}", "")).strip())
    return out


def _pad(n: int) -> int:
    return -(-n // BLOCK) * BLOCK


def parse_header(buf: bytes, start: int = 0) -> Optional[tuple[fits.Header, int]]:
    """The header that begins at `start` of buf, and its length in bytes (whole blocks), or None when the
    END card is not inside buf."""
    for i in range(start, len(buf) - 79, 80):
        if buf[i : i + 8] == b"END     ":
            n = (i - start) // 80 + 1
            hlen = -(-n // 36) * BLOCK
            if start + hlen > len(buf):
                return None
            return fits.Header.fromstring(buf[start : start + hlen].decode("ascii")), hlen
    return None


def data_length(h: fits.Header) -> int:
    """Bytes of the data of an HDU, without the padding."""
    nax = h.get("NAXIS", 0)
    if not nax:
        return 0
    n = 1
    for i in range(1, nax + 1):
        n *= h[f"NAXIS{i}"]
    return abs(h["BITPIX"]) // 8 * h.get("GCOUNT", 1) * (h.get("PCOUNT", 0) + n)


@dataclass
class Hdu:
    name: str
    header: fits.Header
    hoff: int  # file offset of the header
    doff: int  # file offset of the data
    dlen: int  # bytes of data without padding
    buf: bytes = b""  # what was read starting at hoff (header and perhaps data after it)

    @property
    def next(self) -> int:
        return self.doff + _pad(self.dlen)


def hdu_at(key: str, off: int, want: int = BLOCK * 6) -> Hdu:
    """The HDU whose header starts at `off`. `want` bytes are read first; more when the header is longer."""
    buf = s3.get_range(key, off, off + want - 1)
    p = parse_header(buf)
    while p is None:
        buf += s3.get_range(key, off + len(buf), off + len(buf) + BLOCK * 4 - 1)
        p = parse_header(buf)
    h, hlen = p
    return Hdu(h.get("EXTNAME", "PRIMARY"), h, off, off + hlen, data_length(h), buf)


@dataclass
class FrameFile:
    """The parts of one frame that are known after the first request, and the readers of its rows."""

    key: str
    primary: fits.Header
    image: Hdu
    start: bytes = field(repr=False, default=b"")
    _flags: Optional[Hdu] = field(default=None, repr=False)
    _variance: Optional[Hdu] = field(default=None, repr=False)
    _wcs: object = field(default=None, repr=False)

    @classmethod
    def open(cls, key: str) -> "FrameFile":
        buf = s3.get_range(key, 0, HEAD_BYTES - 1)
        p0 = parse_header(buf)
        if p0 is None:
            raise ValueError(f"{key}: no END card in the primary header")
        h0, l0 = p0
        off = l0 + _pad(data_length(h0))
        p1 = parse_header(buf, off)
        if p1 is None:
            img = hdu_at(key, off)
        else:
            h1, l1 = p1
            img = Hdu(h1.get("EXTNAME", "?"), h1, off, off + l1, data_length(h1), buf[off:])
        if img.name != "IMAGE" or img.header["BITPIX"] != -32:
            raise ValueError(f"{key}: the first extension is not a float32 IMAGE")
        return cls(key, h0, img, buf)

    @property
    def header(self) -> fits.Header:
        return self.image.header

    @property
    def nx(self) -> int:
        return self.header["NAXIS1"]

    @property
    def ny(self) -> int:
        return self.header["NAXIS2"]

    @property
    def det(self) -> int:
        return int(self.header["DETECTOR"])

    @property
    def mjd(self) -> float:
        """Mid-exposure time, MJD (UTC), from MJD-AVG."""
        return float(self.header["MJD-AVG"])

    @property
    def wcs(self):
        if self._wcs is None:
            self._wcs = make_wcs(self.header)
        return self._wcs

    # -- rows of the uncompressed extensions ---------------------------------------------------

    def _rows_f32(self, hdu: Hdu, y0: int, y1: int) -> np.ndarray:
        a, b = max(0, y0), min(self.ny, y1)
        if b <= a:
            return np.empty((0, self.nx), np.float32)
        raw = s3.get_range(self.key, hdu.doff + a * self.nx * 4, hdu.doff + b * self.nx * 4 - 1)
        return np.frombuffer(raw, ">f4").reshape(b - a, self.nx).astype(np.float32)

    def image_rows(self, y0: int, y1: int) -> np.ndarray:
        """Rows y0 to y1 (end excluded) of IMAGE, full width, MJy/sr. Rows outside the frame are left out."""
        return self._rows_f32(self.image, y0, y1)

    @property
    def flags_hdu(self) -> Hdu:
        if self._flags is None:
            h = hdu_at(self.key, self.image.next, BLOCK * 6 + 8 * self.ny)
            if h.name != "FLAGS" or not h.header.get("ZIMAGE"):
                raise ValueError(f"{self.key}: expected a compressed FLAGS after IMAGE, found {h.name}")
            self._flags = h
        return self._flags

    @property
    def variance_hdu(self) -> Hdu:
        if self._variance is None:
            f = self.flags_hdu
            h = hdu_at(self.key, f.next, BLOCK * 4)
            if h.name != "VARIANCE" or h.header["BITPIX"] != -32:
                raise ValueError(f"{self.key}: expected VARIANCE after FLAGS, found {h.name}")
            self._variance = h
        return self._variance

    def variance_rows(self, y0: int, y1: int) -> np.ndarray:
        """Rows of VARIANCE, (MJy/sr) squared, full width."""
        return self._rows_f32(self.variance_hdu, y0, y1)

    # -- FLAGS: Rice-compressed, one row to a tile ---------------------------------------------

    def _descriptors(self, y0: int, y1: int) -> list[tuple[int, int]]:
        f = self.flags_hdu
        h = f.header
        if h["ZCMPTYPE"] != "RICE_1" or h["ZTILE1"] != self.nx or h["ZTILE2"] != 1:
            raise ValueError(f"{self.key}: FLAGS layout not handled: {h['ZCMPTYPE']} {h['ZTILE1']}x{h['ZTILE2']}")
        tf = str(h["TFORM1"]).strip()
        width = 8 if tf[:2] == "1P" else 16 if tf[:2] == "1Q" else 0
        if not width or h["NAXIS1"] != width:
            raise ValueError(f"{self.key}: FLAGS descriptor {tf} not handled")
        a, b = f.doff + y0 * width, f.doff + y1 * width
        have_to = f.hoff + len(f.buf)
        raw = f.buf[a - f.hoff : b - f.hoff] if b <= have_to else s3.get_range(self.key, a, b - 1)
        fmt = ">ii" if width == 8 else ">qq"
        return [struct.unpack_from(fmt, raw, i * width) for i in range(y1 - y0)]

    def flag_rows(self, y0: int, y1: int) -> np.ndarray:
        """Rows y0 to y1 (end excluded) of FLAGS as int32, full width. Rows outside the frame are left out."""
        a, b = max(0, y0), min(self.ny, y1)
        if b <= a:
            return np.empty((0, self.nx), np.int32)
        f = self.flags_hdu
        desc = self._descriptors(a, b)
        if any(n == 0 for n, _ in desc):
            raise ValueError(f"{self.key}: a FLAGS row is stored without compression")
        heap = f.doff + f.header.get("THEAP", f.header["NAXIS1"] * f.header["NAXIS2"])
        lo = min(o for _, o in desc)
        hi = max(o + n for n, o in desc)
        raw = s3.get_range(self.key, heap + lo, heap + hi - 1)
        table, packed = bytearray(), bytearray()
        for n, o in desc:
            table += struct.pack(">ii", n, len(packed))
            packed += raw[o - lo : o - lo + n]
        h = f.header.copy()
        h["NAXIS2"] = b - a
        h["ZNAXIS2"] = b - a
        h["PCOUNT"] = len(packed)
        h["TFORM1"] = f"1PB({max(n for n, _ in desc)})"
        h.remove("THEAP", ignore_missing=True)
        body = bytes(table) + bytes(packed)
        body += b"\0" * (_pad(len(body)) - len(body))
        blob = fits.PrimaryHDU().header.tostring().encode("ascii") + h.tostring().encode("ascii") + body
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            hdul = fits.HDUList.fromstring(blob)
            out = np.asarray(hdul[1].data)
        return out.astype(np.int32).reshape(b - a, self.nx)

    # -- the wavelength table, last in the file ------------------------------------------------

    def wave_hdu(self) -> fits.BinTableHDU:
        """The WCS-WAVE table of the frame (identical in every frame of a detector)."""
        raw = s3.get_suffix(self.key, BLOCK * 2)
        if fits.Header.fromstring(raw[:BLOCK].decode("ascii")).get("EXTNAME") != "WCS-WAVE":
            raise ValueError(f"{self.key}: WCS-WAVE is not the last extension")
        blob = fits.PrimaryHDU().header.tostring().encode("ascii") + raw
        return fits.HDUList.fromstring(blob)[1]

    # -- a box of whole rows -------------------------------------------------------------------

    def box(self, x0: int, y0: int, w: int, h: int, flags: bool = True, variance: bool = False):
        """The w by h box whose first element is the pixel (x0, y0): (data, flags, variance). Parts outside
        the frame hold NaN (data, variance) and 0 (flags). `flags` and `variance` are None when not asked for."""
        data = _cut(self.image_rows(y0, y0 + h), self.nx, self.ny, x0, y0, w, h, np.float32, np.nan)
        fl = _cut(self.flag_rows(y0, y0 + h), self.nx, self.ny, x0, y0, w, h, np.int32, 0) if flags else None
        var = _cut(self.variance_rows(y0, y0 + h), self.nx, self.ny, x0, y0, w, h, np.float32, np.nan) if variance else None
        return data, fl, var


def _cut(rows: np.ndarray, nx: int, ny: int, x0: int, y0: int, w: int, h: int, dtype, fill) -> np.ndarray:
    """Place whole rows (the rows of the frame between y0 and y0 + h) into a w by h box."""
    out = np.full((h, w), fill, dtype)
    ya, yb = max(0, y0), min(ny, y0 + h)
    xa, xb = max(0, x0), min(nx, x0 + w)
    if yb > ya and xb > xa:
        out[ya - y0 : yb - y0, xa - x0 : xb - x0] = rows[:, xa:xb]
    return out
