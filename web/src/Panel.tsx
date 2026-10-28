import type { ReactNode } from "react";
import type { Outline } from "./api";
import { BRUSH_MAX, BRUSH_MIN, isEmpty, type Mode } from "./clicks";
import type { RecordedNodule } from "./record";
import { NOT_SAVED, SAVED, SAVING, riderTimepoint, tpName, type SaveState } from "./study";
import { workingText } from "./ui";

type Props = { outline?: Outline; pending: boolean | "outline" | "edit" | "record" | "find"; error?: string; instanceNumbers: number[] | null; mode?: Mode; onMode?: (m: Mode) => void; onUndo?: () => void; onStartOver?: () => void; onGoToAxisSlice: () => void; onNew: () => void;
  brush?: number; onBrush?: (radius: number) => void; snap?: boolean; onSnap?: (on: boolean) => void; // the brush radius in image pixels and Snap to tissue (Paint and Erase)
  recorded?: number; onRecord?: () => void; onCopy?: () => void; onScreenshot?: () => void;
  onUndoRecord?: () => void; save?: SaveState; // Undo of the Record on the page; its study-table save (hosted)
  nodule?: number; idle?: string; notice?: string; onKeys?: () => void; device?: string; // device: the engine's, from /api/info // nodule: the number this outline gets (or got); idle: the status before any click
  followup?: ReactNode; finding?: string; proposal?: { text: string; hint?: string; warn?: boolean } }; // follow-up scans: the Earlier nodules section, the status while finding, and the proposal's status

/** "On Images 86–143 (72.5 mm top to bottom)": the outline's first and last slice, as shown numbers. */
function span(o: Outline, inst: number[] | null) {
  const [z0, z1] = [o.bbox![0], o.bbox![3] - 1];
  const [a, b] = (inst ? [inst[z0], inst[z1]] : [z0 + 1, z1 + 1]).sort((p, q) => p - q);
  return `On ${inst ? "Image" : "slice"}${a === b ? "" : "s"} ${a === b ? a : `${a}–${b}`} (${o.depth_mm.toFixed(1)} mm top to bottom)`;
}

const EDGE = "The outline reaches the edge of the model's window. Check it, and if it is cut, click beyond the edge with Add.";
const Kbd = ({ k, on }: { k: string; on?: boolean }) => <kbd className={on ? "k k-on" : "k"}>{k}</kbd>;
const Check = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></svg>;
const Warn = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4.5M12 17.5v.01" /></svg>;
// The value with a space before its unit, so the text reads "Volume 6.90 mL" when copied or read aloud.
const Value = ({ v, unit, big }: { v?: string; unit: string; big?: boolean }) => <div className="num"><span className={`${big ? "m-volume" : "m-axis"}${v ? "" : " m-none"}`}>{v ?? "—"}</span> <span className="m-unit">{unit}</span></div>;

/** Follow-up scans: the earlier scan's recorded nodules, each with Find; Measure here (M) beside the one whose proposal is on screen. */
export function Earlier({ rows, proposed, busy, open, onFind, onMeasure }: { rows: RecordedNodule[]; proposed?: string; busy: boolean; open: boolean;
  onFind: (r: RecordedNodule) => void; onMeasure: () => void }) { // proposed: that row's outline_file; open: an unrecorded outline is on the page
  return (
    <div className="m-tools-panel" role="group" aria-label="Earlier nodules">
      {/* the rows are all of one scan (followup.ts), so the heading names it once and each row stays one line */}
      <div className="m-earlier-head"><h3 className="m-sub">Earlier nodules</h3>{rows[0] && <span className="small muted">{`from the ${tpName(riderTimepoint(rows[0].series))}`}</span>}</div>
      {rows.map((r) => (
        <div className="m-earlier" key={r.outline_file}>
          <span className="m-earlier-t">{`N${r.nodule} · ${r.slice_label === "image" ? "Image" : "Slice index"} ${r.slice}`}</span>
          <span className="m-row">
            {proposed === r.outline_file && <button className="m-btn sm" aria-label="Measure here (M)" data-key="m" disabled={busy || open} onClick={onMeasure}>Measure here<Kbd k="M" on={!busy && !open} /></button>}
            <button className="m-btn sm" aria-label={`Find N${r.nodule}`} disabled={busy || open} onClick={() => onFind(r)}>Find</button>
          </span>
        </div>
      ))}
      {/* its room is kept while hidden, so the card below never moves */}
      <div className="small muted" style={open ? undefined : { visibility: "hidden" }}>Record this nodule or start a new one to find another.</div>
    </div>
  );
}

// Two labelled rows: the model's clicks, and edits made by hand. Proposed for review.
const MODES: [string, [Mode, string, string][]][] = [["Clicks", [["add", "Add", "A"], ["remove", "Remove", "R"]]], ["By hand", [["paint", "Paint", "P"], ["erase", "Erase", "E"], ["axes", "Axes", "X"]]]];

export function Panel({ outline, pending, error, instanceNumbers, mode = "add", onMode, brush = 3, onBrush, snap = false, onSnap, onUndo, onStartOver, onGoToAxisSlice, onNew, recorded, onRecord, onCopy, onScreenshot, onUndoRecord, save, nodule, idle, notice, onKeys, device, followup, finding, proposal }: Props) {
  const measured = !!outline && !isEmpty(outline);
  const done = recorded !== undefined;
  const step = done ? 4 : pending === "record" ? 3 : measured ? 2 : 1; // 4: all three done
  const brushing = mode === "paint" || mode === "erase";
  const status = pending ? (
    <div className="m-status busy" role="status"><b>{pending === "record" ? "Recording…" : pending === "find" ? finding : pending === "edit" ? "Updating the outline…" : workingText(device)}</b><div className="m-bar-run" aria-hidden="true" /></div>
  ) : error ? (
    <div className="m-status warn" role="alert"><Warn /><span>{error}</span></div>
  ) : proposal?.warn ? (
    <div className="m-status warn" role="status"><Warn /><span>{proposal.text}</span></div>
  ) : proposal ? (
    <div className="m-status" role="status"><div><b>{proposal.text}</b>{proposal.hint && <div className="small muted">{proposal.hint}</div>}</div></div>
  ) : outline && !measured ? (
    <div className="m-status warn" role="status"><Warn /><span>No outline here. Click the nodule again.</span></div>
  ) : done ? (
    // a save that waits: one amber box in plain words, with the Record's actions (the error itself goes to the event log)
    <div className={save?.state === "waiting" ? "m-status ok warn" : "m-status ok"} role="status">
      {save?.state === "waiting" ? <><Warn /><b className="grow">{NOT_SAVED}</b></> : <><Check /><b className="grow">{`Recorded as nodule ${recorded}.`}</b></>}
      {/* lines that arrive later sit above the actions: the box grows upward, so its buttons never move */}
      {(save?.state === "saving" || save?.state === "saved") && <span className="small m-line">{save.state === "saving" ? SAVING : SAVED}</span>}
      {save?.replaces && <span className="small m-line">{save.replaces}</span>}
      {save?.note && <span className="small m-line">{save.note}</span>}
      {/* the Record step's next actions, in the run sheet's order, here whether the table is open or folded */}
      {(onCopy || onScreenshot || onUndoRecord) && <span className="m-acts">{onCopy && <button className="m-btn sm" onClick={onCopy}>Copy row</button>}{onScreenshot && <button className="m-btn sm" onClick={onScreenshot}>Save screenshot</button>}
        {onUndoRecord && <button className="m-btn sm" aria-label="Undo this Record" onClick={onUndoRecord}>Undo</button>}</span>}</div>
  ) : measured && outline.at_window_edge ? (
    <div className="m-status warn" role="alert"><Warn /><span>{EDGE}</span></div>
  ) : measured ? (
    <div className="m-status" role="status"><Check /><div><b>Outline ready.</b><div className="small muted">{outline.axes_edited ? "Axes set by hand. A click or stroke measures them again." : "Check the edges on a few images. Correct with Add or Remove, then record."} Not saved yet: Record saves this nodule to the table.</div></div></div>
  ) : (
    <div className="m-status" role="status"><span>{idle ?? "Click a nodule to outline it."}</span></div>
  );
  return (
    <section className="m-panel" aria-label="Measurements">
      <div className="m-panel-body">
        {(nodule !== undefined || onKeys) && (
          <div className="m-head">
            {nodule !== undefined && <h2>{`Nodule ${nodule}`}</h2>}
            {done ? <span className="m-state ok">Recorded</span> : pending ? <span className="m-state">{pending === "record" ? "Recording" : pending === "find" ? "Finding" : "Outlining"}</span> : measured && <span className="m-state">Not saved yet</span>}
            <span className="grow" />
            {onKeys && <button className="m-link" aria-label="Keyboard shortcuts (?)" data-key="?" onClick={onKeys}>Shortcuts<Kbd k="?" /></button>}
          </div>
        )}
        <ol className="m-steps" aria-label="Steps">
          {["Click nodule", "Check, correct", "Record"].map((s, i) => <li key={s} aria-current={i + 1 === step ? "step" : undefined}>{`${i + 1 < step ? "✓" : i + 1} ${s}`}</li>)}
        </ol>
        {followup}
        <div className="m-card">
          <div><div className="small muted">Volume</div> <Value v={measured ? outline.volume_ml.toFixed(2) : undefined} unit="mL" big /></div>
          <div className="m-axes">
            <div><div className="small muted m-key"><span className="key" style={{ background: "var(--ov-long)" }} aria-hidden="true" />Long axis</div> <Value v={measured ? outline.long_mm.toFixed(1) : undefined} unit="mm" /></div>
            <div><div className="small muted m-key"><span className="key" style={{ background: "var(--ov-short)" }} aria-hidden="true" />Short axis</div> <Value v={measured ? outline.short_mm.toFixed(1) : undefined} unit="mm" /></div>
          </div>
          <div className="m-depth">
            {measured && outline.bbox ? (
              <>
                <div className="num">{span(outline, instanceNumbers)}</div>
                <div className="small muted">{outline.axes_edited ? "Axes set by hand" : `Widths measured ${outline.width_method}`}</div>{/* one line either way: the card keeps its height */}
                <button className="m-btn sm m-goto" aria-label="Go to largest slice (G)" data-key="g" onClick={onGoToAxisSlice}>Go to largest slice<Kbd k="G" /></button>
              </>
            ) : <div className="small muted">The numbers appear when the outline is ready.</div>}
          </div>
        </div>
        {!done && (
          <div className="m-tools-panel" role="group" aria-label="Correct the outline">
            {/* Not colour alone: the active mode is bold on a lighter ground, and its key hint lights up. */}
            {MODES.map(([label, row]) => (
              <div key={label} className="m-mode-row" role="group" aria-label={label}>
                <span className="small muted">{label}</span>
                <div className="m-seg">
                  {row.map(([m, name, k]) => <button key={m} aria-pressed={mode === m} aria-label={`${name} (${k})`} data-key={k.toLowerCase()} disabled={!outline} onClick={() => onMode?.(m)}>{name}<Kbd k={k} on={mode === m} /></button>)}
                </div>
              </div>
            ))}
            {/* The brush row is laid out in every mode (hidden and disabled outside Paint and Erase) and the hint sits on top of it, so the row is as tall
                as the brush row even when it wraps: switching modes never moves Undo and Start over. */}
            <div className="m-opts">
              <div className="m-row m-brush" style={brushing ? undefined : { visibility: "hidden" }}>
                <span className="num small">{`Brush ${brush} px`}</span>
                <button className="m-btn sm" aria-label="Smaller brush ([)" data-key="[" disabled={!brushing || brush <= BRUSH_MIN} onClick={() => onBrush?.(brush - 1)}>−<Kbd k="[" /></button>
                <button className="m-btn sm" aria-label="Larger brush (])" data-key="]" disabled={!brushing || brush >= BRUSH_MAX} onClick={() => onBrush?.(brush + 1)}>+<Kbd k="]" /></button>
                {/* erase ignores Snap: it removes every pixel under the brush */}
                <button className="m-btn sm" aria-pressed={snap} aria-label="Snap to tissue (T)" data-key="t" disabled={mode !== "paint"} onClick={() => onSnap?.(!snap)}>Snap to tissue<Kbd k="T" on={snap && mode === "paint"} /></button>
              </div>
              {!brushing && <div className="small muted">{mode === "axes" ? "Drag an end of an axis line on the largest slice." : <>Hold <Kbd k="Shift" /> to remove for one click.</>}</div>}
            </div>
            <div className="m-row">
              <button className="m-btn" aria-label="Undo (U)" data-key="u" onClick={onUndo} disabled={!!pending || !outline?.can_undo}>Undo<Kbd k="U" /></button>
              <button className="m-btn" aria-label="Start over (S)" data-key="s" onClick={onStartOver} disabled={!!pending || !outline}>Start over<Kbd k="S" /></button>
            </div>
            {nodule !== undefined && <div className="small muted m-hint-tall">{`Start over throws away this outline. Your next click starts nodule ${nodule} again.`}</div>}
          </div>
        )}
      </div>
      {/* the foot sits on the panel's bottom edge: a notice goes above the status box, so it never moves the box or its buttons */}
      <div className="m-panel-foot">
        {notice && <p className="m-notice" role="status">{notice}</p>}
        {status}
        {done ? (
          <>
            <button className="m-btn primary wide" aria-label="New nodule (N)" data-key="n" onClick={onNew} disabled={!!pending}>New nodule<Kbd k="N" on /></button>
            <button className="m-btn wide" disabled>Recorded</button>
          </>
        ) : (
          <>
            <button className="m-btn primary wide" aria-label="Record nodule (Enter)" data-key="enter" onClick={onRecord} disabled={!!pending || !measured}>Record nodule<Kbd k="Enter" on={measured && !pending} /></button>
            <button className="m-btn wide" aria-label="New nodule (N)" data-key="n" onClick={onNew} disabled={!!pending || (!outline && !error)}>New nodule<Kbd k="N" /></button>
          </>
        )}
      </div>
    </section>
  );
}
