import type { Candidate } from "./api";

/** The suggestions as the page shows them: in the finder's order of confidence (the engine sends them so; this keeps it true), numbered in that order.
 *  off: marked "Not a nodule" (Undo takes it back). The score stays out of the page; only the events carry it. */
export const ranked = (list: Candidate[]) => [...list].sort((a, b) => b.score - a.score).map((c, i) => ({ ...c, rank: i + 1, off: false }));
// files: the outline_files of the Records that hold this suggestion (started by its Measure, or an outline the engine found its voxel in);
// measured: the nodule number of the first of those rows still in the table
export type Ranked = ReturnType<typeof ranked>[number] & { files?: string[]; measured?: number };
/** The list with each suggestion's measured state, read from the table: Undo of the Record (or Delete row) takes the row out, so the suggestion comes back. */
export const withMeasured = (list: Ranked[] | undefined, rows: { outline_file: string; nodule: number }[]) =>
  list?.map((c) => ({ ...c, measured: c.files?.map((f) => rows.find((r) => r.outline_file === f)?.nodule).find((n) => n !== undefined) }));
/** The finder's request for one scan: no list yet while it runs, or its error. */
export type Finds = { scan: string; list?: Ranked[]; error?: string };

// The finder list's texts.
export const MODEL_LINE = "Finder: YOLO11n, 2.5D (Chou et al., 2026)";
export const LICENCE = "The finder is its own program under AGPL-3.0; its weights are under CC BY 4.0. Its source code:";
/** A page that runs the finder (the practice servers too) links its AGPL source. The repository root, which always exists; the text names the folder. */
export const FINDER_SOURCE = "https://github.com/hillel-base/baseline";
export const HOLD = "Record this nodule or start a new one to measure another."; // as the follow-up's Find says: Measure never drops an open outline
export const NOTE = "Suggestions, not findings. It can miss nodules larger than about 3 cm. Read the whole scan as usual.";
export const NONE = "No suggestions on this scan. Read it as usual.";
export const ACCURACY = [
  "In our tests on 50 public screening scans, it found about 7 in 10 nodules that radiologists marked: about half of those under 6 mm, and about 8 in 10 from 6 mm up.",
  "It made about 2 extra marks per scan.",
  "It learned from nodules up to about 30 mm, so it can miss large tumours: it marked 10 of 15 tumours of 40 mm or more.",
  "The list is in order of the finder's confidence.",
];
export const SOURCES = "Sources: our tests on LIDC-annot-NLST501 (Renoust et al. 2026), NLST and RIDER images (TCIA). Finder: Chou et al., Diagnostics 2026. Full credits in About.";

// shortcut: the gap is a share of the slice bar, not pixels (about 19 px at 1440 x 900); measure the bar if labels still touch on small windows
const TICK_GAP = 0.03;
/** The slice-bar ticks: suggestions on nearby images (`f`, 0 at the top to 1) share one tick, labelled with all their numbers, e.g. "2·4". A group is measured from its first tick. */
export function tickGroups(ticks: { rank: number; f: number; off: boolean }[]) {
  const out: { f: number; ranks: number[]; off: boolean[] }[] = [];
  for (const t of [...ticks].sort((a, b) => a.f - b.f || a.rank - b.rank)) {
    const g = out.at(-1);
    if (g && t.f - g.f < TICK_GAP) { g.ranks.push(t.rank); g.off.push(t.off); } else out.push({ f: t.f, ranks: [t.rank], off: [t.off] });
  }
  for (const g of out) { // the numbers in list order: "2·4", whichever image is higher
    const order = g.ranks.map((_, i) => i).sort((a, b) => g.ranks[a] - g.ranks[b]);
    [g.ranks, g.off] = [order.map((i) => g.ranks[i]), order.map((i) => g.off[i])];
  }
  return out;
}
