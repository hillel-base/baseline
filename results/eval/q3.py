"""Q3 and Q3b (protocol §Quality): the tool run by script, no person in the loop, on both scans of the given patients.
- Q3: the first click at the deepest voxel of R1 (S1's method), then up to MAX corrections steered by R1, and separately
  by R2 (the radiologists' majority) where it exists; every step scored against both references (eval/replay.py walk()).
- Q3b(1): the first click one pixel up, down, left and right of that voxel (inside R1, not air), then 2 corrections
  steered by R1, so quality after 1 and after 3 clicks.
- Q3b(2): the first click only, from the cross (R1's centre voxel) and 3 and 5 mm away (eval/replay.py offset_starts()).
Opens only the given patients (default: role "heldout" in eval/cases.csv; the timed ones wait until the timed runs are
done). Start the engine with LUNG_DATA_DIR holding only those patients. One CSV per patient in <out dir>, kept out of git
until the timed runs end; a patient whose file exists is skipped, so the graphics chip can be shared in short blocks.
Usage: python -I eval/q3.py <data/rider> <out dir> [engine URL, default http://localhost:8100; port 8000 is kept for the operator's sessions] [--patients P1,P2] [--limit N] [--after-timed-runs]"""
import csv, os, sys
import numpy as np, pydicom, SimpleITK as sitk
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from patch_reach import deepest
from qiba import qiba_index
from replay import AIR_HU, MAX, bars, mark_bars, offset_starts, post, walk
from score import r1_r2

def neighbours(r1, hu, c):
    """The 4 in-plane one-pixel neighbours of c that are inside R1 and not air."""
    out = []
    for name, dy, dx in (("1 px up", -1, 0), ("1 px down", 1, 0), ("1 px left", 0, -1), ("1 px right", 0, 1)):
        p = (int(c[0]), int(c[1]) + dy, int(c[2]) + dx)
        if r1[p] and hu[p] > AIR_HU: out.append((name, p))
    return out

_r = np.zeros((5, 9, 9), bool); _r[2, 3:6, 3:6] = True; _h = np.zeros(_r.shape); _h[2, 3, 4] = -1000
assert [n for n, _ in neighbours(_r, _h, (2, 4, 4))] == ["1 px down", "1 px left", "1 px right"]  # self-check: "up" is air

def run_patient(root, url, patient, Q, bar, line):
    rows, cache = [], {}
    for scan, (ct, r1, r2) in r1_r2(root, patient, Q, cache).items():
        sp, hu, scan_id = ct.GetSpacing(), sitk.GetArrayFromImage(ct), f"{patient}_{scan}"
        majority = (np.sum(list(r2.values()), axis=0) > len(r2) / 2) if r2 else None
        refs = {"R1": [r1], "R2": list(r2.values())}
        d = deepest(r1)
        v = np.argwhere(r1); cross = v[np.argmin(((v - v.mean(0)) ** 2).sum(1))]
        plan = [("q3", "deepest", d, "R1", MAX)] + ([("q3", "deepest", d, "R2", MAX)] if r2 else [])
        plan += [("q3b1", name, p, "R1", 2) for name, p in neighbours(r1, hu, d)]
        plan += [("q3b2", name, p, None, 0) for name, p in offset_starts(r1, hu, cross, sp[::-1])]
        for part, start, (z, y, x), steer, n in plan:
            base = dict(patient=patient, scan=scan, part=part, start=start, steer=steer, start_z=int(z), start_y=int(y), start_x=int(x))
            code, o = post(url, f"/api/scans/{scan_id}/nodules", dict(z=int(z), y=int(y), x=int(x)))
            if code != 200: rows.append(dict(base, step=0, refused=o.get("detail", code))); continue
            target = r1 if steer != "R2" else majority
            rows += walk(url, o, target, refs, hu, sp, n, base)
        print(patient, scan, len(plan), "starts", flush=True)
    mark_bars(rows, bar, line)
    return rows

if __name__ == "__main__":
    args = sys.argv[1:]
    opt = lambda k: args[args.index(k) + 1] if k in args else None
    pos = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or not args[i - 1].startswith("--"))]
    root, out = pos[0], pos[1]
    url = pos[2] if len(pos) > 2 else "http://localhost:8100"
    patients = opt("--patients").split(",") if opt("--patients") else [r["patient"] for r in csv.DictReader(open(os.path.join(here, "cases.csv"))) if r["role"] == "heldout"]
    timed = {r["patient"] for r in csv.DictReader(open(os.path.join(here, "cases.csv"))) if r["role"] == "timed"}
    assert "--after-timed-runs" in args or not set(patients) & timed, "timed patients are opened only after the timed runs (protocol §Cases)"
    limit = int(opt("--limit") or len(patients))
    os.makedirs(out, exist_ok=True)
    bar, line = bars()
    Q, done = qiba_index(os.path.join(root, "series")), 0
    for p in patients:
        f = os.path.join(out, f"{p}.csv")
        if os.path.exists(f) or done >= limit: continue
        rows = run_patient(root, url, p, Q, bar, line)
        keys = list(dict.fromkeys(k for r in rows for k in r))
        with open(f + ".tmp", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=keys); w.writeheader(); w.writerows(rows)
        os.replace(f + ".tmp", f)  # a block stopped mid-patient leaves no half file
        done += 1
