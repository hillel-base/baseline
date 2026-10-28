import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { About } from "./About";
import { Copilot, Suggestions } from "./Copilot";
import { HOLD, LICENCE, ranked, tickGroups, withMeasured } from "./list";

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").trim();
const c = (score: number, image: number, z = 1) => ({ z, y: 2, x: 3, score, image });
const no = () => {};
const btn = { z: 0, busy: false, onFind: no, onGo: no, onMeasure: no, onToggle: no };
const pop = { busy: false, how: false, onHow: no, onClose: no, onGo: no, onMeasure: no, onToggle: no };

test("the list is in the finder's order of confidence, numbered in that order, none marked off", () => {
  const r = ranked([c(0.5, 7), c(0.81, 104), c(0.6, 9)]);
  expect(r.map((x) => [x.rank, x.image, x.off])).toEqual([[1, 104, false], [2, 9, false], [3, 7, false]]);
});

test("one button over the image, in each of its states", () => {
  expect(text(renderToString(<Copilot {...btn} />))).toBe("Find nodules");
  const running = renderToString(<Copilot {...btn} finds={{ scan: "s" }} />);
  expect(text(running)).toBe("Looking… up to 30 s");
  expect(running).toMatch(/<button[^>]*disabled/);
  const found = renderToString(<Copilot {...btn} finds={{ scan: "s", list: ranked([c(0.9, 1), c(0.8, 2), c(0.7, 3)]) }} />);
  expect(text(found)).toBe("3 suggestions Suggestions 3 ▾"); // a screen reader hears the count once, from the status line
  expect(found).toMatch(/<span role="status" class="sr-only">3 suggestions<\/span>/);
  expect(text(renderToString(<Copilot {...btn} finds={{ scan: "s", list: [] }} />))).toBe("No suggestions No suggestions");
  const failed = renderToString(<Copilot {...btn} finds={{ scan: "s", error: "The finder did not run." }} />);
  expect(text(failed)).toBe("The finder did not run. Find nodules");
  expect(failed).toContain('role="alert"');
});

test("the drop-down: its title, the model line, a close button, one row per suggestion, the note and How accurate?", () => {
  const list = ranked([c(0.9, 104, 5), c(0.6, 165, 8), c(0.5, 212, 9)]);
  list[2] = { ...list[2], off: true };
  const html = renderToString(<Suggestions {...pop} list={list} z={5} />);
  const t = text(html);
  expect(t).toContain("Suggestions to check Finder: YOLO11n, 2.5D (Chou et al., 2026)");
  expect(html).toMatch(/<button[^>]*title="Close \(Esc\)"[^>]*aria-label="Close"|<button[^>]*aria-label="Close"[^>]*title="Close \(Esc\)"/);
  expect(t).toContain("1 Image 104 You are here Measure Not a nodule");
  expect(t).toContain("2 Image 165 Go to it Measure Not a nodule");
  expect(t).toContain("3 Image 212 Marked not a nodule Undo");
  expect(t).toContain("Suggestions, not findings. It can miss nodules larger than about 3 cm. Read the whole scan as usual. How accurate?");
  expect(t).not.toContain("How accurate is the finder?");
  expect(t).not.toMatch(/score|0\.9|0\.6|0\.5/); // no raw score anywhere
});

test("How accurate? opens inside the list: 7 in 10, 2 extra marks, large tumours, the order, the sources", () => {
  const html = renderToString(<Suggestions {...pop} how list={ranked([c(0.9, 1)])} z={0} />), t = text(html);
  for (const s of ["How accurate is the finder?",
    "In our tests on 50 public screening scans, it found about 7 in 10 nodules that radiologists marked: about half of those under 6 mm, and about 8 in 10 from 6 mm up.",
    "It made about 2 extra marks per scan.",
    "It learned from nodules up to about 30 mm, so it can miss large tumours: it marked 10 of 15 tumours of 40 mm or more.",
    "The list is in order of the finder's confidence.",
    "Sources: our tests on LIDC-annot-NLST501 (Renoust et al. 2026), NLST and RIDER images (TCIA). Finder: Chou et al., Diagnostics 2026. Full credits in About.",
    LICENCE]) expect(t).toContain(s);
  expect(LICENCE).toBe("The finder is its own program under AGPL-3.0; its weights are under CC BY 4.0. Its source code:"); // the licence is on screen, not in a tooltip
  expect(t).toContain("Its source code: github.com/hillel-base/baseline"); expect(t).toContain("the finder/ folder."); // and its source
  expect(html).toContain('href="https://github.com/hillel-base/baseline"');
});

test("with an open, unrecorded outline, Measure is off and the list says why; Not a nodule still works", () => {
  const html = renderToString(<Suggestions {...pop} busy hold={HOLD} list={ranked([c(0.9, 104, 5)])} z={5} />);
  expect(text(html)).toContain("Record this nodule or start a new one to measure another.");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Measure<\/button>/);
  expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Not a nodule<\/button>/);
});

test("a suggestion is measured while a Record that holds it is in the table: Undo of the Record (or Delete) brings the row back", () => {
  const [a, b, d] = ranked([c(0.9, 1), c(0.8, 2), c(0.7, 3)]);
  // files: the Records that hold the suggestion (its Measure, or a hand-clicked outline that contains its voxel)
  const list = [{ ...a, files: ["outlines/s_n1_accepted.nii.gz"] }, { ...b, files: ["outlines/s_n4_accepted.nii.gz", "outlines/s_n5_accepted.nii.gz"] }, { ...d, files: ["outlines/s_n2_accepted.nii.gz"] }];
  const rows = [{ outline_file: "outlines/s_n1_accepted.nii.gz", nodule: 3 }, { outline_file: "outlines/s_n5_accepted.nii.gz", nodule: 5 }]; // n2's and n4's Records were undone
  expect(withMeasured(list, rows)!.map((x) => x.measured)).toEqual([3, 5, undefined]);
  expect(withMeasured(undefined, rows)).toBeUndefined();
});

test("a measured row reads Measured · nodule N in green, with Measure and Not a nodule gone", () => {
  const [a, b] = ranked([c(0.9, 104, 5), c(0.6, 165, 8)]);
  const html = renderToString(<Suggestions {...pop} list={[{ ...a, measured: 3 }, b]} z={5} />);
  const first = html.match(/<li class="done">.*?<\/li>/)?.[0] ?? "";
  expect(text(first)).toBe("1 Image 104 Measured · nodule 3");
  expect(first).not.toMatch(/Measure<\/button>|Not a nodule/);
  expect(text(html)).toContain("2 Image 165 Go to it Measure Not a nodule");
});

test("ticks on nearby images become one tick, numbered like the rings", () => {
  const g = tickGroups([{ rank: 1, f: 0.4, off: false }, { rank: 2, f: 0.7, off: false }, { rank: 4, f: 0.71, off: true }, { rank: 3, f: 0.95, off: false }]);
  expect(g).toEqual([{ f: 0.4, ranks: [1], off: [false] }, { f: 0.7, ranks: [2, 4], off: [false, true] }, { f: 0.95, ranks: [3], off: [false] }]);
  expect(tickGroups([{ rank: 1, f: 0.5, off: false }, { rank: 2, f: 0.52, off: false }, { rank: 3, f: 0.54, off: false }]).map((t) => t.ranks)).toEqual([[1, 2], [3]]); // measured from a group's first tick: no endless chains
  expect(tickGroups([{ rank: 4, f: 0.6, off: true }, { rank: 2, f: 0.61, off: false }])).toEqual([{ f: 0.6, ranks: [2, 4], off: [false, true] }]); // list order inside a tick
  expect(tickGroups([])).toEqual([]);
});

test("no suggestions: the drop-down says so in place of the list", () => {
  expect(text(renderToString(<Suggestions {...pop} list={[]} z={0} />))).toContain("No suggestions on this scan. Read it as usual.");
});

test("About names the finder model and both licences", () => {
  const t = text(renderToString(<About />));
  expect(t).toContain("YOLO11n");
  expect(t).toMatch(/its own program under AGPL-3\.0/);
  expect(t).toMatch(/weights.*CC BY 4\.0/);
});
