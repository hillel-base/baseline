"""The Record step with the study record (protocol §The Record step with the study record): "with the record"
(the version with the study record, the row saved by the tool) against "with the paste" (the 18 timed runs: Copy row, paste, screenshot).
(1) The record phase from the stopwatch: study-record rows (setup containing "study record") against the timed runs' record_s in
    scores.csv (with our screenshot rule).
(2) From the tool's logs, the part that differs: Record -> Save screenshot. With the record: waiting for "saved"; with the paste:
    Copy row, the paste and the switch back (sitting 2 only: sitting 1 skipped most screenshots).
Usage: python -I eval/record_step.py <timing.csv> <scores.csv> <study-record runs dir> <timed runs dir> <out.csv>"""
import csv, json, os, statistics as st, sys
from datetime import datetime

def ts(e): return datetime.fromisoformat(e["t"].replace("Z", "+00:00"))

def gaps(events, scans):
    """Seconds from each scan's last Record to its first Save screenshot after it."""
    out = []
    for scan in scans:
        rec = [e for e in events if e.get("scan") == scan and e["action"] == "record"]
        if not rec: continue
        shot = [e for e in events if e.get("scan") == scan and e["action"] == "screenshot" and ts(e) >= ts(rec[-1])]
        if shot: out.append(round((ts(shot[0]) - ts(rec[-1])).total_seconds(), 1))
    return out

def spread(v):
    q = st.quantiles(v, n=4) if len(v) > 1 else [v[0]] * 3
    return dict(n=len(v), median_s=round(st.median(v), 1), q1_s=round(q[0], 1), q3_s=round(q[2], 1), fastest_s=min(v), slowest_s=max(v))

_e = lambda t, a, scan: dict(t=f"2026-10-28T06:00:{t:02d}Z", action=a, scan=scan)
assert gaps([_e(1, "record", "A"), _e(4, "screenshot", "A"), _e(9, "record", "B")], ["A", "B"]) == [3.0]

if __name__ == "__main__":
    timing, scores, study_runs, timed, out = sys.argv[1:6]
    study_rows = [r for r in csv.DictReader(open(timing)) if "study record" in r["setup"] and r["status"] == "done"]
    paste_rows = [r for r in csv.DictReader(open(scores)) if r["role"] == "timed" and r["status"] == "done"]
    ev_study = [json.loads(l) for l in open(os.path.join(study_runs, "events.jsonl")) if l.strip()]
    ev_timed = [json.loads(l) for l in open(os.path.join(timed, "events.jsonl")) if l.strip()]
    rows = [dict(measure="record phase (stopwatch)", way="with the record", **spread([float(r["record_s"]) for r in study_rows])),
            dict(measure="record phase (stopwatch)", way="with the paste (timed runs)", **spread([float(r["record_s"]) for r in paste_rows])),
            dict(measure="Record to Save screenshot (log)", way="with the record", **spread(gaps(ev_study, [f"{r['patient']}_{r['scan']}" for r in study_rows]))),
            dict(measure="Record to Save screenshot (log)", way="with the paste (sitting 2)", **spread(gaps(ev_timed, [f"{r['patient']}_retest" for r in paste_rows if r["scan"] == "retest"])))]
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    for r in rows: print(r)
