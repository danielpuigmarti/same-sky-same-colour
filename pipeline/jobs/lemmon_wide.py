"""Job lemmon_wide: the wide field of comet C/2025 A6 (Lemmon) for the first screen.

    python -m sx.run lemmon_wide

The five frames of the first-screen showcase (site/data/lemmon/hero/manifest.json: 10 August 2025 at 4.273 µm, and
the four colours of 26 February 2026) are each placed on the display grid (sx.display: north up, east to the left,
6.15 arcsec a pixel, nearest pixel, nothing blended) with the comet's place at the pixel (size // 2, size // 2).
The place is the one JPL Horizons gives for the comet at the time of the 4.266 µm photo of 26 February, and it is
the same sky position for all five pictures, so the stars lie on the same pixels from picture to picture and
the comet moves by itself, a few pixels in the four minutes of the night.

The grey scale is the display rule of the first-screen panels (jobs/lemmon_draw.display_rule, over the five
64 by 64 stamps of the showcase): each photo has the sky level of its own 64 by 64 stamp taken off, black is 2
sky noises below the sky, white is the comet's peak, and the grey follows one asinh curve. A pixel that the archive
flags as unusable takes the median of its usable neighbours (jobs/lemmon.Cut.shown); the manifest counts them.

The pictures are 512 by 512 (52 arcmin) when every frame covers that square once turned north up, else the
largest of 384 and 256 that all five cover.

Registration is checked with stars: the Gaia DR3 stars of the field, moved to the date of each frame, are measured
(sx.gaia.centroid) in the August picture and in the 4.266 µm picture; their positions in the two must agree.

Writes: site/data/lemmon/wide/ (five PNG files of 8-bit grey and manifest.json) and review/r5-wide.png. Needs the
network the first time; byte ranges and answers are cached afterwards.
"""
from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

from sx import checks, display, gaia, horizons
from sx.display import PIXEL_ARCSEC, PIXEL_DEG, tangent_offset
from sx.fits import FrameFile
from sx.stamp import StampVar

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "data" / "lemmon" / "wide"
REVIEW = ROOT / "review"
HERO = ROOT / "site" / "data" / "lemmon" / "hero" / "manifest.json"

COMET = "DES=C/2025 A6;CAP;NOFRAG"
SIZES = (512, 384, 256)
"""The sizes tried, largest first."""
READ = 751
"""Side of the square of a frame that is read round the comet: a 512 square turned by any angle fits in it."""
HALF = 380
"""Rows read on either side of the comet's row."""
COLOUR = 4.266
"""The colour of carbon dioxide, µm: the frame of the hero that is nearest it sets the place."""

STAR_G = (8.0, 14.0)
"""Gaia G magnitudes of the stars used for the registration."""
STAR_SNR = 20.0
STAR_CONE = 0.45
"""Radius of the Gaia cone, degrees: a little more than the half side of the largest picture (26.2 arcmin)."""
STAR_REACH = 2.0
"""A star is found only when its centroid lies within this many pixels of where the catalogue puts it: a fit that
wandered to a neighbour is not a measurement of the star."""
COMET_CLEAR = 10.0
"""Stars closer than this to the comet, pixels, are not used."""
SAME_PIXEL = 1.0
MIN_STARS = 20
COMET_REACH = 2.0
"""The comet's brightest pixel in the 4.266 µm picture must lie within this many pixels of the centre."""
SEARCH = 5.0
"""Where that brightest pixel is looked for: pixels round the centre."""

SOURCES = [
    "SPHEREx Data Release 1, Level 2 spectral images, NASA/IPAC Infrared Science Archive",
    "JPL Horizons: positions of C/2025 A6 (Lemmon) as seen from SPHEREx",
    "Gaia Data Release 3, through the MAST cone search",
]


def main(argv: list[str]) -> int:
    if argv:
        print(__doc__)
        return 0
    run()
    return 0


# -- pure functions ---------------------------------------------------------------------------------


def grid_pixel(ra0: float, dec0: float, ra: float, dec: float, size: int) -> tuple[float, float]:
    """Where a sky position falls on the display grid of `size` pixels centred on (ra0, dec0): (x, y), 0-based,
    whole numbers at pixel centres, first row at the lowest y (the inverse of sx.display.source_pixels)."""
    east, north = tangent_offset(ra0, dec0, ra, dec)
    c = size // 2
    return c - east / PIXEL_DEG, c + north / PIXEL_DEG


def covered_size(valid: np.ndarray, sizes: Sequence[int] = SIZES) -> Optional[int]:
    """The largest of `sizes` for which the middle size by size pixels of `valid` (a square of the largest size,
    True where every frame holds data) are all True; None when none is."""
    n = valid.shape[0]
    for s in sizes:
        a = (n - s) // 2
        if s <= n and valid[a : a + s, a : a + s].all():
            return int(s)
    return None


def crop_middle(a: np.ndarray, size: int) -> np.ndarray:
    """The middle size by size pixels of a square array whose side is even like `size`."""
    k = (a.shape[0] - size) // 2
    return a[k : k + size, k : k + size]


def grey8(v: np.ndarray, rule: dict) -> np.ndarray:
    """8-bit grey (0 black, 255 white) of values in MJy/sr above the sky by the display rule of the hero;
    values that are not finite give 0."""
    from jobs import lemmon_draw as draw

    g = draw.grey(v, rule)
    return (np.where(np.isfinite(g), g, 0.0) * 255.0 + 0.5).astype(np.uint8)


def grey_png(a: np.ndarray) -> bytes:
    """A PNG file of an (h, w) uint8 array, 8-bit grey, first row of the array at the top of the picture. The same
    bytes every time. Each row takes the filter (none, sub or up) that leaves the smallest numbers."""
    h, w = a.shape
    a = np.ascontiguousarray(a, np.uint8)
    prev = np.zeros(w, np.uint8)
    rows = []
    for y in range(h):
        row = a[y]
        cand = [(0, row), (1, np.diff(row, prepend=np.uint8(0)).astype(np.uint8)), (2, (row - prev).astype(np.uint8))]
        f, body = min(cand, key=lambda c: int(np.abs(c[1].astype(np.int16).astype(np.int8).astype(np.int32)).sum()))
        rows.append(bytes([f]) + body.tobytes())
        prev = row

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def read_grey_png(data: bytes) -> np.ndarray:
    """The (h, w) uint8 array of a PNG as grey_png writes it (8-bit grey, filters none, sub and up)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        n, tag = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + n]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    out = np.zeros((h, w), np.uint8)
    for y in range(h):
        f, row = raw[y * (w + 1)], np.frombuffer(raw[y * (w + 1) + 1 : (y + 1) * (w + 1)], np.uint8)
        if f == 1:
            row = np.cumsum(row.astype(np.uint32)).astype(np.uint8)
        elif f == 2:
            row = (row + (out[y - 1] if y else 0)).astype(np.uint8)
        out[y] = row
    return out


def offsets(a: dict[str, tuple[float, float]], b: dict[str, tuple[float, float]]) -> dict[str, float]:
    """Distance in pixels between the two positions of each star that is in both sets."""
    return {k: math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]) for k in a if k in b}


def registration(off: dict[str, float], limit: float = SAME_PIXEL) -> dict:
    """{n, within, median, worst}: how many stars were found in both pictures, how many of them lie within
    `limit` pixels, and the median and the largest offset, pixels."""
    v = np.array(sorted(off.values()), float)
    if not v.size:
        return {"n": 0, "within": 0, "median": None, "worst": None}
    return {"n": int(v.size), "within": int((v <= limit).sum()), "median": float(np.median(v)), "worst": float(v.max())}


def brightest_near(img: np.ndarray, c: float, radius: float) -> tuple[float, float, float]:
    """(x, y, distance from the pixel (c, c)) of the brightest finite pixel within `radius` pixels of (c, c)."""
    h, w = img.shape
    yy, xx = np.mgrid[:h, :w]
    r = np.hypot(xx - c, yy - c)
    v = np.where((r <= radius) & np.isfinite(img), img, -np.inf)
    j, i = np.unravel_index(int(np.argmax(v)), v.shape)
    return float(i), float(j), float(r[j, i])


def fill_unusable(data: np.ndarray, bad: np.ndarray, passes: int = 12) -> np.ndarray:
    """`data` with every pixel of `bad` (a boolean array) taken from the median of the usable pixels among its 8
    neighbours; a pixel that has none yet takes the median of those that were filled before, round by round,
    up to `passes` rounds. Pixels not in `bad` are never changed (NaN stays NaN there)."""
    import warnings

    out = np.where(bad, np.nan, data).astype(np.float32)
    todo = bad.copy()
    h, w = out.shape
    for _ in range(passes):
        if not todo.any():
            break
        pad = np.pad(out, 1, constant_values=np.nan)
        near = np.stack([pad[1 + dy : 1 + dy + h, 1 + dx : 1 + dx + w] for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                         if (dx, dy) != (0, 0)])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            fill = np.nanmedian(near, axis=0)
        got = todo & np.isfinite(fill)
        out[got] = fill[got]
        todo &= ~got
    return out


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# -- reading and placing a frame --------------------------------------------------------------------


def hero_frames() -> list[dict]:
    """The frames of the first-screen showcase: key, mjd, lam, bw, x0, y0, in time order."""
    m = json.loads(HERO.read_text(encoding="utf-8"))
    return [{k: f[k] for k in ("key", "mjd", "lam", "bw", "x0", "y0")} for f in m["frames"]]


def place_on_grid(cut, ra: float, dec: float, size: int = SIZES[0]) -> tuple[np.ndarray, np.ndarray, int, StampVar]:
    """A frame (a jobs.lemmon.Cut) on the display grid centred on (ra, dec): (values as the pictures show them, in
    MJy/sr; a True where the source pixel is flagged unusable; the number of those; the stamp that was used).
    An unusable pixel carries the median of its usable neighbours (as Cut.shown does; where it has none,
    the median of the neighbours filled before: fill_unusable); pixels outside the frame are NaN."""
    x, y = cut.pixel(ra, dec)
    x0, y0 = int(math.floor(x + 0.5)) - READ // 2, int(math.floor(y + 0.5)) - READ // 2
    from sx import wave

    wb = wave.wavelength_at(cut.det, x, y)
    badwin = cut.window(cut.unusable, x0, y0, READ, READ, False)
    st = StampVar(key=cut.key, det=cut.det, mjd=cut.mjd, w=READ, h=READ, x0=x0, y0=y0, tx=x - x0, ty=y - y0,
                  lam=wb["lam"], bw=wb["bw"], data=fill_unusable(cut.window(cut.data, x0, y0, READ, READ, np.nan), badwin),
                  flags=cut.window(cut.flags, x0, y0, READ, READ, 0), sky=display.local_sky(cut.wcs, x, y))
    g = display.to_display_grid(st, size)
    bad = badwin
    inside = g.sx >= 0
    unusable = np.zeros((size, size), bool)
    unusable[inside] = bad[g.sy[inside], g.sx[inside]]
    return g.data, unusable, int(unusable.sum()), st


# -- the stars --------------------------------------------------------------------------------------


def field_stars(ra0: float, dec0: float) -> list[dict]:
    found = gaia.cone(round(ra0, 6), round(dec0, 6), STAR_CONE)
    return [s for s in found if s["phot_g_mean_mag"] is not None and STAR_G[0] <= s["phot_g_mean_mag"] <= STAR_G[1]
            and s["ra"] is not None and s["dec"] is not None]


def measure_stars(img: np.ndarray, stars: list[dict], mjd: float, ra0: float, dec0: float, size: int) -> dict[str, tuple]:
    """The centroid (x, y), and the Gaia position on the grid, of each star that is found in `img` (sky taken off,
    MJy/sr, the size by size grid): {source_id: (x, y, gx, gy)}."""
    ra, dec = gaia.propagate(stars, mjd)
    c = size // 2
    out = {}
    for s, a, d in zip(stars, ra, dec):
        gx, gy = grid_pixel(ra0, dec0, float(a), float(d), size)
        if math.hypot(gx - c, gy - c) < COMET_CLEAR or not (6 <= gx < size - 6 and 6 <= gy < size - 6):
            continue
        got = gaia.centroid(img, gx, gy)
        if got is not None and got[2] >= STAR_SNR and math.hypot(got[0] - gx, got[1] - gy) <= STAR_REACH:
            out[s["source_id"]] = (got[0], got[1], gx, gy)
    return out


# -- the job ----------------------------------------------------------------------------------------


def run() -> dict:
    from jobs import lemmon, lemmon_draw as draw

    frames = hero_frames()
    i_on = min(range(len(frames)), key=lambda i: abs(frames[i]["lam"] - COLOUR))
    eph = horizons.positions(COMET, [f["mjd"] for f in frames])
    ra0, dec0 = float(eph.ra[i_on]), float(eph.dec[i_on])
    print(f"centre {ra0:.6f} {dec0:.6f} from the photo at {frames[i_on]['lam']:.3f} um")

    hero = json.loads(HERO.read_text(encoding="utf-8"))
    cuts, small = [], []
    for f in frames:
        cut = lemmon.read_cut(f["key"], ra0, dec0, half=HALF, variance=False)
        if cut is None:
            raise SystemExit(f"{f['key']} does not hold the centre")
        cuts.append(cut)
        st = cut.stamp(ra0, dec0)
        if (st.x0, st.y0) != (f["x0"], f["y0"]):
            raise SystemExit(f"the showcase stamp of {f['key']} starts at {(f['x0'], f['y0'])}, here {(st.x0, st.y0)}")
        small.append(st)
    rule = draw.display_rule([(s.data, s.flags, s.tx, s.ty) for s in small])
    skies = [draw.sky_of(s.data, s.flags)[0] for s in small]
    print("rule", {k: round(v, 4) for k, v in rule.items()})

    big = SIZES[0]
    grids = [place_on_grid(c, ra0, dec0, big) for c in cuts]
    valid = np.all([np.isfinite(g[0]) for g in grids], axis=0)
    size = covered_size(valid)
    if size is None:
        raise SystemExit("not even 256 by 256 pixels are covered by all five frames")
    print(f"size {size}; pixels without data in the 512 square: {[int((~np.isfinite(g[0])).sum()) for g in grids]}")

    images = [crop_middle(g[0] - sk, size) for g, sk in zip(grids, skies)]
    unusable = [crop_middle(g[1], size) for g in grids]
    filled = [int(u.sum()) for u in unusable]
    pngs = [grey_png(np.flipud(grey8(im, rule))) for im in images]

    # the comet's place in the pictures
    c = size // 2
    place = []
    for i, f in enumerate(frames):
        if i == 0:
            place.append(None)
        else:
            x, y = grid_pixel(ra0, dec0, float(eph.ra[i]), float(eph.dec[i]), size)
            place.append([round(x, 2), round(y, 2)])

    # checks
    stars = field_stars(ra0, dec0)
    print(f"{len(stars)} Gaia stars with G {STAR_G[0]:g} to {STAR_G[1]:g} in the cone")
    ms = [measure_stars(images[i], stars, frames[i]["mjd"], ra0, dec0, size) for i in (0, i_on)]
    off = offsets({k: v[:2] for k, v in ms[0].items()}, {k: v[:2] for k, v in ms[1].items()})
    reg = registration(off)
    own = [registration(offsets({k: v[:2] for k, v in m.items()}, {k: v[2:] for k, v in m.items()})) for m in ms]
    bx, by, bd = brightest_near(images[i_on], c, SEARCH)
    white = float(draw.grey(np.array([images[i_on][int(by), int(bx)]]), rule)[0])
    peaks = []
    for i in range(1, len(frames)):
        x, y, d = brightest_near(images[i], c, 12.0)
        peaks.append({"frame": i, "pixel": [x, y], "grey": int(grey8(images[i][int(y), int(x)], rule))})
    print("registration", reg, "against Gaia (August, 4.266):", own)
    print(f"brightest pixel of the 4.266 um picture {bd:.2f} px from the centre, grey {white:.4f}")

    # write
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    pics = []
    for i, (f, png) in enumerate(zip(frames, pngs)):
        name = f"wide-{i}.png"
        (OUT / name).write_bytes(png)
        pics.append({"file": name, "sha256": sha256(png), "key": f["key"], "mjd": f["mjd"], "lam_um": f["lam"],
                     "bw_um": f["bw"], "comet_px": place[i], "filled": filled[i]})
    manifest = {
        "id": "lemmon-wide", "name": hero["name"], "centre": {"ra": ra0, "dec": dec0}, "size": size,
        "pixel_arcsec": PIXEL_ARCSEC, "field_arcmin": size * PIXEL_ARCSEC / 60.0, "grid": "north-up",
        "centre_pixel": [c, c], "centre_from": f"JPL Horizons, the comet at the time of the photo {pics[i_on]['key']}",
        "rule": {"unit": "MJy/sr above the sky of each photo", "curve": "asinh",
                 "black": rule["black"], "white": rule["white"], "soften": rule["soften"], "noise": rule["noise"],
                 "black_noise": draw.BLACK_NOISE, "soften_noise": draw.SOFTEN_NOISE,
                 "sky": [round(s, 6) for s in skies],
                 "grey": "255 * (asinh(v / soften) - asinh(black / soften)) / (asinh(white / soften) - asinh(black / soften)), "
                         "limited to 0..255; the same for the five pictures"},
        "pictures": pics, "refs": SOURCES,
        "registration": {**reg, "limit_px": SAME_PIXEL, "against_gaia": {"august": own[0], "feb_4266": own[1]}},
    }
    checks.write_json(OUT / "manifest.json", manifest)

    sheet(REVIEW / "r5-wide.png", images, frames, pics, rule, place)
    total = sum(len(p) for p in pngs)
    print(f"wrote {len(pngs)} pictures, {total} bytes; filled {filled}")
    return {"manifest": manifest, "reg": reg, "own": own, "brightest": (bx, by, bd, white), "peaks": peaks,
            "total": total, "size": size, "i_on": i_on}


def sheet(path: Path, images: list[np.ndarray], frames: list[dict], pics: list[dict], rule: dict, place: list) -> None:
    """The review sheet: the five pictures side by side, with the date and the colour under each."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from jobs import lemmon_draw as draw
    from jobs.lemmon import day_text, time_text

    n, side, gap, foot = len(images), images[0].shape[0], 12, 70
    width, height = n * side + (n + 1) * gap, side + foot + gap
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100, facecolor="white")
    for i, (im, f) in enumerate(zip(images, frames)):
        x = gap + i * (side + gap)
        ax = fig.add_axes([x / width, foot / height, side / width, side / height])
        ax.imshow(grey8(im, rule), cmap="gray", vmin=0, vmax=255, origin="lower", interpolation="nearest")
        ax.set_axis_off()
        fig.text((x + side / 2) / width, (foot - 8) / height, f"{day_text(f['mjd'])}, {time_text(f['mjd'])}\n{f['lam']:.3f} µm",
                 ha="center", va="top", fontsize=11, color="#1b1f23", linespacing=1.4)
    draw.save(fig, path)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
