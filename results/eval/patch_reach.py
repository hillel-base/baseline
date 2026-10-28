"""Which RIDER tumours could be cut by the tool's patch edge (autozoom off: the outline stops at the model window's edge, 80 voxels from the click).
For each scan, how far the expert outline (R1) reaches from a click at its deepest voxel (Q3's click) and at the voxel
nearest its centre (where a person clicks), per axis, in voxels. An estimate from R1, which is bigger than the radiologists'.
Prints counts only (blinding); per-scan rows go to the git-ignored output CSV.
Usage: python -I eval/patch_reach.py <data/rider> data/eval/patch_reach.csv"""
import csv, glob, os, sys
import numpy as np
from scipy import ndimage
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask

HALF = 80  # half the 160-voxel window the tool adopted from our feasibility test S6 on 2026-10-25 (was 96 at 192), autozoom off

def deepest(m):
    """Voxel deepest inside the largest piece of m (as spike S1 and Q3), on the bounding box so it stays light."""
    lab, _ = ndimage.label(m)
    big = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1
    sl = ndimage.find_objects(big.astype(np.uint8))[0]
    crop = np.pad(big[sl], 1)
    return tuple(int(i + s.start - 1) for i, s in zip(np.unravel_index(np.argmax(ndimage.distance_transform_edt(crop)), crop.shape), sl))

def centre(m):
    zyx = np.argwhere(m)
    return tuple(int(i) for i in zyx[np.argmin(((zyx - zyx.mean(0)) ** 2).sum(1))])

def reach(m, c):
    """Largest |offset| from c to any mask voxel, per axis (z, y, x)."""
    zyx = np.argwhere(m)
    return tuple(int(v) for v in np.abs(zyx - np.array(c)).max(0))

_g = np.indices((21, 21, 31)); _t = ((_g[0] - 10) ** 2 + (_g[1] - 12) ** 2 + (_g[2] - 15) ** 2 <= 25).astype(np.uint8)
assert deepest(_t) == centre(_t) == (10, 12, 15) and reach(_t, (10, 12, 15)) == (5, 5, 5)  # self-check: a ball of radius 5

if __name__ == "__main__":  # importable for deepest() (eval/q3.py)
    root, out = sys.argv[1], sys.argv[2]
    role = {r["patient"]: r["role"] for r in csv.DictReader(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cases.csv")))}
    rows = []
    for p in sorted(glob.glob(os.path.join(root, "RIDER-*"))):
        pid = os.path.basename(p)
        if pid not in role: continue
        for s in ("test", "retest"):
            ct = load_ct(os.path.join(p, f"ct_{s}")); m = manual_mask(load_seg(os.path.join(p, f"lungctseg_{s}"), ct))
            r = dict(patient=pid, role=role[pid], scan=s, pixel_mm=round(ct.GetSpacing()[0], 3), slice_mm=round(ct.GetSpacing()[2], 3))
            for k, c in (("deepest", deepest(m)), ("centre", centre(m))):
                r.update({f"{k}_reach_{a}": v for a, v in zip("zyx", reach(m, c))})
                r[f"{k}_edge"] = max(reach(m, c)) >= HALF - 1  # the window runs from click-80 to click+79
                r[f"{k}_near"] = max(reach(m, c)) >= HALF - 10
            rows.append(r); print(pid, s, flush=True)  # progress only

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    for k in ("deepest", "centre"):
        for t, lim in (("edge", HALF - 1), ("near", HALF - 10)):
            by = {g: sum(r[f"{k}_{t}"] for r in rows if r["role"] == g) for g in ("dev", "timed", "heldout")}
            print(f"click at {k}: {sum(by.values())} of {len(rows)} scans reach >= {lim} voxels; by role {by}")
        print(f"click at {k}: furthest reach {max(max(int(r[f'{k}_reach_{a}']) for a in 'zyx') for r in rows)} voxels")
    for r in rows:  # dev cases may be named
        if r["role"] == "dev":
            print(r["patient"], r["scan"], {k: v for k, v in r.items() if "reach" in k})
