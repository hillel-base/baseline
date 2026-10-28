"""Q3c totals (protocol §Quality): his first click alone (step 0) and the modelled corrector, who stops at the steering
reference's own bar or after MAX corrections, per steering arm, from eval/replay.py's rows (start "his click").
Usage: python -I eval/q3c_summary.py <replay.csv> <out.csv>"""
import csv, statistics as st, sys

LAB_BAR = (10.0, 2.0)  # his own re-measures: "roughly 10%" in volume, "a couple of millimetres" on the axes (the lab's research fellow, 2026-10-24)

def within(row, ref, bar):
    return row.get(f"{ref}_vol_change") not in (None, "") and float(row[f"{ref}_vol_change"]) <= bar[0] and abs(float(row[f"{ref}_long_err"])) <= bar[1]

def summary(rows):
    out = []
    for arm in ("R1", "R2"):
        by = {}
        for r in rows:
            if r.get("steer") == arm and r.get("start") == "his click": by.setdefault((r["patient"], r["scan"]), []).append(r)
        if not by: continue
        first = [v[0] for v in by.values()]
        reach = [next((int(x["step"]) for x in v if x["within_own_bar"] == "True"), None) for v in by.values()]
        stop = [next((x for x in v if x["within_own_bar"] == "True"), v[-1]) for v in by.values()]
        med = lambda xs, k: round(st.median(float(x[k]) for x in xs if x.get(k) not in (None, "")), 3)
        ref = arm.lower()  # the lab's bar, as a sensitivity check, against the steering reference
        d_reach = [next((int(x["step"]) for x in v if within(x, ref, LAB_BAR)), None) for v in by.values()]
        out.append(dict(steer=arm, scans=len(by),
                        click_within_own_bar=sum(x["within_own_bar"] == "True" for x in first), click_within_r1_line=sum(x["within_r1_line"] == "True" for x in first),
                        reached_own_bar=sum(x is not None for x in reach), corrections_median=st.median([x for x in reach if x is not None]),
                        corrections_max_used=max(x for x in reach if x is not None), not_reached=sum(x is None for x in reach),
                        stop_r1_dice=med(stop, "r1_dice"), stop_r2_dice=med(stop, "r2_dice"), stop_r1_vol_change=med(stop, "r1_vol_change"),
                        stop_within_r1_line=sum(x["within_r1_line"] == "True" for x in stop),
                        click_within_lab_bar=sum(within(x, ref, LAB_BAR) for x in first), reached_lab_bar=sum(x is not None for x in d_reach),
                        lab_bar_corrections_median=st.median([x for x in d_reach if x is not None]) if any(x is not None for x in d_reach) else "",
                        lab_bar_not_reached=sum(x is None for x in d_reach)))
    return out

_r = [dict(steer="R1", start="his click", patient="P", scan="test", step=str(i), within_own_bar=str(i == 2), within_r1_line="True", r1_dice=str(0.6 + i / 10),
           r2_dice="0.5", r1_vol_change=str(30 - 10 * i), r1_long_err="1") for i in range(4)]
_s = summary(_r)[0]
assert (_s["reached_own_bar"], _s["corrections_median"], _s["stop_r1_dice"], _s["click_within_own_bar"]) == (1, 2, 0.8, 0), _s
assert (_s["click_within_lab_bar"], _s["reached_lab_bar"], _s["lab_bar_corrections_median"]) == (0, 1, 2), _s  # 30%, 20%, 10%: within at step 2

if __name__ == "__main__":
    rows = summary(list(csv.DictReader(open(sys.argv[1]))))
    with open(sys.argv[2], "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
    for r in rows: print(r)
