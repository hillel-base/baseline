import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Signed-out checks against the hosted Base44 app: LUNG_DEPLOYED_URL=https://... NO_ENGINE=1 npx playwright test --project=deployed
const url = process.env.LUNG_DEPLOYED_URL;
test.skip(!url, "set LUNG_DEPLOYED_URL to the hosted app address");
// The app's own file a stranger must not get: the page script of the deploy's own build (npm run deploy:base44 builds dist-hosted/ just before it deploys).
const script = existsSync("dist-hosted/index.html") ? readFileSync("dist-hosted/index.html", "utf8").match(/src="(\/assets\/[^"]+\.js)"/)?.[1] : undefined;

test("signed out: the page goes to Base44 sign-in and the app's own page script is refused", async ({ page, request }) => {
  await page.goto(url!);
  await expect(page).toHaveURL(/\/login/);
  expect(script, "no page script in dist-hosted/index.html: run the deploy's build first (npm run deploy:base44 builds it), so the check knows the page script's name").toBeTruthy(); // never a silent pass
  expect((await request.get(new URL(script!, url!).href)).status()).toBe(401);
});
