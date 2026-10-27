import { expect, test } from "vitest";
import { keepInMemory, loadCounters, loadRecorded, saveCounters, saveRecorded, backUpRows, loadCleared } from "./record";

test("in memory mode rows, counters and the backup slot never touch localStorage", () => {
  const touched: string[] = [];
  (globalThis as any).localStorage = { getItem: (k: string) => (touched.push(k), null), setItem: (k: string) => touched.push(k) };
  keepInMemory();
  const row = { patient: "p", series: "s", series_number: 1, study_date: null, nodule: 1, slice: 1, slice_label: "image", long_mm: 1, short_mm: 1, width: "w", volume_ml: 1, depth_mm: 1, clicks: 1, corrections: 0, seconds_to_record: 1, recorded_at: "t",
    long_y1: 0, long_x1: 0, long_y2: 0, long_x2: 0, short_y1: 0, short_x1: 0, short_y2: 0, short_x2: 0, click_image: 1, click_y: 1, click_x: 1, at_window_edge: false, slice_thickness_mm: 1, slice_spacing_mm: 1, painted: 0, axes_edited: false, follows: "", outline_file: "f" } as never; // painted, axes_edited: row v5; follows: row v4
  expect(saveRecorded([row])).toBe(true);
  saveCounters({ a: 1 });
  expect(backUpRows([row])).toBe(true);
  expect([loadRecorded().length, loadCounters().a, loadCleared().length]).toEqual([1, 1, 1]);
  expect(touched).toEqual([]);
});
