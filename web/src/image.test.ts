import { expect, test } from "vitest";
import { addPoint, aimedHere, axisLabels, edgePixels, imageInput, loadingCue, lineMm, nearestEnd, sliceLabel, stepZ, toVoxel, unpackMask, upLabel, wheelNotches, wheelStep, windowToRGBA, zOfImage } from "./image";

test("lung window maps level-width/2 to 0 and level+width/2 to 255", () => {
  const px = windowToRGBA(new Int16Array([-1350, -600, 150]));
  expect([px[0], px[4], px[8], px[3]]).toEqual([0, 128, 255, 255]);
});
test("toVoxel undoes CSS scaling", () => {
  const rect = { left: 10, top: 20, width: 256, height: 256 } as DOMRect;
  expect(toVoxel(10 + 128, 20 + 64, rect, 512, 512)).toEqual({ x: 256, y: 128 });
  expect(toVoxel(5, 5, rect, 512, 512)).toBeNull();
});
test("toVoxel returns null for an empty rect", () => {
  const rect = { left: 0, top: 0, width: 0, height: 0 } as DOMRect;
  expect(toVoxel(0, 0, rect, 512, 512)).toBeNull();
});

test("wheelStep accumulates small trackpad deltas, one step per 50 px", () => {
  let r = wheelStep(0, 20, 0, 800);
  expect(r).toEqual({ steps: 0, acc: 20 });
  r = wheelStep(r.acc, 40, 0, 800);
  expect(r).toEqual({ steps: 1, acc: 10 });
  expect(wheelStep(0, -120, 0, 800).steps).toBe(-2);
});
test("wheelNotches: one mouse-wheel event is one step, whatever its size; a trackpad gives 0 (smooth path)", () => {
  expect(wheelNotches(4, 0, -120)).toBe(1); // Chrome/Safari on macOS, mouse: about 4 px, legacy wheelDelta -120
  expect(wheelNotches(100, 0, -120)).toBe(1); // Chrome on Windows, mouse
  expect(wheelNotches(-4, 0, 120)).toBe(-1); // the other way
  expect(wheelNotches(8, 0, -240)).toBe(1); // a fast spin: still one image, no acceleration
  expect(wheelNotches(2, 0, -6)).toBe(0); // trackpad: wheelDelta is -3 x deltaY
  expect(wheelNotches(40, 0, -120)).toBe(0); // trackpad, even when that is a whole 120
  expect(wheelNotches(3, 1)).toBe(1); // Firefox mouse: lines, one event per notch
  expect(wheelNotches(-3, 1)).toBe(-1);
  expect(wheelNotches(0.375, 1)).toBe(0); // Firefox, a hi-res wheel or a touchpad: fractional lines take the smooth path
  expect(wheelNotches(48, 0)).toBe(0); // no legacy field: smooth path
  expect(wheelNotches(4.000244140625, 0, -120)).toBe(1); // Chrome's fractional mouse delta
});
test("wheelStep scales line and page modes", () => {
  expect(wheelStep(0, 1, 1, 800).steps).toBe(0); // 40 px: not yet a step
  expect(wheelStep(0, 2, 1, 800).steps).toBe(1);
  expect(wheelStep(0, 1, 2, 800).steps).toBe(16);
});

test("label shows the image number", () => { expect(sliceLabel(0, [265, 264, 263], 3)).toBe("Image 265 / 3"); });
test("label falls back to slice index", () => { expect(sliceLabel(0, null, 3)).toBe("Slice index 1 / 3"); });
test("one step down goes to the next image number", () => {
  expect(stepZ(2, [3, 2, 1], 1, 3)).toBe(1);
  expect(stepZ(0, [3, 2, 1], 1, 3)).toBe(0);
  expect(stepZ(0, [3, 2, 1], -1, 3)).toBe(1);
  expect(stepZ(0, null, 1, 3)).toBe(1);
  expect(stepZ(2, null, 1, 3)).toBe(2);
});
test("zOfImage finds the slice that shows an image number", () => {
  expect(zOfImage(2, [3, 2, 1])).toBe(1);
  expect(zOfImage(5, [3, 1])).toBe(0); // nearest when the number is absent
});

test("unpackMask matches numpy packbits order", () => {
  // "+EA=" is base64(np.packbits([1,1,1,1,1,0,0,0,0,1])); bbox is 1 slice x 2 rows x 5 cols
  expect(Array.from(unpackMask("+EA=", [0, 0, 0, 1, 2, 5]))).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 1]);
});
test("edgePixels keeps the rim of a 3x3 block", () => {
  const edge = edgePixels(new Uint8Array(9).fill(1), 3, 3);
  expect(Array.from(edge)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);
});
test("edgePixels treats the border of the box as outside", () => {
  expect(Array.from(edgePixels(new Uint8Array([1]), 1, 1))).toEqual([1]);
});

test("upLabel says which way up moves, from head_dir and the shown numbers", () => {
  const falling = Array.from({ length: 5 }, (_, z) => 265 - z);
  expect(upLabel(1, falling)).toBe("head ↑ / feet ↓");
  expect(upLabel(1, [...falling].reverse())).toBe("feet ↑ / head ↓");
  expect(upLabel(-1, null)).toBe("head ↑ / feet ↓");
  expect(upLabel(null, falling)).toBe("");
});

test("a stroke drops a repeat of its last pixel and stops at the engine's 1000 points", () => {
  expect(addPoint([], [1, 2])).toEqual([[1, 2]]);
  expect(addPoint([[1, 2]], [1, 2])).toEqual([[1, 2]]);
  expect(addPoint([[1, 2]], [1, 3])).toEqual([[1, 2], [1, 3]]);
  expect(addPoint([[1, 2], [1, 3]], [1, 2])).toHaveLength(3); // back over an earlier pixel is a new point
  const full = Array.from({ length: 1000 }, (_, i) => [0, i] as [number, number]);
  expect(addPoint(full, [5, 5])).toBe(full);
});
test("an axis length in mm uses the row and column spacing ([x, y, z])", () => {
  expect(lineMm([[0, 0], [3, 4]], [0.5, 1, 2])).toBeCloseTo(Math.hypot(3, 2), 10);
});
test("the axis end under the pointer: the nearest within reach, else none", () => {
  const ends: [number, number][][] = [[[0, 0], [100, 0]], [[50, 50], [50, 60]]]; // [line][end] = screen [x, y]
  expect(nearestEnd(ends, 2, 1, 8)).toEqual([0, 0]);
  expect(nearestEnd(ends, 52, 58, 8)).toEqual([1, 1]);
  expect(nearestEnd(ends, 30, 30, 8)).toBeNull();
  expect(nearestEnd([], 0, 0, 8)).toBeNull();
});

// Axis labels: [x, y] canvas points, 50 x 14 px labels, a 512 x 512 canvas; a label sits 6 px past its line's end.
const size: [[number, number], [number, number]] = [[50, 14], [50, 14]];
test("axis labels far apart: each past the end of its line that is farther from the other line", () => {
  expect(axisLabels([[100, 200], [200, 200]], [[400, 300], [400, 340]], size, [512, 512]))
    .toEqual([{ x: 44, y: 193, w: 50, h: 14 }, { x: 375, y: 346, w: 50, h: 14 }]); // long: left of its left end; short: under its lower end
});
test("axis labels on a cross that do not touch stay at the outer ends (a tie: the right end, then the upper end)", () => {
  expect(axisLabels([[100, 200], [200, 200]], [[150, 170], [150, 230]], size, [512, 512]))
    .toEqual([{ x: 206, y: 193, w: 50, h: 14 }, { x: 125, y: 150, w: 50, h: 14 }]);
});
test("axis labels that would touch: the short label moves to its other end", () => {
  const [long, short] = axisLabels([[100, 104], [112, 96]], [[106, 97], [106, 103]], size, [512, 512]);
  expect(long).toEqual({ x: expect.closeTo(117, 1), y: expect.closeTo(81, 1), w: 50, h: 14 }); // up and right of the upper-right end
  expect(short).toEqual({ x: 81, y: 109, w: 50, h: 14 }); // the upper end touched the long label: under the lower end instead
});
test("axis labels that touch at every end: the short label is dropped, the long one stays", () => {
  expect(axisLabels([[100, 100], [104, 100]], [[102, 99], [102, 101]], size, [512, 512])).toEqual([{ x: 110, y: 93, w: 50, h: 14 }, undefined]);
});
test("an axis label that would leave the canvas goes to the line's other end; no line, no label", () => {
  expect(axisLabels([[400, 200], [506, 200]], null, size, [512, 512])).toEqual([{ x: 344, y: 193, w: 50, h: 14 }, undefined]);
  expect(axisLabels(null, null, size, [512, 512])).toEqual([undefined, undefined]);
});
test("an axis label off the canvas at both ends (zoomed in) keeps its first place, and the short label that fits stays", () => {
  expect(axisLabels([[-100, 200], [600, 200]], [[300, 400], [300, 440]], size, [512, 512]))
    .toEqual([{ x: -156, y: 193, w: 50, h: 14 }, { x: 275, y: 446, w: 50, h: 14 }]);
});

test("loadingCue: no cue while the picture shows the indicator's slice; else the indicator's own number", () => {
  const inst = [265, 264, 263];
  expect(loadingCue(1, 1, inst)).toBeUndefined();
  expect(loadingCue(0, 1, inst)).toBe("Loading image 264…"); // the indicator says "Image 264 / 3"
  expect(loadingCue(undefined, 2, inst)).toBe("Loading image 263…"); // nothing on the canvas yet
  expect(loadingCue(4, 2, null)).toBe("Loading slice index 3…"); // a scan with no image numbers: "Slice index 3 / n"
});

const base = { space: false, areaMode: false, tool: false, panning: false, dragging: false, overHandle: false, pending: false, axes: false };
test("imageInput: during the cue no overlay shows, any press is never a click (N1), and the cursor says loading, also over an Axes handle (N3)", () => {
  const cue = "Loading image 104…";
  expect(imageInput({ ...base, cue })).toEqual({ overlays: false, toolPress: true, cursor: "progress" }); // Add mode: a press now, released after the slice lands, is no click
  expect(imageInput({ ...base, cue, axes: true, tool: true, overHandle: true }).cursor).toBe("progress");
  expect(imageInput({ ...base, cue, space: true }).cursor).toBe("grab"); // a Space pan still works
  expect(imageInput(base)).toEqual({ overlays: true, toolPress: false, cursor: "crosshair" });
});
test("imageInput: without the cue, the cursor and tool presses are as before", () => {
  expect(imageInput({ ...base, axes: true, tool: true, overHandle: true }).cursor).toBe("grab");
  expect(imageInput({ ...base, axes: true, tool: true, overHandle: true, pending: true }).cursor).toBe("wait");
  expect(imageInput({ ...base, axes: true, tool: true })).toEqual({ overlays: true, toolPress: true, cursor: "default" });
  expect(imageInput({ ...base, panning: true, space: true }).cursor).toBe("grabbing");
  expect(imageInput({ ...base, dragging: true, tool: true }).cursor).toBe("grabbing");
  expect(imageInput({ ...base, areaMode: true }).toolPress).toBe(true);
});
test("aimedHere: a click, stroke or axis drag acts only while the indicator names the image it was aimed at", () => {
  expect(aimedHere(5, 5, 9)).toBe(true); // a stroke or a press on image 5, released on 5
  expect(aimedHere(5, 6, 9)).toBe(false); // the wheel moved during it: cancelled, nothing sent
  expect(aimedHere(undefined, 9, 9)).toBe(true); // an axis drag lives on the largest slice
  expect(aimedHere(undefined, 8, 9)).toBe(false);
  expect(aimedHere(undefined, 8, null)).toBe(false);
});
