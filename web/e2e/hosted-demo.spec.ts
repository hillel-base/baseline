import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });
test.skip(!existsSync("public/demo/index.json"), "demo files not generated: run engine/scripts/record_demo.py");

test("demo: medium case replays the first click and its 2 corrections with no engine request", async ({ page }) => {
  const toEngine: string[] = [];
  // The Measure tab asks the build's stand-in practice server (not a Demo request, and no DNS lookup): it is paused, so the choice card offers the Demo
  await page.route("https://practice.example/**", (r) => r.fulfill({ status: 503, headers: { "access-control-allow-origin": new URL(page.url()).origin }, contentType: "text/plain", body: "The space is paused" }));
  page.on("request", (r) => { if (/localhost:(?!4173)\d+|\/api\//.test(r.url()) && !r.url().startsWith("https://practice.example/")) toEngine.push(r.url()); });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Demo" })).toHaveCount(0); // the Demo has no tab: a person reaches it from the choice card
  await page.getByRole("region", { name: "Engine" }).getByRole("button", { name: "Open the Demo" }).click();
  await expect(page.getByText("Demo: recorded results on development cases, not a live model.")).toBeVisible();
  await page.getByLabel("Case").selectOption({ label: "medium (RIDER-1286684383_test)" });
  const marks = page.getByLabel("Axis lines and click marks");
  await expect.poll(() => marks.evaluate((c: HTMLCanvasElement) => c.dataset.target)).not.toBe(""); // the target ring is drawn
  const canvas = page.locator('canvas[aria-label="CT slice"]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const at = async (y: number, x: number) => { await expect(page.getByText(/^Loading (image|slice index) \d+…$/)).toHaveCount(0, { timeout: 30_000 }); return page.mouse.click(Math.round(box.x + ((x + 0.5) / 512) * box.width), Math.round(box.y + ((y + 0.5) / 512) * box.height)); };
  const panel = page.getByRole("region", { name: "Measurements" });

  await at(50, 50); // far from the spot
  await expect(panel).toContainText("In demo mode, click the marked spot: these are recorded results.");
  await at(321, 330);
  await expect(panel).toContainText("Volume 6.90 mL");
  await expect(page.getByText("Recorded result: First click")).toBeVisible();
  await expect(panel).toContainText('Corrections and saving need your own engine: use "Use my local engine" in Measure.');
  for (const name of ["Record nodule", "Undo", "New nodule", "Add (A)"]) await expect(page.getByRole("button", { name })).toHaveCount(0);

  await page.getByRole("button", { name: "Next: After 2 corrections" }).click();
  await expect(panel).toContainText("Volume 8.84 mL");
  await expect(page.getByText("Recorded result: After 2 corrections")).toBeVisible();
  const meta = await (await page.request.get("/demo/RIDER-1286684383_test/meta.json")).json();
  const slider = page.getByRole("slider");
  await slider.fill(String(meta.instance_numbers[52])); // the - correction is on sub-volume slice 52
  const red = () => marks.evaluate((c: HTMLCanvasElement) => { const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 100 && d[i + 3] > 200) n++; return n; });
  expect(await red()).toBeGreaterThan(5);
  await slider.fill(String(meta.instance_numbers[44]));
  await page.screenshot({ path: "e2e/screenshots/hosted-demo.png" });

  await page.getByRole("button", { name: "Back: First click" }).click();
  await expect(panel).toContainText("Volume 6.90 mL");
  await expect(page.locator("footer").getByText(/CC BY 4\.0/).first()).toBeVisible();
  expect(toEngine).toEqual([]);
});
