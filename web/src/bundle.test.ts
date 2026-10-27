import { expect, test } from "vitest";
import { build } from "vite";

// The page the engine serves (the user's computer) writes nothing to Base44, because its bundle holds no Base44 client.
// The hosted build is checked too, so the markers are known to be the SDK's. The flags are set here, whatever the shell running the tests holds.
const bundle = async (env: Record<string, string>) => {
  const define = Object.fromEntries(["VITE_HOSTED", "VITE_BASE44_FAKE", "VITE_BASE44_APP_ID"].map((k) => [`import.meta.env.${k}`, JSON.stringify(env[k] ?? "")]));
  const out = await build({ logLevel: "silent", define, build: { write: false } });
  return (Array.isArray(out) ? out : [out]).flatMap((o) => ("output" in o ? o.output : [])).map((c) => ("code" in c ? c.code : String(c.source))).join("\n");
};
const SDK = /base44_access_token|\/api\/apps\//;
test("the engine-served build holds no Base44 client; the hosted build does", async () => {
  expect(await bundle({})).not.toMatch(SDK);
  expect(await bundle({ VITE_HOSTED: "1", VITE_BASE44_APP_ID: "x" })).toMatch(SDK);
}, 120_000);
