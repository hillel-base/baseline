import type { Outline, ScanMeta } from "./api";

export type RecordedNodule = {
  patient: string; series: string; series_number: number | null; study_date: string | null; nodule: number; slice: number; slice_label: "image" | "slice index";
  long_mm: number; short_mm: number; width: string; volume_ml: number; depth_mm: number | null; clicks: number; corrections: number | null; seconds_to_record: number; recorded_at: string;
  long_y1: number; long_x1: number; long_y2: number; long_x2: number; short_y1: number; short_x1: number; short_y2: number; short_x2: number;
  click_image: number | null; click_y: number | null; click_x: number | null; at_window_edge: boolean | null; // null only in rows migrated from v1
  slice_thickness_mm: number | null; slice_spacing_mm: number | null; // null only in migrated rows (thickness also when the header has none)
  painted: number; axes_edited: boolean; // brush strokes in the recorded outline (paint and erase); true when the axes were dragged by hand. 0 and false in migrated rows
  follows: string; // the outline_file of the earlier recorded nodule this one was matched to on a follow-up scan; empty if none
  outline_file: string;
};

// Column order and names are our assumption, open to change.
export const COLUMNS: (keyof RecordedNodule)[] = [
  "patient", "series", "series_number", "study_date", "nodule", "slice", "slice_label", "long_mm", "short_mm", "width", "volume_ml", "depth_mm", "clicks", "corrections", "seconds_to_record", "recorded_at",
  "long_y1", "long_x1", "long_y2", "long_x2", "short_y1", "short_x1", "short_y2", "short_x2", "click_image", "click_y", "click_x", "at_window_edge", "slice_thickness_mm", "slice_spacing_mm", "painted", "axes_edited", "follows", "outline_file",
];
const DECIMALS: Partial<Record<keyof RecordedNodule, number>> = { long_mm: 1, short_mm: 1, volume_ml: 2, depth_mm: 1, seconds_to_record: 1,
  long_y1: 1, long_x1: 1, long_y2: 1, long_x2: 1, short_y1: 1, short_x1: 1, short_y2: 1, short_x2: 1,
  slice_thickness_mm: 3, slice_spacing_mm: 3 };  // geometry from slice positions carries float noise
// Any columns with Copy row's names get Copy row's rounding (the Study table's CSV uses it too).
const cells = (r: Record<string, unknown>, cols: string[] = COLUMNS) =>
  cols.map((k) => { const d = DECIMALS[k as keyof RecordedNodule], v = r[k]; return v === null ? "" : d === undefined ? String(v) : (v as number).toFixed(d); }); // as before the study table, byte for byte

export const toTSV = (r: RecordedNodule) => cells(r).join("\t");
const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
export const toCSV = (rows: Record<string, unknown>[], cols: string[] = COLUMNS) => [cols, ...rows.map((r) => cells(r, cols))].map((l) => l.map(q).join(",")).join("\n") + "\n";

/** Highest nodule number ever given per scan ("patient/series"), so a deleted number is never reused. */
export type Counters = Record<string, number>;
export const scanKey = (patient: string, series: string) => `${patient}/${series}`;
/** The page's own number for the next nodule of a scan (the engine's counter restarts with each engine start). */
export const nextNodule = (rows: RecordedNodule[], counters: Counters, patient: string, series: string) =>
  1 + Math.max(counters[scanKey(patient, series)] ?? 0, ...rows.filter((r) => r.patient === patient && r.series === series).map((r) => r.nodule));

const KEY = "lung.recorded.v5", V4 = "lung.recorded.v4", V3 = "lung.recorded.v3", V2 = "lung.recorded.v2", V1 = "lung.recorded.v1", CLEARED = "lung.cleared.v1", COUNTERS = "lung.counters.v1";
const STRINGS = new Set<string>(["patient", "series", "study_date", "slice_label", "width", "recorded_at", "follows", "outline_file"]);
const NEW_FIELDS = ["depth_mm", "click_image", "click_y", "click_x", "at_window_edge", "series_number", "study_date", "corrections", "slice_thickness_mm", "slice_spacing_mm"] as const; // empty in migrated rows
const upgrade = (r: unknown) => (typeof r === "object" && r !== null ? { ...Object.fromEntries(NEW_FIELDS.map((k) => [k, null])), follows: "", painted: 0, axes_edited: false, ...r } : r); // v4's follows: empty; v5's painted 0, axes_edited false
const kind = (k: string) => (STRINGS.has(k) ? "string" : k === "at_window_edge" || k === "axes_edited" ? "boolean" : "number");
const isRow = (v: unknown): v is RecordedNodule =>
  typeof v === "object" && v !== null && COLUMNS.every((k) => {
    const x = (v as Record<string, unknown>)[k];
    return (x === null && (NEW_FIELDS as readonly string[]).includes(k)) || (typeof x === kind(k) && (kind(k) !== "number" || Number.isFinite(x)));
  });
// The hosted page keeps rows, counters and the backup slot in memory only: nothing identifying is stored on that origin. One tab, lost on reload.
let memory: Map<string, string> | undefined;
export const keepInMemory = () => { memory = new Map(); };
const get = (key: string) => (memory ? memory.get(key) ?? null : localStorage.getItem(key));
const read = (key: string): unknown => { try { return JSON.parse(get(key) ?? "null"); } catch { return null; } };
const write = (key: string, v: unknown) => { try { if (memory) memory.set(key, JSON.stringify(v)); else localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } }; // storage full or blocked: the page still works this session
/** The saved rows. When v5 does not exist yet, v4 (else v3, v2, v1) rows are copied into it with empty new fields (the old key stays as it was). */
export function loadRecorded(): RecordedNodule[] {
  const v = read(KEY);
  if (Array.isArray(v)) return v.filter(isRow);
  const old = [read(V4), read(V3), read(V2), read(V1)].find(Array.isArray);
  if (!old) return [];
  const rows = old.map(upgrade).filter(isRow);
  if (rows.length) write(KEY, rows);
  return rows;
}
/** False when the browser would not store it. */
export const saveRecorded = (rows: RecordedNodule[]) => write(KEY, rows);
/** Adds the rows a clear removed to the backup slot (the browser may not have saved the CSV). False when it could not be written. */
/** Rows not already in `have`, by outline file (one file per recorded nodule): no row is ever doubled. */
const without = (rows: RecordedNodule[], have: RecordedNodule[]) => { const f = new Set(have.map((r) => r.outline_file)); return rows.filter((r) => !f.has(r.outline_file)); };
export const backUpRows = (rows: RecordedNodule[]) => { const kept = loadCleared(); return write(CLEARED, [...kept, ...without(rows, kept)]); };
export function loadCleared(): RecordedNodule[] { const v = read(CLEARED); return Array.isArray(v) ? v.map(upgrade).filter(isRow) : []; } // the backup slot may hold older rows
export const forgetCleared = () => write(CLEARED, []);
/** The new table (backup rows, then the saved rows), already saved and with the slot emptied; null, with nothing changed, when it could not be saved. */
export function restoreCleared(): RecordedNodule[] | null {
  const saved = loadRecorded();
  const next = [...without(loadCleared(), saved), ...saved];
  if (!saveRecorded(next)) return null;
  forgetCleared();
  return next;
}
export function loadCounters(): Counters { const v = read(COUNTERS); return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Counters : {}; }
export const saveCounters = (c: Counters) => write(COUNTERS, c);
/** The `storage` event of another tab: the fresh state when the changed key is one of ours (null key = storage was cleared), else null. */
export const reloadFor = (key: string | null) =>
  key === null || [KEY, COUNTERS, CLEARED].includes(key) ? { rows: loadRecorded(), cleared: loadCleared().length } : null;

const r1 = (v: number) => Math.round(v * 10) / 10;
/** Needs an outline with axis_z and both lines (a recorded outline is never empty). */
export function toRow(scan: ScanMeta, o: Outline, nodule: number, seconds: number, outline_file: string, now = new Date()): RecordedNodule {
  const inst = scan.instance_numbers, z = o.axis_z!, c0 = o.clicks[0];
  const [[ly1, lx1], [ly2, lx2]] = o.long_line!, [[sy1, sx1], [sy2, sx2]] = o.short_line!;
  return {
    patient: scan.patient, series: scan.series, series_number: scan.series_number, study_date: scan.study_date ?? null, nodule, slice: inst ? inst[z] : z + 1, slice_label: inst ? "image" : "slice index",
    long_mm: o.long_mm, short_mm: o.short_mm, width: o.width_method, volume_ml: o.volume_ml, depth_mm: o.depth_mm, clicks: o.clicks.length, corrections: o.clicks.length - 1,
    seconds_to_record: r1(seconds), recorded_at: now.toISOString(),
    long_y1: r1(ly1), long_x1: r1(lx1), long_y2: r1(ly2), long_x2: r1(lx2), short_y1: r1(sy1), short_x1: r1(sx1), short_y2: r1(sy2), short_x2: r1(sx2),
    click_image: inst ? inst[c0.z] : c0.z + 1, click_y: c0.y, click_x: c0.x, at_window_edge: o.at_window_edge,
    slice_thickness_mm: scan.slice_thickness_mm, slice_spacing_mm: scan.spacing[2],
    painted: o.painted ?? 0, axes_edited: o.axes_edited ?? false, // an engine from before strokes sends neither
    follows: "", outline_file,
  };
}

// The engine's scan id of each recorded row, by outline_file. It stays out of the row, so Copy row, the CSV and storage do not change.
// A coded scan (D-xxxxxxxx) cannot be rebuilt from patient and series. shortcut: lost on reload (rows on the hosted page are too); then the old patient_series is used, right for local scans.
const opened = new Map<string, string>();
export const rememberScanId = (r: RecordedNodule, id: string) => { opened.set(r.outline_file, id); };
export const scanIdOf = (r: RecordedNodule) => opened.get(r.outline_file) ?? (/^F-[0-9a-f]{8}$/.test(r.patient) ? r.patient : `${r.patient}_${r.series}`);

/** Caption lines of the screenshot. */
export const captionLines = (r: RecordedNodule) => [
  `${r.patient} ${r.series} · nodule ${r.nodule} · ${r.slice_label === "image" ? "Image" : "Slice index"} ${r.slice}`,
  `Long ${r.long_mm.toFixed(1)} mm · Short ${r.short_mm.toFixed(1)} mm · Volume ${r.volume_ml.toFixed(2)} mL`,
  `Width: ${r.width} · Research use only`, // drawn smaller
];
export const screenshotName = (r: RecordedNodule) => `${r.patient}_${r.series}_n${r.nodule}.png`;
