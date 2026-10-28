"""The study table's correction rule (our question, and the rule we approved): a new Record replaces a row on the same scan
when its first click is within max(10 mm, K x the old row's long axis) of the old row's first click, in 3D.
Q1, same tumour: the share of pairs of first clicks on one tumour that fall OUTSIDE the rule (they would get a new label
instead of replacing). Development and held-out patients only. Two click sets per scan:
 (a) the scripted starts of Q3 and Q3b (deepest voxel, 1 pixel off it, the cross, 3 and 5 mm off it), from eval/q3.py's CSVs;
 (b) a stress test: N voxels drawn at random anywhere inside R1 (seed 0), every pair; a real reader clicks nearer the middle.
The old row's long axis is R1's (eval/measure.py axes_mm), standing in for the tool's.
Q2 (two different tumours inside the rule) needs scans with several marked nodules; RIDER has one tumour per scan.
Per-scan rows go to <out dir>/replace_rule_scans.csv (out of git until the timed runs end); totals to eval/runs/replace_rule.csv.
Usage: python -I eval/replace_rule.py <data/rider> <out dir> <q3 dir> [<q3 dir> ...]"""
import csv, glob, os, statistics, sys
import numpy as np
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from measure import axes_mm
from rider import load_ct, load_seg, manual_mask

KS, FLOOR_MM, N = (0.5, 0.75, 1.0), 10.0, 300

def pair_dists(pts_zyx, sp_zyx):
    """All pairwise 3D distances in mm (upper triangle)."""
    p = np.asarray(pts_zyx, float) * np.asarray(sp_zyx)
    d = np.sqrt(((p[:, None] - p[None]) ** 2).sum(-1))
    return d[np.triu_indices(len(p), 1)]

def outside(d, long_mm, k):
    return float((d > max(FLOOR_MM, k * long_mm)).mean()) if len(d) else 0.0

# self-check: two clicks 12 mm apart on a 20 mm tumour are inside at K 0.75 (15 mm) and outside at K 0.5 (floor 10 mm)
_d = pair_dists([(0, 0, 0), (0, 0, 24)], (1, 0.5, 0.5)); assert abs(_d[0] - 12) < 1e-9
assert outside(_d, 20, 0.75) == 0.0 and outside(_d, 20, 0.5) == 1.0

if __name__ == "__main__":
    root, out, q3dirs = sys.argv[1], sys.argv[2], sys.argv[3:]
    starts = {}
    for d in q3dirs:
        for f in glob.glob(os.path.join(d, "*.csv")):
            for r in csv.DictReader(open(f)):
                if r["step"] == "0": starts.setdefault((r["patient"], r["scan"]), set()).add((int(r["start_z"]), int(r["start_y"]), int(r["start_x"])))
    rng, rows = np.random.default_rng(0), []
    for (patient, scan), pts in sorted(starts.items()):
        ct = load_ct(os.path.join(root, patient, f"ct_{scan}"))
        r1 = manual_mask(load_seg(os.path.join(root, patient, f"lungctseg_{scan}"), ct)).astype(bool)
        sp = ct.GetSpacing()[::-1]; L = axes_mm(r1, ct.GetSpacing())[0]
        v = np.argwhere(r1); rand = v[rng.choice(len(v), min(N, len(v)), replace=False)]
        dq, dr = pair_dists(sorted(pts), sp), pair_dists(rand, sp)
        row = dict(patient=patient, scan=scan, r1_long_mm=round(L, 1), q3_clicks=len(pts), q3_max_mm=round(float(dq.max()), 1),
                   random_max_over_long=round(float(dr.max()) / L, 2))
        for k in KS: row.update({f"q3_outside_k{k}": outside(dq, L, k), f"random_outside_k{k}": round(outside(dr, L, k), 4)})
        rows.append(row); print(patient, scan, f"long {L:.1f} mm", f"Q3 max {dq.max():.1f} mm", f"random outside at 0.75: {row['random_outside_k0.75']:.1%}", flush=True)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "replace_rule_scans.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    tot = []
    for k in KS:
        tot.append(dict(k=k, floor_mm=FLOOR_MM, scans=len(rows),
                        q3_scans_with_any_pair_outside=sum(r[f"q3_outside_k{k}"] > 0 for r in rows),
                        random_outside_median_pct=round(100 * statistics.median(r[f"random_outside_k{k}"] for r in rows), 2),
                        random_outside_max_pct=round(100 * max(r[f"random_outside_k{k}"] for r in rows), 2),
                        random_scans_over_1pct=sum(r[f"random_outside_k{k}"] > 0.01 for r in rows)))
    with open(os.path.join(here, "runs", "replace_rule.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(tot[0])); w.writeheader(); w.writerows(tot)
    for t in tot: print(t)
    worst = sorted(rows, key=lambda r: -r["random_outside_k0.75"])[:3]
    print("worst at 0.75:", [(r["r1_long_mm"], r["random_outside_k0.75"], r["random_max_over_long"]) for r in worst])
