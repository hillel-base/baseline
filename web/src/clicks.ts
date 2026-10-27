import { ENGINE_STOPPED, NO_LONGER_OPEN, PRACTICE_STOPPED, type Outline } from "./api";

/** The correction mode: Add or Remove clicks, a brush that paints or erases on the shown slice, or Axes (drag an axis end on the largest slice). */
export type Mode = "add" | "remove" | "paint" | "erase" | "axes";
export const BRUSH_MIN = 1, BRUSH_MAX = 15; // brush radius in image pixels, as the engine allows

/** No axis, or under 0.01 mL: nothing to measure or record. */
export const isEmpty = (o: Outline) => o.axis_z === null || o.volume_ml < 0.01;

/** What a click on the image does: no (or an empty) outline means a new nodule; otherwise a correction, - with the Remove mode or Shift.
 *  null: no model click (Paint, Erase and Axes edit by hand, so a stray click there never reaches the model). */
export function clickKind(outline: Outline | undefined, mode: Mode, shift: boolean, recorded = false): "start" | "add" | "remove" | null {
  if (!outline || recorded || isEmpty(outline)) return "start"; // a recorded nodule is final, so a click starts a new one
  if (mode !== "add" && mode !== "remove") return null;
  return mode === "remove" || shift ? "remove" : "add";
}

/** True when the error means the engine no longer holds our nodule, so the page must forget its outline and the next click starts. */
export const dropsNodule = (message: string) => message === ENGINE_STOPPED || message === PRACTICE_STOPPED || message === NO_LONGER_OPEN;
