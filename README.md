<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-lockup-dark.svg">
    <img src="docs/logo-lockup-light.svg" alt="Baseline" width="360">
  </picture>
</p>

<h3 align="center">Lung nodule measurement on CT, a research aid</h3>

<p align="center">Outline and measure a lung nodule on CT in one click, then correct it with a few more.</p>

<p align="center">
  <a href="https://github.com/hillel-base/baseline/actions/workflows/windows-setup.yml"><img src="https://github.com/hillel-base/baseline/actions/workflows/windows-setup.yml/badge.svg" alt="windows-setup"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
</p>

> **Research use only. Not a medical device.** Baseline does not diagnose, and its measurements are not for clinical decisions.

## Quick start

**macOS or Linux** (Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/hillel-base/baseline/main/install.sh | bash
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/hillel-base/baseline/main/install.ps1 | iex
```

The command:
1. Gets the code into `~/Baseline` (`%USERPROFILE%\Baseline` on Windows), with git if you have it, or as a download.
2. Installs uv and Python 3.11 if they are missing.
3. Gets the page for your own computer: it builds it with Node 22.12 or newer, or downloads it from this version's release.
4. Installs the engine's packages.
5. Downloads the model weights (392 MB) from their publisher.
6. Downloads three public practice patients (about 0.9 GB) from NCI Imaging Data Commons.
7. Starts the engine on `http://localhost:8000`.
8. Opens the page:
   - **Mac with Chrome:** the Baseline page, in Chrome. It connects to the engine on your computer by itself.
   - **Mac without Chrome:** the page on your own computer, `http://localhost:8000`, in your default browser. Safari can use it (see [Safari](#troubleshooting)).
   - **Linux and Windows:** the Baseline page, in your default browser. It connects to the engine on your computer by itself.

On a Mac with Apple silicon (M4 Pro), the first run took about 5 minutes from the command to a running engine (4 min 31 s, 5 min 14 s and 4 min 39 s in three clean installs). It downloaded about 1.8 GB and used about 3 GB of disk. Run the same command again to update the code and start the tool: steps already done are skipped, and the engine was running again in about 10 s. Stop the engine with Ctrl+C, or close the window.

Then:
1. **Sign in** (the Baseline page only). It is invite-only. Without an invitation, open `http://localhost:8000` instead: the page on your own computer needs no sign-in.
2. **Pick a scan.**
3. **Click the nodule.** The outline appears, with its long axis (magenta), its short axis (cyan) and its volume.
4. **Correct the outline:** an **Add** click where it misses, a **Remove** click where it spills over, or Paint and Erase by hand.
5. **Record.** The numbers go to your table. Copy the row, or download the table as CSV. On the Baseline page they are also saved to the **Study table**.

Each control shows its keyboard key. Press **?** to list them all. While the page says "Loading image …", wait: a click counts once that image shows.

## No install: the practice server

If you have an invitation to the Baseline page, choose **Practice server** in Measure. The engine then runs on our server, which has a graphics card, so you install nothing.
- **Scans:** the three public practice patients only.
- **One person at a time:** others see a short wait message.
- **Sometimes paused:** the page then says so and offers the Demo, recorded results that need no engine.
- **Change:** the top line names where the tool runs ("Practice server · Change" or "Your own computer · Change"). **Change** goes back to the choice. If an outline is not recorded yet, the page asks first. Leaving the practice server frees it for the next person at once.

## Requirements and speed

| Computer | Time per click | Memory | Notes |
|---|---|---|---|
| Mac with Apple silicon | about 1–2 s (1.2 s on an M4 Pro) | 16 GB or more (one click peaks at about 10 GB) | uses the Mac's graphics chip |
| PC with an NVIDIA graphics card | about 0.4 s on an NVIDIA T4; other cards not measured | | uses CUDA |
| Standard PC without a graphics card (Intel or AMD) | about 20 s (32 s on a 2-core cloud machine) | 16 GB recommended (one click peaks at about 6–7 GB) | |
| Practice server | about 0.4 s (an NVIDIA T4); the first click after the server starts takes about 4 s | nothing on your computer | the same outlines as on a Mac |

- **Disk:** about 6 GB free on macOS and Windows, about 12 GB on Linux. On Linux the default PyTorch build includes the NVIDIA libraries, even without a graphics card (about 3 GB more to download).
- **Browser:** Chrome or Firefox for the Baseline page. Chrome asks you once whether the page may connect to apps on your device: choose **Allow**. Any browser, Safari too, for the page on your own computer (`http://localhost:8000`). Safari cannot use the Baseline page with your own engine, see [Troubleshooting](#troubleshooting).
- **Internet:** needed for the first run.
- **Not supported:** a Mac with Apple silicon whose graphics chip PyTorch cannot use is refused.

## How it works

```mermaid
flowchart LR
  subgraph PC["Your computer"]
    B["Browser: the Baseline page"] -- "clicks" --> E["Engine (localhost:8000)"]
    E -- "outline and measurements" --> B
    E <--> M["nnInteractive model"]
    S[("CT scans")] --> E
  end
  B -- "numbers only" --> R[("Hosted page: sign-in and saved records")]
```

- **The page:** a hosted copy runs at https://lung-measure.base44.app (on Base44, which also handles sign-in and keeps the saved records). The engine also serves the page itself, at `http://localhost:8000`: Measure only, with no sign-in, and nothing is saved to Base44. Only this page can open a CT folder.
- **The engine:** a small Python server on your own computer. It reads the scans and runs the outline model, [nnInteractive](https://github.com/MIC-DKFZ/nnInteractive) (DKFZ).
- **One click** starts a 3D outline. Each correction click updates it. The engine then measures the outline:
  - the long axis, the longest line across it on the slice where that line is longest;
  - the short axis, the longest line at right angles to it;
  - the volume and the depth.

  Widths are measured edge to edge, like a ruler.

## Privacy

- **The scans never leave your computer.** The engine reads them locally, and the page shows them straight from the engine.
- **The hosted page saves numbers and short labels only.** For example: long axis, short axis, volume, number of clicks, and a random code for each scan. Base44 never receives images, names, study dates, DICOM UIDs or folder paths.
- **For your own scans, use the page on your computer (`http://localhost:8000`).** It is the only page that shows patient names. The hosted page gets a random code for each of your scans instead; only the three public practice patients keep their public names.
- **The engine answers only the Baseline page's own address.** A page on another site cannot use it. Folders can be opened only from the page on your computer.

## Known limits

- **Reach:** an outline reaches at most about 50 mm from the click (80 voxels at 0.625 mm pixels). The page warns when an outline touches that edge.
- **Spiculated nodules** (nodules with spikes at the edge): the first outline takes the solid core and leaves the spikes out.
  - This was tested on 10 public nodules rated "marked" by radiologists (LIDC-annot-NLST501). The first outline was about a third smaller than the radiologists' consensus.
  - Up to 5 corrections brought 9 of the 10 within the radiologists' own disagreement.
- **Follow-up scans:** matching a nodule on a follow-up scan was tested on same-day scan pairs. Real follow-ups months apart, with several nodules, will be less accurate. The match is a proposal that you confirm.
- **Touching structures:** on a tumour that touches another structure, the outline can run along it. Check the outline and correct it.
- **Nodule finder** (suggests where to click): not included yet.
<!-- later: when the finder ships, add it here and its credits (its own program, AGPL-3.0; weights CC BY 4.0) under Credits. -->

## Troubleshooting

- **Chrome asks whether the page may connect to apps on this device.** Choose **Allow**. If you chose Block, click the icon left of the address, open the site settings, and allow it.
- **Safari:** the Base44 page cannot reach the engine on your computer (Safari blocks it). In Safari the page says so, and "Your own computer" cannot be chosen there. Use Chrome or Firefox, open http://localhost:8000, or use the practice server.
- **"You are signed in, but this app is invite-only. Ask the app's admin for an invite."** You need an invitation for the hosted page. Open `http://localhost:8000` instead: it needs no sign-in.
- **"Could not download the local page."** Setup says so and goes on: the hosted page still works. Run the command again later, or install Node 22.12 or newer, which builds the page instead.
- **The first run is slow.** It downloads about 1.8 GB on a Mac: about 0.4 GB of Python packages, 0.4 GB of model weights and 0.9 GB of practice scans. Linux downloads about 3 GB more for PyTorch. Later starts download nothing.
- **"The engine stopped."** The engine stops itself when it would use too much memory (the log says `watchdog: memory … exiting`). Close other programs and run the command again. On an 8 GB PC you can raise the limit with `LUNG_MEM_LIMIT_GB=7`, at your own risk.
- **Port 8000 is in use.** The hosted page looks for the engine on port 8000 only. Stop the other program, or use the page on your own computer with `LUNG_PORT` set to another port.
- **Windows warns about a script.** Windows SmartScreen should not appear: the command runs in PowerShell and opens no downloaded file from Explorer. This is not tested on Windows yet. If you run a downloaded `install.ps1` or `Start lung tool.bat` instead and "Windows protected your PC" appears, choose More info, then Run anyway.

## Run from source

```bash
git clone https://github.com/hillel-base/baseline && cd baseline
./lung.sh setup          # macOS, Linux. Windows: .\lung.ps1 setup
```

- `setup` installs what is missing and starts the engine. Each step is skipped when it is already done. Later starts: `./lung.sh start` (`.\lung.ps1 start`).
- **Double-click to start:** `Start lung tool.command` on a Mac, `Start lung tool.bat` on Windows.
- **The page on your own computer:** with Node 22.12 or newer, `setup` builds it; without Node, it downloads the built page (`baseline-page.zip`) from this version's release. The engine serves it at `http://localhost:8000`, with no sign-in. `scripts/build-page.sh` makes that file, and a pushed tag `v<VERSION>` publishes it (`.github/workflows/release-page.yml`).
- **Settings** (environment variables):

| Variable | What it sets | Default |
|---|---|---|
| `LUNG_PORT` | the engine's port | `8000` |
| `LUNG_DATA_DIR` | the folder of practice scans | `data/rider` |
| `LUNG_BROWSE_ROOT` | the only folder tree "Open a CT folder" can browse | your home folder |
| `LUNG_NO_OPEN` | `1`: do not open the browser | |
| `LUNG_PAGE_URL` | the page to open | per system, see [Quick start](#quick-start) |
| `BASELINE_PAGE_URL` | where setup downloads the built page when Node is missing | this version's release |
| `LUNG_WIDTH` | `edge` (edge to edge) or `centre` (pixel centre to centre) | `edge` |
| `LUNG_MEM_LIMIT_GB` | the engine's memory limit | the smaller of 14 and 70% of memory |
| `BASELINE_DIR` | the folder the one-line command installs into | `~/Baseline` |

- **Where things go:** the code, the scans (`data/`), the outlines and the event log (`runs/`) and the engine's packages (`engine/.venv`) stay in the Baseline folder. The model weights go to `~/.nninteractive`. To remove Baseline, delete those two folders; uv's own files are in `~/.local/bin` and its cache (`uv cache dir`).
- **Tests:**
  - engine, fast, no model: `cd engine && uv run pytest -q -m "not model and not data"`
  - page: `cd web && npm ci && npm test`
  - browser, with the real model and the practice scans: `cd web && npm run build && npx playwright install chromium && LUNG_DATA_DIR="$PWD/../data/rider" npx playwright test --project local --project hosted`

## Credits and licences

- **Our code:** MIT, see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).
- **Outline model:** nnInteractive. Isensee F., Rokuss M., Krämer L. et al., *nnInteractive: Redefining 3D Promptable Segmentation*, 2025, arXiv:2503.08373 (DKFZ).
  - Code: Apache-2.0.
  - Weights: **CC BY-NC-SA 4.0 (non-commercial)**. They are downloaded from their publisher at install and are not part of this repository.
- **Practice scans:** from The Cancer Imaging Archive (TCIA), through NCI Imaging Data Commons. They are downloaded at install and are not part of this repository.
  - **RIDER Lung CT:** Zhao B., Schwartz L. H., Kris M. G., Riely G. J. (2015), doi:10.7937/k9/tcia.2015.u1x8a5nr. CC BY 4.0.
  - **RIDER-LungCT-Seg:** Wee L., Aerts H. J. W. L., Kalendralis P., Dekker A. (2020), doi:10.7937/tcia.2020.jit9grk8. CC BY 3.0.
- **Test data for the known limits:** LIDC-annot-NLST501. Renoust B., Baudot P. et al. (2026), doi:10.7937/Y2DX-E334. CC BY 4.0.
- **Typeface:** Atkinson Hyperlegible Next (Braille Institute of America), under the SIL Open Font License 1.1. It is bundled, so nothing is fetched.
