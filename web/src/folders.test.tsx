import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { FolderPanel } from "./FolderPanel";
import { canUse, crumbs, enter, readsLine } from "./folders";

test("enter joins below the root and below a folder", () => {
  expect(enter("", "study")).toBe("study");
  expect(enter("study", "ct")).toBe("study/ct");
});

test("(a) the breadcrumb: Top folder, then each part of the path with the path up to it", () => {
  expect(crumbs("")).toEqual([{ name: "Top folder", path: "" }]);
  expect(crumbs("made-up/Doe Jane")).toEqual([{ name: "Top folder", path: "" }, { name: "made-up", path: "made-up" }, { name: "Doe Jane", path: "made-up/Doe Jane" }]);
});

test("(a) what Use this folder reads, with no count (the engine reads only the axial CT among a folder's series); at the top, the next step (the engine refuses the top itself)", () => {
  const f = (series: number, folders: number, parent: string | null = "x") => ({ series: Array(series).fill({}), folders: Array(folders).fill("a"), parent });
  expect(readsLine(f(0, 2, null))).toBe("Open the study's folder in the list.");
  expect(readsLine(f(4, 0))).toBe("Reads the CT series here and in its subfolders.");
  expect(readsLine(f(1, 3))).toBe("Reads the CT series here and in its subfolders.");
  expect(readsLine(f(0, 2))).toBe("Reads the CT series in its subfolders.");
  expect(readsLine(f(0, 0))).toBe("This folder is empty. Go back up, or type a path.");
});

test("(a) Use this folder is offered only below the top folder (the engine refuses the top itself), and only once the folder is listed", () => {
  expect(canUse(undefined)).toBe(false);
  expect(canUse({ parent: null })).toBe(false);
  expect(canUse({ parent: "" })).toBe(true); // a folder just inside the top
  expect(canUse({ parent: "made-up" })).toBe(true);
});

test("(a) the folder view: its title and what to pick, Type a path, Cancel, and Use this folder (off until the folder is listed)", () => {
  const h = renderToString(<FolderPanel onChosen={() => {}} onClose={() => {}} />);
  expect(h).toMatch(/<section[^>]*aria-labelledby="pp-fold-h"[^>]*><header class="pp-fold-head"><h2 id="pp-fold-h">Choose the study folder<\/h2><p>The folder that holds the study&#x27;s CT scans. Subfolders are read too.<\/p>/);
  expect(h).toMatch(/<button[^>]*class="m-link"[^>]*>Type a path<\/button>/);
  expect(h).toMatch(/<button class="m-btn sm ghost"[^>]*>Cancel<\/button><button class="m-btn sm primary" disabled="">Use this folder<\/button>/);
  for (const old of ["Choose this folder", ">Up<", ">Close<", "#888"]) expect(h).not.toContain(old);
});
