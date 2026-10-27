import { afterEach, expect, test, vi } from "vitest";
import { COLUMNS, backUpRows, captionLines, forgetCleared, loadCleared, loadRecorded, nextNodule, reloadFor, restoreCleared, saveRecorded, toCSV, toRow, toTSV, rememberScanId, scanIdOf, type RecordedNodule } from "./record";
import type { Outline, ScanMeta } from "./api";

const row: RecordedNodule = {
  patient: "RIDER-1286684383", series: "test", series_number: 3, study_date: "2001-02-03", nodule: 1, slice: 142, slice_label: "image", long_mm: 12.3, short_mm: 8.1, width: "edge to edge",
  volume_ml: 0.61, depth_mm: 10, clicks: 3, corrections: 2, seconds_to_record: 41, recorded_at: "2026-10-25T09:00:00.000Z",
  long_y1: 300.1, long_x1: 310.2, long_y2: 305.3, long_x2: 320.5, short_y1: 1.6, short_x1: 2.7, short_y2: 3.8, short_x2: 4.9,
  click_image: 104, click_y: 321, click_x: 330, at_window_edge: false, slice_thickness_mm: 1.25, slice_spacing_mm: 1.25, painted: 0, axes_edited: false, follows: "",
  outline_file: "outlines/RIDER-1286684383_test_n1_accepted.nii.gz",
};
afterEach(() => vi.unstubAllGlobals());

test("TSV row keeps column order and units", () => {
  expect(toTSV(row)).toMatch(/^RIDER-1286684383\ttest\t3\t2001-02-03\t1\t142\timage\t12\.3\t8\.1\tedge to edge\t0\.61\t10\.0\t3\t2\t41\.0\t2026-10-25T09:00:00\.000Z(\t\d+\.\d){8}\t104\t321\t330\tfalse\t1\.250\t1\.250\t0\tfalse\t\toutlines\/RIDER-1286684383_test_n1_accepted\.nii\.gz$/);
});
test("frozen path: a missing field still prints as before the study table (null empty, undefined as text)", () => {
  expect(toTSV({ ...row, follows: undefined as never }).split("\t").at(-2)).toBe("undefined");
  expect(toCSV([{ ...row, depth_mm: null }]).split("\n")[1].split(",")[11]).toBe("");
});
test("CSV quotes only what needs quoting", () => {
  const lines = toCSV([row, { ...row, series: 'te,"st' }]).split("\n");
  expect(lines[0].startsWith("patient,series,series_number,study_date,nodule,slice,slice_label,long_mm")).toBe(true);
  expect(lines[0]).toBe("patient,series,series_number,study_date,nodule,slice,slice_label,long_mm,short_mm,width,volume_ml,depth_mm,clicks,corrections,seconds_to_record,recorded_at,long_y1,long_x1,long_y2,long_x2,short_y1,short_x1,short_y2,short_x2,click_image,click_y,click_x,at_window_edge,slice_thickness_mm,slice_spacing_mm,painted,axes_edited,follows,outline_file");
  expect(lines[1].startsWith("RIDER-1286684383,test,3,2001-02-03,1,142,image,12.3,8.1,edge to edge,")).toBe(true);
  expect(lines[2].startsWith('RIDER-1286684383,"te,""st",3,')).toBe(true);
});
test("TSV end points keep their own order", () => {
  expect(toTSV(row).split("\t").slice(16, 24)).toEqual(["300.1", "310.2", "305.3", "320.5", "1.6", "2.7", "3.8", "4.9"]);
});
test("storage failures give an empty list, not a crash", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); } });
  expect(loadRecorded()).toEqual([]);
  vi.stubGlobal("localStorage", { getItem: () => "not json" });
  expect(loadRecorded()).toEqual([]);
});
test("a stored list keeps only well-formed rows", () => {
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify([row, null, {}, { ...row, long_mm: "12" }]) });
  expect(loadRecorded()).toEqual([row]);
});
test("the next nodule number is per scan and never reused", () => {
  const rows = [row, { ...row, nodule: 2 }, { ...row, series: "retest" }];
  expect(nextNodule(rows, {}, "RIDER-1286684383", "test")).toBe(3);
  expect(nextNodule(rows, {}, "RIDER-1286684383", "retest")).toBe(2);
  expect(nextNodule([], {}, "p", "s")).toBe(1);
  expect(nextNodule([row], { "RIDER-1286684383/test": 2 }, "RIDER-1286684383", "test")).toBe(3); // row 2 was deleted
  expect(nextNodule([], { "RIDER-1286684383/test": 1 }, "RIDER-1286684383", "test")).toBe(2); // table cleared, counter kept
});
const outline = { axis_z: 4, long_mm: 12.34, short_mm: 8.1, volume_ml: 0.61, width_method: "edge to edge", clicks: [{ z: 3, y: 321, x: 330 }, {}, {}],
  long_line: [[10.04, 20.06], [30, 40]], short_line: [[1, 2], [3, 4]], depth_mm: 10.04, at_window_edge: true } as unknown as Outline;
const meta = (inst: number[] | null) => ({ patient: "P", series: "s", series_number: 7, study_date: "2001-02-03", slice_thickness_mm: 1.25, spacing: [0.7, 0.7, 1.5], instance_numbers: inst }) as ScanMeta;
test("toRow maps [y, x] pairs, image numbers and the slice-index case", () => {
  const r = toRow(meta([9, 8, 7, 6, 5]), outline, 2, 41.04, "f.nii.gz", new Date("2026-10-25T09:00:00Z"));
  expect(r).toMatchObject({ slice: 5, slice_label: "image", long_y1: 10, long_x1: 20.1, long_y2: 30, long_x2: 40, short_y1: 1, short_x1: 2, short_y2: 3, short_x2: 4,
    nodule: 2, clicks: 3, corrections: 2, series_number: 7, study_date: "2001-02-03", slice_thickness_mm: 1.25, slice_spacing_mm: 1.5, seconds_to_record: 41, recorded_at: "2026-10-25T09:00:00.000Z", follows: "", outline_file: "f.nii.gz" });
  expect(r).toMatchObject({ depth_mm: 10.04, click_image: 6, click_y: 321, click_x: 330, at_window_edge: true, painted: 0, axes_edited: false }); // an engine without strokes: 0 and false
  expect(toRow(meta(null), { ...outline, painted: 2, axes_edited: true }, 1, 1, "f")).toMatchObject({ painted: 2, axes_edited: true });
  expect(toRow(meta(null), outline, 1, 1, "f").click_image).toBe(4); // z + 1
  expect(toRow(meta(null), outline, 1, 1, "f").slice).toBe(5);
  expect(toRow(meta(null), outline, 1, 1, "f").slice_label).toBe("slice index");
});
test("the caption holds every required field", () => {
  const text = captionLines(row).join("\n");
  for (const part of ["RIDER-1286684383", "test", "Image 142", "nodule 1", "Long 12.3 mm", "Short 8.1 mm", "Volume 0.61 mL", "edge to edge", "Research use only"]) expect(text).toContain(part);
  expect(captionLines({ ...row, slice_label: "slice index" }).join("")).toContain("Slice index 142");
  expect(captionLines(row)).toEqual(["RIDER-1286684383 test · nodule 1 · Image 142", "Long 12.3 mm · Short 8.1 mm · Volume 0.61 mL", "Width: edge to edge · Research use only"]);
});

const fakeStorage = (failSet = false) => {
  const m = new Map<string, string>();
  const setItem = vi.fn((k: string, v: string) => { if (failSet) throw new Error("full"); m.set(k, v); });
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem });
  return { m, setItem };
};
const v4 = (({ painted, axes_edited, ...old }) => old)(row);
const v3 = (({ follows, ...old }) => old)(v4);
const v2 = (({ series_number, study_date, corrections, slice_thickness_mm, slice_spacing_mm, ...old }) => old)(v3);
const v1 = (({ depth_mm, click_image, click_y, click_x, at_window_edge, ...old }) => old)(v2);
const none = { series_number: null, study_date: null, corrections: null, slice_thickness_mm: null, slice_spacing_mm: null, painted: 0, axes_edited: false, follows: "" };
test("v4 rows migrate to v5 with painted 0 and axes_edited false, losing nothing, and v4 stays", () => {
  const { m } = fakeStorage();
  const linked = { ...v4, nodule: 2, follows: "outlines/a.nii.gz", outline_file: "outlines/b.nii.gz" };
  m.set("lung.recorded.v4", JSON.stringify([v4, linked]));
  const rows = loadRecorded();
  expect(rows).toEqual([{ ...v4, painted: 0, axes_edited: false }, { ...linked, painted: 0, axes_edited: false }]);
  expect(JSON.parse(m.get("lung.recorded.v5")!)).toEqual(rows);
  expect(JSON.parse(m.get("lung.recorded.v4")!)).toEqual([v4, linked]);
  expect(toTSV(rows[1]).split("\t").slice(-4)).toEqual(["0", "false", "outlines/a.nii.gz", "outlines/b.nii.gz"]);
});
test("v3 rows migrate to v5 with an empty follows, losing nothing, and v3 stays", () => {
  const { m } = fakeStorage();
  const linked = { ...v3, nodule: 2, outline_file: "outlines/b.nii.gz" };
  m.set("lung.recorded.v3", JSON.stringify([v3, linked]));
  const rows = loadRecorded();
  expect(rows).toEqual([{ ...v3, painted: 0, axes_edited: false, follows: "" }, { ...linked, painted: 0, axes_edited: false, follows: "" }]);
  expect(JSON.parse(m.get("lung.recorded.v5")!)).toEqual(rows);
  expect(JSON.parse(m.get("lung.recorded.v3")!)).toEqual([v3, linked]);
  expect(toTSV(rows[0]).split("\t").slice(-2)).toEqual(["", v3.outline_file]);
});
test("painted and axes_edited sit just before follows; a stored row with either of the wrong type is dropped", () => {
  expect(COLUMNS.slice(-4)).toEqual(["painted", "axes_edited", "follows", "outline_file"]);
  expect(toTSV({ ...row, painted: 2, axes_edited: true }).split("\t").slice(-4, -2)).toEqual(["2", "true"]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "lung.recorded.v5" ? JSON.stringify([row, { ...row, painted: "2" }, { ...row, painted: null }, { ...row, axes_edited: 1 }, { ...row, axes_edited: null }]) : null) });
  expect(loadRecorded()).toEqual([row]);
});
test("follows sits just before outline_file, and a matched row exports it", () => {
  expect(COLUMNS.slice(-2)).toEqual(["follows", "outline_file"]);
  const f = "outlines/RIDER-1286684383_test_n1_accepted.nii.gz";
  const cells = toTSV({ ...row, series: "retest", follows: f, outline_file: "outlines/r.nii.gz" }).split("\t");
  expect(cells.slice(-2)).toEqual([f, "outlines/r.nii.gz"]);
  expect(toCSV([{ ...row, follows: f }]).split("\n")[1].split(",").slice(-2)).toEqual([f, row.outline_file]);
});
test("a stored row whose follows is not text is dropped", () => {
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "lung.recorded.v5" ? JSON.stringify([row, { ...row, follows: null }, { ...row, follows: 3 }]) : null) });
  expect(loadRecorded()).toEqual([row]);
});
test("v2 rows migrate to v5 with empty new fields, and v2 stays", () => {
  const { m } = fakeStorage();
  m.set("lung.recorded.v2", JSON.stringify([v2, { ...v2, nodule: 2 }]));
  const rows = loadRecorded();
  expect(rows).toEqual([{ ...v2, ...none }, { ...v2, nodule: 2, ...none }]);
  expect(JSON.parse(m.get("lung.recorded.v5")!)).toEqual(rows);
  expect(JSON.parse(m.get("lung.recorded.v2")!)).toEqual([v2, { ...v2, nodule: 2 }]);
  const cells = toTSV(rows[0]).split("\t");
  expect(cells.slice(2, 4)).toEqual(["", ""]); expect(cells[13]).toBe(""); expect(cells.slice(-6)).toEqual(["", "", "0", "false", "", v2.outline_file]);
});
test("v1 rows migrate to v5 with empty new fields, and v1 stays", () => {
  const { m } = fakeStorage();
  m.set("lung.recorded.v1", JSON.stringify([v1]));
  const rows = loadRecorded();
  expect(rows).toEqual([{ ...v1, depth_mm: null, click_image: null, click_y: null, click_x: null, at_window_edge: null, ...none }]);
  expect(JSON.parse(m.get("lung.recorded.v5")!)).toEqual(rows);
  expect(JSON.parse(m.get("lung.recorded.v1")!)).toEqual([v1]);
  expect(toTSV(rows[0]).split("\t")[11]).toBe(""); // depth_mm is an empty cell
});
test("older rows in the backup slot are kept, not dropped", () => {
  const { m } = fakeStorage();
  m.set("lung.cleared.v1", JSON.stringify([v2]));
  expect(loadCleared()).toEqual([{ ...v2, ...none }]);
});
test("v5 wins over v4, v3 and v1, and nothing is written when there is nothing to migrate", () => {
  const { m, setItem } = fakeStorage();
  expect(loadRecorded()).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
  m.set("lung.recorded.v1", JSON.stringify([v1]));
  m.set("lung.recorded.v3", JSON.stringify([v3, v3]));
  m.set("lung.recorded.v4", JSON.stringify([v4, v4]));
  m.set("lung.recorded.v5", JSON.stringify([row]));
  expect(loadRecorded()).toEqual([row]);
});
test("loading a table that is already v5 does not write", () => {
  const { m, setItem } = fakeStorage();
  m.set("lung.recorded.v5", JSON.stringify([row]));
  loadRecorded(); loadCleared();
  expect(setItem).not.toHaveBeenCalled();
});
test("clearing adds to the backup slot, and Forget empties it", () => {
  fakeStorage();
  expect(backUpRows([row])).toBe(true);
  const two = { ...row, nodule: 2, outline_file: "outlines/b.nii.gz" };
  expect(backUpRows([two])).toBe(true);
  expect(loadCleared()).toEqual([row, two]);
  expect(forgetCleared()).toBe(true);
  expect(loadCleared()).toEqual([]);
});
test("restore puts every backup before the saved rows, saves them and empties the slot", () => {
  fakeStorage();
  const two = { ...row, nodule: 2, outline_file: "outlines/b.nii.gz" };
  backUpRows([row]); backUpRows([two]);
  const newer = { ...row, nodule: 3, outline_file: "outlines/c.nii.gz" };
  saveRecorded([newer]);
  const expected = [row, two, newer];
  expect(restoreCleared()).toEqual(expected);
  expect(loadRecorded()).toEqual(expected);
  expect(loadCleared()).toEqual([]);
});
test("a failed backup write is reported so the table is left alone", () => {
  fakeStorage(true);
  expect(backUpRows([row])).toBe(false);
});
test("a failed save on restore keeps the backup", () => {
  const { m } = fakeStorage();
  m.set("lung.cleared.v1", JSON.stringify([row]));
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem() { throw new Error("full"); } });
  expect(restoreCleared()).toBeNull();
  expect(loadCleared()).toEqual([row]);
});
test("a storage event for our keys reloads the state; another key does not", () => {
  const { m } = fakeStorage();
  m.set("lung.recorded.v5", JSON.stringify([row, { ...row, nodule: 2 }]));
  m.set("lung.cleared.v1", JSON.stringify([row]));
  expect(reloadFor("lung.recorded.v5")).toEqual({ rows: [row, { ...row, nodule: 2 }], cleared: 1 });
  expect(reloadFor("lung.counters.v1")?.cleared).toBe(1);
  expect(reloadFor("lung.cleared.v1")).not.toBeNull();
  expect(reloadFor(null)).not.toBeNull();
  expect(reloadFor("something.else")).toBeNull();
});

test("a row is never doubled: not in the backup twice, not restored next to itself", () => {
  fakeStorage();
  backUpRows([row]); backUpRows([row]);            // the same clear seen twice
  expect(loadCleared()).toEqual([row]);
  saveRecorded([row]);                              // the clear's empty-table save failed: the row is still saved
  expect(restoreCleared()).toEqual([row]);
});

test("slice spacing and thickness print with 3 decimals, so float noise never reaches the spreadsheet", () => {
  const r = { ...row, slice_spacing_mm: 1.2500000000000002, slice_thickness_mm: 1.25 };
  const cells = toTSV(r).split("\t");
  expect(cells[COLUMNS.indexOf("slice_spacing_mm")]).toBe("1.250");
  expect(cells[COLUMNS.indexOf("slice_thickness_mm")]).toBe("1.250");
});

test("a coded scan keeps its opened id for Find and the row events; a local row falls back to patient_series", () => {
  const coded = { patient: "ab12cd34", series: "test", outline_file: "f1" } as RecordedNodule;
  rememberScanId(coded, "D-0a1b2c3d");
  expect(scanIdOf(coded)).toBe("D-0a1b2c3d");
  expect(scanIdOf({ patient: "RIDER-1", series: "test", outline_file: "f2" } as RecordedNodule)).toBe("RIDER-1_test");
  const folder = { patient: "F-0a1b2c3d", series: "folder", outline_file: "f3" } as RecordedNodule; // an opened folder: the id is the patient alone (scans.py FOLDER_ID)
  expect(scanIdOf(folder)).toBe("F-0a1b2c3d");
});
