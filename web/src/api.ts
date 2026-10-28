export type ScanRow = { id: string; patient: string; series: string };
export type ScanMeta = ScanRow & {
  study_code: string; // the public RIDER name, else a random code from the engine
  days_from_baseline: number | null; // whole days from the patient's earliest test/retest date; null when a date is missing (never 0: that reads as the same day)
  scan_ref: string; // random per scan, made by the engine: the only scan name Base44 gets
  shape: [number, number, number];
  spacing: [number, number, number];
  instance_numbers: number[] | null; // DICOM image number per z, null if the series has none
  series_number: number | null; study_date?: string | null; /* absent when the page is not the engine's own */ slice_thickness_mm: number | null; // DICOM header; null if missing
  head_dir: 1 | -1 | null; // +1 if head lies toward higher z, null if unknown
  timepoint?: number | null; // a study-folder scan's order among its patient's study days (Baseline 0); null or absent: the RIDER test/retest rule
};

let base = ""; // "" = the engine serves this page; the hosted page sets http://localhost:8000 after "Use my local engine", or a practice server
let practice = false; // a practice server: its own texts replace the local engine's "see README" ones
export const setApiBase = (b: string, onPractice = false) => { base = b; practice = onPractice; };
let auth: string | undefined; // the visitor's Base44 token, set only for a practice server
export const setAuth = (token: string | undefined) => { auth = token; };
/** leaving a practice server gives its hold back at once, so the next user need not wait out the idle minutes. Not through send(): the page is
 * leaving, so a refusal or a lost answer must not show; the hold then ends by itself. */
export const releaseSession = async () => {
  if (!practice || !auth) return;
  await fetch(`${base}/api/session/release`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, keepalive: true }).catch(() => {});
};

// A practice server's refusals. The page says its own words, never a raw body.
export const SIGN_IN_FIRST = "Sign in to use the practice server.";
export const IN_USE = "Someone else is using the practice server. It is free again after 10 minutes without use.";
export const PRACTICE_STOPPED = "The practice server stopped answering. Try again in a minute.";
const REFUSED: Record<number, string | undefined> = { 401: SIGN_IN_FIRST, 423: IN_USE };
/** The texts a page shows as they are: a practice server's states. */
export const PRACTICE_TEXTS = [SIGN_IN_FIRST, IN_USE, PRACTICE_STOPPED];
let blocked = (_text: string | undefined) => {};
/** The Shell's status line: told after every engine answer whether a practice server refused it or stopped (the text), or not (undefined). */
export const onBlocked = (f: (text: string | undefined) => void) => { blocked = f; };

/** Every engine request at the current base goes through here, so the token reaches each one. */
async function send(url: string, init?: RequestInit) {
  const r = await fetch(base + url, auth ? { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${auth}` } } : init)
    .catch((e) => { if (!practice || (e as Error).name === "AbortError") throw e; blocked(PRACTICE_STOPPED); throw new Error(PRACTICE_STOPPED); }); // an abort is the page's own (a slice scrolled past)
  const gone = practice && r.status >= 502 && r.status <= 504; // Hugging Face's page for a paused or broken Space
  if (url !== "/api/info") blocked(gone ? PRACTICE_STOPPED : REFUSED[r.status]); // /api/info answers holder and non-holder alike, so it cannot clear a refusal
  return r;
}
/** The engine's /api/info (5 s by default), with the token while one is set: a practice server sends its model only to a signed-in caller.
 * Does not change the base: the caller does that on success. */
export const probeEngine = async (at: string, ms = 5000): Promise<{ commit: string; model: string; picker?: boolean }> => // picker: the engine serves /picker
  (await ok(await fetch(`${at}/api/info`, { headers: auth ? { authorization: `Bearer ${auth}` } : undefined, signal: AbortSignal.timeout(ms) }))).json();

/** The engine's /api/info at the current base; `device` is the torch device type ("cuda", "mps" or "cpu", "unknown" for a fake model). */
export const getInfo = async (): Promise<{ device: string }> => (await ok(await send("/api/info"))).json();

async function ok(r: Response) {
  if (!r.ok) throw new Error(REFUSED[r.status] ?? (practice ? PRACTICE_STOPPED : `${r.url}: ${r.status}`));
  return r;
}

export const listScans = async (): Promise<ScanRow[]> => (await ok(await send("/api/scans"))).json();
export const getScan = async (id: string): Promise<ScanMeta> => (await ok(await send(`/api/scans/${id}`))).json();
const getOnly = new Set<string>(); // practice servers whose engine answered POST /api/slice with 404: they get the GET for the rest of the session
/** One slice. With the token (a practice server) it is POST /api/slice, one URL for every slice: the token makes each request need a CORS
 *  preflight, which the browser keeps per URL, so one URL pays it once per 10 minutes instead of once per slice.
 *  The local engine never gets the token and keeps the plain GET, which needs no preflight. */
export const getSlice = async (id: string, z: number, signal?: AbortSignal): Promise<Int16Array> => {
  const at = base, byGet = () => send(`/api/scans/${id}/slices/${z}`, { signal });
  let r: Response;
  if (auth && !getOnly.has(at)) {
    r = await send("/api/slice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scan: id, z }), signal });
    const missingRoute = r.status === 404 && (await r.clone().json().catch(() => null))?.detail === "Not Found"; // the router's own 404, not "unknown scan"
    if (missingRoute) { getOnly.add(at); r = await byGet(); } // an older practice engine has no route: GET from now on, this slice once more
  } else r = await byGet();
  return new Int16Array(await (await ok(r)).arrayBuffer());
};

export const ENGINE_STOPPED = "The engine stopped. Restart it (see README) and click again.";
export const NO_LONGER_OPEN = "This nodule is no longer open in the engine (another tab or a restart). Click the nodule to start again."; // the engine's own text

export type Pt = [number, number]; // [y, x]
export type Outline = {
  nodule: number; scan: string; can_undo: boolean;
  clicks: { z: number; y: number; x: number; positive: boolean }[]; at_window_edge: boolean;
  bbox: number[] | null; mask: string | null; // bbox [z0,y0,x0,z1,y1,x1]; mask = base64 packbits of that box
  volume_ml: number; long_mm: number; short_mm: number; axis_z: number | null;
  long_line: [Pt, Pt] | null; short_line: [Pt, Pt] | null; seconds: number;
  depth_mm: number; width_method: "edge to edge" | "centre to centre";
  painted?: number; axes_edited?: boolean; // strokes applied; true while hand-set axes replace the outline's own (absent from engines before strokes, and the Demo's recordings)
};

async function post<T = Outline>(url: string, body?: object): Promise<T> {
  return call<T>(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body),
  });
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await send(url, init).catch(() => { throw new Error(practice ? PRACTICE_STOPPED : ENGINE_STOPPED); }); // a network failure: the engine is gone
  if (!r.ok) {
    if (practice && r.status >= 502 && r.status <= 504) throw new Error(PRACTICE_STOPPED); // Hugging Face's page for a paused or broken Space: the designed "stopped" state
    const d = REFUSED[r.status] ?? await r.json().then((j) => j.detail, () => undefined);
    throw new Error(typeof d === "string" ? d : `The engine failed (${r.status}).`);
  }
  return r.json();
}

type Vox = { z: number; y: number; x: number };
/** Where voxel `p` of scan `from` lies on scan `to` (the engine aligns the two scans; about 15 s the first time for a pair). `outside`: it fell outside `to`. */
export const mapPoint = (from: string, to: string, p: Vox) =>
  call<Vox & { seconds: number; outside?: true }>(`/api/scans/${to}/map?from=${from}&z=${p.z}&y=${p.y}&x=${p.x}`);
/** First click of a new nodule. Rejects with the engine's own message when it sends one. */
export const startNodule = (id: string, p: Vox) => post(`/api/scans/${id}/nodules`, p);
/** A + or - click on the nodule the page shows (scan and number, so the engine can refuse a stale one). */
export const correctNodule = (p: Vox, positive: boolean, o: Pick<Outline, "scan" | "nodule">) =>
  post("/api/nodule/clicks", { ...p, positive, scan: o.scan, nodule: o.nodule });
/** Undoes the last action of any kind: a click, a stroke or hand-set axes. */
export const undoClick = (o: Pick<Outline, "scan" | "nodule">) => post("/api/nodule/undo", { scan: o.scan, nodule: o.nodule });
export type Stroke = { z: number; points: Pt[]; radius: number; mode: "paint" | "erase"; snap: boolean }; // points: image pixels [y, x] on slice z; radius 1 to 15 px
/** One brush stroke, sent on release. */
export const paintStroke = (o: Pick<Outline, "scan" | "nodule">, s: Stroke) => post("/api/nodule/paint", { scan: o.scan, nodule: o.nodule, ...s });
/** Hand-set axes on axis_z, end points [[y, x], [y, x]] (decimals allowed). Sent only after a real drag: the engine marks the axes hand-set even when unchanged. */
export const setAxes = (o: Pick<Outline, "scan" | "nodule">, long_line: [Pt, Pt], short_line: [Pt, Pt]) => post("/api/nodule/axes", { scan: o.scan, nodule: o.nodule, long_line, short_line });
export type Link = { follows: string; map_distance_mm: number }; // the earlier nodule a follow-up nodule was matched to, and the proposal to the first click
/** Saves the nodule as the engine holds it: the outline file (relative to the runs folder) and, after a finder run on the scan, the ranks of the suggestions inside the outline. */
export const recordNodule = (o: Pick<Outline, "scan" | "nodule">, link?: Link) =>
  post<{ outline_file: string; suggestions?: number[] }>("/api/nodule/record", { scan: o.scan, nodule: o.nodule, ...link });
/** Reports a UI-only action for the run log. Fire and forget: a logging failure never blocks the user. */
export const postEvent = (e: { action: "copy_row" | "export_csv" | "screenshot" | "discard" | "delete_row" | "clear_table" | "restore_table" | "start_over" | "zoom" | "zoom_fit" | "zoom_area" | "undo_delete_row" | "followup_confirm" | "followup_moved" | "undo_record" | "save_failed" | "candidate_accept" | "candidate_reject" | "undo_candidate_reject";
  scale?: number; scan?: string; nodule?: number; rows?: number; file?: string; follows?: string; distance_mm?: number; undoes?: string; reason?: string; rank?: number; score?: number }) => {
  if (e.action === "save_failed" && !base) return; // only the hosted page saves, and before "Use my local engine" "" is the hosted origin, which keeps no log: dropped
  send("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e) }).catch(() => {});
};

export type FolderSeries = { uid_hash: string; description: string; images: number };
export type Folder = { path: string; parent: string | null; folders: string[]; series: FolderSeries[] };
/** The engine's folder list: `path` is relative to its browse root (or absolute inside it). Rejects with the engine's own text. */
export const listFolder = (path: string) => call<Folder>(`/api/folders?path=${encodeURIComponent(path)}`);

// GET /api/patients: the engine's own page gets names; a practice server gets "Practice patient N" and no folder.
export type PatientScan = { id: string; code?: string /* the id as the hosted page sees it (none from an older engine) */; timepoint: "Baseline" | "Follow-up" | "Undated"; date: string | null; day: number | null; label: string; slice_mm: number | null; images: number };
export type Patient = { key: string; name: string; source: "study" | "data"; scans: PatientScan[] };
export type Patients = { folder: { path: string | null; from: "panel" | "LUNG_STUDY_DIR" | null; error: string | null }; patients: Patient[] };
/** Rejects when the route fails or is missing (an older practice server): the page then keeps the drop-down. */
export const listPatients = async (): Promise<Patients> => {
  const j = await (await ok(await send("/api/patients", { signal: AbortSignal.timeout(60_000) }))).json(); // a hung index gives the drop-down back (20,000 headers take about 7 s)
  if (!Array.isArray(j?.patients)) throw new Error("No patient list.");
  return j;
};
/** Sets the study folder (relative to the browse root); the engine reads it first and answers as GET does, or with its own plain text. */
export const setStudyFolder = (path: string) => post<Patients>("/api/patients/folder", { path });
export type Candidate = { z: number; y: number; x: number; score: number; image: number };
/** Is the optional co-pilot there? Any failure (an older engine too) counts as no. */
export const getCopilot = (): Promise<boolean> => call<{ enabled?: boolean }>("/api/copilot").then((j) => j.enabled === true, () => false);
/** Runs the finder on the scan; rejects with the engine's own text. */
export const findCandidates = (id: string) => post<Candidate[]>(`/api/scans/${id}/candidates`);
