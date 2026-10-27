import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App";
import { Measure, Refused, wantsLocal } from "./Shell";
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

// The hosted e2e build always lists a stand-in practice server, so the deployed setting (VITE_PRACTICE_SERVERS unset, as here) is checked in this file.
test("with no practice server configured, Measure keeps its first-click card: the old line, one primary button, no practice text", () => {
  const html = renderToString(<Measure uid="u1" onDemo={() => {}} onInstall={() => {}} />);
  expect(html).toContain("Measure uses the engine on this computer.");
  expect(html).toContain('<button class="shell-btn primary">Use my local engine</button>');
  expect(html).not.toMatch(/practice/i);
  expect(html).toContain("For real patient data, use the tool&#x27;s own page on your computer (http://localhost:8000), not this page."); // until the scan list shows codes instead of folder names
});
test("the folder button shows for the local engine and not for a practice server", () => {
  expect(renderToString(<App embedded />)).toContain("Open a CT folder…");
  expect(renderToString(<App embedded folders={false} />)).not.toContain("Open a CT folder…");
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
