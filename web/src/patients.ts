import type { Patient, PatientScan } from "./api";
import { scanIdOf, type RecordedNodule } from "./record";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2025-09-12" as "12 Sep 2025" (by hand: the browser's own format changes with its language). */
export const showDate = (d: string) => { const [y, m, day] = d.split("-").map(Number); return `${day} ${MONTHS[m - 1]} ${y}`; };

/** "Baseline · 12 Sep 2025", "Follow-up · 14 Mar 2026 · day 182", "Follow-up · same day" (the practice server sends no dates). */
export const scanTitle = (s: PatientScan) =>
  [s.timepoint, s.date && showDate(s.date), s.timepoint === "Follow-up" && s.day != null && (s.day === 0 ? "same day" : `day ${s.day}`)].filter(Boolean).join(" · ");
/** The Patients button: "Doe, Jane · Follow-up · 14 Mar 2026 · day 182", "Practice patient 1 · Baseline". */
export const buttonLabel = (p: Patient, s: PatientScan) => `${p.name} · ${scanTitle(s)}`;

/** Nodules recorded on scan `id`: the page's own table, one per nodule number. shortcut: the hosted page's earlier rows on Base44 are not counted yet (Base44's rows by scan are a later step). */
export const recordedOn = (rows: RecordedNodule[], id: string) => new Set(rows.filter((r) => scanIdOf(r) === id).map((r) => r.nodule)).size;
/** The left column's count: the most nodules on any one scan of the patient (a follow-up measures the baseline's nodules again). */
export const patientCount = (p: Patient, rows: RecordedNodule[]) => Math.max(0, ...p.scans.map((s) => recordedOn(rows, s.id)));
const nodules = (n: number) => (n === 1 ? "1 nodule" : `${n} nodules`);
export const chip = (n: number) => (n ? `${nodules(n)} recorded` : "not measured yet");
export const countText = (n: number, practice: boolean) => (n ? nodules(n) : practice ? "" : "not measured yet"); // the timeline chip's words too

/** "3 scans · last 14 Mar 2026", "1 scan · 9 Mar 2026". */
export const scansLine = (p: Patient) => {
  const n = p.scans.length, last = p.scans.map((s) => s.date).filter((d): d is string => !!d).sort().at(-1);
  return [n === 1 ? "1 scan" : `${n} scans`, last && `${n === 1 ? "" : "last "}${showDate(last)}`].filter(Boolean).join(" · ");
};

export const search = (ps: Patient[], q: string) => { const t = q.trim().toLowerCase(); return t ? ps.filter((p) => p.name.toLowerCase().includes(t)) : ps; };

/** Newest activity first: the patient's last Record on this page, else its newest scan date (ISO strings compare as times); then by name. */
export const byActivity = (ps: Patient[], rows: RecordedNodule[]) => {
  const last = new Map<string, string>();
  for (const r of rows) { const id = scanIdOf(r); if ((last.get(id) ?? "") < r.recorded_at) last.set(id, r.recorded_at); }
  const at = new Map(ps.map((p) => [p, p.scans.map((s) => last.get(s.id) ?? s.date ?? "").sort().at(-1) ?? ""]));
  return [...ps].sort((a, b) => at.get(b)!.localeCompare(at.get(a)!) || a.name.localeCompare(b.name, "en", { numeric: true }));
};

/** The patient holding scan `id`, and that patient's scans before and after it (the engine sends each patient's scans oldest first). */
export const locate = (ps: Patient[], id: string) => {
  for (const patient of ps) {
    const i = patient.scans.findIndex((s) => s.id === id);
    if (i >= 0) return { patient, scan: patient.scans[i], prev: patient.scans[i - 1] as PatientScan | undefined, next: patient.scans[i + 1] as PatientScan | undefined };
  }
};
