"""Pictures and showcases.

Stamps become PNG pictures with one stated stretch (asinh_png), and a set of stamps becomes a CT-8 showcase
(write_showcase): manifest.json with stamps.bin and flags.bin beside it, checked against the contract before
the function returns.
"""
from __future__ import annotations

import json
import math
import struct
import zlib
from dataclasses import replace
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

from . import contracts as C
from . import display
from .fits import FrameFile

SOFTENING = 10.0
"""The stretch: u = clip((x - black) / (white - black), 0, 1); grey = asinh(SOFTENING * u) / asinh(SOFTENING).
Black and white are given by the caller and written next to the picture; the same two values are used for
every picture that is to be compared."""

NAN_RGB = (46, 38, 80)
"""Missing values are drawn in this dark violet, never in a grey that the sky could take."""


def stretch(data: np.ndarray, black: float, white: float) -> np.ndarray:
    """The asinh stretch of the module, 0 to 1; NaN stays NaN."""
    u = np.clip((data - black) / (white - black), 0.0, 1.0)
    return np.arcsinh(SOFTENING * u) / math.asinh(SOFTENING)


def to_rgb(data: np.ndarray, black: float, white: float, flip: bool = True) -> np.ndarray:
    """(h, w, 3) uint8 of a stamp. `flip` draws the first row (lowest y) at the bottom, as the sky is seen."""
    g = stretch(data, black, white)
    v = np.where(np.isnan(g), 0.0, g)
    rgb = np.repeat((v * 255 + 0.5).astype(np.uint8)[..., None], 3, axis=2)
    rgb[np.isnan(g)] = NAN_RGB
    return rgb[::-1] if flip else rgb


def png_bytes(rgb: np.ndarray) -> bytes:
    """A PNG file of an (h, w, 3) uint8 array. Written here, byte for byte the same every time."""
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def asinh_png(path: Path, data: np.ndarray, black: float, white: float, scale: int = 1) -> Path:
    """Write one stamp as a PNG with the module's stretch; `scale` repeats each pixel scale times each way."""
    rgb = to_rgb(data, black, white)
    if scale > 1:
        rgb = np.repeat(np.repeat(rgb, scale, axis=0), scale, axis=1)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(rgb))
    return path


def strip_png(path: Path, stamps: Sequence[np.ndarray], black: float, white: float, scale: int = 4, gap: int = 4) -> Path:
    """Stamps side by side in one PNG, one stretch for all of them."""
    tiles = [np.repeat(np.repeat(to_rgb(s, black, white), scale, axis=0), scale, axis=1) for s in stamps]
    h = max(t.shape[0] for t in tiles)
    sep = np.full((h, gap, 3), 255, np.uint8)
    parts = []
    for i, t in enumerate(tiles):
        if i:
            parts.append(sep)
        parts.append(np.pad(t, ((0, h - t.shape[0]), (0, 0), (0, 0)), constant_values=255))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png_bytes(np.concatenate(parts, axis=1)))
    return path


def _sky_of(stamp):
    """The sky of a stamp: the one it carries, or the one the header of its frame gives at its target pixel."""
    if stamp.sky is not None:
        return stamp.sky
    sky = display.local_sky(FrameFile.open(stamp.key).wcs, stamp.x0 + stamp.tx, stamp.y0 + stamp.ty)
    if sky is None:
        raise ValueError(f"no sky position at the target of {stamp.key}")
    return sky


def write_showcase(folder: Path, id: str, name: str, ra: float, dec: float, stamps: Sequence, visits: Sequence[int],
                   pairs: Sequence[tuple[int, int]], refs: Sequence[str] = (), numbers: Sequence[str] = (),
                   with_flags: bool = True, preview: Optional[tuple[float, float]] = None,
                   display_grid: bool = True) -> dict:
    """Write a showcase folder (CT-8) and return its manifest.

    `stamps` are Stamp objects of one detector and one size, in time order (sorted here if not); `visits[i]` is
    the visit number of stamps[i] counted from 0; `pairs` are positions into `stamps`, the earlier visit first.
    `folder` must be named `id`. When `preview` = (black, white) is given, `pair.png` is written beside the
    files: the first pair side by side, the picture shown when scripts are off. Raises ValueError if the result
    does not satisfy the contract.

    With `display_grid` (the default) the stamps are written on the display grid (sx.display): north up, east to
    the left, 6.15 arcsec per pixel, centred on each frame's target, nearest neighbour, the same size as the
    stamps given; each frame carries `sky` and `tx = ty = w // 2`, and the manifest says `grid: "north-up"`. A stamp
    without `sky` takes it from the header of its frame (the target pixel is x0 + tx, y0 + ty). `x0` and `y0`
    stay those of the stamp as cut. Without it the stamps are written as given, in detector orientation."""
    folder = Path(folder)
    if folder.name != id:
        raise ValueError(f"the folder is named {folder.name}, the showcase {id}")
    order = sorted(range(len(stamps)), key=lambda i: stamps[i].mjd)
    new_of = {old: new for new, old in enumerate(order)}
    st = [stamps[i] for i in order]
    vis = [int(visits[i]) for i in order]
    if len({(s.det, s.w, s.h) for s in st}) != 1:
        raise ValueError("a showcase holds one detector and one stamp size")
    if with_flags and any(s.flags is None for s in st):
        raise ValueError("flags were asked for but a stamp has none")
    skies: list = [None] * len(st)
    if display_grid:
        if st[0].w != st[0].h:
            raise ValueError("the display grid needs square stamps")
        skies = [_sky_of(s) for s in st]
        grids = [display.to_display_grid(replace(s, sky=k), s.w) for s, k in zip(st, skies)]
        st = [replace(s, data=g.data, flags=g.flags, tx=float(s.w // 2), ty=float(s.h // 2), sky=display.grid_sky(k))
              for s, g, k in zip(st, grids, skies)]
    manifest = {
        "id": id, "name": name, "ra": ra, "dec": dec, "det": st[0].det, "w": st[0].w, "h": st[0].h,
        "frames": [{"key": s.key, "mjd": s.mjd, "lam": s.lam, "bw": s.bw, "x0": s.x0, "y0": s.y0,
                    "tx": s.tx, "ty": s.ty, "visit": v, **({"sky": s.sky} if display_grid else {})}
                   for s, v in zip(st, vis)],
        "pairs": [[new_of[a], new_of[b]] for a, b in pairs],
        "stamps": C.STAMPS_FILE, "flags": C.FLAGS_FILE if with_flags else None,
        "refs": list(refs), "numbers": list(numbers), **({"grid": "north-up"} if display_grid else {}),
    }
    folder.mkdir(parents=True, exist_ok=True)
    (folder / C.STAMPS_FILE).write_bytes(b"".join(np.ascontiguousarray(s.data, "<f4").tobytes() for s in st))
    if with_flags:
        (folder / C.FLAGS_FILE).write_bytes(b"".join(np.ascontiguousarray(s.flags, "<i4").tobytes() for s in st))
    elif (folder / C.FLAGS_FILE).exists():
        (folder / C.FLAGS_FILE).unlink()
    (folder / C.MANIFEST_FILE).write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    problems = C.check_showcase(folder)
    if problems:
        raise ValueError("the showcase breaks the contract: " + "; ".join(problems))
    if preview is not None and manifest["pairs"]:
        a, b = manifest["pairs"][0]
        strip_png(folder / "pair.png", [st[a].data, st[b].data], *preview)
    return manifest
