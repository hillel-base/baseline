import { zOfImage } from "./image";
import type { RecordedNodule } from "./record";

type Vox = { z: number; y: number; x: number };

/** On a patient's `retest` scan, the recorded rows of the same patient's `test` scan; none on any other scan. Rows migrated from v1 have no first click to map. */
export const earlierRows = (rows: RecordedNodule[], patient: string, series: string) =>
  series === "retest" ? rows.filter((r) => r.patient === patient && r.series === "test" && r.click_image !== null) : [];

/** The row's first click as a voxel of its own scan: the image number back to z (z + 1 when the scan has no image numbers). */
export const firstClick = (r: RecordedNodule, inst: number[] | null): Vox =>
  ({ z: inst ? zOfImage(r.click_image!, inst) : r.click_image! - 1, y: r.click_y!, x: r.click_x! });

/** Millimetres between two voxels of one scan, to 0.1 mm; spacing is [x, y, z] as ScanMeta gives it. */
export const distanceMm = (a: Vox, b: Vox, [sx, sy, sz]: number[]) =>
  Math.round(Math.hypot((a.x - b.x) * sx, (a.y - b.y) * sy, (a.z - b.z) * sz) * 10) / 10;
