import { useEffect, useRef, useState } from "react";
import { ACCURACY, FINDER_SOURCE, LICENCE, MODEL_LINE, NONE, NOTE, SOURCES, type Finds, type Ranked } from "./list";

type Acts = { onGo: (c: Ranked) => void; onMeasure: (c: Ranked) => void; onToggle: (c: Ranked) => void };
type Props = Acts & { finds?: Finds; z: number; busy: boolean; hold?: string; onFind: () => void }; // busy: Measure is off (a request runs, or an open outline: hold says why)

/** The finder's one button over the image, and its drop-down over the image's corner. Shown only when the engine has a finder and it is on. */
export function Copilot({ finds, z, busy, hold, onFind, ...acts }: Props) {
  const [open, setOpen] = useState(false);
  const [how, setHow] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const asked = useRef(false); // "Find nodules" was pressed on this scan: its answer opens the list, once
  const list = finds?.list;
  useEffect(() => { if (list && asked.current) { asked.current = false; setOpen(true); } }, [list]);
  // Closed from the keyboard, focus goes back to the button; after a mouse press it stays nowhere, so Enter still records
  const close = (keyboard: boolean) => { setOpen(false); if (keyboard) setTimeout(() => trigger.current?.focus()); };
  useEffect(() => { // Esc or a press outside closes it
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(!!box.current?.contains(document.activeElement)); };
    const press = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      setOpen(false);
      if (!(e.target as Element).closest?.('[data-testid="viewer"]')) return;
      // on the image, the press only closes the list: its mousedown and click never reach the viewer (no outline, no stroke)
      const eat = (m: MouseEvent) => { m.stopPropagation(); m.preventDefault(); };
      const done = () => setTimeout(() => { window.removeEventListener("mousedown", eat, true); window.removeEventListener("click", eat, true); });
      window.addEventListener("mousedown", eat, true); window.addEventListener("click", eat, true);
      window.addEventListener("pointerup", done, { once: true, capture: true }); // the click, if any, comes right after
    };
    window.addEventListener("keydown", key); document.addEventListener("pointerdown", press);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("pointerdown", press); };
  }, [open]);
  return (
    <span ref={box} className="m-finder">
      <span role="status" className="sr-only">{list ? (list.length ? `${list.length} suggestions` : "No suggestions") : ""}</span>
      {finds?.error && <span role="alert" className="small m-finder-error">{finds.error}</span>}
      {finds && !list && !finds.error ? <button className="m-btn sm" disabled><span className="m-spin" aria-hidden="true" />Looking… up to 30 s</button>
        : !list ? <button className="m-btn sm" onClick={() => { asked.current = true; onFind(); }}>Find nodules</button>
        : <button ref={trigger} className="m-btn sm" aria-expanded={open} aria-controls="m-suggestions" onClick={() => setOpen(!open)}>
          {list.length ? <>Suggestions<span className="m-n">{list.length}</span><span aria-hidden="true">▾</span></> : "No suggestions"}</button>}
      {open && list && <Suggestions list={list} z={z} busy={busy} hold={hold} how={how} onHow={() => setHow(!how)} onClose={close} {...acts} />}
    </span>
  );
}

/** The drop-down: numbered like the rings on the image and the ticks on the slice bar. */
export function Suggestions({ list, z, busy, hold, how, onHow, onClose, onGo, onMeasure, onToggle }: Acts & { list: Ranked[]; z: number; busy: boolean; hold?: string; how: boolean; onHow: () => void; onClose: (keyboard: boolean) => void }) {
  return (
    <section id="m-suggestions" className="m-pop" aria-label="Suggestions to check">
      <header>
        <span><b>Suggestions to check</b><small className="m-pop-model">{MODEL_LINE}</small></span>
        <button className="m-x" title="Close (Esc)" aria-label="Close" onClick={(e) => onClose(e.detail === 0)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
        </button>
      </header>
      {hold && list.some((c) => !c.off && !c.measured) && <p className="m-pop-none">{hold}</p>}
      {list.length === 0 ? <p className="m-pop-none">{NONE}</p> : (
        <ol className="m-pop-list">
          {list.map((c) => {
            const here = c.z === z;
            return (
              <li key={c.rank} className={c.measured ? "done" : c.off ? "off" : here ? "here" : undefined}>
                <span className="m-pop-n">{c.rank}</span>
                {c.off ? <span className="m-pop-t">Image {c.image}<small>Marked not a nodule</small></span>
                  : <button className="m-pop-t" onClick={() => onGo(c)}>Image {c.image}<small>{c.measured ? `Measured · nodule ${c.measured}` : here ? "You are here" : "Go to it"}</small></button>}
                <span className="m-pop-acts">
                  {c.measured ? null : c.off ? <button className="m-btn ghost" onClick={() => onToggle(c)}>Undo</button> : <>
                    <button className={here ? "m-btn primary" : "m-btn"} disabled={busy} onClick={() => onMeasure(c)}>Measure</button>
                    <button className="m-btn ghost" onClick={() => onToggle(c)}>Not a nodule</button>
                  </>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <footer><span>{NOTE}</span><button className="m-pop-how" aria-expanded={how} onClick={onHow}>How accurate?</button></footer>
      {how && (
        <div className="m-pop-acc">
          <b>How accurate is the finder?</b>
          <ul>{ACCURACY.map((t) => <li key={t}>{t}</li>)}</ul>
          <small>{SOURCES}</small>
          <small>{LICENCE} <a href={FINDER_SOURCE} target="_blank" rel="noreferrer">github.com/hillel-base/baseline</a>, the finder/ folder.</small>
        </div>
      )}
    </section>
  );
}
