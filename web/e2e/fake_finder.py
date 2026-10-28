"""A stand-in nodule finder for the e2e (same command line as lung_finder): four fixed marks in voxels, written as mm (LPS); 2 and 4 on nearby images."""
import json, sys, time
from pathlib import Path
import SimpleITK as sitk

a = sys.argv
img, out = sitk.ReadImage(a[a.index("--image") + 1]), a[a.index("--out") + 1]
slow = Path(__file__).with_name("finder-slow.flag")  # the scan-switch e2e: one run long enough to be stopped
if slow.exists():
    slow.unlink()  # one run only: the page waits for the flag to go, so it knows the slow run has started
    time.sleep(30)
time.sleep(1.5)  # long enough for the page to show "Looking…"
marks = [((330, 321, 161), 0.9), ((250, 200, 100), 0.6), ((180, 300, 212), 0.5), ((400, 300, 102), 0.45)]  # (x, y, z) voxels, score
cands = [dict(zip("xyz", img.TransformIndexToPhysicalPoint(v)), score=s) for v, s in marks]
json.dump({"finder": "fake finder", "candidates": cands, "seconds": 1.5}, open(out, "w"))
