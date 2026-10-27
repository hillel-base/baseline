import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { WAITING_LOCAL } from "../src/texts";

const imageReady = (page: Page) => expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 }); // a click waits for the right image

const PORT = process.env.LUNG_E2E_PORT ?? "8205"; // the same default as playwright.config.ts
test.use({ viewport: { width: 1440, height: 900 } });
async function outline(page: Page) {
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 }); // "Your own computer · Change"
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330]; // the expert outline's deepest voxel, as in slices.spec
  const scan = await (await page.request.get(`http://localhost:${PORT}/api/scans/RIDER-1286684383_test`)).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[z]));
  await expect(counter).toHaveText(`Image ${scan.instance_numbers[z]} / 265`);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  await expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 }); // a click counts once the image is in
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  const panel = page.getByRole("region", { name: "Measurements" });
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  return panel;
}
const SIGNED_OUT = () => localStorage.setItem("lung.fake.signedOut", "1");
const LOCAL_LINE = /^Your own computer · Change/; // the top line on the local engine, from its start: waiting rows may follow on its right
// The stand-in practice servers the hosted e2e builds list (playwright.config.ts). A test that does not answer for one gets a refused
// connection, so no request leaves this machine, not even a DNS lookup.
const PRACTICE = "https://practice.example";
const NO_ENGINE = "No engine found on this computer. Start it (see Run it on your computer), then try again."; // the hosted page's own text
test.beforeEach(({ page }) => page.route(/^https:\/\/practice(-2)?\.example\//, (r) => r.abort()));

test("hosted: signed in, three tabs, no localhost call before the button, then live and a click outlines", async ({ page }) => {
  test.setTimeout(240_000);
  const toEngine: string[] = [];
  page.on("request", (r) => { if (r.url().includes(`localhost:${PORT}`)) toEngine.push(r.url()); });

  await page.goto("/");
  await expect(page.getByText("Signed in as test-user")).toBeVisible();
  for (const t of ["Measure", "Study table", "Demo"]) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("img", { name: "Baseline, lung nodule measurement on CT" })).toBeVisible(); // the logo, not a text title
  await expect(page).toHaveTitle("Baseline");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /favicon.*\.svg$/);
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible(); // this build lists a practice server
  await expect(page.locator("footer").getByText("Research use only. Not a medical device.")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(toEngine).toEqual([]); // (b) nothing before the click

  await page.getByRole("tab", { name: "Demo" }).click();
  await expect(page.getByText("Demo: recorded results on development cases, not a live model.")).toBeVisible();
  await page.getByRole("tab", { name: "Measure" }).click();

  const panel = await outline(page);
  expect(await panel.textContent()).toMatch(/Long axis \d+\.\d mm/); // label and value sit on two lines: read the text, not the layout
  expect(toEngine.length).toBeGreaterThan(0);
  // Another tab and back: the hidden viewer measured 0 x 0, so the click mark must be drawn again.
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const marks = page.getByLabel("Axis lines and click marks");
  const markPixels = () => marks.evaluate((c: HTMLCanvasElement) => (c.width === 0 ? 0 : c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 3 && v > 0).length));
  expect(await markPixels()).toBeGreaterThan(0);
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByText("No measurements yet")).toBeVisible();
  await expect(page.getByText("Every Record saved on Base44. Numbers only: names and dates stay on your computer.")).toBeVisible();
  await page.setViewportSize({ width: 1300, height: 900 }); // a resize while hidden redraws the marks at 0 x 0
  await page.getByRole("button", { name: "Go to Measure" }).click();
  await expect(page.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/);
  await expect.poll(markPixels).toBeGreaterThan(0);
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(300);
  await page.screenshot({ path: "e2e/screenshots/hosted-measure.png" });
});

test("hosted: a failed probe shows the no-engine message, whose Run it on your computer link opens the install view", async ({ page }) => {
  await page.route(`http://localhost:${PORT}/**`, (r) => r.abort());
  await page.goto("/");
  const t0 = Date.now();
  await page.getByRole("button", { name: "Use my local engine" }).click();
  const alert = page.getByRole("alert").filter({ hasText: NO_ENGINE });
  await expect(alert).toHaveText(NO_ENGINE);
  expect(Date.now() - t0).toBeLessThan(3000); // a refused connection fails at once: the longer local limit costs nothing here
  await alert.getByRole("link", { name: "Run it on your computer" }).click();
  await expect(page.getByRole("region", { name: "Run it on your computer" })).toBeVisible();
  expect(page.context().pages()).toHaveLength(1);
});

test("hosted: the local connect waits for a slow first answer, as while Chrome asks about apps on this device", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route(`http://localhost:${PORT}/api/info`, async (r) => {
    await new Promise((done) => setTimeout(done, 7000)); // longer than the 5 s the local probe used to allow
    await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin },
      body: JSON.stringify({ commit: "slow123", model: "m", width_method: "edge", device: "cpu" }) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: WAITING_LOCAL })).toBeVisible(); // the designed wait (gate minor 1), with its spinner
  await page.screenshot({ path: "e2e/screenshots/hosted-waiting-local.png" });
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(NO_ENGINE)).toHaveCount(0);
});

test("hosted: signed out, the sign-in redirect is called and no tab shows", async ({ page }) => {
  await page.addInitScript(SIGNED_OUT);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fakeSignIn?: number }).__fakeSignIn)).toBe(1);
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /Baseline/ })).toHaveCount(0); // no header before sign-in
});

test("hosted: signed in but not invited, the one sign-in bounce then shows the invite-only line on the tool's dark card, and Sign out", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lung.fake.notInvited", "1"));
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __fakeSignIn?: number }).__fakeSignIn)).toBe(1);
  await page.reload(); // as the return from Base44's sign-in page
  const card = page.getByRole("region", { name: "Sign-in" });
  await expect(card.getByRole("alert")).toHaveText("You are signed in, but this app is invite-only. Ask the app's admin for an invite.");
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgb(255, 255, 255)"); // the tool's dark page, not a bare one
  await page.screenshot({ path: "e2e/screenshots/hosted-invite-only.png" });
  await card.getByRole("button", { name: "Sign out" }).click(); // to try another account
  await expect.poll(() => page.evaluate(() => localStorage.getItem("lung.fake.signedOut"))).toBe("1");
});

// The only keys of ours on this origin are the waiting rows' (lung.waiting.<key>, one per row), and only while a save waits
// (the fake client's own lung.fake.* keys aside).
const ours = (page: Page) => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("lung.") && !k.startsWith("lung.fake")));
const LEFT = "1 row is still waiting to be saved. It is saved when you sign in again on this computer.";
const BANNER = "These come from public practice scans and are kept apart from the study record.";
const practiceSwitch = (page: Page) => page.getByRole("switch", { name: "Practice rows" });
const RIDER_N1 = /RIDER-1286684383.*N1/;
const NOT_SAVED = "Recorded on this computer. Not saved to the study table yet; trying again every 15 s.";
const events = () => { try { return readFileSync("test-results/engine-runs/events.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("hosted: Record saves to the study table; with only practice rows, they show under the banner; Remove with a reason takes the row out", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Saved to the study table.");
  await expect(page.getByRole("heading", { name: "This browser's table" })).toBeVisible();
  await expect(page.getByText("Kept in this browser tab only. Reloading empties it. The Study table is the lasting record.")).toBeVisible();
  await page.getByRole("button", { name: /^This browser's table/ }).click(); // open and resize the table: kept in memory only here
  await page.getByRole("separator", { name: "Resize the recorded-nodules table" }).focus();
  await page.keyboard.press("ArrowUp");
  expect(await ours(page)).toEqual([]); // saved: nothing stays on this origin
  const sent = await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement[0]);
  expect(JSON.stringify(sent)).not.toContain("@"); // no email in what Base44 gets
  expect(sent.approved_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByText(BANNER)).toBeVisible(); // only practice rows: shown by default
  await expect(practiceSwitch(page)).toHaveAttribute("aria-checked", "true");
  const row = page.getByRole("row", { name: RIDER_N1 });
  await expect(page.getByRole("columnheader", { name: "Baseline" })).toBeVisible();
  await expect(row).toContainText(/RIDER-1286684383\s*Practice\s*N1\s*\d+\.\d\s*\d+\.\d\s*\d+\.\d\d\s*Approved/);
  await row.getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("dialog", { name: "Remove N1 of RIDER-1286684383" });
  await expect(menu.getByRole("button", { name: "Remove" })).toBeDisabled(); // no reason chosen yet
  await menu.getByRole("radio", { name: "Wrong nodule" }).check();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removal saved.")).toBeVisible();
  await expect(page.getByText("No measurements yet")).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("table", { name: "History" }).getByRole("row", { name: /RIDER-1286684383/ })).toContainText("Removed: wrong nodule");
});

test("hosted: with a study row in the study table, practice rows are hidden until asked for", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lung.fake.store", JSON.stringify({
    Scan: [{ id: "Scan1", study_code: "a1b2c3d4", timepoint: 0, scan_ref: "lab" }, { id: "Scan2", study_code: "RIDER-1286684383", timepoint: 0, scan_ref: "rider" }],
    NoduleMeasurement: [{ id: "M1", scan_id: "Scan1", nodule_label: "N1", long_axis_mm: 12.3, short_axis_mm: 8.1, volume_ml: 0.61, method: "tool approved", approved_at: "2026-10-27T09:00:00.000Z", practice: false },
      { id: "M2", scan_id: "Scan2", nodule_label: "N1", long_axis_mm: 22.1, short_axis_mm: 12.4, volume_ml: 6.9, method: "tool approved", approved_at: "2026-10-27T09:01:00.000Z", practice: true }],
  })));
  await page.goto("/");
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByRole("row", { name: /a1b2c3d4 N1/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /RIDER-1286684383/ })).toHaveCount(0);
  await expect(page.getByText(/^1 nodule on 1 patient · 1 practice row hidden · "Edited" means/)).toBeVisible();
  await expect(page.getByText(BANNER)).toHaveCount(0);
  await expect(practiceSwitch(page)).toHaveAttribute("aria-checked", "false");
  await practiceSwitch(page).click();
  await expect(page.getByRole("row", { name: RIDER_N1 })).toBeVisible();
});

test("hosted: a failed save is one amber box in plain words, logged by its class, tried again, and turns to saved", async ({ page }) => {
  test.setTimeout(240_000);
  const before = events().length;
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lung.fake.saveFail", "1"));
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel.locator(".m-status.warn")).toHaveText(new RegExp(`^${NOT_SAVED.replace(/[.?]/g, "\\$&")}\\s*Copy row\\s*Save screenshot\\s*Undo$`));
  await expect(page.getByText("Fake save failure")).toHaveCount(0); // no raw error on screen
  await expect(panel.locator(".m-status.ok:not(.warn)")).toHaveCount(0);
  const keys = await ours(page);
  expect([keys.length, keys.every((k) => /^lung\.waiting\.[\w-]+$/.test(k))]).toEqual([1, true]); // only the waiting row's own key
  expect(await page.evaluate((k) => localStorage.getItem(k), keys[0])).not.toContain("@"); // tied to the Base44 user id, never an email
  await expect(page.locator(".shell-user").getByRole("status")).toHaveText(LEFT); // said beside Sign out
  await expect.poll(() => events().slice(before).filter((e) => e.action === "save_failed").map((e) => e.reason)).toEqual(["Error"]);
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByRole("row", { name: RIDER_N1 })).toContainText("Not saved yet"); // shown, marked, until Base44 has it
  await expect(page.getByRole("row", { name: RIDER_N1 }).getByRole("button", { name: "More" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Measure" }).click();
  await page.getByRole("button", { name: /^This browser's table/ }).click(); // the table starts folded
  await expect(page.getByRole("region", { name: "Recorded nodules" }).getByRole("row", { name: /RIDER-1286684383/ })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem("lung.fake.saveFail")); // Base44 is back
  await expect(panel).toContainText("Saved to the study table.", { timeout: 30_000 });
  await expect(panel).toContainText("Recorded as nodule 1.");
  expect(await ours(page)).toEqual([]);
  await expect(page.getByText(LEFT)).toHaveCount(0);
  expect(events().slice(before).filter((e) => e.action === "save_failed")).toHaveLength(1); // logged once, not at every try
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByRole("row", { name: RIDER_N1 })).toContainText("Approved");
  await expect(page.getByText("Not saved yet")).toHaveCount(0);
});

test("hosted: a waiting row survives a reload and is saved then", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lung.fake.saveFail", "1"));
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText(NOT_SAVED);
  await page.evaluate(() => localStorage.removeItem("lung.fake.saveFail"));
  await page.reload(); // before the next try
  await expect.poll(() => ours(page), { timeout: 10_000 }).toEqual([]);
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByRole("row", { name: RIDER_N1 })).toBeVisible();
});

test("hosted: Undo after the save adds a removal row; the Study table drops the row and its history says why", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Saved to the study table.");
  await panel.getByRole("button", { name: "Undo this Record" }).click();
  await expect(panel).toContainText("Record undone. Click the nodule to outline it again.");
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByText("No measurements yet")).toBeVisible();
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("table", { name: "History" }).getByRole("row", { name: /RIDER-1286684383/ })).toContainText("Removed: recorded by mistake");
});

test("hosted: Undo after the Study table removed the Record writes no second removal row, and says so", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Saved to the study table.");
  await page.getByRole("tab", { name: "Study table" }).click();
  await page.getByRole("row", { name: RIDER_N1 }).getByRole("button", { name: "More" }).click();
  const menu = page.getByRole("dialog", { name: "Remove N1 of RIDER-1286684383" });
  await menu.getByRole("radio", { name: "Wrong scan" }).check();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removal saved.")).toBeVisible();
  await page.getByRole("tab", { name: "Measure" }).click(); // a tab change is not a next action: Undo is still there
  await panel.getByRole("button", { name: "Undo this Record" }).click();
  await expect(panel).toContainText("Record undone. It was already removed in the Study table, so nothing more was written.");
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement);
  expect(rows.filter((r: { removed_reason?: string }) => r.removed_reason).map((r: { removed_reason: string }) => r.removed_reason)).toEqual(["wrong scan"]);
});

test("hosted: Undo while the save waits cancels it, and nothing reaches the study table", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lung.fake.saveFail", "1"));
  const panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText(NOT_SAVED);
  await panel.getByRole("button", { name: "Undo this Record" }).click(); // Base44 is still down: this Undo does not need it
  await expect.poll(() => ours(page)).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store") ?? "{}").NoduleMeasurement ?? [])).toEqual([]);
});

test("hosted: a Record at the same place after a reload replaces that row and keeps its label", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  let panel = await outline(page);
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Saved to the study table.");
  await page.reload(); // the page's own numbers restart; the study table's do not
  panel = await outline(page);
  await expect(panel).toContainText("Nodule 2"); // a new nodule would be N2
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText(/This replaces nodule 1 recorded at \d\d:\d\d\./);
  await expect(panel).toContainText("Recorded as nodule 1."); // the same nodule keeps its label
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByRole("row", { name: RIDER_N1 })).toHaveCount(1);
  await page.getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("table", { name: "History" });
  await expect(hist.getByRole("row", { name: /Replaced at \d\d:\d\d/ })).toHaveCount(1);
  await expect(hist.getByRole("row", { name: /Current/ })).toHaveCount(1);
});

test("hosted: with N1 and N2 elsewhere on this scan, a new place is N3 and replaces nothing", async ({ page }) => {
  test.setTimeout(240_000);
  const scan = await (await page.request.get(`http://localhost:${PORT}/api/scans/RIDER-1286684383_test`)).json();
  await page.goto("/");
  await page.evaluate((ref) => localStorage.setItem("lung.fake.store", JSON.stringify({
    Scan: [{ id: "Scan1", study_code: "RIDER-1286684383", timepoint: 0, scan_ref: ref }],
    NoduleMeasurement: [1, 2].map((n) => ({ id: `M${n}`, scan_id: "Scan1", nodule_label: `N${n}`, position_voxel: [20 * n, 60, 60], long_axis_mm: 10, short_axis_mm: 8, volume_ml: 0.5,
      method: "tool approved", approved_at: "2026-10-27T09:00:00.000Z", practice: true })),
  })), scan.scan_ref);
  const panel = await outline(page);
  await expect(panel).toContainText("Nodule 3");
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText("Saved to the study table.");
  await expect(panel).toContainText("Recorded as nodule 3.");
  await expect(panel).not.toContainText("This replaces");
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement);
  expect(rows.map((r: { nodule_label: string; replaces_id?: string }) => [r.nodule_label, r.replaces_id ?? ""])).toEqual([["N1", ""], ["N2", ""], ["N3", ""]]);
});

// Seeded rows only: no engine needed (DEMO_ONLY=1 runs it). N1 has a Baseline and a Follow-up row, N2 a Baseline row.
const seed = (page: Page) => page.addInitScript(() => { if (!localStorage.getItem("lung.fake.store")) localStorage.setItem("lung.fake.store", JSON.stringify({
  Scan: [{ id: "Scan1", study_code: "a1b2c3d4", timepoint: 0, scan_ref: "lab0" }, { id: "Scan2", study_code: "a1b2c3d4", timepoint: 1, scan_ref: "lab1" }],
  NoduleMeasurement: [
    { id: "M1", scan_id: "Scan1", nodule_label: "N1", long_axis_mm: 12.3, short_axis_mm: 8.1, volume_ml: 0.61, method: "tool approved", approved_at: "2026-10-27T09:00:00.000Z", practice: false },
    { id: "M2", scan_id: "Scan2", nodule_label: "N1", long_axis_mm: 13.0, short_axis_mm: 8.4, volume_ml: 0.7, method: "tool edited", approved_at: "2026-10-27T09:05:00.000Z", practice: false },
    { id: "M3", scan_id: "Scan1", nodule_label: "N2", long_axis_mm: 9.4, short_axis_mm: 7.8, volume_ml: 0.31, method: "tool approved", approved_at: "2026-10-27T09:02:00.000Z", practice: false },
  ],
})); });

test("hosted Study table: Remove through the ⋯ menu with a reason; Esc and a click outside close the menu; Both removes both timepoints; focus goes to the next ⋯", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Study table" }).click();
  const n1 = page.getByRole("row", { name: /a1b2c3d4 N1/ });
  await expect(n1).toContainText(/N1\s*12\.3\s*8\.1\s*0\.61\s*Approved\s*13\.0\s*8\.4\s*0\.70\s*Edited/); // Baseline and Follow-up side by side, a Method each
  const more = n1.getByRole("button", { name: "More" });
  const menu = page.getByRole("dialog", { name: "Remove N1 of a1b2c3d4" });
  await more.click();
  await expect(menu).toContainText("It leaves the record; the history keeps it, with the reason.");
  for (const r of ["Wrong nodule", "Wrong scan", "Duplicate", "Recorded by mistake"]) await expect(menu.getByRole("radio", { name: r })).not.toBeChecked(); // no default reason
  await expect(menu.getByRole("button", { name: "Remove" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("heading", { name: "Study table" }).click(); // outside
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  for (const t of ["Baseline", "Follow-up", "Both"]) await expect(menu.getByRole("radio", { name: t, exact: true })).not.toBeChecked(); // no default
  await menu.getByRole("radio", { name: "Duplicate" }).check();
  await expect(menu.getByRole("button", { name: "Remove" })).toBeDisabled(); // a reason, but no timepoint yet
  await menu.getByRole("radio", { name: "Both" }).check();
  await expect(menu.getByRole("button", { name: "Remove" })).toBeEnabled();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removal saved.")).toBeVisible();
  await expect(n1).toHaveCount(0);
  const n2 = page.getByRole("row", { name: /a1b2c3d4 N2/ });
  await expect(n2.getByRole("button", { name: "More" })).toBeFocused(); // the next row's ⋯, not the page
  await page.getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("table", { name: "History" });
  await expect(hist.getByRole("row", { name: /N1.*Removed: duplicate/ })).toHaveCount(2); // both timepoints
  await expect(hist.getByRole("row", { name: /N2.*Current/ })).toHaveCount(1);
});

test("hosted Study table: Remove at one timepoint writes a removal for that timepoint only; with one timepoint left, the menu asks the reason only", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Study table" }).click();
  const n1 = page.getByRole("row", { name: /a1b2c3d4 N1/ }), more = n1.getByRole("button", { name: "More" });
  const menu = page.getByRole("dialog", { name: "Remove N1 of a1b2c3d4" });
  await more.click();
  await menu.getByRole("radio", { name: "Follow-up" }).check();
  await expect(menu.getByRole("button", { name: "Remove" })).toBeDisabled(); // a timepoint, but no reason yet
  await menu.getByRole("radio", { name: "Wrong nodule" }).check();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removal saved.")).toBeVisible();
  await expect(n1).toContainText(/N1\s*12\.3\s*8\.1\s*0\.61\s*Approved\s*⋯$/); // the Baseline stays
  await expect(page.getByRole("columnheader", { name: "Follow-up" })).toHaveCount(0); // no row has a Follow-up now: no group for it
  await expect(more).toBeFocused(); // the same line is still there: its ⋯
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement);
  expect(rows.filter((r: { removed_reason?: string }) => r.removed_reason).map((r: { replaces_id: string; removed_reason: string }) => [r.replaces_id, r.removed_reason])).toEqual([["M2", "wrong nodule"]]);
  await more.click();
  await expect(menu.getByRole("radio", { name: "Baseline" })).toHaveCount(0); // one timepoint: the reason only
  await expect(menu.getByRole("button", { name: "Remove" })).toBeDisabled(); // until one is chosen
  await menu.getByRole("radio", { name: "Duplicate" }).check();
  await expect(menu.getByRole("button", { name: "Remove" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("table", { name: "History" });
  await expect(hist.getByRole("row", { name: /N1.*Follow-up.*Removed: wrong nodule/ })).toHaveCount(1);
  await expect(hist.getByRole("row", { name: /N1.*Baseline.*Current/ })).toHaveCount(1);
});

test("hosted Study table: Both with Base44 down stores both removals at once and says so outside the menu, focus on the ⋯; the row goes once Base44 has them", async ({ page }) => {
  test.setTimeout(90_000);
  await seed(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lung.fake.saveFail", "1"));
  await page.getByRole("tab", { name: "Study table" }).click();
  const n1 = page.getByRole("row", { name: /a1b2c3d4 N1/ }), more = n1.getByRole("button", { name: "More" });
  const menu = page.getByRole("dialog", { name: "Remove N1 of a1b2c3d4" });
  await more.click();
  await menu.getByRole("radio", { name: "Both" }).check();
  await menu.getByRole("radio", { name: "Wrong scan" }).check();
  await menu.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Removal not saved yet; trying again every 15 s.")).toBeVisible();
  await expect(menu).toHaveCount(0); // said outside the menu, which a changed line would take with it
  await expect(more).toBeFocused(); // the line still stands: its ⋯, not the page
  expect(await ours(page)).toHaveLength(2); // both removals stored
  await page.evaluate(() => localStorage.removeItem("lung.fake.saveFail")); // Base44 is back
  await expect(n1).toHaveCount(0, { timeout: 45_000 }); // the table loads again while a removal waits
  await expect(page.getByText("Removal saved.")).toBeVisible();
  expect(await ours(page)).toEqual([]);
});

test("hosted: on the Study table tab the arrow and zoom keys do not reach the hidden Measure viewer, and the page keeps them", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 }); // "Your own computer · Change"
  await page.getByLabel("Scan").selectOption("RIDER-1286684383_test");
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const scan = await (await page.request.get(`http://localhost:${PORT}/api/scans/RIDER-1286684383_test`)).json();
  await page.getByRole("slider").fill(String(scan.instance_numbers[100])); // mid-scan: ArrowDown can move
  const before = `Image ${scan.instance_numbers[100]} / 265`;
  await expect(counter).toHaveText(before);
  await page.getByRole("tab", { name: "Study table" }).click();
  await page.evaluate(() => window.addEventListener("keydown", (e) => { (window as unknown as { __prevented?: boolean }).__prevented = e.defaultPrevented; })); // runs after the viewer's own listener
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  expect(await page.evaluate(() => (window as unknown as { __prevented?: boolean }).__prevented)).toBe(false); // the page scrolls as usual
  for (const k of ["+", "=", "z"]) await page.keyboard.press(k); // the zoom keys too
  await page.getByRole("tab", { name: "Measure" }).click();
  await expect(counter).toHaveText(before);
  await expect(page.getByLabel("Zoom", { exact: true })).toHaveText("100 %");
  await expect(page.getByRole("button", { name: "Zoom to area (Z)" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("ArrowDown"); // on the Measure tab the keys still move through the images
  await expect(counter).not.toHaveText(before);
});

test("hosted Study table: with no rows, the empty state's Go to Measure opens the Measure tab", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(page.getByText("Record a nodule on the Measure screen, and it appears here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to Measure" }).click();
  await expect(page.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible(); // this build lists a practice server
});

// The practice server. The hosted e2e build lists the stand-in origin PRACTICE (top of this file); page.route answers for it.
const INFO = (busy: boolean, signedIn: boolean) => signedIn // the engine's open answer is minimal; a signed-in caller gets it all
  ? { commit: "fake123", model: "fake", width_method: "edge to edge", device: "cuda", server: { busy, idle_min: 10 } }
  : { commit: "fake123", server: { busy, idle_min: 10 } };
const TOKEN = "Bearer fake-base44-token";
const TEXT = {
  title: "Choose where the tool runs",
  fast: "nothing to install, about 1 s per click",
  slow: "On a standard computer without a graphics card, a click takes about 20 s (our test).",
  live: "Practice server", // the name only
  paused: "The practice server is paused right now.",
  starting: "The practice server is starting. This takes about 4 minutes; the page connects by itself.",
  unreachable: "The practice server is starting or cannot be reached. We will try again.",
  busy1: "The practice server is in use. It is free again after 10 minutes without use.",
  busy2: "Both practice servers are in use. One is free again after 10 minutes without use.",
  stopped: "The practice server stopped answering. Try again in a minute.",
  demo: "Demo: recorded results on development cases, not a live model.",
};
const INSTALL = "#install"; // opens Run it on your computer in the page (no link out of the page)
const LIVE_LINE = new RegExp(`^${TEXT.live} · Change`); // the line from its start (with Change): "practice server" is also in the card's and the stop's texts

const shot = (page: Page, state: string) => page.screenshot({ path: `e2e/screenshots/practice-${state}.png` });
type Answer = { status: number; body: unknown } | "hang" | "abort";
const engine = (busy: boolean) => (auth?: string): Answer => ({ status: 200, body: INFO(busy, !!auth) });
const SCANS = { status: 200, body: [{ id: "RIDER-1286684383_test", patient: "RIDER-1286684383", series: "test" }] };
/** Stands in for a practice server at `origin`: `info` answers /api/info (given the request's Authorization), `api` every other path (default: one practice scan).
 * Records each request's path and Authorization. Playwright answers every CORS preflight itself, so a 503 page here fails any request that
 * would have needed one (one with Authorization), the way a browser does when Hugging Face answers the preflight with its 503 too. */
async function practice(page: Page, info: Answer | ((auth?: string) => Answer), api?: (path: string) => Answer, origin = PRACTICE) {
  const seen: { path: string; auth: string | undefined }[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname, auth = req.headers()["authorization"];
    seen.push({ path, auth });
    const a = path === "/api/info" ? (typeof info === "function" ? info(auth) : info) : api ? api(path) : SCANS;
    if (a === "hang") return; // a starting Space: no answer at all
    if (a === "abort" || (a.status === 503 && auth)) return route.abort();
    await route.fulfill({ status: a.status, headers: { "access-control-allow-origin": new URL(page.url()).origin }, contentType: typeof a.body === "string" ? "text/plain" : "application/json", body: typeof a.body === "string" ? a.body : JSON.stringify(a.body) });
  });
  return seen;
}
const card = (page: Page) => page.getByRole("region", { name: "Engine" });

test("practice: a free server gets the centred choice card; connected, the line names the server (only its name), every call carries the token, no commit, no folders", async ({ page }) => {
  const seen = await practice(page, engine(false));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: TEXT.title })).toBeVisible();
  const use = card(page).getByRole("button", { name: "Practice server" });
  await expect(use).toHaveClass(/primary/);
  await expect(card(page).getByText(TEXT.fast)).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Your own computer" })).not.toHaveClass(/primary/);
  await expect(card(page).getByRole("link", { name: "How to install it" })).toHaveAttribute("href", INSTALL);
  await expect(card(page).getByText(TEXT.slow)).toBeVisible();
  const box = (await card(page).boundingBox())!; // centred on the page
  expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThan(2);
  const asked = seen.length;
  expect(seen.every((s) => s.path === "/api/info" && s.auth === undefined)).toBe(true); // a free server is asked without the token: no preflight
  await shot(page, "ready");
  await use.click();
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveText(`${TEXT.live} · Change`);
  await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  await expect(page.getByText(/commit|fake123/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open a CT folder…" })).toHaveCount(0);
  const after = seen.slice(asked);
  expect(after[0]).toEqual({ path: "/api/info", auth: TOKEN }); // the connect check reads the full answer (the model for the Base44 row)
  expect(after.map((s) => s.path)).toContain("/api/scans");
  expect(after.every((s) => s.auth === TOKEN)).toBe(true);
  await shot(page, "connected");
});

test("install: How to install it and the footer link open Run it on your computer in the page; Copy copies the command; Back to Measure returns", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await practice(page, engine(false));
  await page.goto("/");
  const link = card(page).getByRole("link", { name: "How to install it" });
  await expect(link).not.toHaveAttribute("target");
  await page.screenshot({ path: "e2e/screenshots/install-card.png" });
  await link.click();
  const view = page.getByRole("region", { name: "Run it on your computer" });
  await expect(view.getByRole("heading", { name: "Run it on your computer" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(3); // a view, not a fourth tab
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(0);
  expect(context.pages()).toHaveLength(1);
  expect(await page.content()).not.toContain("github.com"); // the commands name raw.githubusercontent.com as text, never a link
  await page.screenshot({ path: "e2e/screenshots/install-view.png" });
  const mac = "curl -fsSL https://raw.githubusercontent.com/hillel-base/baseline/main/install.sh | bash";
  const win = "irm https://raw.githubusercontent.com/hillel-base/baseline/main/install.ps1 | iex";
  const copyButtons = view.getByRole("button", { name: /^Cop(y|ied)$/ });
  for (const [i, cmd] of [mac, win].entries()) {
    await expect(view.getByText(cmd, { exact: true })).toBeVisible();
    await copyButtons.nth(i).click();
    await expect(copyButtons.nth(i)).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(cmd);
    await expect(copyButtons.nth(i)).toHaveText("Copy", { timeout: 3000 }); // back after 2 s
  }
  await view.getByRole("button", { name: "Back to Measure" }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Measure" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Study table" }).click();
  await page.locator("footer").getByRole("link", { name: "Run it on your computer" }).click();
  await expect(view).toBeVisible();
  await expect(page.getByText("No measurements saved yet.")).toHaveCount(0);
});

test("practice: the user who holds the server (after a reload) is offered it again", async ({ page }) => {
  const seen = await practice(page, (auth) => ({ status: 200, body: INFO(!auth, !!auth) })); // busy to a stranger, free to the holder's token
  await page.goto("/");
  await expect(card(page).getByRole("button", { name: "Practice server" })).toBeVisible();
  expect(seen.slice(0, 2)).toEqual([{ path: "/api/info", auth: undefined }, { path: "/api/info", auth: TOKEN }]);
});

test("practice: paused offers the Demo as the main button, the local engine next to it and the install link", async ({ page }) => {
  const seen = await practice(page, { status: 503, body: "The space is paused, ask a maintainer to restart it" }); // a 503 page, although Hugging Face would refuse a preflight
  await page.goto("/");
  await expect(card(page).getByText(TEXT.paused, { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Open the Demo" })).toHaveClass(/primary/);
  await expect(card(page).getByRole("button", { name: "Use my local engine" })).not.toHaveClass(/primary/);
  await expect(card(page).getByRole("link", { name: "How to install it" })).toHaveAttribute("href", INSTALL);
  await expect(card(page).getByRole("button", { name: "Practice server" })).toHaveCount(0);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.auth === undefined)).toBe(true);
  await shot(page, "paused");
  await card(page).getByRole("button", { name: "Open the Demo" }).click();
  await expect(page.getByRole("tab", { name: "Demo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(TEXT.demo)).toBeVisible();
});

test("practice: starting shows a spinner and the Demo, keeps asking every 10 s, and connects by itself when the server answers", async ({ page }) => {
  test.setTimeout(60_000);
  let up = false;
  const seen = await practice(page, (auth) => (up ? engine(false)(auth) : "hang"));
  await page.goto("/");
  await expect(card(page).getByRole("button", { name: "Use my local engine" })).toBeEnabled(); // while the first ask still waits
  const t0 = Date.now();
  await expect(page.getByText(TEXT.starting)).toHaveCount(0); // not an instant error: the page waits for the time limit
  await expect(card(page).getByText(TEXT.starting)).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - t0).toBeGreaterThan(6_000);
  await expect(card(page).locator(".shell-spinner")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Open the Demo meanwhile" })).toBeVisible();
  await shot(page, "starting");
  up = true;
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible({ timeout: 15_000 });
  expect(seen.filter((s) => s.path === "/api/info").length).toBeGreaterThanOrEqual(2);
});

test("practice: starting, then unreachable, then ready still connects by itself, as the starting message promised", async ({ page }) => {
  test.setTimeout(60_000);
  let phase: "hang" | "abort" | "ready" = "hang";
  await practice(page, (auth) => (phase === "ready" ? engine(false)(auth) : phase));
  await page.goto("/");
  await expect(card(page).getByText(TEXT.starting)).toBeVisible({ timeout: 10_000 });
  phase = "abort"; // a network error in between: probe says unavailable
  await page.waitForTimeout(11_000);
  phase = "ready";
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible({ timeout: 15_000 });
});

test("practice: a visitor who chose the local engine while the server started is offered it, never moved to it", async ({ page }) => {
  test.setTimeout(60_000);
  let up = false;
  await practice(page, (auth) => (up ? engine(false)(auth) : "hang"));
  await page.route(`http://localhost:${PORT}/**`, (r) => r.abort()); // no local engine either
  await page.goto("/");
  await expect(card(page).getByText(TEXT.starting)).toBeVisible({ timeout: 10_000 });
  await card(page).getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByText(NO_ENGINE)).toBeVisible();
  up = true;
  await expect(card(page).getByRole("button", { name: "Practice server" })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveCount(0);
});

test("practice: a failed connect drops the token; the local engine never gets an Authorization header", async ({ page }) => {
  await practice(page, (auth) => (auth ? "abort" : { status: 200, body: INFO(false, false) })); // ready to the open ask, gone by the connect
  const local: (string | undefined)[] = [];
  await page.route(`http://localhost:${PORT}/**`, (r) => { local.push(r.request().headers()["authorization"]); return r.abort(); });
  await page.goto("/");
  await card(page).getByRole("button", { name: "Practice server" }).click();
  await expect(card(page).getByText(TEXT.unreachable)).toBeVisible();
  await card(page).getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByText(NO_ENGINE)).toBeVisible();
  expect(local.length).toBeGreaterThan(0);
  expect(local.every((a) => a === undefined)).toBe(true);
});

test("practice: another 503 or a network error says not available, never the raw body", async ({ page }) => {
  await practice(page, { status: 503, body: "Your space is in error, check its status on hf.co" });
  await page.goto("/");
  await expect(card(page).getByText(TEXT.unreachable)).toBeVisible();
  await expect(page.getByText(/space is in error/)).toHaveCount(0);
  await page.unrouteAll();
  await practice(page, "abort");
  await page.reload();
  await expect(card(page).getByText(TEXT.unreachable)).toBeVisible();
});

test("practice: busy before connecting shows on the choice card with Try again and the Demo; Try again gets in once it is free", async ({ page }) => {
  let busy = true;
  const seen = await practice(page, (auth) => engine(busy)(auth));
  await page.goto("/");
  await expect(card(page).getByText(TEXT.busy1, { exact: true })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Try again" })).toHaveClass(/primary/);
  await expect(card(page).getByRole("button", { name: "Open the Demo" })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Practice server" })).toHaveCount(0);
  expect(seen.slice(0, 2)).toEqual([{ path: "/api/info", auth: undefined }, { path: "/api/info", auth: TOKEN }]);
  await shot(page, "busy-before");
  busy = false;
  await card(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible();
});

test("practice: busy during use shows once, in the image area, with Try again and the Demo; Try again gets back in", async ({ page }) => {
  let held = true;
  await practice(page, (auth) => engine(false)(auth), () => (held ? { status: 423, body: { detail: "raw engine words" } } : SCANS));
  await page.goto("/");
  await card(page).getByRole("button", { name: "Practice server" }).click();
  const viewer = page.getByRole("region", { name: "Image viewer" });
  await expect(viewer.getByRole("alert")).toHaveText(TEXT.busy1);
  await expect(page.getByText(/in use|using the practice server/)).toHaveCount(1); // once: not in the status line, the Panel or the scan list
  await expect(page.getByText(/raw engine words|Engine not running/)).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Try again" })).toHaveClass(/primary/);
  await expect(viewer.getByRole("button", { name: "Open the Demo" })).toBeVisible();
  await shot(page, "busy");
  held = false;
  await viewer.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveClass(/ok/);
  await expect(page.getByText(/in use/)).toHaveCount(0);
});

test("practice: a 401 during use shows the sign-in text in the status line and the scan area, never the raw body or the README line", async ({ page }) => {
  const text = "Sign in to use the practice server.";
  await practice(page, engine(false), () => ({ status: 401, body: { detail: "raw engine words" } }));
  await page.goto("/");
  await card(page).getByRole("button", { name: "Practice server" }).click();
  await expect(page.getByRole("alert").filter({ hasText: text })).toHaveCount(2);
  await expect(page.getByText(/raw engine words|Engine not running/)).toHaveCount(0);
  await shot(page, "refused-401");
});

for (const [how, answer] of [["a lost answer", "abort"], ["a 502", { status: 502, body: "<html>Bad gateway</html>" }]] as const) {
  test(`practice: ${how} during use turns the status line amber with the image area's text and Try again; never the green line beside it`, async ({ page }) => {
    let down = true;
    await practice(page, engine(false), () => (down ? answer : SCANS));
    await page.goto("/");
    await card(page).getByRole("button", { name: "Practice server" }).click();
    const viewer = page.getByRole("region", { name: "Image viewer" });
    await expect(viewer.getByRole("alert")).toHaveText(TEXT.stopped);
    const line = page.getByRole("status").filter({ hasText: TEXT.stopped });
    await expect(line).toHaveClass(/warn/);
    await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveCount(0);
    await expect(page.getByText(/Engine not running|Bad gateway/)).toHaveCount(0);
    if (how === "a lost answer") await shot(page, "stopped");
    down = false;
    await viewer.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveClass(/ok/);
    await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  });
}

test.describe("two practice servers", () => {
  test.use({ baseURL: process.env.LUNG_E2E_TWO_URL ?? "http://localhost:4174" }); // the build that lists practice.example and practice-2.example (another port when 4174 is taken)
  const SECOND = "https://practice-2.example";

  test("practice: with one server busy, the choice card offers the free one", async ({ page }) => {
    await practice(page, engine(true));
    const second = await practice(page, engine(false), undefined, SECOND);
    await page.goto("/");
    await card(page).getByRole("button", { name: "Practice server" }).click();
    await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible();
    expect(second.some((s) => s.path === "/api/scans" && s.auth === TOKEN)).toBe(true);
  });

  test("practice: a 423 during use moves to the other server by itself when it is free", async ({ page }) => {
    const first = await practice(page, engine(false), () => ({ status: 423, body: { detail: "raw engine words" } }));
    let secondFree = false;
    const second = await practice(page, (auth) => engine(!secondFree)(auth), undefined, SECOND);
    await page.goto("/");
    await card(page).getByRole("button", { name: "Practice server" }).click();
    await expect(page.getByRole("region", { name: "Image viewer" }).getByRole("alert")).toHaveText(TEXT.busy2);
    expect(first.some((s) => s.path === "/api/scans")).toBe(true);
    await shot(page, "busy-2");
    secondFree = true;
    await page.getByRole("region", { name: "Image viewer" }).getByRole("button", { name: "Try again" }).click();
    await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
    expect(second.some((s) => s.path === "/api/scans" && s.auth === TOKEN)).toBe(true);
  });

  test("practice: a 423 during use with the other server already free switches without a click", async ({ page }) => {
    await practice(page, (auth) => engine(false)(auth), () => ({ status: 423, body: { detail: "raw engine words" } }));
    const second = await practice(page, (auth) => engine(false)(auth), undefined, SECOND); // both free: list order picks the first
    await page.goto("/");
    await card(page).getByRole("button", { name: "Practice server" }).click();
    await expect.poll(() => second.some((s) => s.path === "/api/scans"), { timeout: 10_000 }).toBe(true);
    await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  });
});

test("hosted: the page never offers Open a CT folder: folder names stay on the engine's own page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Scan")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open a CT folder…" })).toHaveCount(0);
  // and the engine refuses the hosted page's own folder request, with no CORS header for it to read
  const r = await page.evaluate(async (port) => { try { const x = await fetch(`http://localhost:${port}/api/folders?path=`); return x.status; } catch { return "blocked"; } }, PORT);
  expect(r).toBe("blocked");
});

test.describe("in Safari", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15" });
  const SAFARI = "In Safari, this page cannot reach the tool on your computer. Use Chrome or Firefox, or the practice server. The tool's own page on your computer (http://localhost:8000) works in Safari."; // this build lists a practice server
  test("hosted: with no practice server ready, the note comes first, the local engine is disabled with the note as its reason, and the Demo is the main action", async ({ page }) => {
    await page.goto("/");
    await expect(card(page).locator("h2 + [role=note]")).toHaveText(SAFARI); // first thing under the title
    const local = card(page).getByRole("button", { name: "Use my local engine" });
    await expect(local).toBeDisabled();
    await expect(local).not.toHaveClass(/primary/);
    await expect(local).toHaveAccessibleDescription(SAFARI);
    await expect(card(page).getByRole("button", { name: "Open the Demo" })).toHaveClass(/primary/);
    await page.screenshot({ path: "e2e/screenshots/hosted-safari-note.png" });
    await card(page).getByRole("button", { name: "Open the Demo" }).click();
    await expect(page.getByText(TEXT.demo)).toBeVisible();
  });
  test("hosted: with a practice server ready, it is the main action and Your own computer is disabled", async ({ page }) => {
    await practice(page, engine(false));
    await page.goto("/");
    await expect(card(page).locator("h2 + [role=note]")).toHaveText(SAFARI);
    await expect(card(page).getByRole("button", { name: "Practice server" })).toHaveClass(/primary/);
    const local = card(page).getByRole("button", { name: "Your own computer" });
    await expect(local).toBeDisabled();
    await expect(local).toHaveAccessibleDescription(SAFARI);
    await page.screenshot({ path: "e2e/screenshots/hosted-safari-ready.png" });
  });
  test("hosted: ?engine=local does not connect by itself: nothing calls localhost, and the Safari card shows as usual", async ({ page, baseURL }) => {
    const toEngine: string[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && u.port !== new URL(baseURL!).port) toEngine.push(r.url()); }); // any port but the page's own
    await page.goto("/?engine=local");
    await expect(card(page).locator("h2 + [role=note]")).toHaveText(SAFARI);
    await expect(card(page).getByRole("button", { name: "Use my local engine" })).toBeDisabled();
    await page.waitForTimeout(1500);
    expect(toEngine).toEqual([]);
    await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toHaveCount(0);
    await page.screenshot({ path: "e2e/screenshots/hosted-safari-engine-local.png" });
  });
});

test("hosted: no Safari note in Chrome", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible();
  await expect(page.getByText(/In Safari, this page cannot reach/)).toHaveCount(0);
});

test("hosted: ?engine=local connects to the local engine by itself, once, even with a free practice server", async ({ page }) => {
  const seen = await practice(page, engine(false));
  const infos: string[] = [];
  page.on("request", (r) => { if (r.url() === `http://localhost:${PORT}/api/info`) infos.push(r.url()); });
  await page.goto("/?engine=local");
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  await page.waitForTimeout(1500);
  expect(infos).toHaveLength(2); // the connect check and the viewer's device check: one connect, no repeat
  expect(seen.every((s) => s.auth === undefined)).toBe(true); // the practice server was only asked, never used
});

// A data-folder patient whose name is not a public RIDER one (a clone of RIDER-1286684383 named Jane_Doe_Test, see playwright.config.ts "coded").
test("coded: the hosted page shows codes only; click, Record, Find and copy_row work with the engine's internal id; the engine's own page keeps the name", async ({ page }) => {
  test.setTimeout(300_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const CODED = process.env.LUNG_E2E_CODED_PORT ?? "8206";
  const engineLog = "test-results/engine-runs-coded/events.jsonl";
  const lines = () => { try { return readFileSync(engineLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const before = lines().length;
  const NAME = /jane|doe_test/i; // not "doe" alone: a build hash can hold it
  const seen: Promise<string>[] = []; // every engine URL and every text answer the hosted page got, awaited before the check
  page.on("response", (r) => {
    if (!r.url().includes(`localhost:${CODED}`)) return;
    seen.push(Promise.resolve(r.url()));
    if ((r.headers()["content-type"] ?? "").includes("json")) seen.push(r.text().catch(() => ""));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 });
  const options = await page.getByLabel("Scan").locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
  expect(options).toHaveLength(2);
  expect(options.every((v) => /^D-[0-9a-f]{8}$/.test(v))).toBe(true);
  const info = (id: string) => page.evaluate(async ([u, i]) => (await fetch(`${u}/api/scans/${i}`)).json(), [`http://localhost:${CODED}`, id]);
  const metas = await Promise.all(options.map(info));
  const [testId, retestId] = [options[metas.findIndex((m) => m.series === "test")], options[metas.findIndex((m) => m.series === "retest")]];
  expect(JSON.stringify(metas)).not.toMatch(NAME);

  await page.getByLabel("Scan").selectOption(testId);
  const counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(counter).toBeVisible({ timeout: 60_000 });
  const [z, y, x] = [161, 321, 330];
  const test_ = metas.find((m) => m.series === "test");
  await page.getByRole("slider").fill(String(test_.instance_numbers[z]));
  await imageReady(page);
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height));
  const panel = page.getByRole("region", { name: "Measurements" });
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Recorded as nodule 1.");
  await expect(panel).toContainText("Saved to the study table.");

  await page.getByLabel("Scan").selectOption(retestId);
  const earlier = panel.getByRole("group", { name: "Earlier nodules" });
  await expect(earlier).toContainText(/N1 · Image \d+ on test/, { timeout: 60_000 });
  const mapped = page.waitForResponse((r) => r.url().includes("/map?"), { timeout: 120_000 });
  await earlier.getByRole("button", { name: "Find N1" }).click();
  expect((await (await mapped).json()).outside).toBeUndefined();
  await expect(panel).toContainText("N1? Check here.");
  await page.screenshot({ path: "e2e/screenshots/p1/hosted-coded-measure.png" });

  await page.getByRole("button", { name: /^This browser's table/ }).click();
  await page.getByRole("button", { name: /^Copy row for/ }).click();

  const internal = "Jane_Doe_Test_test";
  const of = (action: string) => lines().slice(before).filter((e) => e.action === action);
  await expect.poll(() => of("copy_row").map((e) => e.scan)).toEqual([internal]);
  expect(of("copy_row")[0].file).toMatch(/^outlines\/Jane_Doe_Test_test_n/); // the engine's own log keeps internal names; the page only ever saw codes
  expect(of("map").length).toBeGreaterThan(0);
  await page.getByRole("button", { name: /^Delete nodule 1/ }).click();
  await page.getByRole("button", { name: /^Confirm: delete/ }).click();
  await expect.poll(() => of("delete_row").map((e) => e.scan)).toEqual([internal]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => of("undo_delete_row").map((e) => e.scan)).toEqual([internal]);

  const body = await page.content();
  expect(body).not.toMatch(NAME);
  expect(await page.locator("body").innerText()).not.toMatch(NAME);
  expect((await Promise.all(seen)).join("\n")).not.toMatch(NAME);

  // The engine's own page (same origin) still shows the name, in the picker.
  await page.goto(`http://localhost:${CODED}/`);
  await expect(page.getByLabel("Scan").locator("option", { hasText: "Jane_Doe_Test_test" })).toHaveCount(1);
});

// rows waiting for the study table share the live line, and the sign-out line sits left of the name, so the tool and Sign out never move.
test("hosted: a second waiting row adds no line above the tool, and the sign-out line moves neither the name nor Sign out", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("lung.fake.saveFail", "1"));
  const panel = await outline(page);
  const sheet = page.locator(".measure-sheet"), signOut = page.getByRole("button", { name: "Sign out" }), name = page.getByText("Signed in as test-user");
  const places = async () => [(await sheet.boundingBox())!.y, (await signOut.boundingBox())!.x, (await name.boundingBox())!.x].map(Math.round);
  const before = await places();
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(panel).toContainText(NOT_SAVED);
  await expect(page.locator(".shell-user").getByRole("status")).toHaveText(LEFT);
  expect(await places()).toEqual(before);
  await page.keyboard.press("n"); // the same nodule again: a second Record while the first still waits
  const box = (await page.locator('canvas[aria-label="CT slice"]').boundingBox())!;
  await page.mouse.click(Math.round(box.x + (330.5 / 512) * box.width), Math.round(box.y + (321.5 / 512) * box.height));
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 60_000 });
  await panel.getByRole("button", { name: "Record nodule" }).click();
  await expect(page.getByText("1 row is waiting for the study table; tried again every 15 s.")).toBeVisible({ timeout: 30_000 });
  expect(await places()).toEqual(before);
});

// Change in the top line goes back to the choice card; an unrecorded outline asks first, in the page; leaving a practice server releases its hold.
test("practice: the line reads Practice server · Change; with nothing unrecorded, Change goes straight back to the card and releases the hold once, with the token", async ({ page }) => {
  const seen = await practice(page, engine(false));
  const posts: string[] = [], dialogs: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/session/release")) posts.push(`${r.method()} ${r.headers()["authorization"]}`); });
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto("/");
  await card(page).getByRole("button", { name: "Practice server" }).click();
  const line = page.getByRole("status").filter({ hasText: LIVE_LINE });
  await expect(line).toHaveText(`${TEXT.live} · Change`);
  await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
  expect(posts).toEqual([]);
  await line.getByRole("button", { name: "Change" }).click();
  await expect(page.getByRole("heading", { name: TEXT.title })).toBeVisible();
  await expect.poll(() => posts).toEqual([`POST ${TOKEN}`]);
  expect(seen.filter((s) => s.path === "/api/session/release")).toEqual([{ path: "/api/session/release", auth: TOKEN }]);
  await expect(card(page).getByRole("button", { name: "Practice server" })).toBeVisible(); // free again: offered again
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test("hosted: an unrecorded outline asks in the page first; Cancel keeps everything; Change goes back to the card; after Record, Change asks nothing; the local engine gets no release", async ({ page }) => {
  test.setTimeout(240_000);
  const dialogs: string[] = [], releases: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on("request", (r) => { if (r.url().includes("/api/session/release")) releases.push(r.url()); });
  await page.goto("/");
  const panel = await outline(page);
  const line = page.getByRole("status").filter({ hasText: LOCAL_LINE }), counter = page.getByText(/^Image \d+ \/ 265$/);
  await expect(line).toHaveText("Your own computer · Change");
  const sheet = page.locator(".measure-sheet"), top = (await sheet.boundingBox())!.y, image = await counter.textContent(), volume = (await panel.textContent())!.match(/Volume \S+ mL/)![0];
  await line.getByRole("button", { name: "Change" }).click();
  const ask = page.getByRole("alert").filter({ hasText: "This outline is not recorded yet. Change anyway?" });
  await expect(ask).toHaveText("This outline is not recorded yet. Change anyway? ChangeCancel");
  await expect(ask.getByRole("button", { name: "Cancel" })).toBeFocused(); // the safe answer first
  expect((await sheet.boundingBox())!.y).toBe(top); // the question takes the line's place: nothing under it moves
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(line).toHaveText("Your own computer · Change");
  await expect(counter).toHaveText(image!);
  await expect(panel).toContainText(volume);
  await expect(panel.getByRole("button", { name: "Record nodule (Enter)" })).toBeEnabled();
  await line.getByRole("button", { name: "Change" }).click();
  await ask.getByRole("button", { name: "Change" }).click();
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible();
  const again = await outline(page); // back on the local engine; Record first, and Change asks nothing
  await again.getByRole("button", { name: "Record nodule" }).click();
  await expect(again).toContainText("Saved to the study table.");
  await line.getByRole("button", { name: "Change" }).click();
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible();
  expect(dialogs).toEqual([]);
  expect(releases).toEqual([]);
});

test("hosted: the question goes once the outline is recorded while it was asking", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  const panel = await outline(page);
  const line = page.getByRole("status").filter({ hasText: LOCAL_LINE });
  await line.getByRole("button", { name: "Change" }).click();
  const ask = page.getByRole("alert").filter({ hasText: "This outline is not recorded yet. Change anyway?" });
  await expect(ask).toBeVisible();
  await panel.getByRole("button", { name: "Record nodule" }).click(); // recorded without answering the question
  await expect(panel).toContainText("Saved to the study table.");
  await expect(ask).toHaveCount(0);
  await expect(line).toHaveText("Your own computer · Change");
});

test.describe("in Safari on a practice server", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15" });
  test("practice: the line reads Practice server only, with no Change: the other choice is disabled in Safari", async ({ page }) => {
    await practice(page, engine(false));
    await page.goto("/");
    await card(page).getByRole("button", { name: "Practice server" }).click();
    await expect(page.getByLabel("Scan")).toContainText("RIDER-1286684383");
    const line = page.locator(".shell-line");
    await expect(line).toHaveText(TEXT.live);
    await expect(line.getByRole("button", { name: "Change" })).toHaveCount(0);
  });
});

test("hosted (gate minors): ?engine=local leaves the address once used, so a reload does not connect again", async ({ page }) => {
  await page.goto("/?engine=local&x=1");
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).searchParams.get("engine")).toBeNull();
  expect(new URL(page.url()).searchParams.get("x")).toBe("1"); // other parameters stay
});

test("practice (gate minors): while the local engine is awaited, a ready practice server stays available, and choosing it wins over the late local answer", async ({ page }) => {
  test.setTimeout(60_000);
  await practice(page, engine(false));
  await page.route(`http://localhost:${PORT}/api/info`, async (r) => {
    await new Promise((done) => setTimeout(done, 4000));
    await r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin },
      body: JSON.stringify({ commit: "late123", model: "m", width_method: "edge", device: "cpu" }) });
  });
  await page.goto("/");
  await card(page).getByRole("button", { name: "Your own computer" }).click();
  await expect(page.getByRole("status").filter({ hasText: WAITING_LOCAL })).toBeVisible();
  const pick = card(page).getByRole("button", { name: "Practice server" });
  await expect(pick).toBeEnabled();
  await pick.click();
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(5000); // the late local answer arrives meanwhile
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toHaveCount(0);
});

test("practice: a check still running when the visitor presses Change never connects afterwards; the new engine gets the calls", async ({ page }) => {
  test.setTimeout(90_000);
  let refuse = true, slow = false;
  const toPractice: string[] = [];
  await page.route(`${PRACTICE}/**`, async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname, auth = req.headers()["authorization"];
    toPractice.push(path);
    const send = (status: number, body: unknown) => route.fulfill({ status, headers: { "access-control-allow-origin": new URL(page.url()).origin }, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/info") { if (slow) await new Promise((done) => setTimeout(done, 3000)); return send(200, INFO(false, !!auth)); }
    return refuse ? send(423, { detail: "in use" }) : send(200, SCANS.body);
  });
  await page.goto("/");
  await card(page).getByRole("button", { name: "Practice server" }).click();
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeVisible({ timeout: 15_000 }); // the scan list was refused: busy, in the image area
  slow = true;
  await tryAgain.click(); // its check now waits 3 s for a "ready" answer
  await page.locator(".shell-line").getByRole("button", { name: "Change" }).click();
  await expect(page.getByRole("heading", { name: TEXT.title })).toBeVisible();
  const mark = toPractice.length;
  await card(page).getByRole("button", { name: /^(Use my local engine|Your own computer)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible({ timeout: 30_000 });
  refuse = false;
  await page.waitForTimeout(4500); // the old check's "ready" arrives meanwhile
  await expect(page.getByRole("status").filter({ hasText: LOCAL_LINE })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: LIVE_LINE })).toHaveCount(0);
  expect(toPractice.slice(mark).filter((p) => p !== "/api/info")).toEqual([]); // after Change, only the practice probes: every call goes to this computer
  await expect(page.getByLabel("Scan")).toContainText("RIDER-2541949645"); // the local engine's list (the practice stand-in lists only RIDER-1286684383)
});
