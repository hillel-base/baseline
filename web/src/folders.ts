import type { FolderSeries } from "./api";

/** The path of subfolder `name` inside `path` (both relative to the engine's browse root). */
export const enter = (path: string, name: string) => (path ? `${path}/${name}` : name);

/** One line per series in the folder panel. */
export const seriesLabel = (s: FolderSeries) =>
  `${s.description || "(no description)"}, ${s.images} ${s.images === 1 ? "image" : "images"}`;
