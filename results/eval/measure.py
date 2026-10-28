# Copied from our feasibility tests' shared code (2026-10-24, commit 425bd67): eval recomputes every measurement itself, independent of the tool.
"""Long axis, short axis (on the axial slice where the outline is largest) and volume of a 3D mask.
Long axis = the longest distance across the outline. Short axis = the longest line across the outline itself at right
angles to it, as a reader lays a caliper (and as the tool defines it; this is our own code, so the tool's numbers get a
second implementation). Changed 2026-10-25: first from the hull's width, then from a chord of the convex hull, which
fills in the dents of a concave outline and read 0.9 mm long on one.
Axes run between pixel centres (outline against outline: the offset cancels) or, with edges=True, between the pixels'
corners, edge to edge like a caliper and like the tool's exported rows from its slice 3."""
import numpy as np
from scipy.spatial import ConvexHull

def volume_ml(mask, spacing_xyz):
    return float(mask.sum()) * float(np.prod(spacing_xyz)) / 1000.0

def axes_mm(mask, spacing_xyz, edges=False):
    """mask is z,y,x. Returns (long_mm, short_mm, slice_index)."""
    z = int(np.argmax(mask.reshape(mask.shape[0], -1).sum(1)))
    yx = np.argwhere(mask[z])
    pts = np.c_[yx[:, 1] * spacing_xyz[0], yx[:, 0] * spacing_xyz[1]]
    if edges:
        pts = (pts[:, None] + np.array([[-1, -1], [-1, 1], [1, -1], [1, 1]]) * np.array(spacing_xyz[:2]) / 2).reshape(-1, 2)
    if len(pts) < 3 or np.linalg.matrix_rank(pts - pts[0]) < 2:  # a dot or a straight run of pixels has no hull
        return (float(np.linalg.norm(np.ptp(pts, 0))) if len(pts) else 0.0), 0.0, z
    hp = pts[ConvexHull(pts).vertices]
    d = np.linalg.norm(hp[:, None] - hp[None], axis=2)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    u = (hp[j] - hp[i]) / d[i, j]
    return float(d[i, j]), chord_mm(pts, u, min(spacing_xyz[:2])), z

def chord_mm(pts, u, w):
    """Longest extent of the points at right angles to u within a slab w mm wide across u: the longest caliper line
    across the outline itself. Half-width bins, read in neighbouring pairs, make the slab."""
    t, s = pts @ u, pts @ np.array([-u[1], u[0]])
    k = np.floor((t - t.min()) / (w / 2)).astype(int)
    hi, lo = np.full(k.max() + 2, -np.inf), np.full(k.max() + 2, np.inf)
    np.maximum.at(hi, k, s); np.minimum.at(lo, k, s)
    ext = np.maximum(hi[:-1], hi[1:]) - np.minimum(lo[:-1], lo[1:])
    return float(ext[np.isfinite(ext)].max())

def dice(a, b):
    a, b = a.astype(bool), b.astype(bool)
    return 2.0 * (a & b).sum() / max(1, a.sum() + b.sum())

if __name__ == "__main__":  # self-check on synthetic shapes, 0.5 mm pixels
    yy, xx = np.mgrid[:200, :200] * 0.5
    ell = (((xx - 50) / 20) ** 2 + ((yy - 50) / 10) ** 2 <= 1)[None].repeat(3, 0)  # 40 x 20 mm ellipse, 3 slices
    L, S, _ = axes_mm(ell, (0.5, 0.5, 2.0))
    assert abs(L - 40) < 1.1 and abs(S - 20) < 1.1, (L, S)
    assert abs(volume_ml(ell, (0.5, 0.5, 2.0)) - np.pi * 20 * 10 * 6 / 1000) < 0.05
    assert dice(ell, ell) == 1.0
    # the short axis on a slanted parallelogram is the exact chord 10.198 mm (not its 15.7 mm width); on a C shape it
    # spans the gap of the C at its widest slab, as a caliper would, and no hull fills the gap's sides
    yy, xx = np.mgrid[:300, :300] * 0.2
    par = ((yy >= 5) & (yy <= 15) & (xx >= 5 + (yy - 5)) & (xx <= 45 + (yy - 5)))[None]
    L, S, _ = axes_mm(par, (0.2, 0.2, 1.0))
    assert abs(S - 10.198) < 0.25, S
    c = (((xx - 30) ** 2 + (yy - 30) ** 2 <= 400) & ((xx - 30) ** 2 + (yy - 30) ** 2 >= 144) & ~((xx > 30) & (abs(yy - 30) < 6)))[None]
    assert abs(axes_mm(c, (0.2, 0.2, 1.0))[1] - 40) < 0.5  # ring of radius 20 with a gap: still 40 mm across
    ell_l = (((xx >= 5) & (xx <= 10) & (yy >= 5) & (yy <= 45)) | ((xx >= 5) & (xx <= 45) & (yy >= 5) & (yy <= 10)))[None]
    assert 6.5 < axes_mm(ell_l, (0.2, 0.2, 1.0))[1] < 8.5  # an L 40 mm a side, 5 mm thick: each line square to its diagonal crosses one arm (7.1 mm), not the 28 mm a hull gives
    box = np.zeros((1, 30, 30), np.uint8); box[0, 5:15, 5:25] = 1  # 20 x 10 pixels at 1 mm: the long axis is the diagonal
    assert abs(axes_mm(box, (1, 1, 1))[0] - np.hypot(19, 9)) < 1e-9 and abs(axes_mm(box, (1, 1, 1), edges=True)[0] - np.hypot(20, 10)) < 1e-9
    line = np.zeros((1, 30, 30), np.uint8); line[0, 3, 2:22] = 1  # one pixel wide: no hull from centres
    assert axes_mm(line, (1, 1, 1))[:2] == (19.0, 0.0) and 0.99 < axes_mm(line, (1, 1, 1), edges=True)[1] < 1.1  # one pixel wide, edge to edge
    print("measure.py self-check ok", round(L, 2), round(S, 2))
