"""Pieces of the recorded Demo: a sub-volume around one outline, re-indexed to it, and 8-bit lung-window pictures."""
import numpy as np
from scipy import ndimage

from lung_engine.outline import OnAir, OutsideBox

CONTEXT = 5


def subvolume(scan, *payloads) -> tuple[int, int]:
    """(z0, z1) exclusive: the z range of all the outlines plus CONTEXT slices each side, clamped to the scan."""
    return (max(0, min(p["bbox"][0] for p in payloads) - CONTEXT),
            min(scan.array.shape[0], max(p["bbox"][3] for p in payloads) + CONTEXT))


def reindex(payload, z0) -> dict:
    """The payload with z counted from z0 (the sub-volume must cover the outline: subvolume guarantees it)."""
    assert payload["bbox"][0] >= z0
    b = payload["bbox"]
    return dict(payload, clicks=[dict(c, z=c["z"] - z0) for c in payload["clicks"]], axis_z=payload["axis_z"] - z0,
                bbox=[b[0] - z0, *b[1:3], b[3] - z0, *b[4:]])


def deepest_voxels(mask) -> list[tuple]:
    """Deepest voxel (z,y,x) of each connected piece of mask, the largest piece first.
    The rule is `deepest` from our first feasibility test (S1), run on the bounding box so a full CT fits in memory."""
    idx = np.argwhere(mask)
    lo = idx.min(0)
    sub = np.pad(mask[tuple(slice(a, b + 1) for a, b in zip(lo, idx.max(0)))], 1)
    lab, n = ndimage.label(sub)
    dist = ndimage.distance_transform_edt(sub)  # per piece: the EDT of the whole mask is the EDT of each piece (pieces are separated by background)
    out = []
    for k in np.argsort(-np.bincount(lab.ravel())[1:]) + 1:
        d = np.where(lab == k, dist, -1)
        out.append(tuple(int(i + o - 1) for i, o in zip(np.unravel_index(np.argmax(d), d.shape), lo)))
    return out


def full_mask(session) -> np.ndarray:
    """The session's current outline on the full CT grid."""
    full = np.zeros(session.scan.array.shape, bool)
    full[tuple(slice(a, b) for a, b in zip(session.lo, session.hi))] = session.mask
    return full


def correct(session, expert, max_corrections=2) -> int:
    """Our 3-click rule (feasibility test S1): + at the deepest missed voxel if the missed part is at least as big as
    the excess, else - at the deepest excess voxel. A refused click (OnAir, OutsideBox) falls back to the next piece of the
    same error mask; none accepted ends it. Returns the number of corrections made."""
    for made in range(max_corrections):
        mask = full_mask(session)
        fn, fp = expert & ~mask, mask & ~expert
        if not (fn.any() or fp.any()):
            return made
        positive = bool(fn.sum() >= fp.sum())
        for v in deepest_voxels(fn if positive else fp):
            try:
                session.click(v, positive)
                break
            except (OnAir, OutsideBox):
                continue
        else:
            return made
    return max_corrections


def lung_png(slice_hu) -> np.ndarray:
    """Lung window W1500 / L-600: HU -1350 is black, 150 is white (half rounds up)."""
    return np.clip(np.floor((np.asarray(slice_hu, np.float64) + 1350) / 1500 * 255 + 0.5), 0, 255).astype(np.uint8)
