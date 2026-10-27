"""Volume, long axis, short axis and depth of a 3D mask. Axes are taken on the axial slice with the largest outline.
Edge to edge (default) adds the width of the end pixels along each line; centre to centre is the plain pixel-centre distance."""
import math

import numpy as np
from scipy.spatial import ConvexHull


def half_up(v: float, nd: int) -> float:
    """Round half up (71.25 -> 71.3), as people do by hand; Python's round() goes to even."""
    return math.floor(v * 10**nd + 0.5) / 10**nd


def volume_ml(mask, spacing_xyz) -> float:
    return float(mask.sum()) * float(np.prod(spacing_xyz)) / 1000.0


def depth_mm(mask, spacing_z, edge: bool = True) -> float:
    zs = np.flatnonzero(mask.reshape(mask.shape[0], -1).any(1))
    return float((zs[-1] - zs[0] + edge) * spacing_z) if len(zs) else 0.0


def axes(mask, spacing_xyz, edge: bool = True) -> dict | None:
    """mask is z,y,x. Lines are [[y,x],[y,x]] in voxel indices of the slice `z` (decimals when edge)."""
    if not mask.any():
        return None
    z = int(np.argmax(mask.reshape(mask.shape[0], -1).sum(1)))
    yx = np.argwhere(mask[z])
    pts = yx[:, ::-1] * np.array(spacing_xyz[:2])  # (x, y) in mm
    if len(yx) < 3 or np.linalg.matrix_rank(pts - pts[0]) < 2:  # a point or a straight run: the hull is undefined
        hp = pts
    else:
        hp = pts[ConvexHull(pts).vertices]
    d = np.linalg.norm(hp[:, None] - hp[None], axis=2)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    long_mm = float(d[i, j])
    a, b = hp[i], hp[j]
    sx, sy = spacing_xyz[:2]
    ext = lambda u: abs(u[0]) * sx + abs(u[1]) * sy  # width of an end pixel along direction u
    if long_mm == 0:
        one = (max(sx, sy), min(sx, sy)) if edge else (0.0, 0.0)
        return dict(long_mm=one[0], short_mm=one[1], z=z, long_line=[yx[0].tolist()] * 2, short_line=[yx[0].tolist()] * 2)
    u = (b - a) / long_mm
    grow = ext(u) / 2 if edge else 0.0
    vox = lambda p: (lambda v: v.round(2).tolist() if edge else v.round().astype(int).tolist())(p[::-1] / spacing_xyz[1::-1])
    long_line = [vox(a - u * grow), vox(b + u * grow)]
    long_mm += 2 * grow
    s = (pts - a) @ u
    t = (pts - a) @ np.array([-u[1], u[0]])
    bins = np.floor(s / min(spacing_xyz[:2])).astype(int)
    best = (-1.0, 0, 0)
    for k in np.unique(bins):
        idx = np.flatnonzero(bins == k)
        lo, hi = idx[np.argmin(t[idx])], idx[np.argmax(t[idx])]
        if t[hi] - t[lo] > best[0]:
            best = (float(t[hi] - t[lo]), lo, hi)
    v = np.array([-u[1], u[0]])
    g = ext(v) / 2 if edge else 0.0
    short_line = [vox(pts[best[1]] - v * g), vox(pts[best[2]] + v * g)]
    return dict(long_mm=long_mm, short_mm=best[0] + 2 * g, z=z, long_line=long_line, short_line=short_line)
