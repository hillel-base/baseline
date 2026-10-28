"""Expert yardsticks: how much the experts themselves vary (protocol §Yardsticks), and the failure cut (§Timing).
- R1, the RIDER-LungCT-Seg expert, scan against repeat scan: measured here with eval/measure.py on the 28 patients.
- R2, the QIBA radiologists against each other on the same scan: placed by eval/qiba.py (our own code), on the 28 patients.
Change in volume = |a - b| / mean(a, b) in %; change in long axis = |a - b| in mm (pixel centres, outline against outline).
Prints and writes medians and 90th percentiles only; per-reader values go to a git-ignored file (blinding).
Usage: python -I eval/yardsticks.py <data/rider> eval/runs/yardsticks.csv data/eval/r2_readers.csv"""
import csv, itertools, os, sys
import pydicom
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask
from measure import volume_ml, axes_mm
from qiba import qiba_index, readers

def vol_change(a, b): return 100 * abs(a - b) / ((a + b) / 2)

assert vol_change(10, 10) == 0 and abs(vol_change(12, 8) - 40) < 1e-9  # self-check

root, out, per_reader = sys.argv[1:4]
Q = qiba_index(os.path.join(root, "series"))
here = os.path.dirname(os.path.abspath(__file__))
patients = [r["patient"] for r in csv.DictReader(open(os.path.join(here, "cases.csv")))]
r1v, r1l, r2v, r2l, rows_r = [], [], [], [], []
for p in patients:
    m, cts, r1s = {}, {}, {}
    for s in ("test", "retest"):
        cts[s] = ct = load_ct(os.path.join(root, p, f"ct_{s}")); r1s[s] = k = manual_mask(load_seg(os.path.join(root, p, f"lungctseg_{s}"), ct))
        m[s] = (volume_ml(k, ct.GetSpacing()), axes_mm(k, ct.GetSpacing())[0])
    r1v.append(vol_change(m["test"][0], m["retest"][0])); r1l.append(abs(m["test"][1] - m["retest"][1]))
    placed, _ = readers([pydicom.dcmread(f) for f in Q.get(p, [])], cts, r1s)
    for s, by in placed.items():
        meas = {w: (volume_ml(k, cts[s].GetSpacing()), axes_mm(k, cts[s].GetSpacing())[0]) for w, k in by.items()}
        rows_r += [dict(patient=p, scan=s, reader=w, vol_ml=round(v, 3), long_mm=round(l, 2)) for w, (v, l) in sorted(meas.items())]
        for a, b in itertools.combinations(sorted(meas), 2):
            r2v.append(vol_change(meas[a][0], meas[b][0])); r2l.append(abs(meas[a][1] - meas[b][1]))
    print(p, flush=True)  # progress only
q = {r["patient"] for r in rows_r}
os.makedirs(os.path.dirname(os.path.abspath(per_reader)), exist_ok=True)
with open(per_reader, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows_r[0])); w.writeheader(); w.writerows(rows_r)
rows = [dict(yardstick=name, n=len(v), unit=u, median=round(float(np.median(v)), 1), p90=round(float(np.percentile(v, 90)), 1))
        for name, v, u in (("R1 scan vs repeat, volume", r1v, "%"), ("R1 scan vs repeat, long axis", r1l, "mm"),
                           ("R2 reader vs reader same scan, volume", r2v, "%"), ("R2 reader vs reader same scan, long axis", r2l, "mm"))]
rows[2]["patients"] = rows[3]["patients"] = len(q)
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["yardstick", "n", "patients", "unit", "median", "p90"]); w.writeheader(); w.writerows(rows)
for r in rows: print(r)
