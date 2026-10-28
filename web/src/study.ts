import type { ScanMeta } from "./api";
import { toCSV, type RecordedNodule } from "./record";
import { utcTime } from "./utc";

// Numbers only: no study date, no UID, no path, no outline file, no image, no email. A test keeps it so.
export type ScanFields = {
  study_code: string; timepoint: number; days_from_baseline: number; scan_ref: string; series_number: number | null; series_label: string;
  slice_thickness_mm: number | null; slice_spacing_mm: number | null; status?: "to do" | "in progress" | "done";
};
// The fixed list of removal reasons: no free text anywhere. "recorded by mistake" is Undo's.
export const REMOVED_REASONS = ["wrong nodule", "wrong scan", "duplicate", "recorded by mistake"] as const;
export type RemovedReason = (typeof REMOVED_REASONS)[number];
export const UNDONE: RemovedReason = "recorded by mistake";
export type MeasurementFields = {
  scan_id: string; nodule_label: string; previous_id?: string; lobe: "RUL" | "RML" | "RLL" | "LUL" | "LLL" | "unknown"; position_voxel: [number, number, number];
  long_axis_mm: number; short_axis_mm: number; volume_ml: number; depth_mm: number | null; width_method: string;
  method: "tool approved" | "tool edited" | "manual"; clicks: number; corrections: number | null; edit_seconds: number;
  engine_version: string; model: string; reason: "vessel attached" | "ground-glass" | "uncertain" | "none"; approved: boolean; approved_at: string; // who saved it is Base44's own created_by
  practice: boolean; // a row from the public practice scans
  replaces_id?: string; removed_reason?: RemovedReason; // the row a correction replaces; a removal row names the row it removes and why (it has no numbers)
};
type M = MeasurementFields & { id: string };
const PRACTICE = /^RIDER-\d{10}$/; // the public practice data keeps its own name as its study code (the engine's PUBLIC_PATIENT)

/** The Base44 payload of a recorded row. approved_at is the row's own Record time. A study-folder scan's timepoint is the engine's (the order of its study day);
 *  otherwise RIDER test is timepoint 0, retest is 1 (the series name is the label). */
export function toEntities(row: RecordedNodule, scan: ScanMeta, info: { commit: string; model: string }):
  { scan: ScanFields; measurement: Omit<MeasurementFields, "scan_id"> } {
  const inst = scan.instance_numbers;
  const z = inst ? inst.indexOf(row.click_image!) : row.click_image! - 1;
  return {
    scan: {
      study_code: scan.study_code, timepoint: scan.timepoint ?? (scan.series === "retest" ? 1 : 0), days_from_baseline: scan.days_from_baseline, scan_ref: scan.scan_ref, status: "in progress", series_number: scan.series_number,
      series_label: scan.slice_thickness_mm === null ? "" : `${scan.slice_thickness_mm} mm`, slice_thickness_mm: scan.slice_thickness_mm, slice_spacing_mm: scan.spacing[2],
    },
    measurement: {
      nodule_label: `N${row.nodule}`, lobe: "unknown", position_voxel: [z, row.click_y!, row.click_x!],
      long_axis_mm: row.long_mm, short_axis_mm: row.short_mm, volume_ml: row.volume_ml, depth_mm: row.depth_mm, width_method: row.width,
      method: row.clicks === 1 && !row.painted && !row.axes_edited ? "tool approved" : "tool edited", clicks: row.clicks, corrections: row.corrections, edit_seconds: row.seconds_to_record,
      engine_version: info.commit, model: info.model, reason: "none", approved: true, approved_at: row.recorded_at, practice: PRACTICE.test(scan.study_code),
    },
  };
}
export type Payload = ReturnType<typeof toEntities>;
type Removal = { scan: Pick<ScanFields, "scan_ref">; measurement: Pick<MeasurementFields, "nodule_label" | "practice" | "approved_at"> & { removed_reason: RemovedReason; replaces_id?: string } };

/** Each measurement row's mark: "current", "replaced" (a later row that still stands corrects it), or the reason it was removed. Removal rows get none.
 *  A removal row removes the one row it names, whatever its reason: Undo writes one for its own Record, so a row that Record replaced stands
 *  again; a Study-table removal writes one for every row of the label at that timepoint. */
export function marks(ms: M[]): Map<string, "current" | "replaced" | RemovedReason> {
  const byId = new Map(ms.map((m) => [m.id, m]));
  const removed = new Map(ms.filter((r) => r.removed_reason).map((r) => [r.replaces_id, r.removed_reason!]));
  const replaced = new Set<string>();
  for (const m of ms) if (!m.removed_reason && !removed.has(m.id)) for (let p = m.replaces_id; p && !replaced.has(p); p = byId.get(p)?.replaces_id) replaced.add(p);
  return new Map(ms.filter((m) => !m.removed_reason).map((m) => [m.id, removed.get(m.id) ?? (replaced.has(m.id) ? "replaced" : "current")]));
}

type Row = Record<string, any> & { id: string };
type Store = { filter(q: Record<string, unknown>): Promise<Row[]>; create(o: Record<string, unknown>): Promise<{ id: string }> };
type Db = { Scan: Store; NoduleMeasurement: Store };
/** A row waiting to be saved: a Record, or a removal. user: the Base44 user id of who made it (it is sent only while that person is signed in; never
 *  sent to Base44, and no email is kept). at: when it was stored, for the order. target: the approved_at of the Record an Undo removes, found on
 *  Base44 at save time. spacing: the scan's voxel size (x, y, z) in mm, for a Record. */
type Waiting = { key: string; user: string; at: number; e: Payload | Removal; target?: string; spacing?: [number, number, number] };
/** A scan's oldest Scan row on Base44, if any, and every measurement row on any of its Scan rows: two can share a scan_ref (a reload during a Scan
 *  create, or two browsers on one computer), so a lookup that read one would miss rows. filter() gives rows oldest first. */
async function rowsOf(db: Db, scan_ref: string) {
  const scans = await db.Scan.filter({ scan_ref });
  return { scan: scans[0], rows: (await Promise.all(scans.map((s) => db.NoduleMeasurement.filter({ scan_id: s.id })))).flat() as M[] };
}

// A Record whose first click
// is near a standing row of the same Scan re-measures that nodule. Near: within max(NEAR_MM, NEAR_LONG_AXIS × that row's long axis).
export const NEAR_MM = 10, NEAR_LONG_AXIS = 0.75;
const label = (r: Record<string, any>) => Number(r.nodule_label?.slice(1)) || 0; // "N3" -> 3
/** The standing row a first click at `at` (z, y, x voxels) re-measures, the nearest if several are near; none when none is. */
function nearest(rows: M[], at: [number, number, number], [sx, sy, sz]: [number, number, number]): M | undefined {
  const mark = marks(rows);
  const mm = (r: M) => Math.hypot((r.position_voxel[0] - at[0]) * sz, (r.position_voxel[1] - at[1]) * sy, (r.position_voxel[2] - at[2]) * sx);
  return rows.filter((r) => "practice" in r && mark.get(r.id) === "current" && r.position_voxel && mm(r) <= Math.max(NEAR_MM, NEAR_LONG_AXIS * r.long_axis_mm)) // a row
    .sort((a, b) => mm(a) - mm(b))[0]; // saved before the table files were pushed has no practice key and could never take a mark: it never blocks a Record
}
const time = utcTime; // Base44 may write a time differently than it was sent (no zone = UTC): always compare the time, never the text
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const OUT_OF_DATE = "TablesOutOfDate", NOT_FOUND = "RowNotFound";

/** Finds the Scan by scan_ref (creates it for a Record), then adds the row. A Record near a standing row replaces it and takes its label;
 *  any other Record gets the next label after every row of that scan, or this sitting's own number if higher.
 *  Resolves to the row it replaced and the label it saved, if any. Throws the SDK's error when a call fails. */
async function save(db: Db, { e, target, spacing }: Waiting): Promise<{ replaced?: M; nodule?: number; already?: boolean }> {
  const m: Record<string, any> = e.measurement, removal = !!m.removed_reason;
  const { scan: found, rows } = await rowsOf(db, e.scan.scan_ref);
  if (removal && !target) return removeLabel(db, rows, m); // a removal from the Study table: its own path
  if (!found && removal) return {}; // an Undo whose Record never reached Base44: nothing to remove
  const scan = found ?? (await db.Scan.create(e.scan));
  const done = rows.find((r) => time(r.approved_at) === time(m.approved_at) && !r.removed_reason === !removal);
  if (done) return { nodule: removal ? undefined : label(done) }; // a retry after a lost reply: already saved
  const old = target ? rows.find((r) => !r.removed_reason && time(r.approved_at) === time(target)) // Undo: the one Record it takes back
    : spacing && nearest(rows, m.position_voxel, spacing); // a re-measured nodule
  if (removal && !old) return {}; // the row it removes never reached Base44: nothing to write
  if (removal && old && rows.some((x) => x.removed_reason && x.replaces_id === old.id)) return { already: true }; // removed in the Study table meanwhile: one removal row is enough
  if (old && !("practice" in old)) throw outOfDate();
  const nodule_label = old ? old.nodule_label : `N${Math.max(1 + Math.max(0, ...rows.map(label)), label(m))}`;
  await db.NoduleMeasurement.create({ ...m, nodule_label, scan_id: scan.id, ...(old && { replaces_id: old.id }) });
  return removal ? {} : { replaced: old, nodule: label({ nodule_label }) };
}
// Base44 silently drops fields its table files do not declare: a removal saved before the files are pushed would lose its mark
const outOfDate = () => named(OUT_OF_DATE, "The study table's fields are out of date.");
/** From the Study table, whatever the reason: the label at that timepoint goes, with the rows it had replaced. One removal row for each, oldest
 *  first (half saved, it hides nothing yet); a row that already has its removal row is skipped, so a retry never writes one twice. */
async function removeLabel(db: Db, rows: M[], m: Record<string, any>) {
  const chain: M[] = [];
  let r = rows.find((x) => x.id === m.replaces_id);
  while (r) { chain.unshift(r); const p = r.replaces_id; r = rows.find((x) => x.id === p); }
  if (!chain.length) throw named(NOT_FOUND, "The row to remove is not on the study table."); // it waits and is tried again, never "saved"
  if (!("practice" in chain.at(-1)!)) throw outOfDate();
  for (const c of chain) if (!rows.some((x) => x.removed_reason && x.replaces_id === c.id)) await db.NoduleMeasurement.create({ ...m, nodule_label: c.nodule_label, scan_id: c.scan_id, replaces_id: c.id });
  return {};
}

// The SDK sets no time limit. A save still open after SLOW_MS shows as waiting, but it is never given up, so it is never sent twice: it is tried
// again only once it has failed, or after a reload (where the lost-reply check finds it if it landed).
export const RETRY_MS = 15_000, SLOW_MS = 20_000;
export const SAVING = "Saving to the study table…";
export const SAVED = "Saved to the study table.";
export const NOT_SAVED = `Recorded on this computer. Not saved to the study table yet; trying again every ${RETRY_MS / 1000} s.`;
export const ALREADY_REMOVED = "Record undone. It was already removed in the Study table, so nothing more was written.";
export const OUT_OF_DATE_NOTE = "The study table needs an update by its admin before this can be saved. Nothing was written.";
/** The state of a Record's save, for the panel. note: a plain reason it cannot be saved yet, if one is known. nodule: the label Base44 got (a re-measure may change it). */
export type SaveState = { state: "saving" | "saved" | "waiting"; replaces?: string; note?: string; nodule?: number };
/** What the event log may hold about a failed save: the HTTP status or the error's class, never its message (it can quote the payload). */
export const failReason = (e: unknown) => { const s = (e as { status?: unknown })?.status; return typeof s === "number" ? String(s) : e instanceof Error ? e.name : "unknown"; };
const pad = (n: number) => String(n).padStart(2, "0");
/** the line beside Sign out while this person's rows wait. */
export const signOutLine = (n: number) => n === 1 ? "1 row is still waiting to be saved. It is saved when you sign in again on this computer."
  : `${n} rows are still waiting to be saved. They are saved when you sign in again on this computer.`;
/** "This replaces nodule 1 recorded at 14:02." (local time), with the day when it was not today. */
export function replacesLine(old: Pick<MeasurementFields, "nodule_label" | "approved_at">, now = new Date()) {
  const d = new Date(time(old.approved_at));
  const day = d.toDateString() === now.toDateString() ? "" : ` on ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `This replaces nodule ${old.nodule_label.slice(1)} recorded at ${pad(d.getHours())}:${pad(d.getMinutes())}${day}.`;
}

export const WAITING = "lung.waiting."; // one key per waiting row (WAITING + its key): two tabs never overwrite each other's rows
type Kv = Pick<Storage, "getItem" | "setItem" | "removeItem"> & { keys(): string[] };
type Lock = <T>(fn: () => Promise<T>) => Promise<T>;
// One tab at a time across the origin, so two tabs never save the same waiting row twice.
const webLock: Lock = (fn) => (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("lung.waiting", fn) : fn());
type Options = { onCount?: (waiting: number, note?: string) => void; onFail?: (reason: string) => void; lock?: Lock; slowMs?: number };
const parse = (v: string | null): Waiting[] => { try { const w = JSON.parse(v ?? ""); return w && typeof w.key === "string" && w.e ? [w] : []; } catch { return []; } };

/** The rows still waiting to be saved, and nothing else, stay in the browser (`kv`, the hosted origin's localStorage), each under its own key.
 *  A change is stored at once; each row leaves as soon as Base44 confirms it. A row is sent only while the person who made it (me(), the Base44 user id)
 *  is signed in. flush() tries them all, in order; the page calls it on load and every RETRY_MS. onCount hears how many of this person's rows wait;
 *  onFail hears each row's first failure (failReason only). */
export function outbox(db: Db, kv: Kv, me: () => string | undefined, { onCount = () => {}, onFail = () => {}, lock = webLock, slowMs = SLOW_MS }: Options = {}) {
  const reports = new Map<string, { report: (s: SaveState) => void; e: Payload; slow: ReturnType<typeof setTimeout> }>(); // slow: its 20 s mark, from add()
  /** Stops reporting a Record (saved, or undone): its 20 s mark goes too. Returns its report. */
  const forget = (key: string) => { const r = reports.get(key); clearTimeout(r?.slow); reports.delete(key); return r?.report; };
  const failed = new Map<string, string>(); // key -> the reason of its last failure
  const already = new Set<string>(); // Undo entries skipped because the Study table had removed their Record
  let memory: Map<string, Waiting> | undefined; // the browser refused a write: this tab keeps them (lost on reload)
  let flushing: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve(); // one save at a time in this tab: two quick Records on a new scan would otherwise both find no Scan and create two
  let last = 0;
  const read = (): Waiting[] => {
    let list: Waiting[] = [];
    if (memory) list = [...memory.values()];
    else try { list = kv.keys().filter((k) => k.startsWith(WAITING)).flatMap((k) => parse(kv.getItem(k))); } catch { /* storage blocked: nothing stored */ }
    return list.sort((a, b) => a.at - b.at);
  };
  const put = (w: Waiting) => { // at once, never behind a save in progress: a reload or an Undo always finds it
    if (!memory) try { kv.setItem(WAITING + w.key, JSON.stringify(w)); return; } catch { memory = new Map(read().map((x) => [x.key, x])); }
    memory!.set(w.key, w);
  };
  const drop = (key: string) => { memory?.delete(key); try { kv.removeItem(WAITING + key); } catch { /* storage blocked */ } };
  const stored = (key: string) => read().some((w) => w.key === key);
  const entry = (e: Payload | Removal, more?: Pick<Waiting, "target" | "spacing">): Waiting =>
    ({ key: crypto.randomUUID(), user: me() ?? "", at: (last = Math.max(Date.now(), last + 1)), e, ...more });
  /** Undo lookups (target) are not counted: they write only if the Record they take back was saved. */
  const count = () => {
    const mine = read().filter((w) => w.user === me());
    onCount(mine.filter((w) => !w.target).length, mine.some((w) => failed.get(w.key) === OUT_OF_DATE) ? OUT_OF_DATE_NOTE : undefined);
  };
  /** Recounts, and reports Saved for this page's Records another tab saved, with the label Base44 got (found by their time; asked again next time if not yet). */
  const sync = async () => {
    count();
    for (const [key, { e }] of reports) if (!stored(key)) {
      const { rows } = await rowsOf(db, e.scan.scan_ref).catch(() => ({ rows: [] as M[] }));
      const row = rows.find((r) => !r.removed_reason && time(r.approved_at) === time(e.measurement.approved_at)), old = row && rows.find((r) => r.id === row.replaces_id);
      if (row) forget(key)?.({ state: "saved", replaces: old ? replacesLine(old) : undefined, nodule: label(row) }); // none if a save here reported it meanwhile
    }
  };
  const run = () => {
    const r = queue.catch(() => {}).then(() => lock(async () => {
      for (const w of read()) { // one failure does not block the rest
        if (w.user !== me() || !stored(w.key)) continue; // another person's row waits for them; an Undo may have dropped this one meanwhile
        const slow = setTimeout(count, slowMs); // still open: it waits, and is not sent again (a Record's own box turns at 20 s from add())
        try {
          const { replaced, nodule, already: skipped } = await save(db, w);
          drop(w.key); failed.delete(w.key);
          if (skipped) already.add(w.key);
          forget(w.key)?.({ state: "saved", replaces: replaced && replacesLine(replaced), nodule });
        } catch (err) {
          const why = failReason(err);
          if (!failed.has(w.key)) onFail(why);
          failed.set(w.key, err instanceof Error && err.name === OUT_OF_DATE ? OUT_OF_DATE : why);
          reports.get(w.key)?.report({ state: "waiting", note: failed.get(w.key) === OUT_OF_DATE ? OUT_OF_DATE_NOTE : undefined });
        } finally { clearTimeout(slow); }
      }
      await sync();
    }));
    queue = r;
    return r;
  };
  const removal = (scan_ref: string, m: Pick<MeasurementFields, "nodule_label" | "practice">, reason: RemovedReason, nowIso: string, replaces_id?: string): Removal =>
    ({ scan: { scan_ref }, measurement: { nodule_label: m.nodule_label, practice: m.practice, removed_reason: reason, approved_at: nowIso, ...(replaces_id && { replaces_id }) } });
  return {
    /** Stores a Record and tries it; `report` hears saving, then saved (with the label Base44 got) or waiting. spacing: the scan's voxel size (x, y, z),
     *  to tell a re-measured nodule by its first click. Returns the key Undo needs. */
    add(e: Payload, report?: (s: SaveState) => void, spacing?: [number, number, number]) {
      const w = entry(e, spacing && { spacing });
      if (report) { // the 20 s mark starts now, also while it waits behind another save in this tab or another
        reports.set(w.key, { report, e, slow: setTimeout(() => { reports.get(w.key)?.report({ state: "waiting" }); count(); }, slowMs) });
        report({ state: "saving" });
      }
      put(w);
      void run();
      return w.key;
    },
    /** A Record still waiting is dropped, never written. One already saved, or still on its way, gets a removal row, "recorded by mistake":
     *  the Undo is stored at once and sent once that save has settled (nothing is written if it failed). Resolves to ALREADY_REMOVED when the Study
     *  table had removed that Record meanwhile (nothing is written then), else to nothing. */
    undo(key: string, e: Payload, nowIso = new Date().toISOString()) {
      forget(key);
      drop(key);
      const w = entry(removal(e.scan.scan_ref, e.measurement, UNDONE, nowIso), { target: e.measurement.approved_at });
      put(w);
      return run().then(() => (already.delete(w.key) ? ALREADY_REMOVED : undefined));
    },
    /** Removes a row of the Study table, with a reason from the fixed list. Resolves once tried, or after SLOW_MS: saved, or why not yet. */
    async remove(scan_ref: string, m: M, reason: RemovedReason, nowIso = new Date().toISOString()) {
      const w = entry(removal(scan_ref, m, reason, nowIso, m.id));
      put(w);
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run(), new Promise((ok) => { t = setTimeout(ok, slowMs); })]).finally(() => clearTimeout(t)); // a slow save ahead: "not saved yet"
      return { saved: !stored(w.key), outOfDate: failed.get(w.key) === OUT_OF_DATE };
    },
    /** Tries every waiting row; a call while one is still running joins it (a slow Base44 never piles up retries). */
    flush: () => (flushing ??= run().finally(() => { flushing = undefined; })),
    /** Another tab changed the waiting rows (the storage event). */
    sync,
    /** How many of this person's rows wait, Records and removals (Undo lookups left out): the Study table loads again while any does. */
    pending: () => read().filter((w) => w.user === me() && !w.target).length,
    /** This person's Records still waiting to be saved (removals and Undo lookups left out): the Study table shows them as not saved yet. */
    waiting: () => read().filter((w) => w.user === me() && !("removed_reason" in w.e.measurement)).map((w) => ({ key: w.key, ...(w.e as Payload) })),
    /** The highest label of a scan on Base44 (every row) and among its rows still waiting: the page numbers its next nodule after it. Throws when Base44 does not answer. */
    async highest(scan_ref: string) {
      const { rows } = await rowsOf(db, scan_ref);
      return Math.max(0, ...rows.map(label), ...read().filter((w) => w.e.scan.scan_ref === scan_ref).map((w) => label(w.e.measurement)));
    },
  };
}

export type Cell = { long: number; short: number; volume: number; method: string; id: string }; // id: the measurement row's
export type StudyRow = { study_code: string; nodule_label: string; cells: Record<number, Cell | undefined>; duplicate: boolean }; // cells by timepoint
const by = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
type S = ScanFields & { id: string };
export const isPractice = (s: Pick<ScanFields, "study_code">, m: { practice?: boolean }) => !!m.practice || PRACTICE.test(s.study_code); // rows saved before the mark are known by their RIDER code
const hidden = (s: S, m: M, practice: boolean) => !practice && isPractice(s, m);

/** One row per study code and nodule label, a cell per timepoint, from the rows that stand. Practice rows only when asked.
 *  Pairing by label is a stand-in until follow-up matching links nodules.
 *  A second measurement of the same label and timepoint gets its own row, and every row of that label says "duplicate label": none is dropped. */
export function studyRows(scans: S[], measurements: M[], practice = false): StudyRow[] {
  const scanById = new Map(scans.map((s) => [s.id, s]));
  const mark = marks(measurements);
  const rows: StudyRow[] = [];
  for (const m of measurements) {
    const s = scanById.get(m.scan_id);
    if (!s || mark.get(m.id) !== "current" || hidden(s, m, practice)) continue; // a measurement whose scan is not visible, a replaced, removed or practice row
    const same = rows.filter((r) => r.study_code === s.study_code && r.nodule_label === m.nodule_label);
    let row = same.find((r) => r.cells[s.timepoint] === undefined);
    if (!row) { row = { study_code: s.study_code, nodule_label: m.nodule_label, cells: {}, duplicate: false }; rows.push(row); if (same.length) for (const r of [...same, row]) r.duplicate = true; }
    row.cells[s.timepoint] = { long: m.long_axis_mm, short: m.short_axis_mm, volume: m.volume_ml, method: m.method, id: m.id };
  }
  return rows.sort((a, b) => by(a.study_code, b.study_code) || by(a.nodule_label, b.nodule_label)); // a stable sort keeps duplicates in the order saved
}

/** Every measurement row ever saved, with its mark: the Study table's history, sorted like the table and then by time. */
export function history(scans: S[], measurements: M[], practice = false) {
  const scanById = new Map(scans.map((s) => [s.id, s]));
  const mark = marks(measurements);
  return measurements.flatMap((m) => { const s = scanById.get(m.scan_id), k = mark.get(m.id); return s && k && !hidden(s, m, practice) ? [{ ...m, scan: s, mark: k }] : []; })
    .sort((a, b) => by(a.scan.study_code, b.scan.study_code) || by(a.nodule_label, b.nodule_label) || a.scan.timepoint - b.scan.timepoint || time(a.approved_at) - time(b.approved_at));
}
/** True when there are rows and every one is a practice row: the Study table then shows them by default, under their own label. */
export const onlyPractice = (scans: S[], measurements: M[]) => history(scans, measurements, true).length > 0 && history(scans, measurements, false).length === 0;

/** The 13 columns Base44 holds, under Copy row's names and with its rounding, plus study_code, timepoint, days_from_baseline, method and the marks.
 *  Base44 holds no patient name, series name, file, image number or date, so Copy row's other columns are not here. */
export const STUDY_COLUMNS = ["study_code", "timepoint", "days_from_baseline", "series_number", "nodule", "long_mm", "short_mm", "width", "volume_ml", "depth_mm", "clicks", "corrections",
  "seconds_to_record", "recorded_at", "slice_thickness_mm", "slice_spacing_mm", "method", "replaced", "removed"];
/** A Base44 time as Copy row writes it (toISOString), whatever text Base44 gives it back in; text that is not a time is kept as it is. */
const iso = (s?: string) => { const t = time(s); return Number.isNaN(t) ? s : new Date(t).toISOString(); };
export const studyCSV = (scans: S[], measurements: M[], practice = false) => toCSV(history(scans, measurements, practice).map(({ scan: s, ...m }) => Object.fromEntries(Object.entries({
  study_code: s.study_code, timepoint: s.timepoint, days_from_baseline: s.days_from_baseline, series_number: s.series_number, nodule: Number(m.nodule_label.slice(1)),
  long_mm: m.long_axis_mm, short_mm: m.short_axis_mm, width: m.width_method, volume_ml: m.volume_ml, depth_mm: m.depth_mm, clicks: m.clicks, corrections: m.corrections,
  seconds_to_record: m.edit_seconds, recorded_at: iso(m.approved_at), slice_thickness_mm: s.slice_thickness_mm, slice_spacing_mm: s.slice_spacing_mm, method: m.method,
  replaced: m.mark === "replaced" ? "yes" : "", removed: m.mark === "current" || m.mark === "replaced" ? "" : m.mark,
}).map(([k, v]) => [k, v ?? null]))), STUDY_COLUMNS); // a field Base44 does not hold is an empty cell
