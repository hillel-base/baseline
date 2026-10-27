import { expect, test } from "@playwright/test";

// Signed-out checks against the hosted Base44 app: LUNG_DEPLOYED_URL=https://... npx playwright test deployed
const url = process.env.LUNG_DEPLOYED_URL;
test.skip(!url, "set LUNG_DEPLOYED_URL to the hosted app address");

test("signed out: the page goes to Base44 sign-in and demo files are refused", async ({ page, request }) => {
  await page.goto(url!);
  await expect(page).toHaveURL(/\/login/);
  const demo = await request.get(new URL("/demo/index.json", url!).href);
  expect(demo.status()).toBe(401);
});
