"""Time one run (protocol §Timing). The operator presses Enter at each phase boundary; one row is appended to the CSV.
The same three phases are timed in both conditions, in the order each workflow does them.
Usage: python -I eval/stopwatch.py <patient> <test|retest> <manual|assisted> <operator> "<setup>" [tool_sha] [out.csv]
  setup: input device and software version, e.g. "mouse; Slicer 5.8.1" or "trackpad; tool".
Type 'abort' at any prompt to stop: the run is still written, with status=aborted and the reason, so no run disappears.
Self-check: printf '\\n\\n\\n\\n\\nok\\n' | python -I eval/stopwatch.py SELFTEST test manual me "mouse" - /tmp/sw.csv"""
import csv, datetime, os, platform, sys, time

PHASES = {"manual": ["axes", "outline", "record"], "assisted": ["outline", "axes", "record"]}
KEYS = ["started_at", "status", "patient", "role", "scan", "condition", "operator", "setup", "machine", "tool_sha", "order",
        "load_s", "axes_s", "outline_s", "record_s", "total_s", "scan_total_s", "note"]
here = os.path.dirname(os.path.abspath(__file__))
patient, scan, cond, operator, setup = sys.argv[1:6]
sha = sys.argv[6] if len(sys.argv) > 6 else "-"
out = sys.argv[7] if len(sys.argv) > 7 else os.path.join(here, "runs", "timing.csv")
assert scan in ("test", "retest") and cond in PHASES, "scan must be test|retest, condition manual|assisted"
roles = {r["patient"]: r["role"] for r in csv.DictReader(open(os.path.join(here, "cases.csv")))}
roles["SELFTEST"] = "selftest"
assert patient in roles, f"{patient} is not in eval/cases.csv (typo?)"

row = dict(status="done", patient=patient, role=roles[patient], scan=scan, condition=cond, operator=operator, setup=setup,
           machine=f"{platform.machine()} macOS {platform.mac_ver()[0]}", tool_sha=sha, order=">".join(PHASES[cond]))

def save():
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    new = not os.path.exists(out)
    with open(out, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=KEYS)
        if new: w.writeheader()
        w.writerow(row)

def mark(prompt):
    if input(prompt + " [Enter] ").strip().lower() == "abort":
        row.update(status="aborted", note=input("Why aborted? ").strip()); save()
        sys.exit(f"aborted; written to {out} with status=aborted")
    return time.monotonic()

t = mark(f"{patient} ({roles[patient]}) {scan} {cond}: press Enter, then choose the scan in the software")
# the first Enter, so eval/score.py can line the phases up with the tool's log (before 2026-10-25 22:10 it was the script's start)
row["started_at"] = datetime.datetime.now().isoformat(timespec="milliseconds")
t0 = mark("Enter when the scan is open at the hint slice (tumour timing starts now)")
row["load_s"], last = round(t0 - t, 1), t0
for ph in PHASES[cond]:
    now = mark(f"Enter when '{ph}' is done")
    row[f"{ph}_s"], last = round(now - last, 1), now
row["total_s"], row["scan_total_s"] = round(last - t0, 1), round(last - t, 1)
row["note"] = input("Note (corrections, fallback, axis wrong, interruptions): ").strip()
save()
print(f"saved to {out}: tumour {row['total_s']} s, scan incl. loading {row['scan_total_s']} s "
      f"(axes {row['axes_s']}, outline {row['outline_s']}, record {row['record_s']})")
