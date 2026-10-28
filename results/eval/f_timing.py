"""Re-find time (protocol §Follow-up matching, v1.12), from the tool's own event log, no stopwatch: per follow-up scan,
from its last open_scan before the accept to followup_confirm (Measure here at the proposal), less that start's model
seconds. Find and its wait (the map event's seconds) fall inside. A follow-up scan where Find ran (map or map_failed)
but nothing was accepted is reported as "not accepted", with its time to its last event. A scan accepted twice is the
protocol's untimed try on the first pair: its earlier row is marked "try".
Usage: python -I eval/f_timing.py <runs dir holding events.jsonl> <out.csv>"""
import csv, json, os, statistics, sys
from datetime import datetime

def ts(e): return datetime.fromisoformat(e["t"].replace("Z", "+00:00"))

def runs(events):
    rows, done = [], set()
    for i, e in enumerate(events):
        if e["action"] != "followup_confirm": continue
        on = [x for x in events[:i] if x.get("scan") == e["scan"]]
        o = [x for x in on if x["action"] == "open_scan"][-1]
        s = [x for x in on if x["action"] == "nodule_start"][-1]
        m = [x for x in on if x["action"] == "map" and ts(x) >= ts(o)]
        rows.append(dict(scan=e["scan"], status="accepted", follows=e["follows"], seconds=round((ts(e) - ts(o)).total_seconds() - s["seconds"], 1),
                         find_seconds=m[-1]["seconds"] if m else "", model_seconds=s["seconds"]))
        done.add(e["scan"])
    for scan in dict.fromkeys(e["scan"] for e in events if e["action"] in ("map", "map_failed")):
        if scan in done: continue
        on = [x for x in events if x.get("scan") == scan]
        o = [x for x in on if x["action"] == "open_scan"][-1]
        rows.append(dict(scan=scan, status="not accepted", follows="", seconds=round((ts(on[-1]) - ts(o)).total_seconds(), 1), find_seconds="", model_seconds=""))
    for scan in {r["scan"] for r in rows}:  # the protocol's untimed try: a scan accepted more than once keeps only its last
        acc = [r for r in rows if r["scan"] == scan and r["status"] == "accepted"]
        for r in acc[:-1]: r["status"] = "try"
    return rows

# self-check: open at 0 s, Find takes 15 s, accept at 20.5 s with a 1.5 s start: 19.0 s; a second scan whose Find failed
_e = lambda t, a, scan, **k: dict(t=f"2026-10-27T10:00:{t:04.1f}Z", action=a, scan=scan, **k)
_r = runs([_e(0, "open_scan", "P_retest"), _e(1, "open_scan", "P_test"), _e(16, "map", "P_retest", seconds=15.0),
           _e(20.5, "nodule_start", "P_retest", seconds=1.5), _e(20.5, "followup_confirm", "P_retest", follows="outlines/P_test_n1_accepted.nii.gz"),
           _e(30, "open_scan", "Q_retest"), _e(45, "map_failed", "Q_retest")])
assert [(r["scan"], r["status"], r["seconds"], r["find_seconds"]) for r in _r] == [("P_retest", "accepted", 19.0, 15.0), ("Q_retest", "not accepted", 15.0, "")], _r
_r = runs([_e(0, "open_scan", "P_retest"), _e(5, "nodule_start", "P_retest", seconds=1), _e(5, "followup_confirm", "P_retest", follows="f"),
           _e(30, "open_scan", "P_retest"), _e(33, "nodule_start", "P_retest", seconds=1), _e(33, "followup_confirm", "P_retest", follows="f")])
assert [(r["status"], r["seconds"]) for r in _r] == [("try", 4.0), ("accepted", 2.0)], _r

if __name__ == "__main__":
    src, out = sys.argv[1:3]
    rows = runs([json.loads(l) for l in open(os.path.join(src, "events.jsonl")) if l.strip()])
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["scan", "status", "follows", "seconds", "find_seconds", "model_seconds"]); w.writeheader(); w.writerows(rows)
    ok = [r["seconds"] for r in rows if r["status"] == "accepted"]
    print(f"{len(ok)} accepted of {len(rows)}; seconds median {statistics.median(ok) if ok else '-'}, range {min(ok, default='-')}-{max(ok, default='-')}")
