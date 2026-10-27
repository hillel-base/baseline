import { afterEach, expect, test, vi } from "vitest";
import { FAR, getSteps, greyToHU, hitsRecorded, startNodule } from "./demo";
import { windowToRGBA } from "./image";
import type { Outline } from "./api";

afterEach(() => vi.unstubAllGlobals());
const grey = (hu: number) => windowToRGBA(new Int16Array([hu]))[0];
const o = (extra: Partial<Outline> = {}) => ({ clicks: [{ z: 10, y: 100, x: 100, positive: true }], bbox: null, mask: null, ...extra }) as Outline;

test("PNG grey to HU round-trips the lung window within one grey step", () => {
  for (let g = 0; g < 256; g++) expect(grey(greyToHU(g))).toBe(g);
  expect(greyToHU(0)).toBe(-1350); expect(greyToHU(255)).toBe(150);
});
test("10-voxel rule: near passes, far fails; inside the mask passes", () => {
  expect(hitsRecorded(o(), { z: 10, y: 100, x: 110 })).toBe(true);
  expect(hitsRecorded(o(), { z: 10, y: 100, x: 111 })).toBe(false);
  const m = btoa(String.fromCharCode(0b01000000)); // 1x1x2 box, second voxel set
  const masked = o({ bbox: [30, 50, 50, 31, 51, 52], mask: m });
  expect(hitsRecorded(masked, { z: 30, y: 50, x: 51 })).toBe(true);
  expect(hitsRecorded(masked, { z: 30, y: 50, x: 50 })).toBe(false);
});
test("startNodule gives the recorded First click outline or the demo message; steps keep one sub-volume", async () => {
  const steps = [{ label: "First click", outline: o() }, { label: "After 2 corrections", outline: o() }];
  const f = vi.fn(async () => ({ ok: true, json: async () => ({ steps }) }));
  vi.stubGlobal("fetch", f);
  expect(await startNodule("c1", { z: 10, y: 100, x: 100 })).toBe(steps[0].outline);
  await expect(startNodule("c1", { z: 10, y: 300, x: 300 })).rejects.toThrow(FAR);
  expect(await getSteps("c1")).toBe(await getSteps("c1"));
  expect(f).toHaveBeenCalledTimes(1);
});
