"""Fix the study cases before any timing (protocol §Cases). Patients with an expert outline on both same-day scans are split
into volume tertiles (test scan); with a fixed seed each tertile gives 3 timed patients and 1 dev patient, the rest are
held out. Timed orders 1-4 also get the manual baseline (column manual), fixed here so the cut cannot follow the results. Size is the only input, so no case is picked for how well the tool does on it.
Also writes where the tumour is (the expert-outline voxel nearest its centre, so always inside it), so the operator skips finding, which the tool does not do.
Usage: python -I eval/select_cases.py <data/rider> eval/cases.csv"""
import csv, glob, os, sys
import numpy as np, pydicom, SimpleITK as sitk
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask, centroid_phys
from measure import volume_ml

SEED = 20261024
root, out = sys.argv[1], sys.argv[2]

pts = []
for p in sorted(glob.glob(os.path.join(root, "RIDER-*"))):
    if not all(glob.glob(os.path.join(p, f"{k}_{s}", "*")) for k in ("ct", "lungctseg") for s in ("test", "retest")): continue
    r = dict(patient=os.path.basename(p))
    for s in ("test", "retest"):
        ct = load_ct(os.path.join(p, f"ct_{s}")); m = manual_mask(load_seg(os.path.join(p, f"lungctseg_{s}"), ct))
        x, y, z = centroid_phys(m, ct)
        r[f"vol_{s}_ml"] = round(volume_ml(m, ct.GetSpacing()), 2)
        k = ct.TransformPhysicalPointToIndex((x, y, z))[2]
        r[f"{s}_slice"] = k  # 0-based index in the series as SimpleITK sorts it (the tool's logs and outline files use it)
        # DICOM Instance Number of that slice, what the tool's counter and most viewers show; on RIDER it runs the other way from k.
        f = sitk.ImageSeriesReader.GetGDCMSeriesFileNames(os.path.join(p, f"ct_{s}"))[k]
        r[f"{s}_image"] = int(pydicom.dcmread(f, stop_before_pixels=True).InstanceNumber)
        r[f"{s}_ras_mm"] = f"{-x:.1f} {-y:.1f} {z:.1f}"  # 3D Slicer shows RAS; DICOM is LPS
    pts.append(r); print(r["patient"], flush=True)  # progress only; volumes stay off screen (blinding)

rng = np.random.default_rng(SEED)
by_vol = sorted(pts, key=lambda r: r["vol_test_ml"])
tert = np.array_split(np.arange(len(by_vol)), 3)
picks = [[by_vol[i] for i in rng.permutation(t)] for t in tert]
for name, t in zip("SML", picks):
    for r in t: r.update(stratum=name, role="heldout", order="")
    for i in (0, 1, 3): t[i]["role"] = "timed"
    t[2]["role"] = "dev"  # t[3] added after review (v1.1); same seed, so t[0..2] are unchanged
# Timed order S,M,L,S,M,L,S,M,L; manual baseline on orders 1-4 (both small ones and one of each other size).
for k, r in enumerate([t[i] for i in (0, 1, 3) for t in picks], 1): r.update(order=k, manual="yes" if k <= 4 else "no")
for r in pts: r.setdefault("manual", "no")

assert sum(r["role"] == "timed" for r in pts) == 9 and sum(r["role"] == "dev" for r in pts) == 3
assert sorted(r["order"] for r in pts if r["role"] == "timed") == list(range(1, 10))
# No volumes in the file: the operator reads his hints here and must not see the expert's answer (protocol v1.4).
keys = ["role", "order", "manual", "stratum", "patient", "test_slice", "test_image", "test_ras_mm", "retest_slice", "retest_image", "retest_ras_mm"]
rows = sorted(pts, key=lambda r: ({"timed": 0, "dev": 1, "heldout": 2}[r["role"]], r["order"] or 0, r["vol_test_ml"]))
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows({k: r[k] for k in keys} for r in rows)
print(f"{len(pts)} patients; tertile sizes {[len(t) for t in tert]}")
print("timed, dev:", [(r["order"], r["stratum"], r["patient"]) for r in rows[:12]])
