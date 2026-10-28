"""Does the practice server (T4, CUDA) give the same outlines as the Mac (MPS) for the same clicks?
On each scan of the development patients (never timed or held-out ones), the Mac engine gets: the first click at R1's
deepest voxel plus up to MAX corrections steered toward R1 (eval/replay.py next_click); first clicks 1 pixel off it
(eval/q3.py neighbours); first clicks at R1's centre voxel and 3 and 5 mm off it (eval/replay.py offset_starts).
The server then gets exactly the clicks the Mac got, RUNS times, so a device difference can be told from run-to-run noise.
Per outline: Dice server vs Mac, volume and axis differences (our recomputation, eval/measure.py), whether the tool's
displayed numbers match, the seconds per click. The rule, fixed before the data: the same tool if every outline has
Dice >= 0.99 against the Mac's and a volume within 1%. Both engines run the server's tagged commit; the Mac one with
LUNG_DATA_DIR holding only the development patients; the script checks both report the same commit (/api/info).
Sign-in for the server (our choice, 2026-10-27): with --browser <fresh profile dir>, a headed Playwright browser
opens the hosted page; the operator signs in there as the test user; every server request then runs as fetch() inside that
page, so the Base44 token never leaves the browser (no file, no environment variable, no log). At the end the script
releases the server's hold. Delete the profile afterwards.
Usage: python -I eval/server_check.py <data/rider> <out dir> <server URL> [Mac URL, default http://localhost:8100] [--browser <profile dir>]
With LUNG_GO_FILE set, it waits after the sign-in until that file exists, and uses the server URL written in it."""
import csv, json, os, statistics, sys, time, urllib.request
import numpy as np, SimpleITK as sitk
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from measure import axes_mm, dice, volume_ml
from patch_reach import deepest
from q3 import neighbours
from qiba import qiba_index
from replay import MAX, decode, next_click, offset_starts, post
from score import r1_r2

RUNS, MIN_DICE, MAX_VOL_PCT = 2, 0.99, 1.0
PAGE, TOKEN_KEY = "https://lung-measure.base44.app", "base44_access_token"  # the hosted page; the Base44 SDK's storage key
SEND = {}  # url -> request function; a URL not here goes through eval/replay.py post
# runs inside the signed-in page: the token is read there and never returned
FETCH_JS = """async ({url, path, body}) => {
  const r = await fetch(url + path, {method: "POST", headers: {"Authorization": "Bearer " + localStorage.getItem("%s"),
    "content-type": "application/json"}, body: JSON.stringify(body)});
  let json = {}; try { json = await r.json(); } catch (e) {}
  return {status: r.status, json};
}""" % TOKEN_KEY

def browser(profile, headless=False):  # headless only for the offline test
    """Open the hosted page in a headed browser with a fresh profile, wait (up to 30 min) for the operator's sign-in in any
    tab at the page's address, and return a request function that runs inside that tab."""
    from playwright.sync_api import sync_playwright
    assert not os.path.exists(profile), f"{profile} exists: use a fresh profile"
    ctx = sync_playwright().start().chromium.launch_persistent_context(profile, headless=headless)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(PAGE)
    print("browser open: waiting for the sign-in", flush=True)
    def signed_in(p):  # a yes or no, never the token
        try: return p.url.startswith(PAGE) and p.evaluate(f"() => !!localStorage.getItem('{TOKEN_KEY}')")
        except Exception: return False  # the tab is navigating
    for i in range(360):
        page = next((p for p in ctx.pages if signed_in(p)), None)
        if page: break
        if i % 12 == 0: print("tabs:", [p.url.split("#")[0].split("?")[0] for p in ctx.pages], flush=True)  # addresses only: a token can sit after ? or #
        time.sleep(5)
    else: sys.exit("no sign-in within 30 min")
    print("signed in", flush=True)
    def send(url, path, body):
        r = page.evaluate(FETCH_JS, dict(url=url, path=path, body=body))
        return r["status"], r["json"]
    return send

def run(url, scan_id, clicks, shape, target=None, hu=None, n=0):
    """Send clicks[0] as a start, the rest as corrections; with target, add corrections toward it until n are made.
    Returns (the clicks sent, one dict per outline, the refusal or None)."""
    clicks, outs = list(clicks), []
    post_ = SEND.get(url, post)
    code, o = post_(url, f"/api/scans/{scan_id}/nodules", dict(z=clicks[0][0], y=clicks[0][1], x=clicks[0][2]))
    while code == 200:
        m = decode(o, shape)
        outs.append(dict(mask=m, seconds=o["seconds"], shown=tuple(o.get(k) for k in ("volume_ml", "long_mm", "short_mm"))))
        if target is not None and len(clicks) == len(outs) <= n and (c := next_click(m, target, hu)): clicks.append(c)
        if len(clicks) == len(outs): return clicks, outs, None
        c = clicks[len(outs)]
        code, o = post_(url, "/api/nodule/clicks", dict(z=c[0], y=c[1], x=c[2], positive=c[3], scan=o["scan"], nodule=o["nodule"]))
    if code in (401, 403, 423): sys.exit(f"{url}: refused ({code}): 401/403 the sign-in expired (sign in again), 423 someone else holds the server")
    return clicks, outs, o.get("detail", code)

def same(a, b):
    return 1.0 if not a.any() and not b.any() else dice(a, b)

def compare(mac, srv, sp):
    """One row of differences between the Mac's outline and the server's for the same clicks."""
    vm, vs = volume_ml(mac["mask"], sp), volume_ml(srv["mask"], sp)
    (lm, sm), (ls, ss) = axes_mm(mac["mask"], sp)[:2], axes_mm(srv["mask"], sp)[:2]
    return dict(dice=round(same(mac["mask"], srv["mask"]), 4), voxels_differ=int((mac["mask"] ^ srv["mask"]).sum()),
                vol_mac=round(vm, 3), vol_diff_pct=round(100 * abs(vs - vm) / vm, 3) if vm else (0.0 if not vs else float("inf")),
                long_diff_mm=round(abs(ls - lm), 2), short_diff_mm=round(abs(ss - sm), 2), shown_same=mac["shown"] == srv["shown"])

def verdict(rows):
    ok = [r for r in rows if r.get("dice") != ""]
    same_tool = all(float(r["dice"]) >= MIN_DICE and float(r["vol_diff_pct"]) <= MAX_VOL_PCT for r in ok) and not any(r.get("refusal_differs") for r in rows)
    return same_tool, len(ok)

# self-check: one flipped edge voxel passes the rule, a shifted ball fails it; two empty outlines are the same
_g = np.indices((40, 40, 40)); _b = ((_g - 20) ** 2).sum(0) <= 100; _e = _b.copy(); _e[20, 20, 30] = False
_c = compare(dict(mask=_b, shown=(1,)), dict(mask=_e, shown=(1,)), (1, 1, 1))
assert _c["voxels_differ"] == 1 and _c["dice"] >= MIN_DICE and _c["vol_diff_pct"] <= MAX_VOL_PCT, _c
assert verdict([dict(dice=_c["dice"], vol_diff_pct=_c["vol_diff_pct"])]) == (True, 1)
_s = ((_g - [[[[20]]], [[[20]]], [[[22]]]]) ** 2).sum(0) <= 100
assert not verdict([compare(dict(mask=_b, shown=(1,)), dict(mask=_s, shown=(1,)), (1, 1, 1))])[0]
assert same(np.zeros((2, 2, 2), bool), np.zeros((2, 2, 2), bool)) == 1.0

if __name__ == "__main__":
    args = sys.argv[1:]
    profile = args.pop(args.index("--browser") + 1) if "--browser" in args else None
    args = [a for a in args if a != "--browser"]
    root, out, server = args[:3]
    mac = args[3] if len(args) > 3 else "http://localhost:8100"
    if profile: SEND[server] = browser(profile)  # first, so the Mac engine starts only after the sign-in
    go = os.environ.get("LUNG_GO_FILE")  # optional: after the sign-in, wait for an all-clear file that names the server to use
    if go:
        print("signed in; waiting for the go file", flush=True)
        while not os.path.exists(go): time.sleep(10)
        chosen = open(go).read().strip() or server
        if chosen != server and server in SEND: SEND[chosen] = SEND.pop(server)
        server = chosen
        print("go:", server, flush=True)
    for u in (mac, server):  # either may still be starting (the server takes about 5 min after a restart)
        for _ in range(180):
            try: json.load(urllib.request.urlopen(u + "/api/info"))["commit"]; break
            except (OSError, ValueError, KeyError): time.sleep(5)  # not up yet, or Hugging Face's own page while it starts
    commits = [json.load(urllib.request.urlopen(u + "/api/info"))["commit"] for u in (mac, server)]  # needs no sign-in
    assert commits[0] == commits[1], f"the Mac engine runs {commits[0]}, the server {commits[1]}: both must run the server's tag"
    print("both engines at", commits[0], flush=True)
    cases = list(csv.DictReader(open(os.path.join(here, "cases.csv"))))
    patients = [r["patient"] for r in cases if r["role"] == "dev"]  # development patients only
    assert len(patients) == 3 and not set(patients) & {r["patient"] for r in cases if r["role"] != "dev"}
    os.makedirs(out, exist_ok=True)
    Q, cache, rows, worst = qiba_index(os.path.join(root, "series")), {}, [], None
    for patient in patients:
        for scan, (ct, r1, _) in r1_r2(root, patient, Q, cache).items():
            sp, hu, scan_id = ct.GetSpacing(), sitk.GetArrayFromImage(ct), f"{patient}_{scan}"
            v = np.argwhere(r1); cross = v[np.argmin(((v - v.mean(0)) ** 2).sum(1))]
            d = tuple(int(i) for i in deepest(r1))
            plan = [("deepest, steered by R1", d, MAX)] + [(name, p, 0) for name, p in neighbours(r1, hu, d)]
            plan += [(name, p, 0) for name, p in offset_starts(r1, hu, cross, sp[::-1])]
            for start, p, n in plan:
                clicks, m_outs, m_ref = run(mac, scan_id, [tuple(int(i) for i in p)], r1.shape, r1, hu, n)
                s_runs = [run(server, scan_id, clicks, r1.shape) for _ in range(RUNS)]
                first = len(rows)
                for step in range(max([len(m_outs)] + [len(s[1]) for s in s_runs])):
                    z, y, x = clicks[step][:3]
                    row = dict(patient=patient, scan=scan, start=start, step=step, z=z, y=y, x=x,
                               positive=clicks[step][3] if step else "", seconds_mac=m_outs[step]["seconds"] if step < len(m_outs) else "")
                    for i, (_, s_outs, _) in enumerate(s_runs, 1):
                        row[f"seconds_server{i}"] = s_outs[step]["seconds"] if step < len(s_outs) else ""
                    if step < len(m_outs) and all(step < len(s[1]) for s in s_runs):
                        row.update(compare(m_outs[step], s_runs[0][1][step], sp))
                        row["dice_server_runs"] = round(min(same(s_runs[0][1][step]["mask"], s[1][step]["mask"]) for s in s_runs[1:]), 4) if RUNS > 1 else ""
                        if worst is None or row["dice"] < worst[0]:
                            worst = (row["dice"], scan_id, start, step, m_outs[step]["mask"], s_runs[0][1][step]["mask"])
                    else:
                        row["refusal_differs"] = True  # one engine refused or stopped where another did not
                    rows.append(row)
                refusals = [m_ref] + [s[2] for s in s_runs]
                if len(rows) == first: rows.append(dict(patient=patient, scan=scan, start=start, step=0, z=clicks[0][0], y=clicks[0][1], x=clicks[0][2]))
                if any(refusals): rows[-1]["refused"] = " | ".join(map(str, refusals))
                if len(set(map(str, refusals))) > 1: rows[-1]["refusal_differs"] = True
                print(scan_id, start, "outlines", len(m_outs), flush=True)
    keys = list(dict.fromkeys(k for r in rows for k in r))
    with open(os.path.join(out, "server_check.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys, restval=""); w.writeheader(); w.writerows(rows)
    if worst: np.savez_compressed(os.path.join(out, "worst.npz"), mac=worst[4], server=worst[5], where=np.array([str(w) for w in worst[1:4]]))
    same_tool, n = verdict([{k: r.get(k, "") for k in ("dice", "vol_diff_pct", "refusal_differs")} for r in rows])
    num = [r for r in rows if "dice" in r]
    sec = lambda k: statistics.median(float(r[k]) for r in rows if r.get(k) not in ("", None))
    print(f"{n} outlines on {len({(r['patient'], r['scan']) for r in rows})} scans; Dice server vs Mac: min {min(r['dice'] for r in num)}, "
          f"median {statistics.median(r['dice'] for r in num)}; volume difference: max {max(r['vol_diff_pct'] for r in num)}%, "
          f"median {statistics.median(r['vol_diff_pct'] for r in num)}%; long axis max {max(r['long_diff_mm'] for r in num)} mm; "
          f"identical outlines {sum(r['voxels_differ'] == 0 for r in num)}; displayed numbers equal {sum(r['shown_same'] for r in num)}; "
          f"server run-to-run Dice min {min((r['dice_server_runs'] for r in num if r['dice_server_runs'] != ''), default='')}; "
          f"seconds per click: Mac {sec('seconds_mac')}, server {sec('seconds_server1')}")
    if server in SEND: print("server hold released:", SEND[server](server, "/api/session/release", {})[0])
    print("verdict:", "the same tool (every outline Dice >= 0.99 and volume within 1%)" if same_tool else "NOT the same tool by the rule: report the worst cases")
