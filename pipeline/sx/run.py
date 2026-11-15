"""Run a job of the pipeline.

    python -m sx.run <job> [arguments of the job]     run pipeline/jobs/<job>.py
    python -m sx.run all                              run every job, in JOB_ORDER and then by name
    python -m sx.run list                             name the jobs

Run it from the pipeline folder. A job is a module in pipeline/jobs/ with a function main(argv) that returns
0 (or None) on success; it writes only below site/data/ (and its frozen list, review sheet and references
file). Jobs that need the network say so in their own help. The job index (pipeline/jobs/index_build.py) also
writes an index of photos, into pipeline/out/ or into the folder it is given; run without arguments, as "all"
runs it, it only says what the site's index holds.
"""
from __future__ import annotations

import importlib
import pkgutil
import sys
import time
import traceback
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]
JOBS = PIPELINE / "jobs"

JOB_ORDER = ["wave_tables", "lines", "placement", "names", "index", "lemmon", "targets", "motion", "rwaur",
             "gaia_fast", "diffcheck", "limits", "gallery", "pluto", "falsepos", "threei", "spectra"]
"""Jobs that depend on others come after them. Jobs not listed run afterwards, alphabetically."""

MODULES = {"index": "index_build"}
"""The jobs whose module is not named as the job is: {job: module}."""


def names() -> list[str]:
    job = {module: name for name, module in MODULES.items()}
    found = sorted(job.get(m.name, m.name) for m in pkgutil.iter_modules([str(JOBS)]) if not m.name.startswith("_"))
    first = [n for n in JOB_ORDER if n in found]
    return first + [n for n in found if n not in first]


def run_job(name: str, argv: list[str]) -> int:
    if str(PIPELINE) not in sys.path:
        sys.path.insert(0, str(PIPELINE))
    mod = importlib.import_module(f"jobs.{MODULES.get(name, name)}")
    if not hasattr(mod, "main"):
        raise SystemExit(f"jobs/{MODULES.get(name, name)}.py has no main(argv)")
    return int(mod.main(argv) or 0)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "list":
        print("\n".join(names()))
        return 0
    if cmd != "all":
        if cmd not in names():
            print(f"no job {cmd!r}; jobs: {', '.join(names())}", file=sys.stderr)
            return 2
        return run_job(cmd, rest)
    failed = []
    for name in names():
        t = time.time()
        print(f"== {name}", flush=True)
        try:
            code = run_job(name, [])
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
        except Exception:
            traceback.print_exc()
            code = 1
        print(f"== {name}: {'ok' if not code else 'FAILED'} ({time.time() - t:.0f} s)", flush=True)
        if code:
            failed.append(name)
    if failed:
        print("failed: " + ", ".join(failed), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
