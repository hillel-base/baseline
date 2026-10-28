"""Test data only (playwright.config.ts): gives the cloned development series in <folder> made-up patients, by rewriting the copies' headers
(never the originals): PatientName, PatientID and the dates. Usage: uv run python made_up.py <folder> (from engine/, for pydicom)."""
import sys
from pathlib import Path

from pydicom import dcmread

PLAN = {  # folder: PatientName, PatientID, date. Doe Jane: a baseline and a follow-up 89 days later (timepoint 1); Okafor Sam: one scan.
    "Doe Jane/2025-09 chest CT": ("Doe^Jane", "LAB-0001", "20250912"),
    "Doe Jane/2025-12 chest CT": ("Doe^Jane", "LAB-0001", "20251210"),
    "Okafor Sam/first": ("Okafor^Sam", "LAB-0002", "20260102"),
}
root = Path(sys.argv[1])
for folder, (name, pid, day) in PLAN.items():
    files = sorted(f for f in (root / folder).iterdir() if not f.name.startswith("."))
    assert files and not any(f.is_symlink() for f in files), folder  # copies, never links to the originals
    for f in files:
        ds = dcmread(f)
        ds.PatientName, ds.PatientID = name, pid
        for tag in ("StudyDate", "SeriesDate", "AcquisitionDate", "ContentDate"):
            if tag in ds:
                setattr(ds, tag, day)
        ds.save_as(f)
    print(f"made-up: {folder}, {len(files)} files")
