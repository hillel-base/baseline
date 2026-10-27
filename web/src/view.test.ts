import { expect, test, vi } from "vitest";
import { toVoxel } from "./image";
import { centreOn, clampView, fitView, gestureLog, panBy, wheelFactor, imageToScreen, screenToImage, zoomAt, zoomToRect, type Size } from "./view";

const s: Size = { w: 800, h: 800, cols: 512, rows: 512 };
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

test("at fit, screenToImage is the plain 512 to canvas mapping", () => {
  const p = screenToImage(fitView(), 400, 200, s);
  near(p.x, 256); near(p.y, 128);
  const rect = { left: 10, top: 20, width: 800, height: 800 } as DOMRect;
  expect(toVoxel(10 + 400, 20 + 200, rect, 512, 512)).toEqual({ x: 256, y: 128 });
  expect(toVoxel(9, 30, rect, 512, 512)).toBeNull();
});
test("screenToImage and imageToScreen are inverse", () => {
  const v = { scale: 2.5, ox: 40, oy: 90 };
  const p = screenToImage(v, 123, 456, s), q = imageToScreen(v, p.x, p.y, s);
  near(q.x, 123); near(q.y, 456);
});
test("zoomAt keeps the point under the cursor fixed", () => {
  const v = zoomAt({ scale: 2, ox: 100, oy: 100 }, 1.25, 300, 500, s);
  const before = screenToImage({ scale: 2, ox: 100, oy: 100 }, 300, 500, s), after = screenToImage(v, 300, 500, s);
  near(after.x, before.x); near(after.y, before.y);
  near(v.scale, 2.5);
});
test("zoomAt clamps the scale to 1..8 and at fit does not move", () => {
  expect(zoomAt(fitView(), 0.5, 300, 300, s)).toEqual(fitView());
  expect(zoomAt({ scale: 8, ox: 0, oy: 0 }, 2, 0, 0, s).scale).toBe(8);
});
test("zoomToRect maps the rectangle's corners to the canvas corners", () => {
  const v = zoomToRect(fitView(), { x0: 200, y0: 300, x1: 400, y1: 500 }, s);
  near(v.scale, 4);
  const a = imageToScreen(v, screenToImage(fitView(), 200, 300, s).x, screenToImage(fitView(), 200, 300, s).y, s);
  const b = imageToScreen(v, screenToImage(fitView(), 400, 500, s).x, screenToImage(fitView(), 400, 500, s).y, s);
  near(a.x, 0); near(a.y, 0); near(b.x, 800); near(b.y, 800);
});
test("zoomToRect keeps aspect: a wide rectangle fits by its width", () => {
  const v = zoomToRect(fitView(), { x0: 100, y0: 300, x1: 500, y1: 400 }, s);
  near(v.scale, 2);
});
test("zoomToRect ignores a zero-size rectangle", () => {
  expect(zoomToRect(fitView(), { x0: 5, y0: 5, x1: 5, y1: 50 }, s)).toEqual(fitView());
});
test("clampView leaves no margin beyond the image", () => {
  expect(clampView({ scale: 2, ox: -50, oy: 400 }, s)).toEqual({ scale: 2, ox: 0, oy: 256 });
  expect(clampView({ scale: 1, ox: 30, oy: 30 }, s)).toEqual(fitView());
});
test("toVoxel at scale 2 with an offset hits the expected voxel", () => {
  const rect = { left: 0, top: 0, width: 800, height: 800 } as DOMRect;
  // visible image starts at (100, 60); screen (400, 400) is 400/(800*2/512) = 128 px in
  expect(toVoxel(400, 400, rect, 512, 512, { scale: 2, ox: 100, oy: 60 })).toEqual({ x: 228, y: 188 });
});

test("wheelFactor: up zooms in, down out, opposite events cancel, no move is 1", () => {
  expect(wheelFactor(-10)).toBeGreaterThan(1);
  expect(wheelFactor(10)).toBeLessThan(1);
  near(wheelFactor(7) * wheelFactor(-7), 1);
  expect(wheelFactor(0)).toBe(1);
  near(wheelFactor(-100), Math.exp(0.2)); // a mouse notch is capped
  near(wheelFactor(100), 1 / Math.exp(0.2));
  near(wheelFactor(-7), Math.exp(0.07)); // a trackpad delta is not
});
test("panBy keeps the grabbed image point under the cursor and stays clamped", () => {
  const v = { scale: 2, ox: 100, oy: 100 };
  const p = panBy(v, 400, 400, 300, 350, s);
  const a = screenToImage(v, 400, 400, s), b = screenToImage(p, 300, 350, s);
  near(a.x, b.x); near(a.y, b.y);
  expect(panBy(v, 0, 0, 5000, 5000, s)).toEqual({ scale: 2, ox: 0, oy: 0 });
});
test("gestureLog: one post per gesture, after 500 ms, with the values captured at the events", () => {
  vi.useFakeTimers();
  const post = vi.fn(), g = gestureLog(post, 500);
  g.note("A", 1.5, 1); vi.advanceTimersByTime(300); g.note("A", 2, 1.5);
  vi.advanceTimersByTime(499);
  expect(post).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(post).toHaveBeenCalledExactlyOnceWith("A", 2);
  vi.useRealTimers();
});
test("gestureLog: flush posts the captured scan and scale now, once; no post when the scale came back", () => {
  vi.useFakeTimers();
  const post = vi.fn(), g = gestureLog(post, 500);
  g.note("A", 3, 1); g.flush(); g.flush(); vi.advanceTimersByTime(1000);
  expect(post).toHaveBeenCalledExactlyOnceWith("A", 3);
  g.note("B", 2, 1); g.note("B", 1, 2); g.flush();
  expect(post).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("centreOn puts the point in the middle at the same scale, and at fit or an edge moves only as far as the image allows", () => {
  const v = centreOn({ scale: 4, ox: 0, oy: 0 }, 300, 200, s);
  expect(v.scale).toBe(4);
  const mid = imageToScreen(v, 300, 200, s);
  expect(mid.x).toBeCloseTo(s.w / 2); expect(mid.y).toBeCloseTo(s.h / 2);
  expect(centreOn(fitView(), 300, 200, s)).toEqual(fitView());
  expect(centreOn({ scale: 4, ox: 100, oy: 100 }, 5, 5, s)).toMatchObject({ ox: 0, oy: 0 });
});
