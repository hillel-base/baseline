import { expect, test } from "vitest";
import { ARM_MS, DRAWER_H, DRAWER_MIN, clampDrawer, deletePress, keyFor, restoreRow, workingText } from "./ui";
import type { RecordedNodule } from "./record";

// A focused element that sits inside `inside` (for example "textarea" or "button"); closest() answers for selectors naming it.
const at = (inside?: string) => ({ closest: (sel: string) => (inside && sel.split(",").some((s) => s.trim() === inside) ? {} : null) }) as unknown as EventTarget;
const press = (key: string, more: Partial<Parameters<typeof keyFor>[0]> = {}) => keyFor({ key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: at(), ...more });

test("the Measure keys map to their controls, any case", () => {
  for (const k of ["a", "r", "s", "u", "g", "n", "m", "?", "p", "e", "x", "t", "[", "]"]) expect(press(k)).toBe(k); // m: Measure here on a follow-up scan; p, e, x: Paint, Erase, Axes; t: Snap to tissue; [ ]: brush size
  expect(press("P")).toBe("p");
  expect(press("[", { repeat: true })).toBeNull(); // a held key never steps the brush size
  expect(press("U")).toBe("u");
  expect(press("Enter")).toBe("enter");
  for (const k of ["q", "z", "f", "+", "ArrowUp", " "]) expect(press(k)).toBeNull(); // the viewer's own keys, or none
});
test("no key while held, with Ctrl, Cmd or Alt, in a field or in an open dialog", () => {
  expect(press("u", { repeat: true })).toBeNull();
  expect(press("Enter", { repeat: true })).toBeNull();
  for (const m of ["ctrlKey", "metaKey", "altKey"]) expect(press("n", { [m]: true })).toBeNull();
  for (const f of ["select", "textarea", "dialog"]) { expect(press("g", { target: at(f) })).toBeNull(); expect(press("Enter", { target: at(f) })).toBeNull(); }
});
test("Enter on a focused button or link stays that control's Enter; letters still work there", () => {
  expect(press("Enter", { target: at("button") })).toBeNull();
  expect(press("Enter", { target: at("a") })).toBeNull();
  expect(press("u", { target: at("button") })).toBe("u");
});

test("Enter does nothing while a Delete is armed; the letters still work", () => {
  expect(keyFor({ key: "Enter", repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: at() }, true)).toBeNull();
  expect(keyFor({ key: "n", repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: at() }, true)).toBe("n");
});

test("the working line says about 20 s only when the engine runs on the CPU", () => {
  expect(workingText("cpu")).toBe("Outlining… about 20 s (standard-PC mode)");
  for (const d of ["mps", "cuda", "unknown", undefined]) expect(workingText(d)).toBe("Outlining… about 2 s"); // undefined: /api/info failed or not read yet
});

test("Delete deletes only on a second press of the same row within 3 s", () => {
  expect(deletePress(undefined, "a", 0)).toBe("arm");
  expect(deletePress({ file: "a", at: 0 }, "a", ARM_MS - 1)).toBe("delete");
  expect(deletePress({ file: "a", at: 0 }, "a", ARM_MS)).toBe("arm"); // waited: no delete
  expect(deletePress({ file: "a", at: 0 }, "b", 10)).toBe("arm"); // another row
});

const r = (n: number) => ({ nodule: n, outline_file: `f${n}` }) as RecordedNodule;
test("Undo puts a deleted row back in its place, never twice", () => {
  expect(restoreRow([r(2), r(3)], r(1), 0).map((x) => x.nodule)).toEqual([1, 2, 3]);
  expect(restoreRow([r(1), r(3)], r(2), 1).map((x) => x.nodule)).toEqual([1, 2, 3]);
  expect(restoreRow([r(1)], r(2), 5).map((x) => x.nodule)).toEqual([1, 2]); // the table shrank meanwhile: at the end
  expect(restoreRow([r(1), r(2)], r(2), 0).map((x) => x.nodule)).toEqual([1, 2]);
});

test("clampDrawer keeps the drawer between its minimum and what leaves the image 240 px", () => {
  expect(clampDrawer(300, 800)).toBe(300);
  expect(clampDrawer(50, 800)).toBe(DRAWER_MIN);
  expect(clampDrawer(700, 800)).toBe(560);
  expect(clampDrawer(300, 300)).toBe(DRAWER_MIN); // a short window: the minimum wins
  expect(clampDrawer(212.6, 800)).toBe(213);
  expect(DRAWER_H).toBeGreaterThanOrEqual(DRAWER_MIN);
});
