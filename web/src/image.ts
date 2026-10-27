import { fitView, screenToImage, type View } from "./view";
/** Grey RGBA pixels for HU values through a display window (default: lung window). */
export function windowToRGBA(hu: Int16Array, width = 1500, level = -600): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(hu.length * 4);
  const lo = level - width / 2;
  for (let i = 0; i < hu.length; i++) {
    const g = ((hu[i] - lo) / width) * 255; // Uint8ClampedArray clamps and rounds
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = g;
    out[4 * i + 3] = 255;
  }
  return out;
}

/** Image pixel under the mouse, or null outside the image. */
export function toVoxel(clientX: number, clientY: number, rect: DOMRect, cols: number, rows: number, view: View = fitView()) {
  if (!rect.width || !rect.height) return null;
  const p = screenToImage(view, clientX - rect.left, clientY - rect.top, { w: rect.width, h: rect.height, cols, rows });
  const [x, y] = [Math.floor(p.x), Math.floor(p.y)];
  return x < 0 || y < 0 || x >= cols || y >= rows ? null : { x, y };
}

type Pt = [number, number]; // [y, x]
/** The stroke with pixel p added: a repeat of the last pixel is dropped.
 *  shortcut: a stroke keeps its first 1000 pixels (the engine's limit); split it into several requests if strokes that long turn up. */
export const addPoint = (pts: Pt[], p: Pt): Pt[] => {
  const l = pts.at(-1);
  return (l && l[0] === p[0] && l[1] === p[1]) || pts.length >= 1000 ? pts : [...pts, p];
};

/** Millimetres along [[y, x], [y, x]] on one slice; spacing is [x, y, z] as ScanMeta gives it. */
export const lineMm = ([[y1, x1], [y2, x2]]: Pt[], [sx, sy]: number[]) => Math.hypot((y2 - y1) * sy, (x2 - x1) * sx);

/** [line, end] of the axis end nearest screen point (px, py) within `max` px, or null; ends[line][end] is that end's [x, y] on screen. */
export function nearestEnd(ends: [number, number][][], px: number, py: number, max: number): [number, number] | null {
  let best: [number, number] | null = null, d = max;
  ends.forEach((line, i) => line.forEach(([x, y], j) => { const e = Math.hypot(x - px, y - py); if (e <= d) { d = e; best = [i, j]; } }));
  return best;
}

type XY = [number, number]; // [x, y] on a canvas
export type Box = { x: number; y: number; w: number; h: number }; // top-left corner and size, canvas px
const GAP = 6, PAD = 2; // GAP: line end to label, clear of the Axes handle ring; PAD: room for two halos between labels
/** A [w, h] label just past `end`, on the far side from `from` (the line's other end), so it never covers its own line. */
const pastEnd = ([ex, ey]: XY, [fx, fy]: XY, [w, h]: XY): Box => {
  const n = Math.hypot(ex - fx, ey - fy), [dx, dy] = n ? [(ex - fx) / n, (ey - fy) / n] : [1, 0], m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: ex + dx * GAP + (dx / m - 1) * (w / 2), y: ey + dy * GAP + (dy / m - 1) * (h / 2), w, h };
};
const touch = (a: Box, b: Box) => a.x < b.x + b.w + PAD && b.x < a.x + a.w + PAD && a.y < b.y + b.h + PAD && b.y < a.y + a.h + PAD;
/** A line's two label places: past its outer end (farther from the other line's middle; on a tie the right end, then the upper one), then past the other end. */
const places = ([a, b]: [XY, XY], other: [XY, XY] | null, size: XY): Box[] => {
  const far = (p: XY) => (other ? Math.hypot(p[0] - (other[0][0] + other[1][0]) / 2, p[1] - (other[0][1] + other[1][1]) / 2) : 0);
  const aFirst = far(a) !== far(b) ? far(a) > far(b) : a[0] !== b[0] ? a[0] > b[0] : a[1] < b[1];
  return aFirst ? [pastEnd(a, b, size), pastEnd(b, a, size)] : [pastEnd(b, a, size), pastEnd(a, b, size)];
};
/** Where the long and short axis labels go: each past the outer end of its own line and inside the canvas. If the two would touch,
 *  the short label moves to its other end, then the long one does; if they still touch, the short label is dropped (undefined). */
export function axisLabels(long: [XY, XY] | null, short: [XY, XY] | null, sizes: [XY, XY], [w, h]: XY): [Box | undefined, Box | undefined] {
  const inside = (r: Box) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;
  const L = long ? places(long, short, sizes[0]) : [], S = short ? places(short, long, sizes[1]) : [];
  for (const l of L) for (const s of S) if (inside(l) && inside(s) && !touch(l, s)) return [l, s];
  const pick = (c: Box[]) => c.find(inside) ?? c[0]; // neither place inside (zoomed past the line's ends): keep the first, as before
  const l = pick(L), s = S.find((b) => inside(b) && !(l && touch(l, b))); // the short label still shows where it fits and touches nothing
  return [l, s ?? (L.length ? undefined : pick(S))];
}

/** One image (±1, the sign of deltaY) for a mouse-wheel event, or 0 for a trackpad or an unknown device (they take wheelStep).
 *  No standard flag tells a mouse from a trackpad, so: whole lines (Firefox's mouse), or Chrome/Safari's legacy wheelDelta in whole 120s
 *  that is not the trackpad's -3 × delta. One event is one image even when the OS reports a fast spin as 240 or 360 (no acceleration).
 *  Fractional lines are a hi-res wheel or a touchpad: smooth path. shortcut: a heuristic per browser; if a mouse still needs several notches, log the raw deltas. */
export function wheelNotches(delta: number, deltaMode: number, legacy?: number) {
  if (deltaMode === 1) return Number.isInteger(delta) ? Math.sign(delta) : 0;
  return legacy && legacy % 120 === 0 && legacy !== -3 * delta ? Math.sign(-legacy) : 0;
}

/** Wheel scroll: adds this event's pixels to `acc`, one step per 50 px; returns the whole steps and the leftover. */
export function wheelStep(acc: number, deltaY: number, deltaMode: number, pageHeight: number) {
  acc += deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? pageHeight : 1);
  const steps = Math.trunc(acc / 50);
  return { steps, acc: acc - steps * 50 };
}

/** "Image 117 / 265" (DICOM InstanceNumber) or, when the scan has none, "Slice index 149 / 265". */
export function sliceLabel(z: number, inst: number[] | null, n: number) {
  return inst ? `Image ${inst[z]} / ${n}` : `Slice index ${z + 1} / ${n}`;
}
/** The cue on the image while the canvas shows another slice than the indicator's z (`shown`; undefined: none yet), in the indicator's own
 *  words; undefined when they agree. Only then do the overlays show and a click, stroke or axis drag reach the engine. */
export const loadingCue = (shown: number | undefined, z: number, inst: number[] | null) =>
  shown === z ? undefined : `Loading ${inst ? `image ${inst[z]}` : `slice index ${z + 1}`}…`;
/** The image's overlays, press rule and cursor. While `cue` is set (the picture is another slice than the indicator's): no overlay, and a
 *  press is never a click, even one released after the slice lands; the cursor says loading, also over an Axes handle,
 *  and a Space pan still grabs. `tool`: Paint, Erase or Axes, whose presses are never clicks; `dragging`: an axis end in hand. */
export function imageInput(s: { cue?: string; space: boolean; areaMode: boolean; tool: boolean; panning: boolean; dragging: boolean; overHandle: boolean; pending: boolean; axes: boolean }) {
  return {
    overlays: !s.cue,
    toolPress: s.space || s.areaMode || s.tool || !!s.cue,
    cursor: s.panning || s.dragging ? "grabbing" : s.space ? "grab" : s.cue ? "progress" : s.overHandle && !s.pending ? "grab" : s.pending ? "wait" : s.axes ? "default" : "crosshair",
  };
}
/** A click, stroke or axis drag acts only on the image it was aimed at: one begun on slice `at` (an axis drag: undefined, the largest
 *  slice) is cancelled, and sends nothing, once the indicator names another slice (the wheel, an arrow key or the slider). */
export const aimedHere = (at: number | undefined, z: number, axisZ: number | null | undefined) => z === (at ?? axisZ);

/** Which way up on the screen is: up goes to the lower shown number. "" when the scan's head direction is unknown. */
export function upLabel(headDir: 1 | -1 | null, inst: number[] | null) {
  // assumes monotonic image numbers: only the first pair is read
  if (!headDir) return "";
  const upStep = inst && inst.length > 1 && inst[1] < inst[0] ? 1 : -1; // z step toward the lower shown number
  return upStep === headDir ? "head ↑ / feet ↓" : "feet ↑ / head ↓";
}

/** The slice whose shown number is one step further in `dir`, clamped at the ends. */
export function stepZ(z: number, inst: number[] | null, dir: 1 | -1, n: number) {
  if (!inst) return Math.min(n - 1, Math.max(0, z + dir));
  let best = z; // nearest number beyond this one, so a gap in the numbering is skipped
  for (let k = 0; k < n; k++) {
    const d = (inst[k] - inst[z]) * dir;
    if (d > 0 && (best === z || d < (inst[best] - inst[z]) * dir)) best = k;
  }
  return best;
}

/** The slice that shows image number `num` (the nearest one if absent). */
export function zOfImage(num: number, inst: number[]) {
  return inst.reduce((b, v, k) => (Math.abs(v - num) < Math.abs(inst[b] - num) ? k : b), 0);
}

/** Bits of a base64 np.packbits array (most significant bit first), one byte per voxel, for bbox [z0,y0,x0,z1,y1,x1]. */
export function unpackMask(b64: string, bbox: number[]): Uint8Array {
  const n = (bbox[3] - bbox[0]) * (bbox[4] - bbox[1]) * (bbox[5] - bbox[2]);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

/** 1 where a mask pixel has a 4-neighbour outside the mask (the box border counts as outside). */
export function edgePixels(slice: Uint8Array, rows: number, cols: number): Uint8Array {
  const out = new Uint8Array(slice.length);
  const at = (y: number, x: number) => (y >= 0 && x >= 0 && y < rows && x < cols ? slice[y * cols + x] : 0);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      if (slice[y * cols + x] && !(at(y - 1, x) && at(y + 1, x) && at(y, x - 1) && at(y, x + 1))) out[y * cols + x] = 1;
  return out;
}
