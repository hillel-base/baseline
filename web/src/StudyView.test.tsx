import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { OUT_OF_DATE_NOTE, type MeasurementFields, type ScanFields } from "./study";
import { RemoveMenu, StudyTable, StudyView, forgetStudy, historyRows, preloadStudy, recordLines, removeLine, type Data } from "./StudyView";

const lists = vi.hoisted(() => { const l = { scans: [] as unknown[], ms: [] as unknown[], answer: (k: "scans" | "ms"): Promise<unknown> => Promise.resolve(l[k]) }; return l; });
vi.mock("./base44", async (real) => ({ ...(await real<object>()), entities: { Scan: { list: () => lists.answer("scans") }, NoduleMeasurement: { list: () => lists.answer("ms") } } })); // the two lists the Study table reads; nothing reaches Base44

type S = ScanFields & { id: string };
type M = MeasurementFields & { id: string };
const local = (day: number, h: number, min: number) => new Date(2026, 9, day, h, min).toISOString(); // the page shows local time
const sc = (id: string, study_code: string, timepoint: number): S => ({ id, study_code, timepoint, scan_ref: `ref-${id}` } as S);
const m = (id: string, scan_id: string, nodule_label: string, more: Partial<M> = {}): M =>
  ({ id, scan_id, nodule_label, long_axis_mm: 22.1, short_axis_mm: 12.4, volume_ml: 6.9, method: "tool approved", approved_at: local(27, 14, 0), practice: false, ...more } as M);
const html = (data: Data) => renderToString(<StudyTable data={data} onRemove={async () => ({ saved: true, outOfDate: false })} onChanged={() => {}} onGoToMeasure={() => {}} />);
const decode = (s: string) => s.replace(/<!-- -->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const text = (h: string) => decode(h.replace(/<[^>]*>/g, ""));
/** Each table row as its cells' text. */
const rows = (h: string) => [...h.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map(([, r]) => [...r.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map(([, c]) => text(c).trim()));

const lab: Data = {
  scans: [sc("b0", "P-3K9Q", 0), sc("b1", "P-3K9Q", 1), sc("c0", "P-7XM2", 0), sc("r0", "RIDER-1286684383", 0)],
  ms: [m("1", "b0", "N1"), m("2", "b1", "N1", { long_axis_mm: 23, method: "tool edited" }), m("3", "b0", "N2", { long_axis_mm: 9.4, short_axis_mm: 7.8, volume_ml: 0.31 }),
    m("4", "c0", "N1", { long_axis_mm: 31.5, volume_ml: 11.82 }), m("5", "r0", "N1", { practice: true })],
  waiting: [],
};

test("one row per nodule, the timepoints as column groups side by side (Long, Short, Volume, Method), units in the headers, — for a missing timepoint", () => {
  const r = rows(html(lab));
  expect(r[0]).toEqual(["Patient", "Nodule", "Baseline", "Follow-up", "Actions"]);
  expect(r[1]).toEqual(["Long mm", "Short mm", "Volume mL", "Method", "Long mm", "Short mm", "Volume mL", "Method"]);
  expect(r.slice(2)).toEqual([
    ["P-3K9Q", "N1", "22.1", "12.4", "6.90", "Approved", "23.0", "12.4", "6.90", "Edited", "⋯"],
    ["P-3K9Q", "N2", "9.4", "7.8", "0.31", "Approved", "—", "—", "—", "—", "⋯"],
    ["P-7XM2", "N1", "31.5", "12.4", "11.82", "Approved", "—", "—", "—", "—", "⋯"],
  ]);
  expect(html(lab)).toContain('title="More"');
  // a third timepoint adds a third group
  const three = html({ ...lab, scans: [...lab.scans, sc("b2", "P-3K9Q", 2)], ms: [...lab.ms, m("6", "b2", "N1")] });
  expect(rows(three)[0]).toEqual(["Patient", "Nodule", "Baseline", "Follow-up", "Follow-up 2", "Actions"]);
});

test("Method per timepoint: Edited for a correction, a paint stroke or a dragged axis (tool edited), else Approved", () => {
  const cellsOf = (method: M["method"]) => rows(html({ ...lab, ms: [m("1", "b0", "N1"), m("2", "b1", "N1", { method })] }))[2];
  expect([cellsOf("tool edited")[5], cellsOf("tool edited")[9]]).toEqual(["Approved", "Edited"]);
  expect([cellsOf("tool approved")[5], cellsOf("tool approved")[9]]).toEqual(["Approved", "Approved"]);
  expect(html(lab)).toMatch(/class="m-state warn">Edited</);
  expect(html(lab)).toMatch(/class="m-state ok">Approved</);
});

test("the footer counts nodules, patients and hidden practice rows; the practice part goes when none is hidden", () => {
  expect(text(html(lab))).toContain('3 nodules on 2 patients · 1 practice row hidden · "Edited" means a correction, a paint stroke or a dragged axis');
  const noPractice = { ...lab, ms: lab.ms.slice(0, 1) };
  expect(text(html(noPractice))).toContain('1 nodule on 1 patient · "Edited" means a correction, a paint stroke or a dragged axis');
});

test("the first row of each patient has the stronger line, and a repeated patient code is muted", () => {
  const trs = [...html(lab).matchAll(/<tr([^>]*)><td[^>]*>(<span[^>]*>)?/g)].map(([, tr, span]) => [tr.includes("st-first"), !!span?.includes("muted")]);
  expect(trs).toEqual([[true, false], [false, true], [true, false]]);
});

test("practice rows: all practice shows them by default, with the banner and the Practice chip; with study rows they are hidden by default", () => {
  const all: Data = { scans: lab.scans, ms: [m("5", "r0", "N1", { practice: true })], waiting: [] };
  const h = html(all);
  expect(h).toMatch(/role="switch" aria-checked="true"/);
  expect(text(h)).toContain("Practice rows These come from public practice scans and are kept apart from the study record.");
  expect(h).toContain("<b>Practice rows</b>");
  expect(rows(h)[2].slice(0, 2)).toEqual(["RIDER-1286684383Practice", "N1"]);
  expect(text(h)).not.toContain("hidden");
  const mixed = html(lab);
  expect(mixed).toMatch(/role="switch" aria-checked="false"/);
  expect(text(mixed)).not.toContain("These come from public practice scans");
  expect(text(mixed)).not.toContain("RIDER-1286684383");
  // a waiting practice Record counts as a practice row too: the first Record of a user still shows if its save waits
  const firstWaits = html({ scans: [], ms: [], waiting: [{ key: "k", scan: { study_code: "RIDER-1286684383", timepoint: 0 } as ScanFields, measurement: { ...m("x", "", "N1"), practice: true } }] });
  expect(firstWaits).toMatch(/role="switch" aria-checked="true"/);
});

test("a Record still waiting in this browser is its own line, Not saved yet (amber) in its timepoint's Method, and no ⋯", () => {
  const h = html({ ...lab, waiting: [{ key: "k", scan: { study_code: "P-7XM2", timepoint: 1 } as ScanFields, measurement: m("x", "", "N2", { long_axis_mm: 8.8 }) }] });
  expect(rows(h).find((r) => r[1] === "N2" && r[0] === "P-7XM2")).toEqual(["P-7XM2", "N2", "—", "—", "—", "—", "8.8", "12.4", "6.90", "Not saved yet", ""]);
  expect(h).toMatch(/class="m-state warn">Not saved yet</);
});

const menu = (timepoints: number[]) => renderToString(<RemoveMenu title="Remove N1 of P-3K9Q" timepoints={timepoints} anchor={undefined as never} onClose={() => {}} onRemove={async () => undefined} />);
const removeButton = (h: string) => h.match(/<button[^>]*>Remove<\/button>/)![0];
test("the Remove menu: with one timepoint, the reason only, none chosen, and Remove disabled until one is", () => {
  const h = menu([0]);
  expect(text(h)).toContain("Remove N1 of P-3K9QIt leaves the record; the history keeps it, with the reason.");
  expect(text(h)).toMatch(/Wrong nodule\s*Wrong scan\s*Duplicate\s*Recorded by mistake/);
  expect(text(h)).not.toMatch(/Baseline|Both/);
  expect(h).not.toMatch(/checked/); // no default reason
  expect(removeButton(h)).toContain("disabled");
});
test("the Remove menu: with two timepoints, Baseline / Follow-up / Both and the reason, none chosen, and Remove disabled until both are", () => {
  const h = menu([0, 1]);
  expect(text(h)).toMatch(/Baseline\s*Follow-up\s*Both/);
  expect(h).not.toMatch(/checked/);
  expect(removeButton(h)).toContain("disabled");
  expect(text(menu([0, 1, 2]))).toMatch(/Baseline\s*Follow-up\s*Follow-up 2\s*All/); // more than two: All
});

test("Remove of both timepoints stores both removals at once, not one after the other's save; what it says after", async () => {
  const calls: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const slowFirst = async (_ref: string, x: M) => { calls.push(x.id); if (calls.length === 1) await gate; return { saved: x.id !== "2", outOfDate: false }; };
  const line = recordLines(lab, false).lines[0]; // P-3K9Q N1: Baseline row 1, Follow-up row 2
  const said = removeLine(line, "duplicate", [0, 1], lab, slowFirst);
  expect(calls).toEqual(["1", "2"]); // both stored while the first save is still open: a reload now loses neither
  open();
  expect(await said).toBe("Removal not saved yet; trying again every 15 s."); // one of the two saved
  expect(await removeLine(line, "duplicate", [0, 1], lab, async () => ({ saved: true, outOfDate: false }))).toBe("Removal saved.");
  expect(await removeLine(line, "duplicate", [1], lab, async () => ({ saved: false, outOfDate: true }))).toBe(`Removal not saved. ${OUT_OF_DATE_NOTE}`);
});

test("History: every saved row newest first, with its status: Current, Replaced at HH:MM (on D Mon from another day), Removed: the reason; removal rows are not lines", () => {
  const data: Data = {
    scans: lab.scans,
    ms: [
      m("a", "b1", "N2", { approved_at: local(27, 14, 2) }),
      m("b", "b1", "N2", { approved_at: local(27, 14, 6), replaces_id: "a" }),
      m("c", "b1", "N3", { approved_at: local(27, 13, 58) }),
      m("r", "b1", "N3", { approved_at: local(27, 14, 10), replaces_id: "c", removed_reason: "recorded by mistake" }),
      m("d", "b0", "N1", { approved_at: local(26, 16, 40) }),
      m("e", "b0", "N1", { approved_at: local(28, 9, 5), replaces_id: "d" }),
    ],
    waiting: [],
  };
  expect(historyRows(data, false).map((h) => [h.id, h.recorded, h.status.text, h.status.tone])).toEqual([
    ["e", "28 Oct 09:05", "Current", "ok"],
    ["b", "27 Oct 14:06", "Current", "ok"],
    ["a", "27 Oct 14:02", "Replaced at 14:06", undefined],
    ["c", "27 Oct 13:58", "Removed: recorded by mistake", "danger"],
    ["d", "26 Oct 16:40", "Replaced at 09:05 on 28 Oct", undefined],
  ]);
});

test("History reads a Base44 time with no zone as UTC: its order, its Recorded time and its Replaced at time", () => {
  vi.stubEnv("TZ", "Asia/Jerusalem"); // a zone away from UTC, where reading such a time as local time shows
  try {
    const p2 = (n: number) => String(n).padStart(2, "0"), hm = (h: number, min: number) => { const d = new Date(Date.UTC(2026, 9, 27, h, min)); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
    const data: Data = { scans: lab.scans, waiting: [], ms: [
      m("old", "b0", "N1", { approved_at: "2026-10-27T11:30:00.000Z" }),
      m("new", "b0", "N2", { approved_at: "2026-10-27T12:00:00" }), // 12:00 UTC, as Base44 may give a time back
      m("a", "b1", "N3", { approved_at: "2026-10-27T10:00:00.000Z" }),
      m("b", "b1", "N3", { approved_at: "2026-10-27T11:00:00", replaces_id: "a" }), // two corrections of one row (two tabs): the earlier one is named
      m("c", "b1", "N3", { approved_at: "2026-10-27T10:30:00.000Z", replaces_id: "a" }),
      m("d", "b1", "N4", { approved_at: "2026-10-27T09:00:00.000Z" }),
      m("e", "b1", "N4", { approved_at: "2026-10-27T09:30:00", replaces_id: "d" }),
    ] };
    expect(historyRows(data, false).map((h) => [h.id, h.recorded, h.status.text])).toEqual([
      ["new", `27 Oct ${hm(12, 0)}`, "Current"], ["old", `27 Oct ${hm(11, 30)}`, "Current"], ["b", `27 Oct ${hm(11, 0)}`, "Current"],
      ["c", `27 Oct ${hm(10, 30)}`, "Current"], ["a", `27 Oct ${hm(10, 0)}`, `Replaced at ${hm(10, 30)}`],
      ["e", `27 Oct ${hm(9, 30)}`, "Current"], ["d", `27 Oct ${hm(9, 0)}`, `Replaced at ${hm(9, 30)}`],
    ]);
    expect(hm(12, 0)).toBe("14:00"); // the zone took effect
  } finally { vi.unstubAllEnvs(); }
});

test("no rows at all: the empty state, with Go to Measure, and no controls", () => {
  const h = html({ scans: [], ms: [], waiting: [] });
  expect(text(h)).toContain("No measurements yetRecord a nodule on the Measure screen, and it appears here.Go to Measure");
  expect(h).toMatch(/<button[^>]*>Go to Measure<\/button>/);
  expect(text(h)).not.toContain("Download CSV");
  expect(h).not.toContain("<table");
  expect(text(h)).toContain("Every Record saved on Base44. Numbers only: names and dates stay on your computer.");
});

const view = (waiting: Data["waiting"] = []) => renderToString(<StudyView onRemove={async () => ({ saved: true, outOfDate: false })} waiting={() => waiting} pending={() => 0} onGoToMeasure={() => {}} />);
test("(b) before the lists come: the table's own title row, tools (off) and column header, three placeholder rows, and Loading the study table… for a screen reader", () => {
  const h = view();
  expect(h).toContain('<p class="sr-only" role="status">Loading the study table…</p>');
  expect(h).toContain("<h2>Study table</h2>");
  expect(text(h)).toContain("Every Record saved on Base44. Numbers only: names and dates stay on your computer.");
  const skel = h.match(/<table class="st-table st-skel" aria-hidden="true">.*?<\/table>/)![0];
  expect(rows(skel).slice(0, 2)).toEqual([["Patient", "Nodule", "Baseline", "Follow-up", "Actions"], ["Long mm", "Short mm", "Volume mL", "Method", "Long mm", "Short mm", "Volume mL", "Method"]]); // as the loaded table heads them
  expect(rows(skel).slice(2)).toHaveLength(3);
  expect(h.match(/<button[^>]*disabled=""[^>]*>(Record|History|Download CSV)<\/button>|role="switch"[^>]*disabled=""/g)).toHaveLength(4); // there, so nothing moves, but off
  expect(text(h)).not.toContain("No measurements yet");
});
test("(b) preloadStudy: the lists the signed-in page loaded are the tab's first rows, with this browser's Records still waiting (the e2e checks that the tab loads them again)", async () => {
  lists.scans = [sc("b0", "P-3K9Q", 0)]; lists.ms = [m("1", "b0", "N1")];
  preloadStudy(() => []);
  await new Promise((ok) => setTimeout(ok, 0));
  const waits = [{ key: "k", scan: { study_code: "P-7XM2", timepoint: 0 } as ScanFields, measurement: m("x", "", "N2") }]; // recorded after the preload
  const h = view(waits);
  expect(h).not.toContain("Loading the study table…");
  expect(rows(h).slice(2).map((r) => r.slice(0, 2))).toEqual([["P-3K9Q", "N1"], ["P-7XM2", "N2"]]);
  expect(rows(h)[3]).toContain("Not saved yet");
  preloadStudy(() => []); // after a save: the old copy is not shown while the new one loads
  expect(view()).toContain("Loading the study table…");
});

test("(b) forgetStudy, at the moment of an Undo: the early copy is dropped at once, so an undone Record never shows while the next load is on its way", async () => {
  lists.scans = [sc("b0", "P-3K9Q", 0)]; lists.ms = [m("1", "b0", "N1")];
  preloadStudy(() => []);
  await new Promise((ok) => setTimeout(ok, 0));
  expect(text(view())).toContain("N1");
  forgetStudy();
  expect(view()).toContain("Loading the study table…");
});

test("(b) an answer asked before the last preloadStudy never becomes the tab's first copy: a Record, then Undo at once, in either order of the answers", async () => {
  const tick = () => new Promise((ok) => setTimeout(ok, 0));
  const before = lists.answer;
  try {
    for (const olderLast of [true, false]) {
      const held: ((v: unknown) => void)[] = [];
      lists.answer = () => new Promise((ok) => held.push(ok));
      preloadStudy(() => []); // the Record's save is reported: R1 stands in this answer
      preloadStudy(() => []); // Undo at once: R1 is taken back in this one
      const [olderScans, olderMs, newerScans, newerMs] = held;
      const older = async () => { olderScans([sc("b0", "P-3K9Q", 0)]); olderMs([m("1", "b0", "N1")]); await tick(); };
      const newer = async () => { newerScans([sc("b0", "P-3K9Q", 0)]); newerMs([]); await tick(); };
      if (olderLast) { await newer(); await older(); } else { await older(); expect(view()).toContain("Loading the study table…"); await newer(); } // never the undone Record
      expect(text(view())).toContain("No measurements yet");
      expect(text(view())).not.toContain("N1");
    }
  } finally { lists.answer = before; }
});
