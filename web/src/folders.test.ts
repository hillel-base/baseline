import { expect, test } from "vitest";
import { enter, seriesLabel } from "./folders";

test("enter joins below the root and below a folder", () => {
  expect(enter("", "study")).toBe("study");
  expect(enter("study", "ct")).toBe("study/ct");
});

test("series label shows description and image count", () => {
  expect(seriesLabel({ uid_hash: "a", description: "Chest 1.25", images: 8 })).toBe("Chest 1.25, 8 images");
  expect(seriesLabel({ uid_hash: "a", description: "", images: 1 })).toBe("(no description), 1 image");
});
