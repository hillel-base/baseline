import { expect, test } from "vitest";
import { ENGINE_STOPPED, NO_LONGER_OPEN, PRACTICE_STOPPED, type Outline } from "./api";
import { clickKind, dropsNodule } from "./clicks";

const o = {
  nodule: 1, scan: "s", can_undo: true, clicks: [], at_window_edge: false, bbox: null, mask: null, volume_ml: 6.6, long_mm: 20, short_mm: 10,
  axis_z: 3, long_line: null, short_line: null, seconds: 1, depth_mm: 5, width_method: "edge to edge",
} as Outline;

test("no outline, or an empty one, starts a nodule whatever the mode", () => {
  for (const [r, s] of [["add", false], ["remove", false], ["add", true], ["paint", false], ["erase", true], ["axes", false]] as const) {
    expect(clickKind(undefined, r, s)).toBe("start");
    expect(clickKind({ ...o, axis_z: null, volume_ml: 0 }, r, s)).toBe("start");
    expect(clickKind({ ...o, volume_ml: 0.004 }, r, s)).toBe("start");
  }
});
test("with an outline: Add mode adds, Remove mode or Shift removes", () => {
  expect(clickKind(o, "add", false)).toBe("add");
  expect(clickKind(o, "remove", false)).toBe("remove");
  expect(clickKind(o, "add", true)).toBe("remove");
  expect(clickKind({ ...o, volume_ml: 0.01 }, "add", false)).toBe("add");
});
test("with an outline, Paint, Erase and Axes never send a model click, Shift or not", () => {
  for (const m of ["paint", "erase", "axes"] as const) for (const shift of [false, true]) expect(clickKind(o, m, shift)).toBeNull();
});
test("only the stopped-engine and no-longer-open errors drop the nodule", () => {
  expect(dropsNodule(ENGINE_STOPPED)).toBe(true);
  expect(dropsNodule(NO_LONGER_OPEN)).toBe(true);
  expect(dropsNodule(PRACTICE_STOPPED)).toBe(true); // the practice server lost the nodule the same way
  expect(dropsNodule("That click is outside the working box of this nodule. Start a new nodule to outline something else.")).toBe(false);
  expect(dropsNodule("That point is air, so it cannot be added. Click on the nodule itself.")).toBe(false);
});
test("a recorded nodule is final: the next click starts a new one", () => {
  expect(clickKind(o, "add", false, true)).toBe("start");
  expect(clickKind(o, "remove", true, true)).toBe("start");
  expect(clickKind(o, "paint", false, true)).toBe("start");
});
