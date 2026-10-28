import type { Patients } from "./api";

/** Tutorial mode: the coach's step model, kept free of the DOM. The coach (Coach.tsx) reads the page into Facts; each step names where to point
 *  and when it is done. Research use only: the case is a public RIDER development scan, so its Records are practice rows. */
export const CASE = { patient: "RIDER-2619750334", test: "RIDER-2619750334_test", retest: "RIDER-2619750334_retest",
  cross: { scan: "RIDER-2619750334_test", z: 148, y: 337, x: 195 }, image: 133, // the evaluation's cross for that scan (eval/cases.csv: slice 148, Image 133), z the engine's array index
  // Step 6's correction, made 2026-10-28 the evaluation's way: eval/replay.py next_click (the deepest voxel of the largest error) between the real
  // model's first-click outline at the cross and R1 (RIDER-LungCT-Seg), then one correction there (replay.py walk): Dice against R1 0.786 to 0.815,
  // against R2 (median of the 5 QIBA readers) 0.831 to 0.831. A + click (inside R1, outside the outline), on Image 153 (z 128).
  fix: { scan: "RIDER-2619750334_test", z: 128, y: 343, x: 200, tone: "add", image: 153 } } as const;

/** What the coach reads from the page: roles, names and text, plus the open scan and the practice patient App reports. */
export type Facts = {
  tab: string; live: boolean; local: boolean; practice: boolean; sheet: boolean; rowShown: boolean; scan?: string; patientN?: number;
  measured: boolean; recorded: boolean; edits: number; proposal: boolean; findLabel?: string; finder: boolean; tools: boolean;
  patientsLabel?: string; practiceRows?: boolean; // the Patients button's own words; the Study table's Practice rows switch (undefined: not shown)
};
export const idle: Facts = { tab: "Measure", live: false, local: false, practice: false, sheet: false, rowShown: false, measured: false, recorded: false, edits: 0, proposal: false, finder: false, tools: false };
/** A control by a CSS selector for its role and an accessible name; "@cross" is the white ring the coach asks App to draw. */
export type Anchor = { sel: string; name?: RegExp };
export type Side = "below" | "above" | "left" | "right";
type Tab = "Measure" | "Study table";
type Step = { id: string; n: number; tab?: Tab; side?: Side; when?: (f: Facts) => boolean; lines: (f: Facts) => string[]; at: (f: Facts) => Anchor[]; done?: (f: Facts, from: Facts) => boolean;
  record?: boolean; // shows the Record's line in the Study table: hidden while Practice rows is off
  on?: "test" | "retest" | "case" }; // counts only while the case's Baseline, Follow-up, or either is the open scan: another scan never moves the tour on

const exact = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const button = (name: string): Anchor => ({ sel: "button", name: exact(name) });
const tab = (name: Tab): Anchor => ({ sel: '[role="tab"]', name: exact(name) });
const SHEET = '[role="dialog"][aria-label="Patients"]';
const PATIENTS: Anchor = { sel: '.m-bar button[aria-haspopup="dialog"]' }, FRAME: Anchor = { sel: 'iframe[title="Patients"]' };
const RECORD = button("Record nodule (Enter)"), STATUS: Anchor = { sel: 'section[aria-label="Measurements"] .m-status' };
const ROW: Anchor = { sel: 'table[aria-label="Study record"] tbody tr', name: new RegExp(CASE.patient) }, TABLE: Anchor = { sel: 'section[aria-label="Study table"]' };
export const FINDER_OFF = "The nodule finder is off here. It is optional.";
/** Step 6's words for a precomputed correction: an Add or a Remove click on the small ring, on its image. */
export const correctLines = ({ tone, image }: { tone: "add" | "remove"; image: number }) => ["Correct the outline once.",
  tone === "add" ? "Click the centre of the small ring: a part the first outline missed." : "Click the centre of the small ring: a part it should not hold. Hold Shift, or press R first.",
  `It is on Image ${image}. If you scrolled away, go back to Image ${image}.`, "Undo (U) takes it back."];
const SWITCH: Anchor = { sel: '[role="switch"]', name: /^Practice rows$/ };
const onRetest = (f: Facts) => f.scan === CASE.retest;

export const STEPS: Step[] = [
  { id: "engine", n: 1, tab: "Measure", done: (f) => f.live,
    lines: (f) => (f.live ? ["Connected. The line above the image says where the tool runs."]
      : f.local ? ["Choose where the tool runs.", `You pressed ${f.practice ? "Your own computer" : "Use my local engine"}. This step moves on once the tool on this computer answers.`]
      : f.practice ? ["Choose where the tool runs.", "Press Practice server: there is nothing to install.", "Your own computer also works, once the tool is installed there."]
      : ["Choose where the tool runs.", "Press Use my local engine. The tool must be running on this computer."]),
    at: (f) => (f.live ? [{ sel: ".shell-line" }] : [...(f.practice && !f.local ? [button("Practice server")] : []), button("Your own computer"), button("Use my local engine")]) },
  { id: "patients", n: 2, tab: "Measure", when: (f) => !f.local, done: (f) => f.sheet, // the local engine's panel is a frame this page cannot reach into: step 3 says it in words
    lines: (f) => [f.patientsLabel ? `Press ${f.patientsLabel}, above the image, to open the Patients panel.` : "Press the Patients button above the image."], at: (f) => (f.sheet ? [{ sel: SHEET }] : [PATIENTS]) },
  { id: "baseline", n: 3, tab: "Measure", done: (f) => f.scan === CASE.test,
    lines: (f) => (f.local ? [`Open ${CASE.patient}, Baseline, in the Patients panel above the image.`, "Type the code in Search patients, then press Open beside Baseline."]
      : f.patientN ? [`Press Practice patient ${f.patientN}. Then press Open beside Baseline.`, "It is a public practice scan (RIDER Lung CT)."]
      : ["In the Patients panel, press Open beside Baseline."]),
    at: (f) => {
      const open = { sel: `${SHEET} button`, name: /^Open Baseline$/ };
      if (f.local) return [FRAME, { sel: ".m-bar select" }]; // the drop-down stands in when the frame does not open
      if (!f.sheet) return [PATIENTS];
      return f.rowShown || !f.patientN ? [open] : [{ sel: `${SHEET} .pp-pt`, name: new RegExp(`^Practice patient ${f.patientN}(?!\\d)`) }, open];
    } },
  { id: "cross", on: "test", n: 4, tab: "Measure", side: "right", done: (f) => f.measured,
    lines: () => [`Click the centre of the white ring on Image ${CASE.image}.`, "It marks the nodule. One click outlines the whole nodule, on every image it covers.", `If you scrolled away, go back to Image ${CASE.image}.`],
    at: () => [{ sel: "@cross" }, { sel: 'canvas[aria-label="CT slice"]' }] },
  { id: "check", on: "test", n: 5, tab: "Measure", side: "left",
    lines: () => ["Check the outline on a few images. Use the arrow keys or the wheel.", "The panel shows the volume, the long and short axes, and the images the nodule covers."],
    at: () => [{ sel: 'section[aria-label="Measurements"] .m-card' }] },
  { id: "correct", on: "test", n: 6, tab: "Measure", side: "right", done: (f, from) => f.edits > from.edits && f.measured,
    lines: () => correctLines(CASE.fix), at: () => [{ sel: "@cross" }, { sel: '[role="group"][aria-label="Clicks"]' }] }, // "@cross": App draws CASE.fix in this step
  { id: "record", on: "test", n: 7, tab: "Measure", side: "left", done: (f) => f.recorded,
    lines: () => ["Press Record nodule, or Enter.", "The numbers are saved to the Study table as a practice row."], at: () => [RECORD, STATUS] },
  { id: "table", on: "test", n: 8, done: (f) => f.tab === "Study table", lines: () => ["Press Study table. It lists every saved Record."], at: () => [tab("Study table")] },
  { id: "row", on: "test", n: 8, tab: "Study table", record: true,
    lines: () => ["This line is your Record: the long axis, the short axis, the volume and the method.", "It is marked Practice. Practice rows are kept apart from the study record."], at: () => [ROW, TABLE] },
  { id: "csv", on: "test", n: 8, tab: "Study table", record: true, lines: () => ["Download CSV saves the table as a file for a spreadsheet."], at: () => [button("Download CSV")] },
  { id: "measure", on: "case", n: 9, done: (f) => f.tab === "Measure", lines: () => ["Now measure the same nodule on the repeat scan. Press Measure."], at: () => [tab("Measure")] },
  { id: "followup", on: "case", n: 9, tab: "Measure", done: onRetest,
    lines: (f) => [f.local ? "Press Follow-up › in the Patients bar, or press Alt+→." : "Press Follow-up ›, or press Alt+→.", "It opens the repeat scan of this patient."],
    at: (f) => (f.local ? [FRAME] : [button("Follow-up ›"), PATIENTS]) },
  { id: "find", on: "retest", n: 9, tab: "Measure", done: (f) => f.proposal || (onRetest(f) && f.measured), // the proposal needs Find first (the brief left it out)
    lines: (f) => [`Press Find${f.findLabel ? ` beside ${f.findLabel.replace(/^Find /, "")}` : ""}. The tool looks for your Baseline nodule on this scan.`, "The first time takes about 15 s."], // the button reads Find; its row names N1
    at: () => [{ sel: '[role="group"][aria-label="Earlier nodules"] button', name: /^Find N\d+$/ }] },
  { id: "here", on: "retest", n: 9, tab: "Measure", done: (f) => onRetest(f) && f.measured,
    lines: () => ["The yellow ring shows where your Baseline nodule is on this scan. Check it.", "Press Measure here (M) to outline the nodule at the ring."], at: () => [button("Measure here (M)")] },
  { id: "record-followup", on: "retest", n: 9, tab: "Measure", side: "left", done: (f) => onRetest(f) && f.recorded,
    lines: () => ["Check the outline, then press Record nodule or Enter."], at: () => [RECORD, STATUS] },
  { id: "table-again", on: "retest", n: 10, done: (f) => f.tab === "Study table", lines: () => ["Press Study table again."], at: () => [tab("Study table")] },
  { id: "both", on: "retest", n: 10, tab: "Study table", record: true, lines: () => ["The same line now holds both scans side by side: Baseline and Follow-up, each with its own numbers."], at: () => [ROW, TABLE] },
  { id: "finder", n: 11, tab: "Measure",
    lines: (f) => (f.finder ? ["Optional: Find nodules.", "The finder suggests places to check on the open scan. Its marks are suggestions, not findings. Read the whole scan as usual."] : [FINDER_OFF]),
    at: (f) => (f.finder ? [{ sel: ".m-finder button" }] : []) },
  { id: "paint", n: 11, tab: "Measure", side: "left",
    lines: (f) => (f.tools ? ["Optional: the tools for fixes by hand.", "Paint (P) and Erase (E): drag on the image to add to the outline or take away from it, on that image only.",
      "Axes (X): drag an end of an axis line on the largest slice to set it by hand."]
      : ["Optional: Paint (P), Erase (E) and Axes (X) fix an outline by hand.", "They show while an outline is open. Press New nodule (N), then click a nodule to see them."]),
    at: (f) => (f.tools ? [{ sel: '[role="group"][aria-label="By hand"]' }] : [button("New nodule (N)")]) },
  { id: "end", n: 12, lines: () => ["That is the whole tour.", "You measured a nodule, corrected it, recorded it and measured it again on the repeat scan. The Records stay in the Study table.",
    "Tutorial, in the top bar, starts it again.", "Research use only. Not a medical device."], at: () => [] },
];

const caseOpen = (s: Step, f: Facts) => !s.on || (s.on === "test" ? f.scan === CASE.test : s.on === "retest" ? onRetest(f) : f.scan === CASE.test || onRetest(f));
/** The case as this page names it: "Practice patient N" on a practice server, its RIDER code with the local engine. */
const caseName = (f: Facts) => (f.patientN ? `Practice patient ${f.patientN}` : CASE.patient);

/** The tour: the step shown, the facts when it appeared (a correction counts from there), whether its condition held then (it shows Next and never
 *  moves on by itself), and the steps that completed by themselves (Back to one shows Next). */
export type Tour = { i: number; from: Facts; held: boolean; done: string[] };
const fits = (i: number, f: Facts) => STEPS[i].when?.(f) !== false;
const after = (i: number, f: Facts) => { while (i < STEPS.length && !fits(i, f)) i++; return i; };
const enter = (i: number, f: Facts, done: string[]): Tour => ({ i, from: f, done, held: caseOpen(STEPS[i], f) && (done.includes(STEPS[i].id) || !!STEPS[i].done?.(f, f)) });
export const start = (f: Facts, at = 0): Tour => enter(after(at, f), f, []);
/** Next and Skip: the following step that applies; undefined after the last. */
export const next = (t: Tour, f: Facts): Tour | undefined => { const i = after(t.i + 1, f); return i < STEPS.length ? enter(i, f, t.done) : undefined; };
export const back = (t: Tour, f: Facts): Tour => { let i = t.i - 1; while (i >= 0 && !fits(i, f)) i--; return i < 0 ? t : enter(i, f, t.done); };
/** A step moves on by itself only when its condition becomes true while it is shown. */
export const observe = (t: Tour, f: Facts): Tour => {
  const s = STEPS[t.i];
  if (t.held || !caseOpen(s, f) || !s.done?.(f, t.from)) return t;
  const done = [...t.done, s.id];
  return next({ ...t, done }, f) ?? { ...t, done };
};
export type Shown = { n: number; of: number; lines: string[]; anchors: Anchor[]; side: Side; next: boolean; back: boolean; skip: boolean };
/** The box for this step: a step that lives on the other tab first points at that tab; one that shows the Record's line first points at
 *  Practice rows while it is off (it starts off once the study table holds any study row, and the practice lines are then not on the page). */
export function show(t: Tour, f: Facts): Shown {
  const s = STEPS[t.i], last = t.i === STEPS.length - 1;
  if (!caseOpen(s, f)) { // another scan, or none: the box asks for the case's own scan (on Measure) and waits; nothing about that scan
    const ask = s.on === "retest" ? `Open ${caseName(f)}, Follow-up, first (step 9).` : `Open ${caseName(f)}, Baseline, first (step 3).`, measure = f.tab === "Measure";
    return { n: s.n, of: STEPS[STEPS.length - 1].n, lines: measure ? [ask] : ["First press Measure.", ask], anchors: !measure ? [tab("Measure")] : f.local ? [FRAME, { sel: ".m-bar select" }] : [PATIENTS],
      side: "below", next: false, back: back(t, f) !== t, skip: !last };
  }
  const away = !!s.tab && f.tab !== s.tab, hidden = !away && !!s.record && f.practiceRows === false;
  const lines = away ? [`First press ${s.tab}.`, ...s.lines(f)] : hidden ? ["Turn on Practice rows to see your Record.", "Practice rows are kept apart from the study record."] : s.lines(f);
  return { n: s.n, of: STEPS[STEPS.length - 1].n, lines, anchors: away ? [tab(s.tab!)] : hidden ? [SWITCH] : s.at(f),
    side: away ? "below" : s.side ?? "below", next: !last && !hidden && (!s.done || t.held), back: back(t, f) !== t, skip: !last }; // hidden: it waits for the switch
}

/** The practice patient ("Practice patient N") whose scans hold the tutorial's Baseline, from the page's own patient list. */
export const practiceN = (p: Patients | null | undefined) => {
  const m = p?.patients.find((x) => x.scans.some((s) => s.id === CASE.test || s.code === CASE.test))?.name.match(/^Practice patient (\d+)$/);
  return m ? Number(m[1]) : undefined;
};

/** Offered once per browser. Storage may be blocked or throw: then it is offered, and the answer holds for this page only. An automated browser
 *  (navigator.webdriver: the e2e and scripted runs) is never offered it, so those runs see the page as before; the Tutorial button still works. */
export const OFFERED = "lung.tutorial.offered";
type Store = Pick<Storage, "getItem" | "setItem">;
export const shouldOffer = (store: Store | undefined, automated: boolean) => { if (automated) return false; try { return store?.getItem(OFFERED) !== "1"; } catch { return true; } };
export const markOffered = (store: Store | undefined) => { try { store?.setItem(OFFERED, "1"); } catch { /* blocked storage: offered again next visit */ } };
/** Esc on the offer: closed for this visit only, so it may show again next visit (No thanks is for good). */
export const unmarkOffered = (store: Pick<Storage, "removeItem"> | undefined) => { try { store?.removeItem(OFFERED); } catch { /* blocked storage: nothing was kept */ } };

/** Esc exits the tour, unless one of the app's own sheets, lists, dialogs or modes is open: Esc closes that first, as without the tour. */
const OPEN = ['[role="dialog"]', "dialog[open]", '[aria-controls="m-suggestions"][aria-expanded="true"]', '[aria-label="Zoom to area (Z)"][aria-pressed="true"]'].join(", ");
export const appHasOpen = (doc: Pick<Document, "querySelector">) => !!doc.querySelector(OPEN) || (doc.querySelector('iframe[title="Patients"]')?.getBoundingClientRect().height ?? 0) > 40; // the frame grows over the viewer while its sheet is open
export const escExits = (e: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, appOpen: boolean) =>
  e.key === "Escape" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !appOpen;

export type Rect = { left: number; top: number; right: number; bottom: number };
/** Where the box goes: the preferred side if it fits in the window, else the next side that does, else inside the target's bottom-left corner
 *  (the local engine's Patients frame grown over the page: its sheet is at the top left, the viewer's free corner at the bottom left).
 *  arrow: the arrow's offset along the box edge that faces the target. */
export function placeBox(a: Rect, b: { w: number; h: number }, vw: number, vh: number, prefer: Side, gap = 14): { side: Side | "inside"; left: number; top: number; arrow: number } {
  const m = 8, cx = (a.left + a.right) / 2, cy = (a.top + a.bottom) / 2, clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  for (const side of [prefer, ...(["below", "above", "left", "right"] as const).filter((s) => s !== prefer)]) {
    const vertical = side === "below" || side === "above";
    const left = vertical ? clamp(cx - b.w / 2, m, vw - m - b.w) : side === "left" ? a.left - gap - b.w : a.right + gap;
    const top = vertical ? (side === "below" ? a.bottom + gap : a.top - gap - b.h) : clamp(cy - b.h / 2, m, vh - m - b.h);
    if (left >= m && top >= m && left + b.w <= vw - m && top + b.h <= vh - m) return { side, left, top, arrow: vertical ? clamp(cx - left, 12, b.w - 12) : clamp(cy - top, 12, b.h - 12) };
  }
  return { side: "inside", left: clamp(Math.max(a.left, 0) + 16, m, vw - m - b.w), top: clamp(Math.min(a.bottom, vh) - b.h - 16, m, vh - m - b.h), arrow: 0 };
}
