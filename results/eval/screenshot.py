"""One scan's slice with the expert outline (R1) drawn on it: for the lab's hard-case examples and the results' failure
examples. The slice is where R1 is largest, in the tool's lung window (width 1500 HU, level -600), cropped around it.
Development patients only until the timed runs are over (protocol §Cases).
Usage: python -I eval/screenshot.py <data/rider> <patient> <test|retest> <out.png> ["caption"]"""
import os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np, pydicom, SimpleITK as sitk
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rider import load_ct, load_seg, manual_mask

root, patient, scan, out = sys.argv[1:5]
caption = sys.argv[5] if len(sys.argv) > 5 else ""
d = os.path.join(root, patient, f"ct_{scan}")
ct = load_ct(d); m = manual_mask(load_seg(os.path.join(root, patient, f"lungctseg_{scan}"), ct))
sx, sy = ct.GetSpacing()[:2]
z = int(np.argmax(m.reshape(m.shape[0], -1).sum(1)))
image = int(pydicom.dcmread(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(d)[z], stop_before_pixels=True).InstanceNumber)
hu = sitk.GetArrayFromImage(ct)[z]
ys, xs = np.nonzero(m[z])
pad_y, pad_x = int(25 / sy), int(25 / sx)  # 25 mm of context around the outline
y0, y1 = max(0, ys.min() - pad_y), min(hu.shape[0], ys.max() + pad_y + 1)
x0, x1 = max(0, xs.min() - pad_x), min(hu.shape[1], xs.max() + pad_x + 1)
ext = (0, (x1 - x0) * sx, (y1 - y0) * sy, 0)  # in mm, so the picture keeps true proportions

fig, ax = plt.subplots(figsize=(5, 5 * (y1 - y0) * sy / ((x1 - x0) * sx) + 0.6), dpi=150)
ax.imshow(hu[y0:y1, x0:x1], cmap="gray", vmin=-1350, vmax=150, extent=ext)
ax.contour(np.linspace(0, ext[1], x1 - x0), np.linspace(0, ext[2], y1 - y0), m[z, y0:y1, x0:x1], levels=[0.5], colors="yellow", linewidths=1.2)
edge = [pe.withStroke(linewidth=4, foreground="black")]  # readable on bright tissue too
ax.plot([5, 15], [ext[2] - 5] * 2, color="white", lw=2.5, path_effects=edge)
ax.text(10, ext[2] - 7, "10 mm", color="white", ha="center", fontsize=8, path_effects=edge)
ax.set_axis_off()
ax.set_title(f"{patient} {scan}, Image {image}. Yellow: expert outline (RIDER-LungCT-Seg)\n{caption}", fontsize=7, loc="left")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
fig.savefig(out, bbox_inches="tight"); print(out)
