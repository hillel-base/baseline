"""Q3c (protocol §Quality): corrections modelled from the operator's own first click, through the tool's engine.
For each scored run (eval/score.py output), the engine starts a nodule at his logged first click, then makes up to MAX
corrections, each at the deepest voxel of the largest remaining error against the steering reference (S1's method):
a + click where the reference is missed, a - click where the outline spills over it.
Two arms, steered by R1 and by R2 (the radiologists' majority); every step is scored against both references, so a
report can count corrections against the steering reference's own bar (R1: its median repeat; R2: the radiologists'
median spread) and give quality against the other one. A patient with no R2 has only the R1 arm. A + click on air (refused by the engine) moves to the deepest non-air voxel of
the same error. Step 0 is his click alone; it is compared with the outline his first click gave (the engine is deterministic).
With --offsets (Q3b): the first click only, from the cross (R1's centre voxel) and from OFFSETS_MM away from it in four
in-plane directions, where that point is inside R1 and not air; how much the first outline moves with a realistic click.
Usage: python -I eval/replay.py <data/rider> <tool runs dir> <scores.csv> <out.csv> [engine URL, default http://localhost:8100; port 8000 is kept for the operator's sessions] [--offsets]
The engine runs at the timed runs' commit and settings (protocol §Assisted runs), with its own LUNG_RUNS_DIR."""
import base64, csv, json, os, statistics, sys, urllib.error, urllib.request
import numpy as np, SimpleITK as sitk
from scipy import ndimage
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from measure import axes_mm, dice, volume_ml
from score import r1_r2, vol_change
from qiba import qiba_index

OFFSETS_MM = (3, 5)
MAX, AIR_HU = 5, -950  # corrections per arm (protocol Q3c); the engine refuses a + click at or below -950 HU

def next_click(out, ref, hu):
    """(z, y, x, positive) at the deepest voxel of the largest error, or None if the outline equals the reference."""
    fn, fp = ref & ~out, out & ~ref
    err, positive = (fn, True) if fn.sum() >= fp.sum() else (fp, False)
    if not err.any(): return None
    lab, _ = ndimage.label(err)
    big = lab == np.argmax(np.bincount(lab.ravel())[1:]) + 1
    sl = tuple(slice(max(0, s.start - 1), s.stop + 1) for s in ndimage.find_objects(big.astype(np.uint8))[0])
    depth = ndimage.distance_transform_edt(big[sl])
    if positive: depth[hu[sl] <= AIR_HU] = 0  # the engine refuses + clicks on air
    if not depth.any(): return None
    z, y, x = (int(i + s.start) for i, s in zip(np.unravel_index(np.argmax(depth), depth.shape), sl))
    return z, y, x, positive

def offset_starts(r1, hu, centre, spacing_zyx):
    """[(label, (z, y, x))]: the cross itself, then OFFSETS_MM away in +-y and +-x, kept if inside R1 and not air."""
    centre = [int(c) for c in centre]  # plain ints, so the engine request can be written as JSON
    out = [("cross", tuple(centre))]
    for mm in OFFSETS_MM:
        for name, ax, sgn in (("up", 1, -1), ("down", 1, 1), ("left", 2, -1), ("right", 2, 1)):
            p = list(centre); p[ax] += sgn * int(round(mm / spacing_zyx[ax]))
            if all(0 <= p[i] < r1.shape[i] for i in range(3)) and r1[tuple(p)] and hu[tuple(p)] > AIR_HU:
                out.append((f"{mm} mm {name}", tuple(p)))
    return out

def decode(o, shape):
    """The engine's Outline payload as a full boolean mask (z, y, x)."""
    m = np.zeros(shape, bool)
    if o.get("bbox"):
        z0, y0, x0, z1, y1, x1 = o["bbox"]; n = (z1 - z0) * (y1 - y0) * (x1 - x0)
        m[z0:z1, y0:y1, x0:x1] = np.unpackbits(np.frombuffer(base64.b64decode(o["mask"]), np.uint8))[:n].reshape(z1 - z0, y1 - y0, x1 - x0).astype(bool)
    return m

def scores(m, ref, sp):
    v, L = volume_ml(m, sp), axes_mm(m, sp)[0]; rv, rL = volume_ml(ref, sp), axes_mm(ref, sp)[0]
    return dict(dice=dice(m, ref), vol_change=vol_change(v, rv) if v + rv else 0.0, vol_err_pct=100 * (v - rv) / rv, long_err=L - rL)

# self-check: a + click into the missed part, a - click into the spill, a + click moved off an air pocket
_g = np.indices((30, 30, 30)); _ref = ((_g - 15) ** 2).sum(0) <= 64; _hu = np.zeros(_ref.shape)
c = next_click(np.zeros_like(_ref), _ref, _hu); assert c[3] and c[:3] == (15, 15, 15), c
c = next_click(((_g - 15) ** 2).sum(0) <= 144, _ref, _hu); assert not c[3], c
_hu[15, 15, 15] = -1000; c = next_click(np.zeros_like(_ref), _ref, _hu); assert c[3] and c[:3] != (15, 15, 15), c
assert next_click(_ref, _ref, _hu) is None
_st = offset_starts(_ref, np.zeros(_ref.shape), (15, 15, 15), (1, 1, 1))  # radius 8: 3 and 5 voxels away stay inside
assert len(_st) == 9 and _st[1] == ("3 mm up", (15, 12, 15)), _st

def walk(url, o, target, refs, hu, sp, max_steps, base, check=None):
    """Score the engine's outline o, then correct it toward target, up to max_steps times; one row per step.
    refs: {"R1": [mask], "R2": [reader masks]} (R2 scored as the median over its readers, as in score.py).
    check: an outline step 0 must reproduce (his first-click outline), reported as replay_vs_his_dice."""
    which, step, c, rows = dict(scan=o["scan"], nodule=o["nodule"]), 0, None, []
    while True:
        m = decode(o, target.shape)
        row = dict(base, step=step, positive=None if c is None else c[3], z=None if c is None else c[0], seconds=o["seconds"])
        for ref_name, ref_masks in refs.items():
            if not ref_masks: continue
            per = [scores(m, ref, sp) for ref in ref_masks]
            row.update({f"{ref_name.lower()}_{k}": round(statistics.median(p[k] for p in per), 3) for k in per[0]})
        if step == 0 and check is not None: row["replay_vs_his_dice"] = round(dice(m, check), 3)
        rows.append(row)
        if step == max_steps or (c := next_click(m, target, hu)) is None: break
        code, o2 = post(url, "/api/nodule/clicks", dict(z=c[0], y=c[1], x=c[2], positive=c[3], **which))
        if code != 200: row["refused_next"] = o2.get("detail", code); break
        o, step = o2, step + 1
    return rows

def mark_bars(rows, bar, line):
    """Per step: within the steering reference's own bar, and within the failure line (against R1)."""
    for r in rows:
        if "r1_dice" in r and r.get("steer"):  # offset rows (Q3b) have no steering
            k = r["steer"].lower(); bv, bl = bar[r["steer"]]
            r["within_own_bar"] = r[f"{k}_vol_change"] <= bv and abs(r[f"{k}_long_err"]) <= bl
            r["within_r1_line"] = r["r1_vol_change"] <= line[0] and abs(r["r1_long_err"]) <= line[1]

def bars():
    """The own bar per steering reference (its median spread) and the failure line (R1's 90th percentile)."""
    yard = {r["yardstick"]: r for r in csv.DictReader(open(os.path.join(here, "runs", "yardsticks.csv")))}
    bar = {"R1": (float(yard["R1 scan vs repeat, volume"]["median"]), float(yard["R1 scan vs repeat, long axis"]["median"])),
           "R2": (float(yard["R2 reader vs reader same scan, volume"]["median"]), float(yard["R2 reader vs reader same scan, long axis"]["median"]))}
    return bar, (float(yard["R1 scan vs repeat, volume"]["p90"]), float(yard["R1 scan vs repeat, long axis"]["p90"]))

def post(url, path, body):
    # LUNG_HEADERS: extra headers as JSON, for the practice server's sign-in (eval/server_check.py); unset for local engines
    req = urllib.request.Request(url + path, json.dumps(body).encode(), {"Content-Type": "application/json", **json.loads(os.environ.get("LUNG_HEADERS", "{}"))})
    try: return 200, json.load(urllib.request.urlopen(req))
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--offsets"]; offsets = "--offsets" in sys.argv
    root, runs, scores_csv, out = args[:4]
    url = args[4] if len(args) > 4 else "http://localhost:8100"
    bar, line = bars()
    Q, cache, rows = qiba_index(os.path.join(root, "series")), {}, []
    for run in csv.DictReader(open(scores_csv)):
        if not run.get("click_z"): continue
        ct, r1, r2 = r1_r2(root, run["patient"], Q, cache)[run["scan"]]
        sp, hu, scan_id = ct.GetSpacing(), sitk.GetArrayFromImage(ct), f"{run['patient']}_{run['scan']}"
        majority = (np.sum(list(r2.values()), axis=0) > len(r2) / 2) if r2 else None
        refs = {"R1": [r1], "R2": list(r2.values())}
        arms = ["R1", "R2"] if r2 else ["R1"]
        if offsets:  # Q3b: first click only, no steering; scored against both references
            v = np.argwhere(r1); centre = v[np.argmin(((v - v.mean(0)) ** 2).sum(1))]
            for label, (sz, sy, sx) in offset_starts(r1, hu, centre, sp[::-1]):
                code, o = post(url, f"/api/scans/{scan_id}/nodules", dict(z=sz, y=sy, x=sx))
                row = dict(patient=run["patient"], scan=run["scan"], started_at=run["started_at"], start=label, z=sz, y=sy, x=sx)
                if code != 200: rows.append(dict(row, refused=o.get("detail", code))); continue
                m = decode(o, r1.shape); row["seconds"] = o["seconds"]
                v_, L_ = volume_ml(m, sp), axes_mm(m, sp)[0]; row.update(volume_ml=round(v_, 2), long_mm=round(L_, 1))
                for ref_name, ref_masks in refs.items():
                    if ref_masks:
                        per = [scores(m, ref, sp) for ref in ref_masks]
                        row.update({f"{ref_name.lower()}_{k}": round(statistics.median(p[k] for p in per), 3) for k in per[0]})
                rows.append(row)
            print(run["patient"], run["scan"], "offset starts", flush=True)
            continue
        his = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(runs, run.get("first_outline_file") or run["outline_file"]))) > 0  # his first-click outline
        starts = [("his click", (int(run["click_z"]), int(run["click_y"]), int(run["click_x"])))]
        if run.get("click_in_r1") == "False":  # protocol: a click outside R1 is also modelled from R1's centre voxel
            v = np.argwhere(r1); starts.append(("R1 centre", tuple(int(i) for i in v[np.argmin(((v - v.mean(0)) ** 2).sum(1))])))
        for (start, (sz, sy, sx)), steer in [(st, a) for st in starts for a in arms]:
            target = majority if steer == "R2" else r1
            code, o = post(url, f"/api/scans/{scan_id}/nodules", dict(z=sz, y=sy, x=sx))
            if code != 200:
                rows.append(dict(patient=run["patient"], scan=run["scan"], started_at=run["started_at"], start=start, steer=steer, step=0, refused=o.get("detail", code))); continue
            steps = walk(url, o, target, refs, hu, sp, MAX, dict(patient=run["patient"], scan=run["scan"], started_at=run["started_at"], start=start, steer=steer),
                         check=his if start == "his click" else None)
            rows += steps; step = steps[-1]["step"]
            print(run["patient"], run["scan"], start, "steered by", steer, "steps", step, flush=True)
    mark_bars(rows, bar, line)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
