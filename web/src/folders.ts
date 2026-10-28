import type { Folder } from "./api";

/** The path of subfolder `name` inside `path` (both relative to the engine's browse root). */
export const enter = (path: string, name: string) => (path ? `${path}/${name}` : name);
/** The folder view's breadcrumb: the browse root, then each part of `path` with the path up to it. */
export const crumbs = (path: string) => [{ name: "Top folder", path: "" }, ...path.split("/").filter(Boolean).map((name, i, all) => ({ name, path: all.slice(0, i + 1).join("/") }))];
/** Use this folder is offered once the folder is listed and below the top folder, which the engine refuses: the page never offers an error it can prevent. */
export const canUse = (f: Pick<Folder, "parent"> | undefined) => !!f && f.parent !== null;
/** What Use this folder reads, with no count: GET /api/folders lists every series directly in the folder, and the engine keeps only the axial CT
 *  among them, also in its subfolders. The top (the browse root, parent null) is refused by the engine: the line gives the next step. */
export const readsLine = ({ series, folders, parent }: Pick<Folder, "series" | "folders" | "parent">) =>
  parent === null ? "Open the study's folder in the list." : series.length ? "Reads the CT series here and in its subfolders."
    : folders.length ? "Reads the CT series in its subfolders." : "This folder is empty. Go back up, or type a path.";
