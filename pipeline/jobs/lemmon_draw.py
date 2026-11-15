"""The pictures of the lemmon job. Not a job of its own: `python -m sx.run lemmon` draws them.

One display rule serves every picture of the comet, the same rule the first page uses when it draws the photos
itself: each photo has its own sky level taken off; black is 2 times the sky noise below the sky, white is the
comet's peak, and in between the grey follows an asinh curve whose bend is 3 times the sky noise. Under a
straight (linear) rule the comet at 4.19 µm would be too dark to see, and "small" would read as "absent".
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import Optional, Sequence

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from sx import phot, render, stack  # noqa: E402
from sx.contracts import DIFF_RANGE  # noqa: E402

BLACK_NOISE, SOFTEN_NOISE, PEAK_RADIUS = -2.0, 3.0, 2
"""The display rule, in units of the sky noise, and the radius in which the peak is looked for (pixels)."""

PAGE, INK_ON_DARK, MUTED_ON_DARK, MARK, MARK_ALT = "#0a0c10", "#e8eaed", "#a9b1bc", "#7af0d0", "#ffd166"
"""Colours of the pictures shown on the site: the page's background, its text, and its two marks."""
INK, BLUE, ORANGE, GREY, BAND_FILL = "#1b1f23", "#1f5fa8", "#c45a00", "#8a8f98", "#dbe8f8"
"""Colours of the pictures of the Checks page and of the review sheets, on white."""
MISSING = tuple(c / 255 for c in render.NAN_RGB)


def main(argv: list[str]) -> int:
    print("lemmon_draw holds the pictures of the lemmon job; run `python -m sx.run lemmon`.")
    return 0


# -- the display rule ---------------------------------------------------------------------------------


def sky_of(data: np.ndarray, flags: Optional[np.ndarray] = None) -> tuple[float, float]:
    """(sky level, sky noise) of a stamp by the shared rule (CT-7, sx.stack.stamp_stats)."""
    s = stack.stamp_stats(data, flags)
    return s["background"], s["noise"]


def display_rule(photos: Sequence[tuple[np.ndarray, Optional[np.ndarray], float, float]]) -> dict:
    """The one rule for a set of photos, each given as (data, flags, tx, ty): {noise, black, white, soften} in
    MJy/sr above the sky of each photo. The noise is that of the quietest photo; white is the brightest usable
    pixel within PEAK_RADIUS pixels of a target over all the photos. A pixel flagged unusable (sx.phot.BAD_MASK)
    never sets white: a cosmic-ray hit beside the comet would otherwise make every photo look dim."""
    noise, peak = math.inf, -math.inf
    for data, flags, tx, ty in photos:
        sky, n = sky_of(data, flags)
        if n > 0:
            noise = min(noise, n)
        h, w = data.shape
        x0, y0 = int(math.floor(tx + 0.5)), int(math.floor(ty + 0.5))
        for y in range(y0 - PEAK_RADIUS, y0 + PEAK_RADIUS + 1):
            for x in range(x0 - PEAK_RADIUS, x0 + PEAK_RADIUS + 1):
                if 0 <= x < w and 0 <= y < h and math.hypot(x - tx, y - ty) <= PEAK_RADIUS + 0.5:
                    if flags is not None and int(flags[y, x]) & phot.BAD_MASK:
                        continue
                    v = float(data[y, x]) - sky
                    if math.isfinite(v):
                        peak = max(peak, v)
    if not (math.isfinite(noise) and math.isfinite(peak)):
        raise ValueError("the photos give no display rule")
    black = BLACK_NOISE * noise
    return {"noise": noise, "black": black, "white": max(peak, black + 10 * noise), "soften": SOFTEN_NOISE * noise}


def grey(v: np.ndarray, rule: dict) -> np.ndarray:
    """0 (black) to 1 (white) for values in MJy/sr above the sky; NaN stays NaN."""
    lo = math.asinh(rule["black"] / rule["soften"])
    g = (np.arcsinh(np.asarray(v, float) / rule["soften"]) - lo) / (math.asinh(rule["white"] / rule["soften"]) - lo)
    return np.clip(g, 0.0, 1.0)


def rgb_of(v: np.ndarray, rule: dict) -> np.ndarray:
    """(h, w, 3) floats for imshow: the grey of the rule, and the colour for missing values where v is NaN."""
    g = grey(v, rule)
    out = np.repeat(np.where(np.isnan(g), 0.0, g)[..., None], 3, axis=2)
    out[np.isnan(g)] = MISSING
    return out


def rgb_of_difference(units: np.ndarray) -> np.ndarray:
    """A difference in units of its noise on the fixed scale from -DIFF_RANGE (black) to +DIFF_RANGE (white)."""
    g = np.clip((np.asarray(units, float) + DIFF_RANGE) / (2 * DIFF_RANGE), 0.0, 1.0)
    out = np.repeat(np.where(np.isnan(g), 0.0, g)[..., None], 3, axis=2)
    out[np.isnan(g)] = MISSING
    return out


# -- helpers ------------------------------------------------------------------------------------------


def save(fig, path: Path, dpi: int = 100) -> Path:
    """Write a figure as a PNG without the alpha channel and without any text chunk: the same bytes every run."""
    fig.set_dpi(dpi)
    fig.canvas.draw()
    rgba = np.asarray(fig.canvas.buffer_rgba())
    plt.close(fig)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(render.png_bytes(np.ascontiguousarray(rgba[..., :3])))
    return path


def show(ax, rgb: np.ndarray, mark: Optional[tuple[float, float]] = None, colour: str = MARK) -> None:
    """One photo in an axes, one square for each pixel, the first row at the bottom; `mark` draws four short
    lines round a pixel position without covering it."""
    h, w = rgb.shape[:2]
    ax.imshow(rgb, origin="lower", interpolation="nearest", extent=(-0.5, w - 0.5, -0.5, h - 0.5))
    ax.set_xlim(-0.5, w - 0.5)
    ax.set_ylim(-0.5, h - 0.5)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    if mark is not None:
        x, y = mark
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ax.plot([x + 4 * dx, x + 7 * dx], [y + 4 * dy, y + 7 * dy], color=colour, lw=1.6, solid_capstyle="butt")


def crop(img: np.ndarray, size: int) -> np.ndarray:
    """The middle size by size pixels of a square image with an odd side."""
    a = (img.shape[0] - size) // 2
    return img[a : a + size, a : a + size]


# -- pictures shown on the site -------------------------------------------------------------------------


def hero_png(path: Path, panels: Sequence[dict], rule: dict, scale: int = 8, gap: int = 8) -> Path:
    """The three panels side by side. A panel is {image, lines, mark}: `image` in MJy/sr above its sky on one
    common grid, `lines` the date and the wavelength, `mark` the comet's place in grid pixels. No other text."""
    n = len(panels)
    side = panels[0]["image"].shape[0] * scale
    width, height = n * side + (n - 1) * gap, side
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100, facecolor=PAGE)
    for i, p in enumerate(panels):
        ax = fig.add_axes([i * (side + gap) / width, 0, side / width, 1])
        show(ax, rgb_of(p["image"], rule), p.get("mark"))
        ax.text(0.03, 0.97, "\n".join(p["lines"]), transform=ax.transAxes, ha="left", va="top", color="white",
                fontsize=10.5, fontweight="bold", linespacing=1.35,
                bbox=dict(boxstyle="round,pad=0.35", facecolor="black", edgecolor="none", alpha=0.6))
    return save(fig, path)


def strip_png(path: Path, rows: Sequence[tuple[str, Sequence[dict]]], rule: dict, size: int = 31, scale: int = 5) -> Path:
    """The colour strips: one row of photos for each night, in order of wavelength. A tile is {image, lines,
    mark, inside}; tiles inside the band have a line of the mark colour under them."""
    side, gap, left, foot, top = size * scale, 10, 150, 46, 8
    cols = max(len(t) for _, t in rows)
    width, height = left + cols * (side + gap), len(rows) * (side + foot + top)
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100, facecolor=PAGE)
    for r, (label, tiles) in enumerate(rows):
        bottom = height - (r + 1) * (side + foot + top) + foot
        fig.text(12 / width, (bottom + side / 2) / height, label, color=INK_ON_DARK, fontsize=11, fontweight="bold",
                 ha="left", va="center")
        for c, t in enumerate(tiles):
            x = left + c * (side + gap)
            ax = fig.add_axes([x / width, bottom / height, side / width, side / height])
            cut_off = (t["image"].shape[0] - size) // 2
            mark = t.get("mark") and (t["mark"][0] - cut_off, t["mark"][1] - cut_off)
            show(ax, rgb_of(crop(t["image"], size), rule), mark)
            fig.text((x + side / 2) / width, (bottom - 6) / height, "\n".join(t["lines"]), color=INK_ON_DARK,
                     fontsize=9.5, ha="center", va="top", linespacing=1.3)
            if t.get("inside"):
                fig.add_artist(plt.Line2D([x / width, (x + side) / width], [(bottom - 2.5) / height] * 2, color=MARK, lw=2.5))
    return save(fig, path)


def rows_size(n: int, numbers: bool, size: int = 41, scale: int = 4) -> tuple[int, int]:
    """Width and height in pixels of the picture that rows_figure draws for n rows."""
    return 112 + 3 * (size * scale + 8) + (232 if numbers else 0), 44 + n * (size * scale + 8) + 40


def rows_figure(rows: Sequence[dict], rule: dict, dark: bool, numbers: bool, fig=None, box=(0, 0, 1, 1),
                size: int = 41, scale: int = 4):
    """Frame, template and difference for each photo inside the band, one row each. A row is {frame, template,
    units, lines, text, mark}: `frame` and `template` in MJy/sr above their sky on the frame's grid, `units` the
    difference in units of its noise. With `numbers`, `text` is written to the right of the row.
    Draws into `box` (left, bottom, width, height as fractions) of `fig`, or makes a figure of its own."""
    side, gap, left, top, foot = size * scale, 8, 112, 44, 40
    right = 232 if numbers else 0
    width, height = left + 3 * (side + gap) + right, top + len(rows) * (side + gap) + foot
    own = fig is None
    ink = INK_ON_DARK if dark else INK
    if own:
        fig = plt.figure(figsize=(width / 100, height / 100), dpi=100, facecolor=PAGE if dark else "white")
    fx = lambda px: box[0] + box[2] * px / width
    fy = lambda px: box[1] + box[3] * px / height
    heads = ["February 2026:\nthe comet", "August 2025:\nsame sky, same colour", "difference"]
    for c, head in enumerate(heads):
        fig.text(fx(left + c * (side + gap) + side / 2), fy(height - 6), head, color=ink, fontsize=9.5,
                 fontweight="bold", ha="center", va="top", linespacing=1.25)
    fig.text(fx(10), fy(foot - 8), "Difference: the comet's photo minus the August photo placed on its pixels, in units of the noise,\n"
             f"from -{DIFF_RANGE} (black) to +{DIFF_RANGE} (white). Dark violet: no value, a pixel flagged in one of the two photos.",
             color=ink, fontsize=8, ha="left", va="top", linespacing=1.35)
    for r, row in enumerate(rows):
        bottom = height - top - (r + 1) * (side + gap) + gap
        fig.text(fx(10), fy(bottom + side / 2), "\n".join(row["lines"]), color=ink, fontsize=9.5, ha="left",
                 va="center", linespacing=1.35)
        pics = [rgb_of(crop(row["frame"], size), rule), rgb_of(crop(row["template"], size), rule),
                rgb_of_difference(crop(row["units"], size))]
        for c, rgb in enumerate(pics):
            ax = fig.add_axes([fx(left + c * (side + gap)), fy(bottom), box[2] * side / width, box[3] * side / height])
            show(ax, rgb, row.get("mark"))
        if numbers:
            fig.text(fx(left + 3 * (side + gap) + 6), fy(bottom + side / 2), row["text"], color=ink, fontsize=9,
                     ha="left", va="center", linespacing=1.4)
    return fig, (width, height)


def track_figure(track: dict, insets: Sequence[dict], rule: dict, dark: bool):
    """The comet's path over the two nights as seen from SPHEREx, with the two places where it was photographed
    inside the band and, for each, the photo of August 2025 and of February 2026. Offsets are in arcmin from
    the middle of the path, north up and east to the left."""
    ink, muted, face = (INK_ON_DARK, MUTED_ON_DARK, PAGE) if dark else (INK, GREY, "white")
    fig = plt.figure(figsize=(9.6, 5.6), dpi=100, facecolor=face)
    ax = fig.add_axes([0.08, 0.11, 0.56, 0.84], facecolor=face)
    pts = np.array([[p["east"], p["north"]] for p in track["path"]])
    ax.plot(pts[:, 0], pts[:, 1], color=muted, lw=1.2)
    sh = np.array([[p["east"], p["north"]] for p in track["photos"]])
    ax.plot(sh[:, 0], sh[:, 1], "o", ms=3.5, color=ink, mec="none")
    for p in track["places"]:
        ax.plot([p["east"]], [p["north"]], "o", ms=13, mfc="none", mec=MARK if dark else ORANGE, mew=1.8)
        west = p["east"] < 0
        ax.annotate(p["label"], (p["east"], p["north"]), textcoords="offset points", xytext=(-14 if west else 14, 12),
                    color=ink, fontsize=9.5, ha="right" if west else "left")
    ax.invert_xaxis()
    ax.set_aspect("equal", adjustable="datalim")
    ax.set_xlabel("east of the middle of the path (arcmin)", color=ink)
    ax.set_ylabel("north of the middle of the path (arcmin)", color=ink)
    ax.tick_params(colors=muted)
    for s in ax.spines.values():
        s.set_color(muted)
    for i, ins in enumerate(insets):
        y = 0.56 - i * 0.47
        fig.text(0.68, y + 0.385, ins["title"], color=ink, fontsize=9.5, fontweight="bold", ha="left", va="bottom")
        for j, (img, cap) in enumerate(((ins["early"], ins["early_label"]), (ins["late"], ins["late_label"]))):
            a = fig.add_axes([0.68 + j * 0.155, y + 0.06, 0.145, 0.145 * 9.6 / 5.6])
            show(a, rgb_of(crop(img, 41), rule), ins.get("mark"))
            fig.text(0.68 + j * 0.155 + 0.0725, y + 0.05, cap, color=ink, fontsize=8.5, ha="center", va="top")
    return fig


# -- the chart and the sheets (Checks page and reviews: on white, with numbers) -------------------------


def spectrum_axes(ax, spec: dict) -> None:
    """Brightness against wavelength for both nights, the templates, the band and the two neighbours."""
    ax.axvspan(spec["band"][0], spec["band"][1], color=BAND_FILL, lw=0, zorder=0)
    ax.text(sum(spec["band"]) / 2, 0.985, "carbon-dioxide band", transform=ax.get_xaxis_transform(), ha="center",
            va="top", fontsize=8.5, color=BLUE)
    for night, colour, marker, name in (("feb25", BLUE, "o", "25 February 2026"), ("feb26", ORANGE, "s", "26 February 2026")):
        pts = sorted((p for p in spec["photos"] if p["night"] == night and p["flux"] is not None), key=lambda p: p["lam"])
        ax.errorbar([p["lam"] for p in pts], [p["flux"] for p in pts], yerr=[p["err"] for p in pts], fmt=marker, ms=6,
                    color=colour, mec="white", mew=1, elinewidth=1.2, capsize=2.5, label=name, zorder=3)
        ax.plot([p["lam"] for p in pts], [p["flux"] for p in pts], color=colour, lw=0.9, alpha=0.5, zorder=2)
    tp = spec["templates"]
    ax.errorbar([t["template_lam"] for t in tp], [t["template_flux"] for t in tp], yerr=[t["template_err"] for t in tp],
                fmt="D", ms=5, color=GREY, mec="white", elinewidth=1, capsize=2.5, zorder=3,
                label="same sky and colour, August 2025 (no comet)")
    by = {p["obs"]: p for p in spec["photos"]}
    c = spec["contrast"]["feb26"]
    for obs, word in ((c["below"], "neighbour\nbelow"), (c["above"], "neighbour\nabove")):
        p = by[obs]
        ax.plot([p["lam"]], [p["flux"]], "o", ms=13, mfc="none", mec=INK, mew=1.1, zorder=4)
        ax.annotate(word, (p["lam"], p["flux"]), textcoords="offset points", xytext=(0, 12), ha="center", fontsize=8,
                    color=INK, linespacing=1.1)
    star = [p for p in spec["photos"] if p.get("star_in_aperture") and p["flux"] is not None]
    if star:
        ax.plot([p["lam"] for p in star], [p["flux"] for p in star], "D", ms=12, mfc="none", mec=GREY, mew=1.1, zorder=4,
                label="a catalogue star in the aperture adds to this flux")
    ax.axhline(0, color=GREY, lw=0.7)
    ax.set_xlabel("colour: wavelength at the comet's pixel (µm)")
    ax.set_ylabel(f"flux in a {spec['aperture_px']}-pixel aperture (mJy), a lower limit")
    ax.legend(fontsize=8, frameon=False, loc="upper left")
    ax.spines[["top", "right"]].set_visible(False)


def spectrum_title(spec: dict) -> str:
    c26, c25 = spec["contrast"]["feb26"], spec["contrast"]["feb25"]
    return (f"Brightest photo inside the band over the mean of its two neighbours: "
            f"{c26['contrast']:.1f} ± {c26['err']:.1f} on 26 February 2026, {c25['contrast']:.1f} ± {c25['err']:.1f} on 25 February 2026\n"
            f"Aperture {spec['aperture_px']} pixels ({spec['aperture_arcsec']:.1f} arcsec) in radius, background ring "
            f"{spec['ring_px'][0]:g} to {spec['ring_px'][1]:g} pixels")


def contrast_png(path: Path, spec: dict) -> Path:
    fig, ax = plt.subplots(figsize=(10.0, 5.2), dpi=110, facecolor="white")
    spectrum_axes(ax, spec)
    ax.set_title(spectrum_title(spec), fontsize=9, loc="left")
    fig.tight_layout()
    return save(fig, path, dpi=110)


def evidence_png(path: Path, spec: dict, rows: Sequence[dict], rule: dict, lines: Sequence[str]) -> Path:
    """Review sheet H2: the chart, the five rows and the headline in one picture."""
    wide, high = 1600, 1010
    fig = plt.figure(figsize=(wide / 100, high / 100), dpi=100, facecolor="white")
    ax = fig.add_axes([0.055, 0.40, 0.40, 0.50])
    spectrum_axes(ax, spec)
    fig.text(0.02, 0.975, spectrum_title(spec), fontsize=10, ha="left", va="top", fontweight="bold", color=INK)
    fig.text(0.02, 0.33, "\n".join(lines), fontsize=9.5, ha="left", va="top", color=INK, linespacing=1.5)
    w, h = rows_size(len(rows), True)
    scale = 0.9 * high / h  # the rows keep their shape: one factor for both directions
    rows_figure(rows, rule, dark=False, numbers=True, fig=fig, box=(0.48, 0.02, scale * w / wide, scale * h / high))
    return save(fig, path)


def hero_sheet_png(path: Path, tiles: Sequence[dict], rule: dict, lines: Sequence[str], size: int = 41, scale: int = 6) -> Path:
    """Review sheet H1: the August photo and the photos of the comet's night in one row, each with its time,
    wavelength and flux printed, and the display rule under them."""
    side, gap, top, foot = size * scale, 12, 30, 80 + 17 * len(lines)
    width, height = len(tiles) * (side + gap) + gap, top + side + foot
    fig = plt.figure(figsize=(width / 100, height / 100), dpi=100, facecolor="white")
    for i, t in enumerate(tiles):
        x = gap + i * (side + gap)
        ax = fig.add_axes([x / width, foot / height, side / width, side / height])
        show(ax, rgb_of(crop(t["image"], size), rule), t.get("mark"))
        fig.text((x + side / 2) / width, (foot + side + 6) / height, t["title"], fontsize=9.5, fontweight="bold",
                 ha="center", va="bottom", color=INK)
        fig.text((x + side / 2) / width, (foot - 6) / height, "\n".join(t["lines"]), fontsize=9, ha="center", va="top",
                 color=INK, linespacing=1.35)
    fig.text(gap / width, (foot - 70) / height, "\n".join(lines), fontsize=9, ha="left", va="top", color=INK, linespacing=1.45)
    return save(fig, path)
