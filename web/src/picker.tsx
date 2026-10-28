import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listPatients, type Patients } from "./api";
import { PatientsPanel } from "./PatientsPanel";
import { SCAN_CODE, fromPage } from "./PatientsFrame";
import { rememberScanId, type RecordedNodule } from "./record";
import { keyFor } from "./ui";
import "./theme.css";
import "./measure.css";

// the Patients panel alone, served by the engine at /picker inside the hosted page's frame. Names and dates show here only: this page talks to the
// hosted page by postMessage to its exact origin (never "*"), in scan codes only, and takes messages only from that origin and its parent window.
const PARENT = document.querySelector<HTMLMetaElement>('meta[name="lung-parent"]')?.content ?? "";
const tell = (m: object) => { try { window.parent.postMessage(m, PARENT); } catch { /* not served by the engine: no parent origin, nothing is sent */ } };
const FAILED = "The patient list could not be read. Reload the page.";

function Picker() {
  const [data, setData] = useState<Patients>();
  const [code, setCode] = useState(""); // the scan open on the hosted page, as a code
  const [counts, setCounts] = useState<Record<string, number>>({}); // that page's own Records, by scan code
  const root = useRef<HTMLDivElement>(null);
  const step = (k: string) => { const b = root.current?.querySelector<HTMLButtonElement>(`[data-key="${k}"]`); if (b && !b.disabled) b.click(); };
  useEffect(() => {
    listPatients().then(setData, () => setData({ folder: { path: null, from: null, error: FAILED }, patients: [] }));
    const on = (e: MessageEvent) => {
      const m = fromPage(e, PARENT, window.parent);
      if (m?.type === "current") setCode(m.scan);
      if (m?.type === "step") step(m.key);
      if (m?.type === "counts") setCounts(m.counts);
    };
    addEventListener("message", on);
    const key = (e: KeyboardEvent) => { const k = keyFor(e); if (k === "prev" || k === "next") { e.preventDefault(); step(k); } }; // Alt+←/→ here, as on the engine's own page
    addEventListener("keydown", key);
    tell({ type: "ready" });
    return () => { removeEventListener("message", on); removeEventListener("keydown", key); };
  }, []);
  const scans = data?.patients.flatMap((p) => p.scans) ?? [];
  // The chips count rows: the frame has no table, so stand-in rows carry only what they count (a nodule number per Record on that scan)
  const rows = useMemo(() => scans.flatMap((s) => Array.from({ length: (s.code && counts[s.code]) || 0 }, (_, i) => {
    const r = { nodule: i + 1, recorded_at: "", outline_file: `${s.id}#${i + 1}` } as RecordedNodule;
    rememberScanId(r, s.id);
    return r;
  })), [data, counts]);
  const open = (id: string) => { const c = scans.find((s) => s.id === id)?.code; if (c && SCAN_CODE.test(c)) tell({ type: "open", scan: c }); }; // a code, or nothing
  return (
    <div ref={root}>
      <PatientsPanel data={data} current={scans.find((s) => s.code === code)?.id ?? code} rows={rows} practice={false} busy={false}
        onOpen={open} onChosen={setData} onSheet={(open) => tell({ type: "size", open })} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Picker />);
