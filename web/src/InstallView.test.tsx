import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { About } from "./About";
import { COMMANDS, COPY_FAILED, InstallView, TOOL_REPO_RAW, copy } from "./InstallView";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const MAC = "curl -fsSL https://raw.githubusercontent.com/hillel-base/baseline/main/install.sh | bash";
const WIN = "irm https://raw.githubusercontent.com/hillel-base/baseline/main/install.ps1 | iex";

test("the install view shows one command per system from TOOL_REPO_RAW, what happens next and what you need", () => {
  expect(TOOL_REPO_RAW).toBe("https://raw.githubusercontent.com/hillel-base/baseline/main");
  expect(COMMANDS.map((c) => c.cmd)).toEqual([MAC, WIN]);
  const html = renderToString(<InstallView onBack={() => {}} />), t = text(html);
  for (const line of [
    "Run it on your computer",
    "The tool can run on your own computer, with the same three public practice scans. Research use only.",
    "It also opens CT folders on your computer, with Change folder… in the Patients panel: on the tool's own page, and on this page in Chrome or Firefox.",
    "On a Mac or Linux, open Terminal and run:", MAC,
    "On Windows, open PowerShell and run:", WIN,
    "The first start installs the tool's packages and downloads the model weights and the three practice patients: about 1.8 GB on a Mac (about 3 GB more on Linux). It took about 5 minutes on a Mac with Apple silicon (our tests). Later starts are quick.",
    "The command then opens this page, which connects to the engine on your computer by itself, and your Records are saved to the Study table. If it does not connect, choose Your own computer, or Use my local engine. Chrome asks once whether this site may use apps on your device; allow it.",
    "On a Mac without Chrome, the command opens the tool's own page instead (http://localhost:8000), which works in Safari. That page works without Base44 and saves nothing to it.",
    "What you need",
    "An Apple-chip Mac with 16 GB of memory or more, or a PC with an NVIDIA graphics card, or an ordinary Intel or AMD PC without one.",
    "On a standard computer without a graphics card, a click takes about 20 s (our test).",
    "About 6 GB of free disk (12 GB on Linux), and internet for the first start.",
    "Research use only. Not a medical device.",
    "Back to Measure",
  ]) expect(t).toContain(line);
  expect(t.indexOf("The command then opens this page")).toBeLessThan(t.indexOf("On a Mac without Chrome")); // Base44 first
  expect(t.indexOf("Research use only.") + "Research use only.".length).toBe(t.indexOf("It also opens CT folders")); // the folders line comes right under the first sentence
  expect(html.match(/<button class="shell-btn">Copy<\/button>/g)).toHaveLength(2);
  expect(t).not.toMatch(/start file|\.command|\.bat|zip/i);
});

test("Copy writes the exact command to the clipboard, and the button reads Copied for 2 s", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const shown: string[] = [];
  await copy(MAC, (s) => shown.push(s));
  expect(writeText).toHaveBeenCalledWith(MAC);
  expect(shown).toEqual(["copied"]);
  vi.advanceTimersByTime(1999);
  expect(shown).toEqual(["copied"]);
  vi.advanceTimersByTime(1);
  expect(shown).toEqual(["copied", "idle"]);
});

test("Copy refused, or no Clipboard API at all: the plain line, never an uncaught error", async () => {
  for (const nav of [{ clipboard: { writeText: vi.fn(async () => { throw new Error("NotAllowedError"); }) } }, {}]) {
    vi.stubGlobal("navigator", nav);
    const shown: string[] = [];
    await expect(copy(MAC, (s) => shown.push(s))).resolves.toBeUndefined();
    expect(shown).toEqual(["failed"]);
  }
  expect(COPY_FAILED).toBe("Copy failed. Select the command and copy it by hand.");
});

test("the hosted Shell links no GitHub page but the public Baseline source in About: How to install it opens the view in the page, not a new tab", async () => {
  vi.stubEnv("VITE_PRACTICE_SERVERS", "https://practice.example"); // with a practice server the card shows How to install it
  const { Measure } = await import("./Shell");
  const card = renderToString(<Measure uid="u1" onDemo={() => {}} onInstall={() => {}} />);
  expect(card).toMatch(/<a href="#install">How to install it<\/a>/);
  for (const html of [card, renderToString(<InstallView onBack={() => {}} />)]) expect(html).not.toContain("github.com"); // the commands name raw.githubusercontent.com as text, never a link
  const about = renderToString(<About />); // About links one page only: the public Baseline repository, the finder's AGPL source
  expect(about).toContain('href="https://github.com/hillel-base/baseline"');
  expect(about.replaceAll("github.com/hillel-base/baseline", "")).not.toContain("github.com");
});
