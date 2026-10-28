import { useEffect, useRef, useState, type ReactNode } from "react";
import { recordedOn } from "./patients";
import { scanIdOf, type RecordedNodule } from "./record";
import { FRAME_BLOCKED } from "./texts";
import { keyFor, stepKey } from "./ui";

/** the Patients panel on the hosted page, drawn by the engine on this computer inside a frame (its /picker). The hosted page, and Base44's scripts on it,
 *  cannot read the frame; the two talk by postMessage in scan codes only:
 *  frame → page {type:"ready"}, {type:"size", open}, {type:"open", scan};
 *  page → frame {type:"current", scan}, {type:"step", key:"prev"|"next"} (Alt+←/→ here), {type:"counts", counts:{[scan code]: nodules recorded}} (the chips). */
export const SCAN_CODE = /^(F-[0-9a-f]{8}|D-[0-9a-f]{8}|RIDER-\d{10}_(test|retest))$/;
export const FRAME_WAIT_MS = 8000; // no ready by then: the drop-down stands in
export const BLOCKED = FRAME_BLOCKED;
export type FrameMsg = { type: "ready" } | { type: "size"; open: boolean } | { type: "open"; scan: string };

/** The frame's message, only from the engine's exact origin and the frame's own window, and with a code only; anything else is null (ignored silently). */
export function fromFrame(e: Pick<MessageEvent, "origin" | "source" | "data">, engine: string, frame: Window | null | undefined): FrameMsg | null {
  if (e.origin !== engine || !frame || e.source !== frame) return null;
  const d = e.data;
  if (d?.type === "ready") return { type: "ready" };
  if (d?.type === "size" && typeof d.open === "boolean") return { type: "size", open: d.open };
  if (d?.type === "open" && typeof d.scan === "string" && SCAN_CODE.test(d.scan)) return { type: "open", scan: d.scan };
  return null;
}

export type PageMsg = { type: "current"; scan: string } | { type: "step"; key: "prev" | "next" } | { type: "counts"; counts: Record<string, number> };

/** In the frame: the hosted page's message, only from the allowed origin and the parent window, with codes and small whole counts only; anything else is null.
 *  Counts come from any script on that page, so a false count is possible; they only label the chips, never open or record anything. */
export function fromPage(e: Pick<MessageEvent, "origin" | "source" | "data">, parent: string, win: Window | null | undefined): PageMsg | null {
  if (!parent || e.origin !== parent || !win || e.source !== win) return null;
  const d = e.data;
  if (d?.type === "current" && typeof d.scan === "string" && (d.scan === "" || SCAN_CODE.test(d.scan))) return { type: "current", scan: d.scan };
  if (d?.type === "step" && (d.key === "prev" || d.key === "next")) return { type: "step", key: d.key };
  if (d?.type === "counts" && d.counts && typeof d.counts === "object" && !Array.isArray(d.counts)) {
    const c = Object.entries(d.counts);
    if (c.every(([k, n]) => SCAN_CODE.test(k) && Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 99)) return { type: "counts", counts: Object.fromEntries(c) as Record<string, number> };
  }
  return null;
}

/** The page's own Records as {scan code: nodules recorded}: codes and counts only, nothing else from the rows. */
export const countsOf = (rows: RecordedNodule[]) =>
  Object.fromEntries([...new Set(rows.map(scanIdOf))].filter((id) => SCAN_CODE.test(id)).map((id) => [id, Math.min(99, recordedOn(rows, id))]));

/** Closed: undefined, the CSS size (the Patients button and its steps, 34 px high). Open: from the slot's corner to the window's far corner, over the viewer,
 *  so a click beside the sheet lands on the frame's own backdrop and only closes it, as on the engine's own page. */
export const frameBox = (open: boolean, at: { left: number; top: number }, win: { width: number; height: number }) =>
  open ? { width: Math.floor(win.width - at.left), height: Math.floor(win.height - at.top) } : undefined;

/** The frame in the Patients button's place. Opening a scan goes through onOpen, the drop-down's own path; the drop-down (codes) is the fallback while the frame is late. */
export function PatientsFrame({ engine, current, counts, busy, onOpen, fallback }: { engine: string; current: string; counts: Record<string, number>; busy: boolean;
  onOpen: (code: string) => void; fallback: ReactNode }) {
  const frame = useRef<HTMLIFrameElement>(null), slot = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  const [late, setLate] = useState(false);
  const [box, setBox] = useState<{ width: number; height: number }>();
  const open = useRef(false); // the sheet, as the frame last said
  const now = useRef({ current, busy, onOpen, counts });
  now.current = { current, busy, onOpen, counts };
  const tell = (m: object) => frame.current?.contentWindow?.postMessage(m, engine); // to the engine's origin only: a frame showing anything else gets nothing
  // The keys are the page's again (Enter records, ↑ ↓ move). iframe.blur() does it in Chrome only; focusing an element of this page works in Firefox too.
  const giveBack = () => { const s = slot.current; if (s && document.activeElement === frame.current) { s.focus({ preventScroll: true }); s.blur(); } };
  const fit = () => setBox(slot.current ? frameBox(open.current, slot.current.getBoundingClientRect(), { width: innerWidth, height: innerHeight }) : undefined);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), FRAME_WAIT_MS);
    const on = (e: MessageEvent) => {
      const m = fromFrame(e, engine, frame.current?.contentWindow);
      if (!m) return;
      const { current, busy, onOpen } = now.current;
      if (m.type === "ready") { setReady(true); tell({ type: "current", scan: current }); tell({ type: "counts", counts: now.current.counts }); } // every ready: a reloaded frame gets them too
      else if (m.type === "size") {
        open.current = m.open;
        if (!m.open) giveBack(); // closed by Esc or a click beside it, as after Open
        fit();
      }
      else {
        giveBack(); // as after Open on the engine's own page
        if (busy || m.scan === current) tell({ type: "current", scan: current }); // the drop-down is off while the engine works: the frame shows the open scan again
        else onOpen(m.scan); // the current effect below tells the frame
      }
    };
    addEventListener("message", on);
    // As in the panel: while it shows, Alt+←/→ is never the browser's Back; with the focus on this page it steps the frame's list (the frame opens the scan)
    const key = (e: KeyboardEvent) => {
      if (!stepKey(e)) return;
      e.preventDefault();
      const k = keyFor(e);
      if ((k === "prev" || k === "next") && slot.current?.offsetParent) tell({ type: "step", key: k }); // not from a hidden tab
    };
    addEventListener("keydown", key);
    addEventListener("resize", fit); // an open sheet keeps covering the viewer
    return () => { clearTimeout(timer); removeEventListener("message", on); removeEventListener("keydown", key); removeEventListener("resize", fit); };
  }, []);
  useEffect(() => { if (ready) tell({ type: "current", scan: current }); }, [current, ready]);
  useEffect(() => { if (ready) tell({ type: "counts", counts }); }, [counts, ready]);
  const blocked = late && !ready; // the frame stays, hidden: a ready that comes later still takes over
  return <>
    <span ref={slot} className="pp-slot" hidden={blocked} tabIndex={-1}>
      <iframe ref={frame} className="pp-frame" src={`${engine}/picker`} title="Patients" referrerPolicy="no-referrer" style={box} />
    </span>
    {blocked && <><span className="pp-blocked" role="status">{BLOCKED}</span>{fallback}</>}
  </>;
}
