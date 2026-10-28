"""Q2 (protocol §Quality): repeatability. Per timed patient, the tool's test-to-retest change (volume, long axis) from the
operator's runs, next to the expert's (R1's) own test-to-retest change on the same patient.
The cross puts both of his clicks at R1's centre voxel on each scan, which helps the tool's repeatability; Q3b shows how
much the first outline moves when the click does not.
Usage: python -I eval/q2.py <scores.csv> <out.csv>"""
import csv, statistics, sys

def vol_change(a, b): return 100 * abs(a - b) / ((a + b) / 2)  # as eval/score.py

def q2(rows):
    by = {}
    for r in rows:
        if r.get("tool_volume_ml") in (None, ""): continue
        v, L, S = float(r["tool_volume_ml"]), float(r["tool_long_mm"]), float(r.get("tool_short_mm") or 0)
        by.setdefault(r["patient"], {})[r["scan"]] = (v, v / (1 + float(r["r1_vol_err_pct"]) / 100), L, L - float(r["r1_long_err"]), S, S - float(r.get("r1_short_err") or 0))
    out = []
    for p, d in by.items():
        if set(d) != {"test", "retest"}: continue
        (v1, e1, l1, el1, s1, es1), (v2, e2, l2, el2, s2, es2) = d["test"], d["retest"]
        out.append(dict(patient=p, tool_vol_change=round(vol_change(v1, v2), 1), r1_vol_change=round(vol_change(e1, e2), 1),
                        tool_long_change_mm=round(abs(l1 - l2), 1), r1_long_change_mm=round(abs(el1 - el2), 1),
                        tool_short_change_mm=round(abs(s1 - s2), 1), r1_short_change_mm=round(abs(es1 - es2), 1)))
    return out

# self-check: tool 10 -> 11 mL (9.5%), expert 10 -> 12 mL (18.2%)
_r = q2([dict(patient="P", scan="test", tool_volume_ml="10", tool_long_mm="20", r1_vol_err_pct="0", r1_long_err="0"),
         dict(patient="P", scan="retest", tool_volume_ml="11", tool_long_mm="21", r1_vol_err_pct="-8.3333333", r1_long_err="0")])
assert _r[0]["tool_vol_change"] == 9.5 and _r[0]["r1_vol_change"] == 18.2, _r

if __name__ == "__main__":
    rows = q2(list(csv.DictReader(open(sys.argv[1]))))
    with open(sys.argv[2], "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    m = lambda k: statistics.median(r[k] for r in rows)
    print(f"{len(rows)} patients; volume change test-retest: tool median {m('tool_vol_change')}%, expert {m('r1_vol_change')}%; "
          f"tool below the expert in {sum(r['tool_vol_change'] <= r['r1_vol_change'] for r in rows)}; long axis: tool {m('tool_long_change_mm')} mm, expert {m('r1_long_change_mm')} mm; "
          f"short axis: tool {m('tool_short_change_mm')} mm, expert {m('r1_short_change_mm')} mm; tool above R1's repeat 90th percentile (45.3%): {sum(r['tool_vol_change'] > 45.3 for r in rows)}")
