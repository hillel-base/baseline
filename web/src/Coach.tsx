import { useEffect, useRef, useState } from "react";
import { WAITING_LOCAL } from "./texts";
import { STEPS, appHasOpen, back, escExits, idle, next, observe, placeBox, show, start, type Anchor, type Facts, type Rect, type Side, type Tour } from "./tutorial";

// The coach: a box with an arrow beside the next control, moved on resize and scroll. It reads the page as a person sees it (roles, names, text)
// and never acts on it, never takes the focus, and sits after the header in the DOM, so Tab reaches its buttons.
const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
const named = (doc: Document, sel: string, name?: RegExp) => [...doc.querySelectorAll(sel)].find((e) => !e.closest(".tut") && e.getClientRects().length > 0 && (!name || name.test(nameOf(e))));
const R = 44; // the room kept clear round the white ring, so the box never hides the nodule's centre
const G = 4; // the ring's gap round its target, the same on all four sides; its corners are the target's, G further out

function locate(doc: Document, a: Anchor): (Rect & { ring: boolean; el?: Element }) | undefined {
  if (a.sel === "@cross") { // SliceView writes the ring's place on its marks canvas, in CSS px
    const c = doc.querySelector<HTMLCanvasElement>('canvas[aria-label="Axis lines and click marks"]'), t = c?.dataset.target;
    if (!c || !t || !c.getClientRects().length) return;
    const [x, y] = JSON.parse(t) as [number, number], r = c.getBoundingClientRect();
    return { left: r.left + x - R, top: r.top + y - R, right: r.left + x + R, bottom: r.top + y + R, ring: false };
  }
  const el = named(doc, a.sel, a.name);
  if (!el) return;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, ring: r.width * r.height < innerWidth * innerHeight * 0.4, el }; // no ring round a frame grown over the page
}

/** The facts the steps need. edits counts finished corrections: a busy status that is not Recording or Finding, then not busy. */
function read(doc: Document, scan: string | undefined, patientN: number | undefined, edits: { n: number; was: boolean }): Facts {
  const panel = doc.querySelector('section[aria-label="Measurements"]'), line = doc.querySelector(".shell-line");
  const busy = panel?.querySelector(".m-status.busy")?.textContent ?? "", editing = !!busy && !/^(Recording|Finding)/.test(busy);
  if (edits.was && !editing) edits.n++;
  edits.was = editing;
  const find = named(doc, '[role="group"][aria-label="Earlier nodules"] button', /^Find N\d+$/), tab = doc.querySelector('[role="tab"][aria-selected="true"]');
  const patients = doc.querySelector('.m-bar button[aria-haspopup="dialog"]')?.textContent?.replace("▾", "").replace(/\s+/g, " ").trim(), rows = named(doc, '[role="switch"]', /^Practice rows$/);
  return {
    ...idle, scan, patientN, edits: edits.n,
    tab: tab ? nameOf(tab) : "", // "" on the install view, which has no tab
    live: !!line,
    local: !!doc.querySelector('iframe[title="Patients"]') || !!line?.textContent?.startsWith("Your own computer") || [...doc.querySelectorAll(".shell-status")].some((e) => e.textContent?.includes(WAITING_LOCAL)),
    practice: !!named(doc, "button", /^Practice server$/),
    sheet: !!doc.querySelector('[role="dialog"][aria-label="Patients"]'),
    rowShown: patientN !== undefined && !!named(doc, '[role="dialog"][aria-label="Patients"] .pp-pt[aria-pressed="true"]', new RegExp(`^Practice patient ${patientN}(?!\\d)`)),
    measured: /\d/.test(panel?.querySelector(".m-volume")?.textContent ?? ""),
    recorded: !!panel?.querySelector(".m-status.ok"),
    proposal: !!named(doc, "button", /^Measure here \(M\)$/),
    findLabel: find && nameOf(find),
    finder: !!doc.querySelector(".m-finder button"),
    tools: !!doc.querySelector('[role="group"][aria-label="By hand"]'),
    patientsLabel: patients && !patients.endsWith("…") ? patients : undefined, // not "Loading scans…": nothing to press yet
    practiceRows: rows ? rows.getAttribute("aria-checked") === "true" : undefined,
  };
}
const same = (a: Facts, b: Facts) => (Object.keys(b) as (keyof Facts)[]).every((k) => a[k] === b[k]);
// Esc: one listener, in the capture phase, added when this module loads (before any of the app's own), so it sees a sheet or list still open
// before the app's Esc closes it, whatever opened first.
let onEsc: (() => void) | undefined;
if (typeof window !== "undefined") window.addEventListener("keydown", (e) => { if (onEsc && escExits(e, appHasOpen(document))) onEsc(); }, true);

type Props = { mode: "offer" | "on"; scan?: string; patientN?: number; onStart: () => void; onDecline: () => void; onLater: () => void; onExit: () => void; onStep: (id?: string) => void };

export function Coach({ mode, scan, patientN, onStart, onDecline, onLater, onExit, onStep }: Props) {
  const root = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), ring = useRef<HTMLDivElement>(null), marked = useRef<Element>();
  const edits = useRef({ n: 0, was: false }), seen = useRef({ scan, patientN }), reread = useRef(() => {}), refocus = useRef(false);
  seen.current = { scan, patientN };
  const [facts, setFacts] = useState<Facts>();
  const [tour, setTour] = useState<Tour>();
  const shown = mode === "on" && tour && facts ? show(tour, facts) : undefined;
  const target = useRef<{ anchors: Anchor[]; side: Side }>({ anchors: [], side: "below" });
  target.current = mode === "offer" ? { anchors: [{ sel: ".shell-bar button", name: /^Tutorial$/ }], side: "right" } // beside the button: the card under it stays readable
    : { anchors: shown?.anchors ?? [], side: shown?.side ?? "below" };

  const place = () => {
    const c = card.current, g = ring.current;
    if (!c || !g) return;
    const { anchors, side } = target.current;
    let at: ReturnType<typeof locate>;
    for (const a of anchors) if ((at = locate(document, a))) break;
    const b = { w: c.offsetWidth, h: c.offsetHeight };
    const p = at ? placeBox(at, b, innerWidth, innerHeight, side) : { side: "inside" as const, left: (innerWidth - b.w) / 2, top: (innerHeight - b.h) / 2, arrow: 0 };
    Object.assign(c.style, { left: `${Math.round(p.left)}px`, top: `${Math.round(p.top)}px`, visibility: "visible" });
    c.dataset.side = p.side;
    c.style.setProperty("--arrow", `${Math.round(p.arrow)}px`);
    const el = at?.ring ? at.el : undefined; // "@cross" has no element: SliceView draws that ring on its canvas
    if (marked.current !== el) { marked.current?.removeAttribute("data-tut-anchor"); el?.setAttribute("data-tut-anchor", ""); marked.current = el; } // the ring's target, for the e2e to measure
    Object.assign(g.style, at && el ? { display: "block", left: `${at.left - G}px`, top: `${at.top - G}px`, width: `${at.right - at.left + 2 * G}px`, height: `${at.bottom - at.top + 2 * G}px`,
      borderRadius: `${(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + G}px` } : { display: "none" });
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // Watch the page: every change is read again (corrections are short, so nothing is sampled); the box moves on the next frame.
  useEffect(() => {
    let raf = 0;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeRef.current(); }); };
    const update = () => { // the offer only moves with its button (mode is fixed per mount: Start mounts a new coach)
      if (mode === "on") { const f = read(document, seen.current.scan, seen.current.patientN, edits.current); setFacts((p) => (p && same(p, f) ? p : f)); }
      soon();
    };
    const mo = new MutationObserver((recs) => { if (!recs.every((r) => root.current?.contains(r.target) || r.attributeName === "data-tut-anchor")) update(); }); // its own moves and marks are not news
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    update();
    addEventListener("resize", soon); addEventListener("scroll", soon, true);
    reread.current = update;
    return () => { mo.disconnect(); cancelAnimationFrame(raf); removeEventListener("resize", soon); removeEventListener("scroll", soon, true); marked.current?.removeAttribute("data-tut-anchor"); };
  }, []);
  useEffect(() => reread.current(), [scan, patientN]); // App reported another scan: no DOM change may come with it
  useEffect(() => { if (mode === "on" && facts) setTour((t) => (t ? observe(t, facts) : start(facts))); }, [mode, facts]);
  useEffect(() => { onStep(mode === "on" && tour ? STEPS[tour.i].id : undefined); }, [mode, tour?.i]);
  useEffect(() => place()); // after every render: the box's own size may have changed
  useEffect(() => { onEsc = mode === "on" ? onExit : onLater; return () => { onEsc = undefined; }; }, [mode]); // Esc exits (or closes the offer for this visit), unless the app has a sheet or list open
  useEffect(() => { // a button pressed from the keyboard may be gone in the new step (Next): the focus stays in the coach, never on the page's body
    if (!refocus.current) return;
    refocus.current = false;
    if (!root.current?.contains(document.activeElement)) root.current?.focus({ preventScroll: true });
  });

  const go = (t: Tour | undefined) => (t ? setTour(t) : onExit());
  const btn = (label: string, onClick: () => void, primary = false) =>
    <button className={primary ? "m-btn sm primary" : "m-btn sm"} onClick={(e) => { refocus.current = e.detail === 0; onClick(); }}>{label}</button>;
  return (
    // a mouse click leaves no focus on a coach button, so Enter and the letter keys go to the page next
    <div ref={root} className="tut" role="region" aria-label="Tutorial" tabIndex={-1} onClick={(e) => { if (e.detail > 0) (e.target as Element).closest("button")?.blur(); }}>
      <div ref={ring} className="tut-ring" aria-hidden="true" />
      <div ref={card} className={mode === "offer" ? "tut-card tut-offer" : "tut-card"}>
        <span className="tut-arrow" aria-hidden="true" />
        {mode === "offer" ? <>{/* one row inside the top bar, beside its button: it never reaches the Patients bar under the header */}
          <span className="tut-title" role="status" aria-label="Take a short tutorial?">Take a short tutorial?</span>{/* not "2-minute": a click takes about 20 s on a standard PC */}
          {btn("No thanks", onDecline)}{btn("Start", onStart, true)}
        </> : shown && tour && facts && <>
          <p className="tut-step">Tutorial · Step {shown.n} of {shown.of}</p>
          <div aria-live="polite">{shown.lines.map((l) => <p key={l}>{l}</p>)}</div>
          <div className="tut-acts">
            {shown.back && btn("Back", () => setTour(back(tour, facts)))}
            {shown.skip && btn("Skip", () => go(next(tour, facts)))}
            <span className="grow" />
            {btn("Exit", onExit, !shown.next && !shown.skip)}
            {shown.next && btn("Next", () => go(next(tour, facts)), true)}
          </div>
        </>}
      </div>
    </div>
  );
}
