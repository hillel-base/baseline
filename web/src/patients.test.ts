import { expect, test } from "vitest";
import type { Patient } from "./api";
import { byActivity, buttonLabel, chip, countText, locate, patientCount, recordedOn, scanTitle, scansLine, search, showDate } from "./patients";
import { rememberScanId, type RecordedNodule } from "./record";

const scan = (id: string, timepoint: "Baseline" | "Follow-up" | "Undated", date: string | null, day: number | null) => ({ id, timepoint, date, day, label: "Series 3 · 1.25 mm", slice_mm: 1.25, images: 300 });
const jane: Patient = { key: "a1", name: "Doe, Jane", source: "study", scans: [scan("F-00000001", "Baseline", "2025-09-12", 0), scan("F-00000002", "Follow-up", "2025-12-10", 89), scan("F-00000003", "Follow-up", "2026-03-14", 182)] };
const sam: Patient = { key: "b2", name: "Okafor, Sam", source: "study", scans: [scan("F-00000004", "Baseline", "2026-01-02", 0), scan("F-00000005", "Follow-up", "2026-03-01", 58)] };
const maria: Patient = { key: "c3", name: "Lopez, Maria", source: "study", scans: [scan("F-00000006", "Baseline", "2026-03-09", 0)] };
const rider: Patient = { key: "RIDER-1286684383", name: "RIDER-1286684383", source: "data", scans: [scan("RIDER-1286684383_test", "Baseline", "2006-01-03", 0), scan("RIDER-1286684383_retest", "Follow-up", "2006-01-03", 0)] };
const practice = (n: number): Patient => ({ key: `RIDER-${n}`, name: `Practice patient ${n}`, source: "data", scans: [scan(`RIDER-${n}_test`, "Baseline", null, 0), scan(`RIDER-${n}_retest`, "Follow-up", null, 0)] });

const row = (patient: string, series: string, nodule: number, recorded_at = "2026-10-27T09:00:00.000Z") =>
  ({ patient, series, nodule, recorded_at, outline_file: `outlines/${patient}_${series}_n${nodule}_${recorded_at}.nii.gz` }) as RecordedNodule;

test("a date reads as 12 Sep 2025, in English whatever the browser's language", () => {
  expect(showDate("2025-09-12")).toBe("12 Sep 2025");
  expect(showDate("2026-03-01")).toBe("1 Mar 2026");
});

test("a scan's title: timepoint, date and the day count from the baseline; a same-day follow-up says so", () => {
  expect(scanTitle(jane.scans[0])).toBe("Baseline · 12 Sep 2025");
  expect(scanTitle(jane.scans[2])).toBe("Follow-up · 14 Mar 2026 · day 182");
  expect(scanTitle(rider.scans[1])).toBe("Follow-up · 3 Jan 2006 · same day");
  expect(scanTitle(practice(1).scans[0])).toBe("Baseline"); // the practice server sends no dates
  expect(scanTitle(practice(1).scans[1])).toBe("Follow-up · same day");
  expect(scanTitle(scan("F-00000009", "Undated", null, null))).toBe("Undated");
  expect(scanTitle(scan("x_retest", "Follow-up", null, null))).toBe("Follow-up"); // a data scan with no date in its header
});

test("the button: Patient · Timepoint · date · day N, or Practice patient 1 · Baseline", () => {
  expect(buttonLabel(jane, jane.scans[2])).toBe("Doe, Jane · Follow-up · 14 Mar 2026 · day 182");
  expect(buttonLabel(practice(1), practice(1).scans[0])).toBe("Practice patient 1 · Baseline");
});

test("the chip and the patient count", () => {
  expect(chip(0)).toBe("not measured yet");
  expect(chip(1)).toBe("1 nodule recorded");
  expect(chip(3)).toBe("3 nodules recorded");
  expect(countText(0, false)).toBe("not measured yet"); // one empty-state wording, as the timeline's chip
  expect(countText(0, true)).toBe(""); // the practice list leaves it blank
  expect(countText(1, false)).toBe("1 nodule");
  expect(countText(2, true)).toBe("2 nodules");
});

test("recorded nodules per scan come from the page's own rows, by the engine's scan id; one nodule recorded twice counts once", () => {
  const rows = [row("RIDER-1286684383", "test", 1), row("RIDER-1286684383", "test", 2), row("RIDER-1286684383", "test", 2, "2026-10-27T10:00:00.000Z"), row("RIDER-1286684383", "retest", 1)];
  expect(recordedOn(rows, "RIDER-1286684383_test")).toBe(2);
  expect(recordedOn(rows, "RIDER-1286684383_retest")).toBe(1);
  expect(recordedOn(rows, "RIDER-2541949645_test")).toBe(0);
  const f = row("F-00000002", "ct", 1); // a study-folder scan: its row's patient is the F- id
  expect(recordedOn([f], "F-00000002")).toBe(1);
  const coded = row("D-1a2b3c4d", "test", 1); // a coded row knows its scan only through rememberScanId
  rememberScanId(coded, "D-99999999");
  expect(recordedOn([coded], "D-99999999")).toBe(1);
  // the left column: the most nodules on any one scan (a follow-up measures the baseline's nodules again)
  expect(patientCount(rider, rows)).toBe(2);
  expect(patientCount(maria, rows)).toBe(0);
});

test("the left column's line: N scans · last <date>; one scan has no 'last'; undated scans add no date", () => {
  expect(scansLine(jane)).toBe("3 scans · last 14 Mar 2026");
  expect(scansLine(maria)).toBe("1 scan · 9 Mar 2026");
  expect(scansLine({ ...maria, scans: [scan("F-00000009", "Undated", null, null)] })).toBe("1 scan");
});

test("search: any part of the name, any case; an empty search lists everyone", () => {
  const all = [jane, sam, maria];
  expect(search(all, "oka")).toEqual([sam]);
  expect(search(all, "  JANE ")).toEqual([jane]);
  expect(search(all, "")).toEqual(all);
  expect(search(all, "nobody")).toEqual([]);
});

test("newest activity first: the last Record on this page, else the newest scan date; then by name, numbers in order", () => {
  expect(byActivity([maria, sam, jane], []).map((p) => p.name)).toEqual(["Doe, Jane", "Lopez, Maria", "Okafor, Sam"]); // 14 Mar, 9 Mar, 1 Mar
  const rows = [row("F-00000004", "ct", 1, "2026-10-27T08:00:00.000Z")];
  expect(byActivity([maria, sam, jane], rows).map((p) => p.name)).toEqual(["Okafor, Sam", "Doe, Jane", "Lopez, Maria"]); // measured today
  expect(byActivity([practice(10), practice(2), practice(1)], []).map((p) => p.name)).toEqual(["Practice patient 1", "Practice patient 2", "Practice patient 10"]);
  expect(byActivity([practice(1), practice(2)], [row("RIDER-2", "retest", 1)]).map((p) => p.name)).toEqual(["Practice patient 2", "Practice patient 1"]);
});

test("the previous and next scan of the same patient", () => {
  const all = [sam, jane];
  expect(locate(all, "F-00000002")).toEqual({ patient: jane, scan: jane.scans[1], prev: jane.scans[0], next: jane.scans[2] });
  expect(locate(all, "F-00000001")).toMatchObject({ prev: undefined, next: jane.scans[1] });
  expect(locate(all, "F-00000005")).toMatchObject({ patient: sam, prev: sam.scans[0], next: undefined });
  expect(locate(all, "F-0000000f")).toBeUndefined(); // an F- scan from outside the study folder (as the engine's POST /api/folders/open gives): not in the panel
  expect(locate(all, "")).toBeUndefined();
});
