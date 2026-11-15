"""The frames that hold comet 3I/ATLAS in the three passes of SPHEREx, as the job threei needs them.

They are the frames of IRSA's table of observations of the comet (August and December 2025, detectors 4 to 6; the
comet's own position is in that table) and of a search of the archive's frame outlines along the comet's track in
spring 2026 (detectors 4 to 6). A frame is written as "<obs>_<exp>D<detector>" under its "<week>/<version>" folder; keys()
turns that into the bucket keys of the contract. The job freezes the keys it uses (pipeline/frozen/obs_ids.json), so
this list is only the first answer to "which frames".
"""
from sx.contracts import KEY_PATTERN

PASSES = {
    "aug": {
        "2025W31_2A/l2b-v27-2026-225": ["0219_1D5", "0219_2D5", "0219_3D5"],
        "2025W32_2D/l2b-v27-2026-226": ["0189_1D5", "0189_2D5", "0189_3D5", "0189_4D5", "0201_1D5", "0201_2D5", "0201_3D5", "0201_4D5", "0213_4D5"],
        "2025W33_1B/l2b-v27-2026-227": ["0010_3D5", "0010_4D5", "0020_1D5", "0020_2D5", "0020_3D5", "0020_4D5", "0049_1D5", "0049_2D5", "0049_3D5", "0049_4D5", "0399_1D5", "0399_2D5", "0399_3D5", "0399_4D5", "0599_1D5"],
    },
    "dec": {
        "2025W50_1A/l2b-v27-2026-209": ["0002_1D4", "0002_2D4", "0002_3D4", "0002_4D4", "0021_1D4", "0021_2D4", "0021_3D4", "0021_4D4", "0038_1D4", "0038_2D4", "0038_3D4", "0038_4D4", "0105_2D4", "0106_1D4", "0106_2D4", "0106_3D4", "0106_4D4", "0120_1D4", "0348_1D5", "0348_2D5", "0348_3D5", "0348_4D5"],
        "2025W50_2A/l2b-v27-2026-210": ["0685_1D5", "0685_2D5", "0685_3D5", "0685_4D5", "0698_1D5", "0698_2D5", "0698_3D5", "0698_4D5", "0712_1D5", "0712_2D5", "0712_3D5", "0712_4D5", "0827_1D5", "0741_2D6", "0741_3D6", "0741_4D6", "0755_2D6", "0755_3D6", "0755_4D6", "0797_1D6", "0797_2D6", "0797_4D6", "0813_1D6", "0813_2D6", "0813_4D6"],
    },
    "apr": {
        "2026W12_1A/l2b-v27-2026-235": ["0291_1D6", "0291_2D6", "0291_3D6", "0291_4D6", "0537_1D6", "0537_2D6", "0537_3D6", "0537_4D6"],
        "2026W12_2A/l2b-v27-2026-235": ["0082_1D5", "0082_2D5", "0082_3D5", "0082_4D5", "0425_1D5", "0425_2D5", "0425_3D5", "0425_4D5", "0146_1D6", "0146_2D6", "0146_3D6", "0146_4D6", "0450_1D6", "0511_1D6", "0511_2D6", "0511_3D6", "0511_4D6"],
        "2026W13_1A/l2b-v27-2026-236": ["0044_1D5", "0044_3D5", "0044_4D5"],
        "2026W13_1A/l2b_retry-v27-2026-236": ["0044_2D5"],
        "2026W13_2A/l2b-v27-2026-237": ["0472_1D4", "0472_2D4", "0485_1D4", "0485_2D4", "0485_3D4", "0485_4D4", "0392_1D5", "0447_1D5", "0447_2D5", "0447_3D5", "0447_4D5", "0658_1D5", "0353_1D6"],
        "2026W14_1A/l2b-v27-2026-238": ["0100_1D4", "0100_2D4", "0217_2D4", "0471_1D4"],
        "2026W14_1A/l2b_retry-v27-2026-238": ["0217_3D4"],
        "2026W14_2A/l2b-v27-2026-238": ["0005_1D4"],
        "2026W15_1A/l2b-v27-2026-239": ["0010_1D4"],
    },
}


def keys(which: str) -> list[str]:
    """Bucket keys of one pass: "aug", "dec" or "apr"."""
    out = []
    for wv, frames in PASSES[which].items():
        week, ver = wv.split("/")
        for f in frames:
            obs, rest = f.split("_")
            out.append(KEY_PATTERN.format(week=week, ver=ver, det=rest[2:], obs=int(obs), exp=rest[0]))
    return sorted(out)
