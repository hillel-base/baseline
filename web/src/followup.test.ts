import { expect, test } from "vitest";
import { distanceMm, earlierRows, firstClick } from "./followup";
import type { RecordedNodule } from "./record";

const r = (patient: string, series: string, nodule: number, click_image: number | null = 104) =>
  ({ patient, series, nodule, click_image, click_y: 321, click_x: 330, outline_file: `${patient}_${series}_n${nodule}` }) as RecordedNodule;
const rows = [r("RIDER-1", "test", 1), r("RIDER-1", "retest", 1), r("RIDER-10", "test", 1), r("RIDER-1", "test", 2), r("RIDER-1", "test", 3, null)];

test("a retest scan lists its own patient's test rows, in table order", () => {
  expect(earlierRows(rows, "RIDER-1", "retest").map((x) => x.outline_file)).toEqual(["RIDER-1_test_n1", "RIDER-1_test_n2"]); // not RIDER-10, not the retest row, not a v1 row without a click
  expect(earlierRows(rows, "RIDER-10", "retest").map((x) => x.outline_file)).toEqual(["RIDER-10_test_n1"]);
});
test("a test scan, an unknown patient or a name without _retest has no earlier nodules", () => {
  for (const [patient, series] of [["RIDER-1", "test"], ["RIDER-2", "retest"], ["RIDER-1", "retest2"], ["RIDER-1", ""], ["", "retest"]]) expect(earlierRows(rows, patient, series)).toEqual([]);
  expect(earlierRows([], "RIDER-1", "retest")).toEqual([]);
});
test("a coded (hex) patient's retest lists that patient's test rows", () => {
  const hex = [r("ab12cd34", "test", 1), r("ab12cd34", "retest", 1), r("ef567890", "test", 1)];
  expect(earlierRows(hex, "ab12cd34", "retest").map((x) => x.outline_file)).toEqual(["ab12cd34_test_n1"]);
});
test("the first click comes back as the earlier scan's voxel", () => {
  expect(firstClick(r("P", "test", 1, 104), [110, 108, 106, 104, 102])).toEqual({ z: 3, y: 321, x: 330 });
  expect(firstClick(r("P", "test", 1, 4), null)).toEqual({ z: 3, y: 321, x: 330 });
});
test("the distance is in mm with each axis's own spacing ([x, y, z])", () => {
  expect(distanceMm({ z: 1, y: 2, x: 3 }, { z: 1, y: 2, x: 3 }, [0.7, 0.7, 1.25])).toBe(0);
  expect(distanceMm({ z: 0, y: 0, x: 0 }, { z: 0, y: 0, x: 10 }, [0.7, 0.8, 1.25])).toBe(7);
  expect(distanceMm({ z: 0, y: 0, x: 0 }, { z: 0, y: 10, x: 0 }, [0.7, 0.8, 1.25])).toBe(8);
  expect(distanceMm({ z: 4, y: 0, x: 0 }, { z: 0, y: 0, x: 0 }, [0.7, 0.8, 1.25])).toBe(5);
  expect(distanceMm({ z: 0, y: 0, x: 0 }, { z: 2, y: 3, x: 4 }, [1, 1, 1])).toBe(5.4); // sqrt(29) = 5.385
});
