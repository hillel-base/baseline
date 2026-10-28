"""Score tool runs (protocol §Timing, §Quality): one row per stopwatch run, joined to the tool's event log and outlines.
- Join: a stopwatch row owns the tool events for its scan between "scan open" and its end (local stopwatch time vs UTC log).
- Time: the stopwatch phases; model seconds per phase from the log; re-timed for a PC without a graphics chip (S7).
- Quality: the recorded outline and the first-click outline against R1 and R2 (eval/qiba.py), measured by eval/measure.py.
- Checks: the tool's reported numbers against our recomputation; our own window-edge check; the failure cut (§Timing).
Usage: python -I eval/score.py <data/rider> <tool runs dir> <eval/runs/timing.csv> <out.csv> [roles, default timed]"""
import csv, datetime as dt, json, os, statistics, sys
import numpy as np, pydicom, SimpleITK as sitk
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from rider import load_ct, load_seg, manual_mask
from measure import axes_mm, dice, volume_ml
from qiba import qiba_index, readers

PC_S = {"pc4": 19.8, "pc2": 44.6}  # S7: seconds per click at 160^3 on 4 vCPU (the slower runner) and on 2 vCPU
HALF = 80                           # the 160-voxel window reaches 80 voxels from its click (protocol §Window edge)
MODEL = ("nodule_start", "click")   # the actions that run the model

def utc(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(dt.timezone.utc)

def vol_change(a, b): return 100 * abs(a - b) / ((a + b) / 2)

CROP_MM = (60, 90, 90)  # the engine's working box: 120 x 180 x 180 mm (z, y, x) centred on the first click (the engine's)

def at_edge(mask, starts_and_plus, first, spacing_zyx):
    """(touches a window, touches the box): does the outline reach the edge of where the model could draw it? The model
    draws only inside the 160-voxel windows of the clicks that can grow it (the start and + clicks), and only inside the
    working box around the first click; - clicks only remove. An outline voxel next to a voxel outside that region may
    be cut."""
    if not mask.any(): return False, False
    sl = tuple(slice(max(0, a - 1), b + 1) for a, b in zip(np.argwhere(mask).min(0), np.argwhere(mask).max(0) + 1))
    g = np.indices(tuple(s_.stop - s_.start for s_ in sl)) + np.array([s_.start for s_ in sl]).reshape(3, 1, 1, 1)
    win = np.zeros(g.shape[1:], bool)
    for c in starts_and_plus:
        win |= np.all([(g[i] >= c[i] - HALF) & (g[i] <= c[i] + HALF - 1) for i in range(3)], axis=0)
    box = np.all([np.abs(g[i] - first[i]) * spacing_zyx[i] <= CROP_MM[i] for i in range(3)], axis=0)
    m = mask[sl]
    def touches(allowed):
        out = ~allowed
        near = np.zeros_like(out)
        for ax in range(3):
            near |= np.roll(out, 1, ax) | np.roll(out, -1, ax)
        return bool((m & near).any())
    return touches(win), touches(box)

def edge_reach(mask, clicks):
    """Voxels from the outline's furthest point to its nearest click (Chebyshev, the window is a cube): the window edge
    is reached when this is >= HALF - 1 for every click that could have drawn that point."""
    zyx = np.argwhere(mask)
    if not len(zyx) or not clicks: return 0
    return int(np.min([np.abs(zyx - np.array(c)).max(1) for c in clicks], axis=0).max())

def phases(row, gap=0.0):
    """(name, start, end) in UTC for the timed phases of a stopwatch row; gap = seconds from started_at to the first Enter
    (0 from 2026-10-25 22:10, when the stopwatch began to record the first Enter; found by lining up older rows)."""
    t, out = utc(dt.datetime.fromisoformat(row["started_at"]).astimezone().isoformat()) + dt.timedelta(seconds=gap + float(row["load_s"])), []
    for ph in row["order"].split(">"):
        e = t + dt.timedelta(seconds=float(row[f"{ph}_s"])); out.append((ph, t, e)); t = e
    return out

# self-check: the window edge, and phases from a stopwatch row
_m = np.zeros((5, 200, 200), bool); _m[2, 100, 10:191] = True
assert edge_reach(_m, [(2, 100, 100)]) == 90 and edge_reach(_m, [(2, 100, 20), (2, 100, 180)]) == 80  # the middle is 80 from both
_m2 = np.zeros((20, 200, 200), bool); _m2[10, 100, 30:171] = True  # 141 voxels long, a click in the middle
assert at_edge(_m2, [(10, 100, 100)], (10, 100, 100), (1, 1, 1)) == (False, False)
_m2[10, 100, 15:30] = True  # now it reaches x = 15, past the window's edge at x = 20 (inside the 90 mm box)
assert at_edge(_m2, [(10, 100, 100)], (10, 100, 100), (1, 1, 1)) == (True, False)
assert at_edge(_m2, [(10, 100, 100), (10, 100, 30)], (10, 100, 100), (1, 1, 1)) == (False, False)  # a + click there covers it
_m3 = np.zeros((100, 20, 20), bool); _m3[10:76, 10, 10] = True  # 65 mm deep from the click: past the box's 60 mm
assert at_edge(_m3, [(10, 10, 10)], (10, 10, 10), (1, 1, 1)) == (False, True)
_p = phases(dict(started_at="2026-10-25T10:00:00", load_s="5", order="outline>axes>record", outline_s="60", axes_s="10", record_s="20"))
assert [p[0] for p in _p] == ["outline", "axes", "record"] and (_p[2][2] - _p[0][1]).total_seconds() == 90

def r1_r2(root, patient, Q, cache):
    """Per scan side: (ct, R1 mask, {reader: mask}); both sides are loaded because R2 is placed across the pair."""
    if patient not in cache:
        cts, r1s = {}, {}
        for s in ("test", "retest"):
            cts[s] = load_ct(os.path.join(root, patient, f"ct_{s}")); r1s[s] = manual_mask(load_seg(os.path.join(root, patient, f"lungctseg_{s}"), cts[s])).astype(bool)
        placed, _ = readers([pydicom.dcmread(f) for f in Q.get(patient, [])], cts, r1s)
        cache.clear(); cache[patient] = {s: (cts[s], r1s[s], placed.get(s, {})) for s in cts}  # one patient in memory
    return cache[patient]

def quality(mask, ct, r1, r2):
    sp = ct.GetSpacing(); v, (L, S, _) = volume_ml(mask, sp), axes_mm(mask, sp)
    def vs(ref):
        rv, (rL, rS, _) = volume_ml(ref, sp), axes_mm(ref, sp)
        return dict(dice=dice(mask, ref), vol_err_pct=100 * (v - rv) / rv, vol_change=vol_change(v, rv), long_err=L - rL, short_err=S - rS)
    q = {f"r1_{k}": round(x, 3) for k, x in vs(r1).items()}
    if r2:
        per = [vs(m) for m in r2.values()]
        q.update({f"r2_{k}": round(statistics.median(p[k] for p in per), 3) for k in per[0]})
        q["r2_readers"] = len(per)
    return q, v, L, S

if __name__ == "__main__":
    root, runs, timing, out = sys.argv[1:5]
    roles = (sys.argv[5] if len(sys.argv) > 5 else "timed").split(",")
    cases = {r["patient"]: r for r in csv.DictReader(open(os.path.join(here, "cases.csv")))}
    yard = {r["yardstick"]: float(r["p90"]) for r in csv.DictReader(open(os.path.join(here, "runs", "yardsticks.csv")))}
    cut_v, cut_l = yard["R1 scan vs repeat, volume"], yard["R1 scan vs repeat, long axis"]
    hard_f = os.path.join(root, os.pardir, "eval", "hard_cases.csv")
    hard = {r["patient"]: r for r in csv.DictReader(open(hard_f))} if os.path.exists(hard_f) else {}
    ev = [dict(e, ts=utc(e["t"])) for e in map(json.loads, open(os.path.join(runs, "events.jsonl")))]
    Q, cache, rows = qiba_index(os.path.join(root, "series")), {}, []
    for tr in csv.DictReader(open(timing)):
        if tr["role"] not in roles or tr["condition"] != "assisted": continue
        row = {k: tr[k] for k in ("started_at", "status", "patient", "role", "scan", "operator", "tool_sha", "load_s", "outline_s", "axes_s", "record_s", "total_s", "scan_total_s", "note")}
        c = cases[tr["patient"]]; row.update(stratum=c["stratum"], order=c["order"])
        if tr["patient"] in hard: row.update(irregular=hard[tr["patient"]]["irregular"], touching=hard[tr["patient"]]["touching_tag"])
        if tr["status"] != "done": rows.append(row); continue
        scan_id = f"{tr['patient']}_{tr['scan']}"
        recs = [e["ts"] for e in ev if e["action"] == "record" and e.get("scan") == scan_id]
        if "." in tr["started_at"]:  # the fixed stopwatch (ms): started_at is the first Enter, so no lining up
            gap = 0.0
        else:  # older rows: the smallest gap (0.5 s steps, up to 10 min) that puts one of this scan's Records in the record phase
            gap = next((g / 2 for g in range(1201) if any(phases(tr, g / 2)[-1][1] <= t_ <= phases(tr, g / 2)[-1][2] for t_ in recs)), 0.0)
        ph = phases(tr, gap); row["aligned_gap_s"] = gap
        row["record_in_record_phase"] = any(ph[-1][1] <= t_ <= ph[-1][2] + dt.timedelta(seconds=5) for t_ in recs)  # False: e.g. an early Enter in the tool
        mine = [e for e in ev if e.get("scan") == scan_id and ph[0][1] <= e["ts"] <= ph[-1][2] + dt.timedelta(seconds=5)]
        model = [e for e in mine if e["action"] in MODEL]
        row.update(model_runs=len(model), model_s=round(sum(e["seconds"] for e in model), 1),
                   plus=sum(e["action"] == "nodule_start" or (e["action"] == "click" and e["positive"]) for e in model),
                   minus=sum(e["action"] == "click" and not e["positive"] for e in model),
                   undo=sum(e["action"] == "undo" for e in mine), refused=sum(e["action"] == "click_refused" for e in mine),
                   nodules=sum(e["action"] == "nodule_start" for e in mine), discards=sum(e["action"] == "discard" for e in mine))
        ui = [e for e in ev if e.get("scan") in (scan_id, None) and ph[0][1] <= e["ts"] <= ph[-1][2] + dt.timedelta(seconds=5)]  # UI events may name no scan
        row.update(start_over=sum(e["action"] == "start_over" for e in ui), zooms=sum(e["action"] in ("zoom", "zoom_fit", "zoom_area") for e in ui))
        shots = [e for e in ui if e["action"] == "screenshot"]
        if shots:  # Copy row (or Record, with no Copy row) -> Save screenshot, from the log
            before = [e for e in ui if e["action"] in ("copy_row", "record") and e["ts"] <= shots[0]["ts"]]
            row["screenshot_gap_s"] = round((shots[0]["ts"] - before[-1]["ts"]).total_seconds(), 1) if before else None
        for name, a, b in ph:  # model seconds inside each phase, so the PC re-timing changes the right step
            ms = [e for e in model if a <= e["ts"] < b]; row[f"{name}_model_s"] = round(sum(e["seconds"] for e in ms), 1); row[f"{name}_runs"] = len(ms)
        for k, s_click in PC_S.items():
            for name, _, _ in ph:
                row[f"{name}_{k}_s"] = round(float(tr[f"{name}_s"]) - row[f"{name}_model_s"] + row[f"{name}_runs"] * s_click, 1)
            row[f"total_{k}_s"] = round(sum(row[f"{n}_{k}_s"] for n, _, _ in ph), 1)
            row[f"scan_total_{k}_s"] = round(float(tr["load_s"]) + row[f"total_{k}_s"], 1)  # per scan, with opening it (no model in loading)
        rec = [e for e in mine if e["action"] == "record"]
        row["records"] = len(rec)
        if not rec: rows.append(row); continue
        r = rec[-1]; key = (r["run"], r["nodule"])
        clicks = [(e["z"], e["y"], e["x"]) for e in model if (e["run"], e["nodule"]) == key]
        first = [e for e in model if e["action"] == "nodule_start" and (e["run"], e["nodule"]) == key]
        ct, r1, r2 = r1_r2(root, tr["patient"], Q, cache)[tr["scan"]]
        acc = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(runs, r["outline_file"]))) > 0
        q, v, L, S = quality(acc, ct, r1, r2); row.update(q)
        Le, Se, _ = axes_mm(acc, ct.GetSpacing(), edges=r["width_method"] == "edge to edge")
        row.update(tool_volume_ml=r["volume_ml"], tool_long_mm=r["long_mm"], tool_short_mm=r["short_mm"], width_method=r["width_method"],
                   clicks_in_outline=r["clicks"], tool_at_window_edge=r["at_window_edge"], outline_file=r["outline_file"],
                   check_volume=round(r["volume_ml"] - v, 2), check_long=round(r["long_mm"] - Le, 2), check_short=round(r["short_mm"] - Se, 2),
                   edge_reach=edge_reach(acc, clicks))
        grow = [(e["z"], e["y"], e["x"]) for e in model if (e["run"], e["nodule"]) == key and (e["action"] == "nodule_start" or e["positive"])]
        sp_zyx = ct.GetSpacing()[::-1]
        row["our_window_edge"], row["our_box_edge"] = at_edge(acc, grow, clicks[0], sp_zyx) if clicks else (None, None)
        row["failure"] = q["r1_vol_change"] > cut_v or abs(q["r1_long_err"]) > cut_l
        if first:  # placement: from the scan open at the hint to the start of the outline (the event is logged after the model)
            row["placement_s"] = round((first[0]["ts"] - dt.timedelta(seconds=first[0]["seconds"]) - ph[0][1]).total_seconds(), 1)
            z, y, x = clicks[0]; centre = np.argwhere(r1).mean(0)
            row.update(click_z=z, click_y=y, click_x=x)  # eval/replay.py starts its corrections here
            row["click_mm_from_r1_centre"] = round(float(np.linalg.norm((np.array([x, y, z]) - centre[::-1]) * np.array(ct.GetSpacing()))), 1)
            row["click_in_r1"] = bool(r1[z, y, x])
        if first and first[0].get("outline_file"):
            f1 = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(runs, first[0]["outline_file"]))) > 0
            row["first_outline_file"] = first[0]["outline_file"]
            row["first_at_window_edge"], row["first_at_box_edge"] = at_edge(f1, [clicks[0]], clicks[0], ct.GetSpacing()[::-1])
            row.update({f"first_{k}": x for k, x in quality(f1, ct, r1, r2)[0].items() if k in ("r1_dice", "r1_vol_err_pct", "r2_dice", "r2_vol_err_pct")})
        rows.append(row)
    # Our rule for runs with no screenshot (set before scoring): add the
    # larger of 1 s and the retest runs' median Copy row -> Save screenshot time, and count the run as complete.
    gaps = [r["screenshot_gap_s"] for r in rows if r.get("screenshot_gap_s") is not None and r["scan"] == "retest"]
    add = max(1.0, statistics.median(gaps)) if gaps else 1.0
    for r in rows:
        if r.get("records") and "screenshot_gap_s" not in r:
            r["screenshot_added_s"], r["record_measured_s"] = add, r["record_s"]
            for k in ["record_s", "total_s", "scan_total_s"] + [f"{n}_{c}_s" for c in PC_S for n in ("record", "total", "scan_total")]:
                if r.get(k) not in (None, ""): r[k] = round(float(r[k]) + add, 1)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
    for r in rows:
        print(r["patient"], r["scan"], r["status"], f"total {r['total_s']} s (pc4 {r.get('total_pc4_s')})", f"model runs {r.get('model_runs')}",
              f"Dice R1 {r.get('r1_dice')} R2 {r.get('r2_dice')}", f"failure {r.get('failure')}", f"checks {r.get('check_volume')}/{r.get('check_long')}/{r.get('check_short')}")
