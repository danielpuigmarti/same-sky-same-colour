"""The flags of a SPHEREx Level 2 image: the Python twin of site/js/lib/flags.js (same names, bits and tiers; a test
holds the two together).

Tiers: saturation (too bright to be measured well), defect (the value cannot be trusted), source (a known star or
galaxy, no defect), none (never excludes a pixel)."""
from __future__ import annotations

FLAG_TABLE: tuple[tuple[int, str, str], ...] = (
    (0, "TRANSIENT", "defect"),
    (1, "OVERFLOW", "saturation"),
    (2, "SUR_ERROR", "defect"),
    (6, "NONFUNC", "defect"),
    (7, "DICHROIC", "none"),
    (9, "MISSING_DATA", "defect"),
    (10, "HOT", "defect"),
    (11, "COLD", "defect"),
    (12, "FULLSAMPLE", "none"),
    (14, "PHANMISS", "none"),
    (15, "NONLINEAR", "saturation"),
    (17, "PERSIST", "defect"),
    (19, "OUTLIER", "defect"),
    (20, "CROSSTALK", "defect"),
    (21, "SOURCE", "source"),
    (22, "GHOST", "defect"),
    (23, "GHOST_FPA", "defect"),
    (24, "GHOST_EXT", "defect"),
    (25, "STREAK", "defect"),
    (26, "BLOOM", "saturation"),
    (27, "SNOWBALL", "defect"),
    (28, "HALO", "defect"),
)


def mask_of(tier: str) -> int:
    word = 0
    for bit, _, t in FLAG_TABLE:
        if t == tier:
            word |= 1 << bit
    return word


SATURATION_MASK = mask_of("saturation")
DEFECT_MASK = mask_of("defect")
SOURCE_MASK = mask_of("source")
