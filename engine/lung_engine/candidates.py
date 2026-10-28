import contextlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

import SimpleITK as sitk

from .scans import Scan


class FinderMissing(Exception):
    pass


class FinderError(Exception):
    pass


class Finder(Protocol):
    name: str

    def find(self, scan: Scan) -> list[tuple[float, float, float, float]]:
        """(x, y, z in mm, LPS; score 0..1) per mark."""

    def cancel(self) -> None:
        """Ends a run in progress, if any: its find() raises FinderError."""


class NoFinder:
    name = "none"

    def find(self, scan: Scan):
        raise FinderMissing

    def cancel(self):
        pass


class SubprocessFinder:
    """Runs the AGPL-3.0 finder (finder/) as its own process and reads its JSON; the engine never imports it.
    It gets the volume the engine itself loaded, as a temporary file in `work` (runs/), so every scan (data folder or opened folder) is read the same way."""
    name = "subprocess"

    def __init__(self, work: Path, command: list[str] | None = None, timeout: float = 180):
        self.work, self.timeout, self.proc, self.stop = Path(work), timeout, None, False
        self.command = command or ["uv", "run", "--frozen", "--directory", str(Path(__file__).resolve().parents[2] / "finder"), "python", "-m", "lung_finder"]
        for d in self.work.glob("finder-*"):  # left by a run the engine never finished (a watchdog exit, a crash)
            shutil.rmtree(d, ignore_errors=True)

    def cancel(self):
        self.stop = True  # a run still writing its volume ends as soon as its process exists
        p = self.proc
        if p and p.poll() is None:
            with contextlib.suppress(ProcessLookupError):  # it can exit between poll and kill
                os.killpg(p.pid, signal.SIGKILL)

    def find(self, scan: Scan):
        self.stop = False
        self.work.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.work, prefix="finder-") as tmp:  # deleted after the run, whatever happens
            out, image = Path(tmp) / "finds.json", Path(tmp) / "scan.mha"
            try:
                sitk.WriteImage(scan.image, str(image))  # MetaImage keeps the geometry in doubles; the finder reads it with SimpleITK
                # own process group: on timeout the whole tree (uv and the finder Python) is killed, not only uv
                env = {k: v for k, v in os.environ.items() if k != "UV_PROJECT_ENVIRONMENT"}  # the engine's own venv (the practice server): the finder keeps finder/.venv
                self.proc = proc = subprocess.Popen([*self.command, "--image", str(image), "--out", str(out)], stdout=subprocess.PIPE,
                                                    stderr=subprocess.PIPE, text=True, start_new_session=True, env=env)
                if self.stop:  # cancelled while it was starting: self.proc is set first, so a later cancel kills it itself
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(proc.pid, signal.SIGKILL)
                try:
                    _, stderr = proc.communicate(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.communicate()
                    raise
                if proc.returncode:
                    raise FinderError(f"exit code {proc.returncode}: {stderr.strip()[-300:]}")
                data = json.loads(out.read_text())
                self.name = str(data["finder"])
                return [(float(c["x"]), float(c["y"]), float(c["z"]), float(c["score"])) for c in data["candidates"]]
            except subprocess.TimeoutExpired:
                raise FinderError(f"it took longer than {self.timeout:g} s") from None
            except (OSError, ValueError, KeyError, TypeError, RuntimeError) as e:  # bad or missing JSON, no uv, or the volume not written
                raise FinderError(f"{type(e).__name__}: {e}") from None


CUT = 0.43  # the 2-false-marks-per-scan operating point (our measurement)


def to_voxels(scan: Scan, finds, cut: float = CUT) -> list[dict]:
    """Marks at or above the cut, as the engine's own (z, y, x) indices, best first; points outside the volume are dropped."""
    nz, ny, nx = scan.array.shape
    out = []
    for x, y, z, score in finds:
        if score < cut:
            continue
        ix, iy, iz = scan.image.TransformPhysicalPointToIndex((x, y, z))  # SimpleITK order is x, y, z
        if 0 <= iz < nz and 0 <= iy < ny and 0 <= ix < nx:
            image = scan.instance_numbers[iz] if scan.instance_numbers else iz + 1
            out.append({"z": iz, "y": iy, "x": ix, "score": round(float(score), 3), "image": image})
    return sorted(out, key=lambda c: -c["score"])
