import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import type { Patient, Patients } from "./api";
import { PatientsPanel, Sheet } from "./PatientsPanel";
import type { RecordedNodule } from "./record";

const text = (html: string) => html.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&"); // what the page reads
const scan = (id: string, timepoint: "Baseline" | "Follow-up", date: string | null, day: number, label = "Series 3 · 1.25 mm") => ({ id, timepoint, date, day, label, slice_mm: 1.25, images: 300 });
const jane: Patient = { key: "a1", name: "Doe, Jane", source: "study", scans: [scan("F-00000001", "Baseline", "2025-09-12", 0), scan("F-00000002", "Follow-up", "2025-12-10", 89, "Series 4 · 1 mm")] };
const sam: Patient = { key: "b2", name: "Okafor, Sam", source: "study", scans: [scan("F-00000004", "Baseline", "2026-01-02", 0)] };
const lab = (folder: Partial<Patients["folder"]> = {}): Patients => ({ folder: { path: "Scans/Lung growth study", from: "panel", error: null, ...folder }, patients: [sam, jane] });
const practiceData: Patients = { folder: { path: null, from: null, error: null }, patients: [1, 2, 3].map((n) => ({ key: `RIDER-${n}`, name: `Practice patient ${n}`, source: "data" as const,
  scans: [scan(`RIDER-${n}_test`, "Baseline", null, 0, "Test scan"), scan(`RIDER-${n}_retest`, "Follow-up", null, 0, "Retest scan")] })) };
const recorded = [{ patient: "F-00000001", series: "ct", nodule: 1, recorded_at: "2026-10-27T09:00:00.000Z", outline_file: "outlines/F-00000001_n1.nii.gz" } as RecordedNodule];
const none = { onOpen() {}, onChangeFolder() {} };

test("the sheet on the engine's own page: search, Patients · N with each patient's line and count, the open patient's timeline, the footer with the folder and the privacy line", () => {
  const t = text(renderToString(<Sheet data={lab()} current="F-00000002" rows={recorded} practice={false} busy={false} {...none} />));
  expect(renderToString(<Sheet data={lab()} current="F-00000002" rows={recorded} practice={false} busy={false} {...none} />)).toContain('<span class="pp-nw"> · open now</span>'); // "open now" never splits
  expect(t).toContain("Patients · 2");
  expect(renderToString(<Sheet data={lab()} current="F-00000002" rows={recorded} practice={false} busy={false} {...none} />)).toContain('placeholder="Search patients"');
  expect(t).toContain("Doe, Jane2 scans · last 10 Dec 20251 nodule"); // newest activity first: Jane has today's Record
  expect(t).toContain("Okafor, Sam1 scan · 2 Jan 2026not measured yet");
  expect(t.indexOf("Doe, Jane")).toBeLessThan(t.indexOf("Okafor, Sam"));
  expect(t).toContain("Doe, Jane2 scans, oldest first"); // the right column: the open scan's patient
  expect(t).toContain("Baseline · 12 Sep 2025Series 3 · 1.25 mm1 nodule recordedOpen");
  expect(t).toContain("Follow-up · 10 Dec 2025 · day 89Series 4 · 1 mm · open nownot measured yetOpen");
  expect(t).toContain("Folder: /Scans/Lung growth study");
  expect(t).toContain("Change folder…");
  expect(t).toContain("Names and dates are shown by your computer; Base44 receives only codes.");
  expect(t).not.toContain("practice");
});

test("the open scan's Open is the primary one; Open is off while the engine works", () => {
  const html = renderToString(<Sheet data={lab()} current="F-00000002" rows={[]} practice={false} busy={false} {...none} />);
  expect(html).toMatch(/<button class="m-btn sm primary"[^>]*aria-label="Open Follow-up · 10 Dec 2025 · day 89"/);
  expect(html).toMatch(/<button class="m-btn sm"[^>]*aria-label="Open Baseline · 12 Sep 2025"/);
  expect(renderToString(<Sheet data={lab()} current="F-00000002" rows={[]} practice={false} busy {...none} />).match(/disabled=""/g)).toHaveLength(2); // Jane's two Open buttons
});

test("LUNG_STUDY_DIR: the footer says so and offers no Change; a folder error shows in amber with Change folder… still offered", () => {
  const env = text(renderToString(<Sheet data={lab({ from: "LUNG_STUDY_DIR" })} current="" rows={[]} practice={false} busy={false} {...none} />));
  expect(env).toContain("Set by LUNG_STUDY_DIR on this computer.");
  expect(env).not.toContain("Change folder…");
  const err = renderToString(<Sheet data={lab({ error: "The study folder cannot be found. Choose it again with Change folder…" })} current="" rows={[]} practice={false} busy={false} {...none} />);
  expect(err).toMatch(/class="pp-error" role="alert">The study folder cannot be found. Choose it again with Change folder…</);
  expect(err).toMatch(/<button[^>]*>Change folder…<\/button>/);
  expect(text(renderToString(<Sheet data={lab({ path: null, from: null })} current="" rows={[]} practice={false} busy={false} {...none} />))).toContain("No study folder chosen yet.Change folder…");
});

test("with no scan open, the right column shows the first patient; an empty list says so", () => {
  expect(text(renderToString(<Sheet data={lab()} current="" rows={[]} practice={false} busy={false} {...none} />))).toContain("Okafor, Sam1 scan");
  expect(text(renderToString(<Sheet data={{ ...lab(), patients: [] }} current="" rows={[]} practice={false} busy={false} {...none} />))).toContain("No patients yet.");
});

test("the practice server's sheet: no search, the practice texts, no folder and no names line", () => {
  const t = text(renderToString(<Sheet data={practiceData} current="RIDER-1_test" rows={[]} practice busy={false} {...none} />));
  expect(t).toContain("Practice patients · public scans");
  expect(t).toContain("Practice patient 2Baseline and follow-upPractice patient 3"); // no count before a Record
  expect(t).toContain("Practice patient 1RIDER Lung CT, TCIA");
  expect(t).toContain("Baselineopen nownot measured yetOpen");
  expect(t).toContain("Follow-up · same daya repeat scan, for measuring twicenot measured yetOpen");
  expect(t).toContain("Public practice scans only; no folders on a practice server.");
  for (const no of ["Search patients", "Folder:", "Change folder…", "Names and dates", "Test scan"]) expect(t).not.toContain(no);
  expect(renderToString(<Sheet data={practiceData} current="RIDER-1_test" rows={[]} practice busy={false} {...none} />)).not.toContain("<input");
});

test("the button says where you are, with the patient's other scans beside it; it waits while the engine reads the folder", () => {
  const props = { rows: [], busy: false, onOpen() {}, onChosen() {} };
  const follow = renderToString(<PatientsPanel data={lab()} current="F-00000002" practice={false} {...props} />);
  expect(text(follow)).toContain("Doe, Jane · Follow-up · 10 Dec 2025 · day 89");
  expect(follow).toMatch(/<button class="m-btn sm ghost pp-step" data-key="prev" aria-keyshortcuts="Alt\+ArrowLeft" title="Alt\+←">‹ Baseline</);
  expect(follow).toMatch(/title="Doe, Jane · Follow-up · 10 Dec 2025 · day 89"/); // the whole label, when the button cuts a long name
  expect(follow).toContain('<span class="pp-steps">'); // the steps sit in a box with room for both (measure.css), so one coming or going never wraps the bar
  expect(follow).not.toContain('data-key="next"');
  const base = renderToString(<PatientsPanel data={lab()} current="F-00000001" practice={false} {...props} />);
  expect(base).toMatch(/<span class="pp-steps"><button[^>]*data-key="next"[^>]*>Follow-up ›</); // right beside the button
  expect(base).not.toContain('data-key="prev"');
  expect(text(renderToString(<PatientsPanel data={practiceData} current="RIDER-1_test" practice {...props} />))).toContain("Practice patient 1 · Baseline");
  expect(text(renderToString(<PatientsPanel data={lab()} current="" practice={false} {...props} />))).toContain("Choose a scan");
  expect(text(renderToString(<PatientsPanel data={lab()} current="F-0000000f" practice={false} {...props} />))).toContain("F-0000000f"); // a scan from outside the study folder (POST /api/folders/open): its code
  const reading = renderToString(<PatientsPanel current="" practice={false} {...props} />);
  expect(text(reading)).toContain("Reading the folder…");
  expect(reading).toMatch(/<button class="pp-btn"[^>]*disabled=""/);
  expect(text(renderToString(<PatientsPanel current="" practice {...props} />))).toContain("Loading scans…");
});
