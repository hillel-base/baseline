# Changelog

## 0.1.3 (2026-10-28)

An update refreshes the local page, a richer Study table, and the tutorial starts at Practice patient 1. Research use only.

**Install and start**
- Running the install command again after a new version now builds the local page again (or downloads it, without Node). Before, an update kept the old page, so the Patients panel in the hosted page's frame could show an older Change folder…. An install from before this version refreshes its page once. If the rebuild or the download fails, the old page stays and the tool starts.

**Study table**
- A **More details** switch adds each scan's series number and slice thickness, the days between scans, and each nodule's volume change from the previous scan. On scans from the same day the change is labelled "(same day)": it is the repeat difference, not growth.
- The headers sort the table. **Search codes** finds a patient code, and a filter shows Approved or Edited rows only.
- Download CSV adds two columns at the end: `days_between` and `volume_change_pct`. The other columns keep their names and order.
- The practice-rows notice is the title's second line, so the table no longer moves down when the rows arrive.

**Tutorial and the hosted page**
- The tutorial's highlight ring sits an even 4 px round its target, with the target's own corner shape.
- The Demo has no tab in the top bar. The choice card offers it while no practice server is ready, and so does the message when a server stops answering.
- On a practice server, the tutorial's case is Practice patient 1.

## 0.1.2 (2026-10-28)

The nodule finder on by default, eight practice patients, a cleaner wait and folder choice, and Snap to tissue keeps ground glass. Research use only.

**Measure**
- Paint's Snap to tissue now keeps −750 HU and above (it was above −500 HU), so the hazy ground-glass part of a nodule stays in while air stays out. This follows the lab's convention of including ground glass in the nodule volume; −750 HU is the published lower bound for ground glass. It applies only to a Paint stroke with Snap on, which is off by default, on both pages. Clicks, Erase, Axes and the model are unchanged.
- While a scan opens, the image area shows a plain square with a slow scan line and the time to expect. Under reduced motion it stands still.
- Change folder… in the Patients panel is a folder view in the sheet's own style:
  - a title and one line on what to pick;
  - the path as a breadcrumb, and folder rows;
  - Type a path behind a link;
  - the engine's refusals in amber;
  - one Use this folder button beside Cancel. It is off at the top folder, which the engine refuses.
- The Study table loads its rows in the background when the page signs in, so the tab usually opens with them. Until they come, it shows its own layout with placeholder rows.
- Earlier nodules is a heading that names the Baseline. Each row is one line.

**Install and start**
- The nodule finder is on by default on macOS and Linux. Setup turns it on only after it loads; if it cannot, setup says why and the tool starts without it. Windows keeps it off, as before.
- A local install gets 8 practice patients, not 3. `./lung.sh fetch --all` (Windows: `.\lung.ps1 fetch --all`) gets all 28. The 25 beyond the 3 development patients are CT only.
- A first install takes about 7 minutes on a Mac with Apple silicon and uses about 4.8 GB of disk (our test).

**Practice servers**
- In server mode the engine reads a scan's files in parallel before it decodes them, and with `LUNG_WARMUP=1` it reads every practice scan once at start (the tutorial case first), pausing while a visitor loads. A local install is unchanged.

**Results**
- The results now say which expert reference matches the lab's outline style (spikes and hazy ground glass included): the outlines steered toward the RIDER expert (R1) are the closer guide, and the radiologists' outlines stay reported. "18 of 18" is the 9-in-10 range; within the expert's usual change it is 15 of 18. No number changed.

## 0.1.1 (2026-10-27)

The Patients panel, an optional nodule finder, and faster scrolling on the practice server. Research use only.

**Patients panel**
- The Patients button in the top bar, in place of the scan list, opens a panel: the patients on the left, with a search box, and the chosen patient's scans by date on the right (Baseline, then each Follow-up with its day count). Each scan shows how many nodules this page has recorded on it.
- "‹ Baseline" and "Follow-up ›" beside the button, or Alt+← and Alt+→, open the patient's other scans.
- The panel groups the scans by their DICOM headers (patient, study date, series), in any folder layout, and lists axial CT images only.
- Folders open through the panel's "Change folder…". The separate "Open a CT folder…" button is gone.
- On the page on your computer, the panel shows patient names and dates. On the hosted page it shows inside a frame that the engine on your computer draws (Chrome and Firefox), so the hosted page gets scan codes only, never a name or a date. On a practice server it lists the public practice patients as "Practice patient 1", "2" and so on.

**Nodule finder (optional)**
- "Find nodules" over the image lists suggestions to check, not findings. They show as numbered rings on the image and ticks on the slice bar. Measure starts an outline at a suggestion. Not a nodule strikes it out, and Undo takes that back.
- The finder is a separate program in `finder/`, under AGPL-3.0, with its own licence and notices. It is off unless you turn it on (see the README).
- In our tests it found about 7 in 10 of the nodules that radiologists marked on public screening scans, with about 2 extra marks per scan, and it can miss large tumours. Read the whole scan as usual.

**Practice server**
- Faster scrolling: the page asks for every slice at one address, so the browser checks that address once every 10 minutes instead of once per slice.
- When the server is paused, the page names the next step: the Demo to try the tool, or your own computer for your own scans.
- A sleeping server shows as starting, and the page says it takes about 1 minute.
- The page asks the first server first, and the second only when the first cannot serve.
- After 15 minutes without a click, the page stops asking the practice servers. Try again asks once more.

**Results**
- The results, and the scripts and run tables that produced them, are in `results/`.

## 0.1.0 (2026-10-27)

The first public version. Research use only.

**Install and start**
- One command installs and starts the tool on macOS, Linux and Windows (`install.sh`, `install.ps1`). It installs uv and Python 3.11, the engine's packages, the nnInteractive model weights and three public practice patients, then starts the engine on `http://localhost:8000`.
- The page for your own computer (`http://localhost:8000`) is built with Node, or downloaded from the release (`baseline-page.zip`) when Node is missing.
- The command opens the hosted page, connected to the engine on your computer (in Chrome on a Mac), or `http://localhost:8000` on a Mac without Chrome.
- Running the command again updates the code and starts the engine. Steps already done are skipped.
- Runs on a Mac with Apple silicon, a PC with an NVIDIA graphics card, or a standard PC without one (slower).

**Measure**
- Open a practice scan, or a CT folder (DICOM) on your own computer, and scroll through it. Zoom and pan.
- One click on a nodule outlines it in 3D and shows its long axis, short axis, volume and depth.
- Correct the outline with Add and Remove clicks, or with the Paint and Erase brush. Drag an axis end to set an axis by hand.
- Undo and Start over.
- The page warns when an outline reaches the edge of the model's window.
- While a slice is loading, the page says so ("Loading image …"), and a click counts once that image shows.
- Each control shows its keyboard key. Press ? to list them all.

**Record**
- Record a nodule to the table. Copy a row, download the table as CSV, or save a screenshot.
- The engine saves each recorded outline as a NIfTI file and logs every action, for timing and checks.

**Follow-up scans**
- On a patient's second scan, the page proposes where an earlier recorded nodule is. You confirm it, or click the nodule yourself.

**Hosted page**
- A hosted copy of the page: sign-in, Measure, a Study table of saved numbers, a Demo of recorded results, and the install steps.
- Measure on the hosted page uses the engine on your own computer, or an invite-only practice server. The top line names which one, with Change to go back to the choice.
- The Study table: one line per nodule, with the baseline and follow-up scans side by side. Rows are only added. Remove takes a row out with a reason, and Undo takes back a Record. A Record near an earlier one on the same scan re-measures it and keeps its label. A save that waits is tried again every 15 s, and practice rows are kept apart from the study record.
- The scans stay on your computer. Only numbers and short labels are saved. The hosted page gets a code for each scan, never a folder or patient name (the public practice patients aside). Folders can be opened only from the page on your computer.
- In Safari, the hosted page says that it cannot reach the engine on your computer, and offers the alternatives.

**Not included in 0.1.0**
- The nodule finder (an optional detector that suggests where to click): added in 0.1.1.
