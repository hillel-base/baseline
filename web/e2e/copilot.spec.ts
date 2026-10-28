import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });
const SCAN = "RIDER-1286684383_test"; // a development patient
const LOG = "test-results/engine-runs/events.jsonl";
const events = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const PICS = process.env.FINDER_PICTURES; // a folder for the pictures of each state (optional)
const imageReady = (page: Page) => expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 }); // ui-b: a click waits for the right image
const pic = (page: Page, name: string) => (PICS ? page.screenshot({ path: `${PICS}/${name}.png` }) : Promise.resolve());

const picker = (page: Page) => page.locator('button[aria-haspopup="dialog"]'); // the Patients button replaced the drop-down on the engine's own page
/** Opens a data-folder scan as a user does (as in slices.spec.ts): the Patients button, the patient, the scan's Open (test is the Baseline, retest the Follow-up). */
async function pick(page: Page, id: string) {
  const [patient, series] = [id.slice(0, id.lastIndexOf("_")), id.slice(id.lastIndexOf("_") + 1)];
  await picker(page).click();
  const sheet = page.getByRole("dialog", { name: "Patients" });
  await sheet.getByRole("button", { name: new RegExp(`^${patient}`) }).click();
  await sheet.getByRole("button", { name: new RegExp(`^Open ${series === "test" ? "Baseline" : "Follow-up"}`) }).click();
  await expect(sheet).toHaveCount(0);
}

async function openScan(page: Page) {
  await page.goto("/");
  await pick(page, SCAN);
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const scan = await (await page.request.get(`/api/scans/${SCAN}`)).json();
  await imageReady(page);
  return { counter, image: (k: number) => scan.instance_numbers[k] as number };
}

test("finder: the button's states, the list opens once, rings and ticks, Go to it, Not a nodule and Undo, Measure, Esc and Close", async ({ page }) => {
  test.setTimeout(240_000);
  const before = events().length;
  const { counter, image } = await openScan(page);
  const find = page.getByRole("button", { name: "Find nodules" });
  await expect(find).toBeVisible();
  await pic(page, "1-button-find-nodules");

  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Zoom in (+)" }).click(); // Go to it must keep this zoom
  const zoom = await page.getByRole("status", { name: "Zoom" }).innerText();
  await find.click();
  const looking = page.getByRole("button", { name: "Looking… up to 30 s" });
  await expect(looking).toBeDisabled();
  await pic(page, "2-button-looking");
  const button = page.getByRole("button", { name: /^Suggestions 4/ });
  const list = page.getByRole("region", { name: "Suggestions to check" });
  await expect(list).toBeVisible({ timeout: 60_000 }); // the answer to the press opens the list, once
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("status").filter({ hasText: "4 suggestions" })).toHaveCount(1);
  const ticks = page.locator(".m-tick");
  await expect(ticks).toHaveCount(3); // 2 and 4 lie on nearby images: one tick
  expect(await ticks.evaluateAll((t) => t.map((e) => [e.textContent, (e as HTMLElement).dataset.ranks]))).toEqual([["3", "3"], ["1", "1"], ["2·4", "2,4"]]); // head at the top
  await pic(page, "3-list-opened-after-find");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await pic(page, "4-button-suggestions-4");
  await button.click();
  await expect(list).toBeVisible();
  await expect(list).toContainText("Finder: YOLO11n, 2.5D (Chou et al., 2026)");
  await expect(list).toContainText("Suggestions, not findings. It can miss nodules larger than about 3 cm. Read the whole scan as usual.");
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  for (const [i, k] of [[0, 161], [1, 100], [2, 212], [3, 102]]) await expect(rows.nth(i)).toContainText(`Image ${image(k)}Go to it`);
  expect(await page.locator("body").innerText()).not.toMatch(/score|0\.90|0\.60|0\.50/); // no raw score anywhere

  const marks = page.locator('canvas[aria-label="Axis lines and click marks"]');
  const rings = () => marks.evaluate((c: HTMLCanvasElement) => ({ w: c.clientWidth, h: c.clientHeight, r: JSON.parse(c.dataset.suggestions || "[]") as number[][] }));
  await rows.nth(1).getByRole("button", { name: /^Image/ }).click(); // Go to it
  await expect(counter).toHaveText(`Image ${image(100)} / 265`);
  await expect(rows.nth(1)).toContainText("You are here");
  await expect.poll(async () => { const { w, h, r } = await rings(); return r.length === 1 && r[0][0] === 2 && Math.abs(r[0][1] / w - 0.5) < 0.03 && Math.abs(r[0][2] / h - 0.5) < 0.03; }).toBe(true); // ring 2, centred
  expect(await page.getByRole("status", { name: "Zoom" }).innerText()).toBe(zoom);
  await expect.poll(() => page.locator('canvas[aria-label="CT slice"]').evaluate((c) => (c as HTMLCanvasElement).dataset.z)).toBe("100"); // the image itself has arrived
  await pic(page, "5-dropdown-open-ring-2");

  await rows.nth(1).getByRole("button", { name: /^Image/ }).focus();
  await page.keyboard.press("Escape"); // closed from the keyboard: focus back on the button
  await expect(list).toBeHidden();
  await expect(button).toBeFocused();
  await button.blur();
  await pic(page, "6-ring-and-merged-tick");
  await button.click();
  await list.getByRole("button", { name: "How accurate?" }).click();
  await expect(list).toContainText("How accurate is the finder?");
  await expect(list).toContainText("It made about 2 extra marks per scan.");
  await expect(list).toContainText("The finder is its own program under AGPL-3.0; its weights are under CC BY 4.0. Its source code: github.com/hillel-base/baseline, the finder/ folder.");
  await expect(list.getByRole("link", { name: "github.com/hillel-base/baseline" })).toHaveAttribute("href", "https://github.com/hillel-base/baseline"); // the AGPL source
  await pic(page, "7-how-accurate-open");
  await list.getByRole("button", { name: "How accurate?" }).click();
  await expect(list).not.toContainText("How accurate is the finder?");

  await rows.nth(2).getByRole("button", { name: "Not a nodule" }).click();
  await expect(rows.nth(2)).toContainText("Marked not a nodule");
  await expect(rows.nth(2).getByRole("button", { name: "Measure" })).toHaveCount(0);
  const tick3 = page.locator('.m-tick[data-ranks="3"]');
  await expect(tick3).toHaveClass(/off/);
  await pic(page, "8-not-a-nodule-with-undo");
  await rows.nth(2).getByRole("button", { name: "Undo" }).click();
  await expect(rows.nth(2)).toContainText("Go to it");
  await expect(tick3).not.toHaveClass(/off/);

  const started = page.waitForRequest((q) => q.url().includes("/nodules") && q.method() === "POST");
  await rows.nth(0).getByRole("button", { name: "Measure" }).click(); // from another image: it goes there and outlines
  expect((await started).postDataJSON()).toEqual({ z: 161, y: 321, x: 330 }); // exactly the suggestion's voxel
  await expect(counter).toHaveText(`Image ${image(161)} / 265`);
  await expect.poll(async () => { const { w, h, r } = await rings(); return r.length === 1 && r[0][0] === 1 && Math.abs(r[0][1] / w - 0.5) < 0.03 && Math.abs(r[0][2] / h - 0.5) < 0.03; }).toBe(true); // centred there too
  await expect(page.getByRole("region", { name: "Measurements" })).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await expect(list).toBeVisible(); // a press inside keeps it open
  // the outline is open and not recorded: no Measure may drop it, as the follow-up's Measure here
  await expect(list).toContainText("Record this nodule or start a new one to measure another.");
  for (const i of [0, 1]) await expect(rows.nth(i).getByRole("button", { name: "Measure" })).toBeDisabled();
  await expect(rows.nth(1).getByRole("button", { name: "Not a nodule" })).toBeEnabled();
  await page.screenshot({ path: "e2e/screenshots/copilot.png" });
  await pic(page, "9-measured-suggestion-1");
  await list.getByRole("button", { name: "Close" }).click();
  await expect(list).toBeHidden();
  await expect(button).not.toBeFocused(); // a mouse press leaves focus nowhere: Enter still records

  // Record: the suggestion it started from is measured (green row, solid green ring); Undo of the Record brings it back
  await page.getByRole("button", { name: "Record nodule (Enter)" }).click();
  await expect(page.getByRole("button", { name: "Undo this Record" })).toBeVisible({ timeout: 30_000 });
  await button.click();
  await expect(rows.nth(0)).toContainText(/Measured · nodule \d+$/);
  await expect(rows.nth(0).getByRole("button", { name: /^(Measure|Not a nodule)$/ })).toHaveCount(0);
  await expect(rows.nth(1).getByRole("button", { name: "Measure" })).toBeEnabled(); // recorded: nothing open to drop
  await expect.poll(async () => (await rings()).r.map((x) => x[3])).toEqual([1]);
  await pic(page, "10-recorded-measured-green");
  await page.getByRole("button", { name: "Undo this Record" }).click();
  await expect(list).toBeHidden(); // a press outside
  await button.click();
  await expect(rows.nth(0)).toContainText("You are here");
  await expect(rows.nth(0).getByRole("button", { name: "Measure" })).toBeEnabled();
  await expect.poll(async () => (await rings()).r.map((x) => x[3])).toEqual([0]);

  // A hand click at a suggestion, no Measure: the engine finds its voxel inside the recorded outline, so it is measured too; Undo turns it back
  await rows.nth(1).getByRole("button", { name: /^Image/ }).click(); // Go to suggestion 2
  await expect(counter).toHaveText(`Image ${image(100)} / 265`);
  await expect.poll(async () => (await rings()).r.map((x) => x[0])).toEqual([2]);
  const [{ r }, mb] = [await rings(), (await marks.boundingBox())!];
  await page.keyboard.press("Escape");
  await page.mouse.click(mb.x + r[0][1], mb.y + r[0][2]); // the ring's centre: the suggestion's voxel
  await expect(page.getByRole("region", { name: "Measurements" })).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  const rec = page.waitForResponse((q) => q.url().includes("/nodule/record"));
  await page.getByRole("button", { name: "Record nodule (Enter)" }).click();
  expect((await (await rec).json()).suggestions).toContain(2);
  await button.click();
  await expect(rows.nth(1)).toContainText(/Measured · nodule \d+$/);
  await expect.poll(async () => (await rings()).r.map((x) => x[3])).toEqual([1]);
  await pic(page, "10b-hand-click-measured-green");
  await page.getByRole("button", { name: "Undo this Record" }).click();
  await button.click();
  await expect(rows.nth(1)).toContainText("You are here");
  await expect.poll(async () => (await rings()).r.map((x) => x[3])).toEqual([0]);

  await expect.poll(() => events().slice(before).filter((e) => /candidate_/.test(e.action)).map((e) => [e.action, e.scan, e.rank, e.score]))
    .toEqual([["candidate_reject", SCAN, 3, 0.5], ["undo_candidate_reject", SCAN, 3, 0.5], ["candidate_accept", SCAN, 1, 0.9]]);
  expect(events().slice(before).some((e) => e.action === "candidates_found" && e.count === 4 && e.finder === "fake finder")).toBe(true);
});

test("finder: no suggestions says so; a failed run shows the engine's words and Find nodules again", async ({ page }) => {
  await openScan(page);
  await page.route("**/api/scans/*/candidates", (r) => r.fulfill({ json: [] }));
  await page.getByRole("button", { name: "Find nodules" }).click();
  const none = page.getByRole("button", { name: "No suggestions" });
  await expect(page.getByRole("region", { name: "Suggestions to check" })).toContainText("No suggestions on this scan. Read it as usual."); // opened by itself
  await expect(page.locator(".m-tick")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pic(page, "11-button-no-suggestions");

  await pick(page, "RIDER-1286684383_retest"); // a new scan starts at Find nodules
  await expect(page.getByText(/^Image \d+ \/ \d+$/)).toBeVisible({ timeout: 60_000 });
  await page.route("**/api/scans/*/candidates", (r) => r.fulfill({ status: 500, json: { detail: "The finder did not run. The engine's log has the details." } }));
  await page.getByRole("button", { name: "Find nodules" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The finder did not run. The engine's log has the details." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find nodules" })).toBeEnabled();
});

test("finder: a Find on another scan stops the run in progress", async ({ page }) => { // a folder scan's marks: the Patients panel test (slices.spec.ts)
  test.setTimeout(240_000);
  const before = events().length;
  await openScan(page);
  const flag = "e2e/finder-slow.flag"; // fake_finder.py: this run sleeps 30 s, so only a stop ends it in time
  writeFileSync(flag, "");
  try {
    await page.getByRole("button", { name: "Find nodules" }).click();
    await expect.poll(() => existsSync(flag), { timeout: 30_000 }).toBe(false); // the slow run has started
    await pick(page, "RIDER-1286684383_retest");
    await expect(page.getByText(/^Image \d+ \/ \d+$/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "Find nodules" })).toBeVisible(); // nothing of the old run on the new scan
    const t0 = Date.now();
    await page.getByRole("button", { name: "Find nodules" }).click();
    await expect(page.getByRole("button", { name: /^Suggestions 4/ })).toBeVisible({ timeout: 20_000 }); // not "already running", and well before the 30 s
    expect(Date.now() - t0).toBeLessThan(20_000);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(events().slice(before).filter((e) => e.action === "candidates_found").map((e) => e.scan)).toEqual(["RIDER-1286684383_retest"]); // the stopped run kept nothing
  } finally { rmSync(flag, { force: true }); }

});

test("finder: Measure goes to the suggestion's image and starts only once that image is shown; the rings hide with the cue, the ticks stay", async ({ page }) => {
  test.setTimeout(180_000);
  const { counter, image } = await openScan(page);
  await page.getByRole("button", { name: "Find nodules" }).click();
  const list = page.getByRole("region", { name: "Suggestions to check" }), rows = list.getByRole("listitem");
  await expect(list).toBeVisible({ timeout: 60_000 });
  const marks = page.locator('canvas[aria-label="Axis lines and click marks"]');
  const holdSlice = async (z: number) => { // a far server, for this slice only
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route(`**/api/scans/${SCAN}/slices/${z}`, async (r) => { await held; await r.continue(); });
    return release;
  };
  let starts = 0;
  page.on("request", (q) => { if (q.url().includes("/nodules") && q.method() === "POST") starts++; });

  const release = await holdSlice(161); // suggestion 1's image
  await rows.nth(0).getByRole("button", { name: "Measure" }).click();
  await expect(counter).toHaveText(`Image ${image(161)} / 265`);
  await expect(page.getByText(`Loading image ${image(161)}…`, { exact: true })).toBeVisible();
  await expect(marks).toHaveCSS("visibility", "hidden"); // the rings hide like every other overlay
  await expect(page.locator(".m-tick")).toHaveCount(3); // the slice-bar ticks are not on the image: they stay
  await page.waitForTimeout(1500);
  expect(starts).toBe(0); // another image is on screen: nothing starts
  const started = page.waitForRequest((q) => q.url().includes("/nodules") && q.method() === "POST");
  release();
  expect((await started).postDataJSON()).toEqual({ z: 161, y: 321, x: 330 });
  expect(await page.locator('canvas[aria-label="CT slice"]').evaluate((c) => (c as HTMLCanvasElement).dataset.z)).toBe("161"); // started on its own image
  await expect(page.getByRole("region", { name: "Measurements" })).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await expect(marks).not.toHaveCSS("visibility", "hidden");

  // Measure, then a scroll away before the image lands: nothing starts, and the page is free again
  await page.getByRole("button", { name: /^New nodule/ }).click();
  const release2 = await holdSlice(100); // suggestion 2's image
  if (!(await list.isVisible())) await page.getByRole("button", { name: /^Suggestions 4/ }).click();
  await rows.nth(1).getByRole("button", { name: "Measure" }).click();
  await expect(counter).toHaveText(`Image ${image(100)} / 265`);
  const before = starts;
  await page.keyboard.press("ArrowUp");
  await expect(counter).not.toHaveText(`Image ${image(100)} / 265`);
  await imageReady(page);
  release2();
  await page.waitForTimeout(1500);
  expect(starts).toBe(before);
  await expect(page.getByRole("button", { name: /^Record nodule/ })).toBeDisabled();
  if (!(await list.isVisible())) await page.getByRole("button", { name: /^Suggestions 4/ }).click();
  await expect(rows.nth(1).getByRole("button", { name: "Measure" })).toBeEnabled(); // not stuck waiting
});

test("finder: a press on the image while the list is open only closes the list; the next one is a click", async ({ page }) => {
  await openScan(page);
  await page.getByRole("button", { name: "Find nodules" }).click();
  const list = page.getByRole("region", { name: "Suggestions to check" });
  await expect(list).toBeVisible({ timeout: 60_000 });
  let starts = 0;
  page.on("request", (q) => { if (q.url().includes("/nodules") && q.method() === "POST") starts++; });
  const box = (await page.locator('canvas[aria-label="CT slice"]').boundingBox())!;
  const [x, y] = [box.x + box.width * 0.3, box.y + box.height * 0.6]; // away from the list
  await page.mouse.click(x, y);
  await expect(list).toBeHidden();
  await page.waitForTimeout(1500);
  expect(starts).toBe(0); // no outline started
  await page.mouse.click(x, y);
  await expect.poll(() => starts).toBe(1); // with the list closed, a press is a click again
});

test("finder off: no button, nothing else", async ({ page }) => {
  await page.route("**/api/copilot", (r) => r.fulfill({ json: { enabled: false, finder: null } }));
  await openScan(page);
  await expect(page.getByRole("button", { name: "Find nodules" })).toHaveCount(0);
  await expect(page.locator(".m-tick")).toHaveCount(0);
});
