import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 720 }, permissions: ["clipboard-read", "clipboard-write"] });
/** a click, stroke or axis drag on the image counts only once it shows the indicator's slice; wait for that, as a person would. */
const imageReady = (page: Page) => expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 });
test("while the image is not yet the indicator's slice, the cue shows and a click sends nothing; once it is in, the click works", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await imageReady(page); // the first image and its neighbours are in
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/scans/RIDER-1286684383_test/slices/${z}`, async (r) => { await held; await r.continue(); }); // a far server, for this slice
  const sent: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") sent.push(new URL(r.url()).pathname); }); // any nodule request or logged event

  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  const cue = page.getByText(`Loading image ${scan.instance_numbers[z]}…`, { exact: true });
  await expect(cue).toBeVisible();
  await expect(canvas).not.toHaveAttribute("data-z", String(z)); // a neighbour, or the image before
  const box = (await canvas.boundingBox())!;
  const at = [Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height)] as const;
  await page.mouse.click(...at);
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);
  await expect(panel).toContainText("Click a nodule to outline it.");

  release();
  await expect(canvas).toHaveAttribute("data-z", String(z));
  await expect(cue).toHaveCount(0);
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 60_000 });
  await page.mouse.click(...at);
  await responded;
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
});

test("a press made during the cue does not become a click when it is released after the image arrives", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await imageReady(page);
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`**/api/scans/RIDER-1286684383_test/slices/${z}`, async (r) => { await held; await r.continue(); });
  const sent: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST") sent.push(new URL(r.url()).pathname); });

  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(page.getByText(`Loading image ${scan.instance_numbers[z]}…`, { exact: true })).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  await page.mouse.down(); // pressed while the cue shows
  release();
  await expect(canvas).toHaveAttribute("data-z", String(z));
  await imageReady(page);
  await page.mouse.up(); // released on the right image: still no click
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);
  await expect(panel).toContainText("Click a nodule to outline it.");
});

test("a Paint stroke in progress when the wheel changes the image is cancelled and sends nothing", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const screen = async (vy: number, vx: number) => { const b = (await canvas.boundingBox())!; return [Math.round(b.x + ((vx + 0.5) / 512) * b.width), Math.round(b.y + ((vy + 0.5) / 512) * b.height)]; };
  const strokes: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/nodule/paint")) strokes.push(r.url()); });

  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  await imageReady(page);
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 60_000 });
  await page.mouse.click(...(await screen(y, x)) as [number, number]);
  const first = await (await responded).json();
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`, { timeout: 60_000 });
  await page.keyboard.press("g");
  await expect(canvas).toHaveAttribute("data-z", String(first.axis_z));
  await imageReady(page);
  await page.keyboard.press("p");
  await expect(panel.getByRole("button", { name: "Paint (P)" })).toHaveAttribute("aria-pressed", "true");

  const sy = first.bbox[1] - 6, sx = Math.round((first.bbox[2] + first.bbox[5]) / 2); // above the outline's box: a stroke that would add tissue
  const [from, to] = [await screen(sy, sx - 6), await screen(sy, sx + 6)];
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(Math.round((from[0] + to[0]) / 2), from[1], { steps: 4 });
  await page.mouse.wheel(0, 50); // the image changes under the stroke
  await expect(counter).not.toHaveText(`Image ${scan.instance_numbers[first.axis_z]} / 265`);
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1_000);
  expect(strokes).toEqual([]);
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`);
});

test("slice 1: pick a scan and scroll it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner").getByRole("img", { name: "Baseline, lung nodule measurement on CT" })).toBeVisible();
  await expect(page).toHaveTitle("Baseline");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const read = async () => {
    const [n, m] = (await counter.innerText()).match(/\d+/g)!.map(Number);
    return { n, m };
  };
  const { n, m } = await read();
  expect(m).toBe(265);

  const box = (await counter.boundingBox())!, vp = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  const canvas = page.getByLabel("CT slice");
  await canvas.hover();
  await page.mouse.wheel(0, 50);
  await expect(counter).toHaveText(`Image ${n + 1} / ${m}`);
  await page.keyboard.press("ArrowUp");
  await expect(counter).toHaveText(`Image ${n} / ${m}`);
  // U5: a mouse-wheel notch (Chrome on macOS: about 4 px, legacy wheelDelta -120) is one image; small trackpad deltas add up to 50 px first
  const wheel = (deltaY: number, wheelDeltaY: number) => canvas.evaluate((c, [d, w]) => {
    const e = new WheelEvent("wheel", { deltaY: d, deltaMode: 0, bubbles: true, cancelable: true });
    Object.defineProperty(e, "wheelDeltaY", { value: w });
    c.dispatchEvent(e);
  }, [deltaY, wheelDeltaY]);
  await wheel(4, -120);
  await expect(counter).toHaveText(`Image ${n + 1} / ${m}`);
  await wheel(-4, 120);
  await expect(counter).toHaveText(`Image ${n} / ${m}`);
  for (let i = 0; i < 3; i++) await wheel(2, -6); // trackpad: 6 px, not yet an image
  await page.waitForTimeout(200);
  await expect(counter).toHaveText(`Image ${n} / ${m}`);

  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(c.width / 2 - 8, c.height / 2 - 8, 16, 16).data;
    return d.some((v, i) => i % 4 !== 3 && v > 0);
  })).toBe(true);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: "e2e/screenshots/slice1.png" });
});

test("slice 2: one click outlines and measures, an air click is refused", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 }); // canvas > 512 css px, so every voxel is at least one whole pixel wide
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  // Expert mask's deepest voxel (RIDER-1286684383_test): z = 161 (Image 104), y = 321, x = 330; expert volume 7.15 mL.
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const image = (k: number) => scan.instance_numbers[k];
  await page.getByRole("slider").fill(String(image(z)));
  await expect(counter).toHaveText(`Image ${image(z)} / 265`);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const overlay = page.locator("canvas:not([aria-label])");
  const panel = page.getByRole("region", { name: "Measurements" });
  const clickVoxel = async (vy: number, vx: number) => { // the voxel centre, rounded to a whole pixel (Chromium truncates mouse positions)
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(Math.round(box.x + ((vx + 0.5) / 512) * box.width), Math.round(box.y + ((vy + 0.5) / 512) * box.height));
  };
  const alphaAt = (vy: number, vx: number) =>
    overlay.evaluate((c: HTMLCanvasElement, [py, px]) => c.getContext("2d")!.getImageData(px, py, 1, 1).data[3], [vy, vx]);

  const t0 = Date.now();
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 30_000 });
  await clickVoxel(y, x);
  const outline = await (await responded).json();
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 30_000 });
  expect(outline.clicks[0]).toMatchObject({ z, y, x, positive: true });
  const text = (await panel.textContent())!;
  console.log(`slice 2 click: ${text.match(/Volume \S+ mL/)![0]} (API volume_ml ${outline.volume_ml}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  expect(text).not.toContain("NaN");
  expect(outline.volume_ml).toBeGreaterThan(0);
  expect(text).toContain(`Volume ${outline.volume_ml.toFixed(2)} mL`);
  expect(text).toContain(`Long axis ${outline.long_mm.toFixed(1)} mm`);
  expect(text).toContain(`Short axis ${outline.short_mm.toFixed(1)} mm`);
  expect(await alphaAt(y, x)).toBeGreaterThan(0); // the outline covers the clicked point

  await expect(panel).toBeInViewport(); // results beside the image, no scrolling, at 1280x900 and 1280x720
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(panel).toBeInViewport();
  await panel.getByRole("button", { name: "Go to largest slice" }).click();
  await expect(counter).toHaveText(`Image ${image(outline.axis_z)} / 265`);
  await page.screenshot({ path: "e2e/screenshots/slice2.png" });

  // New nodule, then air on the click slice: the engine refuses, the page shows only that message, the engine lives.
  await panel.getByRole("button", { name: "New nodule" }).click();
  await page.getByRole("slider").fill(String(image(z)));
  await expect(counter).toHaveText(`Image ${image(z)} / 265`);
  await clickVoxel(4, 4);
  await expect(panel).toContainText("No outline here: that point is air. Click on the nodule itself.", { timeout: 30_000 });
  expect(await panel.textContent()).not.toMatch(/Volume \d|NaN/); // no number in the card
  expect(await alphaAt(y, x)).toBe(0);
  expect((await page.request.get("/api/scans")).status()).toBe(200);
});

test("slice 3: a Shift+click removes, Undo restores", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  await expect(page.getByText("head ↑ / feet ↓")).toBeVisible(); // head_dir 1 and image numbers falling with z
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const clickVoxel = async (vy: number, vx: number, shift = false) => {
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    const [px, py] = [Math.round(box.x + ((vx + 0.5) / 512) * box.width), Math.round(box.y + ((vy + 0.5) / 512) * box.height)];
    if (shift) await page.keyboard.down("Shift");
    await page.mouse.click(px, py);
    if (shift) await page.keyboard.up("Shift");
  };
  const post = (path: string) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30_000 });

  let responded = post("/nodules");
  await clickVoxel(y, x);
  const first = await (await responded).json();
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`, { timeout: 30_000 });
  await expect(panel).toContainText(/On Images \d+–\d+ \(\d+\.\d mm top to bottom\)/);

  // A mask voxel of this slice far from the click: the outline's edge.
  const b: number[] = first.bbox, [h, w] = [b[4] - b[1], b[5] - b[2]];
  const bytes = Buffer.from(first.mask, "base64");
  let edge = { vy: y, vx: x, d: -1 };
  for (let i = 0; i < h * w; i++) {
    const n = (z - b[0]) * h * w + i;
    if (!((bytes[n >> 3] >> (7 - (n & 7))) & 1)) continue;
    const [vy, vx] = [b[1] + Math.floor(i / w), b[2] + (i % w)];
    const d = (vy - y) ** 2 + (vx - x) ** 2;
    if (d > edge.d) edge = { vy, vx, d };
  }

  responded = post("/nodule/clicks");
  await clickVoxel(edge.vy, edge.vx, true);
  const removed = await (await responded).json();
  console.log(`slice 3 volume: first ${first.volume_ml}, after Shift+click ${removed.volume_ml}`);
  expect(removed.clicks.at(-1)).toMatchObject({ y: edge.vy, x: edge.vx, positive: false });
  expect(removed.volume_ml).not.toBe(first.volume_ml);
  await expect(panel).toContainText(`Volume ${removed.volume_ml.toFixed(2)} mL`);
  console.log(`slice 3 panel line: ${(await panel.textContent())!.match(/On Images [^)]*\)/)?.[0]}`);
  await page.screenshot({ path: "e2e/screenshots/slice3.png" });

  const undo = panel.getByRole("button", { name: "Undo" });
  responded = post("/nodule/undo");
  await undo.click();
  const undone = await (await responded).json();
  console.log(`slice 3 after Undo: ${undone.volume_ml}`);
  expect(undone.volume_ml).toBe(first.volume_ml);
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`);
  await expect(undo).toBeDisabled();

  // The engine no longer holds this nodule (a restart, or another tab): the correction is refused, the page forgets the outline, the next click starts.
  const gone = "This nodule is no longer open in the engine (another tab or a restart). Click the nodule to start again.";
  await page.route("**/api/nodule/clicks", (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: gone }) }));
  await clickVoxel(y, x, true);
  await expect(panel).toContainText(gone);
  const drawn = () => page.locator("canvas:not([aria-label])").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v) => v));
  expect(await drawn()).toBe(false);
  await page.unroute("**/api/nodule/clicks");
  responded = post("/nodules");
  await clickVoxel(y, x);
  expect((await (await responded).json()).volume_ml).toBeGreaterThan(0);
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/);
  expect(await drawn()).toBe(true);
});

test("slice 4: record, table, export, copy, screenshot, discard", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const table = page.getByRole("region", { name: "Recorded nodules" });
  const outlineOne = async () => {
    await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
    await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
    await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  };

  await outlineOne();
  const shown = await canvas.boundingBox();
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Recorded as nodule 1.");
  await expect(panel.getByRole("button", { name: "Undo (U)" })).toHaveCount(0); // the correction Undo goes; the Record's own Undo shows in the green box
  await expect(panel.getByRole("button", { name: "Undo this Record" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Record nodule" })).toHaveCount(0); // New nodule is now the one primary button
  await expect(table.getByRole("row")).toHaveCount(0); // U1: a Record leaves the table folded, so the image keeps its size
  expect(await canvas.boundingBox()).toEqual(shown);
  await page.getByRole("button", { name: /^Recorded nodules/ }).click();
  await expect(table.getByRole("row")).toHaveCount(2); // header + 1
  await page.screenshot({ path: "e2e/screenshots/slice4.png", fullPage: true });

  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe("lung-measurements.csv");
  const csvLines = readFileSync((await csv.path())!, "utf8").split("\n");
  expect(csvLines[0]).toBe("patient,series,series_number,study_date,nodule,slice,slice_label,long_mm,short_mm,width,volume_ml,depth_mm,clicks,corrections,seconds_to_record,recorded_at,long_y1,long_x1,long_y2,long_x2,short_y1,short_x1,short_y2,short_x2,click_image,click_y,click_x,at_window_edge,slice_thickness_mm,slice_spacing_mm,painted,axes_edited,follows,outline_file");
  const cell = Object.fromEntries(csvLines[0].split(",").map((k, i) => [k, csvLines[1].split(",")[i]]));
  expect(cell).toMatchObject({ patient: "RIDER-1286684383", series: "test", nodule: "1" });
  expect(Number(cell.series_number)).toBe(scan.series_number);
  expect(cell.study_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Number(cell.corrections)).toBe(Number(cell.clicks) - 1);
  expect([cell.painted, cell.axes_edited]).toEqual(["0", "false"]); // clicks only: no stroke, no dragged axis
  expect(Number(cell.slice_thickness_mm)).toBeGreaterThan(0); expect(Number(cell.slice_spacing_mm)).toBeCloseTo(scan.spacing[2], 5);
  console.log(`slice 4 CSV line 2: ${csvLines[1]}`);

  const pngDownload = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Save screenshot" }).click();
  const png = await pngDownload;
  expect(png.suggestedFilename()).toBe("RIDER-1286684383_test_n1.png");
  const bytes = readFileSync((await png.path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(512); // IHDR width: the full slice
  expect(bytes.readUInt32BE(20)).toBe(512 + 24 + 24 + 20 + 12); // the caption strip: three lines, none wrapped, the third smaller

  await table.getByRole("button", { name: /Copy row/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(csvLines[1].split(",").join("\t"));
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await panel.getByRole("button", { name: "Copy row", exact: true }).click(); // the same row from the panel, one click, the table open or folded
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(csvLines[1].split(",").join("\t"));
  console.log(`slice 4 TSV line: ${await page.evaluate(() => navigator.clipboard.readText())}`);

  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(2); // still open after a reload: open or folded is remembered
  await expect(table).toContainText("RIDER-1286684383");

  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await outlineOne();
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_retest");
  await expect(page.getByText("The unrecorded outline was discarded.")).toBeVisible();
  await expect.poll(() => lines().slice(before).filter((e) => ["record", "export_csv", "screenshot", "copy_row", "discard"].includes(e.action)).map((e) => e.action))
    .toEqual(["record", "export_csv", "screenshot", "copy_row", "copy_row", "discard"]); // Copy row from the table, then from the panel
  const ev = lines().slice(before), file = ev.find((e) => e.action === "record").outline_file;
  expect(ev.find((e) => e.action === "screenshot").file).toBe(file);
  const [fromTable, fromPanel] = ev.filter((e) => e.action === "copy_row").map(({ t, ...rest }) => rest);
  expect(fromPanel).toEqual(fromTable); // the same event and fields from both buttons
  expect(fromTable.file).toBe(file);
  console.log(`slice 4 events: ${lines().slice(before).map((e) => e.action).join(", ")}`);

  // A new sitting: download first, then clear; the next nodule of the scan is not number 1 again.
  const clearDownload = page.waitForEvent("download");
  await table.getByRole("button", { name: "Download CSV and clear table" }).click();
  const cleared = readFileSync((await (await clearDownload).path())!, "utf8").split("\n");
  expect(cleared[1]).toMatch(/^RIDER-1286684383,test,\d+,\d{4}-\d{2}-\d{2},1,/);
  console.log(`slice 4 clear CSV line 2: ${cleared[1]}`);
  await expect(table.getByRole("row")).toHaveCount(0);
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(0);
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "clear_table")).toEqual([expect.objectContaining({ rows: 1 })]);
  await expect(page.getByText("Table cleared. The CSV was downloaded; check that it saved.")).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(0);
  const restoreBtn = page.getByRole("button", { name: "Restore the cleared rows (1)" });
  await expect(restoreBtn).toBeVisible(); // survives the reload; the rows themselves stay out of view
  console.log(`slice 4 clear event: ${JSON.stringify(lines().slice(before).find((e) => e.action === "clear_table"))}`);
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await outlineOne();
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Recorded as nodule 2.");
  await restoreBtn.click();
  await expect(table.getByRole("row")).toHaveCount(3); // header + restored row + nodule 2
  await expect(table.getByRole("row").nth(1).getByRole("cell").nth(2)).toHaveText("1"); // the Nodule cell (the patient id holds a 1 too)
  await expect(table.getByRole("row").nth(2).getByRole("cell").nth(2)).toHaveText("2");
  await expect(restoreBtn).toHaveCount(0);
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "restore_table")).toEqual([expect.objectContaining({ rows: 1 })]);
  console.log(`slice 4 restore event: ${JSON.stringify(lines().slice(before).find((e) => e.action === "restore_table"))}`);
  console.log("slice 4 next nodule after clear: 2");

  // Deleting the row of the outline on the page drops the outline: the next click starts anew.
  const deleteTwo = async () => {
    await table.getByRole("button", { name: /Delete nodule 2 of/ }).click();
    await table.getByRole("button", { name: /Confirm: delete nodule 2 of/ }).click();
    await expect(table.getByRole("row")).toHaveCount(2);
  };
  await deleteTwo();
  await expect(page.getByText("Row deleted. Click the nodule to outline it again.")).toBeVisible();
  await table.getByRole("button", { name: "Undo", exact: true }).click(); // Undo brings the row back and clears that notice
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(page.getByText("Row deleted. Click the nodule to outline it again.")).toHaveCount(0);
  await deleteTwo(); // the row is back, but its outline left the page with the first delete
  await expect(panel.getByRole("button", { name: "Record nodule" })).toBeDisabled(); // nothing on the page to record

  // Forget empties the backup slot: no restore button after a reload.
  await table.getByRole("button", { name: "Download CSV and clear table" }).click();
  const forgetBtn = page.getByRole("button", { name: "Forget the cleared rows" });
  await expect(page.getByRole("button", { name: "Restore the cleared rows (1)" })).toBeVisible();
  await forgetBtn.click();
  await expect(page.getByRole("button", { name: /Restore the cleared rows/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /Restore the cleared rows/ })).toHaveCount(0);
  await expect(table.getByRole("row")).toHaveCount(0);
});

test("start over clears the outline, the next click starts again", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const click = async () => {
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  };
  await click();
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await panel.getByRole("button", { name: "Start over (S)" }).click();
  await expect(panel).toContainText("Click a nodule to outline it.");
  await expect(panel.getByRole("button", { name: "Start over (S)" })).toBeDisabled(); // nothing to throw away
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 30_000 });
  await click();
  const o = await (await responded).json();
  expect(o.clicks).toHaveLength(1);
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await page.keyboard.press("s"); // the key does the same
  await expect(panel).toContainText("Click a nodule to outline it.");
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "start_over").length).toBe(2);
  expect(lines().slice(before).some((e) => e.action === "discard")).toBe(false);
});

test("zoom to area, a click on the zoomed image hits the right voxel, the view stays across slices", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const viewer = page.getByTestId("viewer");
  const panel = page.getByRole("region", { name: "Measurements" });
  const readout = page.getByLabel("Zoom", { exact: true });
  const view = async () => JSON.parse((await canvas.getAttribute("data-view"))!) as { scale: number; ox: number; oy: number };
  await expect(readout).toHaveText("100 %");

  const box = (await viewer.boundingBox())!;
  const [cx, cy] = [box.x + ((x + 0.5) / 512) * box.width, box.y + ((y + 0.5) / 512) * box.height];
  await page.keyboard.press("z");
  await expect(page.getByRole("button", { name: "Zoom to area (Z)" })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(cx - 45, cy - 45);
  await page.mouse.down();
  await page.mouse.move(cx + 45, cy + 45, { steps: 5 });
  await page.mouse.up();
  await expect(readout).not.toHaveText("100 %");
  expect(await page.locator("canvas:not([aria-label])").count()).toBe(1);
  await expect(panel).toContainText("Click a nodule to outline it."); // the drag made no engine click
  await expect(page.getByRole("button", { name: "Zoom to area (Z)" })).toHaveAttribute("aria-pressed", "false");
  const v = await view();
  expect(v.scale).toBeGreaterThan(4);
  const zoomed = await readout.innerText();

  // the view stays when the slice changes
  await page.evaluate(() => (document.activeElement as HTMLElement).blur()); // the slider keeps its own arrow keys
  await page.keyboard.press("ArrowDown");
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z - 1]} / 265`); // ArrowDown goes to the next higher image number
  expect(await readout.innerText()).toBe(zoomed);
  expect(await view()).toEqual(v);
  await page.keyboard.press("ArrowUp");
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  expect(await readout.innerText()).toBe(zoomed);

  // the nodule's voxel at its screen position under the view
  const k = (box.width * v.scale) / 512;
  const [px, py] = [Math.round(box.x + (x + 0.5 - v.ox) * k), Math.round(box.y + (y + 0.5 - v.oy) * k)];
  await imageReady(page);
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 30_000 });
  await page.mouse.click(px, py);
  const outline = await (await responded).json();
  expect(outline.clicks[0]).toMatchObject({ z, y, x, positive: true });
  console.log(`zoom: view ${JSON.stringify(v)}, click at screen (${px}, ${py}) -> voxel z ${outline.clicks[0].z}, y ${outline.clicks[0].y}, x ${outline.clicks[0].x}`);
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await page.screenshot({ path: "e2e/screenshots/zoom.png" });

  await page.getByRole("button", { name: "Fit (F)" }).click();
  await expect(readout).toHaveText("100 %");
  await page.getByRole("button", { name: "Zoom in (+)" }).click();
  await expect(readout).toHaveText("125 %");
  await page.keyboard.press("-");
  await expect(readout).toHaveText("100 %");
  await page.keyboard.press("z");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Zoom to area (Z)" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("=");
  await expect(readout).toHaveText("125 %");
  await page.keyboard.press("f");
  await expect(readout).toHaveText("100 %");
  await expect.poll(() => lines().slice(before).filter((e) => e.action.startsWith("zoom")).map((e) => e.action))
    .toEqual(["zoom_area", "zoom_fit", "zoom", "zoom", "zoom", "zoom_fit"]);
  const ev = lines().slice(before);
  expect(ev.find((e) => e.action === "zoom_area").scale).toBe(v.scale);
  console.log(`zoom events: ${ev.filter((e) => e.action.startsWith("zoom")).map((e) => `${e.action}${e.scale ? " " + e.scale : ""}`).join(", ")}`);
});

test("Ctrl+wheel zooms about the cursor, Space+drag pans, a click afterwards is exact", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const viewer = page.getByTestId("viewer");
  const panel = page.getByRole("region", { name: "Measurements" });
  const view = async () => JSON.parse((await canvas.getAttribute("data-view"))!) as { scale: number; ox: number; oy: number };
  const box = (await viewer.boundingBox())!;

  // the plain wheel still changes the image
  const n0 = Number((await counter.innerText()).match(/\d+/)![0]);
  await canvas.hover();
  await page.mouse.wheel(0, 50);
  await expect(counter).toHaveText(`Image ${n0 + 1} / 265`);
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);

  // Ctrl+wheel over the nodule: the image point under the cursor stays put
  const [cx, cy] = [Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height)];
  const under = (v: { scale: number; ox: number; oy: number }) => ({ x: v.ox + ((cx - box.x) * 512) / (box.width * v.scale), y: v.oy + ((cy - box.y) * 512) / (box.height * v.scale) });
  const p0 = under(await view());
  await page.mouse.move(cx, cy);
  await page.keyboard.down("Control");
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100); // each counts as 20: x1.22
  await page.keyboard.up("Control");
  await expect.poll(async () => (await view()).scale).toBeGreaterThan(3);
  const v1 = await view();
  const p1 = under(v1);
  expect(Math.abs(p1.x - p0.x)).toBeLessThan(0.01);
  expect(Math.abs(p1.y - p0.y)).toBeLessThan(0.01);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const zoomEvents = () => lines().slice(before).filter((e) => e.action === "zoom");
  await expect.poll(() => zoomEvents().length, { timeout: 5_000 }).toBe(1); // one per gesture, after it ends
  await page.waitForTimeout(1_000);
  expect(zoomEvents()).toHaveLength(1);
  expect(zoomEvents()[0].scale).toBeCloseTo(v1.scale, 6);

  // Space+drag moves the view and sends no engine click
  await page.keyboard.down("Space");
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 40, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const v2 = await view();
  expect(v2.scale).toBe(v1.scale);
  expect(v2.ox).toBeGreaterThan(v1.ox + 5);
  expect(v2.oy).toBeGreaterThan(v1.oy + 3);
  await page.waitForTimeout(500);
  await expect(panel).toContainText("Click a nodule to outline it."); // no click was sent
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(lines().slice(before).filter((e) => e.action === "zoom")).toHaveLength(1); // pan logs nothing

  // the nodule's voxel at its computed screen position reaches the engine exactly
  const k = (box.width * v2.scale) / 512;
  const [px, py] = [Math.round(box.x + (x + 0.5 - v2.ox) * k), Math.round(box.y + (y + 0.5 - v2.oy) * k)];
  await imageReady(page);
  const responded = page.waitForResponse((r) => r.url().includes("/nodules") && r.request().method() === "POST", { timeout: 30_000 });
  await page.mouse.click(px, py);
  const outline = await (await responded).json();
  expect(outline.clicks).toHaveLength(1);
  expect(outline.clicks[0]).toMatchObject({ z, y, x, positive: true });
  console.log(`ctrl+wheel: scale ${v1.scale.toFixed(3)}, point drift (${(p1.x - p0.x).toExponential(1)}, ${(p1.y - p0.y).toExponential(1)}); pan ox ${v1.ox.toFixed(1)} -> ${v2.ox.toFixed(1)}; click (${px}, ${py}) -> z ${outline.clicks[0].z}, y ${outline.clicks[0].y}, x ${outline.clicks[0].x}`);
});

test("keys A and R set the mode, Esc during a zoom-area drag sends nothing, Start over keeps the clock", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const at = async (vy: number, vx: number) => { const b = (await canvas.boundingBox())!; return [Math.round(b.x + ((vx + 0.5) / 512) * b.width), Math.round(b.y + ((vy + 0.5) / 512) * b.height)]; };
  const post = (path: string) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30_000 });
  const engine: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/nodules?(\/|$)/.test(r.url())) engine.push(r.url()); });

  // Esc in the middle of a zoom-area drag: the release is not a click
  const [cx, cy] = await at(y, x);
  await page.keyboard.press("z");
  await page.mouse.move(cx - 40, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 40, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(engine).toEqual([]);
  await expect(panel).toContainText("Click a nodule to outline it.");

  await imageReady(page);
  const t0 = Date.now(); // the first click of this nodule
  let responded = post("/nodules");
  await page.mouse.click(cx, cy);
  const first = await (await responded).json();
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.keyboard.press("s"); // Start over
  await expect(panel).toContainText("Click a nodule to outline it.");
  responded = post("/nodules");
  await page.mouse.click(cx, cy);
  await (await responded).json();
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });

  // R, then a click on the outline's edge removes; A, then a click adds
  const b: number[] = first.bbox, [h, w] = [b[4] - b[1], b[5] - b[2]];
  const bytes = Buffer.from(first.mask, "base64");
  let edge = { vy: y, vx: x, d: -1 };
  for (let i = 0; i < h * w; i++) {
    const n = (z - b[0]) * h * w + i;
    if (!((bytes[n >> 3] >> (7 - (n & 7))) & 1)) continue;
    const [vy, vx] = [b[1] + Math.floor(i / w), b[2] + (i % w)];
    const d = (vy - y) ** 2 + (vx - x) ** 2;
    if (d > edge.d) edge = { vy, vx, d };
  }
  const [ex, ey] = await at(edge.vy, edge.vx);
  await page.keyboard.press("r");
  responded = post("/nodule/clicks");
  await page.mouse.click(ex, ey);
  expect((await (await responded).json()).clicks.at(-1)).toMatchObject({ positive: false });
  await page.keyboard.press("a");
  responded = post("/nodule/clicks");
  await page.mouse.click(ex, ey);
  expect((await (await responded).json()).clicks.at(-1)).toMatchObject({ positive: true });

  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Recorded as nodule 1.");
  const elapsed = (Date.now() - t0) / 1000;
  await page.getByRole("button", { name: /^Recorded nodules/ }).click(); // the table starts folded; Download CSV is in its bar
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV", exact: true }).click();
  const [head, row] = readFileSync((await (await download).path())!, "utf8").split("\n");
  const seconds = Number(row.split(",")[head.split(",").indexOf("seconds_to_record")]);
  console.log(`start over clock: seconds_to_record ${seconds}, since the first click ${elapsed.toFixed(1)}`);
  expect(seconds).toBeGreaterThanOrEqual(elapsed - 1.5); // the attempt thrown away counts
  expect(seconds).toBeLessThanOrEqual(elapsed + 0.5);
});

test("engine stopped: the panel says so and no outline is drawn", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  await expect(page.getByText(/^Image \d+ \/ 265$/)).toBeVisible({ timeout: 60_000 });
  await page.route("**/nodules", (r) => r.abort());
  await page.locator('canvas[aria-label="CT slice"]').click();
  const panel = page.getByRole("region", { name: "Measurements" });
  await expect(panel).toContainText("The engine stopped. Restart it (see README) and click again.");
  const drawn = await page.locator("canvas:not([aria-label])").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.some((v) => v));
  expect(drawn).toBe(false);
});

test("polish: Enter records, U undoes, Delete asks once more and Undo puts the row back", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear()); // a fresh table: nodule numbers start at 1
  await page.reload();
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Recorded nodules/ }).click(); // open the table (it starts folded); it then keeps a fixed height
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const table = page.getByRole("region", { name: "Recorded nodules" });
  const post = (path: string) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30_000 });
  const outlineOne = async () => {
    await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
    await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    const responded = post("/nodules");
    await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
    const o = await (await responded).json();
    await expect(panel).toContainText(`Volume ${o.volume_ml.toFixed(2)} mL`, { timeout: 60_000 });
    return o;
  };

  // U undoes the last click, like the Undo button
  const first = await outlineOne();
  const box = (await canvas.boundingBox())!;
  let responded = post("/nodule/clicks");
  await page.mouse.click(Math.round(box.x + ((x + 4.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  await (await responded).json();
  responded = post("/nodule/undo");
  await page.keyboard.press("u");
  expect((await (await responded).json()).volume_ml).toBe(first.volume_ml);
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`);
  await expect(panel).toContainText("Outline ready.");
  await page.keyboard.press("g"); // G goes to the largest slice, where the axis lines are drawn
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[first.axis_z]} / 265`);
  await expect(page.getByText("Largest slice", { exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute("data-z", String(first.axis_z)); // the largest slice's image has arrived, not only its counter
  await page.screenshot({ path: "e2e/screenshots/polish-measure.png" });

  // Enter records; the image keeps its size (U1: the table under it has a fixed height)
  const imageBox = await canvas.boundingBox();
  responded = post("/nodule/record");
  await page.keyboard.press("Enter");
  const file1 = (await (await responded).json()).outline_file;
  await expect(panel).toContainText("Recorded as nodule 1.");
  await expect(table.getByRole("row")).toHaveCount(2);
  expect(await canvas.boundingBox()).toEqual(imageBox);
  await page.screenshot({ path: "e2e/screenshots/polish-recorded.png" });

  // N, then a second nodule, recorded with Enter
  await page.keyboard.press("n");
  await expect(panel).toContainText("Nodule 2");
  await outlineOne();
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Recorded as nodule 2.");
  const nodules = () => table.getByRole("row").evaluateAll((rs) => rs.slice(1).map((r) => r.children[2].textContent));
  await expect.poll(nodules).toEqual(["1", "2"]);
  expect(await canvas.boundingBox()).toEqual(imageBox);

  // A third nodule open, not recorded. Delete arms for about 3 s: Enter does not record meanwhile, and waiting deletes nothing
  await page.keyboard.press("n"); // N leaves the table open
  await outlineOne();
  await expect(panel).toContainText("Nodule 3");
  await expect(table.getByRole("row")).toHaveCount(3);
  let records = 0;
  page.on("request", (r) => { if (r.url().includes("/nodule/record")) records++; });
  const del1 = table.getByRole("button", { name: /^Delete nodule 1 of/ });
  await del1.click();
  const confirm1 = table.getByRole("button", { name: /^Confirm: delete nodule 1 of/ });
  await expect(confirm1).toHaveText("Delete row? Confirm");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_500);
  expect(records).toBe(0);
  await expect(panel).toContainText("Not saved yet");
  await expect(panel.getByRole("button", { name: "Record nodule" })).toBeEnabled();
  await expect(confirm1).toHaveCount(0);
  await expect(del1).toBeVisible();
  expect(await nodules()).toEqual(["1", "2"]);
  expect(lines().slice(before).some((e) => e.action === "delete_row")).toBe(false);

  // Confirm within 3 s deletes; Undo puts the row back in its place and logs undo_delete_row with the row's file
  await del1.click();
  await confirm1.click();
  await expect.poll(nodules).toEqual(["2"]);
  await expect(table.getByText("Row deleted.")).toBeVisible();
  await table.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(nodules).toEqual(["1", "2"]);
  await expect(table.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect.poll(() => lines().slice(before).filter((e) => ["delete_row", "undo_delete_row"].includes(e.action)).map((e) => [e.action, e.file, e.nodule]))
    .toEqual([["delete_row", file1, 1], ["undo_delete_row", file1, 1]]);
  await page.keyboard.press("n");
  await expect(panel).toContainText("Nodule 3"); // the scan's counter did not move back
  console.log(`polish: undo_delete_row ${JSON.stringify(lines().slice(before).find((e) => e.action === "undo_delete_row"))}`);

  // U1: the table's default height shows three rows; dragging its top edge up 100 px makes it 100 px taller; the height survives a reload; a double-click resets it
  const tall = async () => (await table.boundingBox())!.height;
  expect(await tall()).toBe(220);
  const grip = page.getByRole("separator", { name: "Resize the recorded-nodules table" });
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 - 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(tall).toBe(320);
  // the arrows on the focused grip resize by 16 px and leave the image alone
  const img = await counter.innerText();
  await grip.focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(tall).toBe(336);
  await page.keyboard.press("ArrowDown");
  await expect.poll(tall).toBe(320);
  await expect(counter).toHaveText(img);
  await page.reload();
  await expect.poll(tall).toBe(320);
  await grip.dblclick();
  await expect.poll(tall).toBe(220);
  await page.reload();
  await expect.poll(tall).toBe(220);
});

test("Undo in the green box removes the local row as Delete does, logs undo_record, and is gone after the next action", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear()); // a fresh table: nodule numbers start at 1
  await page.reload();
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Recorded nodules/ }).click();
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const table = page.getByRole("region", { name: "Recorded nodules" });
  const outlineOne = async () => {
    await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
    await imageReady(page);
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
    await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  };
  await outlineOne();
  await expect(panel).toContainText("Not saved yet");
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Recorded as nodule 1.");
  await expect(table.getByRole("row")).toHaveCount(2);
  await panel.getByRole("button", { name: "Undo this Record" }).click();
  await expect(table.getByRole("row")).toHaveCount(0);
  await expect(panel).toContainText("Record undone. Click the nodule to outline it again.");
  await expect(panel.getByRole("button", { name: "Undo this Record" })).toHaveCount(0);
  const ev = lines().slice(before), rec = ev.find((e) => e.action === "record");
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "undo_record").map(({ scan, nodule, undoes, patient }) => ({ scan, nodule, undoes, patient })))
    .toEqual([{ scan: rec.scan, nodule: rec.nodule, undoes: rec.outline_file, patient: "RIDER-1286684383" }]);
  await outlineOne(); // the next nodule: its number is not reused, as after Delete; a click is the next action, so the new Record's Undo is its own
  await expect(panel).toContainText("Nodule 2");
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Recorded as nodule 2.");
  await page.keyboard.press("n");
  await expect(panel.getByRole("button", { name: "Undo this Record" })).toHaveCount(0); // New nodule ends it
  await expect(table.getByRole("row")).toHaveCount(2);
});

test("open a CT folder: browse to it, open the series, one click outlines", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open a CT folder…" }).click();
  const panel = page.getByRole("region", { name: "Open a CT folder" });
  await panel.getByRole("button", { name: "scan", exact: true }).click();
  await expect(panel.getByText(/265 images/)).toBeVisible();
  await panel.getByRole("button", { name: /^Open .*265 images/ }).click();
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Scan")).toHaveValue(/^F-[0-9a-f]{8}$/);
  const [z, y, x] = [161, 321, 330];
  const id = await page.getByLabel("Scan").inputValue();
  const scan = await (await page.request.get(`/api/scans/${id}`)).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  await imageReady(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  await expect(page.getByRole("region", { name: "Measurements" })).toContainText(/mL/, { timeout: 120_000 });
});

test("slice 5: a Paint stroke beside the outline and its Erase, a dragged long-axis end, the row keeps painted and axes_edited", async ({ page }) => {
  test.setTimeout(240_000);
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear()); // a fresh table: the row is nodule 1
  await page.reload();
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const marks = page.locator('canvas[aria-label="Axis lines and click marks"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const post = (path: string) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30_000 });
  const box = async () => (await canvas.boundingBox())!;
  const screen = async (vy: number, vx: number) => { const b = await box(); return [Math.round(b.x + ((vx + 0.5) / 512) * b.width), Math.round(b.y + ((vy + 0.5) / 512) * b.height)]; };
  const drag = async (from: number[], to: number[]) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); await page.mouse.move(to[0], to[1], { steps: 8 }); await page.mouse.up(); };
  const strokes: unknown[] = [];
  page.on("request", (r) => { if (r.url().includes("/nodule/paint")) strokes.push(r.postDataJSON()); });

  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  await imageReady(page);
  let responded = post("/nodules");
  await page.mouse.click(...(await screen(y, x)) as [number, number]);
  const first = await (await responded).json();
  expect(first).toMatchObject({ painted: 0, axes_edited: false });
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`, { timeout: 60_000 });
  await page.keyboard.press("g"); // paint on the largest slice, where the axis handles are
  await expect(canvas).toHaveAttribute("data-z", String(first.axis_z));

  // A stroke 6 px above the outline's top row on this slice: the 3 px brush stays 2 px clear of it, so Erase takes back only what Paint added.
  const b: number[] = first.bbox, [h, w] = [b[4] - b[1], b[5] - b[2]], bits = Buffer.from(first.mask, "base64");
  const top = { y: Infinity, xs: [] as number[] };
  for (let i = 0; i < h * w; i++) {
    const n = (first.axis_z - b[0]) * h * w + i;
    if (!((bits[n >> 3] >> (7 - (n & 7))) & 1)) continue;
    const [vy, vx] = [b[1] + Math.floor(i / w), b[2] + (i % w)];
    if (vy < top.y) { top.y = vy; top.xs = []; }
    if (vy === top.y) top.xs.push(vx);
  }
  const sy = top.y - 6, sx = Math.round(top.xs.reduce((a, v) => a + v, 0) / top.xs.length);
  const [from, to] = [await screen(sy, sx - 6), await screen(sy, sx + 6)];

  await page.keyboard.press("p");
  await expect(panel.getByRole("button", { name: "Paint (P)" })).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toContainText("Brush 3 px");
  await page.keyboard.press("]");
  await expect(panel).toContainText("Brush 4 px");
  await page.keyboard.press("[");
  await expect(panel).toContainText("Brush 3 px");
  const snapBtn = panel.getByRole("button", { name: "Snap to tissue (T)" });
  await page.keyboard.press("t");
  await expect(snapBtn).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("t");
  await expect(snapBtn).toHaveAttribute("aria-pressed", "false");
  await page.mouse.move(from[0], from[1]);
  const vb = await box(), k = vb.width / 512; // screen px per image pixel at Fit
  await expect.poll(() => marks.getAttribute("data-ring")).toMatch(/^\[/);
  const [rx, ry, rr] = JSON.parse((await marks.getAttribute("data-ring"))!); // the ring on the pixel under the pointer, 3.5 pixels across each way
  expect(Math.abs(rx - (from[0] - vb.x))).toBeLessThanOrEqual(1);
  expect(Math.abs(ry - (from[1] - vb.y))).toBeLessThanOrEqual(1);
  expect(rr).toBeCloseTo(3.5 * k, 3);

  responded = post("/nodule/paint");
  await drag(from, to);
  const painted = await (await responded).json();
  expect(strokes).toHaveLength(1); // one request per stroke, on release
  expect(strokes[0]).toMatchObject({ scan: first.scan, nodule: first.nodule, z: first.axis_z, radius: 3, mode: "paint", snap: false, points: expect.arrayContaining([[sy, sx - 6], [sy, sx + 6]]) });
  console.log(`slice 5 paint: ${first.volume_ml} -> ${painted.volume_ml} mL with ${(strokes[0] as { points: unknown[] }).points.length} points`);
  expect(painted.volume_ml).toBeGreaterThan(first.volume_ml);
  expect(painted.painted).toBe(1);
  await expect(panel).toContainText(`Volume ${painted.volume_ml.toFixed(2)} mL`);
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "paint").map((e) => [e.z, e.radius, e.snap, e.voxels > 0])).toEqual([[first.axis_z, 3, false, true]]);

  await page.keyboard.press("e");
  await expect(panel.getByRole("button", { name: "Erase (E)" })).toHaveAttribute("aria-pressed", "true");
  responded = post("/nodule/paint");
  await drag(from, to);
  const erased = await (await responded).json();
  expect(strokes).toHaveLength(2);
  expect(strokes[1]).toMatchObject({ mode: "erase", points: (strokes[0] as { points: unknown[] }).points });
  console.log(`slice 5 erase: ${erased.volume_ml} mL (first click ${first.volume_ml})`);
  expect(Math.abs(erased.volume_ml - first.volume_ml)).toBeLessThanOrEqual(0.01);
  expect(erased.painted).toBe(2);
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "erase").length).toBe(1);

  // Axes mode (X), then drag the long axis's first end 5 px further out along the line: the line and its length follow, and the card says set by hand.
  const [[y1, x1], [y2, x2]] = erased.long_line, end = await screen(y1, x1), len = Math.hypot(x1 - x2, y1 - y2);
  const out = [Math.round(end[0] + (5 * (x1 - x2)) / len), Math.round(end[1] + (5 * (y1 - y2)) / len)];
  await page.keyboard.press("x");
  await expect(panel.getByRole("button", { name: "Axes (X)" })).toHaveAttribute("aria-pressed", "true");
  responded = post("/nodule/axes");
  await drag(end, out);
  const axes = await (await responded).json();
  console.log(`slice 5 axis drag: long ${erased.long_mm} -> ${axes.long_mm} mm, end ${JSON.stringify(erased.long_line[0])} -> ${JSON.stringify(axes.long_line[0])}`);
  expect(axes.axes_edited).toBe(true);
  expect(axes.long_mm).toBeGreaterThan(erased.long_mm);
  expect(axes.short_line).toEqual(erased.short_line);
  expect(axes.long_line[1]).toEqual(erased.long_line[1]);
  expect(strokes).toHaveLength(2); // a drag that starts on a handle never paints
  await expect(panel).toContainText(`Long axis ${axes.long_mm.toFixed(1)} mm`);
  await expect(panel).toContainText("Axes set by hand");
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "axis_drag").map((e) => [e.which, e.before_mm, e.after_mm])).toEqual([["long", erased.long_mm, axes.long_mm]]);

  await page.mouse.move(from[0], from[1]); // zoomed about the pointer so the handles and the ring show: Axes mode first, then Paint
  await page.keyboard.down("Control");
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(async () => JSON.parse((await canvas.getAttribute("data-view"))!).scale).toBeGreaterThan(4);
  await page.screenshot({ path: "e2e/screenshots/slice5-axes.png" });
  await page.keyboard.press("p");
  await page.mouse.move(from[0] + 1, from[1]); await page.mouse.move(from[0], from[1]);
  await expect.poll(async () => JSON.parse((await marks.getAttribute("data-ring")) || "[0, 0, 0]")[2]).toBeGreaterThan(3.5 * k * 4); // the ring grows with the zoom
  await page.screenshot({ path: "e2e/screenshots/slice5-paint.png" });

  responded = post("/nodule/record");
  await page.keyboard.press("Enter");
  await (await responded).json();
  await expect(panel).toContainText("Recorded as nodule 1.");
  const row = (await page.evaluate(() => JSON.parse(localStorage.getItem("lung.recorded.v5") ?? "[]")))[0];
  expect(row).toMatchObject({ painted: 2, axes_edited: true, long_mm: axes.long_mm, clicks: 1, corrections: 0 });
  await expect.poll(() => lines().slice(before).filter((e) => e.action === "record").map((e) => [e.painted, e.axes_edited])).toEqual([[2, true]]);
  console.log(`slice 5 row: painted ${row.painted}, axes_edited ${row.axes_edited}, long ${row.long_mm} mm, volume ${row.volume_ml} mL`);
});

test("slice 5: an axis end is dragged only in Axes mode; Add-mode presses there are clicks; Paint and Axes presses never reach the model; U says what it undoes", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const idle = () => expect(panel.getByRole("button", { name: "Start over (S)" })).toBeEnabled(); // no engine request pending
  const post = (path: string) => page.waitForResponse((r) => r.url().includes(path) && r.request().method() === "POST", { timeout: 30_000 });
  const screen = async (vy: number, vx: number) => { const b = (await canvas.boundingBox())!; return [Math.round(b.x + ((vx + 0.5) / 512) * b.width), Math.round(b.y + ((vy + 0.5) / 512) * b.height)]; };
  const sent: string[] = []; // every engine request that changes the nodule, in order
  page.on("request", (r) => { const m = /\/api\/(nodule\/\w+|scans\/[^/]+\/nodules)$/.exec(r.url()); if (r.method() === "POST" && m) sent.push(m[1].replace(/^scans\/[^/]+\//, "")); });
  const hold = async (path: string) => { // the next request to path waits until the returned function is called
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    await page.route(`**/api/${path}`, async (route) => { await gate; await route.continue(); }, { times: 1 });
    return go;
  };

  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  await imageReady(page);
  let responded = post("/nodules");
  await page.mouse.click(...(await screen(y, x)) as [number, number]);
  const first = await (await responded).json();
  await expect(panel).toContainText(`Volume ${first.volume_ml.toFixed(2)} mL`, { timeout: 60_000 });
  await page.keyboard.press("g");
  await expect(canvas).toHaveAttribute("data-z", String(first.axis_z));

  // Add mode: a still press on the long axis's end is a + click there; a 2 px wobble is a + click at the release point, as before slice 5.
  const end = await screen(...first.long_line[0] as [number, number]);
  responded = post("/nodule/clicks");
  await page.mouse.click(end[0], end[1]);
  const still = (await responded).request().postDataJSON();
  await idle();
  responded = post("/nodule/clicks");
  await page.mouse.move(end[0], end[1]); await page.mouse.down(); await page.mouse.move(end[0] + 2, end[1], { steps: 2 }); await page.mouse.up();
  const wobble = (await responded).request().postDataJSON();
  await idle();
  const b = (await canvas.boundingBox())!;
  expect(still).toMatchObject({ z: first.axis_z, y: Math.floor(((end[1] - b.y) / b.height) * 512), x: Math.floor(((end[0] - b.x) / b.width) * 512), positive: true });
  expect(wobble).toMatchObject({ z: first.axis_z, y: Math.floor(((end[1] - b.y) / b.height) * 512), x: Math.floor(((end[0] + 2 - b.x) / b.width) * 512), positive: true });
  expect(sent).toEqual(["nodules", "nodule/clicks", "nodule/clicks"]); // no axis drag
  console.log(`slice 5 add-mode presses on the axis end: still ${JSON.stringify(still)}, wobble ${JSON.stringify(wobble)}`);

  // Paint: a press made while a stroke is pending, released after the answer, sends nothing to the model.
  await page.keyboard.press("p");
  const goPaint = await hold("nodule/paint");
  const [a, c] = [await screen(y - 35, x - 3), await screen(y - 35, x + 3)]; // above the outline: the stroke adds pixels
  responded = post("/nodule/paint");
  await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move(c[0], c[1], { steps: 4 }); await page.mouse.up();
  await expect(panel).toContainText("Updating the outline…");
  await page.mouse.move(...(await screen(y, x)) as [number, number]);
  await page.mouse.down(); // pressed while the stroke is pending
  goPaint();
  await responded;
  await idle();
  await page.mouse.up(); // the click this release makes must not reach the model
  await page.waitForTimeout(1_000);
  expect(sent.slice(3)).toEqual(["nodule/paint"]);

  // A stroke that changes nothing (Erase where there is no outline) is refused: the engine's text in the status line, nothing else changes.
  await page.keyboard.press("e");
  const [e0, e1] = [await screen(y + 40, x - 3), await screen(y + 40, x + 3)];
  responded = post("/nodule/paint");
  await page.mouse.move(e0[0], e0[1]); await page.mouse.down(); await page.mouse.move(e1[0], e1[1], { steps: 4 }); await page.mouse.up();
  expect((await responded).status()).toBe(400);
  await expect(panel.getByRole("alert")).toHaveText("That stroke changed nothing.");
  await idle();

  // U says what it takes back: the stroke needs no model ("Updating"), the click before it does ("Outlining").
  for (const text of ["Updating the outline…", "Outlining… about"]) {
    const go = await hold("nodule/undo");
    responded = post("/nodule/undo");
    await page.keyboard.press("u");
    await expect(panel).toContainText(text);
    go();
    await responded;
    await idle();
  }

  // Axes mode: a press away from the handles does nothing.
  await page.keyboard.press("x");
  await expect(panel).toContainText("Drag an end of an axis line on the largest slice.");
  const n = sent.length;
  await page.mouse.click(...(await screen(y, x)) as [number, number]);
  await page.waitForTimeout(1_000);
  expect(sent.slice(n)).toEqual([]);
  await page.keyboard.press("s"); // Start over: the next nodule starts in Add mode
  await expect(panel.getByRole("button", { name: "Add (A)" })).toHaveAttribute("aria-pressed", "true");
});

// Follow-up (F): record N1 on the test scan, then on the retest scan Find proposes where it is; Measure here or a click of the researcher's own.
const followup = async (page: import("@playwright/test").Page) => {
  const eventsFile = "test-results/engine-runs/events.jsonl";
  const lines = () => { try { return readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ \d+$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const test_ = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const marks = page.locator('canvas[aria-label="Axis lines and click marks"]');
  const panel = page.getByRole("region", { name: "Measurements" });
  const earlier = panel.getByRole("group", { name: "Earlier nodules" });
  const post = (path: string) => page.waitForRequest((r) => r.url().includes(path) && r.method() === "POST", { timeout: 30_000 });
  await page.getByRole("slider").fill(String(test_.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${test_.instance_numbers[z]} / 265`);
  await imageReady(page);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await expect(earlier).toHaveCount(0); // nothing changes on a test scan
  const recorded = page.waitForResponse((r) => r.url().includes("/nodule/record"));
  await page.keyboard.press("Enter");
  const file1: string = (await (await recorded).json()).outline_file;
  await expect(panel).toContainText("Recorded as nodule 1.");

  await page.getByLabel("Scan").selectOption("RIDER-1286684383_retest");
  const retest = await (await page.request.get("/api/scans/RIDER-1286684383_retest")).json();
  await expect(earlier).toContainText(/N1 · Image \d+ on test/, { timeout: 60_000 });
  const mapped = page.waitForResponse((r) => r.url().includes("/map?"), { timeout: 120_000 });
  await earlier.getByRole("button", { name: "Find N1" }).click();
  const m = await (await mapped).json();
  expect(m.outside).toBeUndefined();
  await expect(panel).toContainText("N1? Check here.");
  await expect(counter).toHaveText(`Image ${retest.instance_numbers[m.z]} / ${retest.shape[0]}`);
  await expect.poll(() => marks.getAttribute("data-target")).toMatch(/^\[/); // the ring is drawn on this image
  await expect(canvas).toHaveAttribute("data-z", String(m.z)); // and the image itself has arrived
  const rows = () => page.evaluate(() => JSON.parse(localStorage.getItem("lung.recorded.v5") ?? "[]"));
  return { lines, before, m, file1, panel, earlier, marks, post, rows };
};

test("slice 6: the follow-up scan proposes N1, Measure here outlines it there, the row follows N1", async ({ page }) => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  const { lines, before, m, file1, panel, post, rows } = await followup(page);
  console.log(`slice 6 map: ${JSON.stringify(m)} (Find to proposal ${((Date.now() - t0) / 1000).toFixed(1)} s including the test record)`);
  await page.screenshot({ path: "e2e/screenshots/slice6.png" });

  const started = post("/nodules");
  await page.keyboard.press("m"); // Measure here
  expect((await started).postDataJSON()).toEqual({ z: m.z, y: m.y, x: m.x }); // exactly the proposed voxel
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await expect(panel).not.toContainText("N1? Check here."); // the proposal is used

  const rec = post("/nodule/record");
  await page.keyboard.press("Enter");
  expect((await rec).postDataJSON()).toMatchObject({ follows: file1, map_distance_mm: 0 });
  await expect(panel).toContainText("Recorded as nodule 1.");
  const row = (await rows()).find((r: { series: string }) => r.series === "retest");
  expect(row.follows).toBe(file1);
  await expect.poll(() => lines().slice(before).filter((e) => ["followup_confirm", "record"].includes(e.action)).map((e) => [e.action, e.scan, e.follows, e.map_distance_mm]))
    .toEqual([["record", "RIDER-1286684383_test", undefined, undefined], ["followup_confirm", "RIDER-1286684383_retest", file1, undefined], ["record", "RIDER-1286684383_retest", file1, 0]]);
  console.log(`slice 6 row: follows ${row.follows}, volume ${row.volume_ml} mL; map ${JSON.stringify(lines().slice(before).find((e) => e.action === "map"))}`);
});

test("slice 6: a refused Measure here logs nothing, a click away logs followup_moved, Start over keeps the link, no proposal follows nothing", async ({ page }) => {
  test.setTimeout(300_000);
  const { lines, before, file1, panel, earlier, marks, post, rows } = await followup(page);
  const follow = () => lines().slice(before).filter((e) => e.action.startsWith("followup_"));
  const [px, py] = JSON.parse((await marks.getAttribute("data-target"))!), box = (await marks.boundingBox())!;
  const clickAt = async (dx: number, dy: number) => {
    await imageReady(page);
    const started = post("/nodules");
    await page.mouse.click(Math.round(box.x + px + dx), Math.round(box.y + py + dy));
    const p = (await started).postDataJSON();
    await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
    return p;
  };

  // The engine refuses the Measure here start (air): no follow-up event, the proposal stays.
  const air = "No outline here: that point is air. Click on the nodule itself.";
  await page.route("**/nodules", (r) => r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ detail: air }) }), { times: 1 });
  await page.keyboard.press("m");
  await expect(panel).toContainText(air);
  await expect(earlier.getByRole("button", { name: "Measure here (M)" })).toBeVisible();
  // Then a normal click 10 px away: exactly one follow-up event, followup_moved.
  const p1 = await clickAt(-10, 0);
  await expect.poll(follow).toHaveLength(1);
  expect(follow()[0]).toMatchObject({ action: "followup_moved", scan: "RIDER-1286684383_retest", follows: file1 });
  expect(follow()[0].distance_mm).toBeGreaterThan(0);
  console.log(`slice 6 moved: click ${JSON.stringify(p1)}, ${follow()[0].distance_mm} mm from the proposal`);

  // Measure here, Start over, then a click with no proposal on screen: the nodule still follows N1, at the new click's distance.
  await page.keyboard.press("s");
  await earlier.getByRole("button", { name: "Find N1" }).click();
  await expect(panel).toContainText("N1? Check here.");
  await page.keyboard.press("m");
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await expect.poll(follow).toHaveLength(2);
  expect(follow()[1]).toMatchObject({ action: "followup_confirm", follows: file1 });
  await page.keyboard.press("s");
  await expect(panel).toContainText("Click a nodule to outline it.");
  await expect(marks).toHaveAttribute("data-target", ""); // no ring: the proposal is gone, the link is kept
  await clickAt(-5, 5);
  await expect.poll(follow).toHaveLength(3);
  const moved = follow()[2];
  expect(moved).toMatchObject({ action: "followup_moved", follows: file1 });
  expect(moved.distance_mm).toBeGreaterThan(0);
  expect(moved.distance_mm).not.toBe(follow()[0].distance_mm);
  const rec = post("/nodule/record");
  await page.keyboard.press("Enter");
  expect((await rec).postDataJSON()).toEqual({ scan: "RIDER-1286684383_retest", nodule: expect.any(Number), follows: file1, map_distance_mm: moved.distance_mm });
  await expect(panel).toContainText("Recorded as nodule 1.");

  // New nodule: no proposal and no link, so the next nodule follows nothing.
  await page.keyboard.press("n");
  await clickAt(-10, 0);
  const rec2 = post("/nodule/record");
  await page.keyboard.press("Enter");
  expect((await rec2).postDataJSON()).toEqual({ scan: "RIDER-1286684383_retest", nodule: expect.any(Number) });
  await expect(panel).toContainText("Recorded as nodule 2.");
  expect((await rows()).filter((r: { series: string }) => r.series === "retest").map((r: { follows: string }) => r.follows)).toEqual([file1, ""]);
  expect(follow()).toHaveLength(3);
});

// No layout shift: from the first click on, in every mode and with a refused click, the controls under the numbers keep their place.
test("Add, Paint, Undo, Start over and Record keep their place: first outline, every mode, a refused click", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const scan = await (await page.request.get("/api/scans/RIDER-1286684383_test")).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[161]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[161]} / 265`);
  const panel = page.getByRole("region", { name: "Measurements" });
  const places = async () => {
    const out: string[] = [];
    for (const name of ["Add (A)", "Paint (P)", "Undo (U)", "Start over (S)", "Record nodule (Enter)"]) {
      const b = (await panel.getByRole("button", { name, exact: true }).boundingBox())!;
      out.push(`${name} at ${Math.round(b.x)},${Math.round(b.y)}`);
    }
    return out;
  };
  const click = async (vy: number, vx: number) => {
    const box = (await page.locator('canvas[aria-label="CT slice"]').boundingBox())!;
    await page.mouse.click(Math.round(box.x + ((vx + 0.5) / 512) * box.width), Math.round(box.y + ((vy + 0.5) / 512) * box.height));
  };
  const idle = await places();
  await click(321, 330);
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 30_000 });
  expect(await places()).toEqual(idle); // the numbers card had their room before they came
  for (const k of ["r", "p", "e", "x", "a"]) {
    await page.keyboard.press(k);
    expect(await places(), `mode ${k}`).toEqual(idle);
  }
  await click(300, 60); // a correction far outside the working box: refused, the outline stays
  await expect(panel.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  expect(await places()).toEqual(idle);
  await expect(panel.getByRole("button", { name: "Start over (S)" })).toBeInViewport({ ratio: 1 }); // in view at 1440 x 900, no scrolling
});
