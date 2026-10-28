# Changelog

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
