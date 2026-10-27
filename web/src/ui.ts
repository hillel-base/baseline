import type { RecordedNodule } from "./record";

const LETTERS = new Set(["a", "r", "s", "u", "g", "n", "m", "?", "p", "e", "x", "t", "[", "]"]);
type Key = Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey"> & { target: EventTarget | null };

/** The Measure key a keydown means ("a", "r", "s", "u", "g", "n", "m", "?", "p", "e", "x", "t", "[", "]" or "enter"), or null. Not while typing in a field or in an open dialog, never on a held key.
 *  Enter on a focused button or link is that control's own Enter; Enter does nothing while a row's "Delete row? Confirm" is armed. */
export function keyFor(e: Key, deleteArmed = false): string | null {
  const k = e.key === "Enter" ? "enter" : e.key.toLowerCase();
  if ((k !== "enter" && !LETTERS.has(k)) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return null;
  const t = e.target as Element | null;
  if (t?.closest?.("select, textarea, dialog, input:not([type=range])")) return null;
  if (k === "enter" && (deleteArmed || t?.closest?.("button, a"))) return null;
  return k;
}

/** The working status line: a click takes about 20 s on the standard-PC mode (the engine on the CPU), about 2 s on a graphics chip or when the device is not known. */
export const workingText = (device?: string) => (device === "cpu" ? "Outlining… about 20 s (standard-PC mode)" : "Outlining… about 2 s");

export const ARM_MS = 3000, UNDO_MS = 8000;
export type Armed = { file: string; at: number };
/** A press on a row's Delete: the second press on the same row within ARM_MS deletes, any other press (re)arms. */
export const deletePress = (armed: Armed | undefined, file: string, now: number) => (armed?.file === file && now - armed.at < ARM_MS ? "delete" : "arm");

/** The deleted row back at its old index (or the end), unless the table already holds it. */
export const restoreRow = (rows: RecordedNodule[], row: RecordedNodule, index: number) =>
  rows.some((r) => r.outline_file === row.outline_file) ? rows : [...rows.slice(0, index), row, ...rows.slice(index)];

/** The recorded-nodules drawer: its default height (bar, header and about 3 rows) and its smallest, in px. */
export const DRAWER_H = 220, DRAWER_MIN = 120;
/** A dragged drawer height, kept between DRAWER_MIN and what leaves the image at least 240 px of the viewer column. */
export const clampDrawer = (h: number, viewer: number) => Math.round(Math.max(DRAWER_MIN, Math.min(h, viewer - 240)));
