import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App";
import { Measure, PRACTICE_PRINT, Refused, practiceCard, wantsLocal, connectTexts, connectingCard } from "./Shell";
import { INVITE_ONLY, NO_BASE44 } from "./session";

test("a refused or failed sign-in gets the tool's dark page and card with the exact line; not invited also gets Sign out", () => {
  const invite = renderToString(<Refused message={INVITE_ONLY} />);
  expect(invite).toMatch(/^<div class="shell">/); // the themed page, not a bare paragraph
  expect(invite).toContain('<section class="shell-card shell-choice" aria-label="Sign-in"><p role="alert" class="shell-refused">You are signed in, but this app is invite-only. Ask the app&#x27;s admin for an invite.</p>');
  expect(invite).toContain('<button class="shell-btn primary">Sign out</button>');
  const down = renderToString(<Refused message={NO_BASE44} />);
  expect(down).toContain(`<p role="alert" class="shell-refused">${NO_BASE44}</p>`);
  expect(down).not.toContain("Sign out"); // not known to be signed in: reloading is the way, as the line says
});

test("only ?engine=local asks Measure to use the local engine by itself", () => {
  for (const s of ["?engine=local", "?a=1&engine=local", "?engine=local&access_token=x"]) expect(wantsLocal(s)).toBe(true);
  for (const s of ["", "?engine=", "?engine=LOCAL", "?engine=practice", "?local", "?engine=local2"]) expect(wantsLocal(s)).toBe(false);
  expect(wantsLocal("?engine=local", true)).toBe(false); // Safari blocks the call: no auto-connect there
});

// The hosted e2e build always lists a stand-in practice server, so a build without one (VITE_PRACTICE_SERVERS unset, as here) is checked in this file.
test("with no practice server configured, the landing shows the local card alone, its button primary, no practice text and no Demo", () => {
  const html = renderToString(<Measure uid="u1" onInstall={() => {}} onTutorial={() => {}} />);
  expect(html).toContain("<h1>Outline a lung nodule on CT with a click</h1>");
  expect(html).toContain("<p>Then check it, correct it where needed, and record its size in the Study table. A research aid, not a medical device.</p>");
  expect(html).toContain('<button class="shell-btn">Start the tutorial</button>');
  expect(html).toContain('<button class="shell-btn primary">Use your own computer</button>');
  expect(html).not.toMatch(/practice/i);
  expect(html).not.toMatch(/demo/i);
  expect(html).toContain("For real patient data, use the tool&#x27;s own page on your computer (http://localhost:8000), not this page."); // until the scan list shows codes instead of folder names
});

test("the practice card's badge, status line and button in each state (the landing)", () => {
  const card = (s: Parameters<typeof practiceCard>[0]) => { const c = practiceCard(s); return [c.pill.text, c.said, c.action]; };
  expect(card(undefined)).toEqual(["Checking", undefined, "Use the practice server"]); // the first ask is on its way
  expect(card("ready")).toEqual(["Ready", undefined, "Use the practice server"]);
  expect(card("starting")).toEqual(["Waking", "The practice server is waking, about 1 to 4 minutes; the page connects by itself.", "Use the practice server"]);
  expect(card("paused")).toEqual(["Paused", "The practice server is paused right now. To measure your own scans, use your own computer.", "Try again"]);
  expect(card("busy")).toEqual(["In use", "The practice server is in use. It is free again after 10 minutes without use.", "Try again"]); // one server in this build
  expect(card("idle")).toEqual(["Stopped asking", "This page stopped asking the practice server after 15 minutes without a click.", "Try again"]);
  expect(card("unavailable")).toEqual(["Not reachable", "The practice server is starting or cannot be reached. We will try again.", "Use the practice server"]);
  expect(PRACTICE_PRINT).toBe("Records from practice scans are kept apart from the study record.");
  for (const s of [undefined, "ready", "starting", "paused", "busy", "idle", "unavailable"] as const) expect(JSON.stringify(practiceCard(s))).not.toMatch(/demo/i);
});
test("no page has the top-bar Open a CT folder… button: folders open through the Patients panel", () => {
  expect(renderToString(<App />)).not.toContain("Open a CT folder…"); // folders open only through the Patients panel's Change folder…
  expect(renderToString(<App embedded />)).not.toContain("Open a CT folder…");
});

test("isSafari: Safari on Mac and iPhone yes; Chrome, Edge, Firefox (which also say Safari or Gecko) no", async () => {
  const { isSafari } = await import("./Shell");
  const ua = {
    safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
    safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
    chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
    edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:144.0) Gecko/20100101 Firefox/144.0",
  };
  expect(Object.fromEntries(Object.entries(ua).map(([k, v]) => [k, isSafari(v)]))).toEqual({ safariMac: true, safariIos: true, chrome: false, chromeIos: false, edge: false, firefox: false });
});

test("the Safari note names the practice server only when one is configured, and points to the tool's own page", async () => {
  const { safariNote } = await import("./Shell");
  expect(safariNote(true)).toBe("In Safari, this page cannot reach the tool on your computer. Use Chrome or Firefox, or the practice server. The tool's own page on your computer (http://localhost:8000) works in Safari.");
  expect(safariNote(false)).toBe("In Safari, this page cannot reach the tool on your computer. Use Chrome or Firefox. The tool's own page on your computer (http://localhost:8000) works in Safari.");
});

test("connecting to the practice server changes no layout: the button says Connecting… at once; only a wait past 400 ms says more, in the small-print line both cards already have", () => {
  expect(connectTexts(false, false)).toEqual({ button: "Use the practice server", print: "Records from practice scans are kept apart from the study record." });
  expect(connectTexts(true, false)).toEqual({ button: "Connecting…", print: "Records from practice scans are kept apart from the study record." }); // a fast connect: no flash of any line
  expect(connectTexts(true, true)).toEqual({ button: "Connecting…", print: "Connecting to the practice server. This can take a few seconds." });
});

test("while connecting, the card says connecting whatever it said before: Try again from busy or paused, and the auto-connect after waking keep their status box (its row keeps its height) with a connecting line, and the button is Connecting…", () => {
  const fromBusy = connectingCard(practiceCard("busy"), true, true, false);
  expect(fromBusy).toMatchObject({ pill: { text: "Connecting", spin: true }, said: "Connecting to the practice server…", button: "Connecting…", print: PRACTICE_PRINT });
  const afterWaking = connectingCard(practiceCard("ready"), true, true, true); // the server answered ready, so the card is ready; the waking box's row is kept
  expect(afterWaking).toMatchObject({ said: "Connecting to the practice server…", button: "Connecting…", print: PRACTICE_PRINT });
  expect(connectingCard(practiceCard("ready"), true, false, false)).toMatchObject({ said: undefined, button: "Connecting…", print: PRACTICE_PRINT }); // from ready: no box, no flash
  expect(connectingCard(practiceCard("ready"), true, false, true).print).toBe("Connecting to the practice server. This can take a few seconds."); // a slow one says so in the small print
  expect(connectingCard(practiceCard("busy"), false, false, false)).toMatchObject({ pill: { text: "In use" }, button: "Try again", print: PRACTICE_PRINT }); // not connecting: the card as it is
});
