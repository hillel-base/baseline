import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { download } from "./App";
import { entities } from "./base44";
import { utcTime } from "./utc";
import {
  OUT_OF_DATE_NOTE, REMOVED_REASONS, RETRY_MS, history, isPractice, marks, onlyPractice, studyCSV, studyRows,
  type MeasurementFields, type Payload, type RemovedReason, type ScanFields, type StudyRow,
} from "./study";

type S = ScanFields & { id: string };
type M = MeasurementFields & { id: string };
/** A Record still waiting in this browser to be saved (the outbox's waiting()). */
export type WaitingRecord = Payload & { key: string };
export type Data = { scans: S[]; ms: M[]; waiting: WaitingRecord[] };
type Removed = { saved: boolean; outOfDate: boolean };
type OnRemove = (scanRef: string, m: M, reason: RemovedReason) => Promise<Removed>;
type Line = StudyRow & { practice: boolean; waiting?: boolean };

const RECORD_LINE = "Every Record saved on Base44. Numbers only: names and dates stay on your computer.";
const HISTORY_LINE = "Every saved row, newest first. Nothing is ever changed or deleted: a correction or a removal is a new row.";
const EDITED_NOTE = '"Edited" means a correction, a paint stroke or a dragged axis';
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const tpName = (t: number) => (t === 0 ? "Baseline" : t === 1 ? "Follow-up" : `Follow-up ${t}`);
const by = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const num = (v: number | null | undefined, d: number) => (v == null ? <span className="muted">—</span> : v.toFixed(d));
const cells = (l: Line) => Object.values(l.cells).filter((c) => c !== undefined);
const lineKey = (l: Line) => cells(l).map((c) => c.id).join(); // each measurement sits in one line only
const methodChip = (method: string) => method === "tool approved" ? <span className="m-state ok">Approved</span> : <span className="m-state warn">Edited</span>; // "tool edited": clicks > 1, a paint stroke or a dragged axis (toEntities)

/** The Record view: one line per nodule from the rows that stand, then this person's Records still waiting, by patient and nodule.
 *  hidden: the practice lines left out. */
export function recordLines({ scans, ms, waiting }: Data, show: boolean) {
  const byId = new Map(ms.map((m) => [m.id, m]));
  const all: Line[] = [
    ...studyRows(scans, ms, true).map((r) => ({ ...r, practice: Object.values(r.cells).some((c) => c && isPractice(r, byId.get(c.id)!)) })),
    ...waiting.map(({ key, scan: s, measurement: w }) => ({
      study_code: s.study_code, nodule_label: w.nodule_label, duplicate: false, waiting: true, practice: isPractice(s, w),
      cells: { [s.timepoint]: { long: w.long_axis_mm, short: w.short_axis_mm, volume: w.volume_ml, method: w.method, id: key } },
    })),
  ];
  const lines = all.filter((l) => show || !l.practice).sort((a, b) => by(a.study_code, b.study_code) || by(a.nodule_label, b.nodule_label)); // stable: saved first
  return { lines, hidden: all.length - lines.length };
}

/** True when there are rows and every one is a practice row, waiting ones included: practice rows then show by default . */
const allPractice = ({ scans, ms, waiting }: Data) =>
  waiting.every((w) => isPractice(w.scan, w.measurement)) && (history(scans, ms, true).length ? onlyPractice(scans, ms) : waiting.length > 0);

/** The History view: every saved row (removal rows are the status of the row they remove), newest first. */
export function historyRows({ scans, ms }: Data, show: boolean) {
  const mark = marks(ms);
  const status = (h: M & { mark: string }): { text: string; tone?: "ok" | "danger" } => {
    if (h.mark === "current") return { text: "Current", tone: "ok" };
    if (h.mark !== "replaced") return { text: `Removed: ${h.mark}`, tone: "danger" };
    // the row that replaced it: a correction that is not itself removed (it may be replaced in turn)
    const next = ms.filter((r) => r.replaces_id === h.id && !r.removed_reason && ["current", "replaced"].includes(mark.get(r.id)!))
      .sort((a, b) => utcTime(a.approved_at) - utcTime(b.approved_at))[0];
    if (!next) return { text: "Replaced" };
    const at = new Date(utcTime(next.approved_at)), own = new Date(utcTime(h.approved_at));
    return { text: `Replaced at ${hm(at)}${day(at) === day(own) && at.getFullYear() === own.getFullYear() ? "" : ` on ${day(at)}`}` };
  };
  return history(scans, ms, show).map((h) => ({ ...h, recorded: `${day(new Date(utcTime(h.approved_at)))} ${hm(new Date(utcTime(h.approved_at)))}`, status: status(h) }))
    .sort((a, b) => utcTime(b.approved_at) - utcTime(a.approved_at));
}

const NOT_YET = `Removal not saved yet; trying again every ${RETRY_MS / 1000} s.`;
/** Removes a line at the chosen timepoints and says what happened. Every removal is stored at once: none waits for another's save, which a
 *  reload or a closed tab would lose. */
export async function removeLine(l: Line, reason: RemovedReason, at: number[], { scans, ms }: Pick<Data, "scans" | "ms">, onRemove: OnRemove) {
  const byId = new Map(ms.map((m) => [m.id, m])), scanOf = new Map(scans.map((s) => [s.id, s]));
  const done = await Promise.all(at.map((t) => { const m = byId.get(l.cells[t]!.id)!; return onRemove(scanOf.get(m.scan_id)!.scan_ref, m, reason); }));
  return done.every((r) => r.saved) ? "Removal saved." : done.some((r) => r.outOfDate) ? `Removal not saved. ${OUT_OF_DATE_NOTE}` : NOT_YET;
}

/** The study table: numbers only, loaded from Base44 each time the tab opens, plus this browser's Records still waiting.
 *  While any of this person's rows waits (a Record or a removal: pending), it loads again every RETRY_MS, so a row turns saved or goes once Base44 has it. */
export function StudyView({ onRemove, waiting, pending, onGoToMeasure }: { onRemove: OnRemove; waiting: () => WaitingRecord[]; pending: () => number; onGoToMeasure: () => void }) {
  const [data, setData] = useState<Data>();
  const [failed, setFailed] = useState(false); // the last load failed (the last table, if any, stays on screen)
  const [waits, setWaits] = useState(0);
  const load = () => {
    const w = waiting(); // before the lists: a row saved meanwhile shows twice until the next load, never not at all
    setWaits(pending());
    return Promise.all([entities.Scan.list(), entities.NoduleMeasurement.list()]).then(
      ([scans, ms]) => { setData({ scans, ms, waiting: w } as never); setFailed(false); },
      () => setFailed(true),
    );
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (!waits) return; const t = setInterval(() => void load(), RETRY_MS); return () => clearInterval(t); }, [waits]);
  const retry = <button className="m-btn sm" onClick={() => void load()}>Try again</button>;
  if (!data) return failed ? <p role="alert">Could not load the study table. Check the connection, then {retry}</p> : <p role="status">Loading the study table…</p>;
  return <StudyTable data={data} onRemove={onRemove} onChanged={load} onGoToMeasure={onGoToMeasure} waits={waits}
    notice={failed && <p className="shell-status warn" role="alert">Could not refresh the study table; this is the last copy loaded. {retry}</p>} />;
}

/** The Record and History views of the loaded rows. Rows are only added: Remove adds a removal row per timepoint with a reason from the fixed list.
 *  waits: this person's rows still waiting; at 0, a "not saved yet" removal has been saved. */
export function StudyTable({ data, onRemove, onChanged, onGoToMeasure, notice, waits = 0 }: { data: Data; onRemove: OnRemove; onChanged: () => unknown; onGoToMeasure: () => void; notice?: ReactNode; waits?: number }) {
  const [view, setView] = useState<"record" | "history">("record");
  const [practice, setPractice] = useState<boolean>(); // undefined: the default 
  const [menu, setMenu] = useState<{ key: string; button: HTMLButtonElement }>();
  const [said, setSaid] = useState<string>(); // what the last Remove did
  const section = useRef<HTMLElement>(null);
  const refocus = useRef<number>(); // after a Remove: focus the ⋯ button at this place once the reload shows
  useEffect(() => {
    if (refocus.current === undefined || !section.current) return;
    const more = section.current.querySelectorAll<HTMLButtonElement>(".st-more");
    (more[refocus.current] ?? more[more.length - 1] ?? section.current).focus(); // the next row's ⋯ (or this row's, if it still stands), else the table
    refocus.current = undefined;
  }, [data]);
  const { scans, ms, waiting } = data;
  const auto = allPractice(data), show = practice ?? auto;
  const { lines, hidden } = recordLines(data, show);
  const tps = [...new Set(lines.flatMap((l) => Object.keys(l.cells).map(Number)))].sort((a, b) => a - b);
  const close = () => { menu?.button.focus(); setMenu(undefined); };
  /** Removes a line at the chosen timepoints. What it did shows outside the menu, which closes: a line with one timepoint fewer is a new line, and
   *  its menu would go with the note. Focus then goes to the next row's ⋯ (or this row's, if it still stands). place: the line's ⋯ among all. */
  const remove = async (l: Line, reason: RemovedReason, at: number[], place: number) => {
    const note = await removeLine(l, reason, at, data, onRemove);
    refocus.current = place;
    close();
    setSaid(note);
    void onChanged();
  };
  const shown = said === NOT_YET && !waits ? "Removal saved." : said; // the table loaded again once it was saved
  const empty = (
    <div className="st-empty">
      <b>No measurements yet</b>
      <p className="muted">Record a nodule on the Measure screen, and it appears here.</p>
      <button className="m-btn" onClick={onGoToMeasure}>Go to Measure</button>
    </div>
  );
  const unit = (name: string, u: string, sep = false) => <th className={sep ? "r st-sep" : "r"}>{name} <span className="st-unit">{u}</span></th>;
  const code = (c: string, practiceRow: boolean, muted = false) => <><span className={muted ? "muted" : undefined}>{c}</span>{practiceRow && <span className="m-tag st-chip">Practice</span>}</>;
  const record = !lines.length ? empty : (
    <>
      <table className="st-table" aria-label="Study record">
        <thead>
          <tr>
            <th rowSpan={2}>Patient</th><th rowSpan={2}>Nodule</th>
            {tps.map((t) => <th key={t} colSpan={4} scope="colgroup" className="st-group st-sep">{tpName(t)}</th>)}
            <th rowSpan={2} className="st-sep"><span className="sr-only">Actions</span></th>
          </tr>
          <tr>{tps.map((t) => <Fragment key={t}>{unit("Long", "mm", true)}{unit("Short", "mm")}{unit("Volume", "mL")}<th>Method</th></Fragment>)}</tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const first = i === 0 || lines[i - 1].study_code !== l.study_code, key = lineKey(l), open = menu?.key === key, at = tps.filter((t) => l.cells[t]);
            return (
              <tr key={key} className={first ? "st-first" : undefined}>
                <td className="st-code">{code(l.study_code, l.practice, !first)}</td>
                <td className="st-nod">{l.nodule_label}{l.duplicate && <span className="m-tag st-chip">Duplicate label</span>}</td>
                {tps.map((t) => { const c = l.cells[t]; return <Fragment key={t}>
                  <td className="r st-sep">{num(c?.long, 1)}</td><td className="r">{num(c?.short, 1)}</td><td className="r">{num(c?.volume, 2)}</td>
                  <td>{!c ? num(null, 0) : l.waiting ? <span className="m-state warn">Not saved yet</span> : methodChip(c.method)}</td>
                </Fragment>; })}
                <td className="st-acts st-sep">{!l.waiting && <>
                  <button className="m-btn ghost st-more" title="More" aria-label="More" aria-haspopup="dialog" aria-expanded={open}
                    onClick={(ev) => { setSaid(undefined); setMenu(open ? undefined : { key, button: ev.currentTarget }); }}>⋯</button>
                  {open && <RemoveMenu title={`Remove ${l.nodule_label} of ${l.study_code}`} timepoints={at} anchor={menu.button} onClose={close}
                    onRemove={(r, which) => void remove(l, r, which, lines.slice(0, i).filter((x) => !x.waiting).length)} />}
                </>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="st-foot muted">
        {[`${plural(new Set(lines.map((l) => `${l.study_code}/${l.nodule_label}`)).size, "nodule")} on ${plural(new Set(lines.map((l) => l.study_code)).size, "patient")}`,
          hidden > 0 && `${plural(hidden, "practice row")} hidden`, EDITED_NOTE].filter(Boolean).join(" · ")}
      </p>
    </>
  );
  const rows = view === "history" ? historyRows(data, show) : [];
  const past = !rows.length ? empty : (
    <table className="st-table" aria-label="History">
      <thead>
        <tr><th>Recorded</th><th>Patient</th><th>Nodule</th><th>Timepoint</th>{unit("Long", "mm")}{unit("Short", "mm")}{unit("Volume", "mL")}<th>Method</th><th>Status</th></tr>
      </thead>
      <tbody>
        {rows.map((h) => {
          const old = h.mark !== "current", n = (v: number | null | undefined, d: number) => (old && v != null ? <s>{num(v, d)}</s> : num(v, d));
          return (
            <tr key={h.id} className={old ? "st-old" : undefined}>
              <td className="muted">{h.recorded}</td>
              <td className="st-code">{code(h.scan.study_code, isPractice(h.scan, h))}</td>
              <td className="st-nod">{h.nodule_label}</td>
              <td>{tpName(h.scan.timepoint)}</td>
              <td className="r">{n(h.long_axis_mm, 1)}</td><td className="r">{n(h.short_axis_mm, 1)}</td><td className="r">{n(h.volume_ml, 2)}</td>
              <td>{old ? (h.method === "tool approved" ? "Approved" : "Edited") : methodChip(h.method)}</td>
              <td className="st-status"><span className={`m-state${h.status.tone ? ` ${h.status.tone}` : ""}`}>{h.status.text}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  return (
    <section ref={section} className="st" aria-label="Study table" tabIndex={-1}>
      <div className="st-head">
        <div>
          <h2>Study table</h2>
          <p className="muted">{view === "record" ? RECORD_LINE : HISTORY_LINE}</p>
        </div>
        {(ms.length > 0 || waiting.length > 0) && (
          <div className="st-tools">
            <div className="m-seg st-seg" role="group" aria-label="View">
              {(["record", "history"] as const).map((v) => <button key={v} aria-pressed={view === v} onClick={() => { setView(v); setMenu(undefined); }}>{v === "record" ? "Record" : "History"}</button>)}
            </div>
            <button role="switch" aria-checked={show} className="st-switch" onClick={() => setPractice(!show)}><span className="st-track" aria-hidden="true" />Practice rows</button>
            <button className="m-btn" onClick={() => download(new Blob([studyCSV(scans, ms, show)], { type: "text/csv" }), "study-table.csv")}>Download CSV</button>
          </div>
        )}
      </div>
      {notice}
      {shown && <p className="st-said muted" role="status">{shown}</p>}
      {auto && show && <p className="st-banner"><b>Practice rows</b> <span className="muted">These come from public practice scans and are kept apart from the study record.</span></p>}
      {view === "record" ? record : past}
    </section>
  );
}

/** The ⋯ menu: the timepoint (when the line has more than one), the reason, then Remove. Neither has a default: Remove waits until each is chosen.
 *  Esc or a click outside closes it, and focus goes back to the ⋯ button. Remove closes it too; the table says what it did. */
export function RemoveMenu({ title, timepoints, anchor, onClose, onRemove }: {
  title: string; timepoints: number[]; anchor: HTMLElement; onClose: () => void; onRemove: (r: RemovedReason, at: number[]) => void;
}) {
  const [reason, setReason] = useState<RemovedReason>();
  const [when, setWhen] = useState<number | "all">(); // which timepoint(s): asked only when there are several
  const at = timepoints.length === 1 ? timepoints : when === "all" ? timepoints : when === undefined ? [] : [when];
  const [busy, setBusy] = useState(false); // pressed: a second press would store a second removal
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>("input")?.focus(); // the first choice to make
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    const down = (e: MouseEvent) => {
      const t = e.target as Element;
      if (box.current?.contains(t) || anchor.contains(t)) return; // the ⋯ button toggles on its own
      if (!t.closest?.('button, a, input, select, textarea, [tabindex]:not([tabindex="-1"])')) e.preventDefault(); // a click on nothing in particular leaves focus on the ⋯ button
      closeRef.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("mousedown", down); };
  }, [anchor]);
  const go = () => { if (reason) { setBusy(true); onRemove(reason, at); } };
  return (
    <div ref={box} className="st-menu" role="dialog" aria-label={title}>
      <h3>{title}</h3>
      <p className="muted">It leaves the record; the history keeps it, with the reason.</p>
      {timepoints.length > 1 && <fieldset className="st-when">
        <legend className="sr-only">Timepoint</legend>
        {[...timepoints, "all" as const].map((t) => (
          <label key={t}><input type="radio" name="st-when" checked={when === t} onChange={() => setWhen(t)} />{t === "all" ? (timepoints.length === 2 ? "Both" : "All") : tpName(t)}</label>
        ))}
      </fieldset>}
      <fieldset>
        <legend className="sr-only">Reason</legend>
        {REMOVED_REASONS.map((r) => (
          <label key={r}><input type="radio" name="st-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />{r[0].toUpperCase() + r.slice(1)}</label>
        ))}
      </fieldset>
      <div className="st-menu-acts">
        <button className="m-btn sm ghost" onClick={onClose}>Cancel</button>
        <button className="m-btn sm danger" onClick={() => void go()} disabled={busy || !reason || !at.length}>Remove</button>
      </div>
    </div>
  );
}
