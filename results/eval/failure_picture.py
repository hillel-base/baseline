"""One timed run's accepted outline against the expert's (R1), on the slice where the two differ most, for results.md
§What fails. Lung window (width 1500 HU, level -600), cropped around both outlines, a 10 mm scale bar.
Yellow: the expert outline (RIDER-LungCT-Seg). Cyan: the tool's accepted outline from the operator's run.
Usage: python -I eval/failure_picture.py <data/rider> <tool runs dir> <scores.csv> <patient> <test|retest> <out.png>"""
import csv, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np, pydicom, SimpleITK as sitk
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask

root, runs, scores, patient, scan, out = sys.argv[1:7]
run = next(r for r in csv.DictReader(open(scores)) if r["patient"] == patient and r["scan"] == scan)
d = os.path.join(root, patient, f"ct_{scan}")
ct = load_ct(d); r1 = manual_mask(load_seg(os.path.join(root, patient, f"lungctseg_{scan}"), ct)).astype(bool)
tool = sitk.GetArrayFromImage(sitk.ReadImage(os.path.join(runs, run["outline_file"]))) > 0
assert tool.shape == r1.shape
z = int(np.argmax((r1 ^ tool).reshape(r1.shape[0], -1).sum(1)))  # the slice with the largest disagreement
image = int(pydicom.dcmread(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(d)[z], stop_before_pixels=True).InstanceNumber)
sx, sy = ct.GetSpacing()[:2]; hu = sitk.GetArrayFromImage(ct)[z]
ys, xs = np.nonzero(r1[z] | tool[z]); pad_y, pad_x = int(20 / sy), int(20 / sx)
y0, y1 = max(0, ys.min() - pad_y), min(hu.shape[0], ys.max() + pad_y + 1)
x0, x1 = max(0, xs.min() - pad_x), min(hu.shape[1], xs.max() + pad_x + 1)
ext = (0, (x1 - x0) * sx, (y1 - y0) * sy, 0)
gx, gy = np.linspace(0, ext[1], x1 - x0), np.linspace(0, ext[2], y1 - y0)
fig, ax = plt.subplots(figsize=(5, 5 * (y1 - y0) * sy / ((x1 - x0) * sx) + 0.7), dpi=150)
ax.imshow(hu[y0:y1, x0:x1], cmap="gray", vmin=-1350, vmax=150, extent=ext)
for m, colour in ((r1, "yellow"), (tool, "cyan")):
    if m[z].any(): ax.contour(gx, gy, m[z, y0:y1, x0:x1], levels=[0.5], colors=colour, linewidths=1.2)
edge = [pe.withStroke(linewidth=4, foreground="black")]
ax.plot([5, 15], [ext[2] - 5] * 2, color="white", lw=2.5, path_effects=edge)
ax.text(10, ext[2] - 7, "10 mm", color="white", ha="center", fontsize=8, path_effects=edge)
ax.set_axis_off()
ax.set_title(f"{patient} {scan}, Image {image}. Yellow: expert (R1). Cyan: the tool, one click on the cross.\n"
             f"Volume {float(run['r1_vol_err_pct']):+.0f}% against the expert, long axis {float(run['r1_long_err']):+.1f} mm, Dice {float(run['r1_dice']):.2f}",
             fontsize=7, loc="left")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
fig.savefig(out, bbox_inches="tight"); print(out)
