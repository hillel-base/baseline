import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { App } from "./App";
import { BLOCKED, SCAN_CODE, countsOf, frameBox, fromFrame, fromPage, PatientsFrame } from "./PatientsFrame";
import { rememberScanId, type RecordedNodule } from "./record";
import { localFrame } from "./Shell";

const ENGINE = "http://localhost:8000";
const frame = {} as Window, other = {} as Window; // the frame's contentWindow, and any other window (the page's own, another frame)
const from = (data: unknown, origin = ENGINE, source: unknown = frame) => fromFrame({ origin, source: source as Window, data }, ENGINE, frame);

test("the parent takes a message only from the engine's exact origin and the frame's own window, with a code only", () => {
  expect(from({ type: "ready" })).toEqual({ type: "ready" });
  expect(from({ type: "size", open: true })).toEqual({ type: "size", open: true });
  expect(from({ type: "size", open: false })).toEqual({ type: "size", open: false });
  for (const scan of ["F-0a1b2c3d", "D-00ff12ab", "RIDER-1286684383_test", "RIDER-1286684383_retest"]) expect(from({ type: "open", scan })).toEqual({ type: "open", scan });
  for (const origin of ["https://lung-measure.base44.app", "http://127.0.0.1:8000", "http://localhost:8001", "http://localhost:8000/", "null", ""]) expect(from({ type: "ready" }, origin)).toBeNull();
  for (const source of [other, null]) expect(from({ type: "open", scan: "F-0a1b2c3d" }, ENGINE, source)).toBeNull(); // other: the page's own window (a forged post), another frame
  expect(fromFrame({ origin: ENGINE, source: null, data: { type: "ready" } }, ENGINE, null)).toBeNull(); // no frame yet: nothing matches
  for (const scan of ["Doe, Jane", "Jane_Doe_test", "F-0A1B2C3D", "F-0a1b2c3", "D-0a1b2c3d4", " F-0a1b2c3d", "RIDER-12866843_test", "RIDER-1286684383_ct", "", 7, null])
    expect(from({ type: "open", scan })).toBeNull(); // a name-shaped or malformed scan is ignored silently
  for (const data of [null, "ready", 1, { type: "size", open: "yes" }, { type: "size" }, { type: "current", scan: "F-0a1b2c3d" }, { type: "names", names: ["Doe, Jane"] }, {}])
    expect(from(data)).toBeNull();
  expect(from({ type: "open", scan: "F-0a1b2c3d", name: "Doe, Jane" })).toEqual({ type: "open", scan: "F-0a1b2c3d" }); // only the code is kept
  expect(SCAN_CODE.test("F-0a1b2c3d")).toBe(true);
});

test("size states: closed, the frame keeps the button's slot (CSS); open, it reaches from the slot's corner to the window's far corner, over the viewer", () => {
  expect(frameBox(false, { left: 16, top: 130 }, { width: 1440, height: 900 })).toBeUndefined();
  expect(frameBox(true, { left: 16, top: 130 }, { width: 1440, height: 900 })).toEqual({ width: 1424, height: 770 });
  expect(frameBox(true, { left: 16.4, top: 130.6 }, { width: 1440, height: 900 })).toEqual({ width: 1423, height: 769 }); // whole pixels, never past the window
});

test("the frame: the engine's /picker, titled Patients, no name, no referrer, no sandbox; the plain line and the drop-down only once it is late", () => {
  const html = renderToString(<PatientsFrame engine={ENGINE} current="" counts={{}} busy={false} onOpen={() => {}} fallback={<select aria-label="Scan" />} />);
  expect(html).toMatch(/<iframe [^>]*src="http:\/\/localhost:8000\/picker"/);
  expect(html).toContain('title="Patients"');
  expect(html).toContain('referrerPolicy="no-referrer"');
  expect(html).not.toMatch(/ name=|sandbox|allow=/);
  expect(html).not.toContain(BLOCKED);
  expect(html).not.toContain("<select"); // the frame takes the drop-down's place
  expect(BLOCKED).toBe("The patient list could not open here. Use the scan list, or the tool's own page on your computer (http://localhost:8000)."); // no guess at the cause
});

test("the hosted page with the local engine shows the frame in the bar, not the drop-down; without a frame the drop-down stays", () => {
  const html = renderToString(<App embedded panel={false} frame={ENGINE} />);
  expect(html).toContain('title="Patients"');
  expect(html).not.toContain("<select");
  expect(renderToString(<App embedded panel={false} />)).toContain("<select");
});

const HOSTED = "https://lung-measure.base44.app";
const parentWin = {} as Window;
const inFrame = (data: unknown, origin = HOSTED, source: unknown = parentWin) => fromPage({ origin, source: source as Window, data }, HOSTED, parentWin);

test("the frame takes the page's message only from the allowed origin and its parent window: a code, a step, or counts of nodules by code (0 to 99)", () => {
  expect(inFrame({ type: "current", scan: "F-0a1b2c3d" })).toEqual({ type: "current", scan: "F-0a1b2c3d" });
  expect(inFrame({ type: "current", scan: "" })).toEqual({ type: "current", scan: "" }); // no scan open yet
  expect(inFrame({ type: "step", key: "next" })).toEqual({ type: "step", key: "next" });
  const good = { "F-0a1b2c3d": 1, "D-00ff12ab": 0, "RIDER-1286684383_test": 99 };
  expect(inFrame({ type: "counts", counts: good, extra: "Doe, Jane" })).toEqual({ type: "counts", counts: good });
  expect(inFrame({ type: "counts", counts: {} })).toEqual({ type: "counts", counts: {} }); // nothing recorded yet
  for (const origin of ["http://localhost:8000", "https://evil.example", `${HOSTED}/`, "null"]) expect(inFrame({ type: "counts", counts: good }, origin)).toBeNull(); // the wrong origin
  for (const source of [other, null]) expect(inFrame({ type: "counts", counts: good }, HOSTED, source)).toBeNull(); // the wrong source
  expect(fromPage({ origin: "", source: parentWin, data: { type: "step", key: "prev" } }, "", parentWin)).toBeNull(); // no allowed origin: nothing
  for (const counts of [{ "Doe, Jane": 1 }, { "F-0A1B2C3D": 1 }, JSON.parse('{"__proto__": 1}'), { "F-0a1b2c3d": 1.5 }, { "F-0a1b2c3d": "1" }, { "F-0a1b2c3d": 100 }, { "F-0a1b2c3d": -1 },
    { "F-0a1b2c3d": NaN }, { "F-0a1b2c3d": 1, "Doe": 2 }, [1], "F-0a1b2c3d", null])
    expect(inFrame({ type: "counts", counts })).toBeNull(); // a bad key, a non-integer, too big: the whole message is ignored
  for (const data of [{ type: "current", scan: "Doe, Jane" }, { type: "step", key: "back" }, { type: "open", scan: "F-0a1b2c3d" }, null, "current"]) expect(inFrame(data)).toBeNull();
});

test("the page's counts: its own Records, codes and the number of nodules per scan only", () => {
  const row = (scan: string, nodule: number) => { const r = { patient: "x", series: "y", nodule, recorded_at: "2026-10-27T10:00:00Z", outline_file: `outlines/${scan}_n${nodule}.nii.gz`, long_mm: 9 } as RecordedNodule; rememberScanId(r, scan); return r; };
  expect(countsOf([row("F-0a1b2c3d", 1), row("F-0a1b2c3d", 2), row("F-0a1b2c3d", 2), row("D-00ff12ab", 1)])).toEqual({ "F-0a1b2c3d": 2, "D-00ff12ab": 1 });
  expect(countsOf([row("Jane_Doe_test", 1)])).toEqual({}); // never a name-shaped id, even if one reached the table
  expect(countsOf([])).toEqual({});
});

test("the hosted page shows the frame only for an engine that serves it, never in Safari", () => {
  expect(localFrame(true, false)).toMatch(/^http:\/\/localhost:\d+$/);
  expect(localFrame(undefined, false)).toBeUndefined(); // an engine from before the frame: the drop-down at once, no wait
  expect(localFrame(false, false)).toBeUndefined();
  expect(localFrame(true, true)).toBeUndefined();
});
