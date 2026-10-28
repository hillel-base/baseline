"""The verdict per step and the weekly projection (protocol §Timing, §Reporting), against the lab's reported times.
The lab's reported figures: axes 2-4 min per nodule; volume 15-25 min per tumour; record 3-5 min per scan;
12-15 scans a week, 1-2 nodules each, a volume for about 1 tumour in 5 today. Re-finding (10 min a nodule) is left out:
F is not timed, so it would be the same on both sides.
Tool time per step, per run (eval/score.py rows; corrections from eval/replay.py rows):
- (a) measured: axes step = outline + axes phases (the tool gives axes from its outline); record = record phase;
  the volume comes with the outline, so the volume step is the outline phase.
- (b) (a) plus the corrections needed to reach the steering reference's own bar (5, labelled, if not reached), each
  costing the run's own placement time plus the model's time per click.
- Mac as measured; standard PC (pc) with S7's 19.8 s per model run instead of the measured model seconds; small PC (pc2) with 44.6 s.
Rows also give the quartiles, the time per tumour and per scan (with opening it).
Verdict: a step is "clear" if the slowest tool time x 4 is under the lab's low end.
Usage: python -I eval/project.py <scores.csv> <replay.csv> <out.csv> [roles, default timed] [steer, default R1] [lab: correct to the lab's 10%, 2 mm instead]"""
import csv, statistics as st, sys

LAB = {"volume": (15 * 60, 25 * 60), "axes": (2 * 60, 4 * 60), "record": (3 * 60, 5 * 60)}  # seconds, per tumour / nodule / scan
WEEK = dict(scans=(12, 15), nodules_per_scan=(1, 2), volume_share_today=0.2)
PC_CLICK, CAP = {"pc": 19.8, "pc2": 44.6}, 5
# The whole hands-on week behind our target (our arithmetic from the lab's figures, midpoints): finding ~200 min, untouched by the
# tool; re-finding ~105 min today, ~26 min assumed with F (not yet timed by hand). The measuring steps are this script's.
TARGET_WEEK = dict(find_min=200, refind_min=105, refind_assumed_min=26)

def corrections(replay_rows, steer, bar=None):
    """{(started_at, patient, scan): corrections to the own bar (CAP if not reached), from his-click arms.
    bar=(volume %, long axis mm): a stricter bar instead (the lab's own, as a sensitivity check), against the steering reference."""
    out = {}
    for r in replay_rows:
        if r.get("start") != "his click" or r.get("steer") != steer: continue
        k = (r["started_at"], r["patient"], r["scan"])
        ref = steer.lower()
        ok = r.get("within_own_bar") == "True" if bar is None else (float(r[f"{ref}_vol_change"]) <= bar[0] and abs(float(r[f"{ref}_long_err"])) <= bar[1])
        if ok: out[k] = min(out.get(k, CAP), int(r["step"]))
        else: out.setdefault(k, CAP)
    return out

def failed_b(replay_rows, steer):
    """{(started_at, patient, scan): True if the corrected outline (at the step that reached the bar, or the last) is outside R1's failure line}."""
    by = {}
    for r in replay_rows:
        if r.get("start") == "his click" and r.get("steer") == steer: by.setdefault((r["started_at"], r["patient"], r["scan"]), []).append(r)
    out = {}
    for k, v in by.items():
        at = next((x for x in v if x.get("within_own_bar") == "True"), v[-1])
        out[k] = at.get("within_r1_line") != "True"
    return out

def steps(run, n_corr, machine):
    """Seconds per step for one run: volume, axes, record; n_corr modelled corrections added to volume and axes."""
    f = lambda k: float(run[k])
    if machine == "mac":
        outline, axes, record, per_click = f("outline_s"), f("axes_s"), f("record_s"), f("model_s") / max(1, int(run["model_runs"]))
    else:
        c = "pc4" if machine == "pc" else "pc2"
        outline, axes, record, per_click = f(f"outline_{c}_s"), f(f"axes_{c}_s"), f(f"record_{c}_s"), PC_CLICK[machine]
    extra = n_corr * (f("placement_s") + per_click)
    return {"volume": outline + extra, "axes": outline + axes + extra, "record": record, "load": f("load_s")}

def spread(v):
    q = st.quantiles(v, n=4)
    return dict(median_s=round(st.median(v), 1), q1_s=round(q[0], 1), q3_s=round(q[2], 1), fastest_s=round(min(v), 1), slowest_s=round(max(v), 1))

def week_hours(t, scenario, which):
    """Hands-on hours a week for measuring and recording; t: seconds per step; which: 0 low, 1 high, 2 mid of the mix."""
    pick = lambda lo_hi: (lo_hi[0], lo_hi[1], sum(lo_hi) / 2)[which]
    scans = pick(WEEK["scans"]); nod = scans * pick(WEEK["nodules_per_scan"])
    share = WEEK["volume_share_today"] if scenario == "today" else 1.0
    return (scans * t["record"] + nod * t["axes"] + nod * share * t.get("volume_extra", t["volume"])) / 3600

# self-check: the lab's mid week today = 13.5 scans, 20.25 nodules: 13.5*240 + 20.25*180 + 4.05*1200 = 3240+3645+4860 s
_mid = {k: sum(v) / 2 for k, v in LAB.items()}
assert abs(week_hours(_mid, "today", 2) - (3240 + 3645 + 4860) / 3600) < 1e-9

if __name__ == "__main__":
    scores_csv, replay_csv, out = sys.argv[1:4]
    roles = (sys.argv[4] if len(sys.argv) > 4 else "timed").split(","); steer = sys.argv[5] if len(sys.argv) > 5 else "R1"
    bar = (10.0, 2.0) if len(sys.argv) > 6 and sys.argv[6] == "lab" else None  # the lab's re-measure: about 10%, a couple of mm
    runs = [r for r in csv.DictReader(open(scores_csv)) if r["role"] in roles and r["status"] == "done" and r.get("outline_s")]
    rep_rows = list(csv.DictReader(open(replay_csv)))
    corr, fail_b = corrections(rep_rows, steer, bar), failed_b(rep_rows, steer)
    runs = [r for r in runs if (r["started_at"], r["patient"], r["scan"]) in corr]  # an arm covers only the runs it has (R2: no radiologists on timed case 2)
    rows = []
    for kind in ("a", "b"):
        for machine in ("mac", "pc", "pc2"):
            per = [steps(r, corr.get((r["started_at"], r["patient"], r["scan"]), CAP) if kind == "b" else 0, machine) for r in runs]
            if not per: continue
            for s in ("volume", "axes", "record"):
                v = [p[s] for p in per]; slow = max(v)
                rows.append(dict(kind=kind, machine=machine, step=s, runs=len(per), **spread(v),
                                 lab_low_s=LAB[s][0], verdict="clear" if slow * 4 < LAB[s][0] else "not clear"))
            # per tumour: outline, axes look and record; per scan: with opening it (the lab's unit; one tumour per RIDER scan)
            for name, v in (("per tumour", [p["axes"] + p["record"] for p in per]), ("per scan", [p["load"] + p["axes"] + p["record"] for p in per])):
                rows.append(dict(kind=kind, machine=machine, step=name, runs=len(per), **spread(v)))
            # protocol §Timing: a failure is reported as a failure, not as time saved; the rule above still counts every run
            ok = [p for p, r in zip(per, runs) if not (r["failure"] == "True" if kind == "a" else fail_b.get((r["started_at"], r["patient"], r["scan"]), True))]
            rows.append(dict(kind=kind, machine=machine, step="per scan, failures left out", runs=len(ok), **spread([p["load"] + p["axes"] + p["record"] for p in ok])))
            # the tool's volume comes with its outline, so in the week it costs nothing beyond the axes step
            tool = {s: st.median(p[s] for p in per) for s in ("axes", "record")}; tool["volume_extra"] = 0.0; tool["volume"] = 0.0
            slow = {s: max(p[s] for p in per) for s in ("axes", "record")}; slow["volume_extra"] = 0.0; slow["volume"] = 0.0  # every run as slow as the slowest
            for scenario in ("today", "every tumour"):
                for which, name in ((2, "mid"), (0, "low"), (1, "high")):
                    man = week_hours({k: (v[0] if which == 0 else v[1] if which == 1 else sum(v) / 2) for k, v in LAB.items()}, scenario, which)
                    if scenario == "today" and name == "mid":  # like for like with our target of 45% (35-55%) of the whole week
                        whole = TARGET_WEEK["find_min"] + 60 * man + TARGET_WEEK["refind_min"]
                        for refind, label in ((TARGET_WEEK["refind_min"], "re-find unchanged"), (TARGET_WEEK["refind_assumed_min"], "re-find as the target assumed")):
                            with_tool = TARGET_WEEK["find_min"] + 60 * week_hours(tool, scenario, which) + refind
                            rows.append(dict(kind=kind, machine=machine, step=f"whole week (target basis), {label}", runs=len(per),
                                             lab_min=round(whole), tool_min=round(with_tool), saved_pct=round(100 * (1 - with_tool / whole), 1)))
                    rows.append(dict(kind=kind, machine=machine, step=f"week, volume {scenario}, lab {name}", runs=len(per),
                                     lab_hours=round(man, 2), tool_hours=round(week_hours(tool, scenario, which), 2), tool_hours_slowest=round(week_hours(slow, scenario, which), 2),
                                     saved_pct=round(100 * (1 - week_hours(tool, scenario, which) / man), 1)))
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(rows)
    for r in rows: print(r)
