import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = process.env.LUNG_E2E_PORT ?? "8205"; // 8000 is kept for your own engine
const data = process.env.LUNG_DATA_DIR;
const demoOnly = !!process.env.DEMO_ONLY; // the Demo e2e needs neither the engine nor the data
if (!data && !demoOnly) throw new Error("Set LUNG_DATA_DIR to the RIDER data folder before running the e2e tests.");

// A clone that is never left half-made: copy into <root>.part, then rename. cp -c clones on APFS (no extra disk); elsewhere cpSync copies. -L: the data folder's series are links, and a link would point out of the root (the engine refuses it).
function cloneInto(root: string, copies: [string, string][], after?: (part: string) => void) {
  if (existsSync(root)) return;
  const part = root + ".part";
  rmSync(part, { recursive: true, force: true });
  for (const [from, to] of copies) {
    mkdirSync(dirname(`${part}/${to}`), { recursive: true });
    try { execFileSync("cp", ["-cRL", from, `${part}/${to}`]); } catch { rmSync(`${part}/${to}`, { recursive: true, force: true }); cpSync(from, `${part}/${to}`, { recursive: true, dereference: true }); }
  }
  after?.(part);
  renameSync(part, root);
}

// Folder-browser test root: holds only a copy of one development scan.
const browse = resolve("node_modules/.cache/lung-browse-root");
if (!demoOnly) { // the Demo run has no data to copy
  if (!existsSync(browse + "/scan")) rmSync(browse, { recursive: true, force: true }); // an older, half-made root
  cloneInto(browse, [[`${data}/RIDER-1286684383/ct_test`, "scan"]]);
  // The hosted frame e2e: a made-up study folder in the browse root. Two development patients' series under made-up names and dates, written into the copies' headers only.
  cloneInto(`${browse}/made-up`, [["RIDER-1286684383/ct_test", "Doe Jane/2025-09 chest CT"], ["RIDER-1286684383/ct_retest", "Doe Jane/2025-12 chest CT"], ["RIDER-2541949645/ct_test", "Okafor Sam/first"]]
    .map(([s, to]) => [`${data}/${s}`, to] as [string, string]), (part) => execFileSync("uv", ["run", "python", resolve("e2e/made_up.py"), part], { cwd: "../engine", stdio: "inherit" }));
}

// Coded-patient run (hosted.spec.ts "coded:"): the development patient under a made-up non-RIDER name, in its own data root, with its own engine and hosted build.
// Only started when wanted (CODED_E2E=1 or --project=codes): a second engine holds a second model, and nothing else needs it.
//   CODED_E2E=1 LUNG_DATA_DIR=... npx playwright test --project=codes
const CODED_PORT = process.env.LUNG_E2E_CODED_PORT ?? "8206", CODED_WEB = process.env.LUNG_E2E_CODED_WEB ?? "4175";
const wantCodes = !demoOnly && (process.env.CODED_E2E === "1" || process.argv.some((a) => /(^|=)codes$/.test(a)));
const coded = resolve("node_modules/.cache/lung-coded-root");
if (wantCodes) cloneInto(coded, [["ct_test", "Jane_Doe_Test/ct_test"], ["ct_retest", "Jane_Doe_Test/ct_retest"]].map(([s, to]) => [`${data}/RIDER-1286684383/${s}`, to] as [string, string]));

// Engine serves the built page (npm run build first): the same thing a user runs.
export default defineConfig({
  testDir: "e2e",
  workers: 1, // the engine holds one nodule at a time: tests that share it must not overlap
  projects: [
    { name: "local", testMatch: ["slices.spec.ts", "copilot.spec.ts"], use: { baseURL: `http://localhost:${PORT}` } },
    { name: "demo", testMatch: "hosted-demo.spec.ts", use: { baseURL: "http://localhost:4173" } },
    { name: "deployed", testMatch: "deployed.spec.ts" }, // signed-out checks on the live app; skipped without LUNG_DEPLOYED_URL
    { name: "hosted", testMatch: "hosted.spec.ts", grepInvert: /coded: the hosted/, use: { baseURL: "http://localhost:4173" } }, // the Base44 build with the fake client
    ...(wantCodes ? [{ name: "codes", testMatch: "hosted.spec.ts", grep: /coded: the hosted/, use: { baseURL: `http://localhost:${CODED_WEB}` } }] : []), // the same build against the coded-patient engine
    { name: "tutorial", testMatch: "tutorial.spec.ts", use: { baseURL: "http://localhost:4173" } }, // Tutorial mode on the hosted build: the whole tour with the model, a picture per step
  ],
  webServer: [...(demoOnly ? [] : [{
    command: `uv run uvicorn lung_engine.app:create_app --factory --port ${PORT}`,
    cwd: "../engine",
    url: `http://localhost:${PORT}/api/scans`,
    env: { LUNG_DATA_DIR: data!, LUNG_BROWSE_ROOT: browse,
      LUNG_FINDER: "subprocess", LUNG_FINDER_TEST_COMMAND: `uv run --directory ${resolve("../engine")} python ${resolve("e2e/fake_finder.py")}`, // a fake finder: the co-pilot test needs no model
      LUNG_RUNS_DIR: resolve("test-results/engine-runs"), LUNG_ALLOWED_ORIGIN: "http://localhost:4173" }, // never write to the shared runs/
    reuseExistingServer: false,
    timeout: 180_000,
  }]), ...(wantCodes ? [{
    command: `uv run uvicorn lung_engine.app:create_app --factory --port ${CODED_PORT}`,
    cwd: "../engine",
    url: `http://localhost:${CODED_PORT}/api/scans`,
    env: { LUNG_DATA_DIR: coded, LUNG_BROWSE_ROOT: browse, LUNG_RUNS_DIR: resolve("test-results/engine-runs-coded"), LUNG_ALLOWED_ORIGIN: `http://localhost:${CODED_WEB}` },
    reuseExistingServer: false,
    timeout: 180_000,
  }, {
    command: `VITE_HOSTED=1 VITE_BASE44_FAKE=1 VITE_ENGINE_URL=http://localhost:${CODED_PORT} npx vite build --outDir node_modules/.cache/dist-e2e-coded && npx vite preview --outDir node_modules/.cache/dist-e2e-coded --port ${CODED_WEB} --strictPort`,
    url: `http://localhost:${CODED_WEB}`,
    reuseExistingServer: false,
    timeout: 120_000,
  }] : []), {
    command: `VITE_HOSTED=1 VITE_BASE44_FAKE=1 VITE_ENGINE_URL=http://localhost:${PORT} VITE_PRACTICE_SERVERS=https://practice.example npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4173 --strictPort`,
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  }, { // the same build with two stand-in practice servers, for the two-server texts (hosted.spec.ts "two practice servers")
    command: `VITE_HOSTED=1 VITE_BASE44_FAKE=1 VITE_ENGINE_URL=http://localhost:${PORT} VITE_PRACTICE_SERVERS=https://practice.example,https://practice-2.example npx vite build --outDir node_modules/.cache/dist-e2e-two && npx vite preview --outDir node_modules/.cache/dist-e2e-two --port 4174 --strictPort`,
    url: "http://localhost:4174",
    reuseExistingServer: false,
    timeout: 120_000,
  }],
});
