import indexHtml from "../index.html?raw";
import { renderToString } from "react-dom/server";
import { App } from "./App";
import { expect, test } from "vitest";
import { About } from "./About";
import type { Outline } from "./api";
import { Panel } from "./Panel";

const none = { onGoToAxisSlice() {}, onNew() {}, instanceNumbers: null };
const text = (html: string) => html.replace(/<[^>]*>/g, "").replaceAll("&#x27;", "'"); // what the page reads
const empty: Outline = {
  nodule: 1, scan: "s", can_undo: true, clicks: [], at_window_edge: false, bbox: null, mask: null, volume_ml: 0, long_mm: 0, short_mm: 0,
  axis_z: null, long_line: null, short_line: null, seconds: 1, depth_mm: 0, width_method: "edge to edge",
};

test("an empty outline says so and shows no NaN", () => {
  const html = renderToString(<Panel outline={empty} pending={false} {...none} />);
  expect(html).toContain("No outline here. Click the nodule again.");
  expect(html).not.toContain("NaN");
});
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*aria-label="${label.replace(/[()?[\]]/g, "\\$&")}"[^>]*>`))?.[0];
test("the correction tools work with any outline, including an empty one, and not without one", () => {
  expect(button(renderToString(<Panel outline={empty} pending={false} {...none} />), "Add (A)")).not.toContain("disabled");
  expect(button(renderToString(<Panel pending={false} {...none} />), "Add (A)")).toContain("disabled");
  expect(button(renderToString(<Panel pending={false} {...none} />), "Undo (U)")).toContain("disabled");
});
test("Start over (S) works with an unrecorded outline, is gone when recorded and disabled without one", () => {
  expect(button(renderToString(<Panel outline={empty} pending={false} {...none} />), "Start over (S)")).not.toContain("disabled");
  expect(renderToString(<Panel outline={empty} pending={false} recorded={1} {...none} />)).not.toContain("Start over");
  expect(button(renderToString(<Panel pending={false} {...none} />), "Start over (S)")).toContain("disabled");
});
test("pending shows Outlining… about 2 s, a pending Record shows Recording…", () => {
  expect(text(renderToString(<Panel pending {...none} />))).toContain("Outlining… about 2 s");
  expect(text(renderToString(<Panel pending="outline" {...none} />))).toContain("Outlining… about 2 s");
  expect(text(renderToString(<Panel pending="outline" device="cpu" {...none} />))).toContain("Outlining… about 20 s (standard-PC mode)");
  expect(text(renderToString(<Panel pending="outline" device="mps" {...none} />))).toContain("Outlining… about 2 s");
  expect(text(renderToString(<Panel pending="edit" device="cpu" {...none} />))).toContain("Updating the outline…"); // a stroke or hand-set axes: no model, so no 20 s
  const rec = text(renderToString(<Panel pending="record" outline={{ ...empty, axis_z: 3, volume_ml: 6.6 }} {...none} />));
  expect(rec).toContain("Recording…");
  expect(rec).not.toContain("Outlining");
});
test("every control shows its key", () => {
  const o = { ...empty, axis_z: 3, volume_ml: 6.6, bbox: [3, 0, 0, 4, 1, 1] };
  const html = renderToString(<Panel outline={o} pending={false} onKeys={() => {}} {...none} />) + renderToString(<Panel outline={o} pending={false} mode="paint" brush={3} {...none} />);
  for (const [label, key] of [["Add (A)", "A"], ["Remove (R)", "R"], ["Paint (P)", "P"], ["Erase (E)", "E"], ["Axes (X)", "X"], ["Undo (U)", "U"], ["Start over (S)", "S"], ["Go to largest slice (G)", "G"], ["Record nodule (Enter)", "Enter"], ["New nodule (N)", "N"],
    ["Smaller brush ([)", "["], ["Larger brush (])", "]"], ["Snap to tissue (T)", "T"]])
    expect(html).toMatch(new RegExp(`aria-label="${label.replace(/[()[\]]/g, "\\$&")}" data-key="${key.toLowerCase().replace(/[[\]]/g, "\\$&")}"[^>]*>[^<]*<kbd class="k[^"]*">${key.replace(/[[\]]/g, "\\$&")}</kbd>`));
  expect(html).toContain('data-key="?"');
});
test("Paint and Erase show the brush size and Snap in place of the Shift hint; the size stops at 1 and 15 px; Snap is for Paint only", () => {
  const ui = (more: Partial<Parameters<typeof Panel>[0]>) => renderToString(<Panel outline={measured} pending={false} brush={3} {...none} {...more} />);
  expect(text(ui({ mode: "paint" }))).toContain("Brush 3 px");
  expect(text(ui({ mode: "paint" }))).not.toContain("Hold Shift");
  expect(button(ui({ mode: "paint" }), "Paint (P)")).toContain('aria-pressed="true"');
  expect(button(ui({ mode: "paint" }), "Add (A)")).toContain('aria-pressed="false"');
  expect(button(ui({ mode: "paint", snap: true }), "Snap to tissue (T)")).toContain('aria-pressed="true"');
  expect(button(ui({ mode: "paint" }), "Snap to tissue (T)")).toMatch(/aria-pressed="false"(?![^>]*disabled)/);
  expect(button(ui({ mode: "erase" }), "Snap to tissue (T)")).toContain("disabled");
  expect(button(ui({ mode: "paint", brush: 1 }), "Smaller brush ([)")).toContain("disabled");
  expect(button(ui({ mode: "paint", brush: 1 }), "Larger brush (])")).not.toContain("disabled");
  expect(button(ui({ mode: "paint", brush: 15 }), "Larger brush (])")).toContain("disabled");
  expect(text(ui({ mode: "add" }))).toContain("Hold Shift");
  // outside Paint and Erase the brush row keeps its room, hidden, and its keys do nothing
  expect(ui({ mode: "add" })).toContain('class="m-row m-brush" style="visibility:hidden"');
  for (const b of ["Smaller brush ([)", "Larger brush (])", "Snap to tissue (T)"]) expect(button(ui({ mode: "add" }), b)).toContain("disabled");
  expect(ui({ mode: "paint" })).not.toContain("visibility:hidden");
  expect(button(renderToString(<Panel pending={false} {...none} />), "Paint (P)")).toContain("disabled"); // no outline yet: as Add and Remove
});
test("the modes sit in two labelled rows: Clicks (Add, Remove) and By hand (Paint, Erase, Axes)", () => {
  const html = renderToString(<Panel outline={measured} pending={false} {...none} />);
  const row = (label: string) => html.match(new RegExp(`role="group" aria-label="${label}">(.*?)</div></div>`))?.[1] ?? "";
  expect(text(row("Clicks"))).toBe("ClicksAddARemoveR");
  expect(text(row("By hand"))).toBe("By handPaintPEraseEAxesX");
});
test("Axes mode says how to set an axis by hand, in place of the Shift hint and the brush", () => {
  const html = renderToString(<Panel outline={measured} pending={false} mode="axes" {...none} />);
  expect(button(html, "Axes (X)")).toContain('aria-pressed="true"');
  expect(text(html)).toContain("Drag an end of an axis line on the largest slice.");
  expect(text(html)).not.toContain("Hold Shift");
  expect(html).toContain('class="m-row m-brush" style="visibility:hidden"'); // the brush row's room, not the brush
});
test("hand-set axes are marked in the numbers card", () => {
  expect(text(renderToString(<Panel outline={{ ...measured, axes_edited: true }} pending={false} {...none} />))).toContain("Axes set by hand");
  expect(text(renderToString(<Panel outline={measured} pending={false} {...none} />))).not.toContain("by hand");
});

// nothing below moves when the mode, the outline or a message changes. Heights are checked on the page (e2e); here, the structure that keeps them.
const bbox = (): Outline => ({ ...measured, bbox: [3, 0, 0, 4, 1, 1] }); // a function: measured is declared further down
test("the mode's options are one cell in every mode: the brush row always laid out, the hint on top of it; the Shift hint shows in a short panel too", () => {
  for (const mode of ["add", "remove", "paint", "erase", "axes"] as const) {
    const html = renderToString(<Panel outline={bbox()} pending={false} mode={mode} brush={3} {...none} />);
    expect(html.match(/class="m-opts"/g), mode).toHaveLength(1);
    expect(html.match(/class="m-row m-brush"/g), mode).toHaveLength(1);
    expect(html.indexOf('class="m-opts"'), mode).toBeLessThan(html.indexOf('aria-label="Undo (U)"'));
  }
  expect(renderToString(<Panel outline={bbox()} pending={false} mode="add" {...none} />)).toMatch(/<div class="small muted">Hold <kbd/); // not m-hint-tall: its row is kept anyway
});
test("hand-set axes take the widths line, not a new one; the status box says what a click does", () => {
  const html = text(renderToString(<Panel outline={{ ...bbox(), axes_edited: true }} pending={false} {...none} />));
  expect(html).toMatch(/top to bottom\)Axes set by handGo to largest slice/);
  expect(html).not.toContain("Widths measured");
  expect(html).toContain("Outline ready.Axes set by hand. A click or stroke measures them again. Not saved yet: Record saves this nodule to the table.");
  expect(text(renderToString(<Panel outline={bbox()} pending={false} {...none} />))).toMatch(/Widths measured edge to edgeGo to largest slice/);
});
test("a notice sits above the status box, so it never moves the box or its buttons", () => {
  const html = renderToString(<Panel outline={measured} pending={false} recorded={1} onCopy={() => {}} notice="Copy failed. Select the row and copy it by hand." {...none} />);
  expect(html.indexOf("Copy failed.")).toBeLessThan(html.indexOf("Recorded as nodule 1."));
  expect(html.indexOf("Recorded as nodule 1.")).toBeLessThan(html.indexOf(">Copy row<"));
});
test("an error shows its message", () => {
  expect(renderToString(<Panel pending={false} error="That click is outside the working box." {...none} />)).toContain("That click is outside the working box.");
});
test("a measured outline shows volume and both axes", () => {
  const html = text(renderToString(<Panel outline={{ ...empty, axis_z: 3, volume_ml: 6.6, long_mm: 21.44, short_mm: 10.9 }} pending={false} {...none} />));
  expect(html).toContain("Volume 6.60 mL");
  expect(html).toContain("Long axis 21.4 mm");
  expect(html).toContain("Short axis 10.9 mm");
});
test("an outline at the window edge shows the warning, a central one does not", () => {
  const o = { ...empty, axis_z: 3, volume_ml: 6.6, long_mm: 21.4, short_mm: 10.9 };
  const warn = "The outline reaches the edge of the model&#x27;s window. Check it, and if it is cut, click beyond the edge with Add.";
  expect(renderToString(<Panel outline={{ ...o, at_window_edge: true }} pending={false} {...none} />)).toContain(warn);
  expect(text(renderToString(<Panel outline={o} pending={false} {...none} />))).toContain("Outline ready.");
  expect(renderToString(<Panel outline={o} pending={false} {...none} />)).not.toContain("edge of the model");
});
test("a tiny outline says there is no outline", () => {
  const html = text(renderToString(<Panel outline={{ ...empty, axis_z: 3, volume_ml: 0.004, long_mm: 2, short_mm: 1 }} pending={false} {...none} />));
  expect(html).toContain("No outline here. Click the nodule again.");
  expect(html).toContain("Volume — mL"); // no number
});
test("the panel states the image range and depth, or the slice range without image numbers", () => {
  const o = { ...empty, axis_z: 150, volume_ml: 6.6, long_mm: 21.4, short_mm: 10.9, depth_mm: 72.5 };
  const inst = Array.from({ length: 265 }, (_, z) => 265 - z);
  const text = (b: number[], n: number[] | null) =>
    renderToString(<Panel outline={{ ...o, bbox: [b[0], 0, 0, b[1], 1, 1] }} pending={false} {...none} instanceNumbers={n} />);
  expect(text([122, 180], inst)).toContain("On Images 86–143 (72.5 mm top to bottom)");
  expect(text([161, 162], inst)).toContain("On Image 104 (72.5 mm top to bottom)");
  expect(text([2, 7], null)).toContain("On slices 3–7 (72.5 mm top to bottom)");
  expect(text([2, 3], null)).toContain("On slice 3 (72.5 mm top to bottom)");
});
test("the pressed mode button says so, and Undo is disabled when there is nothing to undo", () => {
  const html = renderToString(<Panel outline={{ ...empty, can_undo: false }} pending={false} {...none} mode="remove" />);
  expect(button(html, "Remove (R)")).toContain('aria-pressed="true"');
  expect(button(html, "Add (A)")).toContain('aria-pressed="false"');
  expect(button(html, "Undo (U)")).toContain("disabled");
});
const measured = { ...empty, axis_z: 3, volume_ml: 6.6, long_mm: 21.4, short_mm: 10.9 };
test("Record nodule is disabled for no result, pending and an empty outline, and enabled for a measured one", () => {
  const rec = (o: Outline, pending = false) => button(renderToString(<Panel outline={o} pending={pending} {...none} />), "Record nodule (Enter)");
  expect(rec(empty)).toContain("disabled");
  expect(rec(measured, true)).toContain("disabled");
  expect(rec(measured)).not.toContain("disabled");
});
test("a recorded nodule says so, hides the correction tools, and New nodule becomes the one primary button", () => {
  const html = renderToString(<Panel outline={measured} pending={false} recorded={2} onCopy={() => {}} onScreenshot={() => {}} {...none} />);
  expect(text(html)).toContain("Recorded as nodule 2.");
  expect(text(html)).toMatch(/Recorded as nodule 2\.\s*Copy row\s*Save screenshot/); // the run sheet's order, one click each, the table open or folded
  expect(html).not.toContain("Undo");
  expect(html).not.toContain("Add (A)");
  expect(html).toContain("Save screenshot");
  expect(html).not.toContain("Record nodule");
  expect(button(html, "New nodule (N)")).toMatch(/class="m-btn primary wide"/);
  expect((html.match(/m-btn primary/g) ?? []).length).toBe(1);
});
test("before Record the panel says the outline is not saved yet; after Record the green box offers Undo and names the row it replaces", () => {
  expect(text(renderToString(<Panel outline={measured} pending={false} nodule={1} {...none} />))).toContain("Not saved yet");
  const html = renderToString(<Panel outline={measured} pending={false} recorded={1} nodule={1} onCopy={() => {}} onScreenshot={() => {}} onUndoRecord={() => {}}
    save={{ state: "saved", replaces: "This replaces nodule 1 recorded at 14:02." }} {...none} />);
  // the lines that arrive with the save sit above the actions, so the buttons never move
  expect(text(html)).toMatch(/Recorded as nodule 1\.\s*Saved to the study table\.\s*This replaces nodule 1 recorded at 14:02\.\s*Copy row\s*Save screenshot\s*Undo\s*New nodule/);
  expect(button(html, "Undo this Record")).not.toContain("data-key"); // no key: a stray U never takes a Record back
  expect(text(html)).not.toContain("Not saved yet");
  expect(text(renderToString(<Panel outline={measured} pending={false} recorded={1} {...none} />))).not.toMatch(/Undo|replaces|study table/);
  expect(text(renderToString(<Panel outline={measured} pending={false} recorded={1} save={{ state: "saving" }} {...none} />))).toContain("Saving to the study table…");
  expect(text(renderToString(<Panel outline={measured} pending={false} {...none} />))).toContain("Not saved yet: Record saves this nodule to the table.");
});
test("a save that failed is one amber box in plain words, with the Record's actions and no error text", () => {
  const html = renderToString(<Panel outline={measured} pending={false} recorded={1} nodule={1} onCopy={() => {}} onScreenshot={() => {}} onUndoRecord={() => {}} save={{ state: "waiting" }} {...none} />);
  expect(html.match(/class="m-status[^"]*"/g)).toEqual(['class="m-status ok warn"']);
  expect(text(html)).toMatch(/Recorded on this computer\. Not saved to the study table yet; trying again every 15 s\.\s*Copy row\s*Save screenshot\s*Undo/);
  expect(text(html)).not.toMatch(/Recorded as nodule|Saved to the study table|Saving/);
  const old = text(renderToString(<Panel outline={measured} pending={false} recorded={1} save={{ state: "waiting", note: "The study table needs an update by its admin before this can be saved. Nothing was written." }} {...none} />));
  expect(old).toContain("trying again every 15 s.The study table needs an update by its admin");
});
test("before recording, Record nodule is the one primary button", () => {
  const html = renderToString(<Panel outline={measured} pending={false} {...none} />);
  expect(button(html, "Record nodule (Enter)")).toMatch(/class="m-btn primary wide"/);
  expect((html.match(/m-btn primary/g) ?? []).length).toBe(1);
});
test("the header shows the Baseline logo, named for a screen reader; the tab says Baseline, with the Baseline icon", () => {
  const html = renderToString(<App />);
  expect(html).toMatch(/<img class="logo" src="[^"]*lockup-dark[^"]*\.svg" alt="Baseline, lung nodule measurement on CT"\/>/);
  expect(html).not.toContain("Lung nodule measurement");
  const index = indexHtml;
  expect(index).toContain("<title>Baseline</title>");
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/src/assets/favicon.svg" />');
});
test("About names the licence and credit", () => {
  const html = renderToString(<About />);
  expect(html).toContain("CC BY-NC-SA 4.0 (non-commercial)");
  expect(html).toContain("arXiv:2503.08373");
  expect(html).toContain("Research use only. Not a medical device.");
});

import { Earlier } from "./Panel";
import type { RecordedNodule } from "./record";
test("finding, the proposal and its outside warning take the one status line; an error still wins", () => {
  expect(text(renderToString(<Panel pending="find" finding="Finding N1 on this scan… about 15 s the first time" {...none} />))).toContain("Finding N1 on this scan… about 15 s the first time");
  expect(text(renderToString(<Panel pending="find" finding="x" nodule={1} {...none} />))).toContain("Finding");
  const p = { text: "N1? Check here.", hint: "Measure here (M) outlines it at the ring." };
  const shown = text(renderToString(<Panel pending={false} proposal={p} {...none} />));
  expect(shown).toContain("N1? Check here.");
  expect(shown).not.toContain("Click a nodule to outline it.");
  expect(text(renderToString(<Panel pending={false} proposal={p} outline={measured} recorded={1} {...none} />))).not.toContain("Recorded as nodule 1.");
  const out = renderToString(<Panel pending={false} proposal={{ text: "N1 maps outside this scan. Find it by hand.", warn: true }} {...none} />);
  expect(out).toMatch(/m-status warn[^>]*>.*N1 maps outside this scan\. Find it by hand\./);
  expect(text(renderToString(<Panel pending={false} proposal={p} error="No outline here: that point is air." {...none} />))).not.toContain("N1? Check here.");
  expect(renderToString(<Panel pending={false} {...none} />)).not.toContain("Earlier nodules"); // nothing extra without the follow-up section
});
const row = (nodule: number, slice: number) => ({ nodule, slice, slice_label: "image", series: "test", outline_file: `f${nodule}` }) as RecordedNodule;
test("Earlier nodules: one line per earlier row with Find; Measure here (M) only beside the proposed one", () => {
  const ui = (more: Partial<Parameters<typeof Earlier>[0]> = {}) =>
    renderToString(<Earlier rows={[row(1, 112), row(2, 90)]} busy={false} open={false} onFind={() => {}} onMeasure={() => {}} {...more} />);
  expect(text(ui())).toContain("Earlier nodulesfrom the Baseline"); // the page's own word for the scan (study.ts), never "test"
  expect(ui()).toMatch(/<h3 class="m-sub">Earlier nodules<\/h3>/); // a heading, as strong as the page's other section headings
  expect(text(ui())).toContain("N1 · Image 112Find");
  expect(text(ui())).toContain("N2 · Image 90Find");
  expect(text(ui())).not.toMatch(/\btest\b/);
  expect(ui()).toContain('<span class="m-earlier-t">N1 · Image 112</span>'); // one line: it cuts with an ellipsis, never wraps (measure.css)
  expect(button(ui(), "Find N1")).not.toContain("disabled");
  expect(ui()).not.toContain("Measure here");
  const html = ui({ proposed: "f2" });
  expect(html.match(/Measure here/g)).toHaveLength(2); // its label and its text, once
  expect(html).toMatch(/aria-label="Measure here \(M\)" data-key="m"[^>]*>Measure here<kbd class="k k-on">M<\/kbd>/);
  expect(html.indexOf("N2 · Image 90")).toBeLessThan(html.indexOf("Measure here")); // on N2's line
  for (const more of [{ busy: true }, { open: true }]) {
    expect(button(ui({ proposed: "f2", ...more }), "Measure here (M)")).toContain("disabled");
    expect(button(ui({ proposed: "f2", ...more }), "Find N1")).toContain("disabled");
  }
  expect(text(ui({ open: true }))).toContain("Record this nodule or start a new one to find another.");
  expect(ui()).toContain('style="visibility:hidden">Record this nodule'); // hidden, its room kept, so the card under the list never moves
  expect(ui({ open: true })).not.toContain("visibility:hidden");
  expect(text(renderToString(<Earlier rows={[{ ...row(1, 7), slice_label: "slice index" }]} busy={false} open={false} onFind={() => {}} onMeasure={() => {}} />))).toContain("N1 · Slice index 7");
});

test("the Shortcuts list names Alt+← and Alt+→ (the Patients panel), only where the Patients button shows", () => {
  expect(text(renderToString(<App />))).toContain("Alt+← Alt+→The patient's previous or next scan (beside the Patients button)");
  expect(text(renderToString(<App embedded panel={false} />))).not.toContain("previous or next scan"); // the hosted page with the local engine: the drop-down, no steps
});
