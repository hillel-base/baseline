"""Compare two eval/q3.py runs row by row (protocol §Assisted runs: Q3 run on one commit is re-checked at the frozen one).
Every field except the model's seconds must match for each (patient, scan, part, start, steer, step).
Usage: python -I eval/q3_compare.py <new q3 dir> <old q3 dir>"""
import csv, glob, os, sys

def compare(new, old):
    same, diff = 0, []
    key = lambda r: (r["scan"], r["part"], r["start"], r["steer"], r["step"])
    for f in sorted(glob.glob(os.path.join(new, "*.csv"))):
        before = {key(r): r for r in csv.DictReader(open(os.path.join(old, os.path.basename(f))))}
        for r in csv.DictReader(open(f)):
            o = before.get(key(r))
            if o and all(r[c] == o.get(c) for c in r if c != "seconds"): same += 1
            else: diff.append((os.path.basename(f), key(r)))
    return same, diff

if __name__ == "__main__":
    same, diff = compare(*sys.argv[1:3])
    for d in diff: print("DIFF", *d)
    print(f"{same} rows identical, {len(diff)} different (model seconds not compared)")
