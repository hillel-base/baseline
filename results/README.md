# Results

How much hands-on time Baseline saves when measuring a lung tumour on CT, and how close its outlines come to the experts'. Research use only: the tool is a research aid, and nothing here is a clinical claim.

**Two labels to read first:**

- **Time saved is measured against the lab's reported manual times, not against a timed manual run of ours.** Every time is set against the times the lab reported for measuring by hand (20–34 min per scan with a volume, 5–9 min without one), not a stopwatch on its research fellow. We did no timed hand runs: the operator has never measured a tumour, so his hand outline would measure him (protocol, §Baseline).
- **The corrections are modelled, so the main figure (b) is a lower bound on the tool's time.** The operator made one click per scan and no corrections. A script then modelled up to 5 corrections toward the expert's outline, each costing his own placement time plus the model's time. The corrector is an oracle: it knows where the error is, each correction costs only a click on a point shown on screen, and nothing is reviewed after it. So (b) is a lower bound on time and, scored against the reference it steers toward, flatters quality. A real reader clicks more or less. The one-click floor (a) is measured only, and is not a saving on its own.

## The files

| File | What it is |
|---|---|
| [results.md](results.md) | The results: time, quality, what works, what fails, the limits, and how to reproduce each number |
| [headline.md](headline.md) | The headline numbers, each with the run table it comes from |
| [protocol.md](protocol.md) | The protocol, written before any timing, with every later change and its reason |
| [manual-times-references.md](manual-times-references.md) | The 17 published studies behind the "published" column of the manual-time baseline, with their DOIs |
| `img/` | The five pictures that results.md shows |
| `eval/*.py` | The scripts that produced every number: scoring, the modelled corrections, the projection, the summaries |
| `eval/requirements.txt` | The scripts' Python packages |
| `eval/cases.csv` | The cases: each patient's role (timed, development, held out), size third and the tumour's position |
| `eval/runs/` | The run tables (CSV) that results.md and headline.md cite |

"S1" to "S9" name our earlier feasibility tests; their notes are not in this repository.

## The data

Every scan is public RIDER data from The Cancer Imaging Archive (TCIA), under CC BY 4.0. The expert outline (R1) is from RIDER-LungCT-Seg (CC BY 3.0). The full credits are in the repository's [NOTICE](../NOTICE). The run tables hold patient IDs, positions, times and scores, and no images.

## Rerun a script

From `results/eval/`, these steps rerun from the run tables alone, with Python 3.11 and its standard library only. Each one gives its table again, byte for byte:

```bash
cd results/eval
python3 -I project.py runs/scores.csv runs/replay.csv out.csv                 # = runs/projection.csv
python3 -I project.py runs/scores.csv runs/replay.csv out.csv timed R2        # = runs/projection_r2.csv
python3 -I project.py runs/scores.csv runs/replay.csv out.csv timed R1 lab    # = runs/projection_lab_bar.csv
python3 -I q3c_summary.py runs/replay.csv out.csv                            # = runs/q3c_summary.csv
python3 -I q2.py runs/scores.csv out.csv                                     # = runs/q2.csv
python3 -I run_table.py runs/scores.csv                                      # the per-run table in results.md
```

The other scripts read the RIDER scans, and some also the tool's own log and outlines from the timed runs, which are not in this repository. Each script's first lines give its arguments. Install their packages from their own requirements file:

```bash
cd results
python3 -m venv .venv && .venv/bin/pip install -r eval/requirements.txt
.venv/bin/python -I eval/<script>.py <its arguments>
```
