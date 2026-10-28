"""Q3 and Q3b totals (protocol §Quality), from eval/q3.py's per-patient files: medians and counts only, per group.
Groups: all scans; small tumours (stratum S); hard-case tags irregular, touching, either (eval/hard_cases.py).
- Q3, per steering arm: Dice and volume change against R1 and R2 after 1, 3 and 6 clicks; corrections to the steering
  reference's own bar and to the R1 failure line (median; "not reached within 5" counted).
- Q3b(1): per scan, the spread over the deepest voxel and its 4 one-pixel neighbours (R1-steered), after 1 and 3 clicks.
- Q3b(2): per scan, the spread over the cross and the 3 and 5 mm offsets, first click only.
Spread: volume as (largest - smallest) / median, in % (the protocol's definition); long axis as largest - smallest, in mm
(both from the errors against R1, whose volume and long axis are fixed per scan). The ratio to the median is unstable when
most starts give a near-empty outline, so Q3b(2) also gives the range as a share of R1's volume, and how many first
outlines are over twice or under half R1's volume.
Usage: python -I eval/q3_summary.py <q3 dir> <data/eval/hard_cases.csv> eval/runs/q3_summary.csv"""
import csv, glob, os, statistics as st, sys
here = os.path.dirname(os.path.abspath(__file__))
_y = {r["yardstick"]: r for r in csv.DictReader(open(os.path.join(here, "runs", "yardsticks.csv")))}
BAR_V, LINE_V = float(_y["R1 scan vs repeat, volume"]["median"]), float(_y["R1 scan vs repeat, volume"]["p90"])  # 17.1%, 45.3%

def num(r, k):
    return float(r[k]) if r.get(k) not in (None, "") else None

def spread(rows):
    """(volume spread %, long-axis spread mm) over rows of one scan."""
    v = [100 + num(r, "r1_vol_err_pct") for r in rows]; L = [num(r, "r1_long_err") for r in rows]
    return round(100 * (max(v) - min(v)) / st.median(v), 1), round(max(L) - min(L), 1)

def pairwise(rows):
    """(median volume change in %, median long-axis change in mm) between every two first outlines of one scan; the volume
    change as |a - b| / mean(a, b), like R1's scan-to-repeat yardstick, so the two compare directly."""
    v = [100 + num(r, "r1_vol_err_pct") for r in rows]; L = [num(r, "r1_long_err") for r in rows]
    pv = [100 * abs(a - b) / ((a + b) / 2) for i, a in enumerate(v) for b in v[i + 1:] if a + b > 0]
    pl = [abs(a - b) for i, a in enumerate(L) for b in L[i + 1:]]
    return st.median(pv), st.median(pl), pv

def first(rows, key):
    """The first step at which key is True, or None (not reached)."""
    return next((int(r["step"]) for r in sorted(rows, key=lambda r: int(r["step"])) if r.get(key) == "True"), None)

assert spread([{"r1_vol_err_pct": "-10", "r1_long_err": "1"}, {"r1_vol_err_pct": "10", "r1_long_err": "-2"}]) == (20.0, 3.0)
assert pairwise([{"r1_vol_err_pct": "-20", "r1_long_err": "1"}, {"r1_vol_err_pct": "20", "r1_long_err": "4"}])[:2] == (40.0, 3.0)
assert first([{"step": "2", "x": "True"}, {"step": "1", "x": "False"}], "x") == 2 and first([{"step": "0", "x": "False"}], "x") is None

if __name__ == "__main__":
    q3dir, hard_f, out = sys.argv[1:4]
    rows = [r for f in sorted(glob.glob(os.path.join(q3dir, "*.csv"))) for r in csv.DictReader(open(f)) if not r.get("refused")]
    cases = {r["patient"]: r for r in csv.DictReader(open(os.path.join(here, "cases.csv")))}
    hard = {r["patient"]: r for r in csv.DictReader(open(hard_f))}
    groups = {"all": lambda p: True, "small": lambda p: cases[p]["stratum"] == "S", "irregular": lambda p: hard[p]["irregular"] == "True",
              "touching": lambda p: hard[p]["touching_tag"] == "True", "hard (either)": lambda p: hard[p]["hard"] == "True"}
    scans = sorted({(r["patient"], r["scan"]) for r in rows})
    res = []
    for g, keep in groups.items():
        sc = [s for s in scans if keep(s[0])]
        if not sc: continue
        out_row = dict(group=g, patients=len({p for p, _ in sc}), scans=len(sc))
        for arm in ("R1", "R2"):
            arm_rows = {s: [r for r in rows if (r["patient"], r["scan"]) == s and r["part"] == "q3" and r["steer"] == arm] for s in sc}
            arm_rows = {s: v for s, v in arm_rows.items() if v}
            if not arm_rows: continue
            a = arm.lower(); out_row[f"{a}_steered_scans"] = len(arm_rows)
            for step in (0, 2, 5):  # after 1, 3 and 6 clicks
                at = [next((r for r in v if int(r["step"]) == step), v[-1]) for v in arm_rows.values()]
                for ref in ("r1", "r2"):
                    d = [num(r, f"{ref}_dice") for r in at if num(r, f"{ref}_dice") is not None]
                    vc = [num(r, f"{ref}_vol_change") for r in at if num(r, f"{ref}_vol_change") is not None]
                    if d: out_row[f"{a}_steered_click{step + 1}_{ref}_dice"] = round(st.median(d), 3); out_row[f"{a}_steered_click{step + 1}_{ref}_vol_change"] = round(st.median(vc), 1)
            own = [first(v, "within_own_bar") for v in arm_rows.values()]; line = [first(v, "within_r1_line") for v in arm_rows.values()]
            out_row[f"{a}_steered_corrections_to_own_bar_median"] = st.median([x for x in own if x is not None]) if any(x is not None for x in own) else None
            out_row[f"{a}_steered_own_bar_not_reached"] = sum(x is None for x in own)
            out_row[f"{a}_steered_r1_line_not_reached"] = sum(x is None for x in line)
        for step in (0, 2):  # Q3b(1): the deepest voxel (Q3, R1 arm) and its neighbours, after 1 and 3 clicks
            sp = []
            for s in sc:
                at = [r for r in rows if (r["patient"], r["scan"]) == s and int(r["step"]) == step and (r["part"] == "q3b1" or (r["part"] == "q3" and r["steer"] == "R1"))]
                if len(at) > 1: sp.append(spread(at))
            if sp: out_row[f"q3b1_click{step + 1}_vol_spread_pct_median"] = round(st.median(x for x, _ in sp), 1); out_row[f"q3b1_click{step + 1}_long_spread_mm_median"] = round(st.median(y for _, y in sp), 1)
        sp, d1, rng, starts, pw = [], [], [], [], []
        for s in sc:  # Q3b(2): the cross and its offsets, first click only
            at = [r for r in rows if (r["patient"], r["scan"]) == s and r["part"] == "q3b2"]
            if len(at) > 1:
                sp.append(spread(at)); d1 += [num(r, "r1_dice") for r in at]
                e = [num(r, "r1_vol_err_pct") for r in at]; rng.append(max(e) - min(e)); pw.append(pairwise(at))
                starts += [(num(r, "r1_vol_err_pct"), r["start"] == "cross") for r in at]
        if sp:
            out_row.update(q3b2_vol_spread_pct_median=round(st.median(x for x, _ in sp), 1), q3b2_vol_spread_pct_max=round(max(x for x, _ in sp), 1),
                           q3b2_vol_range_pct_of_r1_median=round(st.median(rng), 1), q3b2_vol_range_pct_of_r1_max=round(max(rng), 1),
                           q3b2_pairwise_vol_change_median=round(st.median(x[0] for x in pw), 1), q3b2_pairwise_long_change_mm_median=round(st.median(x[1] for x in pw), 1),
                           q3b2_pairs=sum(len(x[2]) for x in pw), q3b2_pairs_over_bar_pct=round(100 * sum(v > BAR_V for x in pw for v in x[2]) / sum(len(x[2]) for x in pw), 1),
                           q3b2_pairs_over_line_pct=round(100 * sum(v > LINE_V for x in pw for v in x[2]) / sum(len(x[2]) for x in pw), 1),
                           # the cross itself and the clicks 3 and 5 mm off it, counted apart
                           q3b2_starts=len(starts), q3b2_offset_starts=sum(not c for _, c in starts),
                           q3b2_starts_over_2x_r1=sum(e > 100 for e, c in starts if not c), q3b2_starts_under_half_r1=sum(e < -50 for e, c in starts if not c),
                           q3b2_cross_over_2x_r1=sum(e > 100 for e, c in starts if c), q3b2_cross_under_half_r1=sum(e < -50 for e, c in starts if c),
                           q3b2_long_spread_mm_median=round(st.median(y for _, y in sp), 1), q3b2_long_spread_mm_max=round(max(y for _, y in sp), 1), q3b2_r1_dice_median=round(st.median(d1), 3))
        res.append(out_row)
    keys = list(dict.fromkeys(k for r in res for k in r))
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys); w.writeheader(); w.writerows(res)
    for r in res: print(r)
