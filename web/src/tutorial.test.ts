import { expect, test } from "vitest";
import type { Outline, Patients, ScanMeta } from "./api";
import { toRow } from "./record";
import { toEntities } from "./study";
import { CASE, FINDER_OFF, OFFERED, STEPS, correctLines, appHasOpen, back, escExits, idle, markOffered, next, observe, placeBox, practiceN, shouldOffer, show, start, unmarkOffered, type Facts } from "./tutorial";

const f = (more: Partial<Facts> = {}): Facts => ({ ...idle, ...more });
const ids = (path: Facts[]) => { let t = start(path[0]); const seen = [STEPS[t.i].id]; for (const x of path.slice(1)) { t = observe(t, x); if (seen.at(-1) !== STEPS[t.i].id) seen.push(STEPS[t.i].id); } return seen; };

test("the steps, in order, numbered 1 to 12; the Study table comes twice (8 and 10), the optional extras before the end", () => {
  expect(STEPS.map((s) => `${s.n}:${s.id}`)).toEqual(["1:engine", "2:patients", "3:baseline", "4:cross", "5:check", "6:correct", "7:record", "8:table", "8:row", "8:csv",
    "9:measure", "9:followup", "9:find", "9:here", "9:record-followup", "10:table-again", "10:both", "11:finder", "11:paint", "12:end"]);
});

test("practice path: each step moves on by itself when its condition becomes true while it is shown", () => {
  const live = { practice: true, live: true };
  expect(ids([f({ practice: true }), f(live), f({ ...live, sheet: true }), f({ ...live, scan: CASE.test }), f({ ...live, scan: CASE.test, measured: true })]))
    .toEqual(["engine", "patients", "baseline", "cross", "check"]);
  let t = start(f({ practice: true }));
  expect(show(t, f({ practice: true })).anchors[0]).toEqual({ sel: "button", name: /^Use the practice server$/ });
  t = observe(observe(t, f(live)), f({ ...live, sheet: true, patientN: 3 }));
  const s = show(t, f({ ...live, sheet: true, patientN: 3 }));
  expect(s.lines[0]).toBe("Press Practice patient 3. Then press Open beside Baseline.");
  expect(s.anchors[0].name?.test("Practice patient 3Baseline and follow-up")).toBe(true); // the row first, until it is the one shown
  expect(s.anchors[0].name?.test("Practice patient 31Baseline and follow-up")).toBe(false);
  expect(show(t, f({ ...live, sheet: true, patientN: 3, rowShown: true })).anchors[0]).toEqual({ sel: '[role="dialog"][aria-label="Patients"] button', name: /^Open Baseline$/ });
});

test("local path: step 2 is left out (the frame cannot be reached into); step 3 points at the frame and names the patient and scan in words", () => {
  const local = f({ live: true, local: true });
  let t = observe(start(f()), local);
  expect(STEPS[t.i].id).toBe("baseline");
  const s = show(t, local);
  expect(s.n).toBe(3);
  expect(s.anchors[0]).toEqual({ sel: 'iframe[title="Patients"]' });
  expect(s.lines.join(" ")).toContain("RIDER-2619750334, Baseline");
  t = observe(t, f({ live: true, local: true, scan: CASE.test }));
  expect(STEPS[t.i].id).toBe("cross");
  t = back(back(t, local), local);
  expect(STEPS[t.i].id).toBe("engine"); // Back skips the left-out step too
  expect(show(t, local).next).toBe(true); // its condition holds: Next, no wait
});

test("Back shows the previous step with Next when its condition already holds, and it does not move on by itself; Skip goes to the next step", () => {
  const at = f({ practice: true, live: true, scan: CASE.test, measured: true });
  let t = observe(start(f({ practice: true, live: true, scan: CASE.test })), at); // engine and patients and baseline hold at once: Next, no wait
  expect(STEPS[t.i].id).toBe("engine");
  t = next(t, at)!; t = next(t, at)!; t = next(t, at)!;
  expect(STEPS[t.i].id).toBe("cross");
  expect(show(t, at).next).toBe(true); // the numbers already show
  t = next(t, at)!; // check: Next only
  expect(STEPS[t.i].id).toBe("check");
  t = back(t, at);
  expect(STEPS[t.i].id).toBe("cross");
  expect(show(t, at).next).toBe(true);
  expect(STEPS[observe(t, at).i].id).toBe("cross"); // held: no move by itself
  expect(STEPS[next(t, at)!.i].id).toBe("check"); // Skip and Next both go on
  expect(show(t, at).skip && show(t, at).back).toBe(true);
});

test("a step whose condition holds when it appears waits for Next; one that becomes true while shown moves on", () => {
  const recorded = f({ live: true, scan: CASE.test, measured: true, recorded: true });
  let t = start(recorded, STEPS.findIndex((s) => s.id === "record"));
  expect(show(t, recorded).next).toBe(true);
  expect(STEPS[observe(t, recorded).i].id).toBe("record");
  const open = f({ live: true, scan: CASE.test, measured: true });
  t = start(open, STEPS.findIndex((s) => s.id === "record"));
  expect(show(t, open).next).toBe(false);
  expect(STEPS[observe(t, recorded).i].id).toBe("table");
});

test("the correction step moves on only after a correction finishes while it is shown, and remembers it on Back", () => {
  const open = f({ live: true, scan: CASE.test, measured: true, edits: 2 });
  let t = start(open, STEPS.findIndex((s) => s.id === "correct"));
  expect(show(t, open).next).toBe(false);
  expect(STEPS[observe(t, open).i].id).toBe("correct");
  t = observe(t, { ...open, edits: 3 });
  expect(STEPS[t.i].id).toBe("record");
  t = back(t, { ...open, edits: 3 });
  expect(STEPS[t.i].id).toBe("correct");
  expect(show(t, { ...open, edits: 3 }).next).toBe(true);
  expect(show(t, open).anchors[0]).toEqual({ sel: "@cross" }); // the small ring of the precomputed correction
});

test("the finder step: off says so and offers Next; on, it points at the button; the paint step points at the By hand row, or at New nodule while it is hidden", () => {
  const finder = start(f({ tab: "Measure" }), STEPS.findIndex((s) => s.id === "finder"));
  const off = show(finder, f({ tab: "Measure" }));
  expect(off.lines).toEqual([FINDER_OFF]);
  expect(FINDER_OFF).toBe("The nodule finder is off here. It is optional.");
  expect(off.next && off.skip).toBe(true);
  expect(show(finder, f({ tab: "Measure", finder: true })).anchors[0].sel).toBe(".m-finder button");
  const paint = start(f(), STEPS.findIndex((s) => s.id === "paint"));
  expect(show(paint, f({ tools: true })).anchors[0]).toEqual({ sel: '[role="group"][aria-label="By hand"]' });
  expect(show(paint, f()).anchors[0]).toEqual({ sel: "button", name: /^New nodule \(N\)$/ });
  expect(show(paint, f()).next).toBe(true);
});

test("a step on the other tab first points at that tab; the last step has no Skip and no Next", () => {
  const row = start(f({ tab: "Measure", scan: CASE.test }), STEPS.findIndex((s) => s.id === "row"));
  const s = show(row, f({ tab: "Measure", scan: CASE.test }));
  expect(s.lines[0]).toBe("First press Study table.");
  expect(s.anchors).toEqual([{ sel: '[role="tab"]', name: /^Study table$/ }]);
  const end = start(f(), STEPS.length - 1);
  expect(show(end, f())).toMatchObject({ n: 12, skip: false, next: false, back: true });
  expect(next(end, f())).toBeUndefined();
});

test("every step text: plain sentences, no contractions, no em dashes", () => {
  const all = [f(), f({ practice: true }), f({ local: true, live: true }), f({ finder: true, tools: true, findLabel: "Find N1", patientN: 2 })];
  for (const x of all) for (let i = 0; i < STEPS.length; i++) for (const line of show(start(x, i), x).lines) {
    expect(line).not.toMatch(/—|–|n't|'s |'re |'ll |'ve /);
    expect(line).toMatch(/[.?:)›]$/);
  }
});

test("the practice patient that holds the tutorial scan, by the page's own patient data", () => {
  const data: Patients = { folder: { path: null, from: null, error: null }, patients: ["RIDER-1286684383", "RIDER-2541949645", "RIDER-2619750334"].map((key, i) => ({
    key, name: `Practice patient ${i + 1}`, source: "data" as const, scans: [{ id: `${key}_test`, timepoint: "Baseline" as const, date: null, day: 0, label: "", slice_mm: null, images: 1 }] })) };
  expect(practiceN(data)).toBe(3);
  expect(practiceN(null)).toBeUndefined();
  expect(practiceN({ ...data, patients: data.patients.slice(0, 2) })).toBeUndefined();
});

test("offered once per browser; storage that throws never breaks the page (it offers, and the answer is kept for this page only); never to an automated browser", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  expect(shouldOffer(store, false)).toBe(true);
  markOffered(store);
  expect(mem.get(OFFERED)).toBe("1");
  expect(shouldOffer(store, false)).toBe(false);
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  expect(shouldOffer(broken, false)).toBe(true);
  expect(() => markOffered(broken)).not.toThrow();
  expect(shouldOffer(undefined, false)).toBe(true); // no storage at all
  expect(shouldOffer(new Map() as never, true)).toBe(false); // navigator.webdriver: the e2e and scripted runs
});

test("Esc exits the tour, except while one of the app's sheets or lists is open (Esc closes that first)", () => {
  const key = (k: string, more = {}) => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...more });
  expect(escExits(key("Escape"), false)).toBe(true);
  expect(escExits(key("Escape"), true)).toBe(false);
  expect(escExits(key("Enter"), false)).toBe(false);
  expect(escExits(key("Escape", { repeat: true }), false)).toBe(false);
  const doc = (hit: string | null, frameH = 34) => ({ querySelector: (s: string) => (hit && s.split(",").some((x) => x.trim() === hit) ? {} : s.startsWith("iframe") ? { getBoundingClientRect: () => ({ height: frameH }) } : null) });
  expect(appHasOpen(doc(null) as never)).toBe(false);
  for (const open of ['[role="dialog"]', "dialog[open]", '[aria-controls="m-suggestions"][aria-expanded="true"]', '[aria-label="Zoom to area (Z)"][aria-pressed="true"]']) expect(appHasOpen(doc(open) as never)).toBe(true);
  expect(appHasOpen(doc(null, 700) as never)).toBe(true); // the local engine's Patients frame, grown over the viewer
});

test("the box goes on the preferred side when it fits, else the next side, else inside the target's bottom-left corner", () => {
  const box = { w: 300, h: 150 }, vw = 1440, vh = 900;
  const tab = { left: 200, top: 10, right: 290, bottom: 44 };
  expect(placeBox(tab, box, vw, vh, "below")).toMatchObject({ side: "below", top: 44 + 14 });
  const record = { left: 1150, top: 820, right: 1420, bottom: 860 };
  expect(placeBox(record, box, vw, vh, "below")).toMatchObject({ side: "above" });
  expect(placeBox(record, box, vw, vh, "left")).toMatchObject({ side: "left", left: 1150 - 14 - 300 });
  const all = { left: 0, top: 0, right: 1440, bottom: 900 };
  expect(placeBox(all, box, vw, vh, "below")).toMatchObject({ side: "inside", left: 16, top: 900 - 150 - 16 });
  const near = placeBox({ left: 0, top: 100, right: 40, bottom: 120 }, box, vw, vh, "below");
  expect(near.left).toBe(8); // kept on screen
  expect(near.arrow).toBeGreaterThanOrEqual(12); // the arrow still points at the target, within the box
});

// A Record made in the tutorial is a practice row, because its study code is a RIDER code.
test("the tutorial case's Record payloads are practice rows (Baseline and follow-up)", () => {
  const outline: Outline = { nodule: 1, scan: CASE.test, can_undo: true, clicks: [{ ...CASE.cross, positive: true }], at_window_edge: false, bbox: null, mask: null, volume_ml: 80.1,
    long_mm: 83.2, short_mm: 50.4, axis_z: 148, long_line: [[1, 2], [3, 4]], short_line: [[5, 6], [7, 8]], seconds: 1, depth_mm: 60, width_method: "edge to edge" };
  for (const [id, series] of [[CASE.test, "test"], [CASE.retest, "retest"]]) {
    const scan: ScanMeta = { id, scan_ref: "k3J9xQ2mZp", study_code: CASE.patient, days_from_baseline: 0, patient: CASE.patient, series, shape: [281, 512, 512], spacing: [0.78125, 0.78125, 1.25],
      instance_numbers: null, series_number: 2, slice_thickness_mm: 1.25, head_dir: 1 };
    expect(toEntities(toRow(scan, outline, 1, 5, "runs/x.json"), scan, { commit: "c", model: "m" }).measurement.practice).toBe(true);
  }
});

test("with Practice rows off on the Study table, steps 8 and 10 first point at that switch, and at the Record once it is on", () => {
  const SWITCH = { sel: '[role="switch"]', name: /^Practice rows$/ };
  for (const id of ["row", "csv", "both"]) {
    const t = start(f({ tab: "Study table", scan: id === "both" ? CASE.retest : CASE.test }), STEPS.findIndex((s) => s.id === id));
    const off = show(t, f({ tab: "Study table", scan: id === "both" ? CASE.retest : CASE.test, practiceRows: false }));
    expect(off.lines).toEqual(["Turn on Practice rows to see your Record.", "Practice rows are kept apart from the study record."]);
    expect(off.anchors).toEqual([SWITCH]);
    expect(off.next).toBe(false); // it waits for the switch (Skip still goes on)
    expect(show(t, f({ tab: "Study table", scan: id === "both" ? CASE.retest : CASE.test, practiceRows: true })).next).toBe(true);
    expect(off.n).toBe(id === "both" ? 10 : 8);
    for (const on of [true, undefined]) expect(show(t, f({ tab: "Study table", scan: id === "both" ? CASE.retest : CASE.test, practiceRows: on })).anchors).not.toContainEqual(SWITCH); // on, or no switch (no rows yet)
  }
  const row = start(f({ tab: "Study table", scan: CASE.test }), STEPS.findIndex((s) => s.id === "row"));
  expect(show(row, f({ tab: "Study table", scan: CASE.test, practiceRows: true })).anchors[0].name?.test("RIDER-2619750334PracticeN1")).toBe(true);
});

test("while the local engine is awaited, step 1 says what its arrow points at", () => {
  const t = start(f({ practice: true }));
  const waiting = show(t, f({ practice: true, local: true }));
  expect(waiting.anchors).toEqual([{ sel: "button", name: /^Use your own computer$/ }]);
  expect(waiting.lines.join(" ")).not.toContain("Press Use the practice server");
  expect(waiting.lines.join(" ")).toContain("You pressed Use your own computer.");
  expect(show(t, f({ local: true })).lines.join(" ")).toContain("You pressed Use your own computer.");
  expect(show(t, f({})).lines).toEqual(["Choose where the tool runs.", "Press Use your own computer. The tool must be running on this computer."]); // no practice server ready
});

test("controls are named as the page shows them: Find (beside N1), and the Patients button by its own label", () => {
  const find = start(f({ scan: CASE.retest }), STEPS.findIndex((s) => s.id === "find"));
  expect(show(find, f({ scan: CASE.retest, findLabel: "Find N1" })).lines[0]).toBe("Press Find beside N1. The tool looks for your Baseline nodule on this scan.");
  const patients = start(f({ live: true }), STEPS.findIndex((s) => s.id === "patients"));
  expect(show(patients, f({ live: true, patientsLabel: "Choose a scan" })).lines[0]).toBe("Press Choose a scan, above the image, to open the Patients panel.");
  expect(show(patients, f({ live: true, patientsLabel: "Practice patient 1 · Baseline" })).lines[0]).toBe("Press Practice patient 1 · Baseline, above the image, to open the Patients panel.");
  expect(show(patients, f({ live: true })).lines[0]).toBe("Press the Patients button above the image."); // still loading: no label to name
});

test("step 4 names the image with the ring and says to come back to it", () => {
  expect(CASE.image).toBe(133); // instance number at z 148 (eval/cases.csv test_image)
  const lines = show(start(f({ scan: CASE.test }), STEPS.findIndex((s) => s.id === "cross")), f({ scan: CASE.test })).lines.join(" ");
  expect(lines).toContain("Click the centre of the white ring on Image 133.");
  expect(lines).toContain("If you scrolled away, go back to Image 133.");
});

// A precomputed correction for step 6, so a user who cannot read CT has a place to click
test("the correction point: the evaluation's next_click against R1 on the real model's first outline (an Add on Image 153), on the tutorial's scan", () => {
  expect(CASE.fix).toEqual({ scan: "RIDER-2619750334_test", z: 128, y: 343, x: 200, tone: "add", image: 153 });
  const lines = show(start(f({ scan: CASE.test }), STEPS.findIndex((s) => s.id === "correct")), f({ scan: CASE.test })).lines;
  expect(lines).toEqual(["Correct the outline once.", "Click the centre of the small ring: a part the first outline missed.", "It is on Image 153. If you scrolled away, go back to Image 153.", "Undo (U) takes it back."]);
  expect(correctLines({ tone: "remove", image: 120 })[1]).toBe("Click the centre of the small ring: a part it should not hold. Hold Shift, or press R first.");
  expect(correctLines({ tone: "remove", image: 120 })[2]).toBe("It is on Image 120. If you scrolled away, go back to Image 120.");
});

// A Record of another scan is never called a practice row, and never moves the tour on
test("from step 4 on, a scan that is not the case's never advances the tour: the box asks for the case's scan by its name on this page, and waits", () => {
  const other = "RIDER-1286684383_test", from = STEPS.findIndex((s) => s.id === "cross");
  const doneish = (tab: string, scan?: string): Facts => f({ live: true, tab, scan, measured: true, recorded: true, edits: 9, proposal: true, findLabel: "Find N1", finder: true, tools: true, practiceRows: true });
  for (let i = from; i < STEPS.length; i++) for (const scan of [other, undefined]) for (const tab of ["Measure", "Study table"]) {
    const t = start(f({ live: true, tab, scan }), i);
    expect(STEPS[observe(t, doneish(tab, scan)).i].id).toBe(STEPS[i].id); // done conditions all true, but on the wrong scan
    const sh = show(t, doneish(tab, scan));
    if (["finder", "paint", "end"].includes(STEPS[i].id)) continue; // the optional extras and the end need no scan
    expect(sh.next).toBe(false);
    expect(sh.lines.join(" ")).not.toMatch(/ractice row|marked Practice/);
    const retest = ["find", "here", "record-followup", "table-again", "both"].includes(STEPS[i].id);
    expect(sh.lines.at(-1)).toBe(retest ? "Open RIDER-2619750334, Follow-up, first (step 9)." : "Open RIDER-2619750334, Baseline, first (step 3).");
    expect(sh.anchors[0]).toEqual(tab === "Measure" ? { sel: '.m-bar button[aria-haspopup="dialog"]' } : { sel: '[role="tab"]', name: /^Measure$/ });
  }
  const practice = f({ live: true, tab: "Measure", scan: other, patientN: 3 }), local = f({ live: true, local: true, tab: "Measure", scan: other });
  expect(show(start(practice, from), practice).lines).toEqual(["Open Practice patient 3, Baseline, first (step 3)."]); // the case's name as this page shows it
  expect(show(start(local, from), local).anchors[0]).toEqual({ sel: 'iframe[title="Patients"]' });
  const onCase = f({ live: true, tab: "Measure", scan: CASE.test });
  expect(STEPS[observe(start(onCase, from), { ...onCase, measured: true }).i].id).toBe("check"); // on the case scan it moves on as before
  const followup = STEPS.findIndex((s) => s.id === "followup"); // the Measure tab and Follow-up › steps take either scan of the case
  expect(show(start(onCase, followup), onCase).lines[0]).toBe("Press Follow-up ›, or press Alt+→.");
});

test("Esc on the offer closes it for this visit only: the flag set when it showed is taken back, so it may show next visit", () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  markOffered(store);
  unmarkOffered(store);
  expect(shouldOffer(store, false)).toBe(true);
  expect(() => unmarkOffered({ removeItem: () => { throw new Error("blocked"); } })).not.toThrow();
  expect(() => unmarkOffered(undefined)).not.toThrow();
});
