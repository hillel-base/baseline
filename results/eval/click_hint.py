"""Click hints (protocol §The timed task, its second amendment): for each case and scan, the hint image as the tool shows
it (lung window, whole slice), with a cross on the voxel of the expert outline (R1) nearest its centre, the same voxel as
eval/cases.csv. No outline is drawn. The operator clicks on the cross, so his own reading of the scan is not measured.
Usage: python -I eval/click_hint.py <data/rider> data/eval/hints [roles, default timed,dev]"""
import csv, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np, SimpleITK as sitk
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from rider import load_ct, load_seg, manual_mask, centroid_phys

root, out = sys.argv[1:3]
roles = (sys.argv[3] if len(sys.argv) > 3 else "timed,dev").split(",")
os.makedirs(out, exist_ok=True)
for r in csv.DictReader(open(os.path.join(here, "cases.csv"))):
    if r["role"] not in roles: continue
    for s in ("test", "retest"):
        ct = load_ct(os.path.join(root, r["patient"], f"ct_{s}")); m = manual_mask(load_seg(os.path.join(root, r["patient"], f"lungctseg_{s}"), ct))
        x, y, z = ct.TransformPhysicalPointToIndex(centroid_phys(m, ct))
        assert z == int(r[f"{s}_slice"]) and m[z, y, x], (r["patient"], s)  # the cross is on the hint image and inside the tumour
        fig, ax = plt.subplots(figsize=(7, 7.4), dpi=110)
        ax.imshow(sitk.GetArrayFromImage(ct)[z], cmap="gray", vmin=-1350, vmax=150)
        for c, w in (("black", 5), ("red", 2)):  # a cross with a gap in the middle, so the click point stays visible
            for dx, dy in ((1, 0), (0, 1)):
                for sgn in (-1, 1):
                    ax.plot([x + sgn * dx * 4, x + sgn * dx * 16], [y + sgn * dy * 4, y + sgn * dy * 16], color=c, lw=w, solid_capstyle="round")
        ax.set_axis_off()
        ax.set_title(f"{r['patient']}_{s}, Image {r[f'{s}_image']}: click on the centre of the red cross", fontsize=11)
        f = os.path.join(out, f"{r['patient']}_{s}.png"); fig.savefig(f, bbox_inches="tight"); plt.close(fig)
        print(f, flush=True)
