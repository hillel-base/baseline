import base64
import threading
import time
from pathlib import Path
from typing import Protocol

import numpy as np
import SimpleITK as sitk

from .measure import axes, depth_mm, half_up, volume_ml
from .scans import Scan

HALF_MM = (60, 90, 90)  # working-box half extents (z, y, x): the largest RIDER tumour is ~66 mm across
WINDOW = 160  # the model's input window (voxels per side); nni.py sets the same size on nnInteractive
AIR_HU = -950  # our assumption, not yet confirmed: at or below is air (the usual emphysema cut-off); ground glass is ~-600
SNAP_HU = -500  # proposed, not yet confirmed: Snap to tissue paints only voxels above this (so it leaves ground glass out too)


class OutsideBox(Exception):
    pass


class NoNodule(Exception):
    pass


class Empty(Exception):
    pass


class AlreadyRecorded(Exception):
    pass


class Recorded(Exception):  # a recorded nodule is final
    pass


class NothingToUndo(Exception):
    pass


class OnAir(Exception):
    pass


class NoChange(Exception):  # a stroke that changes no pixel; args: (True when Snap to tissue kept every pixel out,)
    pass


class Segmenter(Protocol):
    def set_image(self, img: np.ndarray) -> None: ...  # float32 (z, y, x)
    def click(self, zyx: tuple, positive: bool) -> np.ndarray: ...  # bool mask of the whole image
    def undo(self) -> np.ndarray | None: ...  # mask before the last click, None if nothing to undo


def crop_box(zyx, shape, spacing_xyz):
    """Working box around the first click, clamped to the volume: (lo inclusive, hi exclusive), z,y,x."""
    half = [round(h / s) for h, s in zip(HALF_MM, spacing_xyz[::-1])]
    lo = tuple(max(0, c - h) for c, h in zip(zyx, half))
    hi = tuple(min(n, c + h) for c, h, n in zip(zyx, half, shape))
    return lo, hi


def at_window_edge(mask, click) -> bool:
    """True when the outline touches the crop box or lies within 2 voxels of the model window around click.
    nnInteractive 2.6.0 centres the window on the click ([c - 80, c + 80)) and pads past the image, never shifting it."""
    if not mask.any():
        return False
    if any(mask.take(i, axis=a).any() for a in range(3) for i in (0, -1)):
        return True
    win = tuple(slice(max(0, c - WINDOW // 2), min(n, c + WINDOW // 2)) for c, n in zip(click, mask.shape))
    inner = tuple(slice(max(0, c - WINDOW // 2 + 2), min(n, c + WINDOW // 2 - 2)) for c, n in zip(click, mask.shape))
    return int(mask[win].sum()) > int(mask[inner].sum())


def brush(shape, points_yx, r):
    """bool (y, x) of the pixels within r of the polyline through points_yx (a disk for one point)."""
    yy, xx = np.indices(shape)
    out = np.zeros(shape, bool)
    p = np.asarray(points_yx, float)
    for a, b in zip(p, p[1:] if len(p) > 1 else p):
        d = b - a
        t = np.clip(((yy - a[0]) * d[0] + (xx - a[1]) * d[1]) / max(d @ d, 1e-12), 0, 1)  # nearest point of the segment
        out |= (yy - a[0] - t * d[0]) ** 2 + (xx - a[1] - t * d[1]) ** 2 <= r * r
    return out


def pack_mask(mask):
    """(bbox [z0,y0,x0,z1,y1,x1] exclusive, base64 of packbits of mask[bbox]); (None, None) when empty."""
    if not mask.any():
        return None, None
    idx = np.argwhere(mask)
    lo, hi = idx.min(0), idx.max(0) + 1
    sub = mask[tuple(slice(a, b) for a, b in zip(lo, hi))]
    return [*lo.tolist(), *hi.tolist()], base64.b64encode(np.packbits(sub).tobytes()).decode()


def write_mask(scan: Scan, mask: np.ndarray, path: Path) -> None:
    """uint8 mask on the scan's CT grid."""
    img = sitk.GetImageFromArray(mask.astype(np.uint8))
    img.CopyInformation(scan.image)
    path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(img, str(path))


class OutlineSession:
    """The one nodule being outlined. Starting a new nodule replaces it."""

    def __init__(self, segmenter: Segmenter, edge: bool = True):
        self.seg, self.lock, self.edge = segmenter, threading.Lock(), edge
        self.scan = self.lo = self.hi = self.mask = self.base = self.hand = None  # base: the model's mask; hand: hand-set axes
        self.clicks: list[dict] = []
        self.strokes: list[tuple] = []  # (crop z, footprint on the crop slice, erase), applied in order on top of base
        self.history: list[tuple] = []  # (kind, hand before it) per action, for undo
        self.counts: dict[str, int] = {}  # nodule numbers per scan, for the engine's lifetime
        self.nodule = 0
        self.model_undo = self.recorded = False  # model_undo: the segmenter can still undo its last click (one level)

    def start(self, scan: Scan, zyx) -> tuple[dict, np.ndarray]:
        """Returns the Outline and the first mask on the full CT grid, both taken under the lock."""
        if scan.array[tuple(zyx)] <= AIR_HU:  # the model outlines a big region of air; refuse before any state changes
            raise OnAir
        with self.lock:
            lo, hi = crop_box(zyx, scan.array.shape, scan.spacing)
            crop = tuple(slice(a, b) for a, b in zip(lo, hi))
            t = time.perf_counter()
            self.scan, self.model_undo, self.history = None, False, []  # the segmenter's image is replaced below, so a model error must leave no nodule
            self.seg.set_image(scan.array[crop].astype(np.float32))
            mask = self.seg.click(tuple(c - l for c, l in zip(zyx, lo)), True)
            seconds = time.perf_counter() - t
            self.scan, self.lo, self.hi, self.mask, self.base, self.strokes, self.hand = scan, lo, hi, mask, mask, [], None
            self.nodule = self.counts[scan.id] = self.counts.get(scan.id, 0) + 1
            self.clicks, self.model_undo, self.recorded = [self._point(zyx, True)], True, False
            self.history = [("click", None)]
            full = np.zeros(scan.array.shape, bool)
            full[crop] = mask
            return self._payload(seconds), full

    def _holds(self, expect) -> bool:
        """expect = (scan id, nodule) the caller thinks is open; None skips the check."""
        return expect is None or (self.scan is not None and (self.scan.id, self.nodule) == tuple(expect))

    def _open(self, expect) -> None:
        """Called under the lock, so another tab's start cannot slip in between."""
        if self.scan is None or not self._holds(expect):
            raise NoNodule
        if self.recorded:
            raise Recorded

    def _act(self, kind) -> None:
        """A new action clears hand-set axes; undo gives them back."""
        self.history.append((kind, self.hand))
        self.hand = None

    def _apply(self):
        mask = self.base.copy()
        for z, fp, erase in self.strokes:
            mask[z] = mask[z] & ~fp if erase else mask[z] | fp
        return mask

    def click(self, zyx, positive: bool, expect=None) -> dict:
        with self.lock:
            self._open(expect)
            if not all(l <= c < h for l, c, h in zip(self.lo, zyx, self.hi)):
                raise OutsideBox
            if positive and self.scan.array[tuple(zyx)] <= AIR_HU:  # same guard as a start; a - click on air is harmless
                raise OnAir
            t = time.perf_counter()
            self.base = self.seg.click(tuple(c - l for c, l in zip(zyx, self.lo)), positive)
            self.mask = self._apply()  # strokes stay on top of the model's new mask
            seconds = time.perf_counter() - t
            self.clicks.append(self._point(zyx, positive))
            self._act("click")
            self.model_undo = True
            return self._payload(seconds)

    def stroke(self, points_zyx, radius: int, erase: bool, snap: bool, expect=None) -> tuple[dict, int]:
        """One brush stroke on one slice: the Outline and the number of voxels it changed."""
        with self.lock:
            self._open(expect)
            zs = {p[0] for p in points_zyx}
            if len(zs) != 1:
                raise ValueError("A stroke has points, all on one slice.")
            z = zs.pop() - self.lo[0]
            if not 0 <= z < self.hi[0] - self.lo[0]:
                raise OutsideBox
            fp = brush(self.mask.shape[1:], [(y - self.lo[1], x - self.lo[2]) for _, y, x in points_zyx], radius)  # clipped to the box
            if not fp.any():
                raise OutsideBox
            if snap and not erase:
                fp &= self.scan.array[z + self.lo[0], self.lo[1]:self.hi[1], self.lo[2]:self.hi[2]] > SNAP_HU
            changed = int((fp & self.mask[z]).sum() if erase else (fp & ~self.mask[z]).sum())
            if not changed:  # refused before any state changes: no history, no painted count, hand-set axes kept
                raise NoChange(snap and not erase)
            self.strokes.append((z, fp, erase))
            self.mask = self._apply()
            self._act("stroke")
            return self._payload(0.0), changed

    def set_axes(self, long_line, short_line, expect=None) -> tuple[dict, list]:
        """Hand-set end points [[y, x], [y, x]] on axis_z. The Outline and (which, before_mm, after_mm) per line that moved."""
        with self.lock:
            self._open(expect)
            if not self.mask.any():
                raise Empty
            lines = [[[round(float(v), 2) for v in p] for p in line] for line in (long_line, short_line)]
            if not all(self.lo[i] - 1 <= p[i - 1] <= self.hi[i] for line in lines for p in line for i in (1, 2)):
                raise OutsideBox
            before = self._payload(0.0)
            sx, sy = self.scan.spacing[:2]
            mm = lambda line: half_up(float(np.hypot((line[1][0] - line[0][0]) * sy, (line[1][1] - line[0][1]) * sx)), 1)
            self._act("axes")
            self.hand = dict(long_line=lines[0], short_line=lines[1], long_mm=mm(lines[0]), short_mm=mm(lines[1]))
            out = self._payload(0.0)
            return out, [(w, before[f"{w}_mm"], out[f"{w}_mm"]) for w in ("long", "short") if before[f"{w}_line"] != out[f"{w}_line"]]

    def undo(self, expect=None) -> dict:
        with self.lock:
            if not self._holds(expect):
                raise NoNodule
            if self.recorded:
                raise Recorded
            if not self._can_undo():
                raise NothingToUndo
            kind = self.history[-1][0]
            if kind == "click":
                prev = self.seg.undo()
                if prev is None:
                    raise NothingToUndo
                self.base, self.model_undo = prev, False
                self.clicks.pop()
            elif kind == "stroke":
                self.strokes.pop()
            self.hand = self.history.pop()[1]
            self.mask = self._apply()
            return self._payload(0.0)

    def _can_undo(self) -> bool:
        return bool(self.history) and (self.history[-1][0] != "click" or self.model_undo)

    def record(self, expect) -> tuple[dict, np.ndarray, Scan]:
        """The Outline, a copy of the crop mask on the full CT grid and the scan, all taken under the lock; a nodule records once.
        The caller writes the file and calls unrecord if that fails."""
        with self.lock:
            if self.scan is None or not self._holds(expect):
                raise NoNodule
            if not self.mask.any():
                raise Empty
            if self.recorded:
                raise AlreadyRecorded
            self.recorded = True
            full = np.zeros(self.scan.array.shape, bool)
            full[tuple(slice(a, b) for a, b in zip(self.lo, self.hi))] = self.mask
            return self._payload(0.0), full, self.scan

    def unrecord(self, expect) -> None:
        with self.lock:
            if self._holds(expect):
                self.recorded = False

    @staticmethod
    def _point(zyx, positive):
        return dict(z=zyx[0], y=zyx[1], x=zyx[2], positive=positive)

    def _payload(self, seconds):
        bbox, packed = pack_mask(self.mask)
        a = axes(self.mask, self.scan.spacing, self.edge)
        off = np.array(self.lo)
        out = dict(nodule=self.nodule, scan=self.scan.id, clicks=list(self.clicks), can_undo=self._can_undo(),
                   bbox=None, mask=None, volume_ml=0, long_mm=0, short_mm=0, axis_z=None, depth_mm=0,
                   width_method="edge to edge" if self.edge else "centre to centre",
                   long_line=None, short_line=None, seconds=round(seconds, 2), at_window_edge=False,
                   painted=len(self.strokes), axes_edited=self.hand is not None)
        if a:
            c = self.clicks[-1] if self.clicks else None  # the window of the latest click, in crop coordinates; none after undoing the first
            # the model's own mask: the warning is about the model's window, so strokes never set or clear it
            out.update(at_window_edge=c is not None and at_window_edge(self.base, (c["z"] - off[0], c["y"] - off[1], c["x"] - off[2])),
                       bbox=(np.array(bbox) + np.tile(off, 2)).tolist(), mask=packed,
                       volume_ml=half_up(volume_ml(self.mask, self.scan.spacing), 2),
                       depth_mm=half_up(depth_mm(self.mask, self.scan.spacing[2], self.edge), 1),
                       long_mm=half_up(a["long_mm"], 1), short_mm=half_up(a["short_mm"], 1), axis_z=a["z"] + self.lo[0],
                       long_line=[(np.array(p) + off[1:]).round(2).tolist() for p in a["long_line"]],
                       short_line=[(np.array(p) + off[1:]).round(2).tolist() for p in a["short_line"]])
            out.update(self.hand or {})  # hand-set axes replace the outline's own
        return out
