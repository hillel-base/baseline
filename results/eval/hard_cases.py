"""Tag the lab's "hard cases" (its research fellow, 2026-10-25) by a fixed rule, before any scoring (protocol §Hard cases).
Both tags come from the expert outline (R1) on the test scan and the CT, never from the tool:
- irregular: solidity = outline voxels / voxels inside the outline's 3D convex hull; the least solid third of the 28
  patients (spiculated or lobulated margins lower it);
- touching: the share of the shell 1-3 mm outside the outline that is dense (above -400 HU: vessel, airway wall,
  chest wall, mediastinum); the third with the most contact.
A patient is hard if either tag is set. Prints counts only (blinding); the per-patient file stays git-ignored until
the operator's last timed run.
Usage: python -I eval/hard_cases.py <data/rider> data/eval/hard_cases.csv"""
import csv, glob, os, sys
import numpy as np, SimpleITK as sitk
from scipy import ndimage
from scipy.spatial import ConvexHull, Delaunay
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask

DENSE_HU = -400        # about halfway between aerated lung (~-850) and soft tissue (~+40); an assumption, not the lab's
SHELL_MM = (1.0, 3.0)  # skips the outline's own blurred edge, reaches the structures right next to it

def solidity(m, sp):
    """m is z,y,x; sp is (sz, sy, sx) in mm."""
    zyx = np.argwhere(m) * sp
    lo, hi = np.argwhere(m).min(0), np.argwhere(m).max(0) + 1
    grid = np.indices(hi - lo).reshape(3, -1).T + lo
    hull = ConvexHull(zyx, qhull_options="QJ")  # triangulate the hull corners only: all voxels would take minutes
    inside = Delaunay(zyx[hull.vertices]).find_simplex(grid * sp) >= 0
    return float(m.sum() / (inside | m[tuple(grid.T)].astype(bool)).sum())

def touching(m, hu, sp):
    d = ndimage.distance_transform_edt(~m.astype(bool), sampling=sp)
    shell = (d > SHELL_MM[0]) & (d <= SHELL_MM[1])
    return float((hu[shell] > DENSE_HU).mean())

def crop(m, hu, sp, pad_mm=5.0):
    sl = ndimage.find_objects(m.astype(np.uint8))[0]
    pad = np.ceil(pad_mm / np.array(sp)).astype(int)
    sl = tuple(slice(max(0, s.start - p), min(n, s.stop + p)) for s, p, n in zip(sl, pad, m.shape))
    return m[sl], hu[sl]

# self-check: a cube is fully solid, an L is not; a ball in air touches nothing until a dense wall sits next to it
_c = np.zeros((12, 12, 12), np.uint8); _c[2:10, 2:10, 2:10] = 1
_l = _c.copy(); _l[2:10, 6:10, 6:10] = 0
assert abs(solidity(_c, (1, 1, 1)) - 1) < 1e-9 and solidity(_l, (1, 1, 1)) < 0.95  # 0.889: the hull covers half the notch
_g = np.indices((30, 30, 30)); _b = (((_g - 15) ** 2).sum(0) <= 25).astype(np.uint8)
_air = np.full(_b.shape, -900.0); _wall = _air.copy(); _wall[:, :, 22:] = 40
assert touching(_b, _air, (1, 1, 1)) == 0 and 0 < touching(_b, _wall, (1, 1, 1)) < 0.5

if __name__ == "__main__":
    root, out = sys.argv[1], sys.argv[2]
    role = {r["patient"]: r["role"] for r in csv.DictReader(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cases.csv")))}
    rows = []
    for p in sorted(glob.glob(os.path.join(root, "RIDER-*"))):
        pid = os.path.basename(p)
        if pid not in role: continue
        ct = load_ct(os.path.join(p, "ct_test")); sp = ct.GetSpacing()[::-1]
        m, hu = crop(manual_mask(load_seg(os.path.join(p, "lungctseg_test"), ct)), sitk.GetArrayFromImage(ct), sp)
        rows.append(dict(patient=pid, role=role[pid], solidity=round(solidity(m, sp), 3), touching=round(touching(m, hu, sp), 3)))
        print(pid, flush=True)  # progress only
    s_cut = np.quantile([r["solidity"] for r in rows], 1 / 3)
    t_cut = np.quantile([r["touching"] for r in rows], 2 / 3)
    for r in rows:
        r.update(irregular=r["solidity"] <= s_cut, touching_tag=r["touching"] >= t_cut)
        r["hard"] = r["irregular"] or r["touching_tag"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    print(f"cuts: solidity <= {s_cut:.3f}, touching >= {t_cut:.3f}")
    for k in ("irregular", "touching_tag", "hard"):
        print(k, {g: sum(r[k] for r in rows if r["role"] == g) for g in ("dev", "timed", "heldout")})
    for r in rows:  # dev cases may be named
        if r["role"] == "dev": print(r)
