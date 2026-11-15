"""Job lemmon: comet C/2025 A6 (Lemmon) on 25 and 26 February 2026, in detector 5 (Checks rows K2 and K3, review
sheets H1 and H2).

    python -m sx.run lemmon [--reviewed "<role>" <YYYY-MM-DD>]

SPHEREx photographed the comet 16 times with detector 5 on those two nights, each time at another colour between
3.8 and 4.4 µm, because the comet fell on another part of the detector. Carbon-dioxide gas shines between about
4.20 and 4.32 µm. The job measures the comet in every photo with one aperture (2 pixels, 12.3 arcsec, in radius)
at the position JPL Horizons gives for the comet as seen from SPHEREx, and from those fluxes makes everything the
site shows about the comet:

  - the contrast: the brightest photo inside the band over the mean of the two photos nearest the band on either
    side, for each night, with its error, with every photo left out in turn, with a second background ring, a
    second aperture and the aperture moved by a fraction of a pixel;
  - the templates: for each photo inside the band, the photo of the same patch of sky taken in August 2025 at the
    same colour (chosen by the match rule of the site), where the comet was not;
  - the showcases hero/, strip/ and templates/ (CT-8) with their pictures, the track of the comet, and the
    brightness against wavelength as data;
  - for each photo, the stars of the Gaia catalogue that lie in or beside the aperture.

Every flux is a lower limit: the comet's glow still reaches the background ring, so the ring takes away some of
the comet with the sky.

The positions are asked from JPL Horizons for the middle of each exposure. Earlier measurements of the same
photos interpolated them in a table of 20-minute steps; the two differ by up to 0.56 arcsec, and because the
aperture is whole pixels, two of the fluxes differ by several mJy from those measurements (see REFERENCE).

Data for the comet page, beside the showcases:
  - spectrum.json: `photos` (one per photo of the two nights: key, mjd, night, lam, bw, inside, flux and err in mJy
    or null, the flux with the second ring and with the wider aperture, the stars beside it), `templates` (one per
    photo inside the band), `contrast` per night with the three photos it uses, the same with the second ring,
    the wider aperture and the apertures moved, and `leave_one_out` (one entry per photo left out);
  - track.json: `path` (the comet every 30 minutes: mjd, ra, dec, and east and north in arcmin from the middle of
    the path), `photos` (where each photo lies on it), `places` (the two brightest positions inside the band, each
    with `pair`: the positions of its August and February stamps in templates/manifest.json), `separation_arcmin`
    and `hours`.

Writes: site/data/lemmon/ (hero/ with hero.png, strip/ with strip.png, templates/ with templates.png, track.json,
track.png, spectrum.json), site/data/numbers/p2.json, site/data/checks/rows/p2.json,
site/data/checks/img/k2-contrast.png and k3-templates.png, review/h1.md, h1.png, h2.md, h2.png, and the frozen
list. The pictures are drawn by jobs/lemmon_draw.py. Needs the network the first time; byte ranges and answers
are cached afterwards. Without --reviewed the rows K2 and K3 stay UNVERIFIED.
"""
from __future__ import annotations

import math
import sys
import warnings
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

from sx import checks, frozen, horizons, irsa, match, numbers, phot, render, s3, stack, visits, wave
from sx.contracts import KEY_REGEX
from sx.fits import FrameFile
from sx.stamp import StampVar
from sx.wcs import corners, on_frame, pixel_area_sr, pixel_to_sky, sky_to_pixel

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "site" / "data" / "lemmon"
REVIEW = ROOT / "review"
IMG = checks.IMG_DIR

JOB = "lemmon"
PRODUCER = "p2"
COMET = "DES=C/2025 A6;CAP;NOFRAG"
"""The comet for JPL Horizons: the designation, the apparition nearest the date, the nucleus and not a fragment."""
NAME = "Comet C/2025 A6 (Lemmon)"
DET = 5
NIGHTS = {"feb25": 61096, "feb26": 61097}
"""The two nights, by the MJD of 0 h UTC of the day."""
NIGHT_TEXT = {"feb25": "25 February 2026", "feb26": "26 February 2026"}

BAND = (4.20, 4.32)
"""Where carbon dioxide shines in these photos, µm: the band of its asymmetric stretch near 4.26 µm as the 0.04 µm
wide colour steps of detector 5 see it. A photo is "inside the band" when the wavelength at the comet lies in it."""
STRIP = (4.0, 4.45)
"""The colour strips on the comet page show the photos between these wavelengths, µm."""

R_AP = 2
"""Radius of the aperture, pixels (12.3 arcsec)."""
R_WIDE = 5
"""A second, wider aperture: only to show that the result does not rest on the first."""
RINGS = {"ring40": (40.0, 55.0), "ring15": (15.0, 25.0)}
"""Background rings, pixels. Everything the site quotes uses HEADLINE; SECOND is the check."""
HEADLINE, SECOND = "ring40", "ring15"
BEYOND = (55.0, 70.0)
"""A ring just outside the outer background ring. The sky level there, against the level in the rings, shows
whether the comet's glow still reaches the rings."""
MIN_QUIET_RING = 50
"""SOURCE-flagged pixels are left out of a ring when at least this many other pixels remain. In this field, close
to the plane of the Milky Way, the SOURCE flag covers every pixel, so the rings use all usable pixels."""

EMPTY_OFFSETS = [28.0 + 11.0 * k for k in range(10)]
"""Empty apertures are placed this many pixels to either side of the comet, each at the pixel of that column
where the colour equals the comet's. The scatter of their fluxes says how much the stars of the field add."""
JITTER = 0.2
"""The aperture is whole pixels, so a flux jumps when the centre crosses a pixel edge. The contrast is computed
again with every centre moved by up to this many pixels (the comet itself moves about 0.4 pixel during an
exposure of two minutes)."""

HALF = 76
"""Rows read on either side of the target: enough for the outer ring round an empty aperture."""
SIZE = 64
"""Side of a showcase stamp, pixels."""
BIG = 121
"""Side of the stamp kept in memory: a showcase stamp turned by any angle fits in it."""

REFERENCE = {
    "ring15": {"2026W09_1A_0447_2": 158.7, "2026W09_1A_0459_2": 49.4, "2026W09_2A_0075_2": 132.2,
               "2026W09_2A_0075_3": 260.2, "2026W09_2A_0075_4": 71.5, "2026W09_2A_0075_1": 12.6},
    "ring40": {"2026W09_1A_0447_2": 162.5, "2026W09_1A_0459_2": 52.7, "2026W09_2A_0075_2": 136.2,
               "2026W09_2A_0075_3": 263.2, "2026W09_2A_0075_4": 75.5},
}
"""What earlier measurements with other code found, mJy. They used positions interpolated in a table of 20-minute
steps, up to 0.56 arcsec from the positions used here; see `compare_with_reference`. At those positions this
job's code gives every one of these values within 0.1 mJy (pipeline/tests/test_p2_lemmon.py)."""

SOURCES = [
    "SPHEREx Data Release 1, Level 2 spectral images, NASA/IPAC Infrared Science Archive",
    "JPL Horizons: positions of C/2025 A6 (Lemmon) as seen from SPHEREx",
]


# -- one frame read around one sky position ---------------------------------------------------------


def obs_id(key: str) -> str:
    """"2026W09_2A_0075_3" from a bucket key: week, observation and exposure."""
    m = KEY_REGEX.fullmatch(key)
    return f"{m.group(1)}_{m.group(4)}_{m.group(5)}"


def short_id(key: str) -> str:
    """"2a-0075-3": what number keys call a frame of the comet's week."""
    m = KEY_REGEX.fullmatch(key)
    return f"{m.group(1).split('_')[1].lower()}-{m.group(4)}-{m.group(5)}"


def night_of(mjd: float) -> Optional[str]:
    for name, day in NIGHTS.items():
        if day <= mjd < day + 1:
            return name
    return None


def utc(mjd: float) -> datetime:
    return datetime(1858, 11, 17, tzinfo=timezone.utc) + timedelta(days=mjd)


@dataclass
class Cut:
    """The rows of one frame around one sky position: 2 * half rows, the whole width of the detector."""

    key: str
    det: int
    mjd: float
    ra: float  # the position the rows were read around, degrees
    dec: float
    px: float  # where it falls on the detector, 0-based
    py: float
    y0: int  # full-frame row of the first row held
    data: np.ndarray  # (rows, nx) float32, MJy/sr; NaN outside the detector
    flags: np.ndarray  # (rows, nx) int32
    var: Optional[np.ndarray]  # (rows, nx) float32, or None when the variance was not read
    wcs: object = field(repr=False)
    nx: int = 2040
    ny: int = 2040
    omega: float = 0.0  # solid angle of a pixel, sr
    pix_arcsec: float = 0.0
    _shown: Optional[np.ndarray] = field(default=None, repr=False)

    @property
    def rows(self) -> int:
        return self.data.shape[0]

    @property
    def unusable(self) -> np.ndarray:
        """True where a pixel has no value or carries a flag that makes it unusable (sx.phot.BAD_MASK): hits of
        cosmic rays, hot, dead and saturated pixels."""
        return ~np.isfinite(self.data) | ((self.flags & phot.BAD_MASK) != 0)

    @property
    def shown(self) -> np.ndarray:
        """The rows as the pictures show them: an unusable pixel takes the median of the usable pixels among
        its 8 neighbours (NaN when it has none). For pictures only: nothing is measured on this, and the showcase
        files hold the values as they are, with the flags beside them."""
        if self._shown is None:
            bad = self.unusable
            pad = np.pad(np.where(bad, np.nan, self.data), 1, constant_values=np.nan)
            near = np.stack([pad[1 + dy : 1 + dy + self.rows, 1 + dx : 1 + dx + self.nx]
                             for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dx, dy) != (0, 0)])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                fill = np.nanmedian(near, axis=0)
            self._shown = np.where(bad, fill, self.data).astype(np.float32)
        return self._shown

    def pixel(self, ra: float, dec: float) -> tuple[float, float]:
        x, y = sky_to_pixel(self.wcs, ra, dec)
        return float(x), float(y)

    def stamp(self, ra: float, dec: float, size: int = SIZE, tables=None) -> StampVar:
        """The size by size stamp around (ra, dec), the same as sx.stamp.cut gives: it starts at
        floor(pixel + 0.5) - size // 2, and what lies outside the detector or outside the rows held is NaN
        (image, variance) or 0 (flags)."""
        x, y = self.pixel(ra, dec)
        x0, y0 = int(math.floor(x + 0.5)) - size // 2, int(math.floor(y + 0.5)) - size // 2
        wb = wave.wavelength_at(self.det, x, y, tables)
        return StampVar(key=self.key, det=self.det, mjd=self.mjd, w=size, h=size, x0=x0, y0=y0, tx=x - x0,
                        ty=y - y0, lam=wb["lam"], bw=wb["bw"], data=self.window(self.data, x0, y0, size, size, np.nan),
                        flags=self.window(self.flags, x0, y0, size, size, 0),
                        variance=None if self.var is None else self.window(self.var, x0, y0, size, size, np.nan))

    def window(self, arr: np.ndarray, x0: int, y0: int, w: int, h: int, fill) -> np.ndarray:
        out = np.full((h, w), fill, arr.dtype)
        ya, yb = max(self.y0, y0), min(self.y0 + self.rows, y0 + h)
        xa, xb = max(0, x0), min(self.nx, x0 + w)
        if yb > ya and xb > xa:
            out[ya - y0 : yb - y0, xa - x0 : xb - x0] = arr[ya - self.y0 : yb - self.y0, xa:xb]
        return out


def read_cut(frame, ra: float, dec: float, half: int = HALF, variance: bool = True) -> Optional[Cut]:
    """The rows of a frame (a bucket key or an open FrameFile) round a sky position, or None when the position
    is not on the detector. The position on the detector comes from all_world2pix (distortion terms on)."""
    ff = FrameFile.open(frame) if isinstance(frame, str) else frame
    px, py = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
    if not on_frame(px, py, ff.nx, ff.ny):
        return None
    y0 = int(math.floor(py + 0.5)) - half
    data, flags, var = ff.box(0, y0, ff.nx, 2 * half, flags=True, variance=variance)
    om = pixel_area_sr(ff.wcs)
    return Cut(key=ff.key, det=ff.det, mjd=ff.mjd, ra=ra, dec=dec, px=px, py=py, y0=y0, data=data, flags=flags,
               var=var, wcs=ff.wcs, nx=ff.nx, ny=ff.ny, omega=om, pix_arcsec=math.degrees(math.sqrt(om)) * 3600)


# -- photometry -------------------------------------------------------------------------------------


def aperture(cut: Cut, x: float, y: float, r_ap: float, ring: tuple[float, float]) -> Optional[phot.Photometry]:
    """Flux at the full-frame pixel (x, y) by the shared rule (sx.phot.aperture), on the part of the rows that
    holds the ring. SOURCE-flagged pixels are left out of the ring only when MIN_QUIET_RING others remain."""
    reach = int(math.ceil(ring[1])) + 2
    ix, iy = int(math.floor(x + 0.5)), int(math.floor(y + 0.5))
    xa, xb = max(0, ix - reach), min(cut.nx, ix + reach + 1)
    ya, yb = max(cut.y0, iy - reach), min(cut.y0 + cut.rows, iy + reach + 1)
    if xb - xa < 3 or yb - ya < 3:
        return None
    sl = (slice(ya - cut.y0, yb - cut.y0), slice(xa, xb))
    d, f, v = cut.data[sl], cut.flags[sl], None if cut.var is None else cut.var[sl]
    cx, cy = x - xa, y - ya
    yy, xx = np.mgrid[: d.shape[0], : d.shape[1]]
    r = np.hypot(xx - cx, yy - cy)
    quiet = np.isfinite(d) & ((f & phot.BAD_MASK) == 0) & ((f & phot.SOURCE) == 0)
    if v is not None:
        quiet &= np.isfinite(v)
    skip = int((quiet & (r >= ring[0]) & (r < ring[1])).sum()) >= MIN_QUIET_RING
    return phot.aperture(d, v, f, cx, cy, r_ap, ring, cut.omega, skip_source_in_ring=skip)


def iso_points(det: int, x: float, y: float, offsets=EMPTY_OFFSETS, tables=None) -> list[tuple[float, float, int, int]]:
    """Pixels of the same colour as (x, y): for each offset d and each side, the column x + side * d and the row
    of that column where the wavelength equals the wavelength at (x, y). Gives (x, y, side, position in offsets).
    In detector 5 the colour changes along y, by about 0.0003 µm a pixel, and hardly along x."""
    t = (tables or wave.default_tables())[str(det)]
    lam0 = float(wave.lam_bw(t, x, y)[0])
    out = []
    for side in (1, -1):
        for k, d in enumerate(offsets):
            xe, ye = x + side * d, y
            for _ in range(12):
                slope = float(wave.lam_bw(t, xe, ye + 1.0)[0] - wave.lam_bw(t, xe, ye - 1.0)[0]) / 2.0
                if slope == 0:
                    break
                step = (float(wave.lam_bw(t, xe, ye)[0]) - lam0) / slope
                ye -= step
                if abs(step) < 1e-4:
                    break
            out.append((xe, ye, side, k))
    return out


def field_scatter(cut: Cut, x: float, y: float, r_ap: float, ring: tuple[float, float], tables=None) -> dict:
    """Fluxes of the empty apertures at the comet's colour in the same frame (each with its own ring), and their
    scatter: {n, sd, mad, fluxes}. sd is the sample standard deviation, the larger and safer of the two; None
    with fewer than 3 apertures."""
    got = []
    for xe, ye, _, _ in iso_points(cut.det, x, y, tables=tables):
        if not (6 <= xe <= cut.nx - 7 and cut.y0 + 6 <= ye <= cut.y0 + cut.rows - 7 and 6 <= ye <= cut.ny - 7):
            continue
        p = aperture(cut, xe, ye, r_ap, ring)
        if p is not None and math.isfinite(p.flux):
            got.append(p.flux)
    a = np.array(got)
    if a.size < 3:
        return {"n": int(a.size), "sd": None, "mad": None, "fluxes": got}
    return {"n": int(a.size), "sd": float(np.std(a, ddof=1)),
            "mad": float(1.4826 * np.median(np.abs(a - np.median(a)))), "fluxes": got}


def light_centre(cut: Cut, x: float, y: float, bkg: float, box: float = 4.0, passes: int = 5) -> Optional[float]:
    """How far the centre of the light within `box` pixels lies from (x, y), pixels: the flux-weighted mean
    position of the usable pixels above the background, found again around itself a few times."""
    xa, ya = int(math.floor(x)) - 12, max(cut.y0, int(math.floor(y)) - 12)
    d = cut.window(cut.data, xa, ya, 25, 25, np.nan)
    f = cut.window(cut.flags, xa, ya, 25, 25, 0)
    yy, xx = np.mgrid[:25, :25]
    xc, yc = x - xa, y - ya
    for _ in range(passes):
        m = (np.hypot(xx - xc, yy - yc) <= box) & np.isfinite(d) & ((f & phot.BAD_MASK) == 0)
        w = np.clip(d[m] - bkg, 0, None)
        if w.sum() <= 0:
            return None
        xc, yc = float(np.sum(w * xx[m]) / w.sum()), float(np.sum(w * yy[m]) / w.sum())
    return float(math.hypot(xc - (x - xa), yc - (y - ya)))


def brightest_pixel(cut: Cut, x: float, y: float, box: float = 4.0) -> tuple[float, float]:
    """(distance in pixels, value in MJy/sr) of the brightest usable pixel within `box` pixels of (x, y)."""
    xa, ya = int(math.floor(x)) - 6, max(cut.y0, int(math.floor(y)) - 6)
    d = cut.window(cut.data, xa, ya, 13, 13, np.nan)
    f = cut.window(cut.flags, xa, ya, 13, 13, 0)
    yy, xx = np.mgrid[:13, :13]
    r = np.hypot(xx - (x - xa), yy - (y - ya))
    v = np.where((r <= box) & np.isfinite(d) & ((f & phot.BAD_MASK) == 0), d, -np.inf)
    j, i = np.unravel_index(int(np.argmax(v)), v.shape)
    return float(r[j, i]), float(v[j, i])


def measure(cut: Cut, ra: float, dec: float, tables=None, scatter: bool = True, jitter: bool = False) -> dict:
    """Everything measured at one sky position of one frame: per ring the flux in the aperture with its errors,
    the flux in the wider aperture, the sky level in each ring ("bkg") and just beyond them ("beyond", MJy/sr),
    and how far the light's centre is from the position.

    err is the error the shared rule gives (pixel variance and the uncertainty of the background); field is the
    scatter of the empty apertures of the same colour; total is the two added in quadrature. With `jitter`, lo
    and hi are the smallest and largest flux when the centre is moved by up to JITTER pixels."""
    x, y = cut.pixel(ra, dec)
    wb = wave.wavelength_at(cut.det, x, y, tables)
    out = {"key": cut.key, "obs": obs_id(cut.key), "mjd": cut.mjd, "ra": ra, "dec": dec, "x": x, "y": y,
           "lam": wb["lam"], "bw": wb["bw"], "pix_arcsec": cut.pix_arcsec, "rings": {}}
    for name, ring in RINGS.items():
        p = aperture(cut, x, y, R_AP, ring)
        if p is None or not math.isfinite(p.flux):
            out["rings"][name] = None
            continue
        r = {"flux": p.flux, "err": p.err, "bkg": p.bkg, "n_ap": p.n_ap, "n_use": p.n_use, "n_ring": p.n_ring,
             "field": None, "n_empty": 0, "total": p.err}
        if scatter:
            s = field_scatter(cut, x, y, R_AP, ring, tables)
            r["n_empty"] = s["n"]
            if s["sd"] is not None:
                r["field"], r["field_mad"] = s["sd"], s["mad"]
                r["total"] = math.hypot(p.err, s["sd"])
        w = aperture(cut, x, y, R_WIDE, ring)
        r["wide"] = w.flux if w is not None and math.isfinite(w.flux) else None
        if jitter:
            steps = np.linspace(-JITTER, JITTER, 5)
            fl = [q.flux for dx in steps for dy in steps if math.hypot(dx, dy) <= JITTER + 1e-9
                  for q in [aperture(cut, x + dx, y + dy, R_AP, ring)] if q is not None and math.isfinite(q.flux)]
            r["lo"], r["hi"] = (min(fl), max(fl)) if fl else (None, None)
        out["rings"][name] = r
    far = aperture(cut, x, y, R_AP, BEYOND)
    out["beyond"] = far.bkg if far is not None else None
    first = out["rings"][SECOND] or out["rings"][HEADLINE]
    out["centre_offset"] = light_centre(cut, x, y, first["bkg"]) if first else None
    out["brightest"] = brightest_pixel(cut, x, y)
    return out


# -- the contrast -----------------------------------------------------------------------------------


def in_band(lam: float) -> bool:
    return BAND[0] <= lam <= BAND[1]


def flux_of(m: dict, ring: str, what: str = "flux") -> Optional[float]:
    r = m["rings"].get(ring)
    return None if r is None else r.get(what)


def contrast(frames: list[dict], night: str, ring: str = HEADLINE, what: str = "flux") -> Optional[dict]:
    """The contrast of one night: the brightest frame of that night inside the band, over the mean of the two
    frames nearest the band, one below and one above it, among all the frames given (both nights: they are one
    visit by the visit rule). `frames` are what measure() gives; frames without a flux in `ring` take no part.
    The three frames are always chosen by "flux"; `what` says which of their fluxes is divided ("flux", or
    "wide" for the wider aperture). Returns None when the night has no frame inside the band, a side has no
    frame, or one of the three has no such flux.

    The error treats the three fluxes as independent, each with its total error:
    err = contrast * sqrt((e_peak / peak)^2 + (e_mean / mean)^2), e_mean = sqrt(e_below^2 + e_above^2) / 2."""
    ok = [m for m in frames if flux_of(m, ring) is not None]
    inside = [m for m in ok if in_band(m["lam"]) and night_of(m["mjd"]) == night]
    below = [m for m in ok if m["lam"] < BAND[0]]
    above = [m for m in ok if m["lam"] > BAND[1]]
    if not inside or not below or not above:
        return None
    peak = max(inside, key=lambda m: flux_of(m, ring))
    lo, hi = max(below, key=lambda m: m["lam"]), min(above, key=lambda m: m["lam"])
    p, a, b = (flux_of(m, ring, what) for m in (peak, lo, hi))
    if p is None or a is None or b is None:
        return None
    mean = (a + b) / 2.0
    ep, ea, eb = (flux_of(m, ring, "total") for m in (peak, lo, hi))
    em = math.hypot(ea, eb) / 2.0
    c = p / mean
    return {"night": night, "ring": ring, "contrast": c, "err": abs(c) * math.hypot(ep / p, em / mean),
            "peak": peak["obs"], "below": lo["obs"], "above": hi["obs"], "peak_flux": p, "below_flux": a,
            "above_flux": b, "mean": mean}


def leave_one_out(frames: list[dict], ring: str = HEADLINE) -> list[dict]:
    """The contrast of both nights with each frame left out in turn: one entry per frame left out,
    {left_out, role, feb25, feb26}. `role` says what the frame is to a night when all frames are there: "peak"
    (the brightest frame inside the band of a night), "neighbour" (one of the two frames nearest the band) or
    "other". A night whose contrast cannot be formed without the frame has None."""
    full = {n: contrast(frames, n, ring) for n in NIGHTS}
    out = []
    for m in frames:
        if flux_of(m, ring) is None:
            continue
        rest = [q for q in frames if q is not m]
        role = "other"
        for n, c in full.items():
            if c and m["obs"] == c["peak"]:
                role = "peak"
            elif c and m["obs"] in (c["below"], c["above"]) and role != "peak":
                role = "neighbour"
        row = {"left_out": m["obs"], "lam": m["lam"], "role": role}
        for n in NIGHTS:
            c = contrast(rest, n, ring)
            row[n] = None if c is None else c["contrast"]
            row[n + "_peak"] = None if c is None else c["peak"]
        out.append(row)
    return out


def jitter_range(frames: list[dict], night: str, ring: str = HEADLINE) -> Optional[tuple[float, float]]:
    """The smallest and the largest the contrast of a night can be when the centre of each of its three
    apertures is moved by up to JITTER pixels: (peak at its lowest over neighbours at their highest, and the
    reverse). None when the frames carry no such range."""
    c = contrast(frames, night, ring)
    if c is None:
        return None
    by = {m["obs"]: m["rings"][ring] for m in frames if m["rings"].get(ring)}
    p, a, b = by[c["peak"]], by[c["below"]], by[c["above"]]
    if any(q.get("lo") is None for q in (p, a, b)):
        return None
    return p["lo"] / ((a["hi"] + b["hi"]) / 2.0), p["hi"] / ((a["lo"] + b["lo"]) / 2.0)


# -- frames -----------------------------------------------------------------------------------------


def find_frames() -> list[str]:
    """The frames of the job, when none are frozen yet: every detector-5 frame of the two nights that holds
    the comet, and every detector-5 frame of any date that covers a place where the comet was photographed
    inside the band (from these the templates are chosen). Asks IRSA's image search along the comet's path."""
    t0 = min(NIGHTS.values())
    times = [t0 + k / 12.0 for k in range(25)]
    eph = horizons.positions(COMET, times)

    def search(p):
        return irsa.sia_frames(round(float(p[0]), 5), round(float(p[1]), 5))

    cand = {f["key"] for got in s3.map_threads(search, list(zip(eph.ra, eph.dec)), workers=3) for f in got
            if f["det"] == DET and night_of(0.5 * (f["tmin"] + f["tmax"]))}
    ffs = s3.map_threads(FrameFile.open, sorted(cand))
    at = horizons.positions(COMET, [ff.mjd for ff in ffs])
    comet, places = [], []
    for ff, ra, dec in zip(ffs, at.ra, at.dec):
        x, y = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
        if R_AP + 1 <= x <= ff.nx - R_AP - 2 and R_AP + 1 <= y <= ff.ny - R_AP - 2:
            comet.append(ff.key)
            if in_band(wave.wavelength_at(ff.det, x, y)["lam"]):
                places.append((float(ra), float(dec)))
    others = {f["key"] for got in s3.map_threads(search, places, workers=3) for f in got if f["det"] == DET}
    return sorted(set(comet) | others)


def as_frame(ff: FrameFile) -> dict:
    """A frame in the shared form (CT-1)."""
    return {"key": ff.key, "det": ff.det, "tmid": ff.mjd, "corners": corners(ff.wcs, ff.nx, ff.ny)}


def choose_template(ffs: list[FrameFile], shot: dict, tables=None) -> Optional[dict]:
    """The frame of another visit that shows the place of `shot` (a measured comet frame) at the same colour.

    The frames that hold the place, with a showcase stamp to spare, are grouped by the visit rule; the two
    visits compared are the rule's default pair, of which the comet's visit is one (when it is not, the earlier
    of the two is taken). The frames of the other visit are then matched against the comet's frame by the match
    rule (same detector, closest colour at the place, within half the smaller bandwidth). Returns {key, lam, bw,
    dlam, n_candidates, tmid, visits} or None when the rule accepts no frame."""
    here = []
    for ff in ffs:
        x, y = (float(v) for v in sky_to_pixel(ff.wcs, shot["ra"], shot["dec"]))
        if not (SIZE // 2 <= x <= ff.nx - SIZE // 2 - 1 and SIZE // 2 <= y <= ff.ny - SIZE // 2 - 1):
            continue
        wb = wave.wavelength_at(ff.det, x, y, tables)
        y0 = int(math.floor(y + 0.5)) - SIZE // 2
        here.append({**as_frame(ff), "lam": wb["lam"], "bw": wb["bw"], "y0": y0, "h": SIZE})
    vs = visits.visits(here, det=DET)
    pair = visits.default_pair(vs)
    mine = [i for i, v in enumerate(vs) if any(f["key"] == shot["key"] for f in v["frames"])]
    if pair is None or not mine:
        return None
    other = pair[0] if pair[0] != mine[0] else pair[1]
    comet = [f for f in vs[mine[0]]["frames"] if f["key"] == shot["key"]]
    pool = vs[other]["frames"]
    got = match.match_pairs(pool, comet)
    if not got:
        return None
    t = pool[got[0][0]]
    return {"key": t["key"], "lam": t["lam"], "bw": t["bw"], "dlam": t["lam"] - comet[0]["lam"],
            "n_candidates": len(pool), "tmid": t["tmid"], "visits": len(vs)}


# -- measuring the comet and its templates ----------------------------------------------------------


def comet_shots(ffs: list[FrameFile], tables=None) -> list[dict]:
    """measure() at the comet's position in every frame of the two nights that holds it, in time order. Each
    result also carries the rows read ("cut"), the night, and the comet's distance from the Sun and from
    SPHEREx in au."""
    mine = [ff for ff in ffs if night_of(ff.mjd)]
    eph = horizons.positions(COMET, [ff.mjd for ff in mine])

    def one(i: int):
        ff = mine[i]
        ra, dec = float(eph.ra[i]), float(eph.dec[i])
        x, y = (float(v) for v in sky_to_pixel(ff.wcs, ra, dec))
        if not (R_AP + 1 <= x <= ff.nx - R_AP - 2 and R_AP + 1 <= y <= ff.ny - R_AP - 2):
            return None
        cut = read_cut(ff, ra, dec)
        m = measure(cut, ra, dec, tables, jitter=True)
        m.update(cut=cut, night=night_of(ff.mjd), r_au=float(eph.r_au[i]), delta_au=float(eph.delta_au[i]))
        return m

    return sorted((m for m in s3.map_threads(one, range(len(mine))) if m), key=lambda m: m["mjd"])


def template_shots(ffs: list[FrameFile], shots: list[dict], tables=None) -> dict[str, dict]:
    """For each comet frame inside the band, its template measured at the same sky position: {obs of the comet
    frame: measure() result with "cut", "dlam" and "n_candidates"}. A frame the match rule finds no template
    for is absent."""
    by_key = {ff.key: ff for ff in ffs}

    def one(m: dict):
        t = choose_template(ffs, m, tables)
        if t is None:
            return m["obs"], None
        cut = read_cut(by_key[t["key"]], m["ra"], m["dec"])
        r = measure(cut, m["ra"], m["dec"], tables)
        r.update(cut=cut, dlam=t["dlam"], n_candidates=t["n_candidates"], for_obs=m["obs"])
        return m["obs"], r

    inside = [m for m in shots if in_band(m["lam"]) and flux_of(m, HEADLINE) is not None]
    return {k: v for k, v in s3.map_threads(one, inside) if v}


def template_tests(shots: list[dict], templates: dict[str, dict], ring: str = HEADLINE) -> list[dict]:
    """One row per comet frame inside the band that has a template: the two fluxes, the template as a percentage
    of the comet's flux, and by how many standard errors the comet's flux exceeds the template's. `sigma` uses
    the total errors, which hold the scatter of the empty apertures of both frames; `sigma_noise` the errors of
    the shared rule alone (pixels and background), which is what the difference of two measurements of one
    place has when the stars of the place are the same in both."""
    peaks = {c["peak"] for c in (contrast(shots, n, ring) for n in NIGHTS) if c}
    rows = []
    for m in shots:
        t = templates.get(m["obs"])
        if t is None or flux_of(t, ring) is None:
            continue
        f, ef, g, eg = flux_of(m, ring), flux_of(m, ring, "total"), flux_of(t, ring), flux_of(t, ring, "total")
        noise = math.hypot(flux_of(m, ring, "err"), flux_of(t, ring, "err"))
        rows.append({"obs": m["obs"], "key": m["key"], "night": m["night"], "lam": m["lam"], "flux": f, "err": ef,
                     "peak": m["obs"] in peaks, "template": t["obs"], "template_key": t["key"],
                     "template_mjd": t["mjd"], "template_lam": t["lam"], "dlam": t["dlam"], "template_flux": g,
                     "template_err": eg, "percent": 100.0 * abs(g) / f, "sigma": (f - g) / math.hypot(ef, eg),
                     "sigma_noise": (f - g) / noise,
                     "n_candidates": t["n_candidates"]})
    return rows


def separation_arcsec(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Angle between two sky positions (ra, dec in degrees), arcsec."""
    ra1, d1, ra2, d2 = (math.radians(v) for v in (*a, *b))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((ra2 - ra1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h)))) * 3600.0


# -- placing one frame on the grid of another -------------------------------------------------------


def sky_map(ref: Cut, x0: int, y0: int, w: int, h: int, src: Cut) -> tuple[np.ndarray, np.ndarray]:
    """Where each pixel of a w by h grid of `ref` (first pixel at the full-frame pixel x0, y0) falls on the
    detector of `src`: two (h, w) arrays of full-frame pixels, through the sky with both distortions on."""
    yy, xx = np.mgrid[y0 : y0 + h, x0 : x0 + w].astype(float)
    ra, dec = pixel_to_sky(ref.wcs, xx.ravel(), yy.ravel())
    xs, ys = sky_to_pixel(src.wcs, ra, dec)
    return np.asarray(xs, float).reshape(h, w), np.asarray(ys, float).reshape(h, w)


def nearest_onto(ref: Cut, x0: int, y0: int, w: int, h: int, src: Cut) -> tuple[np.ndarray, int]:
    """`src` as the pictures show it (Cut.shown) on a grid of `ref`: every pixel of the grid takes the value of
    the one nearest pixel of `src`, and nothing is blended; NaN where `src` holds no value. Also the number of
    grid pixels that fall on an unusable pixel of `src`."""
    xs, ys = sky_map(ref, x0, y0, w, h, src)
    ix, iy = np.floor(xs + 0.5).astype(int), np.floor(ys + 0.5).astype(int) - src.y0
    ok = (ix >= 0) & (ix < src.nx) & (iy >= 0) & (iy < src.rows)
    out = np.full((h, w), np.nan, np.float32)
    out[ok] = src.shown[iy[ok], ix[ok]]
    return out, int(src.unusable[iy[ok], ix[ok]].sum())


def difference_on(frame: Cut, template: Cut, ra: float, dec: float, size: int = SIZE) -> dict:
    """The comet's frame minus its template on the pixel grid of the comet's stamp around (ra, dec), by the
    shared rules: each side has its own background taken off (sx.stack.coadd of one stamp: the comet's showcase
    stamp, and a larger stamp of the template so that it covers the grid at any turn), the template is resampled
    bilinearly onto the grid (sx.stack.resample), and sx.stack.difference gives the result in MJy/sr and in
    units of the noise."""
    st = frame.stamp(ra, dec, size)
    big = template.stamp(ra, dec, BIG)
    xs, ys = sky_map(frame, st.x0, st.y0, size, size, template)
    late = stack.coadd([{"data": st.data, "flags": st.flags}])
    early = stack.resample_coadd(stack.coadd([{"data": big.data, "flags": big.flags}]), xs - big.x0, ys - big.y0)
    d = stack.difference(early, late)
    d["frame"], d["template"] = late, early
    return d


# -- showcases --------------------------------------------------------------------------------------


def visit_numbers(stamps: list) -> list[int]:
    """The visit of each stamp by the visit rule, counted from 0 in time."""
    vs = visits.visits([{"key": s.key, "det": s.det, "tmid": s.mjd, "corners": []} for s in stamps])
    num = {(f["key"], f["tmid"]): i for i, v in enumerate(vs) for f in v["frames"]}
    return [num[(s.key, s.mjd)] for s in stamps]


def matched_pairs(stamps: list, vis: list[int]) -> list[tuple[int, int]]:
    """Pairs between the first and the last visit of a set of stamps, by the match rule, as positions in `stamps`."""
    a = [i for i, v in enumerate(vis) if v == min(vis)]
    b = [i for i, v in enumerate(vis) if v == max(vis)]
    if min(vis) == max(vis):
        return []
    as_m = lambda i: {"det": stamps[i].det, "lam": stamps[i].lam, "bw": stamps[i].bw, "y0": stamps[i].y0, "h": stamps[i].h}
    return [(a[i], b[j]) for i, j in match.match_pairs([as_m(i) for i in a], [as_m(i) for i in b])]


# -- stars beside the comet -------------------------------------------------------------------------

STAR_REACH, STAR_G = 4.0, 15.0
"""A catalogue star brighter than STAR_G (Gaia G magnitude) within STAR_REACH pixels of the comet is listed."""
STAR_TOUCH = R_AP + 0.5
"""A listed star this close, in pixels, lies in the aperture or on its edge and adds to the comet's flux."""


def stars_near(m: dict) -> list[dict]:
    """Gaia DR3 stars brighter than STAR_G within STAR_REACH pixels of the comet's position in a frame, moved
    to the date of the frame, nearest first: [{source_id, g, px}]."""
    from sx import gaia

    found = gaia.cone(round(m["ra"], 6), round(m["dec"], 6), 0.012)
    found = [s for s in found if s["phot_g_mean_mag"] is not None and s["phot_g_mean_mag"] < STAR_G]
    if not found:
        return []
    ra, dec = gaia.propagate(found, m["mjd"])
    out = []
    for s, a, b in zip(found, ra, dec):
        x, y = m["cut"].pixel(float(a), float(b))
        d = math.hypot(x - m["x"], y - m["y"])
        if d <= STAR_REACH:
            out.append({"source_id": s["source_id"], "g": float(s["phot_g_mean_mag"]), "px": d})
    return sorted(out, key=lambda s: s["px"])


# -- what the job works out -------------------------------------------------------------------------


def tile(cut: Cut, ra: float, dec: float, size: int = 41) -> tuple[np.ndarray, tuple[int, int], tuple[float, float]]:
    """The size by size pixels of a frame round a sky position as the pictures show them (Cut.shown):
    (values, (x0, y0), (tx, ty))."""
    x, y = cut.pixel(ra, dec)
    x0, y0 = int(math.floor(x + 0.5)) - size // 2, int(math.floor(y + 0.5)) - size // 2
    return cut.window(cut.shown, x0, y0, size, size, np.nan), (x0, y0), (x - x0, y - y0)


def analyse(shots: list[dict], templates: dict[str, dict]) -> dict:
    """Everything derived from the measurements: the contrasts with their checks, the template tests, the
    frames of the hero and the track."""
    res: dict = {"contrast": {}, "second": {}, "wide": {}, "jitter": {}}
    for n in NIGHTS:
        res["contrast"][n] = contrast(shots, n, HEADLINE)
        res["second"][n] = contrast(shots, n, SECOND)
        res["wide"][n] = contrast(shots, n, HEADLINE, "wide")
        res["jitter"][n] = jitter_range(shots, n, HEADLINE)
    res["loo"] = leave_one_out(shots, HEADLINE)
    res["tests"] = template_tests(shots, templates, HEADLINE)
    res["tests_second"] = template_tests(shots, templates, SECOND)
    by = {m["obs"]: m for m in shots}
    c26, c25 = res["contrast"]["feb26"], res["contrast"]["feb25"]
    on, peak25 = by[c26["peak"]], by[c25["peak"]]
    seq = [m for m in shots if abs(m["mjd"] - on["mjd"]) <= 15.0 / 1440.0 and flux_of(m, HEADLINE) is not None]
    off = by[c26["below"]]
    if off not in seq:
        outside = [m for m in seq if not in_band(m["lam"])]
        off = min(outside, key=lambda m: min(abs(m["lam"] - BAND[0]), abs(m["lam"] - BAND[1])))
    res.update(on=on, off=off, peak25=peak25, sequence=seq, aug=templates[on["obs"]], below=by[c26["below"]],
               above=by[c26["above"]])
    res["sep_arcsec"] = separation_arcsec((peak25["ra"], peak25["dec"]), (on["ra"], on["dec"]))
    res["hours"] = (on["mjd"] - peak25["mjd"]) * 24.0
    return res


def project(ra, dec, ra0: float, dec0: float) -> tuple[np.ndarray, np.ndarray]:
    """(east, north) in arcmin of sky positions on the plane that touches the sky at (ra0, dec0)."""
    a, d, a0, d0 = np.radians(ra), np.radians(dec), math.radians(ra0), math.radians(dec0)
    den = math.sin(d0) * np.sin(d) + math.cos(d0) * np.cos(d) * np.cos(a - a0)
    east = np.cos(d) * np.sin(a - a0) / den
    north = (math.cos(d0) * np.sin(d) - math.sin(d0) * np.cos(d) * np.cos(a - a0)) / den
    return np.degrees(east) * 60.0, np.degrees(north) * 60.0


def track_data(shots: list[dict], res: dict) -> dict:
    """The comet's path over the two nights (JPL Horizons, seen from SPHEREx, every 30 minutes), the frames on
    it, and the two places where the comet was photographed inside the band at its brightest."""
    t0 = min(NIGHTS.values())
    times = [t0 + k / 48.0 for k in range(97)]
    eph = horizons.positions(COMET, times)
    ra0, dec0 = float(eph.ra[48]), float(eph.dec[48])
    e, n = project(eph.ra, eph.dec, ra0, dec0)
    path = [{"mjd": t, "ra": float(a), "dec": float(d), "east": float(x), "north": float(y)}
            for t, a, d, x, y in zip(times, eph.ra, eph.dec, e, n)]

    def at(m: dict) -> dict:
        x, y = project(np.array([m["ra"]]), np.array([m["dec"]]), ra0, dec0)
        return {"key": m["key"], "mjd": m["mjd"], "night": m["night"], "ra": m["ra"], "dec": m["dec"],
                "east": float(x[0]), "north": float(y[0]), "lam": m["lam"], "inside": in_band(m["lam"])}

    places = []
    for m in (res["peak25"], res["on"]):
        p = at(m)
        p.update(centre_offset_px=m["centre_offset"], label=f"{utc(m['mjd']):%d %b %Y, %H:%M} UTC".lstrip("0"))
        places.append(p)
    return {"object": NAME, "observer": "SPHEREx (JPL Horizons body -163182)",
            "source": "JPL Horizons, astrometric positions (ICRS), every 30 minutes",
            "centre": {"ra": ra0, "dec": dec0}, "path": path, "photos": [at(m) for m in shots], "places": places,
            "separation_arcmin": res["sep_arcsec"] / 60.0, "hours": res["hours"]}


# -- the files: showcases, pictures, data -----------------------------------------------------------


def day_month(mjd: float) -> str:
    return f"{utc(mjd).day} {utc(mjd):%B}"


def day_text(mjd: float) -> str:
    return f"{utc(mjd).day} {utc(mjd):%B %Y}"


def short_day(mjd: float) -> str:
    return f"{utc(mjd).day} {utc(mjd):%b %Y}"


def time_text(mjd: float) -> str:
    return f"{utc(mjd):%H:%M} UTC"


def write_files(shots: list[dict], templates: dict[str, dict], res: dict) -> dict:
    """Write the showcases, their pictures, track.json and spectrum.json, and the pictures of the Checks rows
    and of the review sheets. Returns what the numbers and the rows need: the display rule and the paths."""
    from jobs import lemmon_draw as draw

    on, off, aug, peak25 = res["on"], res["off"], res["aug"], res["peak25"]
    place = (on["ra"], on["dec"])
    by = {m["obs"]: m for m in shots}

    # hero/: the August photo and the photos of the comet's night, all cut round one point of the sky
    hero = [aug["cut"].stamp(*place)] + [m["cut"].stamp(*place) for m in res["sequence"]]
    vis = visit_numbers(hero)
    render.write_showcase(OUT / "hero", "hero", NAME, place[0], place[1], hero, vis, matched_pairs(hero, vis),
                          refs=SOURCES,
                          numbers=["lemmon.hero.aug", "lemmon.hero.off", "lemmon.hero.on", "lemmon.contrast.feb26",
                                   "lemmon.aperture.arcsec", "lemmon.ring.inner.px", "lemmon.ring.outer.px"])
    rule = draw.display_rule([(s.data, s.flags, s.tx, s.ty) for s in hero])
    filled = [0]

    def sky(cut: Cut, ra: float, dec: float) -> float:
        st = cut.stamp(ra, dec)
        return draw.sky_of(st.data, st.flags)[0]

    def own(m: dict) -> tuple[np.ndarray, tuple[float, float]]:
        """A frame round its own comet position, above its sky; and the comet's place in it."""
        img, _, mark = tile(m["cut"], m["ra"], m["dec"])
        return img - sky(m["cut"], m["ra"], m["dec"]), mark

    def turned(ref: dict, src: Cut, ra: float, dec: float) -> np.ndarray:
        """`src` round (ra, dec) on the pixel grid of the frame `ref`, nearest pixel, above its sky."""
        _, (x0, y0), _ = tile(ref["cut"], ra, dec)
        img, n = nearest_onto(ref["cut"], x0, y0, 41, 41, src)
        filled[0] = n
        return img - sky(src, ra, dec)

    def label(m: dict, with_time: bool = True) -> list[str]:
        when = f"{day_text(m['mjd'])}, {time_text(m['mjd'])}" if with_time else day_text(m["mjd"])
        return [when, f"{m['lam']:.3f} µm"]

    _, (gx, gy), centre = tile(on["cut"], *place)
    bx, by_ = on["cut"].pixel(off["ra"], off["dec"])
    panels, hero_filled = [], 0
    for m, lines, mark in ((aug, label(aug, False), centre), (off, label(off), (bx - gx, by_ - gy)), (on, label(on), centre)):
        panels.append({"image": turned(on, m["cut"], *place), "lines": lines, "mark": mark})
        hero_filled += filled[0]
    hero_png = draw.hero_png(OUT / "hero" / "hero.png", panels, rule)

    # strip/: every frame of the two nights between the two ends of the strip, each round the comet
    strip = [m for m in shots if STRIP[0] <= m["lam"] <= STRIP[1] and flux_of(m, HEADLINE) is not None]
    stamps = [m["cut"].stamp(m["ra"], m["dec"]) for m in strip]
    svis = visit_numbers(stamps)
    render.write_showcase(OUT / "strip", "strip", f"{NAME}, 25 and 26 February 2026", place[0], place[1], stamps,
                          svis, matched_pairs(stamps, svis), refs=SOURCES,
                          numbers=[f"lemmon.frame.{short_id(m['key'])}.flux" for m in strip])
    rows = []
    for night in ("feb26", "feb25"):
        tiles = []
        for m in sorted((m for m in strip if m["night"] == night), key=lambda m: m["lam"]):
            img, mark = own(m)
            tiles.append({"image": img, "mark": mark, "lines": [f"{m['lam']:.3f} µm", time_text(m["mjd"])],
                          "inside": in_band(m["lam"])})
        rows.append((NIGHT_TEXT[night], tiles))
    draw.strip_png(OUT / "strip" / "strip.png", rows, rule)

    # templates/: each frame inside the band with its template, as pairs
    tests = res["tests"]
    tstamps, tpairs, trows = [], [], []
    for t in tests:
        m, tp = by[t["obs"]], templates[t["obs"]]
        tstamps += [tp["cut"].stamp(m["ra"], m["dec"]), m["cut"].stamp(m["ra"], m["dec"])]
        tpairs.append((len(tstamps) - 2, len(tstamps) - 1))
        d = difference_on(m["cut"], tp["cut"], m["ra"], m["dec"])
        edge = SIZE // 2 - 20  # the 41 pixels of the pictures inside the showcase stamp
        img, mark = own(m)
        trows.append({
            "frame": img, "template": turned(m, tp["cut"], m["ra"], m["dec"]),
            "units": d["units"][edge : edge + 41, edge : edge + 41], "mark": mark,
            "lines": [f"{m['lam']:.3f} µm", short_day(m["mjd"]), short_day(tp["mjd"])],
            "text": (f"comet {t['flux']:.1f} ± {t['err']:.1f} mJy\n"
                     f"August {t['template_flux']:+.1f} ± {t['template_err']:.1f} mJy ({t['percent']:.1f}%)\n"
                     f"{t['sigma']:.1f} standard errors apart\n"
                     f"colours {abs(t['dlam']) * 1000:.1f} nm apart"),
        })
    tvis = visit_numbers(tstamps)
    man = render.write_showcase(OUT / "templates", "templates", f"{NAME} and the same sky in August 2025", place[0],
                                place[1], tstamps, tvis, tpairs, refs=SOURCES,
                                numbers=[f"lemmon.template.{short_id(t['key'])}.flux" for t in tests])
    fig, _ = draw.rows_figure(trows, rule, dark=True, numbers=False)
    draw.save(fig, OUT / "templates" / "templates.png")
    fig, _ = draw.rows_figure(trows, rule, dark=False, numbers=True)
    k3 = draw.save(fig, IMG / "k3-templates.png")

    # track.json and its picture
    trk = track_data(shots, res)
    where = {(f["key"], round(f["mjd"], 6)): i for i, f in enumerate(man["frames"])}
    insets = []
    for p, m in zip(trk["places"], (peak25, on)):
        tp = templates[m["obs"]]
        p["pair"] = {"showcase": "templates", "early": where[(tp["key"], round(tp["mjd"], 6))],
                     "late": where[(m["key"], round(m["mjd"], 6))]}
        p["flux"] = f"lemmon.frame.{short_id(m['key'])}.flux"
        p["august_flux"] = f"lemmon.template.{short_id(m['key'])}.flux"
        img, mark = own(m)
        insets.append({"title": f"{p['label']}, {m['lam']:.3f} µm", "late": img, "late_label": day_text(m["mjd"]),
                       "early": turned(m, tp["cut"], m["ra"], m["dec"]), "early_label": day_text(tp["mjd"]), "mark": mark})
    trk["numbers"] = ["lemmon.track.arcmin", "lemmon.track.hours", "lemmon.track.offset.feb25", "lemmon.track.offset.feb26"]
    checks.write_json(OUT / "track.json", trk)
    draw.save(draw.track_figure(trk, insets, rule, dark=True), OUT / "track.png")

    # spectrum.json: brightness against wavelength, the contrasts and the leave-one-out test, as data
    def photo(m: dict) -> dict:
        r, s = m["rings"][HEADLINE], m["rings"][SECOND]
        near = m.get("stars") or []
        return {"key": m["key"], "obs": m["obs"], "id": short_id(m["key"]), "mjd": m["mjd"], "night": m["night"],
                "lam": m["lam"], "bw": m["bw"], "inside": in_band(m["lam"]), "flux": r and r["flux"],
                "err": r and r["total"], "flux_second_ring": s and s["flux"], "flux_wide_aperture": r and r["wide"],
                "pixels_in_aperture": r and r["n_ap"], "pixels_used": r and r["n_use"],
                "lowest_if_moved": r and r["lo"], "highest_if_moved": r and r["hi"],
                "centre_offset_px": m["centre_offset"], "stars": near,
                "star_in_aperture": bool(near and near[0]["px"] <= STAR_TOUCH)}

    drop = ("key", "template_key")
    spec = {
        "object": NAME, "detector": DET, "aperture_px": R_AP, "aperture_arcsec": R_AP * on["pix_arcsec"],
        "ring_px": list(RINGS[HEADLINE]), "second_ring_px": list(RINGS[SECOND]), "wide_aperture_px": R_WIDE,
        "moved_by_px": JITTER, "band": list(BAND), "unit": "mJy", "limit": "every flux is a lower limit",
        "photos": [photo(m) for m in shots],
        "templates": [{k: v for k, v in t.items() if k not in drop} for t in tests],
        "contrast": res["contrast"], "contrast_second_ring": res["second"],
        "contrast_wide_aperture": {n: c["contrast"] for n, c in res["wide"].items()},
        "contrast_if_moved": {n: list(j) if j else None for n, j in res["jitter"].items()},
        "leave_one_out": res["loo"],
    }
    checks.write_json(OUT / "spectrum.json", spec)
    k2 = draw.contrast_png(IMG / "k2-contrast.png", spec)

    # the two review sheets
    c26, c25 = res["contrast"]["feb26"], res["contrast"]["feb25"]
    tiles = [{"image": panels[0]["image"], "mark": centre, "title": day_text(aug["mjd"]),
              "lines": [time_text(aug["mjd"]), f"{aug['lam']:.4f} µm", f"{flux_of(aug, HEADLINE):+.1f} mJy"]}]
    for m in res["sequence"]:
        x, y = on["cut"].pixel(m["ra"], m["dec"])
        tiles.append({"image": turned(on, m["cut"], *place), "mark": (x - gx, y - gy), "title": day_text(m["mjd"]),
                      "lines": [time_text(m["mjd"]), f"{m['lam']:.4f} µm", f"{flux_of(m, HEADLINE):.1f} mJy"]})
    h1 = draw.hero_sheet_png(REVIEW / "h1.png", tiles, rule, [
        f"One display rule for every tile: black {rule['black']:.3f} MJy/sr (2 times the sky noise of {rule['noise']:.3f}, below the sky), "
        f"white {rule['white']:.1f} MJy/sr (the comet's peak),",
        f"asinh curve with its bend at {rule['soften']:.3f} MJy/sr; each photo's own sky level taken off. Every tile is the same 41 by 41 "
        f"pixels of sky ({41 * on['pix_arcsec'] / 60:.1f} arcmin) on the pixel grid",
        f"of the {on['lam']:.3f} µm photo; the other photos are placed on it pixel by pixel (nearest pixel, nothing blended). "
        "Marks: the comet's position from JPL Horizons.",
        "A pixel flagged unusable (a cosmic-ray hit, a hot, dead or saturated pixel) is drawn with the median of its usable neighbours; "
        "nothing else is changed.",
        f"Fluxes: aperture of {R_AP} pixels ({R_AP * on['pix_arcsec']:.1f} arcsec) radius, background ring {RINGS[HEADLINE][0]:g} to "
        f"{RINGS[HEADLINE][1]:g} pixels; lower limits.",
        f"Contrast on {day_month(on['mjd'])}: {c26['peak_flux']:.1f} / mean({c26['below_flux']:.1f}, {c26['above_flux']:.1f}) = "
        f"{c26['contrast']:.1f} ± {c26['err']:.1f} (the neighbour above the band, {res['above']['lam']:.3f} µm, was taken on "
        f"{day_month(res['above']['mjd'])} and is not among these tiles).",
    ])
    worst = min((r for r in res["loo"] if r["role"] != "peak"), key=lambda r: min(r["feb25"], r["feb26"]))
    no_peak = "; ".join(f"{day_month(by[r['left_out']]['mjd'])} {r[by[r['left_out']]['night']]:.1f}"
                        for r in res["loo"] if r["role"] == "peak")
    h2 = draw.evidence_png(REVIEW / "h2.png", spec, trows, rule, [
        f"Headline: on {day_month(on['mjd'])} the comet is {c26['contrast']:.1f} ± {c26['err']:.1f} times brighter inside the band than at the two nearest",
        f"colours; on {day_month(peak25['mjd'])}: {c25['contrast']:.1f} ± {c25['err']:.1f}. Both nights use the same two neighbours: "
        f"{res['below']['lam']:.3f} µm ({day_month(res['below']['mjd'])})",
        f"and {res['above']['lam']:.3f} µm ({day_month(res['above']['mjd'])}). Fluxes are lower limits (the comet's glow reaches the ring).",
        f"Ring {RINGS[SECOND][0]:g} to {RINGS[SECOND][1]:g} pixels instead: {res['second']['feb26']['contrast']:.1f} and "
        f"{res['second']['feb25']['contrast']:.1f}. Aperture of {R_WIDE} pixels instead: {res['wide']['feb26']['contrast']:.1f} and "
        f"{res['wide']['feb25']['contrast']:.1f}.",
        f"Every aperture shifted by up to {JITTER} pixel:{res['jitter']['feb26'][0]:.1f} to {res['jitter']['feb26'][1]:.1f} and "
        f"{res['jitter']['feb25'][0]:.1f} to {res['jitter']['feb25'][1]:.1f}.",
        f"One photo left out at a time: lowest {min(worst['feb25'], worst['feb26']):.1f} when the photo is not a night's brightest;",
        f"without a night's brightest photo: {no_peak}.",
    ])
    return {"rule": rule, "hero_png": hero_png, "k2": k2, "k3": k3, "h1": h1, "h2": h2, "hero": hero, "strip": strip,
            "worst": worst, "no_peak": no_peak, "hero_filled": hero_filled}


# -- numbers, rows, sheets --------------------------------------------------------------------------


def write_numbers(shots: list[dict], templates: dict[str, dict], res: dict, files: dict) -> dict:
    """The numbers of the comet (site/data/numbers/p2.json). Every flux uses the aperture and the ring of
    lemmon.aperture.* and lemmon.ring.*; keys ending in .ring2 use the second ring and are there as the check."""
    E = numbers.entry
    on, off, aug, peak25, below, above = (res[k] for k in ("on", "off", "aug", "peak25", "below", "above"))
    pix, rule = on["pix_arcsec"], files["rule"]
    f = lambda m, ring=HEADLINE, what="flux": flux_of(m, ring, what)
    n: dict = {
        "lemmon.aperture.px": E(R_AP, 0, unit="pixels", check="K2"),
        "lemmon.aperture.arcsec": E(R_AP * pix, 1, unit="arcsec", check="K2"),
        "lemmon.ring.inner.px": E(RINGS[HEADLINE][0], 0, unit="pixels", check="K2"),
        "lemmon.ring.outer.px": E(RINGS[HEADLINE][1], 0, unit="pixels", check="K2"),
        "lemmon.ring.inner.arcsec": E(RINGS[HEADLINE][0] * pix, 0, unit="arcsec", check="K2"),
        "lemmon.ring.outer.arcsec": E(RINGS[HEADLINE][1] * pix, 0, unit="arcsec", check="K2"),
        "lemmon.ring2.inner.px": E(RINGS[SECOND][0], 0, unit="pixels", check="K2"),
        "lemmon.ring2.outer.px": E(RINGS[SECOND][1], 0, unit="pixels", check="K2"),
        "lemmon.band.from": E(BAND[0], 2, unit="µm", check="K2"),
        "lemmon.band.to": E(BAND[1], 2, unit="µm", check="K2"),
        "lemmon.photos": E(len(shots), 0, check="K2"),
        "lemmon.photos.measured": E(sum(f(m) is not None for m in shots), 0, check="K2"),
        "lemmon.hero.on": E(f(on), 1, err=f(on, what="total"), unit="mJy", check="K2"),
        "lemmon.hero.on.lam": E(on["lam"], 3, unit="µm", check="K2"),
        "lemmon.hero.on.ring2": E(f(on, SECOND), 1, unit="mJy", check="K2"),
        "lemmon.hero.off": E(f(off), 1, err=f(off, what="total"), unit="mJy", check="K2"),
        "lemmon.hero.off.lam": E(off["lam"], 3, unit="µm", check="K2"),
        "lemmon.hero.off.ring2": E(f(off, SECOND), 1, unit="mJy", check="K2"),
        "lemmon.hero.aug": E(f(aug), 1, err=f(aug, what="total"), unit="mJy", check="K3", shown=f"{f(aug):+.1f}"),
        "lemmon.hero.aug.lam": E(aug["lam"], 3, unit="µm", check="K3"),
        "lemmon.hero.aug.ring2": E(f(aug, SECOND), 1, unit="mJy", check="K3", shown=f"{f(aug, SECOND):+.1f}"),
        "lemmon.hero.minutes": E((on["mjd"] - off["mjd"]) * 1440.0, 0, unit="minutes", check="K2"),
        "lemmon.hero.ratio": E(f(on) / f(off), 1, check="K2", shown=f"about {f(on) / f(off):.0f} times"),
        "lemmon.hero.pixels": E(41, 0, unit="pixels"),
        "lemmon.hero.arcmin": E(41 * pix / 60.0, 1, unit="arcmin"),
        "lemmon.hero.filled": E(files["hero_filled"], 0, unit="pixels"),
        "lemmon.display.noise": E(rule["noise"], 3, unit="MJy/sr"),
        "lemmon.display.black": E(rule["black"], 2, unit="MJy/sr"),
        "lemmon.display.white": E(rule["white"], 1, unit="MJy/sr"),
        "lemmon.below.lam": E(below["lam"], 3, unit="µm", check="K2"),
        "lemmon.below.flux": E(f(below), 1, err=f(below, what="total"), unit="mJy", check="K2"),
        "lemmon.below.day": E(below["mjd"], 5, unit="MJD", check="K2", shown=day_month(below["mjd"])),
        "lemmon.above.lam": E(above["lam"], 3, unit="µm", check="K2"),
        "lemmon.above.flux": E(f(above), 1, err=f(above, what="total"), unit="mJy", check="K2"),
        "lemmon.above.day": E(above["mjd"], 5, unit="MJD", check="K2", shown=day_month(above["mjd"])),
        "lemmon.limit.gain": E(100.0 * (f(on) / f(on, SECOND) - 1.0), 1, unit="%", check="K2"),
        "lemmon.glow.near": E(f(on, SECOND, "bkg"), 2, unit="MJy/sr", check="K2"),
        "lemmon.glow.ring": E(f(on, HEADLINE, "bkg"), 2, unit="MJy/sr", check="K2"),
        "lemmon.glow.beyond": E(on["beyond"], 2, unit="MJy/sr", check="K2"),
        "lemmon.glow.aug.near": E(f(aug, SECOND, "bkg"), 2, unit="MJy/sr", check="K2"),
        "lemmon.glow.aug.ring": E(f(aug, HEADLINE, "bkg"), 2, unit="MJy/sr", check="K2"),
        "lemmon.glow.aug.beyond": E(aug["beyond"], 2, unit="MJy/sr", check="K2"),
        "lemmon.track.arcmin": E(res["sep_arcsec"] / 60.0, 1, unit="arcmin", check="K3"),
        "lemmon.track.hours": E(res["hours"], 1, unit="hours", check="K3"),
        "lemmon.track.offset.feb25": E(peak25["centre_offset"], 1, unit="pixels", check="K3"),
        "lemmon.track.offset.feb26": E(on["centre_offset"], 1, unit="pixels", check="K3"),
    }
    for night in NIGHTS:
        c, s, w, j = (res[k][night] for k in ("contrast", "second", "wide", "jitter"))
        k = f"lemmon.contrast.{night}"
        n[k] = E(c["contrast"], 1, err=c["err"], unit="times", check="K2", shown=f"about {c['contrast']:.0f} times")
        n[k + ".exact"] = E(c["contrast"], 1, err=c["err"], unit="times", check="K2")
        n[k + ".err"] = E(c["err"], 1, unit="times", check="K2")
        n[k + ".ring2"] = E(s["contrast"], 1, err=s["err"], unit="times", check="K2")
        n[k + ".wide"] = E(w["contrast"], 1, unit="times", check="K2")
        n[k + ".moved.low"] = E(j[0], 1, unit="times", check="K2")
        n[k + ".moved.high"] = E(j[1], 1, unit="times", check="K2")
        gone = [r for r in res["loo"] if r["role"] == "peak" and r["left_out"] == c["peak"]]
        if gone and gone[0][night] is not None:
            n[k + ".nopeak"] = E(gone[0][night], 1, unit="times", check="K2")
        n[f"lemmon.peak.{night}.lam"] = E([m for m in shots if m["obs"] == c["peak"]][0]["lam"], 3, unit="µm", check="K2")
        n[f"lemmon.peak.{night}.flux"] = E(c["peak_flux"], 1, unit="mJy", check="K2")
    worst = files["worst"]
    n["lemmon.contrast.lowest"] = E(min(worst["feb25"], worst["feb26"]), 1, unit="times", check="K2")
    n["lemmon.contrast.subsets"] = E(len(res["loo"]), 0, check="K2")
    for m in shots:
        if f(m) is None:
            continue
        k = f"lemmon.frame.{short_id(m['key'])}"
        n[k + ".flux"] = E(f(m), 1, err=f(m, what="total"), unit="mJy", check="K2")
        n[k + ".lam"] = E(m["lam"], 3, unit="µm", check="K2")
    for t in res["tests"]:
        k = f"lemmon.template.{short_id(t['key'])}"
        n[k + ".flux"] = E(t["template_flux"], 1, err=t["template_err"], unit="mJy", check="K3", shown=f"{t['template_flux']:+.1f}")
        n[k + ".lam"] = E(t["template_lam"], 3, unit="µm", check="K3")
        n[k + ".percent"] = E(t["percent"], 1, unit="%", check="K3")
        n[k + ".sigma"] = E(t["sigma"], 1, check="K3")
        n[k + ".apart"] = E(abs(t["dlam"]) * 1000.0, 1, unit="nm", check="K3")
    n["lemmon.template.percent.largest"] = E(max(t["percent"] for t in res["tests"]), 1, unit="%", check="K3")
    n["lemmon.template.sigma.smallest"] = E(min(t["sigma"] for t in res["tests"] if not t["peak"]), 1, check="K3")
    n["lemmon.template.apart.largest"] = E(max(abs(t["dlam"]) for t in res["tests"]) * 1000.0, 1, unit="nm", check="K3")
    star = res.get("star")
    if star:
        m, s = star
        n["lemmon.star.lam"] = E(m["lam"], 3, unit="µm", check="K2")
        n["lemmon.star.flux"] = E(f(m), 1, unit="mJy", check="K2")
        n["lemmon.star.pixels"] = E(s["px"], 1, unit="pixels", check="K2", shown=f"{math.floor(s['px']):d} to {math.floor(s['px']) + 1:d}")
        n["lemmon.star.arcsec"] = E(s["px"] * pix, 0, unit="arcsec", check="K2")
        n["lemmon.star.magnitude"] = E(s["g"], 1, unit="Gaia G magnitude", check="K2")
    numbers.write(PRODUCER, n)
    return n


def rules_hold(res: dict) -> tuple[bool, bool]:
    """(K2, K3): the contrast is 5 or more on both nights; every template is under 5% of its comet flux and every
    frame inside the band other than a night's brightest exceeds its template by 5 standard errors."""
    k2 = all(c is not None and c["contrast"] >= 5.0 for c in res["contrast"].values())
    k3 = (len(res["tests"]) > 0 and all(t["percent"] < 5.0 for t in res["tests"])
          and all(t["sigma"] >= 5.0 for t in res["tests"] if not t["peak"]))
    return k2, k3


def status_of(ok: bool, reviewer: Optional[tuple[str, str]]) -> str:
    """FAIL when the rule does not hold; else PASS once a reviewer's role and the date are given, UNVERIFIED before."""
    return ("PASS" if reviewer else "UNVERIFIED") if ok else "FAIL"


def write_rows(shots: list[dict], res: dict, files: dict, reviewer: Optional[tuple[str, str]]) -> tuple[str, str]:
    """Rows K2, K3 and K3-corrected (site/data/checks/rows/p2.json). Returns the status of K2 and of K3."""
    ok2, ok3 = rules_hold(res)
    status = lambda ok: status_of(ok, reviewer)
    on, peak25, below, above = (res[k] for k in ("on", "peak25", "below", "above"))
    c26, c25 = res["contrast"]["feb26"], res["contrast"]["feb25"]
    pix, tests = on["pix_arcsec"], res["tests"]
    measured = sum(flux_of(m, HEADLINE) is not None for m in shots)
    star = res.get("star")
    star_text = ""
    if star:
        m, s = star
        star_text = (f" In the photo at {m['lam']:.3f} µm a star of the Gaia catalogue (G magnitude {s['g']:.1f}) lies "
                     f"{s['px']:.1f} pixels from the comet and adds to its flux; that photo is not one of the three used.")
    k2 = checks.row(
        "K2", "Comet Lemmon: brighter at the colour of carbon dioxide",
        f"On {utc(peak25['mjd']).day} and {day_text(on['mjd'])} the brightest photo of comet C/2025 A6 (Lemmon) inside the "
        f"carbon-dioxide band ({BAND[0]:.2f} to {BAND[1]:.2f} µm) was at least 5 times brighter than the photos taken at the "
        "nearest colours on either side of the band.",
        f"Detector 5 photographed the comet {len(shots)} times on the two nights, each time at another colour; {measured} photos "
        f"could be measured (a photo with too many flagged pixels in the aperture gives no flux). Flux in an aperture of {R_AP} pixels "
        f"({R_AP * pix:.1f} arcsec) radius at the position JPL Horizons gives for the comet seen from SPHEREx; background from a "
        f"ring of {RINGS[HEADLINE][0]:g} to {RINGS[HEADLINE][1]:g} pixels. The fluxes are lower limits, because the comet's glow "
        f"reaches the ring: round the comet at {on['lam']:.3f} µm the sky level falls from {flux_of(on, SECOND, 'bkg'):.2f} MJy/sr at "
        f"{RINGS[SECOND][0]:g} to {RINGS[SECOND][1]:g} pixels to {flux_of(on, HEADLINE, 'bkg'):.2f} in the ring and {on['beyond']:.2f} "
        f"just beyond it, while at the same place in August 2025 it is level ({flux_of(res['aug'], SECOND, 'bkg'):.2f}, "
        f"{flux_of(res['aug'], HEADLINE, 'bkg'):.2f} and {res['aug']['beyond']:.2f}). "
        f"Contrast of a night = the brightest photo of that night inside the band, over the mean of the two "
        f"photos nearest the band: {below['lam']:.3f} µm ({day_month(below['mjd'])}) below it and {above['lam']:.3f} µm "
        f"({day_month(above['mjd'])}) above it, so each night takes one neighbour from the other night. The error counts the "
        f"noise of the pixels, the background, and the scatter of up to {2 * len(EMPTY_OFFSETS)} empty apertures of the same "
        f"colour in each photo. Checks: with a ring of {RINGS[SECOND][0]:g} to {RINGS[SECOND][1]:g} pixels the contrast is "
        f"{res['second']['feb26']['contrast']:.1f} and {res['second']['feb25']['contrast']:.1f}; with an aperture of {R_WIDE} "
        f"pixels {res['wide']['feb26']['contrast']:.1f} and {res['wide']['feb25']['contrast']:.1f}; with every aperture shifted "
        f"by up to {JITTER} pixel it stays between {res['jitter']['feb26'][0]:.1f} and {res['jitter']['feb26'][1]:.1f}, and "
        f"between {res['jitter']['feb25'][0]:.1f} and {res['jitter']['feb25'][1]:.1f}. With any one photo left out that is "
        f"not a night's brightest, the lowest contrast is {min(files['worst']['feb25'], files['worst']['feb26']):.1f}. With "
        f"a night's brightest photo left out, the next brightest gives: {files['no_peak']}; on {day_month(peak25['mjd'])} "
        f"the other photo inside the band sits at its edge, so that night's figure rests on a single photo.{star_text}",
        "The contrast is 5 or more on both nights.",
        status(ok2), "brighter at the colour of carbon dioxide on both nights",
        f"{c26['contrast']:.1f} ± {c26['err']:.1f} ({day_month(on['mjd'])}) and {c25['contrast']:.1f} ± {c25['err']:.1f} "
        f"({day_month(peak25['mjd'])})", "times", "5", "at least",
        checks.image_ref(files["k2"]), reviewer[0] if reviewer else None, reviewer[1] if reviewer else None,
        "python -m sx.run lemmon")
    edge = [t for t in tests if not t["peak"]]
    k3 = checks.row(
        "K3", "Comet Lemmon: the same sky without the comet",
        f"For each of the {len(tests)} photos of the comet taken inside the band, a photo of August 2025 at the same "
        "colour shows nothing at the comet's place: the brightness belongs to the comet, not to that patch of sky.",
        f"For each of the {len(tests)} photos inside the band, the August 2025 photos of detector 5 that hold the same place "
        f"were matched against it by the site's match rule (same detector, closest colour at that place, within half a "
        f"bandwidth); the chosen templates differ in colour by {min(abs(t['dlam']) for t in tests) * 1000:.1f} to "
        f"{max(abs(t['dlam']) for t in tests) * 1000:.1f} nm. Same aperture ({R_AP} pixels) and ring "
        f"({RINGS[HEADLINE][0]:g} to {RINGS[HEADLINE][1]:g} pixels) at the same sky position. Template fluxes: "
        + ", ".join(f"{t['template_flux']:+.1f}" for t in tests) + " mJy against "
        + ", ".join(f"{t['flux']:.1f}" for t in tests) + " mJy for the comet. Standard errors include the scatter of empty "
        "apertures of the same colour in both photos, which in this crowded field is far larger than the noise of the pixels "
        f"(with the noise of the pixels and of the background alone, the smallest excess is {min(t['sigma_noise'] for t in edge):.0f} "
        "standard errors). "
        f"The comet's two brightest positions are {res['sep_arcsec'] / 60:.1f} arcmin and {res['hours']:.1f} hours apart, and "
        f"the centre of its light lies {peak25['centre_offset']:.1f} and {on['centre_offset']:.1f} pixels from the JPL Horizons "
        "position.",
        "Every template flux is under 5% of the comet's flux at that place, and every photo inside the band other than a "
        "night's brightest exceeds its template by 5 standard errors or more.",
        status(ok3), "nothing there in August 2025 at the same colour",
        f"largest template {max(t['percent'] for t in tests):.1f}% of its comet flux; smallest excess "
        f"{min(t['sigma'] for t in edge):.1f} standard errors", None, "5% and 5 standard errors", None,
        checks.image_ref(files["k3"]), reviewer[0] if reviewer else None, reviewer[1] if reviewer else None,
        "python -m sx.run lemmon")
    old = checks.row(
        "K3-corrected", "Comet Lemmon: an earlier figure, corrected",
        "An earlier version of this analysis said the comet's excess inside the band was 88 times the scatter of empty "
        "sky. Measured on enough empty sky it is 4.7 times.",
        "The earlier figure divided the excess by the scatter of the same estimate on 8 tracks of empty apertures, which "
        "happened to miss the stars of the field. On 128 empty tracks, some of which cross stars, the scatter is larger and the same excess "
        "is 4.7 times it. Both figures were measured on 14 November 2026 with an earlier estimate of the excess; this job "
        "does not compute them again, and the site quotes neither: it quotes the contrast of row K2.",
        "Not a pass or fail test: a correction kept on record.", "CORRECTED", "an earlier figure, corrected",
        "4.7", "times the scatter of empty tracks", "88 (the earlier figure)", None, None, None, None, None)
    checks.write_rows(PRODUCER, [k2, k3, old])
    return k2["status"], k3["status"]


def write_sheets(shots: list[dict], res: dict, files: dict, k2: str, k3: str) -> None:
    """review/h1.md and review/h2.md: what to open, the number to read and the rule it passes by."""
    on, off, aug, peak25, above = (res[k] for k in ("on", "off", "aug", "peak25", "above"))
    c26, c25 = res["contrast"]["feb26"], res["contrast"]["feb25"]
    pix, tests = on["pix_arcsec"], res["tests"]
    f = lambda m: flux_of(m, HEADLINE)
    seq = res["sequence"]
    foot = ("Reviewer's role and date are set with `python -m sx.run lemmon --reviewed \"<role>\" <YYYY-MM-DD>` after the "
            "review; that sets rows K2 and K3 to PASS.")
    h1 = [
        "# H1: the comet's colour strip",
        "",
        f"Open `h1.png`. {len(seq) + 1} tiles at one display rule: the same patch of sky on {day_text(aug['mjd'])} and in the",
        f"{len(seq)} photos of {day_text(on['mjd'])} taken about 2 minutes apart, each with its time (UTC), the wavelength at",
        "the comet and the flux in the aperture. Under the tiles: the display rule and the contrast.",
        "",
        "**Number to read**",
        "",
        f"- Contrast on {day_month(on['mjd'])}: {c26['peak_flux']:.1f} / mean({c26['below_flux']:.1f}, {c26['above_flux']:.1f}) = "
        f"{c26['contrast']:.1f} ± {c26['err']:.1f}. The neighbour above the band ({above['lam']:.3f} µm) was taken on "
        f"{day_month(above['mjd'])} and is not among the tiles.",
        "",
        "**It passes if**",
        "",
        "1. Every tile shows the same pixels of sky at the same display rule: the stars sit in the same places from tile to",
        "   tile, and the rule is printed once for all.",
        "2. The wavelengths printed are those of `site/data/lemmon/spectrum.json` ("
        + ", ".join(f"{m['lam']:.4f}" for m in seq) + f" µm; August {aug['lam']:.4f} µm).",
        "3. The contrast is 5 or more.",
        f"4. The August tile is empty at the mark: its flux ({f(aug):+.1f} mJy) is under 5% of the comet's ({f(on):.1f} mJy).",
        "5. No star is hidden: a pixel flagged unusable is drawn with the median of its usable neighbours, nothing else is",
        "   changed, and the marks leave the middle free.",
        f"6. What the caption says about the {off['lam']:.2f} µm tile matches what is visible there: the comet is faint but",
        f"   present ({f(off):.1f} mJy).",
        "",
        f"Status written by the job: {k2} (row K2). {foot}",
        "",
    ]
    (REVIEW / "h1.md").write_text("\n".join(h1), encoding="utf-8", newline="\n")
    worst = files["worst"]
    h2 = [
        "# H2: how we know it is carbon dioxide",
        "",
        "Open `h2.png`. Left: the comet's brightness against colour on both nights, with the two neighbouring photos ringed",
        "and the August 2025 photos of the same places in grey. Right: for each of the photos inside the band, the photo,",
        "the August photo of the same sky at the same colour, and their difference. Under the chart: the headline and its",
        "checks.",
        "",
        "**Number to read**",
        "",
        f"- Contrast: {c26['contrast']:.1f} ± {c26['err']:.1f} on {day_month(on['mjd'])} and {c25['contrast']:.1f} ± {c25['err']:.1f} on "
        f"{day_month(peak25['mjd'])}, with an aperture of {R_AP * pix:.1f} arcsec radius and a ring of "
        f"{RINGS[HEADLINE][0]:g} to {RINGS[HEADLINE][1]:g} pixels.",
        "",
        "**It passes if**",
        "",
        "1. The contrast is 5 or more on both nights, and stays 5 or more when any one photo that is not a night's brightest",
        f"   is left out (lowest: {min(worst['feb25'], worst['feb26']):.1f}).",
        f"2. The page says what follows, or you decide that it need not: with a night's brightest photo left out, the next",
        f"   brightest gives {files['no_peak']}. On {day_month(peak25['mjd'])} the other photo inside the band sits at its edge, so",
        "   that night's figure rests on the brightest.",
        f"3. The headline is quoted with its aperture ({R_AP * pix:.1f} arcsec radius) and its ring "
        f"({RINGS[HEADLINE][0]:g} to {RINGS[HEADLINE][1]:g} pixels), and the fluxes are called lower limits. The contrast itself is",
        f"   not a limit: with the nearer ring it is {res['second']['feb26']['contrast']:.1f} and {res['second']['feb25']['contrast']:.1f}.",
        f"4. Every August template is under 5% of its comet flux (largest: {max(t['percent'] for t in tests):.1f}%), and every photo",
        f"   inside the band other than a night's brightest is above its template by 5 standard errors or more (smallest: "
        f"{min(t['sigma'] for t in tests if not t['peak']):.1f}).",
        "5. The word \"only\" is nowhere on the sheet, and \"first\" and \"discovery\" are nowhere in the comet's captions.",
        "",
        f"Status written by the job: {k2} (row K2) and {k3} (row K3). {foot}",
        "",
    ]
    (REVIEW / "h2.md").write_text("\n".join(h2), encoding="utf-8", newline="\n")


def compare_with_reference(shots: list[dict]) -> list[tuple[str, str, float, float]]:
    """(ring, frame, flux found, reference) for every reference value. The earlier measurements placed the
    aperture at positions interpolated in a table of 20-minute steps; the positions used here are asked from JPL
    Horizons for the middle of each exposure and differ by up to 0.56 arcsec (0.09 pixel). Where that moves a
    pixel across the edge of the aperture the flux changes by several mJy; elsewhere the two agree to 0.01 mJy."""
    by = {m["obs"]: m for m in shots}
    return [(ring, obs, flux_of(by[obs], ring), ref) for ring, d in REFERENCE.items() for obs, ref in d.items() if obs in by]


def main(argv: list[str]) -> int:
    reviewer = None
    if "--reviewed" in argv:
        i = argv.index("--reviewed")
        reviewer = (argv[i + 1], argv[i + 2])
        date.fromisoformat(reviewer[1])
    tables = wave.default_tables()
    keys = frozen.frames_for(JOB, find_frames)
    print(f"{len(keys)} frames in the frozen list")
    ffs = s3.map_threads(FrameFile.open, keys)
    shots = comet_shots(ffs, tables)
    for m in shots:
        m["stars"] = stars_near(m)
    templates = template_shots(ffs, shots, tables)
    res = analyse(shots, templates)
    beside = [(m, m["stars"][0]) for m in shots
              if m["stars"] and m["stars"][0]["px"] <= STAR_TOUCH and flux_of(m, HEADLINE) and STRIP[0] <= m["lam"] <= STRIP[1]]
    res["star"] = min(beside, key=lambda p: p[1]["g"]) if beside else None
    for m in shots:
        r = m["rings"][HEADLINE]
        print(f"{m['obs']} {m['night']} {m['lam']:.4f} µm  " + ("no flux: too many flagged pixels in the aperture" if r is None else
              f"{r['flux']:8.3f} ± {r['total']:.2f} mJy  ({m['rings'][SECOND]['flux']:8.3f} with the second ring)  "
              f"{r['n_use']}/{r['n_ap']} pixels") + (f"  star G {m['stars'][0]['g']:.1f} at {m['stars'][0]['px']:.1f} px" if m["stars"] else ""))
    for ring, obs, got, ref in compare_with_reference(shots):
        print(f"reference {ring} {obs}: {got:.3f} against {ref:.1f} mJy, {got - ref:+.3f}" + ("" if abs(got - ref) <= 0.1 else "  DIFFERENT"))
    files = write_files(shots, templates, res)
    k2, k3 = write_rows(shots, res, files, reviewer)
    write_numbers(shots, templates, res, files)
    write_sheets(shots, res, files, k2, k3)
    for night, c in res["contrast"].items():
        print(f"contrast {night}: {c['contrast']:.2f} ± {c['err']:.2f}  ({c['peak']} over {c['below']} and {c['above']}); "
              f"second ring {res['second'][night]['contrast']:.2f}, wide aperture {res['wide'][night]['contrast']:.2f}, "
              f"moved {res['jitter'][night][0]:.2f} to {res['jitter'][night][1]:.2f}")
    for r in res["loo"]:
        if r["role"] != "other":
            print(f"left out {r['left_out']} ({r['role']}): feb25 {r['feb25']:.2f}, feb26 {r['feb26']:.2f}")
    for t in res["tests"]:
        print(f"template {t['template']} for {t['obs']}: {t['template_flux']:+.3f} ± {t['template_err']:.2f} mJy, "
              f"{t['percent']:.2f}% of {t['flux']:.1f}, {t['sigma']:.1f} standard errors, {t['dlam'] * 1000:+.1f} nm")
    size = files["hero_png"].stat().st_size
    print(f"hero.png {size} bytes; K2 {k2}; K3 {k3}; sheets {files['h1']} and {files['h2']}")
    ok = k2 != "FAIL" and k3 != "FAIL" and size < 150_000
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
