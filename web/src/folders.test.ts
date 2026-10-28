import { expect, test } from "vitest";
import { enter } from "./folders";

test("enter joins below the root and below a folder", () => {
  expect(enter("", "study")).toBe("study");
  expect(enter("study", "ct")).toBe("study/ct");
});
