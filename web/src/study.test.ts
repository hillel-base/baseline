import { expect, test, vi } from "vitest";
import type { Outline, ScanMeta } from "./api";
import { toRow } from "./record";
import { studyRows, toEntities, type MeasurementFields, type ScanFields } from "./study";

const scan: ScanMeta = { id: "Smith_John_retest", scan_ref: "k3J9xQ2mZp", study_code: "a1b2c3d4", days_from_baseline: 12, patient: "Smith_John", series: "retest", shape: [3, 512, 512], spacing: [0.7, 0.7, 1.25],
  instance_numbers: [10, 11, 12], series_number: 4, study_date: "20071123", slice_thickness_mm: 1.25, head_dir: 1 };
const outline = (n: number): Outline => ({ nodule: 1, scan: scan.id, can_undo: false, clicks: Array.from({ length: n }, (_, i) => ({ z: 1, y: 300 + i, x: 330, positive: true })), at_window_edge: false,
  bbox: null, mask: null, volume_ml: 6.9, long_mm: 20.1, short_mm: 15.2, axis_z: 1, long_line: [[1, 2], [3, 4]], short_line: [[5, 6], [7, 8]], seconds: 1, depth_mm: 12.5, width_method: "edge to edge" });
const info = { commit: "abc123", model: "m1" };
const now = "2026-10-25T10:00:00.000Z";
const make = (n: number) => toEntities(toRow(scan, outline(n), 2, 8.4, "runs/secret/path.json", new Date(now)), scan, info);

test("toEntities maps every field", () => {
  const { scan: s, measurement: m } = make(1);
  expect(s).toEqual({ study_code: "a1b2c3d4", timepoint: 1, days_from_baseline: 12, scan_ref: "k3J9xQ2mZp", status: "in progress", series_number: 4, series_label: "1.25 mm", slice_thickness_mm: 1.25, slice_spacing_mm: 1.25 });
  expect(m).toEqual({ nodule_label: "N2", lobe: "unknown", position_voxel: [1, 300, 330], long_axis_mm: 20.1, short_axis_mm: 15.2, volume_ml: 6.9, depth_mm: 12.5, width_method: "edge to edge",
    method: "tool approved", clicks: 1, corrections: 0, edit_seconds: 8.4, engine_version: "abc123", model: "m1", reason: "none", approved: true, approved_at: now, practice: false });
  const rider = { ...scan, study_code: "RIDER-1286684383" }; // the public practice data keeps its own name as its study code
  expect(toEntities(toRow(rider, outline(1), 1, 1, "f"), rider, info).measurement.practice).toBe(true);
});
test("timepoint 0 for test; method is tool edited after a correction; no instance numbers means z = image - 1", () => {
  expect(toEntities(toRow({ ...scan, series: "test" }, outline(1), 1, 1, "f"), { ...scan, series: "test" }, info).scan.timepoint).toBe(0);
  expect(make(3).measurement.method).toBe("tool edited");
  for (const more of [{ painted: 1 }, { axes_edited: true }]) // one click, then a brush stroke or a dragged axis: edited too
    expect(toEntities(toRow(scan, { ...outline(1), ...more }, 1, 1, "f"), scan, info).measurement.method).toBe("tool edited");
  const bare = { ...scan, instance_numbers: null };
  expect(toEntities(toRow(bare, outline(1), 1, 1, "f"), bare, info).measurement.position_voxel[0]).toBe(1);
});
test("payloads hold no study date, outline file, path, UID or date other than approved_at", () => {
  const { scan: s, measurement: m } = make(2);
  for (const [name, o] of [["scan", s], ["measurement", m]] as const) {
    for (const [k, v] of Object.entries(o)) {
      expect(k, name).not.toMatch(/study_date|outline_file|uid$/i);
      if (typeof v === "string" && k !== "approved_at") expect(v, `${name}.${k}`).not.toMatch(/[\\/]|\b\d{8}\b|\d{4}-\d\d-\d\d|\d+\.\d+\.\d+\.\d+/);
    }
  }
  // the whole payload as text, so a field added later cannot slip through
  const text = JSON.stringify([s, { ...m, approved_at: undefined }]);
  expect(text).not.toMatch(/[\\/]|\b\d{8}\b|\d{4}-\d\d-\d\d|\d+\.\d+\.\d+\.\d+|uid|secret|study_date|outline/i);
  expect(text).not.toContain("Smith"); // no folder name of a non-public patient
  expect(text).not.toContain("_retest"); // the scan name never goes to Base44
  expect(text).not.toContain(scan.id);
  expect(JSON.stringify([s, m])).toContain(now); // approved_at is the only date
  expect(JSON.stringify([s, m])).not.toContain("@"); // no email: who saved a row is Base44's own created_by
  expect("approved_by" in m).toBe(false);
  // approved_at comes from the page's own wiring: the recorded row's Record time
  const row = toRow(scan, outline(1), 3, 2, "f", new Date("2026-10-27T09:41:07.123Z"));
  expect(toEntities(row, scan, info).measurement.approved_at).toBe(row.recorded_at);
});

const sc = (id: string, study_code: string, timepoint: number) => ({ id, study_code, timepoint } as ScanFields & { id: string });
const mm = (scan_id: string, nodule_label: string, v: number) => ({ id: `${scan_id}${nodule_label}${v}`, scan_id, nodule_label, long_axis_mm: v, short_axis_mm: v / 2, volume_ml: v / 10, method: "tool approved" } as MeasurementFields & { id: string });
test("studyRows pairs test and retest by label, leaves gaps empty, sorts", () => {
  const rows = studyRows([sc("s1", "B", 0), sc("s2", "B", 1), sc("s3", "A", 0)], [mm("s1", "N1", 10), mm("s2", "N1", 12), mm("s1", "N10", 5), mm("s1", "N2", 6), mm("s3", "N1", 7), mm("zz", "N1", 1)]);
  expect(rows.map((r) => [r.study_code, r.nodule_label])).toEqual([["A", "N1"], ["B", "N1"], ["B", "N2"], ["B", "N10"]]);
  expect(rows[1].cells[0]).toEqual({ long: 10, short: 5, volume: 1, method: "tool approved", id: "s1N110" });
  expect(rows[1].cells[1]?.long).toBe(12);
  expect(rows[2].cells[1]).toBeUndefined();
  expect(studyRows([], [])).toEqual([]);
});

test("a save reuses the Scan with the same scan_ref and creates one when new", async () => {
  const created: [string, Record<string, unknown>][] = [];
  const mk = (name: string, have: { id: string }[]) => ({ filter: async () => have, create: async (o: Record<string, unknown>) => { created.push([name, o]); return { id: "new" }; } });
  const once = async (db: Parameters<typeof outbox>[0]) => { const box = outbox(db, memKv(), me); box.add(make(1)); await box.flush(); };
  await once({ Scan: mk("Scan", [{ id: "old" }]), NoduleMeasurement: mk("M", []) });
  expect(created.map(([n, o]) => [n, o.scan_id])).toEqual([["M", "old"]]);
  created.length = 0;
  await once({ Scan: mk("Scan", []), NoduleMeasurement: mk("M", []) });
  expect(created.map(([n, o]) => [n, o.scan_id])).toEqual([["Scan", undefined], ["M", "new"]]);
});

test("two saves queued together create one Scan; both measurements carry its id; a failed save does not block the next", async () => {
  const scans: Record<string, unknown>[] = [], ms: Record<string, unknown>[] = [];
  const db = {
    Scan: { filter: async (q: Record<string, unknown>) => { await Promise.resolve(); return scans.filter((r) => r.scan_ref === q.scan_ref) as Row[]; },
      create: async (o: Record<string, unknown>) => { await Promise.resolve(); const r = { ...o, id: `s${scans.length}` }; scans.push(r); return r as Row; } },
    NoduleMeasurement: { filter: async () => [], create: async (o: Record<string, unknown>) => { if (o.clicks === 1 && ms.length) throw new Error("down"); ms.push(o); return { id: "m" }; } },
  };
  const kv = memKv(), box = outbox(db, kv, me);
  box.add(make(1)); box.add(make(2));
  await box.flush();
  expect(scans).toHaveLength(1);
  expect(ms.map((m) => m.scan_id)).toEqual(["s0", "s0"]);
  box.add(make(1)); box.add(make(3)); // the first fails, the second is still saved
  await box.flush();
  expect([ms.at(-1)!.clicks, waiting(kv).map((w) => w.e.measurement.clicks)]).toEqual([3, [1]]);
});

test("two measurements of the same label and timepoint both show, each row marked as a duplicate label", () => {
  const rows = studyRows([sc("s1", "A", 0), sc("s2", "A", 1)], [mm("s1", "N1", 10), mm("s1", "N1", 11), mm("s2", "N1", 12), mm("s1", "N2", 5)]);
  expect(rows.map((r) => [r.nodule_label, r.duplicate, r.cells[0]?.long, r.cells[1]?.long])).toEqual([["N1", true, 10, 12], ["N1", true, 11, undefined], ["N2", false, 5, undefined]]);
});

// Rows are only added. A correction names the row it replaces; a removal row names the row it removes, with a reason.
import { NOT_SAVED, OUT_OF_DATE_NOTE, RETRY_MS, SLOW_MS, STUDY_COLUMNS, WAITING, failReason, history, marks, onlyPractice, outbox, replacesLine, signOutLine, studyCSV, type SaveState } from "./study";
import { COLUMNS, toCSV } from "./record";
type Row = Record<string, any> & { id: string };
const me = () => "u-1"; // Base44's user id (auth.me().id): a waiting row is tied to it, never to an email
const mr = (id: string, more: Partial<MeasurementFields> = {}) => ({ id, scan_id: "s1", nodule_label: "N1", long_axis_mm: 1, short_axis_mm: 1, volume_ml: 1, method: "tool approved", approved_at: now, practice: false, ...more } as MeasurementFields & { id: string });
test("marks: a correction replaces its row; a removal row removes the one row it names, whatever its reason; the row that one had replaced then stands again", () => {
  const a = mr("a"), b = mr("b", { replaces_id: "a" }), c = mr("c", { replaces_id: "b" });
  expect([...marks([a, b]).entries()]).toEqual([["a", "replaced"], ["b", "current"]]);
  for (const reason of REMOVED_REASONS) // the reason's text decides nothing (Undo and the Study table differ in the rows they write)
    expect([...marks([a, b, mr("r", { replaces_id: "b", removed_reason: reason })]).entries()]).toEqual([["a", "current"], ["b", reason]]); // the removal row itself has no mark
  expect([...marks([a, b, mr("r1", { replaces_id: "a", removed_reason: "wrong nodule" }), mr("r2", { replaces_id: "b", removed_reason: "wrong nodule" })]).entries()]).toEqual([["a", "wrong nodule"], ["b", "wrong nodule"]]);
  expect([...marks([a, b, c, mr("r", { replaces_id: "c", removed_reason: "duplicate" })]).entries()]).toEqual([["a", "replaced"], ["b", "current"], ["c", "duplicate"]]);
});
test("studyRows shows only standing rows, and hides practice rows unless asked", () => {
  const scans = [sc("s1", "a1b2c3d4", 0), sc("s2", "RIDER-1286684383", 0)];
  const ms = [mr("a", { long_axis_mm: 10 }), mr("b", { replaces_id: "a", long_axis_mm: 11 }), mr("c", { nodule_label: "N2" }), mr("r", { replaces_id: "c", removed_reason: "duplicate" }),
    mr("p", { scan_id: "s2", practice: true }), mr("q", { scan_id: "s2", nodule_label: "N2", practice: undefined })]; // q: a row from before the practice mark, known by its RIDER code
  expect(studyRows(scans, ms).map((r) => [r.study_code, r.nodule_label, r.cells[0]?.long])).toEqual([["a1b2c3d4", "N1", 11]]);
  expect(studyRows(scans, ms, true).map((r) => r.study_code)).toEqual(["a1b2c3d4", "RIDER-1286684383", "RIDER-1286684383"]);
  expect(history(scans, ms).map((h) => [h.id, h.mark])).toEqual([["a", "replaced"], ["b", "current"], ["c", "duplicate"]]);
  expect(history(scans, ms, true).map((h) => h.id)).toEqual(["a", "b", "c", "p", "q"]);
});
test("only practice rows: shown by default; once a study row exists they hide again", () => {
  const scans = [sc("s1", "a1b2c3d4", 0), sc("s2", "RIDER-1286684383", 0)];
  expect(onlyPractice(scans, [mr("p", { scan_id: "s2", practice: true })])).toBe(true);
  expect(onlyPractice(scans, [mr("p", { scan_id: "s2", practice: true }), mr("r", { scan_id: "s2", replaces_id: "p", removed_reason: UNDONE_ })])).toBe(true); // removed, still a practice row
  expect(onlyPractice(scans, [mr("p", { scan_id: "s2", practice: true }), mr("a")])).toBe(false);
  expect(onlyPractice(scans, [])).toBe(false);
});
test("the Study CSV: the 13 columns Base44 holds, with Copy row's names and values, plus study_code, timepoint, days_from_baseline, method and the marks", () => {
  const row = toRow(scan, outline(2), 2, 8.44, "runs/secret/path.json", new Date(now));
  const e = toEntities(row, scan, info);
  const scans = [{ ...e.scan, id: "s1" }], m = { ...e.measurement, scan_id: "s1" };
  const ms = [{ ...m, id: "m1" }, { ...m, id: "m2", replaces_id: "m1" }, { ...m, id: "m3" }, mr("r", { replaces_id: "m3", removed_reason: "wrong scan" })];
  const [head, ...lines] = studyCSV(scans, ms).trim().split("\n").map((l) => l.split(","));
  expect(head).toEqual(STUDY_COLUMNS);
  const copy = toCSV([row]).trim().split("\n")[1].split(","), shared = STUDY_COLUMNS.filter((c) => (COLUMNS as string[]).includes(c));
  expect(shared).toEqual(["series_number", "nodule", "long_mm", "short_mm", "width", "volume_ml", "depth_mm", "clicks", "corrections", "seconds_to_record", "recorded_at", "slice_thickness_mm", "slice_spacing_mm"]);
  for (const l of lines) for (const c of shared) expect(l[STUDY_COLUMNS.indexOf(c)], c).toBe(copy[(COLUMNS as string[]).indexOf(c)]);
  expect(lines.map((l) => [l[0], l[1], l.at(-2), l.at(-1)])).toEqual([["a1b2c3d4", "1", "yes", ""], ["a1b2c3d4", "1", "", ""], ["a1b2c3d4", "1", "", "wrong scan"]]);
  expect(studyCSV(scans, [])).toBe(STUDY_COLUMNS.join(",") + "\n");
  expect(studyCSV(scans, [{ ...ms[0], depth_mm: undefined as never }]).split("\n")[1]).not.toContain("undefined"); // a field Base44 does not hold: an empty cell
});
test("the Study CSV writes recorded_at as Copy row does, whatever text Base44 gives the time back in", () => {
  const row = toRow(scan, outline(1), 1, 8.44, "f", new Date(now)), e = toEntities(row, scan, info);
  const copy = toCSV([row]).trim().split("\n")[1].split(",")[(COLUMNS as string[]).indexOf("recorded_at")];
  for (const approved_at of [now, now.replace(".000Z", ""), now.replace(".000Z", "+00:00")]) { // no zone = UTC
    const line = studyCSV([{ ...e.scan, id: "s1" }], [{ ...e.measurement, scan_id: "s1", id: "m1", approved_at }]).trim().split("\n")[1].split(",");
    expect(line[STUDY_COLUMNS.indexOf("recorded_at")], approved_at).toBe(copy);
  }
  expect(copy).toBe("2026-10-25T10:00:00.000Z");
});
test("the replaces line names the nodule and its local time, and the day when it was not today", () => {
  const t = new Date(2026, 9, 27, 14, 2);
  expect(replacesLine({ nodule_label: "N1", approved_at: t.toISOString() }, new Date(2026, 9, 27, 18, 0))).toBe("This replaces nodule 1 recorded at 14:02.");
  expect(replacesLine({ nodule_label: "N3", approved_at: t.toISOString() }, new Date(2026, 9, 29, 9, 0))).toBe("This replaces nodule 3 recorded at 14:02 on 2026-10-27.");
});
test("the failed-save line is plain words; the log gets only an HTTP status or an error class", () => {
  expect(NOT_SAVED).toBe("Recorded on this computer. Not saved to the study table yet; trying again every 15 s.");
  expect(RETRY_MS).toBe(15_000);
  expect([failReason(Object.assign(new Error("Request failed: {\"long_axis_mm\":3} user-a"), { status: 503 })), failReason(new TypeError("Failed to fetch")), failReason("x")]).toEqual(["503", "TypeError", "unknown"]);
});
test("the sign-out line, when rows still wait", () => {
  expect(signOutLine(1)).toBe("1 row is still waiting to be saved. It is saved when you sign in again on this computer.");
  expect(signOutLine(3)).toBe("3 rows are still waiting to be saved. They are saved when you sign in again on this computer.");
});

// The waiting rows and Undo, against an in-memory Base44 and an in-memory browser store.
const fakeDb = (fields = true) => {
  const t = { Scan: [] as Row[], NoduleMeasurement: [] as Row[] };
  const ctl = { fail: false, lose: false, gate: undefined as Promise<void> | undefined, t, n: 0, creates: [] as string[] }; // creates: every create sent, answered or not
  const store = (name: "Scan" | "NoduleMeasurement") => ({
    filter: async (q: Record<string, unknown>) => { if (ctl.fail) throw new Error("offline"); return t[name].filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)); },
    create: async (o: Record<string, unknown>) => {
      ctl.creates.push(name);
      await ctl.gate;
      if (ctl.fail) throw new Error("offline");
      const kept = fields ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !["practice", "replaces_id", "removed_reason"].includes(k))); // table files not pushed: Base44 drops new fields
      const r = { ...kept, id: `${name[0]}${++ctl.n}` }; t[name].push(r);
      if (ctl.lose) throw new Error("reply lost"); // Base44 kept the row, but the page never heard back
      return r;
    },
  });
  return { ctl, db: { Scan: store("Scan"), NoduleMeasurement: store("NoduleMeasurement") } };
};
const memKv = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), keys: () => [...m.keys()] }; };
const waiting = (kv: ReturnType<typeof memKv>) => [...kv.m].filter(([k]) => k.startsWith(WAITING)).map(([, v]) => JSON.parse(v));
const at = (min: number) => new Date(Date.UTC(2026, 9, 27, 12, min)).toISOString();
const rec = (min: number, n = 1) => toEntities(toRow(scan, outline(1), n, 3, "runs/secret/path.json", new Date(at(min))), scan, info);
const live = (ctl: ReturnType<typeof fakeDb>["ctl"]) => history([{ ...rec(0).scan, id: "S1" }], ctl.t.NoduleMeasurement as never).filter((h) => h.mark === "current").map((h) => h.id);
/** Holds every create until open() (a Base44 that is slow to answer). */
const hold = (ctl: ReturnType<typeof fakeDb>["ctl"]) => { let open!: () => void; ctl.gate = new Promise((r) => { open = r; }); return () => { ctl.gate = undefined; open(); }; };
declare const setImmediate: (f: () => void) => void; // Node's (the tests run in Node; the page's types have no Node)
const tick = () => new Promise<void>((r) => setImmediate(r)); // every pending step runs (setImmediate is not faked)
const solo = <T,>(fn: () => Promise<T>) => fn(); // no Web Lock: these tests step through one tab
const states = (said: SaveState[]) => said.map((s) => s.state);

test("a Record is saved and nothing stays in the browser; the panel hears saving, then saved", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), said: SaveState[] = [];
  const box = outbox(db, kv, me);
  box.add(rec(0), (s) => said.push(s));
  await box.flush();
  expect(states(said)).toEqual(["saving", "saved"]);
  expect([ctl.t.Scan.length, ctl.t.NoduleMeasurement.length, kv.m.size]).toEqual([1, 1, 0]);
});
test("a failed save waits in the browser with only what Base44 would get and who made it, survives a reload, and is removed once saved", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), said: SaveState[] = [], failures: string[] = [];
  ctl.fail = true;
  const first = outbox(db, kv, me, { onFail: (r) => failures.push(r) });
  first.add(rec(0), (s) => said.push(s));
  await first.flush();
  await first.flush();
  expect([said.at(-1), failures]).toEqual([{ state: "waiting", note: undefined }, ["Error"]]); // logged once, by class
  const [w] = waiting(kv), stored = kv.m.get(`${WAITING}${w.key}`)!;
  expect([...kv.m.keys()]).toEqual([`lung.waiting.${w.key}`]); // one key per waiting row
  expect([w.e, w.user]).toEqual([rec(0), "u-1"]); // the Base44 payload; Base44's user id only to know whose row it is
  expect(stored).not.toContain("@"); // no email anywhere in the browser
  expect(stored).not.toMatch(/study_date|outline|secret|runs\/|Smith|_retest|20071123/);
  ctl.fail = false;
  const counts: number[] = [];
  await outbox(db, kv, me, { onCount: (n) => counts.push(n) }).flush(); // a new page load
  expect([ctl.t.NoduleMeasurement.length, kv.m.size, counts.at(-1)]).toEqual([1, 0, 0]);
});
test("a waiting row is sent only while the person who made it is signed in (by Base44 user id); a row of no known id is never sent", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), userA = () => "u-a";
  ctl.fail = true;
  outbox(db, kv, userA).add(rec(0));
  await outbox(db, kv, userA).flush();
  ctl.fail = false;
  const counts: number[] = [];
  await outbox(db, kv, () => "u-b", { onCount: (n) => counts.push(n) }).flush();
  expect([ctl.t.NoduleMeasurement.length, kv.m.size, counts]).toEqual([0, 1, [0]]); // waits for user A; user B's screen counts none of it
  expect(waiting(kv)[0].user).toBe("u-a");
  await outbox(db, kv, userA).flush();
  expect([ctl.t.NoduleMeasurement.length, kv.m.size]).toEqual([1, 0]);
  kv.m.set("lung.waiting.v1", JSON.stringify([{ key: "k", user: "user-a", e: rec(5) }])); // an older single list, tied to an email (never deployed)
  await outbox(db, kv, userA).flush();
  expect(ctl.t.NoduleMeasurement.length).toBe(1); // belongs to nobody: kept, never sent
});
test("Undo while the save is waiting cancels it: nothing is written, not even a removal; the count drops at once", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), counts: number[] = [], box = outbox(db, kv, me, { onCount: (n) => counts.push(n) });
  ctl.fail = true;
  const key = box.add(rec(0));
  await box.flush();
  await box.undo(key, rec(0));
  expect(counts.slice(-2)).toEqual([1, 0]);
  ctl.fail = false;
  await box.flush();
  expect([ctl.t.NoduleMeasurement.length, kv.m.size]).toEqual([0, 0]);
});
test("Undo after the save adds a removal row, recorded by mistake, and the row leaves the Study table", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me);
  const key = box.add(rec(0));
  await box.flush();
  await box.undo(key, rec(0), at(1));
  const [m, r] = ctl.t.NoduleMeasurement;
  expect(r).toEqual({ id: r.id, scan_id: m.scan_id, nodule_label: "N1", replaces_id: m.id, removed_reason: "recorded by mistake", practice: false, approved_at: at(1) });
  expect(live(ctl)).toEqual([]);
  expect(kv.m.size).toBe(0);
});
test("Undo matches the Record by its time, whatever text Base44 gives the time back in", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  const key = box.add(rec(0));
  await box.flush();
  ctl.t.NoduleMeasurement[0].approved_at = at(0).replace(".000Z", "+00:00"); // the same time, other text
  await box.undo(key, rec(0), at(1));
  expect(ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? "row")).toEqual(["row", "recorded by mistake"]);
  await box.flush();
  box.add(rec(0)); // the same Record again (a lost reply's retry): found by time, not saved twice
  await box.flush();
  expect(ctl.t.NoduleMeasurement.length).toBe(2);
});
test("Undo while the save is on its way waits for it: a removal if it was saved, nothing if it failed", async () => {
  for (const fails of [false, true]) {
    const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
    let open!: () => void;
    ctl.gate = new Promise((r) => { open = r; });
    const key = box.add(rec(0));
    await new Promise((r) => setTimeout(r, 0));
    const undone = box.undo(key, rec(0), at(1));
    ctl.fail = fails; open();
    await undone;
    ctl.fail = false;
    await box.flush();
    expect(ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? "row")).toEqual(fails ? [] : ["row", "recorded by mistake"]);
  }
});
test("I-1: while a save hangs, a new Record is stored at once, so a reload keeps it; the reloaded page sends both", async () => {
  const { ctl, db } = fakeDb(), kv = memKv();
  const open = hold(ctl);
  const box = outbox(db, kv, me, { lock: solo }); // a reload frees the old page's lock
  box.add(rec(0));
  box.add(recAt(1, 2, [90, 90, 90]));
  await tick();
  expect([waiting(kv).map((w) => w.e.measurement.nodule_label), ctl.creates]).toEqual([["N1", "N2"], ["Scan"]]); // before any save answers
  ctl.gate = undefined; // the old page's request never lands (it was lost in the reload)
  await outbox(db, kv, me, { lock: solo }).flush(); // the reloaded page
  expect([ctl.t.NoduleMeasurement.map((r) => r.nodule_label), kv.m.size]).toEqual([["N1", "N2"], 0]);
  open();
});
test("a Record behind a slow save that is undone meanwhile is skipped: neither it nor a removal is written", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me, { lock: solo });
  const open = hold(ctl);
  box.add(rec(0));
  const key = box.add(recAt(1, 2, [90, 90, 90])); // the run in progress read both rows before it sent the first
  await tick();
  expect(ctl.creates).toEqual(["Scan"]); // the first save is open
  const undone = box.undo(key, recAt(1, 2, [90, 90, 90]), at(2));
  open();
  await undone;
  await box.flush();
  expect(ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? r.nodule_label)).toEqual(["N1"]);
  expect(kv.m.size).toBe(0);
});
test("a create still open at 20 s shows waiting, is never sent again while open (retries, flushes), and turns to saved when it answers", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    const { ctl, db } = fakeDb(), kv = memKv(), said: SaveState[] = [], counts: number[] = [];
    const box = outbox(db, kv, me, { onCount: (n) => counts.push(n), lock: solo });
    box.add(rec(0), (s) => said.push(s));
    await tick();
    const open = hold(ctl);
    box.add(recAt(1, 2, [90, 90, 90]), (s) => said.push(s));
    await tick();
    expect(ctl.creates).toEqual(["Scan", "NoduleMeasurement", "NoduleMeasurement"]);
    await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
    expect(said.at(-1)?.state).toBe("saving");
    await vi.advanceTimersByTimeAsync(1);
    expect([said.at(-1), counts.at(-1)]).toEqual([{ state: "waiting" }, 1]); // the panel's amber box; the page counts it
    for (let i = 0; i < 4; i++) { void box.flush(); await vi.advanceTimersByTimeAsync(RETRY_MS); } // the page's retries
    const removing = box.remove(scan.scan_ref, ctl.t.NoduleMeasurement[0] as never, "duplicate");
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(await removing).toEqual({ saved: false, outOfDate: false }); // Remove says "not saved yet" instead of waiting with no word
    expect(ctl.creates).toEqual(["Scan", "NoduleMeasurement", "NoduleMeasurement"]); // nothing sent again while it is open
    open();
    await box.flush();
    expect([ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? r.nodule_label), said.at(-1)?.state, kv.m.size]).toEqual([["N1", "N2", "duplicate"], "saved", 0]);
  } finally { vi.useRealTimers(); }
});
test("Undo while a create is open past 20 s: a removal row as soon as the create is saved; nothing if it fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    for (const fails of [false, true]) {
      const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me, { lock: solo });
      ctl.t.Scan.push({ ...rec(0).scan, id: "S1" }); // the scan is on Base44: the open create is the Record's
      const open = hold(ctl);
      const key = box.add(rec(0));
      await vi.advanceTimersByTimeAsync(SLOW_MS + 1);
      const undone = box.undo(key, rec(0), at(1));
      expect(waiting(kv).map((w) => [w.e.measurement.removed_reason, w.target])).toEqual([["recorded by mistake", at(0)]]); // the Undo is kept, the Record no longer
      ctl.fail = fails; open();
      await undone;
      ctl.fail = false;
      await box.flush();
      expect([ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? "row"), live(ctl), kv.m.size]).toEqual([fails ? [] : ["row", "recorded by mistake"], [], 0]);
      expect(ctl.creates.filter((c) => c === "NoduleMeasurement")).toHaveLength(fails ? 1 : 2); // never sent again
    }
  } finally { vi.useRealTimers(); }
});
test("two Records on a new scan while its Scan create is slow make one Scan row", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me, { lock: solo });
    const open = hold(ctl);
    box.add(rec(0));
    box.add(recAt(1, 2, [90, 90, 90]));
    await vi.advanceTimersByTimeAsync(SLOW_MS * 3);
    void box.flush();
    await tick();
    open();
    await box.flush();
    expect([ctl.creates.filter((c) => c === "Scan").length, ctl.t.Scan.length, new Set(ctl.t.NoduleMeasurement.map((r) => r.scan_id)).size]).toEqual([1, 1, 1]);
  } finally { vi.useRealTimers(); }
});
test("a retry after a lost reply does not save the row twice", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me);
  ctl.lose = true;
  box.add(rec(0));
  await box.flush();
  ctl.lose = false;
  await box.flush();
  expect([ctl.t.NoduleMeasurement.length, kv.m.size]).toEqual([1, 0]);
});
test("a Record near a standing row replaces it, says so, and its Undo brings the older row back", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me), said: SaveState[] = [];
  box.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  const key = box.add(recAt(5, 2, [50, 50, 52]), (s) => said.push(s), SP);
  box.add(recAt(6, 3, [50, 50, 90]), undefined, SP); // another place: a row of its own
  await box.flush();
  const [a, b, c] = ctl.t.NoduleMeasurement;
  expect([b.replaces_id, c.replaces_id, b.nodule_label, c.nodule_label]).toEqual([a.id, undefined, "N1", "N3"]);
  expect(said.at(-1)).toEqual({ state: "saved", replaces: replacesLine(a as never), nodule: 1 });
  expect(live(ctl)).toEqual([b.id, c.id]);
  await box.undo(key, recAt(5, 2, [50, 50, 52]), at(7));
  expect(live(ctl)).toEqual([a.id, c.id]);
  expect(ctl.t.NoduleMeasurement.at(-1)).toMatchObject({ nodule_label: "N1", replaces_id: b.id, removed_reason: "recorded by mistake" }); // found by its time, under its new label
  box.add(recAt(8, 4, [50, 50, 50]), undefined, SP); // after an Undo, the same place replaces the row that stands again
  await box.flush();
  expect(ctl.t.NoduleMeasurement.at(-1)).toMatchObject({ replaces_id: a.id, nodule_label: "N1" });
});
test("a removal from the Study table writes a removal row with the chosen reason, and says whether it was saved", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  box.add(rec(0));
  await box.flush();
  const m = ctl.t.NoduleMeasurement[0];
  expect(await box.remove(scan.scan_ref, m as never, "wrong nodule", at(9))).toEqual({ saved: true, outOfDate: false });
  expect(ctl.t.NoduleMeasurement[1]).toEqual({ id: ctl.t.NoduleMeasurement[1].id, replaces_id: m.id, removed_reason: "wrong nodule", approved_at: at(9), nodule_label: "N1", scan_id: m.scan_id, practice: false });
  expect(live(ctl)).toEqual([]);
  ctl.fail = true;
  box.add(rec(10, 2));
  expect(await box.remove(scan.scan_ref, m as never, "duplicate")).toEqual({ saved: false, outOfDate: false });
});
test("a removal from the Study table, whatever the reason (recorded by mistake too), removes the label at that timepoint, the rows it had replaced included; only Undo brings an older row back", async () => {
  for (const reason of REMOVED_REASONS) {
    const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
    box.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
    box.add(recAt(1, 2, [50, 50, 52]), undefined, SP); // re-measures N1: replaces it
    await box.flush();
    const [a, b] = ctl.t.NoduleMeasurement;
    expect(await box.remove(scan.scan_ref, b as never, reason, at(2))).toEqual({ saved: true, outOfDate: false });
    expect([live(ctl), ctl.t.NoduleMeasurement.slice(2).map((r) => [r.replaces_id, r.removed_reason, r.nodule_label])]).toEqual([[], [[a.id, reason, "N1"], [b.id, reason, "N1"]]]); // oldest first
  }
  // the Undo path, for contrast: "a Record near a standing row replaces it, says so, and its Undo brings the older row back"
});
test("a Study-table removal half saved is finished by the retry, with no removal row written twice", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  box.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  box.add(recAt(1, 2, [50, 50, 52]), undefined, SP);
  await box.flush();
  const [a, b] = ctl.t.NoduleMeasurement;
  ctl.lose = true; // the first removal row is kept, but its reply is lost
  expect(await box.remove(scan.scan_ref, b as never, "wrong scan", at(2))).toEqual({ saved: false, outOfDate: false });
  expect(live(ctl)).toEqual([b.id]); // half saved: the label still shows its newest row, nothing older comes back
  ctl.lose = false;
  await box.flush();
  expect([live(ctl), ctl.t.NoduleMeasurement.slice(2).map((r) => r.replaces_id)]).toEqual([[], [a.id, b.id]]);
});
test("table files not pushed (Base44 drops the new fields): no removal is written, and the page says why; a Record near such a row gets its own label", async () => {
  const { ctl, db } = fakeDb(false), notes: (string | undefined)[] = [], said: SaveState[] = [];
  const box = outbox(db, memKv(), me, { onCount: (_n, note) => notes.push(note) });
  const key = box.add(rec(0));
  await box.flush(); // a plain Record is still kept (without its practice mark)
  expect(await box.remove(scan.scan_ref, ctl.t.NoduleMeasurement[0] as never, "wrong nodule")).toEqual({ saved: false, outOfDate: true });
  await box.undo(key, rec(0));
  box.add(rec(3), (s) => said.push(s), scan.spacing); // the same place: it would replace that row, which cannot take a mark
  await box.flush();
  expect(ctl.t.NoduleMeasurement.map((r) => [r.nodule_label, r.removed_reason ?? ""])).toEqual([["N1", ""], ["N2", ""]]); // no removal; the Record is not blocked
  expect([notes.at(-1), said.at(-1)]).toEqual([OUT_OF_DATE_NOTE, { state: "saved", replaces: undefined, nodule: 2 }]);
});
test("a row saved before the table push (no practice key) never blocks a Record near it", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me), said: SaveState[] = [];
  ctl.t.Scan.push({ ...rec(0).scan, id: "S1" });
  ctl.t.NoduleMeasurement.push({ id: "old", scan_id: "S1", nodule_label: "N1", position_voxel: [50, 50, 50], long_axis_mm: 20, approved_at: at(0) });
  box.add(recAt(1, 1, [50, 50, 51]), (s) => said.push(s), SP);
  await box.flush();
  expect([labels(ctl).at(-1), said.at(-1)]).toEqual([["N2", "", ""], { state: "saved", replaces: undefined, nodule: 2 }]);
});
test("a row another tab saved turns this tab's panel to saved, with the label and replaces line Base44 got", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), said: SaveState[] = [];
  const first = outbox(db, kv, me);
  first.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  await first.flush();
  ctl.fail = true;
  const tabA = outbox(db, kv, me);
  tabA.add(recAt(5, 1, [50, 50, 51]), (s) => said.push(s), SP); // the same place: it replaces N1
  await tabA.flush();
  ctl.fail = false;
  await outbox(db, kv, me).flush(); // tab B
  await tabA.sync(); // the storage event in tab A
  expect([...new Set(states(said))]).toEqual(["saving", "waiting", "saved"]);
  expect(said.at(-1)).toEqual({ state: "saved", nodule: 1, replaces: replacesLine(ctl.t.NoduleMeasurement[0] as never) });
});
test("two tabs writing at once never lose a row: each waiting row has its own key", async () => {
  const { ctl, db } = fakeDb(), shared = memKv();
  const seen = new Map(shared.m); // tab A's own copy of the store: Chrome keeps one per tab, so a write by tab B can reach it late
  const kvA = { getItem: (k: string) => seen.get(k) ?? null, keys: () => [...seen.keys()],
    setItem: (k: string, v: string) => { seen.set(k, v); shared.m.set(k, v); }, removeItem: (k: string) => { seen.delete(k); shared.m.delete(k); } };
  ctl.fail = true;
  const tabA = outbox(db, kvA, me);
  tabA.add(rec(0));
  await tabA.flush();
  const tabB = outbox(db, shared, me);
  tabB.add(recAt(1, 2, [90, 90, 90])); // B stores a Record; A has not seen it yet
  await tabB.flush();
  ctl.fail = false;
  await tabA.flush(); // A saves its row and takes it out
  expect(waiting(shared).map((w) => w.e.measurement.nodule_label)).toEqual(["N2"]); // B's row is still there
  await tabB.flush();
  expect([ctl.t.NoduleMeasurement.map((r) => r.nodule_label), shared.m.size]).toEqual([["N1", "N2"], 0]);
});
test("a waiting removal holds only the scan code, the label, the reason, the practice mark and two times, plus whose it is", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me);
  ctl.fail = true;
  await box.undo("saved earlier", rec(0), at(1));
  const [w, more] = waiting(kv);
  expect([Object.keys(w).sort(), more]).toEqual([["at", "e", "key", "target", "user"], undefined]); // at: when it was stored, to keep the order
  expect(w.e).toEqual({ scan: { scan_ref: scan.scan_ref }, measurement: { nodule_label: "N1", practice: false, removed_reason: "recorded by mistake", approved_at: at(1) } });
  expect(w.target).toBe(at(0)); // the approved_at of the row it removes, found on Base44 at save time
});
test("a Study-table removal of a real Base44 row (created_by holds an email) keeps no email in the browser or in the rows it writes", async () => {
  const { ctl, db } = fakeDb(), kv = memKv();
  ctl.t.Scan.push({ ...rec(0).scan, id: "S1" });
  const row = { ...rec(0).measurement, id: "M1", scan_id: "S1", created_by: "user-a", created_by_id: "u-a", created_date: "2026-10-27T12:00:01", updated_date: "2026-10-27T12:00:01" };
  ctl.t.NoduleMeasurement.push(row); // as the Study table passes it to Remove: the whole row Base44 gave back
  ctl.fail = true;
  expect(await outbox(db, kv, me).remove(scan.scan_ref, row as never, "wrong scan", at(1))).toEqual({ saved: false, outOfDate: false });
  const [w] = waiting(kv);
  expect([[...kv.m.values()].join().includes("@"), w.e]).toEqual([false, { scan: { scan_ref: scan.scan_ref }, measurement: { nodule_label: "N1", practice: false, removed_reason: "wrong scan", approved_at: at(1), replaces_id: "M1" } }]);
  ctl.fail = false;
  await outbox(db, kv, me).flush();
  expect([ctl.t.NoduleMeasurement.length, JSON.stringify(ctl.t.NoduleMeasurement.slice(1)).includes("@"), kv.m.size]).toEqual([2, false, 0]);
});
test("two tabs sharing the browser store and the lock save a waiting row once", async () => {
  const { ctl, db } = fakeDb(), kv = memKv();
  let q: Promise<unknown> = Promise.resolve();
  const lock = <T,>(fn: () => Promise<T>) => { const r = q.then(fn); q = r.catch(() => {}); return r as Promise<T>; };
  ctl.fail = true;
  const tab = outbox(db, kv, me, { lock });
  tab.add(rec(0));
  await tab.flush();
  ctl.fail = false;
  await Promise.all([outbox(db, kv, me, { lock }).flush(), outbox(db, kv, me, { lock }).flush()]);
  expect(ctl.t.NoduleMeasurement.length).toBe(1);
});
import scanJson from "../base44/entities/scan.jsonc?raw";
import measJson from "../base44/entities/nodule-measurement.jsonc?raw";
test("the table files let users create and read, only an admin update or delete; every field we send is declared", () => {
  const [scanT, measT] = [JSON.parse(scanJson), JSON.parse(measJson)];
  for (const t of [scanT, measT]) {
    expect(t.rls.update).toEqual({ user_condition: { role: "admin" } });
    expect(t.rls.delete).toEqual({ user_condition: { role: "admin" } });
    for (const op of ["create", "read"]) expect(t.rls[op].$or.map((c: { user_condition: { role: string } }) => c.user_condition.role).sort()).toEqual(["admin", "user"]);
  }
  const e = rec(0), sent = new Set([...Object.keys(e.measurement), "scan_id", "replaces_id", "removed_reason"]);
  expect([...sent].filter((k) => !(k in measT.properties))).toEqual([]);
  expect(Object.keys(e.scan).filter((k) => !(k in scanT.properties))).toEqual([]);
  expect(measT.properties.removed_reason.enum).toEqual([...REMOVED_REASONS]);
});
import { REMOVED_REASONS, UNDONE as UNDONE_ } from "./study";
type Waiting_ = { e: { measurement: { nodule_label: string } } };
// A Record re-measures the standing row its first click is near; otherwise it gets a new label after Base44's rows.
const SP: [number, number, number] = [1, 1, 1]; // mm per voxel (x, y, z): voxel distances are millimetres
function recAt(min: number, n: number, pos: [number, number, number], long = 20) { const e = rec(min, n); e.measurement.position_voxel = pos; e.measurement.long_axis_mm = long; return e; }
const labels = (ctl: ReturnType<typeof fakeDb>["ctl"]) => ctl.t.NoduleMeasurement.map((r) => [r.nodule_label, r.replaces_id ?? "", r.removed_reason ?? ""]);
test("the same place after a reload replaces that row and keeps its label", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), said: SaveState[] = [];
  const first = outbox(db, kv, me);
  first.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  await first.flush();
  const reloaded = outbox(db, kv, me); // the page's own numbers restarted: this Record came in as N2
  reloaded.add(recAt(5, 2, [51, 50, 50]), (s) => said.push(s), SP);
  await reloaded.flush();
  const [a] = ctl.t.NoduleMeasurement;
  expect(labels(ctl)).toEqual([["N1", "", ""], ["N1", a.id, ""]]);
  expect(said.at(-1)).toEqual({ state: "saved", replaces: replacesLine(a as never), nodule: 1 });
});
test("a different place gets a new label, after every label on that scan (replaced and removed too) and this sitting's own number", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me), said: SaveState[] = [];
  box.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  box.add(recAt(1, 2, [50, 50, 100]), undefined, SP);
  const k3 = box.add(recAt(2, 3, [50, 100, 100]), undefined, SP);
  await box.flush();
  await box.undo(k3, recAt(2, 3, [50, 100, 100]), at(3)); // N3 removed: its number stays taken
  box.add(recAt(4, 1, [10, 10, 10]), (s) => said.push(s), SP); // far from all, and came in as N1
  await box.flush();
  expect(labels(ctl).at(-1)).toEqual(["N4", "", ""]);
  expect(said.at(-1)).toEqual({ state: "saved", replaces: undefined, nodule: 4 });
  box.add(recAt(5, 9, [90, 10, 10]), undefined, SP); // this sitting's number is higher: it stays
  await box.flush();
  expect(labels(ctl).at(-1)).toEqual(["N9", "", ""]);
});
test("near is within max(10 mm, 0.75 × the old row's long axis)", async () => {
  const replaces = async (long: number, mm: number) => {
    const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
    box.add(recAt(0, 1, [50, 50, 50], long), undefined, SP);
    box.add(recAt(1, 2, [50 + mm, 50, 50], 5), undefined, SP);
    await box.flush();
    return ctl.t.NoduleMeasurement[1].replaces_id !== undefined;
  };
  expect([await replaces(30, 20), await replaces(30, 25)]).toEqual([true, false]); // 0.75 × 30 = 22.5 mm
  expect([await replaces(6, 9), await replaces(6, 11)]).toEqual([true, false]); // the 10 mm floor
  expect(NEAR_MM).toBe(10); expect(NEAR_LONG_AXIS).toBe(0.75);
});
test("the distance is in mm on the scan's voxel spacing (x, y, z), position_voxel being z, y, x: pairs that flip without the spacing or with x and z swapped", async () => {
  const sp: [number, number, number] = [0.7, 0.7, 2.5], { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  box.add(recAt(0, 1, [50, 50, 50], 6), undefined, sp); // near = within 10 mm
  box.add(recAt(1, 2, [55, 50, 50], 6), undefined, sp); // 5 slices × 2.5 mm = 12.5 mm: its own row (5 mm without the spacing, 3.5 mm with x and z swapped)
  box.add(recAt(2, 3, [50, 50, 63], 6), undefined, sp); // 13 columns × 0.7 mm = 9.1 mm from N1: replaces it (13 mm without the spacing, 32.5 mm swapped)
  await box.flush();
  const [n1] = ctl.t.NoduleMeasurement;
  expect(labels(ctl)).toEqual([["N1", "", ""], ["N2", "", ""], ["N1", n1.id, ""]]);
});
test("a near row on another Scan row never matches", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me), other = recAt(1, 1, [50, 50, 50]);
  box.add(recAt(0, 1, [90, 90, 90]), undefined, SP); // this scan's Scan row, with a row far away
  box.add({ ...other, scan: { ...other.scan, scan_ref: "anotherScan" } }, undefined, SP);
  await box.flush(); // both Scan rows are on Base44, and the other one has an N1 at [50, 50, 50]
  box.add(recAt(2, 2, [50, 50, 50]), undefined, SP); // the same place, on this scan
  await box.flush();
  const [mine, theirs] = ctl.t.Scan;
  expect(ctl.t.NoduleMeasurement.map((r) => [r.scan_id, r.nodule_label, r.replaces_id ?? ""])).toEqual([[mine.id, "N1", ""], [theirs.id, "N1", ""], [mine.id, "N2", ""]]);
});
test("of two near rows, the nearest is replaced", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  box.add(recAt(0, 1, [50, 50, 50], 10), undefined, SP); // near = within 10 mm
  box.add(recAt(1, 2, [50, 50, 62], 10), undefined, SP); // 12 mm from N1: its own row
  box.add(recAt(2, 3, [50, 50, 58]), undefined, SP); // 8 mm from N1, 4 mm from N2
  await box.flush();
  const [, n2] = ctl.t.NoduleMeasurement;
  expect(labels(ctl)).toEqual([["N1", "", ""], ["N2", "", ""], ["N2", n2.id, ""]]);
});
test("the highest label of a scan, for the next number shown before Record: Base44's rows and the rows still waiting", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), box = outbox(db, kv, me);
  expect(await box.highest(scan.scan_ref)).toBe(0);
  box.add(recAt(0, 1, [50, 50, 50]), undefined, SP);
  box.add(recAt(1, 2, [50, 50, 90]), undefined, SP);
  await box.flush();
  ctl.fail = true;
  box.add(recAt(2, 5, [90, 90, 90]), undefined, SP);
  expect(await outbox(db, kv, me).highest(scan.scan_ref).catch(() => "offline")).toBe("offline"); // the caller then keeps its own numbers
  ctl.fail = false;
  expect(await outbox(db, kv, me).highest(scan.scan_ref)).toBe(5);
  expect(await box.highest("anotherScan")).toBe(0);
});
test("Undo after a Study-table Remove of the same Record writes no second removal row, and says so", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  const key = box.add(rec(0));
  await box.flush();
  const m = ctl.t.NoduleMeasurement[0];
  await box.remove(scan.scan_ref, m as never, "wrong nodule", at(1)); // on the Study table tab
  expect(await box.undo(key, rec(0), at(2))).toBe(ALREADY_REMOVED); // back on Measure, Undo is still shown: a tab change is not a next action
  expect(ctl.t.NoduleMeasurement.filter((r) => r.removed_reason).map((r) => [r.replaces_id, r.removed_reason])).toEqual([[m.id, "wrong nodule"]]); // the reason chosen stays
  expect(ALREADY_REMOVED).toBe("Record undone. It was already removed in the Study table, so nothing more was written.");
  const k2 = box.add(rec(3, 2));
  await box.flush();
  expect(await box.undo(k2, rec(3, 2), at(4))).toBeUndefined(); // a plain Undo: nothing more to say
});
import { ALREADY_REMOVED } from "./study";
test("a Record queued behind a slow save turns to waiting at 20 s too, as the page's count does; a Record saved or undone first never does", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { ctl, db } = fakeDb(), counts: number[] = [], box = outbox(db, memKv(), me, { onCount: (n) => counts.push(n), lock: solo });
    ctl.t.Scan.push({ ...rec(0).scan, id: "S1" });
    const quick: SaveState[] = [], undone: SaveState[] = [], first: SaveState[] = [], second: SaveState[] = [];
    box.add(recAt(0, 1, [10, 10, 10]), (s) => quick.push(s));
    await box.flush();
    const open = hold(ctl);
    box.add(recAt(1, 2, [50, 50, 50]), (s) => first.push(s));
    box.add(recAt(2, 3, [90, 90, 90]), (s) => second.push(s)); // queued behind the first, whose create is open
    const k = box.add(recAt(3, 4, [130, 130, 130]), (s) => undone.push(s));
    void box.undo(k, recAt(3, 4, [130, 130, 130]), at(4));
    await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
    expect(states(second)).toEqual(["saving"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([states(first).at(-1), states(second).at(-1), counts.at(-1)]).toEqual(["waiting", "waiting", 2]); // the box and the Measure line agree
    open();
    await box.flush();
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect([states(quick), states(undone), states(first).at(-1), states(second).at(-1)]).toEqual([["saving", "saved"], ["saving"], "saved", "saved"]);
  } finally { vi.useRealTimers(); }
});
test("pending() counts this person's waiting Records and removals (the Study table loads again while any waits), not Undo lookups or another person's", async () => {
  const { ctl, db } = fakeDb(), kv = memKv();
  ctl.fail = true;
  outbox(db, kv, () => "u-b").add(rec(5, 2));
  const box = outbox(db, kv, me);
  box.add(rec(0));
  await box.remove(scan.scan_ref, mr("x"), "duplicate");
  await box.undo("saved earlier", rec(1), at(2));
  expect(box.pending()).toBe(2);
  ctl.fail = false;
  ctl.t.Scan.push({ ...rec(0).scan, id: "S1" });
  ctl.t.NoduleMeasurement.push(mr("x", { scan_id: "S1" }));
  await box.flush();
  expect(box.pending()).toBe(0);
});
test("two Scan rows with one scan_ref: every lookup reads the rows of both, and a Record goes to the oldest", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  ctl.t.Scan.push({ ...rec(0).scan, id: "S1" }, { ...rec(0).scan, id: "S2" }); // a reload race on a Scan create, or two browsers on one computer
  const on2 = (id: string, min: number, n: number, pos: [number, number, number]) => ({ ...recAt(min, n, pos).measurement, id, scan_id: "S2", nodule_label: `N${n}` });
  ctl.t.NoduleMeasurement.push(on2("M1", 0, 1, [50, 50, 50]));
  expect(await box.highest(scan.scan_ref)).toBe(1); // the numbering
  box.add(recAt(0, 1, [50, 50, 50]), undefined, SP); // the same Record again (a lost reply): found, not saved twice
  box.add(recAt(1, 2, [50, 50, 90]), undefined, SP); // elsewhere: the next label, on the oldest Scan row
  box.add(recAt(2, 3, [50, 50, 52]), undefined, SP); // near N1: re-measures it
  await box.flush();
  ctl.t.NoduleMeasurement.push(on2("M4", 4, 3, [90, 90, 90]), on2("M5", 5, 4, [10, 10, 10])); // saved from the other browser
  await box.undo("the other browser's", recAt(4, 3, [90, 90, 90]), at(6)); // Undo finds its Record
  expect(await box.remove(scan.scan_ref, ctl.t.NoduleMeasurement.at(-2) as never, "duplicate", at(7))).toEqual({ saved: true, outOfDate: false });
  expect(ctl.t.NoduleMeasurement.map((r) => [r.scan_id, ...[r.nodule_label, r.replaces_id ?? "", r.removed_reason ?? ""]])).toEqual([
    ["S2", "N1", "", ""], ["S1", "N2", "", ""], ["S1", "N1", "M1", ""], ["S2", "N3", "", ""], ["S2", "N4", "", ""], ["S1", "N3", "M4", "recorded by mistake"], ["S2", "N4", "M5", "duplicate"]]); // a table removal row sits on its row's Scan row
});
test("a Study-table removal whose row is not found waits and is tried again; it never says saved", async () => {
  const { ctl, db } = fakeDb(), kv = memKv(), failures: string[] = [], box = outbox(db, kv, me, { onFail: (r) => failures.push(r) });
  ctl.t.Scan.push({ ...rec(0).scan, id: "S1" });
  expect(await box.remove(scan.scan_ref, mr("ghost"), "wrong scan")).toEqual({ saved: false, outOfDate: false });
  expect(await box.remove("no such scan", mr("ghost2"), "wrong scan")).toEqual({ saved: false, outOfDate: false });
  await box.flush();
  expect([ctl.t.NoduleMeasurement.length, waiting(kv).map((w) => w.e.measurement.replaces_id), failures]).toEqual([0, ["ghost", "ghost2"], ["RowNotFound", "RowNotFound"]]);
});
import { NEAR_LONG_AXIS, NEAR_MM } from "./study";
test("a browser store that refuses writes keeps the waiting rows in memory for this tab", async () => {
  const { ctl, db } = fakeDb(), box = outbox(db, { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => {}, keys: () => [] }, me);
  ctl.fail = true;
  box.add(rec(0));
  await box.flush();
  ctl.fail = false;
  await box.flush();
  expect(ctl.t.NoduleMeasurement.length).toBe(1);
});
import { utcTime } from "./utc";
test("one time rule: a Base44 time with no zone is UTC; the page's lookups and lines use it", async () => {
  expect([utcTime("2026-10-27T12:00:00"), utcTime("2026-10-27T12:00:00.000Z"), utcTime("2026-10-27T12:00:00+00:00"), utcTime("2026-10-27T14:00:00+0200")]).toEqual(Array(4).fill(Date.UTC(2026, 9, 27, 12)));
  expect([utcTime(undefined), utcTime("")]).toEqual([NaN, NaN]);
  const { ctl, db } = fakeDb(), box = outbox(db, memKv(), me);
  const key = box.add(rec(0));
  await box.flush();
  ctl.t.NoduleMeasurement[0].approved_at = at(0).replace(".000Z", ""); // as Base44 reads its own dates back: no zone
  await box.undo(key, rec(0), at(1));
  expect(ctl.t.NoduleMeasurement.map((r) => r.removed_reason ?? "row")).toEqual(["row", "recorded by mistake"]);
  const local = new Date(Date.UTC(2026, 9, 27, 12, 0)), hh = (n: number) => String(n).padStart(2, "0");
  expect(replacesLine({ nodule_label: "N1", approved_at: "2026-10-27T12:00:00" }, local)).toBe(`This replaces nodule 1 recorded at ${hh(local.getHours())}:${hh(local.getMinutes())}.`);
});

test("waiting() lists this person's Records still waiting, not removals, not another person's; empty once saved", async () => {
  const { ctl, db } = fakeDb(), kv = memKv();
  ctl.fail = true;
  outbox(db, kv, () => "user-b").add(rec(5, 2));
  const box = outbox(db, kv, me), key = box.add(rec(0));
  await box.remove("k3J9xQ2mZp", mr("x"), "duplicate");
  expect(box.waiting()).toEqual([{ key, ...rec(0) }]);
  ctl.fail = false;
  await box.flush();
  expect(box.waiting()).toEqual([]);
});
