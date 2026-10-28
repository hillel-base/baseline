import { useCallback, useEffect, useRef, useState } from "react";
import { InstallView } from "./InstallView";
import { About } from "./About";
import { App, Logo } from "./App";
import { IN_USE, PRACTICE_STOPPED, SIGN_IN_FIRST, onBlocked, postEvent, probeEngine, releaseSession, setApiBase, setAuth, type Patients } from "./api";
import { accessToken, configError, currentUser, entities, signIn, signOut } from "./base44";
import { PROBE_MS, askInOrder, probe, servers, waking, type PracticeState } from "./practice";
import { StudyView, forgetStudy, preloadStudy } from "./StudyView";
import { WAITING_LOCAL } from "./texts";
import { RETRY_MS, WAITING, outbox, signOutLine, toEntities, type Payload } from "./study";
import { keepInMemory } from "./record";
import { INVITE_ONLY, NO_BASE44, guardStore, resolveSession, type Session } from "./session";
import { Coach } from "./Coach";
import { CASE, markOffered, practiceN, shouldOffer, unmarkOffered } from "./tutorial";

keepInMemory(); // the hosted page keeps its table in memory: the Study table is the lasting record
// Only the rows still waiting to be saved stay in this origin's storage, each under its own key until Base44 confirms it, and each is sent
// only while the person who made it (by Base44 user id) is signed in. Blocked storage throws inside the outbox, which then keeps them in memory.
// A failed save is logged by its status or class only.
let signedIn: string | undefined;
let showWaiting: (n: number, note?: string) => void = () => {};
let showLeft: (n: number) => void = () => {}; // the sign-out line
const box = outbox(entities, { getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v), removeItem: (k) => localStorage.removeItem(k), keys: () => Object.keys(localStorage) },
  () => signedIn, { onCount: (n, note) => { showWaiting(n, note); showLeft(n); }, onFail: (reason) => postEvent({ action: "save_failed", reason }) });
const sent = new Map<string, { key: string; e: Payload }>(); // this page's Records by outline file, in memory only: what Undo takes back
let newest: string | undefined; // the outline file of the newest Record on this page
const LOCAL_ENGINE = import.meta.env.VITE_ENGINE_URL ?? "http://localhost:8000"; // VITE_ENGINE_URL is for the e2e tests only; the deployed build never sets it
// Chrome holds the first request to this computer while it asks about "apps on this device": time to choose Allow. A refused connection still fails at once.
export const LOCAL_PROBE_MS = 60_000;
/** Automatic sleep: after this long without a click on the page, the card stops asking the practice servers, so a forgotten tab cannot keep them awake. */
export const IDLE_STOP_MS = 15 * 60_000;
const TABS = ["Measure", "Study table"] as const;
type Tab = (typeof TABS)[number];
type Engine = { state: "idle" } | { state: "trying"; local: boolean } | { state: "none" } | { state: "live"; commit: string; model: string; practice?: string; picker?: boolean }; // practice: the server in use
const PRACTICE = servers(import.meta.env.VITE_PRACTICE_SERVERS); // set at build time; none hides the practice option
const LIVE = "Practice server"; // the line names the server only; the card says how fast it is
const CHANGE_ASK = "This outline is not recorded yet. Change anyway?";
const SLOW = "On a standard computer without a graphics card, a click takes about 20 s (our test).";
const BUSY = PRACTICE.length > 1 ? "Both practice servers are in use. One is free again after 10 minutes without use." : "The practice server is in use. It is free again after 10 minutes without use.";
/** Safari blocks an https page's requests to the engine on this computer (WebKit bug 171934): "Your own computer" cannot work there. */
export const isSafari = (ua: string) => /safari/i.test(ua) && !/chrome|chromium|crios|fxios|firefox|edg|android/i.test(ua);
/** Why the note stays: real patient data belongs on the engine's own page, which alone shows names (the hosted page gets codes). */
export const REAL_DATA_NOTE = "For real patient data, use the tool's own page on your computer (http://localhost:8000), not this page.";
export const safariNote = (practice: boolean) => `In Safari, this page cannot reach the tool on your computer. Use Chrome or Firefox${practice ? ", or the practice server" : ""}. The tool's own page on your computer (http://localhost:8000) works in Safari.`;
const SAFARI = typeof navigator !== "undefined" && isSafari(navigator.userAgent);
const SAYS: Record<Exclude<PracticeState, "ready"> | "idle", string> = {
  paused: "The practice server is paused right now. To measure your own scans, use your own computer.",
  starting: "The practice server is waking, about 1 to 4 minutes; the page connects by itself.",
  idle: "This page stopped asking the practice server after 15 minutes without a click.", // its last answer is old, so the card shows this instead
  unavailable: "The practice server is starting or cannot be reached. We will try again.",
  busy: BUSY,
};
/** The practice card's status badge, one per state; no state yet: the first ask is on its way. */
const PILL: Record<PracticeState | "idle" | "checking", { text: string; cls: string; spin?: boolean }> = {
  checking: { text: "Checking", cls: "", spin: true },
  ready: { text: "Ready", cls: "ok" },
  starting: { text: "Waking", cls: "", spin: true },
  busy: { text: "In use", cls: "warn" },
  paused: { text: "Paused", cls: "warn" },
  idle: { text: "Stopped asking", cls: "" },
  unavailable: { text: "Not reachable", cls: "warn" },
};
/** The practice card in each state: its badge, its status line (none when ready or before the first answer) and its button's label. */
export const practiceCard = (s: PracticeState | "idle" | undefined) =>
  ({ pill: PILL[s ?? "checking"], said: s && s !== "ready" ? SAYS[s] : undefined, action: s === "busy" || s === "paused" || s === "idle" ? "Try again" : "Use the practice server" });
export const PRACTICE_PRINT = "Records from practice scans are kept apart from the study record."; // the practice rows (StudyView PRACTICE_LINE)
/** The practice card while it connects: the button says so at once, and only a wait past SLOW_CONNECT_MS says more, in the small-print line both
 *  cards always have, so nothing moves; a fast connect goes straight to the tool with no flash of any line. */
export const SLOW_CONNECT_MS = 400;
export const connectTexts = (connecting: boolean, slow: boolean) => ({
  button: connecting ? "Connecting…" : "Use the practice server",
  print: connecting && slow ? "Connecting to the practice server. This can take a few seconds." : PRACTICE_PRINT,
});
/** The practice card as shown: as it is, or while connecting. A connect that started from a card with a status box (Try again from busy or paused,
 *  the auto-connect after waking) keeps the box, with a connecting line, so its row keeps its height until the tool opens. */
export const connectingCard = (card: ReturnType<typeof practiceCard>, connecting: boolean, hadBox: boolean, slow: boolean) => {
  if (!connecting) return { pill: card.pill, said: card.said, button: card.action, print: PRACTICE_PRINT };
  return { pill: { text: "Connecting", cls: "", spin: true }, said: hadBox ? "Connecting to the practice server…" : undefined, button: "Connecting…",
    print: hadBox ? PRACTICE_PRINT : connectTexts(true, slow).print };
};
const svg = { viewBox: "0 0 24 24", width: 22, height: 22, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const SERVER_ICON = <svg {...svg}><rect x="3.5" y="4" width="17" height="6.5" rx="1.5" /><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" /><path d="M7 7.25h.01M7 16.75h.01M11 7.25h6M11 16.75h6" /></svg>;
const LAPTOP_ICON = <svg {...svg}><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M2.5 19h19" /></svg>;
/** The practice servers in list order, the next only when one cannot serve or has been starting for 5 minutes (practice.ts): a visit wakes one T4, not both. */
const wake = waking();
const askAll = (urls = PRACTICE) => askInOrder(urls, async (url) => { const s = await probe(url, accessToken()); wake.seen(url, s); return s; }, wake.stuck);
/** `?engine=local` (the installer opens the page with it): Measure then uses the local engine by itself, as a click on the button would.
 *  Never in Safari, which blocks the call: the page shows its Safari card as usual. */
export const wantsLocal = (search: string, safari = SAFARI) => !safari && new URLSearchParams(search).get("engine") === "local";
/** The local engine's Patients frame, only when that engine says it serves one (an older one goes straight to the drop-down), and never in Safari, which blocks it. */
export const localFrame = (picker: boolean | undefined, safari = SAFARI) => (picker && !safari ? LOCAL_ENGINE : undefined);

/** The live tool. Nothing calls localhost until the visitor clicks the button; the practice servers are asked at once. */
export function Measure({ uid, onInstall, onTutorial, cross, onScan }: { uid: string; onInstall: () => void; onTutorial?: () => void;
  cross?: { scan: string; z: number; y: number; x: number; tone?: "add" | "remove" }; onScan?: (scan: string | undefined, patients: Patients | null | undefined) => void }) { // the tutorial's two hooks into App
  const [engine, setEngine] = useState<Engine>({ state: "idle" });
  const [practice, setPractice] = useState<{ url: string; state: PracticeState }>();
  const [blocked, setBlocked] = useState<string>(); // a practice server's refusal (401, 423) or stop during use, in the page's own words
  const [asking, setAsking] = useState(false); // Try again waits for an answer
  const choseLocal = useRef(false); // once the visitor picks the local engine, the page never moves them to a practice server by itself
  const [idle, setIdle] = useState(false); // no click for IDLE_STOP_MS: the asking stopped until Try again
  const [slowConnect, setSlowConnect] = useState(false); // a practice connect still waiting after SLOW_CONNECT_MS
  useEffect(() => {
    if (engine.state !== "trying" || engine.local) { setSlowConnect(false); return; }
    const t = setTimeout(() => setSlowConnect(true), SLOW_CONNECT_MS);
    return () => clearTimeout(t);
  }, [engine]);
  const clicked = useRef(Date.now());
  useEffect(() => { const on = () => { clicked.current = Date.now(); }; addEventListener("click", on, true); return () => removeEventListener("click", on, true); }, []);
  const [waiting, setWaiting] = useState<{ n: number; note?: string }>({ n: 0 });
  const [newestWaits, setNewestWaits] = useState(false); // the newest Record's save waits: its own amber box in the panel says so
  const [open, setOpen] = useState(false); // an unrecorded outline is on the page (App says so)
  const [asked, setAsked] = useState(false); // Change was pressed with one open: the line asks first
  useEffect(() => onBlocked(setBlocked), []);
  useEffect(() => { // once: Measure stays mounted for the page's life. The parameter leaves the address, so a reload does not connect again.
    if (!wantsLocal(window.location.search)) return;
    connect();
    const u = new URL(window.location.href); u.searchParams.delete("engine");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
  }, []);
  useEffect(() => { // rows left waiting by an earlier visit are tried at once, then every RETRY_MS (retried, never lost)
    signedIn = uid;
    showWaiting = (n, note) => setWaiting({ n, note });
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key.startsWith(WAITING)) void box.sync(); }; // another tab saved or stored rows
    window.addEventListener("storage", onStorage);
    void box.flush();
    const t = setInterval(() => void box.flush(), RETRY_MS);
    return () => { clearInterval(t); window.removeEventListener("storage", onStorage); };
  }, [uid]);
  const live = engine.state === "live";
  const inUse = engine.state === "live" ? engine.practice : undefined;
  const others = waiting.n - (live && newestWaits ? 1 : 0);
  const wait = (others > 0 || waiting.note) && [others > 0 && `${others === 1 ? "1 row is" : `${others} rows are`} waiting for the study table; tried again every ${RETRY_MS / 1000} s.`, waiting.note].filter(Boolean).join(" ");
  const queued = wait && <p className="shell-status warn" role="status">{wait}</p>;
  // A practice server gets the visitor's Base44 token on every call, this check included (its /api/info sends the model only to a signed-in caller); the local engine never does.
  const shownBox = useRef(false), boxAtConnect = useRef(false); // the practice card showed a status box (at the moment a connect starts)
  const saidRow = useRef<HTMLDivElement>(null), rowAtConnect = useRef(0); // that box row's height then: kept while connecting, so nothing moves
  const attempt = useRef(0); // the newest connect wins: a slow local answer that arrives after the visitor chose a practice server is ignored
  const connect = (server?: string) => {
    if (!server) choseLocal.current = true;
    const mine = ++attempt.current;
    setBlocked(undefined); setIdle(false); // a connect is a click: the idle stop ends
    boxAtConnect.current = !!server && shownBox.current;
    rowAtConnect.current = boxAtConnect.current ? saidRow.current?.offsetHeight ?? 0 : 0;
    setEngine({ state: "trying", local: !server });
    setAuth(server && accessToken());
    probeEngine(server ?? LOCAL_ENGINE, server ? PROBE_MS : LOCAL_PROBE_MS).then(
      (info) => { if (mine !== attempt.current) return; setApiBase(server ?? LOCAL_ENGINE, !!server); setEngine({ state: "live", commit: info.commit, model: info.model, practice: server, picker: info.picker === true }); },
      () => { if (mine !== attempt.current) return; setAuth(undefined); setEngine({ state: server ? "idle" : "none" }); if (server) setPractice({ url: server, state: "unavailable" }); },
    );
  };
  // Ask every practice server now and every 10 s until an engine is live. A server that never answers costs the probe's time limit, in the background.
  // After "starting", a ready answer connects by itself, as that message promises, unless the visitor chose the local engine.
  useEffect(() => {
    if (!PRACTICE.length || live || idle) return;
    let alive = true, woke = false; // woke: "starting" was shown, so a later ready connects by itself (also after an unreachable answer in between)
    const ask = () => {
      if (Date.now() - clicked.current >= IDLE_STOP_MS) { setIdle(true); return; } // no ask, so a sleeping server stays asleep
      askAll().then((s) => {
        if (!alive) return;
        if (s.state === "starting") woke = true;
        if (s.state === "ready" && woke && !choseLocal.current) connect(s.url);
        setPractice(s);
      });
    };
    ask();
    const timer = setInterval(ask, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, [live, idle]); // Try again (idle false) asks at once and goes on asking
  // A 423 during use: another free practice server takes over by itself; busy shows until one does.
  useEffect(() => {
    const others = PRACTICE.filter((u) => u !== inUse);
    const at = attempt.current; // Change (or any newer connect) while this asks makes its answer moot
    if (blocked === IN_USE && inUse && others.length) askAll(others).then((s) => { if (at === attempt.current && s.state === "ready") connect(s.url); });
  }, [blocked]);
  const tryAgain = () => {
    setAsking(true);
    const at = attempt.current;
    askAll().then((s) => {
      setAsking(false);
      if (at !== attempt.current) return; // the visitor pressed Change, or chose another engine, while this asked
      if (s.state === "ready") connect(s.url);
      else if (live) setBlocked(s.state === "busy" ? IN_USE : PRACTICE_STOPPED);
      else setPractice(s);
    });
  };
  // Change goes back to the choice card. An unrecorded outline asks first, in the line (no browser dialog). Leaving a practice server gives its hold back at once.
  const leave = () => {
    attempt.current++; // a check still running for the old engine (Try again, the move after "in use", a slow connect) gives up
    void releaseSession(); // reads the server and the token now, before they are cleared
    setAuth(undefined); setApiBase(""); setBlocked(undefined); setAsked(false); setOpen(false); setEngine({ state: "idle" }); setIdle(false);
    newest = undefined; setNewestWaits(false); // the next engine starts with no "newest Record waits"
  };
  if (engine.state === "live") {
    const gone = blocked === PRACTICE_STOPPED, busy = blocked === IN_USE; // shown once, in the image area; a stop also turns the line amber
    const asking = asked && open; // once the outline is recorded or dropped, the question goes
    const canChange = !(SAFARI && engine.practice); // in Safari the only other choice is disabled: Change would just free the server for someone else
    const line = asking ? { cls: "warn", text: CHANGE_ASK, alert: true }
      : !engine.practice ? { cls: "ok", text: "Your own computer" }
      : blocked === SIGN_IN_FIRST ? { cls: "warn", text: blocked, alert: true }
      : { cls: gone ? "warn" : busy ? "" : "ok", text: gone ? PRACTICE_STOPPED : LIVE };
    return (
      <>
        {/* one top line: where the tool runs and Change (or the question), waiting rows on its right; it keeps one height, so the tool under it never moves */}
        <div className={`shell-status shell-line ${line.cls}`} role={line.alert ? "alert" : "status"}>
          <span title={engine.practice || asking ? undefined : `Engine commit ${engine.commit}`}>{line.text}{asking
            ? <> <button className="shell-link" onClick={leave}>Change</button><button className="shell-link" autoFocus onClick={() => setAsked(false)}>Cancel</button></>
            : canChange && <><span aria-hidden="true"> · </span><button className="shell-link" onClick={() => (open ? setAsked(true) : leave())}>Change</button></>}</span>
          {wait && <span className="shell-wait">{wait}</span>}
        </div>
        {/* the local engine: the Patients panel in its frame */}
        <div className="measure-sheet"><App embedded panel={!!engine.practice} frame={engine.practice ? undefined : localFrame(engine.picker)} onOpen={setOpen} cross={cross} onScan={onScan}
          onRecorded={(row, scan, report) => {
            const e = toEntities(row, scan, engine);
            newest = row.outline_file; setNewestWaits(false);
            sent.set(row.outline_file, { key: box.add(e, (s) => { report(s); if (newest === row.outline_file) setNewestWaits(s.state === "waiting"); if (s.state === "saved") preloadStudy(box.waiting); }, scan.spacing), e });
          }}
          knownNodules={(s) => box.highest(s.scan_ref)}
          onUndoRecord={(row) => { const s = sent.get(row.outline_file); if (newest === row.outline_file) setNewestWaits(false); forgetStudy(); return s && box.undo(s.key, s.e).finally(() => preloadStudy(box.waiting)); }}
          overlay={gone || busy ? <>
            <p role="alert">{gone ? PRACTICE_STOPPED : BUSY}</p>
            <div className="m-empty-actions">
              <button className="m-btn primary" onClick={tryAgain} disabled={asking}>Try again</button>
            </div>
          </> : undefined} /></div>
      </>
    );
  }
  const trying = engine.state === "trying", waitingLocal = engine.state === "trying" && engine.local;
  const toInstall = (text: string) => <a href="#install" onClick={(e) => { e.preventDefault(); onInstall(); }}>{text}</a>; // opens Run it on your computer, in this page
  const none = waitingLocal ? <p className="shell-status" role="status"><span className="shell-spinner" aria-hidden="true" />{WAITING_LOCAL}</p>
    : engine.state === "none" && <p className="shell-status warn" role="alert">No engine found on this computer. Start it (see {toInstall("Run it on your computer")}), then try again.</p>;
  const safari = SAFARI && <p id="safari-note" className="shell-status warn" role="note">{safariNote(PRACTICE.length > 0)}</p>;
  const s = idle ? "idle" : practice?.state, ready = s === "ready" ? practice : undefined, card = practiceCard(s);
  const connecting = trying && !waitingLocal, shown = connectingCard(card, connecting, boxAtConnect.current, slowConnect);
  shownBox.current = !!shown.said;
  const again = s === "idle" ? () => { setPractice(undefined); setIdle(false); /* a 15-minute-old answer is not shown as now */ } : tryAgain;
  // The landing: what the tool does, the tutorial, then one card per place the tool can run, the practice card with the server's live state.
  // Each card's five parts share rows across both cards (CSS subgrid), so the two main buttons sit at one height whatever each card says above them.
  return (
    <section className="landing" aria-label="Engine">
      <header className="landing-hero">
        <span className="landing-tag">Research aid</span>
        <h1>Outline a lung nodule on CT with a click</h1>
        <p>Then check it, correct it where needed, and record its size in the Study table. A research aid, not a medical device.</p>
        {onTutorial && <div className="landing-tour"><span>New here?</span><button className="shell-btn" onClick={onTutorial}>Start the tutorial</button></div>}
      </header>
      {queued}
      <h2>Choose where the tool runs</h2>
      <div className={PRACTICE.length ? "landing-cards" : "landing-cards one"}>
        {PRACTICE.length > 0 && <article className={ready ? "landing-card is-ready" : "landing-card"} aria-labelledby="landing-practice">
          <div className="landing-head">
            <span className="landing-icon">{SERVER_ICON}</span>
            <h3 id="landing-practice">Practice server</h3>
            <span className={`landing-pill ${shown.pill.cls}`}>{shown.pill.spin ? <span className="shell-spinner" aria-hidden="true" /> : <span className="landing-dot" aria-hidden="true" />}{shown.pill.text}</span>
          </div>
          <ul className="landing-facts"><li>Nothing to install</li><li>Public practice scans</li><li>About 1 s per click</li></ul>
          <div className="landing-said" ref={saidRow} style={connecting && rowAtConnect.current ? { minHeight: rowAtConnect.current } : undefined}>
            {shown.said && <p className="shell-status" role="status">{shown.said}</p>}
          </div>
          {connecting ? <button className="shell-btn primary" disabled aria-busy>{shown.button}</button>
            : shown.button === "Try again" ? <button className="shell-btn primary" onClick={again} disabled={s !== "idle" && asking}>Try again</button>
            : <button className="shell-btn primary" onClick={() => ready && connect(ready.url)} disabled={!ready}>{shown.button}</button>}
          <p className="shell-note" role={connecting ? "status" : undefined}>{shown.print}</p>
        </article>}
        <article className="landing-card" aria-labelledby="landing-local">
          <div className="landing-head">
            <span className="landing-icon">{LAPTOP_ICON}</span>
            <h3 id="landing-local">Your own computer</h3>
          </div>
          <ul className="landing-facts"><li>The engine and the scans stay on your computer</li><li>About 7 min to install ({toInstall("How to install it")})</li></ul>
          <div className="landing-said">{safari}{none}</div>
          {/* In Safari this https page cannot reach localhost, so the button is disabled, with the note as its reason. Primary only when it is the one choice. */}
          <button className={PRACTICE.length || SAFARI ? "shell-btn" : "shell-btn primary"} onClick={() => connect()} disabled={trying || SAFARI} aria-describedby={SAFARI ? "safari-note" : undefined}>Use your own computer</button>
          <p className="shell-note">{REAL_DATA_NOTE}</p>
        </article>
      </div>
      <p className="shell-note landing-slow">{SLOW}</p>
    </section>
  );
}

/** A page the person cannot use (not invited, Base44 unreachable, a build without an app id), in the tool's own look with the exact line.
 *  Signed in but not invited: Sign out, so they can try another account. */
export function Refused({ message }: { message: string }) {
  return (
    <div className="shell">
      <header className="shell-bar"><span className="shell-title">Lung nodule measurement</span></header>
      <main className="shell-main">
        <section className="shell-card shell-choice" aria-label="Sign-in">
          <p role="alert" className="shell-refused">{message}</p>
          {message === INVITE_ONLY && <div className="shell-actions"><button className="shell-btn primary" onClick={() => signOut()}>Sign out</button></div>}
        </section>
      </main>
      <footer className="shell-footer"><span>Research use only. Not a medical device.</span></footer>
    </div>
  );
}

const STORE = (() => { try { return localStorage; } catch { return undefined; } })(); // reading localStorage itself can throw where storage is blocked

export function Shell() {
  const [session, setSession] = useState<Session>();
  // Tutorial mode: offered once per browser, and the Tutorial button starts it at any time. It reads the page and acts on nothing; Exit keeps every Record.
  const [tutorial, setTutorial] = useState<"off" | "offer" | "on">(() => (shouldOffer(STORE, !!navigator.webdriver) ? "offer" : "off"));
  const [tour, setTour] = useState({ run: 0, step: undefined as string | undefined, scan: undefined as string | undefined, n: undefined as number | undefined });
  const onScan = useCallback((scan: string | undefined, p: Patients | null | undefined) => setTour((t) => (t.scan === scan && t.n === practiceN(p) ? t : { ...t, scan, n: practiceN(p) })), []);
  const onStep = useCallback((step?: string) => setTour((t) => (t.step === step ? t : { ...t, step })), []);
  const startTour = () => { markOffered(STORE); setTour((t) => ({ ...t, run: t.run + 1, step: undefined })); setTutorial("on"); }; // no step from an earlier run: no stale cross
  useEffect(() => { if (tutorial === "offer" && session?.kind === "user") markOffered(STORE); }, [tutorial, session?.kind]); // offered once: when it shows
  const [tab, setTab] = useState<Tab | "Install">("Measure"); // Install (Run it on your computer) has no tab
  const [seen, setSeen] = useState<Tab[]>(["Measure"]); // Measure stays mounted once opened, so a scan and its table survive a tab change
  const about = useRef<HTMLDialogElement>(null);
  const [left, setLeft] = useState(0); // this person's rows still waiting: they are sent only when this person signs in again here
  useEffect(() => { showLeft = setLeft; resolveSession(currentUser, signIn, guardStore(), configError).then(setSession, () => setSession({ kind: "error", message: NO_BASE44 })); }, []);
  useEffect(() => { if (session?.kind === "user") preloadStudy(box.waiting); }, [session?.kind]); // (b) the Study table's rows load with the signed-in page, not on the tab's press
  if (session?.kind === "error") return <Refused message={session.message} />;
  if (session?.kind !== "user") return null; // loading, or on its way to Base44's sign-in
  const user = session.user;
  const pick = (t: Tab) => { setTab(t); setSeen((s) => (s.includes(t) ? s : [...s, t])); };
  return (
    <div className="shell">
      <header className="shell-bar">
        <Logo />
        <div className="shell-tabs" role="tablist">
          {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className="shell-tab" onClick={() => pick(t)}>{t}</button>)}
        </div>
        <button className="shell-btn" onClick={(e) => { if (e.detail > 0) e.currentTarget.blur(); startTour(); }}>Tutorial</button>{/* blurred after a mouse click, so Enter records */}
        {/* the waiting line goes before the name: the group is right-aligned, so the name and Sign out stay where they are */}
        <div className="shell-user">{left > 0 && <span role="status" className="shell-left">{signOutLine(left)}</span>}<span>Signed in as {user.email}</span><button className="shell-btn" onClick={() => signOut()}>Sign out</button></div>
      </header>
      {tutorial !== "off" && <Coach key={tour.run} mode={tutorial} scan={tour.scan} patientN={tour.n} onStart={startTour} onDecline={() => setTutorial("off")} onLater={() => { unmarkOffered(STORE); setTutorial("off"); }} onExit={() => setTutorial("off")} onStep={onStep} />}
      <main className="shell-main">
        {seen.includes("Measure") && <div hidden={tab !== "Measure"}><Measure uid={user.id} onInstall={() => setTab("Install")} onTutorial={startTour}
          cross={tutorial !== "on" ? undefined : tour.step === "cross" ? CASE.cross : tour.step === "correct" ? CASE.fix : undefined} onScan={tutorial === "on" ? onScan : undefined} /></div>}
        {tab === "Study table" && <StudyView onRemove={(scanRef, m, reason) => box.remove(scanRef, m, reason)} waiting={box.waiting} pending={box.pending} onGoToMeasure={() => pick("Measure")} />}
        {tab === "Install" && <InstallView onBack={() => pick("Measure")} />}
      </main>
      <footer className="shell-footer">
        <span>Research use only. Not a medical device. <a href="#about" onClick={(e) => { e.preventDefault(); about.current?.showModal(); }}>About</a> · <a href="#install" onClick={(e) => { e.preventDefault(); setTab("Install"); }}>Run it on your computer</a></span>
      </footer>
      <About dialog={about} />
    </div>
  );
}
