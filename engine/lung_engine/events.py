import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def _commit() -> str:
    if os.environ.get("LUNG_COMMIT"):  # the practice server has no .git: its build writes the tagged commit here
        return os.environ["LUNG_COMMIT"]
    try:
        git = lambda *a: subprocess.run(["git", "-C", str(REPO), *a], capture_output=True, text=True, check=True).stdout.strip()
        return git("rev-parse", "--short", "HEAD") + ("+dirty" if git("status", "--porcelain") else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


class EventLog:
    def __init__(self, path: Path):
        self.path, self.run, self.commit = Path(path), uuid.uuid4().hex[:8], _commit()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, action: str, **fields):
        t = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        e = {"t": t, "run": self.run, "commit": self.commit, "action": action, **fields}
        if "scan" in fields and "patient" not in fields:
            e["patient"] = fields["scan"].rsplit("_", 1)[0]
        with self.path.open("a") as f:
            f.write(json.dumps(e) + "\n")
