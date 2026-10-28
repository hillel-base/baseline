"""The per-run table for results.md (protocol §Reporting): each of the 18 timed runs, its times next to its quality.
Usage: python -I eval/run_table.py <scores.csv>  (prints Markdown)"""
import csv, sys

def flags(r):
    out = []
    if r.get("record_in_record_phase") == "False": out.append("phase split unreliable")
    if r.get("start_over") not in ("", "0", None): out.append("Start over")
    if r.get("screenshot_added_s"): out.append(f"+{float(r['screenshot_added_s']):g} s screenshot")
    if r.get("failure") == "True": out.append("**failure**")
    return "; ".join(out)

def table(rows):
    head = ["Run", "Scan", "Size, tags", "Open", "Outline", "Axes", "Record", "Per tumour", "Per tumour, PC", "Click from cross (mm)",
            "Dice R1", "Dice R2", "Volume vs R1", "Long axis vs R1 (mm)", "Notes"]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for r in sorted(rows, key=lambda r: (r["scan"] != "test", int(r["order"]))):
        tags = r["stratum"] + "".join([", irregular"] * (r.get("irregular") == "True") + [", touching"] * (r.get("touching") == "True"))
        cells = [r["order"], f"{r['patient']} {r['scan']}", tags, r["load_s"], r["outline_s"], r["axes_s"], r["record_s"], r["total_s"], r["total_pc4_s"],
                 r.get("click_mm_from_r1_centre", ""), r.get("r1_dice", ""), r.get("r2_dice") or "–", f"{float(r['r1_vol_err_pct']):+.0f}%", f"{float(r['r1_long_err']):+.1f}", flags(r)]
        lines.append("| " + " | ".join(str(c) for c in cells) + " |")
    return "\n".join(lines)

assert flags(dict(record_in_record_phase="False", start_over="1", screenshot_added_s="5.9", failure="True")) == "phase split unreliable; Start over; +5.9 s screenshot; **failure**"

if __name__ == "__main__":
    print(table(list(csv.DictReader(open(sys.argv[1])))))
