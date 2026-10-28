import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Tutorial mode on the hosted build (the hosted project's build and engine): the whole tour with the local engine and the model, one picture per step,
// and steps 1 to 3 on a stand-in practice server. The coach only reads the page: every action here is one a person makes.
const PORT = process.env.LUNG_E2E_PORT ?? "8205"; // the same default as playwright.config.ts
const PRACTICE = "https://practice.example";
const FRAME = 'iframe[title="Patients"]';
const DIR = "e2e/screenshots/tutorial";
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeEach(({ page }) => page.route(/^https:\/\/practice(-2)?\.example\//, (r) => r.abort()));

const coachOf = (page: Page) => page.getByRole("region", { name: "Tutorial" });
const imageReady = (page: Page) => expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 });
/** A person's browser: the e2e browser says navigator.webdriver, and the page never offers the tutorial to an automated browser. */
const asPerson = (page: Page) => page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
const G = 4; // Coach.tsx: the ring's gap round its target
const gaps: Record<string, { gaps: number[]; at: number[] }> = {}; // per picture: left, top, right and bottom gaps and the radius over the target's; the target's box
/** The ring hugs the element the coach marked as its target: a gap of G on all four sides, and the target's corner radius plus G. */
async function ringHugs(page: Page, name: string) {
  const measure = () => page.evaluate(() => {
    const ring = document.querySelector(".tut-ring")!, t = document.querySelector("[data-tut-anchor]");
    if (getComputedStyle(ring).display === "none") return t ? "a mark with no ring" : null;
    if (!t) return "a ring with no mark";
    const [r, a] = [ring.getBoundingClientRect(), t.getBoundingClientRect()], px = (e: Element) => parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0;
    return { gaps: [a.left - r.left, a.top - r.top, r.right - a.right, r.bottom - a.bottom, px(ring) - px(t)].map((v) => Math.round(v * 100) / 100), at: [a.x, a.y, a.width, a.height].map(Math.round) };
  });
  await expect.poll(async () => { const m = await measure(); return m === null || (typeof m === "object" && m.gaps.every((v) => Math.abs(v - G) <= 1)) ? "ok" : JSON.stringify(m); }).toBe("ok");
  const m = await measure();
  if (m && typeof m === "object") { gaps[name] = m; writeFileSync("test-results/ring-gaps.json", JSON.stringify(gaps, null, 1)); }
}
/** A picture, once the box has moved (on the next frame) and the ring, if shown, hugs its target. */
async function snap(page: Page, name: string) {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await ringHugs(page, name);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
let shots = 0;
const shot = (page: Page, name: string) => snap(page, `${String(++shots).padStart(2, "0")}-${name}`);
/** The ring is round the target and the box beside it, not over it. */
async function pointsAt(page: Page, target: Locator) {
  const ring = page.locator(".tut-ring"), card = page.locator(".tut-card");
  await expect.poll(async () => {
    const [r, c, t] = await Promise.all([ring.boundingBox(), card.boundingBox(), target.boundingBox()]);
    if (!r || !c || !t) return "not shown";
    const [x, y] = [t.x + t.width / 2, t.y + t.height / 2], inside = (b: typeof r) => b.x <= x && x <= b.x + b.width && b.y <= y && y <= b.y + b.height;
    return inside(r) && !inside(c) ? "ok" : `ring ${JSON.stringify(r)} card ${JSON.stringify(c)} target ${JSON.stringify(t)}`;
  }).toBe("ok");
}
const step = (coach: Locator, n: number, text: string, timeout = 30_000) => Promise.all([expect(coach).toContainText(`Step ${n} of 12`, { timeout }), expect(coach).toContainText(text, { timeout })]);
const next = (coach: Locator) => coach.getByRole("button", { name: "Next", exact: true }).click();

test("tutorial: offered once; the whole tour on the local engine with the model, a picture per step; Back, Enter, Tab and Exit; the Records are practice rows and stay", async ({ page }) => {
  test.setTimeout(600_000);
  shots = 0;
  await asPerson(page);
  await page.goto("/");
  const coach = coachOf(page), panel = page.getByRole("region", { name: "Measurements" });
  await expect(coach.getByRole("status", { name: "Take a short tutorial?" })).toBeVisible(); // announced
  await pointsAt(page, page.getByRole("button", { name: "Tutorial", exact: true }));
  const [offer, bar] = [(await page.locator(".tut-card").boundingBox())!, (await page.getByRole("banner").boundingBox())!];
  expect(offer.y + offer.height).toBeLessThanOrEqual(bar.y + bar.height); // inside the top bar: it never covers the Patients bar under it (Follow-up ›)
  await shot(page, "offer");
  expect(await page.evaluate(() => localStorage.getItem("lung.tutorial.offered"))).toBe("1"); // offered once: remembered as it shows
  await coach.getByRole("button", { name: "Start", exact: true }).click();

  // 1. Where the tool runs (no practice server answers in this run: the local engine)
  await step(coach, 1, "Press Use my local engine.");
  await pointsAt(page, page.getByRole("button", { name: "Use my local engine" }));
  await shot(page, "engine");
  await page.getByRole("button", { name: "Use my local engine" }).click();

  // 3. The local engine's Patients panel is a frame the page cannot reach into: step 2 is left out, and step 3 names the patient and scan in words
  await step(coach, 3, "Open RIDER-2619750334, Baseline, in the Patients panel above the image.");
  await expect(page.frameLocator(FRAME).locator('button[aria-haspopup="dialog"]')).toBeEnabled({ timeout: 30_000 }); // the frame has read the folder
  await pointsAt(page, page.locator(FRAME));
  await shot(page, "baseline");
  const sheet = page.frameLocator(FRAME).getByRole("dialog", { name: "Patients" });
  await page.frameLocator(FRAME).locator('button[aria-haspopup="dialog"]').click();
  await sheet.getByRole("searchbox", { name: "Search patients" }).fill("RIDER-2619750334");
  await shot(page, "baseline-search");
  await sheet.getByRole("button", { name: /^Open Baseline/ }).click();

  // 4. The cross: the viewer goes to its slice (z 148 = Image 133) and the white ring sits on voxel (y 337, x 195)
  await step(coach, 4, "Click the centre of the white ring on Image 133.", 60_000);
  await expect(page.getByText("Image 133 / 281")).toBeVisible({ timeout: 60_000 });
  await imageReady(page);
  const marks = page.getByLabel("Axis lines and click marks");
  await expect.poll(() => marks.getAttribute("data-target")).toMatch(/^\[/);
  const [px, py] = JSON.parse((await marks.getAttribute("data-target"))!) as [number, number];
  const [m, ct] = [(await marks.boundingBox())!, (await page.locator('canvas[aria-label="CT slice"]').boundingBox())!];
  expect(Math.abs(m.x + px - (ct.x + (195.5 / 512) * ct.width))).toBeLessThan(1.5);
  expect(Math.abs(m.y + py - (ct.y + (337.5 / 512) * ct.height))).toBeLessThan(1.5);
  await shot(page, "cross");
  await page.mouse.click(m.x + px, m.y + py);
  await expect(panel).toContainText(/Volume \d+\.\d\d mL/, { timeout: 120_000 });

  // 5. Check: the ring goes once the outline shows. Back shows step 4 with Next (its condition holds) and it waits
  await step(coach, 5, "Check the outline on a few images.");
  await expect(marks).toHaveAttribute("data-target", "");
  await pointsAt(page, panel.locator(".m-card"));
  await shot(page, "check");
  await page.getByRole("button", { name: "Sign out" }).focus(); // Tab after the header reaches the coach's buttons
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Tutorial"]'))).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await coach.getByRole("button", { name: "Back", exact: true }).click();
  await step(coach, 4, "Click the centre of the white ring on Image 133.");
  await expect(coach.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(coach).toContainText("Step 4 of 12"); // it held: no move by itself
  await next(coach);
  await step(coach, 5, "Check the outline on a few images.");
  await coach.getByRole("button", { name: "Next", exact: true }).focus(); // from the keyboard: step 6 has no Next, and the focus stays in the coach
  await page.keyboard.press("Enter");
  await step(coach, 6, "Correct the outline once.");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Tutorial");

  // 6. The precomputed correction (the evaluation's next_click against R1 on this first outline): an Add on the small ring, Image 153 (z 128, y 343, x 200)
  await step(coach, 6, "Click the centre of the small ring: a part the first outline missed.");
  await expect(page.getByText("Image 153 / 281")).toBeVisible({ timeout: 30_000 }); // the viewer went to its slice
  await imageReady(page);
  await expect.poll(() => marks.getAttribute("data-target")).toMatch(/^\[/);
  const [qx, qy] = JSON.parse((await marks.getAttribute("data-target"))!) as [number, number];
  expect(Math.abs(m.x + qx - (ct.x + (200.5 / 512) * ct.width))).toBeLessThan(1.5);
  expect(Math.abs(m.y + qy - (ct.y + (343.5 / 512) * ct.height))).toBeLessThan(1.5);
  const card = (await page.locator(".tut-card").boundingBox())!;
  expect(m.x + qx < card.x || m.x + qx > card.x + card.width || m.y + qy < card.y || m.y + qy > card.y + card.height).toBe(true); // the box leaves the ring clear
  await shot(page, "correct");
  await page.mouse.click(m.x + qx, m.y + qy);

  // 7. Record: Enter works, the coach took no focus
  await step(coach, 7, "Press Record nodule, or Enter.", 120_000);
  await pointsAt(page, panel.getByRole("button", { name: "Record nodule (Enter)" }));
  await shot(page, "record");
  expect(await page.evaluate(() => !document.activeElement?.closest(".tut"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Saved to the study table.");

  // 8. The Study table: the tab, the saved row, Download CSV
  await step(coach, 8, "Press Study table.");
  await pointsAt(page, page.getByRole("tab", { name: "Study table" }));
  await shot(page, "study-tab");
  await page.getByRole("tab", { name: "Study table" }).click();
  const row = page.getByRole("table", { name: "Study record" }).getByRole("row", { name: /RIDER-2619750334/ });
  await step(coach, 8, "This line is your Record");
  await expect(row).toContainText(/Practice\s*N1/);
  await pointsAt(page, row);
  await shot(page, "study-row");
  await next(coach);
  await step(coach, 8, "Download CSV saves the table");
  await pointsAt(page, page.getByRole("button", { name: "Download CSV" }));
  await shot(page, "study-csv");
  await next(coach);

  // 9. The follow-up: back to Measure, Follow-up › (Alt+→ from the page, as the frame's own button), Find N1, Measure here (M), Record
  await step(coach, 9, "Press Measure.");
  await shot(page, "followup-measure-tab");
  await page.getByRole("tab", { name: "Measure" }).click();
  await step(coach, 9, "Press Follow-up › in the Patients bar, or press Alt+→.");
  await pointsAt(page, page.locator(FRAME));
  await shot(page, "followup-open");
  await page.keyboard.press("Alt+ArrowRight");
  await step(coach, 9, "Press Find beside N1.", 60_000);
  await imageReady(page);
  await pointsAt(page, page.getByRole("button", { name: "Find N1" }));
  await shot(page, "followup-find");
  await page.getByRole("button", { name: "Find N1" }).click();
  await step(coach, 9, "Press Measure here (M)", 120_000);
  await imageReady(page);
  await pointsAt(page, page.getByRole("button", { name: "Measure here (M)" }));
  await shot(page, "followup-measure-here");
  await page.keyboard.press("m");
  await step(coach, 9, "Check the outline, then press Record nodule or Enter.", 120_000);
  await shot(page, "followup-record");
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Saved to the study table.");

  // 10. Both scans side by side in the saved row
  await step(coach, 10, "Press Study table again.");
  await page.getByRole("tab", { name: "Study table" }).click();
  await step(coach, 10, "both scans side by side");
  await expect(page.getByRole("columnheader", { name: "Follow-up" })).toBeVisible();
  await expect(row).toContainText(/N1(\s*\d+\.\d+){3}\s*(Approved|Edited)(\s*\d+\.\d+){3}\s*(Approved|Edited)/);
  await pointsAt(page, row);
  await shot(page, "study-both");
  await next(coach);

  // 11. Optional: the finder (this engine has the stand-in finder) and the tools for fixes by hand
  await step(coach, 11, "First press Measure.");
  await page.getByRole("tab", { name: "Measure" }).click();
  await step(coach, 11, "Optional: Find nodules.");
  await pointsAt(page, page.getByRole("button", { name: "Find nodules" }));
  await shot(page, "finder");
  await next(coach);
  await step(coach, 11, "Press New nodule (N), then click a nodule to see them."); // a Record is on the page: the tools are hidden
  await page.keyboard.press("n");
  await step(coach, 11, "Optional: the tools for fixes by hand.");
  await pointsAt(page, panel.getByRole("group", { name: "By hand" }));
  await shot(page, "paint");
  await next(coach);

  // 12. The end; Exit closes the tour and the Records stay, as practice rows
  await step(coach, 12, "Research use only. Not a medical device.");
  await expect(coach.getByRole("button", { name: "Skip" })).toHaveCount(0);
  await shot(page, "end");
  await coach.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(coach).toHaveCount(0);
  await page.getByRole("tab", { name: "Study table" }).click();
  await expect(row).toBeVisible();
  const ms = await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement as { practice: boolean; position_voxel: number[]; removed_reason?: string }[]);
  expect(ms.map((x) => [x.practice, !!x.removed_reason])).toEqual([[true, false], [true, false]]); // practice rows
  expect(ms[0].position_voxel).toEqual([148, 337, 195]); // the first click was on the cross
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lung.fake.store")!).NoduleMeasurement[0].clicks)).toBe(2); // and one correction, on the small ring
  await page.reload();
  await expect(page.getByRole("tab", { name: "Measure" })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(coach).toHaveCount(0); // offered once
});

type Answer = { status: number; body: unknown };
const PRACTICE_PATIENTS = { folder: { path: null, from: null, error: null }, patients: ["RIDER-1286684383", "RIDER-2541949645", "RIDER-2619750334"].map((key, i) => ({
  key, name: `Practice patient ${i + 1}`, source: "data",
  scans: [{ id: `${key}_test`, timepoint: "Baseline", date: null, day: 0, label: "Test scan", slice_mm: null, images: 281 }, { id: `${key}_retest`, timepoint: "Follow-up", date: null, day: 0, label: "Retest scan", slice_mm: null, images: 281 }] })) };
/** A stand-in practice server, as hosted.spec.ts's practice(): free, signed-in answers, the three development patients; the scans themselves come from this run's engine. */
async function practice(page: Page) {
  await page.route(`${PRACTICE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname, signedIn = !!route.request().headers()["authorization"];
    const a: Answer = path === "/api/info" ? { status: 200, body: signedIn ? { commit: "fake123", model: "fake", width_method: "edge to edge", device: "cuda", server: { busy: false, idle_min: 10 } } : { commit: "fake123", server: { busy: false, idle_min: 10 } } }
      : path === "/api/patients" ? { status: 200, body: PRACTICE_PATIENTS } : { status: 200, body: [{ id: "RIDER-2619750334_test", patient: "RIDER-2619750334", series: "test" }] };
    await route.fulfill({ status: a.status, headers: { "access-control-allow-origin": new URL(page.url()).origin }, contentType: "application/json", body: JSON.stringify(a.body) });
  });
  await page.route(new RegExp(`^${PRACTICE}/api/scans/RIDER-`), async (route) => { // the scan's info and its slices, from this run's engine
    const r = await route.fetch({ url: route.request().url().replace(PRACTICE, `http://localhost:${PORT}`), headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), "access-control-allow-origin": new URL(page.url()).origin } });
  });
  await page.route(`${PRACTICE}/api/slice`, async (route) => { // a practice server's slices: one POST with the token, answered here from the engine's GET
    const { scan, z } = route.request().postDataJSON() as { scan: string; z: number };
    const r = await route.fetch({ url: `http://localhost:${PORT}/api/scans/${scan}/slices/${z}`, method: "GET", headers: {} });
    await route.fulfill({ response: r, headers: { ...r.headers(), "access-control-allow-origin": new URL(page.url()).origin } });
  });
}

test("tutorial: on a practice server, the Tutorial button starts it (an automated browser is not offered it); steps 1 to 3 point at the page's own controls; Esc closes the Patients sheet first, then the tour", async ({ page }) => {
  test.setTimeout(180_000);
  await practice(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible();
  const coach = coachOf(page);
  await page.waitForTimeout(500);
  await expect(coach).toHaveCount(0); // navigator.webdriver: never offered
  const pic = (name: string) => snap(page, `practice-${name}`);
  await page.getByRole("button", { name: "Tutorial", exact: true }).click();
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY"); // a mouse click leaves the focus nowhere: Enter still records

  await step(coach, 1, "Press Practice server: there is nothing to install.");
  await pointsAt(page, page.getByRole("button", { name: "Practice server" }));
  await pic("1-engine");
  await page.getByRole("button", { name: "Practice server" }).click();

  await step(coach, 2, "Press Choose a scan, above the image, to open the Patients panel."); // the button by its own words
  const patients = page.locator('.m-bar button[aria-haspopup="dialog"]');
  await pointsAt(page, patients);
  await pic("2-patients");
  await patients.click();

  const sheet = page.getByRole("dialog", { name: "Patients" });
  await step(coach, 3, "Press Practice patient 3. Then press Open beside Baseline."); // the patient whose scans hold RIDER-2619750334_test (App's patient data)
  await pointsAt(page, sheet.getByRole("button", { name: /^Practice patient 3/ }));
  await pic("3-patient");
  await page.keyboard.press("Escape"); // the sheet closes first; the tour stays
  await expect(sheet).toHaveCount(0);
  await expect(coach).toContainText("Step 3 of 12");
  await pointsAt(page, patients);
  await patients.click();
  await sheet.getByRole("button", { name: /^Practice patient 3/ }).click();
  await pointsAt(page, sheet.getByRole("button", { name: "Open Baseline" }));
  await pic("3-open-baseline");
  await sheet.getByRole("button", { name: "Open Baseline" }).click();

  await step(coach, 4, "Click the centre of the white ring on Image 133.", 60_000);
  await expect(page.getByText("Image 133 / 281")).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.getByLabel("Axis lines and click marks").getAttribute("data-target")).toMatch(/^\[/);
  await imageReady(page);
  await pic("4-cross");
  await page.keyboard.press("Escape");
  await expect(coach).toHaveCount(0);
  await expect(page.getByLabel("Axis lines and click marks")).toHaveAttribute("data-target", ""); // Exit takes the ring away

  // Started again from the top bar: step 1 holds already (Next, no wait); Skip to the finder, which this practice server does not have
  await page.getByRole("button", { name: "Tutorial", exact: true }).click();
  await step(coach, 1, "Connected.");
  await expect(coach.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  for (let i = 0; i < 30 && !(await coach.textContent())?.includes("Step 11 of 12"); i++) await coach.getByRole("button", { name: "Skip", exact: true }).click();
  await step(coach, 11, "The nodule finder is off here. It is optional.");
  await expect(coach.getByRole("button", { name: "Next", exact: true })).toBeVisible();
  await pic("11-finder-off");
  await page.keyboard.press("Escape");
  await expect(coach).toHaveCount(0);
});

test("tutorial: Esc closes the offer for this visit only (it shows again next visit); No thanks closes it for good", async ({ page }) => {
  await asPerson(page);
  await page.goto("/");
  const coach = coachOf(page), offer = coach.getByRole("status", { name: "Take a short tutorial?" });
  await expect(offer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(coach).toHaveCount(0);
  await page.reload();
  await expect(offer).toBeVisible(); // Esc was "not now"
  await coach.getByRole("button", { name: "No thanks", exact: true }).click();
  await expect(coach).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose where the tool runs" })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(coach).toHaveCount(0);
});

// One study row in the study table hides the practice rows by default, and with them the tutorial's Record.
const LAB_AND_PRACTICE = JSON.stringify({
  Scan: [{ id: "Scan1", study_code: "a1b2c3d4", timepoint: 0, scan_ref: "lab" }, { id: "Scan2", study_code: "RIDER-2619750334", timepoint: 0, scan_ref: "rider" }],
  NoduleMeasurement: [{ id: "M1", scan_id: "Scan1", nodule_label: "N1", long_axis_mm: 12.3, short_axis_mm: 8.1, volume_ml: 0.61, method: "tool approved", approved_at: "2026-10-27T09:00:00.000Z", practice: false },
    { id: "M2", scan_id: "Scan2", nodule_label: "N1", long_axis_mm: 83.2, short_axis_mm: 50.4, volume_ml: 80.1, method: "tool edited", approved_at: "2026-10-27T09:01:00.000Z", practice: true }],
});
test("tutorial: another patient's scan never moves the tour on (the box asks for the case); with a study row in the study table, steps 8 and 10 first point at Practice rows", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript((store) => { if (!localStorage.getItem("lung.fake.store")) localStorage.setItem("lung.fake.store", store); }, LAB_AND_PRACTICE);
  await page.goto("/");
  const coach = coachOf(page), sw = page.getByRole("switch", { name: "Practice rows" });
  const row = page.getByRole("table", { name: "Study record" }).getByRole("row", { name: /RIDER-2619750334/ });
  const skipTo = async (text: string) => { for (let i = 0; i < 30 && !(await coach.textContent())?.includes(text); i++) await coach.getByRole("button", { name: "Skip", exact: true }).click(); await expect(coach).toContainText(text); };
  await page.getByRole("button", { name: "Tutorial", exact: true }).click();
  await page.getByRole("button", { name: "Use my local engine" }).click();
  await step(coach, 3, "Open RIDER-2619750334, Baseline", 30_000);
  const f = page.frameLocator(FRAME), sheet = f.getByRole("dialog", { name: "Patients" });
  const openFromFrame = async (patient: string, open: RegExp) => {
    await expect(f.locator('button[aria-haspopup="dialog"]')).toBeEnabled({ timeout: 30_000 });
    await f.locator('button[aria-haspopup="dialog"]').click();
    await sheet.getByRole("searchbox", { name: "Search patients" }).fill(patient);
    await sheet.getByRole("button", { name: open }).click();
  };
  await openFromFrame("RIDER-1286684383", /^Open Baseline/); // another development patient: step 3 is not done
  await expect(page.getByText(/^Image \d+ \/ 265$/)).toBeVisible({ timeout: 60_000 });
  await expect(coach).toContainText("Step 3 of 12");
  await coach.getByRole("button", { name: "Skip", exact: true }).click();
  await step(coach, 4, "Open RIDER-2619750334, Baseline, first (step 3).");
  await expect(coach).not.toContainText(/white ring|ractice/);
  await expect(coach.getByRole("button", { name: "Next", exact: true })).toHaveCount(0); // it waits
  await imageReady(page);
  await snap(page, "other-scan-4");
  await openFromFrame("RIDER-2619750334", /^Open Baseline/);
  await step(coach, 4, "Click the centre of the white ring on Image 133.", 60_000);
  await skipTo("Press Study table.");
  await page.getByRole("tab", { name: "Study table" }).click();
  await step(coach, 8, "Turn on Practice rows to see your Record.");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(row).toHaveCount(0); // the Record is not on the page while the switch is off
  await pointsAt(page, sw);
  await expect(coach.getByRole("button", { name: "Next", exact: true })).toHaveCount(0); // it waits for the switch
  await snap(page, "lab-rows-8-switch-off");
  await sw.click();
  await step(coach, 8, "This line is your Record");
  await expect(coach).not.toContainText("Turn on Practice rows");
  await pointsAt(page, row);
  await snap(page, "lab-rows-8-record");
  await next(coach);
  await step(coach, 8, "Download CSV saves the table");
  await next(coach);
  await step(coach, 9, "Press Measure.");
  await page.getByRole("tab", { name: "Measure" }).click();
  await step(coach, 9, "Press Follow-up › in the Patients bar, or press Alt+→.");
  await page.keyboard.press("Alt+ArrowRight"); // the case's Follow-up: the repeat-scan steps count on it
  await step(coach, 9, "Press Find", 60_000); // no Record of this tab to find: the button is not there, the box still names it
  await skipTo("Press Study table again.");
  await page.getByRole("tab", { name: "Study table" }).click(); // the table opens again with its default: practice rows hidden
  await step(coach, 10, "Turn on Practice rows to see your Record.");
  await pointsAt(page, sw);
  await snap(page, "lab-rows-10-switch-off");
  await sw.click();
  await step(coach, 10, "both scans side by side");
  await pointsAt(page, row);
});
