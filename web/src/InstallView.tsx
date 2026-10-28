import { useState } from "react";

/** Baseline, the public repository that holds only the tool, as raw files. Its install.sh and install.ps1 fetch the tool and start it. */
export const TOOL_REPO_RAW = "https://raw.githubusercontent.com/hillel-base/baseline/main";
export const COMMANDS = [
  { label: "On a Mac or Linux, open Terminal and run:", cmd: `curl -fsSL ${TOOL_REPO_RAW}/install.sh | bash` },
  { label: "On Windows, open PowerShell and run:", cmd: `irm ${TOOL_REPO_RAW}/install.ps1 | iex` },
];

export const COPY_FAILED = "Copy failed. Select the command and copy it by hand.";
type CopyState = "idle" | "copied" | "failed";
/** Copies cmd to the clipboard: `show("copied")`, then `show("idle")` 2 s later, turns the button into Copied and back.
 *  Refused, or no Clipboard API at all (as App.tsx's Copy row): `show("failed")`, and the command stays on screen to copy by hand. */
export async function copy(cmd: string, show: (s: CopyState) => void) {
  try { await navigator.clipboard.writeText(cmd); } catch { show("failed"); return; }
  show("copied");
  setTimeout(() => show("idle"), 2000);
}

function Command({ label, cmd }: { label: string; cmd: string }) {
  const [state, setState] = useState<CopyState>("idle");
  return (
    <>
      <div className="shell-command-head"><p>{label}</p><button className="shell-btn" onClick={() => copy(cmd, setState)}>{state === "copied" ? "Copied" : "Copy"}</button></div>
      <code className="shell-command">{cmd}</code>
      {state === "failed" && <p className="shell-note" role="alert">{COPY_FAILED}</p>}
    </>
  );
}

/** Run it on your computer: the hosted page's own install steps (no link out of the page). */
export function InstallView({ onBack }: { onBack: () => void }) {
  return (
    <section className="shell-card shell-install" aria-labelledby="install-title">
      <button className="shell-btn" onClick={onBack}>Back to Measure</button>
      <h2 id="install-title">Run it on your computer</h2>
      <p>The tool can run on your own computer, with the same three public practice scans. Research use only.</p>
      <p>It also opens CT folders on your computer, with Change folder… in the Patients panel: on the tool's own page, and on this page in Chrome or Firefox.</p>
      <ol>
        <li>{COMMANDS.map((c) => <Command key={c.cmd} {...c} />)}</li>
        <li>The first start installs the tool's packages and downloads the model weights and the three practice patients: about 1.8 GB on a Mac (about 3 GB more on Linux). It took about 5 minutes on a Mac with Apple silicon (our tests). Later starts are quick.</li>
      </ol>
      <p>The command then opens this page, which connects to the engine on your computer by itself, and your Records are saved to the Study table. If it does not connect, choose Your own computer, or Use my local engine. Chrome asks once whether this site may use apps on your device; allow it.</p>
      <p>On a Mac without Chrome, the command opens the tool's own page instead (http://localhost:8000), which works in Safari. That page works without Base44 and saves nothing to it.</p>
      <h3>What you need</h3>
      <ul>
        <li>An Apple-chip Mac with 16 GB of memory or more, or a PC with an NVIDIA graphics card, or an ordinary Intel or AMD PC without one.</li>
        <li>On a standard computer without a graphics card, a click takes about 20 s (our test).</li>
        <li>About 6 GB of free disk (12 GB on Linux), and internet for the first start.</li>
      </ul>
      <p className="shell-note">Research use only. Not a medical device.</p>
    </section>
  );
}
