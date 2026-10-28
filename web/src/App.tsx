import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ENGINE_STOPPED, PRACTICE_STOPPED, PRACTICE_TEXTS, correctNodule, findCandidates, getCopilot, getInfo, getScan, listPatients, listScans, mapPoint, paintStroke, postEvent, recordNodule, setAxes, startNodule, undoClick, type Link, type Outline, type Patients, type Pt, type ScanMeta, type ScanRow } from "./api";
import { clickKind, dropsNodule, isEmpty, type Mode } from "./clicks";
import { distanceMm, earlierRows, firstClick } from "./followup";
import { backUpRows, captionLines, forgetCleared, loadCleared, loadCounters, loadRecorded, nextNodule, reloadFor, restoreCleared, saveCounters, saveRecorded, rememberScanId, scanIdOf, scanKey, screenshotName, toCSV, toRow, toTSV, type RecordedNodule } from "./record";
import type { SaveState } from "./study";
import { About } from "./About";
import { Copilot } from "./Copilot";
import { Earlier, Panel } from "./Panel";
import { PatientsFrame, countsOf } from "./PatientsFrame";
import { PatientsPanel } from "./PatientsPanel";
import { RecordedTable } from "./RecordedTable";
import { SliceView, type SliceViewHandle } from "./SliceView";
import { HOLD, ranked, withMeasured, type Finds, type Ranked } from "./list";
import { keyFor, restoreRow } from "./ui";
import lockup from "./assets/lockup-dark.svg";

/** The Baseline logo, in the header of both pages; the alt text is its name for a screen reader. */
export const Logo = () => <img className="logo" src={lockup} alt="Baseline, lung nodule measurement on CT" />;

const DISCARDED = "The unrecorded outline was discarded.";
const SAVE_FAILED = "Could not save the table in this browser. Download the CSV to keep it.";
const NO_BACKUP = "Could not keep a backup of the rows, so the table was not cleared.";
const DELETED = "Row deleted. Click the nodule to outline it again.";
const UNDONE = "Record undone. Click the nodule to outline it again.";
const COPY_FAILED = "Copy failed. Select the row and copy it by hand.";
const AXES_CLEARED = "Axes measured again: that change replaced the axes you set by hand. U takes it back.";

const K = ({ k }: { k: string }) => <kbd className="k">{k}</kbd>;
const STEPS = "The patient's previous or next scan (beside the Patients button)";
const SHORTCUTS: [ReactNode, string][] = [
  [<><K k="↑" /> <K k="↓" /> or wheel</>, "Previous or next image"], [<K k="A" />, "Add mode"], [<K k="R" />, "Remove mode"],
  [<>Hold <K k="Shift" /></>, "Remove for one click"], [<K k="P" />, "Paint mode: drag on the image to paint"], [<K k="E" />, "Erase mode: drag on the image to erase"],
  [<><K k="[" /> <K k="]" /></>, "Smaller or larger brush"], [<K k="T" />, "Snap to tissue: paint only tissue, not air (Paint mode)"],
  [<K k="X" />, "Axes mode: drag an end of an axis line on the largest slice to set that axis by hand"], [<K k="U" />, "Undo the last action: a click, a stroke or a dragged axis"], [<K k="S" />, "Start over: throw away this outline, same nodule"],
  [<K k="G" />, "Go to the largest slice"], [<><K k="+" /> <K k="−" /></>, "Zoom in or out (= also zooms in)"], ["Ctrl+wheel, pinch", "Zoom about the cursor"],
  [<><K k="Space" />+drag</>, "Pan"], [<K k="Z" />, "Zoom to area: drag a rectangle (Esc cancels)"], [<K k="F" />, "Fit: the whole image, 100 %"],
  [<><K k="Alt" />+<K k="←" /> <K k="Alt" />+<K k="→" /></>, STEPS],
  [<K k="Enter" />, "Record nodule"], [<K k="N" />, "New nodule"], [<K k="M" />, "Measure here: outline the proposed nodule (follow-up scan)"], [<K k="?" />, "Show these shortcuts"],
];

type Vox = { z: number; y: number; x: number };
/** A follow-up proposal: the earlier row being found, and where it maps on this scan (none while finding or when it maps outside the scan). */
type Proposal = { row: RecordedNodule; at?: Vox & { label: string }; outside?: boolean };

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// embedded: the hosted shell supplies the heading and the footer. Folders open only through the Patients panel (its Change folder…), on the engine's own page or in its frame.
// overlay: a practice server's busy or stopped message, shown once, in the image area in place of the image.
// onRecorded: the hosted page saves the row and reports its state; onUndoRecord: it takes the save back (and may resolve to a line that replaces "Record undone.");
// knownNodules: the highest nodule number the study table already holds for a scan. onOpen: told whether an unrecorded outline is on the page (the Shell's Change asks first then).
// panel: false keeps the Scan drop-down (codes) and never asks /api/patients: the hosted page with the local engine, which that route refuses.
// frame: that engine's address; the Patients panel then comes from it, in a frame this page cannot read, with the drop-down as its fallback.
// Tutorial mode (hosted, both optional, nothing changes without them): cross, a ring on that voxel of that scan (SliceView's target: white, or with a tone
// the small ring of a correction) while no follow-up proposal shows, and the viewer goes to its slice once; onScan, told the open scan and the patient list,
// which the tour cannot read in the frame.
export function App({ embedded = false, panel = true, frame, overlay, onRecorded, onUndoRecord, knownNodules, onOpen, cross, onScan }: { embedded?: boolean; panel?: boolean; frame?: string; overlay?: ReactNode;
  onRecorded?: (row: RecordedNodule, scan: ScanMeta, report: (s: SaveState) => void) => void;
  onUndoRecord?: (row: RecordedNodule) => Promise<string | undefined> | void; knownNodules?: (scan: ScanMeta) => Promise<number>; onOpen?: (open: boolean) => void;
  cross?: Vox & { scan: string; tone?: "add" | "remove" }; onScan?: (scan: string | undefined, patients: Patients | null | undefined) => void }) {
  const [scans, setScans] = useState<ScanRow[]>();
  const [error, setError] = useState<string | boolean>(false); // the scan list failed: a practice server's own text, or true (the local engine is not running)
  const scansFailed = (e: Error) => setError(PRACTICE_TEXTS.includes(e.message) ? e.message : true);
  const [openFailed, setOpenFailed] = useState<string>();
  const [picked, setPicked] = useState("");
  const latest = useRef(0);
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<ScanMeta>();
  const [z, setZ] = useState(0);
  const [outline, setOutline] = useState<Outline>();
  const [pending, setPending] = useState<false | "outline" | "edit" | "record" | "find">(false); // one engine request at a time; the kind sets the status line
  const [outlineError, setOutlineError] = useState<string>();
  const [mode, setMode] = useState<Mode>("add");
  const [brush, setBrush] = useState(3); // the brush radius in image pixels; it and Snap stay for the next nodule
  const [snap, setSnap] = useState(false);
  const about_ = useRef<HTMLDialogElement>(null);
  const keys = useRef<HTMLDialogElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<SliceViewHandle>(null);
  const [rows, setRows] = useState(loadRecorded);
  const [current, setCurrent] = useState<RecordedNodule>(); // the row of the outline on the page, once recorded
  const [cleared, setCleared] = useState(() => loadCleared().length); // rows in the backup slot, out of view until Restore
  const [saved, setSaved] = useState<SaveState & { row: RecordedNodule }>(); // the study-table save of the row on the page (hosted only)
  const [copilot, setCopilot] = useState(false); // the engine has a nodule finder and the co-pilot is on
  const [finds, setFinds] = useState<Finds>(); // the finder's suggestions for the scan on the page
  const fromMark = useRef<number>(); // the suggestion whose Measure started the nodule on the page (it counts even if an edit took its voxel out); a hand click, New nodule or a scan switch clears it
  const [notice, setNotice] = useState<string>();
  // Another tab changed the saved table: show its state, so this tab's next change builds on it.
  useEffect(() => {
    const on = (e: StorageEvent) => { const s = reloadFor(e.key); if (s) { setRows(s.rows); setCleared(s.cleared); } };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  // Every change starts from what is saved now, not from this tab's copy, so no tab overwrites another's rows.
  const change = (fn: (fresh: RecordedNodule[]) => RecordedNodule[]) => {
    const next = fn(loadRecorded());
    if (!saveRecorded(next)) setNotice(SAVE_FAILED);
    setRows(next);
  };
  const same = (a: RecordedNodule, b?: RecordedNodule) => !!b && a.outline_file === b.outline_file;
  const started = useRef(0); // when the page sent this nodule's first start request
  const keepClock = useRef(false); // Start over keeps the clock: the next start continues the same nodule's time
  const [proposal, setProposal] = useState<Proposal>();
  // The earlier nodule this nodule follows, with its proposal point: set by a first click while a proposal shows, kept through Start over, cleared by New nodule, a scan switch and Record.
  const link = useRef<Link & { at: Vox }>();
  const earlierInst = useRef<Record<string, number[] | null>>({}); // the earlier scans' image numbers, read once per page

  useEffect(() => { getCopilot().then(setCopilot); }, []);
  useEffect(() => { listScans().then(setScans, scansFailed); }, []);
  const [patients, setPatients] = useState<Patients | null | undefined>(panel ? undefined : null); // undefined: the first GET waits; null: the drop-down stays (not asked, or the route failed or is missing)
  useEffect(() => { if (panel) listPatients().then(setPatients, () => setPatients(null)); }, []);
  const [device, setDevice] = useState<string>(); // read once: "cpu" means the standard-PC mode (about 20 s a click); a failed read keeps the 2 s text
  useEffect(() => { getInfo().then((i) => setDevice(i.device), () => {}); }, []);
  useEffect(() => { onScan?.(scan?.id, patients); }, [scan?.id, patients, onScan]);
  const ring = cross && scan?.id === cross.scan ? cross : undefined;
  useEffect(() => { if (ring) setZ(ring.z); }, [ring?.scan, ring?.z]); // once per cross: the viewer goes to its slice

  // An unrecorded outline with something in it is dropped by a scan switch or New nodule: say so, and log it.
  const discard = () => {
    keepClock.current = false;
    const dropped = !!outline && !current && !isEmpty(outline);
    if (dropped) postEvent({ action: "discard", scan: outline.scan, nodule: outline.nodule });
    setNotice(dropped ? DISCARDED : undefined);
  };

  // Clears the page's outline: the next click starts the nodule again. Nothing recorded is lost, so no confirm.
  const startOver = () => {
    if (!outline || current || pending) return;
    keepClock.current = true;
    postEvent({ action: "start_over", scan: outline.scan, nodule: outline.nodule });
    setOutline(undefined); setOutlineError(undefined); setMode("add"); setNotice(undefined); setProposal(undefined);
  };
  // A key presses the control that shows it, so it does exactly what the control does and only when the control is enabled (and on screen: a hidden hosted tab ignores keys).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = keyFor(e, !!root.current?.querySelector("[data-armed]"));
      const b = k && root.current?.querySelector<HTMLButtonElement>(`[data-key="${k}"]`);
      if (!b || b.disabled || !b.offsetParent) return;
      e.preventDefault();
      b.click();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // Hosted: the scan's next number follows what the study table already holds, so a reload never starts again at 1. Unreachable: this sitting's numbers.
  const [raised, setRaised] = useState(0);
  const raise = (s: ScanMeta, mine: number) => knownNodules?.(s).then((n) => {
    const c = loadCounters(), k = scanKey(s.patient, s.series);
    if (mine === latest.current && n > (c[k] ?? 0)) { saveCounters({ ...c, [k]: n }); setRaised((x) => x + 1); }
  }, () => {});
  // The label Base44 gave a Record (it re-measured an earlier nodule, or follows the study table's numbers) becomes the row's own. A number given up is freed.
  const relabel = (r: RecordedNodule, n: number) => {
    const c = loadCounters(), k = scanKey(r.patient, r.series);
    saveCounters({ ...c, [k]: n > r.nodule ? Math.max(c[k] ?? 0, n) : c[k] === r.nodule ? r.nodule - 1 : c[k] });
    change((fresh) => fresh.map((x) => (same(x, r) ? { ...x, nodule: n } : x)));
    setCurrent((cur) => (cur && same(cur, r) ? { ...cur, nodule: n } : cur));
  };
  const open = (id: string) => {
    discard();
    const mine = ++latest.current;
    setCurrent(undefined);
    setFinds(undefined); fromMark.current = undefined; measuring.current = undefined;
    setScan(undefined);
    setOutline(undefined);
    setOutlineError(undefined);
    setPending(false);
    setMode("add");
    setProposal(undefined);
    link.current = undefined;
    setOpenFailed(undefined);
    setLoading(!!id);
    setPicked(id);
    if (!id) return;
    getScan(id).then(
      (s) => { if (mine === latest.current) { setScan(s); setZ(Math.floor(s.shape[0] / 2)); raise(s, mine); } },
      () => { if (mine === latest.current) setOpenFailed(id); },
    ).finally(() => { if (mine === latest.current) setLoading(false); });
  };

  // One request at a time. A refused correction (400) leaves the engine's nodule as it was, so the outline stays and the error shows.
  // A click or a stroke replaces hand-set axes with measured ones: say so when it did. A stroke or hand-set axes (made or undone) need no model: "Updating" while the engine answers.
  const done = useRef<("click" | "stroke" | "axes")[]>([]); // this nodule's actions the engine accepted, newest last: what Undo takes back
  const run = (call: () => Promise<Outline>, onFail: (message: string) => void, action: "start" | "click" | "stroke" | "axes" | "undo") => {
    const mine = latest.current, handSet = !!outline?.axes_edited, remeasures = action === "click" || action === "stroke";
    const what = action === "undo" ? done.current.at(-1) : action;
    setPending(what === "stroke" || what === "axes" ? "edit" : "outline");
    setOutlineError(undefined);
    call().then(
      (o) => {
        if (mine !== latest.current) return;
        setOutline(o);
        setNotice((n) => (remeasures && handSet && !o.axes_edited ? AXES_CLEARED : n === AXES_CLEARED ? undefined : n));
        done.current = action === "start" ? ["click"] : action === "undo" ? done.current.slice(0, -1) : [...done.current, action];
      },
      (e) => { if (mine === latest.current) { onFail(e.message); setOutlineError(e.message); } },
    ).finally(() => { if (mine === latest.current) setPending(false); });
  };

  // A correction the engine cannot place on our nodule (it restarted, or another tab started one) clears the outline, so the next click starts.
  const forget = (message: string) => { if (dropsNodule(message)) { setOutline(undefined); setCurrent(undefined); } };

  // A first click starts a nodule. While a proposal shows, the start follows its earlier nodule: at the proposal (Measure here) or moved by the click's distance.
  const begin = (p: Vox, confirm = false) => {
    if (!scan) return;
    if (!keepClock.current) started.current = Date.now();
    keepClock.current = false;
    fromMark.current = undefined; // a hand click starts this nodule, even after Start over on a suggestion's
    setNotice(undefined);
    setMode("add"); // a new nodule always starts in Add mode
    // a proposal on screen links this start; without one, a nodule restarted after Start over keeps its link, measured from the same proposal
    const base = proposal?.at ? { follows: proposal.row.outline_file, at: proposal.at } : link.current;
    const next = base && { ...base, map_distance_mm: confirm ? 0 : distanceMm(base.at, p, scan.spacing) };
    const mine = latest.current;
    // the engine drops its nodule only when the model fails (500)
    run(() => startNodule(scan.id, p).then((o) => {
      setCurrent(undefined);
      if (mine === latest.current) { // only a start that succeeded links the nodule and logs its follow-up event
        setProposal(undefined);
        link.current = next;
        if (next) postEvent(confirm ? { action: "followup_confirm", scan: scan.id, follows: next.follows } : { action: "followup_moved", scan: scan.id, follows: next.follows, distance_mm: next.map_distance_mm });
      }
      return o;
    }), () => { setOutline(undefined); setCurrent(undefined); }, "start");
  };
  const pick = ({ y, x, shift }: { y: number; x: number; shift: boolean }) => {
    if (!scan || pending) return;
    const kind = clickKind(outline, mode, shift, !!current);
    if (!kind) return; // Paint, Erase and Axes: a click that reaches here (a press while a stroke was pending) never goes to the model
    if (kind === "start" || !outline) return begin({ z, y, x });
    run(() => correctNodule({ z, y, x }, kind === "add", outline), forget, "click");
  };
  // Paint and Erase on the outline on the page; in Axes mode, a drag of an axis end on axis_z. Both edit only an open (unrecorded, not empty) outline.
  const editable = !!outline && !current && !isEmpty(outline);
  useEffect(() => { onOpen?.(editable); }, [editable]);
  const stroke = (sz: number, points: Pt[]) => { if (outline && !pending) run(() => paintStroke(outline, { z: sz, points, radius: brush, mode: mode === "erase" ? "erase" : "paint", snap }), forget, "stroke"); };
  const dragAxes = (long: [Pt, Pt], short: [Pt, Pt]) => { if (outline && !pending) run(() => setAxes(outline, long, short), forget, "axes"); };
  const measureHere = () => { const a = proposal?.at; if (a && !pending) { setZ(a.z); begin({ z: a.z, y: a.y, x: a.x }, true); } };

  // Find: where the earlier nodule's first click lies on this scan. The view goes there; the researcher confirms or clicks the nodule himself.
  const find = async (r: RecordedNodule) => {
    if (!scan || pending) return;
    const mine = latest.current, from = scanIdOf(r), label = `N${r.nodule}`;
    setPending("find"); setOutlineError(undefined); setNotice(undefined); setProposal({ row: r });
    try {
      const inst = (earlierInst.current[from] ??= (await getScan(from).catch(() => { throw new Error(`Could not open ${from}.`); })).instance_numbers);
      const m = await mapPoint(from, scan.id, firstClick(r, inst));
      if (mine !== latest.current) return;
      if (m.outside) { setProposal({ row: r, outside: true }); return; }
      setProposal({ row: r, at: { z: m.z, y: m.y, x: m.x, label: `${label}?` } });
      setZ(m.z); view.current?.centre(m.y, m.x);
    } catch (e) {
      if (mine === latest.current) { setProposal(undefined); setOutlineError(e instanceof Error ? e.message : String(e)); }
    } finally { if (mine === latest.current) setPending(false); }
  };

  // The finder runs apart from the outline engine: clicks and measuring go on meanwhile. A scan switch drops its answer.
  const findNodules = () => {
    if (!scan) return;
    const id = scan.id, mine = latest.current;
    setFinds({ scan: id });
    findCandidates(id).then((l) => { if (mine === latest.current) setFinds({ scan: id, list: ranked(l) }); },
      (e) => { if (mine === latest.current) setFinds({ scan: id, error: e.message }); });
  };
  // Measure on a suggestion: a new nodule at exactly that voxel, as a first click there would start it. It follows no earlier nodule.
  // ui-b's rule: a click never lands on another image than the indicator's. Measure goes to the suggestion's image and starts
  // only once that image is on screen (onShown); if the indicator moves to another image first, nothing starts.
  const measuring = useRef<Ranked>();
  const measureMark = (c: Ranked) => {
    if (!scan || pending || editable) return; // never drops an open outline, as the follow-up's Measure here
    discard();
    started.current = Date.now();
    setProposal(undefined); link.current = undefined;
    setZ(c.z); view.current?.centre(c.y, c.x); setMode("add");
    if (z === c.z && view.current?.shown() === c.z) startMark(c);
    else { measuring.current = c; setPending("outline"); }
  };
  const onShown = (k: number) => {
    const c = measuring.current;
    if (!c) return;
    measuring.current = undefined;
    if (k === c.z) startMark(c); else setPending(false);
  };
  const startMark = (c: Ranked) => {
    if (!scan) return;
    const id = scan.id, mine = latest.current;
    run(() => startNodule(id, { z: c.z, y: c.y, x: c.x }).then((o) => {
      setCurrent(undefined);
      if (mine === latest.current) { postEvent({ action: "candidate_accept", scan: id, rank: c.rank, score: c.score }); fromMark.current = c.rank; } // only a start that succeeded
      return o;
    }), () => { setOutline(undefined); setCurrent(undefined); }, "start");
  };
  // Not a nodule, and its Undo: the row stays, struck through, with its ring gone and its tick greyed.
  const toggleMark = (c: Ranked) => {
    if (!scan) return;
    postEvent({ action: c.off ? "undo_candidate_reject" : "candidate_reject", scan: scan.id, rank: c.rank, score: c.score });
    setFinds((f) => (f?.list ? { ...f, list: f.list.map((x) => (x.rank === c.rank ? { ...x, off: !x.off } : x)) } : f));
  };

  const record = () => {
    if (!scan || !outline || pending) return;
    const [mine, o, l] = [latest.current, outline, link.current];
    setPending("record");
    setOutlineError(undefined);
    recordNodule(o, l && { follows: l.follows, map_distance_mm: l.map_distance_mm }).then(
      ({ outline_file: file, suggestions }) => {
        if (mine !== latest.current) return;
        const counters = loadCounters();
        const n = nextNodule(loadRecorded(), counters, scan.patient, scan.series);
        const row = { ...toRow(embedded ? { ...scan, study_date: null } : scan, o, n, (Date.now() - started.current) / 1000, file), follows: l?.follows ?? "" };
        rememberScanId(row, scan.id);
        link.current = undefined;
        saveCounters({ ...counters, [scanKey(scan.patient, scan.series)]: n });
        change((fresh) => [...fresh, row]);
        setCurrent(row);
        // measured while this row is in the table: the suggestions the engine found inside the outline, and the one its Measure started from
        const held = new Set([...(suggestions ?? []), ...(fromMark.current ? [fromMark.current] : [])]);
        if (held.size) setFinds((f) => (f?.list && f.scan === scan.id ? { ...f, list: f.list.map((x) => (held.has(x.rank) ? { ...x, files: [...(x.files ?? []), file] } : x)) } : f));
        fromMark.current = undefined;
        setSaved(undefined);
        onRecorded?.(row, scan, (s) => { setSaved({ row, ...s }); if (s.nodule !== undefined && s.nodule !== row.nodule) relabel(row, s.nodule); });
      },
      // a lost reply keeps the outline and the Record button: the engine answers a retry with the same file
      (e) => { if (mine === latest.current) { if (e.message !== ENGINE_STOPPED && e.message !== PRACTICE_STOPPED) forget(e.message); setOutlineError(e.message); } },
    ).finally(() => { if (mine === latest.current) setPending(false); });
  };

  const screenshot = async () => {
    if (!current) return;
    try {
      download(await view.current!.toPNG(), screenshotName(current));
      postEvent({ action: "screenshot", scan: scan?.id, nodule: current.nodule, file: current.outline_file });
    } catch { setNotice("Could not save the screenshot."); }
  };
  const copy = async (r: RecordedNodule) => {
    try {
      await navigator.clipboard.writeText(toTSV(r));
      setNotice(undefined);
      postEvent({ action: "copy_row", scan: scanIdOf(r), nodule: r.nodule, file: r.outline_file });
    } catch { setNotice(COPY_FAILED); }
  };
  const del = (r: RecordedNodule) => {
    change((fresh) => fresh.filter((x) => !same(x, r)));
    postEvent({ action: "delete_row", scan: scanIdOf(r), nodule: r.nodule, file: r.outline_file });
    if (same(r, current)) { setCurrent(undefined); setOutline(undefined); setOutlineError(undefined); setMode("add"); setNotice(DELETED); } // a recorded outline is final: the next click starts anew
  };
  // Undo in the green box takes the Record on the page back, until the next action. The local row goes as Delete takes it (its number is not reused);
  // the hosted page also takes it out of the Study table. The log names the engine's scan and nodule, as the record event does.
  const undoRecord = () => {
    if (!current || !outline) return;
    change((fresh) => fresh.filter((x) => !same(x, current)));
    postEvent({ action: "undo_record", scan: outline.scan, nodule: outline.nodule, undoes: current.outline_file });
    const later = onUndoRecord?.(current);
    setCurrent(undefined); setOutline(undefined); setOutlineError(undefined); setMode("add"); setNotice(UNDONE);
    void Promise.resolve(later).then((n) => n && setNotice((x) => (x === UNDONE ? n : x))); // unless a newer notice took its place
  };
  // Undo after Delete: the row goes back where it was; the scan's counter never went down, so no number is reused.
  const undoDelete = (r: RecordedNodule, index: number) => {
    change((fresh) => restoreRow(fresh, r, index));
    setNotice((n) => (n === DELETED ? undefined : n));
    postEvent({ action: "undo_delete_row", scan: scanIdOf(r), nodule: r.nodule, file: r.outline_file });
  };
  const exportCSV = () => { download(new Blob([toCSV(rows)], { type: "text/csv" }), "lung-measurements.csv"); postEvent({ action: "export_csv", rows: rows.length }); };
  // Order: build the CSV, keep the backup, download, clear. Nothing is cleared if either of the first two fails; counters stay, so numbers are never reused.
  const clearTable = () => {
    const fresh = loadRecorded(), n = fresh.length, blob = new Blob([toCSV(fresh)], { type: "text/csv" });
    if (!backUpRows(fresh)) { setNotice(NO_BACKUP); return; }
    download(blob, "lung-measurements.csv"); setNotice(undefined); change(() => []); setCleared(loadCleared().length);
    postEvent({ action: "clear_table", rows: n });
  };
  const restore = () => {
    const back = loadCleared().length, next = restoreCleared();
    if (!next) { setNotice(SAVE_FAILED); return; }
    setRows(next); setCleared(0);
    postEvent({ action: "restore_table", rows: back });
  };
  const forgetBackup = () => { forgetCleared(); setCleared(0); };

  const byPatient = new Map<string, ScanRow[]>();
  for (const s of scans ?? []) byPatient.set(s.patient, [...(byPatient.get(s.patient) ?? []), s]);
  const counters = useMemo(loadCounters, [rows, current, scan, raised]); // browser storage: read when the table, the nodule or the study table's numbers change
  const nodule = scan && (current?.nodule ?? nextNodule(rows, counters, scan.patient, scan.series));
  const earlier = useMemo(() => (scan ? earlierRows(rows, scan.patient, scan.series) : []), [rows, scan]);
  const label = proposal && `N${proposal.row.nodule}`;
  const counts = useMemo(() => countsOf(rows), [rows]); // the frame's chips: codes and counts only
  const select = (
    <label className="m-pick">
      Scan
      <select value={picked} onChange={(e) => { open(e.target.value); e.target.blur(); }} disabled={!scans || !!pending}>
        <option value="">{error === true ? "Engine not running" : error ? "Scans not available" : scans ? "Choose a scan" : "Loading scans…"}</option>
        {[...byPatient].map(([patient, rows]) => (
          <optgroup key={patient} label={patient}>
            {rows.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
  const measured = useMemo(() => withMeasured(finds?.list, rows), [finds, rows]);

  return (
    // A mouse click leaves no focus on a button, so Enter and the letter keys go to the page next, not to that button again.
    <div ref={root} className={embedded ? "m-app embedded" : "m-app"} onClick={(e) => { if (e.detail > 0) (e.target as Element).closest("button")?.blur(); }}>
      <header className="m-bar">
        {!embedded && <><Logo /><span className="m-tag">Research aid</span></>}
        {patients !== null ? <PatientsPanel data={patients} current={picked} rows={rows} practice={embedded} busy={!!pending} onOpen={open} onChosen={setPatients} />
          : frame ? <PatientsFrame engine={frame} current={picked} counts={counts} busy={!!pending} onOpen={open} fallback={select} /> : select}
      </header>
      <div className="m-main" role={embedded ? undefined : "main"}>
        <section className="m-viewer" aria-label="Image viewer">
          {overlay ? <div className="m-empty">{overlay}</div> : scan ? (
            <SliceView ref={view} caption={current ? captionLines(current) : undefined} scan={scan} z={z} onZ={setZ} outline={outline} pending={!!pending} onPick={pick} target={proposal?.at ?? ring}
              brush={editable && (mode === "paint" || mode === "erase") ? { radius: brush, erase: mode === "erase" } : undefined} onStroke={stroke} onAxes={editable && mode === "axes" ? dragAxes : undefined}
              suggestions={measured} onShown={onShown} corner={copilot && <Copilot key={scan.id} finds={finds && { ...finds, list: measured }} z={z} busy={!!pending || editable} hold={editable ? HOLD : undefined} onFind={findNodules}
                onGo={(c) => { setZ(c.z); view.current?.centre(c.y, c.x); }} onMeasure={measureMark} onToggle={toggleMark} />} />
          ) : (
            <div className="m-empty">
              {error ? <p role="alert">{error === true ? "Engine not running. Start it with the command in README." : error}</p>
                : scans?.length === 0 ? <p role="alert">No scans found. Fetch the data (README step 1) or set LUNG_DATA_DIR.</p>
                : openFailed ? <p role="alert">{`Could not open ${openFailed}.`}</p>
                : loading ? <p>Loading scan…</p>
                : <p>{scans ? "Choose a scan to start." : "Looking for scans…"}</p>}
            </div>
          )}
          <RecordedTable embedded={embedded} rows={rows} current={current} cleared={cleared} onCopy={copy} onDelete={del} onUndoDelete={undoDelete}
            onExport={exportCSV} onClear={clearTable} onRestore={restore} onForget={forgetBackup} />
        </section>
        <Panel save={saved && same(saved.row, current) ? saved : undefined} recorded={outline && current?.nodule} onRecord={record}
          onCopy={current && rows.some((x) => same(x, current)) ? () => copy(current) : undefined} onScreenshot={current && rows.some((x) => same(x, current)) ? screenshot : undefined}
          onUndoRecord={current && rows.some((x) => same(x, current)) ? undoRecord : undefined} outline={outline} pending={pending} error={overlay ? undefined : outlineError} instanceNumbers={scan?.instance_numbers ?? null}
          mode={mode} onMode={setMode} brush={brush} onBrush={setBrush} snap={snap} onSnap={setSnap} onUndo={() => outline && run(() => undoClick(outline), forget, "undo")} onStartOver={startOver}
          onGoToAxisSlice={() => outline?.axis_z != null && setZ(outline.axis_z)}
          // clears only the page: the engine keeps its nodule until the next click replaces it
          onNew={() => { discard(); fromMark.current = undefined; setCurrent(undefined); setOutline(undefined); setOutlineError(undefined); setMode("add"); setProposal(undefined); link.current = undefined; }}
          nodule={nodule} idle={scan ? undefined : "Choose a scan, then click a nodule to outline it."} notice={notice} onKeys={() => keys.current?.showModal()} device={device}
          followup={earlier.length > 0 && <Earlier rows={earlier} proposed={proposal?.at && proposal.row.outline_file} busy={!!pending} open={!!outline && !current && !isEmpty(outline)} onFind={find} onMeasure={measureHere} />}
          finding={label && `Finding ${label} on this scan… about 15 s the first time`}
          proposal={proposal?.outside ? { text: `${label} maps outside this scan. Find it by hand.`, warn: true }
            : proposal?.at && { text: `${label}? Check here.`, hint: "Measure here (M) outlines it at the ring. If the ring is off, click the nodule yourself." }} />
      </div>
      {!embedded && (
        <footer className="m-foot">
          <span>Research use only. Not a medical device.</span>
          <span className="grow" />
          <span>Images: RIDER Lung CT, The Cancer Imaging Archive (TCIA), CC BY 4.0</span>
          <a href="#about" onClick={(e) => { e.preventDefault(); about_.current?.showModal(); }}>About</a>
        </footer>
      )}
      {/* closing gives focus back to the Shortcuts button: drop it, so Enter records again */}
      <dialog ref={keys} aria-label="Keyboard shortcuts" onClose={() => (document.activeElement as HTMLElement | null)?.blur()}>
        <h2>Keyboard shortcuts</h2>
        <table className="m-keys"><tbody>
          {SHORTCUTS.filter(([, what]) => what !== STEPS || patients !== null || !!frame).map(([k, what]) => <tr key={what}><td>{k}</td><td>{what}</td></tr>)}{/* the steps only where the Patients button shows (or its frame) */}
        </tbody></table>
        <form method="dialog"><button>Close</button></form>
      </dialog>
      {!embedded && <About dialog={about_} />}
    </div>
  );
}
