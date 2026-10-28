"""F accuracy (protocol §Follow-up matching): does the tool's follow-up matching put its mark on the tumour?
For each pair: a click on the test scan at R1's voxel nearest its centre (S2's method), mapped to the retest scan by the
engine's own code (lung_engine.followup register and map_index, and its scan loader), imported from a fixed, clean
checkout. A hit: within HIT_MM of the retest R1's centre (the lab's research fellow); also whether the mark is inside R1. RIDER has
one tumour per scan, so "nearer to it than to any other nodule" is not tested. The alignment runs on the CPU only, so no
engine server and no graphics chip are needed.
Opens the development and held-out patients; the timed ones only with --after-timed-runs (protocol §Cases).
Per-pair rows go to <out dir>/f_pairs.csv (out of git until the timed runs end); totals per group to eval/runs/f_summary.csv.
Usage: python -I eval/f_accuracy.py <data/rider> <engine checkout> <out dir> [--after-timed-runs]"""
import csv, os, statistics, subprocess, sys, time
from pathlib import Path
import numpy as np, SimpleITK as sitk
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from rider import load_seg, manual_mask

HIT_MM = 10  # the lab's research fellow: "a mark within 1 cm is usually enough to draw my eye to the right area" (2026-10-25)

def centre_voxel(m):
    v = np.argwhere(m); return tuple(int(i) for i in v[np.argmin(((v - v.mean(0)) ** 2).sum(1))])

def score(p, r1, img):
    """(distance in mm from voxel p (z, y, x) to R1's centre, p inside R1)."""
    c = np.argwhere(r1).mean(0)
    centre = np.array(img.TransformContinuousIndexToPhysicalPoint([float(c[2]), float(c[1]), float(c[0])]))
    return float(np.linalg.norm(np.array(img.TransformIndexToPhysicalPoint([int(p[2]), int(p[1]), int(p[0])])) - centre)), bool(r1[p])

# self-check: a ball on a 0.7 x 0.7 x 1.25 mm grid; its centre voxel is a 0 mm hit, 8 voxels along x is 5.6 mm and outside
_img = sitk.Image(40, 40, 20, sitk.sitkInt16); _img.SetSpacing((0.7, 0.7, 1.25))
_g = np.indices((20, 40, 40)); _b = ((_g[0] - 10) * 1.25) ** 2 + ((_g[1] - 20) * 0.7) ** 2 + ((_g[2] - 20) * 0.7) ** 2 <= 16
assert centre_voxel(_b) == (10, 20, 20) and score((10, 20, 20), _b, _img) == (0.0, True)
_d, _in = score((10, 20, 28), _b, _img); assert abs(_d - 5.6) < 1e-6 and not _in, (_d, _in)

def summary(rows):
    out = []
    for g in ["all"] + sorted({r["role"] for r in rows}):
        rs = [r for r in rows if g == "all" or r["role"] == g]
        d = [r["dist_mm"] for r in rs]
        out.append(dict(group=g, pairs=len(rs), hits=sum(r["hit"] for r in rs), inside=sum(r["inside"] for r in rs),
                        median_mm=round(statistics.median(d), 1), max_mm=max(d), median_seconds=statistics.median(r["seconds"] for r in rs)))
    return out

if __name__ == "__main__":
    root, co, out = sys.argv[1:4]
    after = "--after-timed-runs" in sys.argv
    assert not subprocess.run(["git", "-C", co, "status", "--porcelain"], capture_output=True, text=True).stdout, f"{co} is not clean"
    sha = subprocess.run(["git", "-C", co, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    sys.path.insert(0, os.path.join(co, "engine"))
    from lung_engine.followup import map_index, register
    from lung_engine.scans import load_scan
    roles = {"dev", "heldout"} | ({"timed"} if after else set())  # timed patients wait for the end of the timed runs
    rows = []
    for c in csv.DictReader(open(os.path.join(here, "cases.csv"))):
        if c["role"] not in roles: continue
        p = c["patient"]
        a, b = load_scan(Path(root), f"{p}_test"), load_scan(Path(root), f"{p}_retest")
        r1a, r1b = (manual_mask(load_seg(os.path.join(root, p, f"lungctseg_{s}"), x.image)).astype(bool) for s, x in (("test", a), ("retest", b)))
        click = centre_voxel(r1a)
        t0 = time.perf_counter(); to = map_index(register(a.image, b.image), a.image, b.image, click); sec = time.perf_counter() - t0
        d, inside = score(to, r1b, b.image)
        rows.append(dict(patient=p, role=c["role"], click_z=click[0], click_y=click[1], click_x=click[2], to_z=to[0], to_y=to[1], to_x=to[2],
                         dist_mm=round(d, 1), inside=inside, hit=d <= HIT_MM, seconds=round(sec, 1), engine=sha))
        print(p, c["role"], f"{d:.1f} mm", "hit" if d <= HIT_MM else "MISS", "inside" if inside else "outside", f"{sec:.1f} s", flush=True)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "f_pairs.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    tot = summary(rows)
    with open(os.path.join(here, "runs", "f_summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["engine"] + list(tot[0])); w.writeheader(); w.writerows(dict(t, engine=sha) for t in tot)
    for t in tot: print(t)
