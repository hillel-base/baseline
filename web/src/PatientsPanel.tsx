import { useEffect, useRef, useState } from "react";
import type { PatientScan, Patients } from "./api";
import { FolderPanel } from "./FolderPanel";
import { buttonLabel, byActivity, chip, countText, locate, patientCount, recordedOn, scanTitle, scansLine, search } from "./patients";
import type { RecordedNodule } from "./record";
import { sheetTraps, stepKey, wrapTab } from "./ui";

// The panel's texts. A practice server lists public RIDER test/retest pairs, so its lines are fixed.
const PRACTICE_LINE: Record<PatientScan["timepoint"], string> = { Baseline: "", "Follow-up": "a repeat scan, for measuring twice", Undated: "" };

type SheetProps = { data: Patients; current: string; rows: RecordedNodule[]; practice: boolean; busy: boolean; onOpen: (id: string) => void; onChangeFolder: () => void };

/** The sheet's content: patients on the left (newest activity first), the shown patient's scans oldest first on the right, the folder line below.
 *  Mounted on each open, so the search starts empty and the open scan's patient shows. */
export function Sheet({ data, current, rows, practice, busy, onOpen, onChangeFolder }: SheetProps) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(() => locate(data.patients, current)?.patient.key);
  const list = search(byActivity(data.patients, rows), q);
  const p = list.find((x) => x.key === shown) ?? list[0]; // a search that leaves the shown patient out shows its first match
  const { folder } = data;
  const fewer = data.patients.filter((x) => x.source === "data").length; // the data folder's practice patients: a local install has 8 of the 28 until fetch --all
  return <>
    <div className="pp-left">
      {!practice && <label className="pp-search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search patients" aria-label="Search patients" value={q} onChange={(e) => setQ(e.target.value)} /></label>}
      <div className="pp-lab">{practice ? "Practice patients · public scans" : `Patients · ${list.length}`}</div>
      <div className="pp-list">
        {list.map((x) => (
          <button key={x.key} className={x === p ? "pp-pt on" : "pp-pt"} aria-pressed={x === p} onClick={() => setShown(x.key)}>
            <b>{x.name}</b><small>{practice && x.scans.length === 2 ? "Baseline and follow-up" : scansLine(x)}</small><span className="pp-n">{countText(patientCount(x, rows), practice)}</span>
          </button>
        ))}
        {!list.length && <p className="pp-none">{q ? "No patient matches." : "No patients yet."}</p>}
      </div>
    </div>
    <div className="pp-right">
      {p && <>
        <div className="pp-rh"><b>{p.name}</b><span>{practice ? "RIDER Lung CT, TCIA" : p.scans.length === 1 ? "1 scan" : `${p.scans.length} scans, oldest first`}</span></div>
        <ol className="pp-tl">
          {p.scans.map((s) => {
            const cur = s.id === current, n = recordedOn(rows, s.id), title = scanTitle(s), line = practice || p.source === "data" ? PRACTICE_LINE[s.timepoint] : s.label; // the data folder holds the public practice scans: their lines, not RIDER's series names
            return (
              <li key={s.id} className={cur ? "pp-sc cur" : "pp-sc"}>
                <b>{title}</b>
                <small>{line}{cur && <span className="pp-nw">{line ? " · open now" : "open now"}</span>}</small>
                <span className="pp-act"><span className={n ? "pp-chip ok" : "pp-chip"}>{chip(n)}</span>
                  <button className={cur ? "m-btn sm primary" : "m-btn sm"} disabled={busy} onClick={() => onOpen(s.id)} aria-label={`Open ${title}`}>Open</button></span>
              </li>
            );
          })}
        </ol>
      </>}
    </div>
    <div className="pp-foot">
      {practice ? <span>All 28 public practice patients. No folders on a practice server.</span> : <>
        {folder.error && <span className="pp-error" role="alert">{folder.error}</span>}
        {folder.path != null ? <span>Folder: /{folder.path}</span> : !folder.from && <span>No study folder chosen yet.</span>}
        {folder.path == null && !folder.from && fewer > 0 && fewer < 28 && <span>{fewer} of 28 practice patients. For all 28, run <code>./lung.sh fetch --all</code> in the Baseline folder (Windows: <code>.\lung.ps1 fetch --all</code>).</span>}
        {folder.from === "LUNG_STUDY_DIR" ? <span>Set by LUNG_STUDY_DIR on this computer.</span> : <button className="m-btn sm ghost" onClick={onChangeFolder}>Change folder…</button>}
        <span className="grow" />
        <span className="pp-privacy"><i aria-hidden="true" />Names and dates are shown by your computer; Base44 receives only codes.</span>
      </>}
    </div>
  </>;
}

/** The Patients button in place of the Scan drop-down, the patient's other scans beside it (Alt+← / Alt+→ press them), and the sheet over the viewer.
 *  data: undefined while the first GET waits (indexing a big folder takes seconds). Opening a scan calls onOpen, exactly as choosing it in the drop-down did. */
export function PatientsPanel({ data, current, rows, practice, busy, onOpen, onChosen, onSheet }: { data?: Patients; current: string; rows: RecordedNodule[]; practice: boolean; busy: boolean;
  onOpen: (id: string) => void; onChosen: (p: Patients) => void; onSheet?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false); // Change folder…: the folder browser takes the sheet's place
  const reading = useRef(false); // the folder browser's Use this folder is reading: Esc waits (the read cannot be cancelled)
  const btn = useRef<HTMLButtonElement>(null), sheet = useRef<HTMLDivElement>(null);
  const fromKeys = useRef(false); // opened from the keyboard: Esc gives the focus back to the button
  const close = () => { setOpen(false); setChoosing(false); }; // after Open the focus stays off the button, so Enter records
  const dismiss = () => { close(); if (fromKeys.current) btn.current?.focus(); };
  useEffect(() => { onSheet?.(open); }, [open]); // the hosted page's frame grows to the sheet and back
  useEffect(() => { // Alt+←/→ is never the browser's Back or Forward while this button shows
    const keep = (e: KeyboardEvent) => { if (stepKey(e)) e.preventDefault(); };
    window.addEventListener("keydown", keep);
    return () => window.removeEventListener("keydown", keep);
  }, []);
  useEffect(() => { // While open, no key reaches the Measure controls or the viewer, and Tab stays in the sheet
    if (!open) return;
    const trap = (e: KeyboardEvent) => {
      if (e.key === "Escape") return choosing ? !reading.current && setChoosing(false) : dismiss(); // (a) in Change folder…, Esc goes back to the patient list
      if (e.key === "Tab" && sheet.current) {
        const f = [...sheet.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]")];
        const i = wrapTab(f.indexOf(document.activeElement as HTMLElement), f.length, e.shiftKey);
        if (i >= 0) { e.preventDefault(); f[i]?.focus(); }
      }
      if (sheetTraps(e)) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", trap, true);
    return () => window.removeEventListener("keydown", trap, true);
  }, [open, choosing]);
  useEffect(() => { // The focus goes into the sheet: the search box, else the shown patient's row; the folder browser gets the sheet itself
    const s = sheet.current;
    if (open && s) (choosing ? s : s.querySelector<HTMLElement>('input[type="search"], .pp-pt[aria-pressed="true"]') ?? s).focus();
  }, [open, choosing]);
  const at = data && locate(data.patients, current);
  const step = (s: PatientScan | undefined, key: "prev" | "next") => s && (
    <button className="m-btn sm ghost pp-step" data-key={key} aria-keyshortcuts={key === "prev" ? "Alt+ArrowLeft" : "Alt+ArrowRight"} title={key === "prev" ? "Alt+←" : "Alt+→"}
      disabled={busy} onClick={() => { close(); onOpen(s.id); }}>{key === "prev" ? `‹ ${s.timepoint}` : `${s.timepoint} ›`}</button>);
  return (
    <div className="pp">
      <button ref={btn} className="pp-btn" aria-haspopup="dialog" aria-expanded={open} disabled={!data || busy} title={at ? buttonLabel(at.patient, at.scan) : undefined}
        onClick={(e) => { if (open) close(); else { fromKeys.current = e.detail === 0; setOpen(true); } }}>
        {!data ? <span>{practice ? "Loading scans…" : "Reading the folder…"}</span>
          : at ? <><b>{at.patient.name}</b><span className="sr-only"> · </span><span>{scanTitle(at.scan)}</span></>
          : <span>{current || "Choose a scan"}</span>}
        <span className="pp-caret" aria-hidden="true">▾</span>
      </button>
      <span className="pp-steps">{step(at?.prev, "prev")}{step(at?.next, "next")}</span>{/* room for both, always: a step coming or going never wraps the bar */}
      {open && data && <div className="pp-backdrop" onClick={() => { if (!reading.current) close(); }} />}{/* a mouse click: no focus back on the button, so Enter records (Esc gives it back to a keyboard opener) */}{/* a click beside the sheet only closes it: it never reaches the image as a first click */}
      {open && data && (
        <div ref={sheet} className={choosing ? "pp-sheet choosing" : "pp-sheet"} role="dialog" aria-modal="true" aria-label="Patients" tabIndex={-1}>
          {choosing ? <FolderPanel onClose={() => setChoosing(false)} onChosen={(p) => { onChosen(p); setChoosing(false); }} onBusy={(b) => { reading.current = b; }} />
            : <Sheet data={data} current={current} rows={rows} practice={practice} busy={busy} onChangeFolder={() => setChoosing(true)}
              onOpen={(id) => { close(); if (id !== current) onOpen(id); }} />}
        </div>
      )}
    </div>
  );
}
