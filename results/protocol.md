# Evaluation protocol

Version 1.14, 2026-10-28 (first version 2026-10-24), written before any timing or scoring of the tool. After the first timed run, every change goes in [Changes](#changes) with its date and reason, and data taken before the change is kept and reported.

## What we want to know

1. **Time.** Does click to measure cut the hands-on time per scan and per nodule, including review and correction? Measured as the tool's time against the lab's reported times.
   - The lab's research director's success test, in full: "If we can show that [the lab's research fellow's] time per scan drops because he's correcting rather than doing the full tracing, we'll have a great story for our grant renewal".
   - Her trust bar: "[The research fellow] spends less time fixing its work than he does measuring from scratch".
2. **Quality.** Are the tool's outline, axes and volume as close to the expert as the expert is to himself on the repeat scan? This is the lab's bar, and its research fellow's proposed yardstick. Quality comes before speed: he accepts a tool that is "a bit slower or needs more refinement on my end" as long as it gives "a good, correctable outline", and he wants to see "those hard cases I mentioned, like spiculated margins or tumours near vessels".
3. **Follow-up matching, once built.** How often the proposed position on the second scan lands on the tumour.

Not covered: finding nodules, several nodules per scan, follow-ups weeks apart. RIDER has none of these.

## The timed task

B measures; it does not find. So every timed run starts with the tumour on screen and ends when its row is recorded. The tumour's position is given to the operator in `eval/cases.csv`: the voxel of the expert outline nearest its centre (so always inside the tumour), as the DICOM image number that the tool and most viewers show (`test_image`), as the 0-based array index that the tool's logs and outline files use (`test_slice`; on RIDER it runs the other way), and in 3D Slicer's RAS millimetres. **For each run the operator also gets a picture of the hint image with a red cross on that voxel** (`eval/click_hint.py`; the outline is not drawn), and clicks on the cross (the protocol's second amendment): the operator cannot read these scans, and finding the tumour is not what the tool does. Scan loading is timed as well, and reported in the per-scan time.

## Cases (fixed before timing)

`eval/select_cases.py` (seed 20261024) takes the 28 patients with an expert outline on both same-day scans, splits them into thirds by tumour volume on the first (test) scan, and draws from each third 3 timed patients and 1 development patient. Size is the only input, so no case is chosen for how well the tool does on it.

| Order | Size third | Patient |
|---|---|---|
| 1 | small | RIDER-2655999012 |
| 2 | medium | RIDER-2357766186 |
| 3 | large | RIDER-2151469008 |
| 4 | small | RIDER-1867199702 |
| 5 | medium | RIDER-1825099523 |
| 6 | large | RIDER-1532432635 |
| 7 | small | RIDER-1225316081 |
| 8 | medium | RIDER-3160137230 |
| 9 | large | RIDER-1346917136 |

The `manual` column in `eval/cases.csv` is from v1.5 and is no longer used.

- **Development set:** RIDER-2541949645 (small), RIDER-1286684383 (medium), RIDER-2619750334 (large). We develop, tune and demo the tool on these. The operator practises on these.
- **Held out:** the other 16 patients, from 2026-10-24 on. They are opened only in the scripted runs below.
- The nine timed patients are opened only for timed runs.

## Prior exposure (what has already touched these patients)

- **The spikes used all of them.** S1 (30 test scans), S2 and S3 (all 28 pairs) ran on every timed and held-out patient. We chose nnInteractive partly on S1's results on these same patients, so the tool's agreement with the expert here is not fully independent of that choice.
- **No tuning by us.** The engine is pretrained; nobody has fitted it to RIDER.
- **The engine's training data does not include RIDER.** The nnInteractive paper lists "RiderLung (Lung Lesions)" among its held-out test sets (Table A2), not its 120 training sets (Table A1) ([Isensee et al. 2025, arXiv 2503.08373](https://arxiv.org/abs/2503.08373), checked by us). Caveat: the training sets include NSCLC-Radiomics, outlined at Maastro, the group behind RIDER-LungCT-Seg's outlines. The engine may have learnt their outlining style, so agreement with the RIDER expert may flatter it compared with other readers. That is one reason to score against the QIBA radiologists' outlines too (§Quality).
- **The operator** has seen the spikes' summary numbers. Versions 1.0–1.3 of this protocol, which he reviewed, listed each timed tumour's expert volume. That could anchor when he accepts the tool's outline, so the volumes are now removed from the protocol and from `eval/cases.csv` (v1.4), and the exposure is reported with the results. Before the first timed run he writes down in [Changes](#changes) whether he has viewed any timed patient's scan or outline.
- **Header values read by an agent (2026-10-25).** One of our coding agents, briefed only to use "the three development scans", read DICOM header values (series number, study date, slice thickness, slice spacing) of RIDER-1129164940 (held out) and RIDER-1225316081 (timed case 7). No image was shown, nothing was outlined or measured, no development choice used them, and the values were deleted. No effect on blinding or results; our agents' briefs now name the three development patients and forbid reading any other patient's files.
- **Case 7 was a worked example.** From 2026-10-24 (commit d21f425) to 2026-10-25, one of our research notes (not in this repository), which the operator reads in order to present it, used timed case 7: its expert volume and the tool's volume error after the first click and after correction. Knowing the expected volume could steer when he accepts the tool's outline. We found and fixed it before any timing. Case 7's runs are marked as exposed, and every assisted summary is also given without them. In his note before the first timed run, the operator also says whether he remembers that example.

## The operator

The operator is one of us. **He is not a radiologist, has no clinical training and has never measured a tumour.** So:
- His tool times are an inexperienced user's times, not the lab's. He also works closely with the people who build the tool, and they are often a tool's fastest users. The robustness rule (§Timing) is there for both.
- The lab's research fellow's figures are the lab's baseline. Our tool times are set against them, labelled "against the lab's reported times", never "measured saving".
- **Blinding.** Before finishing all runs on a case, the operator does not look at its expert outline, its expert volume, its spike results or its scores. He reads his hints from `eval/cases.csv`, which holds positions only.
- **He times only what a novice can do validly**. In his words: "I found myself playing with the '-' and '+' although I don't really see the nodule with my eyes." So his corrections would measure him, as his hand outlines would have. He makes one click, a review pass and the Record; the corrections are modelled by script (§Quality, Q3c). He sees no quality score during a run. Quality is scored afterwards.
- **Practice before timing:** about 10 minutes with the tool on the development cases, so that learning the tool is not timed. Practice times are kept, marked as practice, and not reported as results.

## Baseline

### The lab's own figures (quoted, not measured by us)

The research fellow's walkthrough and weekly mix:

| Step | His words | Unit |
|---|---|---|
| Long + short axis | "about 2–4 minutes per nodule" | per nodule |
| Volume | "another 15–25 minutes outlining it on every slice" | per larger or fast-changing tumour |
| Recording | "about 3–5 minutes typing everything into my spreadsheet and saving a screenshot" | per scan |
| Re-finding on a follow-up | "roughly 10 minutes to re-find each nodule" | per nodule |
| Weekly mix | "12–15 scans", "one or two nodules", "about 30 new follow-up scans arrive each month", volume for "about one in five tumours" | |

On a one-nodule scan, these add up to 5–9 min without volume and 20–34 min with volume. That sum is our arithmetic, not his.

### Published expert times (the independent check)

The lab's figures are recalled, not timed. We collected published measurements of how long experts take to outline a lung tumour in 3D by hand and to measure its axes. They sit next to the lab's figures as a check on them, not as a second baseline. From [manual-times-references.md](manual-times-references.md) (17 primary papers, 2026-10-25):

| Step | The lab | Published |
|---|---|---|
| Outline for volume | 15–25 min | about 2–3 min (small nodules, or with a tool's help) up to about 10–22 min (subsolid; radiotherapy) |
| Long and short axis | 2–4 min | about 40 s per lesion, the closest figure (not lung nodules alone) |
| Re-find on a follow-up | about 10 min | about 1.6 min per nodule |
| Record | 3–5 min | none found |

For axes and re-finding the published times are below even the lab's halved low end (60 s and 5 min), so the robustness rule does not cover that gap. Each step's tool time is therefore shown next to both figures. The lab's figures stay the baseline (our call: no question to him about his times).

**No timed hand runs by us**: the operator has never measured a tumour, so his hand outline would measure him, not the research fellow.

## Assisted runs

- **Tool:** the tool at a recorded git commit, on this Mac's Apple graphics chip. The model is warmed up before timing; one cold start is timed separately.
- **The lab's computer has no graphics card** (the lab's research director). On this Mac's CPU a click takes minutes (S1), so we time on the graphics chip. Each run's model time (the sum of the per-click `seconds` in the event log) is reported apart from the person's time, so the run can be re-projected with the per-click time our feasibility test S7 measured on a PC without a graphics card, at the same 160³ window and with the same outlines: 17.5–19.8 s on 4 vCPU and 17 GB (a standard PC), 31–45 s on 2 vCPU and 8.5 GB. That is a projection and stays in the Projection section. If the engine itself changes for the lab's CPU before the first timed run (S7), the timed runs use the one that ships.
- **The whole tool stays fixed** from the first timed run to the last: the page as well as the engine, at one git commit, recorded with every run (`tool_sha`). The timed runs come after the UI polish, so they measure the tool as it ships. A change mid-study goes in [Changes](#changes), and the runs before and after it are reported apart.
- **Engine settings stay fixed** from the first timed assisted run to the last: the model window (160 × 160 × 160 voxels since 2026-10-25, from our feasibility test S6; it was 192; kept after S6b as an open exception to that test's own rule, see Changes, v1.6), autozoom (off since 2026-10-25), the air guard (a first click or a + correction at or below −950 HU is refused; a − correction there is allowed), and the width method (`LUNG_WIDTH=edge`, the default from the tool's slice 3; each event and row records it as `width_method`). Q3 runs at the same commit. A change mid-study goes in [Changes](#changes), and the runs before it are kept and reported apart.
- **Run:** open the scan at the hinted image; one click on the red cross of the hint picture; the wait; **one review pass**, scrolling through every slice of the outline at a steady pace (the check the research fellow always does, even with no corrections); a look at the axes on their slice; Record, copy the row into a spreadsheet, save the screenshot. No + or − clicks, no paint, no axis drag. Zoom and Start over are allowed, and both are logged.
- **His click.** Its distance from the cross (R1's centre voxel) is reported. If it lands outside R1 (a misclick), the run is flagged and the modelled corrections (Q3c) are also run from the cross. No Start over, except after a misclick, which he notes. If the outline looks wrong to him, he records it anyway and says so in the note: every run counts, with its full time.
- **Cases:** the nine timed patients, test and retest scan (18 runs). A patient's two scans go in different sittings, without looking at the first scan's numbers. So every sitting ends with the tool's "Download CSV and clear table" (logged as `clear_table`), and the next one starts with an empty table. The operator does not open the Study table, which shows volumes over time, until all runs on that patient are done.
- **Pilot, done 2026-10-25** at commit `fd87ce1`, two development cases, before the cross existed (its notes are not in this repository). It found that the operator could not find or judge the tumour, which led to the cross. Its times are not compared with the timed runs.

## Timing

- **The stopwatch:** `eval/stopwatch.py`, condition `assisted`. Its `started_at` is the first Enter (before 2026-10-25 22:10 it was the script's start; `eval/score.py` lines older rows up with the tool's Record event and reports the gap). The operator presses Enter at each phase boundary; it appends a row to `eval/runs/timing.csv`. It checks the patient ID against `eval/cases.csv`, records the setup (mouse or trackpad, software version) and the machine, and keeps aborted runs with their reason.
- **Phases:** loading (choosing the scan until it is open at the hint slice), then outline (the click, the wait and the review pass), axes (the look) and record.
- **Measured and modelled**, each with its quality:
  - **(a) Measured:** his run as timed: one click, the review pass, the axes look and the Record.
  - **(b) Modelled:** (a) plus the corrections the script (Q3c) needs to reach the steering reference's own bar, given for each arm, each costing his own placement time for that run plus the model's time. His placement time is from the scan open at the hint to the start of the outline (the `nodule_start` event less its model seconds). The model's time is as measured by the script on this Mac, or 19.8 s per click on a standard PC. Labelled "an efficient corrector steered by the expert; a real expert decides when to stop and may click more or less".
- **Outcomes, fixed now:**
  - **Per scan** (the research director's unit): loading plus all phases. RIDER has one tumour per scan.
  - **Per tumour:** all phases, without loading. It includes waiting for the model.
  - **Per step**, set against the lab's step. The tool gives axes only from its outline, so the axes step is the outline and axes phases together:

    | The lab's step, its range | The tool's time we set against it | Clear if the slowest tool time is under |
    |---|---|---|
    | Volume outline, 15–25 min per tumour | outline phase (in (b), plus the modelled corrections) | 3.75 min |
    | Long and short axis, 2–4 min per nodule | outline + axes phases | 30 s |
    | Record, 3–5 min per scan | record phase | 45 s |
    | Re-find on a follow-up, about 10 min per nodule | once F is built: from opening the follow-up to accepting the proposed position (3 development pairs, §F) | 2.5 min |

  - **Per scan, two ways:** with volume, the tool's total against the lab's 20–34 min (volume, axes and record, what the lab wants for "every tumour", its research director); without volume, the tool's total against his 5–9 min (axes and record, what he does today for 4 tumours in 5). The tool always gives a volume.
- **The robustness rule, set before any timing**: a step's saving is called **clear** only if it still holds when the lab's times are halved and the operator's doubled, that is, if the slowest tool time × 4 is under the lab's low end. It is our rule, not the lab's. It decides how strongly we state the time claim; it is not a pass or fail for the tool. A step that misses it is reported as "not clear", with its numbers. The verdict is given for (a) and for (b). The slowest time includes every timed run, also those that fail on quality. The verdict is given twice: as measured on this Mac, and re-timed for a standard PC (below, Projection). The PC verdict is a projection.
- **Re-finding is flattering on RIDER.** Its tumours are large (median long axis 38 mm) and alone, so finding them again is easier than the lab's small nodules among several. That step's time is reported with this label.
- **Speed is never shown without quality.** Each run's Dice and volume error against both references sit next to its time. An accepted outline is reported as a failure, not as time saved, when it is further from R1 than R1 is from itself on the repeat scan 9 times in 10: **more than 45.3% in volume or 9.2 mm in long axis** (R1's scan-to-repeat 90th percentile, 28 patients, `eval/yardsticks.py`). R1 is the yardstick the lab agreed, and the lab's bar is "within the range I see when I re-measure". R2 is not used for this cut: the radiologists' own outlines differ by more than 83.5% in volume and 13.5 mm in long axis in 1 pair in 10 (same scan), so a cut there would excuse almost anything. Each failure also shows its error against the radiologists, so a reader can see whether it looks like a radiologist's outline (R1 is bigger than theirs in 237 of 280 pairs). The cut is generous in one way: R1's repeat includes real scan-to-scan change, which a run on one scan does not have. The run's time still counts in the rule above. The cut is ours, from the lab's words, and applies to the time claim only. The headline quality result stays the medians against the yardsticks (§Quality).
- **Order:** a patient's two scans go in different sittings.
- **Breakdown from the tool's log** (see [Instrumentation](#instrumentation-asked-from-the-tool)): number of + and − clicks, paint strokes, refused clicks, and seconds waiting for the model.

## Quality

Computed by scripts in `eval/` from saved outlines. The same code (`eval/measure.py`) measures every outline: the tool's and the experts'. The tool's own reported numbers are checked against this recomputation, which catches measuring bugs in the tool.

**Definitions.**
- **Volume:** number of outlined voxels × voxel volume.
- **Long and short axis:** on the axial slice where the outline's area is largest, the longest distance across it, and the longest line across the outline itself at right angles to it, as a reader lays a caliper. The research fellow picks the slice where the tumour "looks largest" by eye, so his slice may differ.
- **Pixel centres or edges.** Axes measured between pixel centres read about one pixel (0.5–0.9 mm on RIDER) shorter than a caliper drawn edge to edge. Outline against outline (Q1, Q2, Q3), `eval/measure.py` measures every outline between pixel centres, so the offset cancels. From its slice 3 the tool shows and exports axes edge to edge, and each exported row names its method. Wherever a number is compared with a caliper or with the tool's row, `eval/measure.py` measures edge to edge (on the hull of the pixels' corners) when that row's method says so. Hand calipers (the lab's) are compared with our edge-to-edge values. The tool makes its edge-to-edge line by extending the centre-to-centre line by its end pixels; ours takes the longest line across the pixels' corners. The two differ only on very thin outlines. Our recomputation is a second implementation of the tool's definitions, so a difference of more than about one pixel, with the same method, is a finding.
- **Dice:** overlap of two outlines, 0 (none) to 1 (identical).

**Two references, reported side by side.** RIDER holds two sets of expert outlines of the same tumours, and they disagree in one direction:
- **R1, the RIDER-LungCT-Seg expert** (a radiation oncologist; the MANUAL outline). This is the yardstick the lab agreed.
- **R2, the five QIBA radiologists' own 3D outlines** (fractional DICOM SEG, thresholded at 0.5, as in our feasibility test S3c). Two radiologists on the same scan: median Dice 0.88, 14% in volume, 1.9 mm in long axis. R1 against one radiologist: Dice 0.77, 29%, 4.2 mm, and R1 is the bigger outline in 237 of 280 pairs (S3c as corrected on 2026-10-25). All five used the same semi-automatic tool, which makes them agree more closely than free-hand outlining would. Using R2 as a yardstick waits for the lab's agreement; reporting against it does not. **Corrected 2026-10-25** (in our feasibility test S3c): the SEG files name no source scan, and in 6 patients both scans share a grid, so S3c had put some outlines on the wrong scan. Each SEG now goes to the scan whose R1 it is nearest, one per reader per scan, and outlines of a different lesion (93–133 mm away) are dropped. In timed case 2 the radiologists measured a different lesion, so it has no R2. `eval/qiba.py` places the SEGs by the same rule in its own code, and also checks each SEG's pixel spacing and orientation against the scan. On our 27 patients with R2 it keeps the same 270 outlines as that test's fix, with identical volumes and long axes within 0.01 mm.

So "error against the expert" depends on which expert. Every Q1 and Q3 number is given against both, and neither is called the truth. Which style matches the research fellow's own outlines is a question for him.

**Q1. Agreement with each reference**, per scan, on all 18 assisted runs (R2 on 16: timed case 2 has no radiologist outline of this tumour):
- Dice; volume error in % (signed, to show bias, and absolute); long- and short-axis error in mm.
- Against R2: the tool against each of the five radiologists, next to the radiologists against each other, on the same scans. This is the like-for-like test: does the tool sit among the readers, or outside them?
- For his first-click outline as recorded (a), and for the modelled outline after the corrections (b), so we see what corrections buy.
- If the operator dragged the axis ends, the tool's reported axes are scored too, against the expert outline measured with the method the row names.

**Q2. Repeatability**, 9 patients: the tool's measurements on the test scan against the retest scan, for his first-click outlines (a) and for the modelled ones (b): |Δvolume| / mean volume in %, |Δlong axis| and |Δshort axis| in mm.

**Yardsticks.** Computed by `eval/` on the same patients, and on all 28:
- **For Q2, the agreed one:** how much R1's outline changes between the two same-day scans. Our feasibility test S3 found 17% in volume, 2.7 mm long axis, 2.2 mm short axis (median, 28 patients); `eval/yardsticks.py` gives 17.1% and 2.7 mm (90th percentile 45.3% and 9.2 mm, `eval/runs/yardsticks.csv`). Also each radiologist's own outline, scan against repeat (R2; 8 of the 9 timed patients, all but case 2).
- **For Q1:** the radiologists against each other on the same scan (R2), as above; on our 28 patients (27 with R2), `eval/yardsticks.py` gives a median of 15.0% and 2.0 mm, with a heavy tail (90th percentile 83.5% and 13.5 mm). S3c's 14% and 1.9 mm, quoted when we chose the model, is the same calculation over all 29 patients with radiologist outlines (560 pairs); ours leaves out the 2 that lack R1 on both scans (RIDER-2283289298, RIDER-8509201188), so it covers only the study's patients. R1's scan-to-repeat change is also shown, because the lab chose it, though it contains the change between two scans, which Q1 does not.

**How we compare, fixed now.** For each metric and yardstick we state two facts and nothing more:
1. the tool's median against the yardstick's median;
2. how many of the tool's cases fall above the yardstick's 90th percentile, which is where "consistently off" (the research fellow) would show.

**No pass or fail:** the lab gave the bar in words ("within the range I see when I re-measure the same nodule") but no number, and "defensible" is the research director's call.

**Q3. Simulated corrections, secondary and labelled as such.** The tool's engine is run by script with the click at the deepest point inside R1's outline and up to two corrections at the deepest point of the largest error against R1 (the S1 method), on both scans of the 25 non-development patients. It gives a larger N, and the repeatability of the tool with no person in the loop. It is not evidence of real correction time. **The corrections are steered by R1, so agreement with R1 is flattered** (this also applies to S1's numbers). The score against R2, which the corrections never saw, is the fairer one. If the tool refuses a + correction as air (a voxel at or below −950 HU inside R1, such as an air pocket in the tumour), the script uses the deepest point of the same error that is above −950 HU, and counts the refusal.

**Q3c. Corrections from his click, modelled**. For each timed run, `eval/replay.py` replays his logged first click through the engine, then adds up to 5 corrections, each at the deepest point of the largest error against the steering reference. Two arms: steered by R1, and steered by R2 (the majority of the radiologists). Every step is scored against both references. **Corrections are counted against the steering reference's own bar**, the way an expert corrects toward his own view: steered by R1, until within R1's median scan-to-repeat change (17.1% in volume and 2.7 mm in long axis); steered by R2, until within the radiologists' median spread among themselves (15.0% and 2.0 mm) (`eval/runs/yardsticks.csv`). **Quality after those corrections is also given against the other reference**, so the result does not flatter the reference that steered it. The failure line (45.3% and 9.2 mm) stays against R1. Timed case 2 has no R2, so it has the R1 arm only. "Not reached within 5" is a result. Refused + corrections are handled as in Q3. Step 0, his click alone, must reproduce his recorded outline (the engine is deterministic), which checks the replay.

**Q3b. Where the click lands, secondary.** Two parts. (1) Q3 is run again from the 4 in-plane neighbours of the deepest voxel (one pixel up, down, left, right), with the same correction rule, after 1 click and after 3. (2) **From the cross, a realistic click:** the first click only, from the cross and from 3 mm and 5 mm away from it in four in-plane directions, where that point is inside R1 and not air (`eval/replay.py --offsets`), on all 18 timed scans and on Q3's patients. With the cross, his click is the best case; the research fellow would not click the expert's exact centre. Per scan we report the spread (largest minus smallest, as a percentage of the median) of volume and long axis, and Dice against R1 and R2, **next to (a)**, also per hard tag. Why: on a development case we saw the first-click volume move from 6.6 to 5.31 mL with a one-pixel shift (expert 7.15 mL), and in the pilot the large development tumour's first-click long axis ranged from 83 to 120 mm over these offsets.

**What fails.** For each metric, the three worst cases, each with a screenshot of the slice and the likely cause.

**Hard cases, reported on their own.** Tagged per patient by `eval/hard_cases.py` from R1 on the test scan and the CT, before any scoring, never from the tool's results:
- **Irregular margin** (the lab's "spiculated margins"): solidity, the outline's voxels divided by the voxels inside its 3D convex hull, in the lowest third of the 28 patients (cut 0.754).
- **Touching** (the lab's "tumours near vessels"; also airway walls, chest wall, mediastinum): the share of the shell 1–3 mm outside the outline that is denser than −400 HU, in the highest third (cut 0.363). The −400 HU line is ours, about halfway between aerated lung and soft tissue.
- **Hard** = either tag: 15 of 28 patients, 4 of the 9 timed. Every quality and time result is also given per tag and for the rest. Q3 gives the larger N here (13 hard patients outside the development set).
- These are geometric stand-ins, from one expert's outline, for a radiologist's reading; the research fellow may judge cases differently. The per-patient tags stay out of the operator's sight (`data/eval/hard_cases.csv`) until his last timed run. A check, not a tuning: development patient RIDER-1286684383, where the tool's first click followed an airway, is tagged irregular.

**Small tumours, reported on their own.** The smallest third by expert volume (stratum S in `eval/cases.csv`: timed cases 1, 4 and 7, so 6 runs; in Q3, the small patients outside the development set) get their own line in every quality and time result. Why: the 160 window was kept although S6b's rule, set before the data, said to go back to 192, and what triggered the rule was one small tumour (see Changes, v1.6).

**Window edge.** With autozoom off, the model draws an outline only inside the 160-voxel window around each click that can grow it (the start and + clicks; − clicks only remove), and only inside the engine's working box, 120 × 180 × 180 mm centred on the first click. By R1, on 56 scans (`eval/patch_reach.py`): from the deepest voxel no outline reaches the window edge (the furthest reaches 77 voxels) and 4 come within 10 voxels (1 of them timed); from the voxel nearest the centre, 1 held-out scan touches it. No R1 outline comes near the box (at most 37.5 mm deep and 51 mm across from its centre, against 60 and 90). But the tool's outline can be bigger than R1's, and a click is not always central. So the scoring (`eval/score.py`) flags an outline that touches the edge of the region the model could draw in, for the first-click outline and for the accepted one, and each flagged case is shown under What fails. The tool also warns the user (`at_window_edge`). We report how often it fired, but our own check is the one we score with. In the pilot, both agreed: the large tumour's first outline touched the window edge, and the operator's − click removed that part.

## Follow-up matching (F), once built

- **Hit or miss is scripted only, all 28 pairs** (the timed patients only after the timed runs): click on the test scan at the expert-outline voxel nearest its centre (S2's method). Is the proposed position on the retest scan inside the expert outline, and how far is it from the outline's centre?
- **A hit, the lab's bar:** the proposed position is within 10 mm of the expert outline's centre, and nearer to it than to any other nodule, as in our feasibility test S5 (the "nearer" part is our reading). The research fellow: "a mark within 1 cm is usually enough to draw my eye to the right area, as long as it's clear which nodule it's pointing to". RIDER has one tumour per scan, so "clear which nodule" is not tested here. On a large tumour a mark can miss the 10 mm and still sit inside it; the "inside" count shows those.
- **Timed by the operator, as a lower bound** (decided 2026-10-26; the operator: "i for sure cant tell whether what F found is the tumour or not"):
  - **Cases:** the 3 development pairs, on a fixed checkout of the first version with F (its commit recorded). One untimed try first, on the first pair.
  - **Before each run, not timed:** the tumour is recorded on the test scan from its cross picture.
  - **Timed from the tool's log, no stopwatch:** from the follow-up scan's `open_scan` event to `followup_confirm` (Measure here at the proposal), less that start's model seconds. Find and its wait (`map`, with its seconds) fall inside. If F finds nothing ("Find it by hand") or he does not accept, the run is reported as such, with its time to that point; he does not search by hand.
  - **No judgement:** he accepts what F shows, as in the timed runs. Whether F found the tumour comes from the scripted count above, never from him.
  - **Reported** with N = 3 and every time, against the lab's "roughly 10 minutes" and the published 1.6 min, with the robustness rule (2.5 min, §Timing). With N = 3 the verdict is weak, and it is labelled so.
  - **Labels:** "flattering on RIDER" (large tumours, one per scan; the development patients were also his practice cases) and "a lower bound: the research fellow also checks that the mark points to the right nodule, which is not timed".

## The Record step with the study record, a labelled extra measure

- **Question:** how much of the record step does saving to Base44 remove? In the timed runs the step is Record, Copy row, paste into a spreadsheet, Save screenshot ("with the paste"). With the study record it is Record and Save screenshot, with the row saved by the tool ("with the record").
- **When and where:** after sitting 2 and before inviting other users, on a fixed, clean checkout of the first version with the study record (its commit recorded). The hosted page with the local engine (development patients only).
- **Cases:** the 6 development scans, one record each. The development cases were his practice cases, which favours this measure; it is labelled so.
- **Timed:** the same stopwatch and phases as the timed runs, with setup "study record". Only the record phase is reported: from the end of the axes look to the row shown as saved and the screenshot taken. He makes no judgement, as in the timed runs.
- **Reported:** the record phase with N, median and range for both ways, next to the lab's 3–5 min per scan and the robustness rule (45 s, §Timing). The two come from different cases (timed against development) and a later sitting, so the difference is an estimate, not a paired result.
- **The rows:** practice rows on Base44. They are on our list of test rows, which we delete before inviting other users.

## Setup tests

**Question:** how long does a first install take, from nothing to one live click, and what goes wrong? The run instructions are a deliverable, so we measure them instead of estimating.

**Both tests:**
- Follow only the README's run instructions, typing the commands as written, with the default 10 patients.
- **Phase times** come from the setup script's own log: prerequisites, Python and engine, model weights, practice scans, engine start with model load, page open.
- **One live click:** the first click after the engine starts, so a cold one, on RIDER-2619750334 (development set, the large tumour, easy to spot without training), test scan, at the hint slice in `eval/cases.csv`. Its seconds come from the engine's event log.
- **Every problem is written down** in a copy of the setup checklist: what happened, the message shown, what fixed it, minutes lost, and whether it needed help.
- **The machine is described:** model, chip, memory, macOS, free disk before and after, what was already installed (Homebrew, Xcode Command Line Tools, Python, uv), and download speed (bytes over seconds, from the setup log).
- **Results:** total time to the first live click, time per phase, and the problem list. Every attempt is reported, including failed ones. Filled checklists and setup logs go in `eval/runs/setup/`.

**Test A: a new, empty macOS user account on this Mac.**
- We create the account and run the test.
- It can be repeated after we fix a problem. Each attempt is numbered and reported.
- **Limit:** Homebrew, the Xcode Command Line Tools and the network are shared with the main account, so first-install problems with those do not show up. Test B covers them.

**Test B: a friend installs it on his own Mac, unaided.**
- He gets the repository link and the README, nothing else.
- **Unaided:** nobody helps during the first 15 minutes of any blocker. After that he may ask; the help and its minutes are recorded as a problem.
- He sends back the filled checklist and the setup log. We record his background in one line (for example "software developer, no imaging experience"), not his name, because a developer installs more easily than the research fellow would.
- It is one attempt, not repeated.

**Not covered:** the lab's own computer: a standard computer without a graphics card (the research director, 2026-10-25), make and system unknown.

## Practice server, once live

- **Question:** do the practice servers (a T4 graphics card) give the same outlines as this Mac for the same clicks? Every quality number here is measured on the Mac.
- **Method:** `eval/server_check.py`, on the 6 development scans only. The clicks of Q3 and Q3b (the deepest point with up to 5 corrections steered by R1; 1 pixel off it; the cross and 3 and 5 mm off it), about 113 outlines, go to the Mac and then, unchanged, twice to the server, both at the server's tagged commit. The second server run separates the device from run-to-run noise.
- **The rule, fixed before the data:** the same tool if every outline has Dice ≥ 0.99 against the Mac's and a volume within 1%, which is under a tenth of R1's median repeat change (17.1%). Otherwise the results report the largest differences, with the worst outline pictured, and say that the measured quality is the Mac's. The server's seconds per click are reported too.

## Reporting

- **Every number** states N, the median, the range (and the interquartile range when N ≥ 10) and the conditions.
- **Timing** is a per-run table (18 runs), so every value is visible: each step's time next to the lab's range, and per step the rule's verdict ("clear" or "not clear") with its numbers. The published expert times sit next to the lab's. Every time comparison is labelled "against the lab's reported times". No p-values.
- **Measured and projected stay apart.** `results.md` has a Measured section and a separate Projection section.
- **Projection** (`eval/project.py`, to be written):
  - **Method:** the lab's weekly mix, with each step's reported time replaced by the tool's time for that step (median, and slowest), against his reported week. The main figure uses (b), measured plus modelled corrections; (a) is shown as the floor. Labelled "against the lab's reported times".
  - **Two scenarios:** volume on 1 tumour in 5 (today), and volume on every tumour (what the lab wants).
  - **The lab's CPU:** each run re-timed as its measured time, minus the model seconds in its event log, plus its model runs × S7's per-click time on a PC: 19.8 s for a standard PC (4 vCPU; the slower of S7's two runners) and 44.6 s for a small one (2 vCPU). The person waits during each click, so the wait adds one for one. The rule's verdict per step is given for this Mac and for the standard PC.
  - **Compared with** our target: 1–3 min to check and correct a nodule; about 45% of weekly hands-on time saved.
- **Traceability.** Every number comes from a script in `eval/` and a data file named in the results.

## Instrumentation asked from the tool

The evaluation does not touch product code. It asks for:

1. **An event log per run** (JSON lines): time, patient, scan, event (scan loaded, + or − click with its position, model finished with its seconds, paint or erase stroke, axis drag, accept, export), and the tool's git commit.
2. **Saved outlines** after the first click and at accept, on the CT grid with the scan's geometry (NIfTI or `.seg.nrrd`), named by patient and scan.
3. **The exported row** holds long axis, short axis, volume and the axis end points.
4. **No view of the expert outline** during study runs, if the app has a debug overlay.
5. **A documented engine call** (load a scan, send clicks, get the outline) so Q3 and F can run by script.
6. **Refused clicks in the event log** (on air, outside the scan), with their position, so each one counts as a click. Asked 2026-10-25; the answer: action `click_refused` with z,y,x, positive and a reason (air, outside_volume, outside_box, no_nodule), from its slice 3.
7. **No earlier numbers in a retest sitting.** Asked 2026-10-25; the answer (slice 4): one button, "Download CSV and clear table", which always downloads every row before it clears, logged as `clear_table` with `rows`. Nodule numbers keep counting after a clear. `copy_row`, `delete_row` and `screenshot` events carry `file`, the row's outline file, so scoring can join them to its `record` event.

The format is the tool's choice; the evaluation reads whatever it documents. Its answer (the engine's API notes): `runs/events.jsonl`, and `runs/outlines/<scan>_n<k>_first.nii.gz` and `_accepted.nii.gz` on the full CT grid. Nodule numbers restart with each engine start, so scoring reads each file's path from its event (`outline_file`, relative to the runs folder) rather than building it.

## Files and setup

- `eval/cases.csv` and `eval/runs/timing.csv` are committed. Scored tables go in `eval/runs/` and are committed.
- Outlines and tool logs go in `data/eval/` (git-ignored, with the RIDER data).
- Setup: `pip install -r eval/requirements.txt`. Run scripts with `python -I`. The RIDER data path is the first argument.

## The operator's time

| Part | Estimate |
|---|---|
| Tool practice on the development cases | about 10 min |
| Tool runs: 18 plus a 2-run pilot (one click, a review pass, Record) | about 45 min |

## Known limits, stated before measuring

- The operator is not a radiologist. His times are his, not the lab's, and he makes no corrections: those are modelled by an efficient corrector steered by the expert, which knows where the error is and when to stop. A real expert decides both, and may click more or less.
- The review pass is a mechanical lower bound on the lab's check: it times looking through every slice, not judging it. The ×2 in the robustness rule covers some of that.
- N is small: 9 patients (18 runs) for time and quality. Expect wide spread.
- The "before" numbers are the lab's recollection, not a stopwatch. They are checked against published expert times, not against our own hand runs. The operator's times are an inexperienced user's, and he works closely with the people who build the tool.
- RIDER tumours are larger than typical nodules (median 9.9 mL, long axis 38 mm) and there is one per scan. A third of the timed set is small.
- "Expert" means one radiation oncologist's outline. It is a reference, not the truth; his own outline changes 17% in volume between the same-day scans.
- The spikes and the engine choice already used these patients (see [Prior exposure](#prior-exposure-what-has-already-touched-these-patients)).
- Same-day pairs: no growth, no weeks-apart changes.
- One Mac with an Apple graphics chip. The lab's computer has no graphics card (the research director, 2026-10-25), so our model waits are shorter than the lab's would be (S7: about 18–20 s per click on a standard PC, against about 1.2 s here); the CPU projection covers that.
- Repeatability with a person in the loop includes his memory of the first scan.

## Changes

- **v1.1, 2026-10-24, before any timing.** After a fresh-eyes review of v1:
  - a per-scan outcome (the research director's unit), and a second paired comparison without volume (the lab's 4 in 5);
  - each run's quality shown next to its time, with one acceptance rule for both conditions;
  - manual paired only with assisted test runs, and the manual cut fixed at orders 1–4;
  - 3 more assisted-only patients (orders 7–9), drawn with the same seed, so orders 1–6 did not change;
  - the yardstick comparison fixed as two stated facts;
  - the projection uses our time ratio, not our absolute times, in two scenarios;
  - timed F dropped as an unfair comparison;
  - a prior-exposure section;
  - stopwatch: aborted runs kept, patient IDs checked, setup recorded;
  - two manual practice runs.
- **v1.2, 2026-10-24, before any timing.** Added §Setup tests and `setup-checklist.md`.
- **v1.3, 2026-10-24, before any timing.** We found the five QIBA radiologists' 3D outlines in RIDER, and found the RIDER expert outlines bigger than them in 239 of 280 pairs. Q1 and Q3 are now scored against both references (R1, R2), with radiologist-against-radiologist as the like-for-like Q1 yardstick. Q3's steering by R1 is stated.
- **v1.4, 2026-10-24, before any timing.** Expert volumes removed from the case table and from `eval/cases.csv`, because the operator reads his hints there (a blinding leak found before the first run; see §Prior exposure). Same cases and hints, plus each hint's DICOM image number, because the tool's slice counter runs opposite to it on RIDER (found while building the tool). Added `manual-run-sheet.md` (removed in v1.6).
- **v1.5, 2026-10-25, before any timing.** After the tool turned autozoom off and added the air guard: engine settings fixed through the timed runs; Q3b (one-pixel click shifts), from our finding on a development case; the window-edge flag (80 voxels from the click, after the tool adopted S6's 160 × 160 × 160 window), with R1's reach measured by `eval/patch_reach.py`; refused clicks logged (instrumentation 6). The paint, erase and axis-drag slice is now the tool's slice 5. The short axis is now the longest chord at right angles to the long axis, as a reader draws it and as the tool defines it (it was the outline's width at right angles, which is longer on slanted shapes). S3's quoted short-axis yardstick used the old width; `eval/` recomputes all yardsticks. The research fellow said he outlines every slice, freehand, with no filling: the manual run uses Draw only, no Paint. He also said an F hit is within 10 mm. Timed case 7 was exposed through a research page (see §Prior exposure); its runs stay, marked, with summaries also given without them. The tool's exported axes are edge to edge from its slice 3, so comparisons with its rows use the row's method; outline-to-outline scoring stays between pixel centres.
- **v1.6, 2026-10-25, before any timing.** After the lab's 18:46 answers: hard cases tagged by a fixed rule before scoring (`eval/hard_cases.py`) and reported on their own; the lab's computer has no graphics card, so model time is reported apart and re-projected for a CPU; the lab's "good, correctable outline" trade-off added to What we want to know. R2 corrected after our S3c placement fix: new reference numbers; timed case 2 has no R2, and case 4 now has R2 on both scans. The air guard now also refuses + corrections (the tool's slice 3); Q3 steps around a refused one. S7's PC times (17.5–19.8 s per click on 4 vCPU, 31–45 s on 2 vCPU, same outlines) set the CPU re-projection, and the rule's verdict is given for both machines. **Decided 2026-10-25: no timed hand runs.** This reverses v1.1's paired design (the same person, by hand in 3D Slicer and with the tool, on 4 tumours, with the ratio applied to the lab's times) and its rule that our times and the lab's never meet in one comparison. Reason: the operator has never measured a tumour, so his hand outline would measure him, not the research fellow, and it would cost him 2–3 hours. Now the tool's time is set against the lab's reported step times, labelled as such, checked against published expert times, with a robustness rule per step (slowest tool time × 4 under the lab's low end). The axes step counts the tool's outline too, because its axes come from its outline. Re-finding is timed once F is built, labelled as flattering on RIDER. Q4 (our hand outlines) is dropped. `manual-run-sheet.md` and `eval/runs/manual_rows.csv` are removed; the stopwatch's manual condition is unused. Tool practice is about 10 minutes. **An open exception: the 160 window stays although S6b's rule says to go back to 192** (our decision). The rule, set before the data: go back to 192 if (a) the median Dice after 3 clicks drops by more than 0.02, (b) clearly more scans get worse than better (p < 0.05), or (c) after any click an outline over twice the reference appears at 160 on a scan where 192 has none. What triggered it: (c) only, on one held-out small tumour. Both windows overshoot it equally after click 1; at 160 it passes twice the radiologists' volume after click 2, at 192 after click 3. The rule's code compared click by click. (a) and (b) were not triggered, and every significant difference favoured 160. Why we deviate: (c) was meant to catch a failure that 160 causes and 192 does not, and here both fail on the same tumour one click apart. Going back would break the standard-PC mode (192 measured at 33.5 s per click against 19.8 s), the lab's stated priority. The rule is not rewritten. Small tumours are reported as their own group, and the settings are fixed at 160 from the first timed run.
- **v1.7, 2026-10-25, before any timing.** R2 is now placed by eval's own code (`eval/qiba.py`), not read from the feasibility test's table; it agrees with that test's fix outline by outline, so the R2 numbers above are unchanged. `eval/yardsticks.py` uses it. The published expert times are now in §Baseline, and every step's tool time is shown next to the lab's figure and the published one.
- **v1.8, 2026-10-25, before any timing.** Blinding for the retest sitting (instrumentation 7): each sitting ends with "Download CSV and clear table", and the Study table (the tool's slice 8 view of volumes over time) stays closed until all runs on that patient are done. The whole tool, page included, is fixed at one commit from the first timed run, which comes after the UI polish; the pilot is a dry run of the protocol.
- **v1.9, 2026-10-25, before any timing.** The short axis is now measured across the outline itself, not across its convex hull: the hull filled in the dents of a concave outline and read 0.9 mm long against the tool on a development outline. With the change, our recomputation and the tool agree within 0.05 mm on it (`eval/measure.py` self-checks: a slanted parallelogram, a ring with a gap, an L shape). No scored number used the old short axis. `eval/score.py` scores tool runs; `run-sheet.md` (not in this repository) is the operator's sheet for the pilot and the timed runs. **An amendment: a novice's corrections measure the novice too.** From his practice: "I found myself playing with the '-' and '+' although I don't really see the nodule with my eyes." So he now times one click, a review pass through every slice, a look at the axes and the Record, with no + or − clicks, no paint and no axis drag. The corrections are modelled by script from his own logged first click (Q3c), cross-steered by R1 and R2, up to 5. Each costs his own placement time for that run plus the model's time. Results are given as (a) measured, (b) modelled and (c) the verdict for both, on the Mac and on a standard PC. The lab's bar is named: R1's median repeat, 17.1% and 2.7 mm. The pilot is now a dry run of this procedure. His run time drops to about 45 minutes.
- **v1.10, 2026-10-25, before any timed run.** Q3c counts corrections against the steering reference's own bar (R1-steered: 17.1% and 2.7 mm; R2-steered: 15.0% and 2.0 mm) and gives quality against the other reference too; the failure line stays against R1. Found on a development-case test of `eval/replay.py`: counting the R2-steered arm against R1's bar measured how far apart the two references are, not the tool (R1 7.1 mL against the radiologists' 0.8–3.1 mL on RIDER-1286684383). The same test showed the replayed click reproduces the recorded outline exactly (Dice 1.000).
- **v1.11, 2026-10-25, before any timed run, after the pilot.** The operator clicks on a red cross at R1's centre voxel in a picture of the hint image (`eval/click_hint.py`; the second amendment): in the pilot he could not find or judge the tumour ("I can't read these scans"), which put his reading of the scan into the measurement. Q3b adds first-click starts 3 and 5 mm from the cross, reported next to (a), because the cross is the best case. The window-edge check now covers the start and + clicks' windows and the engine's working box, for the first and the accepted outline (the pilot showed the old check missed the box and counted − clicks). The stopwatch's `started_at` is now the first Enter; older rows are lined up by the Record event. A header read of two non-development patients by one of our coding agents is recorded under Prior exposure.
- **v1.12, 2026-10-26, before any timed run.** Re-finding is timed after all, by the operator on 3 development pairs, as a lower bound with no judgement (our decision). The timing table already had the re-find row, while §F said "Not timed"; they now agree. Whether F found the tumour stays scripted only. The practice-server check is added, with its rule fixed before the data. The Record step on the version with the study record is added as a labelled extra measure, agreed on 2026-10-26.
- **2026-10-27, before the first timed run: the operator's prior exposure.** Asked whether he has ever opened the scan, cross picture or outline of any of the 9 timed patients, he answered: "no i didnt" (§Prior exposure).
- **v1.13, 2026-10-27, after both timed sittings, before quality scoring unless stated.** What happened in the runs and how it is handled. (1) Sitting 1, runs 2–9: Save screenshot was skipped; by our rule, set after sitting 1, before sitting 2 and before any scoring, each gets the larger of 1 s and sitting 2's median Copy row → Save screenshot time (5.9 s) and counts as complete (`eval/score.py`). (2) Sitting 1, run 6 (RIDER-1532432635 test): against "No + or − clicks", a + click after a first click off the cross, then Undo and Start over and a new first click on the cross; the run is kept with all its seconds and flagged; its accepted outline and the click Q3c replays are from the second first click. (3) Two runs (sitting 1 run 4, sitting 2 run 2) have the stopwatch's "outline" Enter before the click, so their phase split is unreliable; kept and flagged, totals stand, per-step numbers given with and without them. (4) Disclosed late: Q3 ran on 2026-10-26 with up to 5 corrections (`eval/q3.py`, the same cap as Q3c), not the "up to two" of §Q3; the after-3-clicks column is that original result. (5) Q2 for (b) is not computed: the modelled corrections steer each scan toward that scan's own expert outline, so their repeat change would measure the expert's, not the tool's. (6) The setup tests (§Setup tests) have not been run; results.md says so. (7) §Timing's (b) is "given for each arm": both arms are now timed (`eval/project.py <scores> <replay> <out> timed R2` → `eval/runs/projection_r2.csv`, 16 runs); the first draft of the results timed only the R1 arm. (8) Exposure, after the timed runs (2026-10-27 evening): a reviewer's dry run of the practice-server upload script listed one held-out patient (RIDER-1129164940) and one timed patient (RIDER-1225316081); it counted and sized their CT files only, read no header, pixel or outline, and uploaded nothing. No result here uses anything it saw.
- **v1.14, 2026-10-28, before the two extra measures.** The Record step with the study record is measured on the live v0.1.1 page (commit `8f6e4ca`, with a clean engine checkout at the same commit; smoke check 6.9 mL, 22.1 × 12.4 mm), not on "the first version with the study record" (`4de2176`): we deployed v0.1.1 before the measure. It is the version the lab uses. The re-find measure stays on the first version with F (`8e86cf6`).
