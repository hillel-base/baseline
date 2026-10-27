import { useEffect, useRef, useState } from "react";
import type { RecordedNodule } from "./record";
import { ARM_MS, DRAWER_H, DRAWER_MIN, UNDO_MS, clampDrawer, deletePress, type Armed } from "./ui";

type Props = { embedded?: boolean; rows: RecordedNodule[]; current?: RecordedNodule; cleared: number;
  onCopy: (r: RecordedNodule) => void; onDelete: (r: RecordedNodule) => void; onUndoDelete: (r: RecordedNodule, index: number) => void;
  onExport: () => void; onClear: () => void; onRestore: () => void; onForget: () => void };

const KEY = "lung.drawer";
type Drawer = { open: boolean; h: number };
/** The remembered drawer (open or folded, and its height); folded at the default height the first time. The hosted page keeps nothing in the browser. */
function stored(embedded?: boolean): Drawer {
  const first = { open: false, h: DRAWER_H };
  if (embedded) return first;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return { open: v?.open === true, h: Number.isFinite(v?.h) ? Math.max(DRAWER_MIN, v.h) : DRAWER_H };
  } catch { return first; }
}

/** The recorded-nodules drawer under the image. Only its toggle opens or folds it (a Record does not), and open it has a fixed height, so a new row
 *  never resizes the image; the grip on its top edge resizes it. Both are remembered; a double-click on the grip resets the height.
 *  Delete asks once more in place for 3 s (no pop-up), then offers Undo for a few seconds. */
export function RecordedTable({ embedded, rows, current, cleared, onCopy, onDelete, onUndoDelete, onExport, onClear, onRestore, onForget }: Props) {
  const [armed, setArmed] = useState<Armed>();
  const [undo, setUndo] = useState<{ row: RecordedNodule; index: number }>();
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(undefined), ARM_MS); return () => clearTimeout(t); }, [armed]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(undefined), UNDO_MS); return () => clearTimeout(t); }, [undo]);
  const press = (r: RecordedNodule, index: number) => {
    const now = Date.now();
    if (deletePress(armed, r.outline_file, now) === "arm") { setArmed({ file: r.outline_file, at: now }); return; }
    setArmed(undefined); setUndo({ row: r, index }); onDelete(r);
  };
  const [{ open, h: height }, setDrawer] = useState(() => stored(embedded));
  const box = useRef<HTMLElement>(null), drag = useRef<{ y: number; h: number; last?: number }>();
  const keep = (d: Drawer) => {
    setDrawer(d);
    if (!embedded) try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* not remembered: still works */ }
  };
  // while dragging: shown only; kept on release
  const resize = (h: number) => { const n = clampDrawer(h, box.current?.parentElement?.clientHeight ?? innerHeight); setDrawer({ open, h: n }); return n; };
  const show = open && rows.length > 0;
  // the current row (just recorded) stays in view inside the fixed height
  useEffect(() => { box.current?.querySelector("tr.current")?.scrollIntoView({ block: "nearest" }); }, [current?.outline_file, show]);
  const shown = () => box.current?.offsetHeight ?? height; // the height on screen: the CSS cap can hold it below the stored one
  return (
    <section ref={box} className={open ? "m-drawer open" : "m-drawer"} style={open ? { height } : undefined} aria-label="Recorded nodules">
      {open && <div className="m-drawer-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the recorded-nodules table" tabIndex={0}
        aria-valuenow={height} aria-valuemin={DRAWER_MIN} title="Drag to resize. Double-click to reset."
        onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, h: shown() }; }}
        onPointerMove={(e) => { if (drag.current) drag.current.last = resize(drag.current.h + drag.current.y - e.clientY); }}
        onPointerUp={() => { if (drag.current?.last) keep({ open, h: drag.current.last }); drag.current = undefined; }}
        onLostPointerCapture={() => { drag.current = undefined; }} // after pointerup or pointercancel
        onDoubleClick={() => keep({ open, h: DRAWER_H })}
        // the arrows here resize the table; they must not also reach the window's slice keys
        onKeyDown={(e) => { if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault(); e.stopPropagation(); keep({ open, h: resize(shown() + (e.key === "ArrowUp" ? 16 : -16)) }); }} />}
      <div className="m-drawer-bar">
        {/* hosted: "This browser's table", so it is not taken for the Study table in Base44 */}
        <h2 className="m-drawer-h"><button className="m-drawer-toggle" aria-expanded={open} onClick={() => keep({ open: !open, h: height })}>
          <span aria-hidden="true" className="muted">{open ? "▾" : "▸"}</span>{embedded ? "This browser's table" : "Recorded nodules"} <span className="m-count num">{rows.length}</span>
        </button></h2>
        {/* hosted: the note shows from the start, so the bar's height does not change on the first Record */}
        {undo ? <span role="status" className="small">Row deleted. <button className="m-btn sm" onClick={() => { onUndoDelete(undo.row, undo.index); setUndo(undefined); }}>Undo</button></span>
          : embedded ? <span className="small muted">Kept in this browser tab only. Reloading empties it. The Study table is the lasting record.</span>
          : rows.length === 0 && cleared === 0 && <span className="small muted">Nothing recorded in this sitting yet.</span>}
        <span className="grow" />
        {show && <><button className="m-btn sm" onClick={onExport}>Download CSV</button>
          <button className="m-btn sm ghost" onClick={() => { setUndo(undefined); setArmed(undefined); onClear(); }}>Download CSV and clear table</button></>}
      </div>
      {cleared > 0 && (
        <div className="m-drawer-line small">
          <span>Table cleared. The CSV was downloaded; check that it saved.</span>
          <button className="m-btn sm" onClick={onRestore}>{`Restore the cleared rows (${cleared})`}</button>
          <button className="m-btn sm ghost" onClick={onForget}>Forget the cleared rows</button>
        </div>
      )}
      {show && (
        <>
          <div className="m-table-box">
            <table className="m-table">
              <thead><tr>{["Patient", "Series", "Nodule", "Image", "Long (mm)", "Short (mm)", "Volume (mL)", "Actions"].map((h, i) => <th key={h} className={i > 1 ? "r" : undefined}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const name = `nodule ${r.nodule} of ${r.patient} ${r.series}`, sure = armed?.file === r.outline_file;
                  return (
                    <tr key={`${r.patient}/${r.series}/${r.nodule}/${r.recorded_at}`} className={r.outline_file === current?.outline_file ? "current" : undefined}>
                      <td>{r.patient}</td><td>{r.series}</td><td className="r">{r.nodule}</td><td className="r">{r.slice_label === "image" ? r.slice : `index ${r.slice}`}</td>
                      <td className="r">{r.long_mm.toFixed(1)}</td><td className="r">{r.short_mm.toFixed(1)}</td><td className="r">{r.volume_ml.toFixed(2)}</td>
                      <td className="acts"><button className="m-btn xs" aria-label={`Copy row for ${name}`} onClick={() => onCopy(r)}>Copy row</button>{" "}
                        <button className={sure ? "m-btn xs armed" : "m-btn xs danger"} aria-label={sure ? `Confirm: delete ${name}` : `Delete ${name}`} data-armed={sure || undefined} onClick={() => press(r, i)}>{sure ? "Delete row? Confirm" : "Delete"}</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* inside the scrolling box: at a small height the rows keep the room */}
            <p className="m-drawer-hint small muted">Copy row puts the row on the clipboard, ready to paste into a spreadsheet.</p>
          </div>
        </>
      )}
    </section>
  );
}
