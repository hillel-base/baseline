import { beforeEach, expect, test } from "vitest";
import * as fake from "./base44.fake";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  (globalThis as any).window = { location: { reload() {} } };
});
test("the fake client is signed in as test-user unless the flag is set", async () => {
  expect(await fake.currentUser()).toEqual({ id: "fake-user-1", email: "test-user", full_name: "Test User" });
  store.set("lung.fake.signedOut", "1");
  expect(await fake.currentUser()).toBeNull();
});
test("the fake signIn only counts the call; signOut sets the flag", () => {
  fake.signIn();
  expect((globalThis as any).window.__fakeSignIn).toBe(1);
  fake.signOut();
  expect(store.get("lung.fake.signedOut")).toBe("1");
});
test("the fake entities create, filter and list under lung.fake.store only, and fail on request", async () => {
  const a = await fake.entities.Scan.create({ scan_ref: "x" });
  await fake.entities.Scan.create({ scan_ref: "y" });
  expect(await fake.entities.Scan.filter({ scan_ref: "x" })).toEqual([a]);
  expect(await fake.entities.Scan.list()).toHaveLength(2);
  expect([...store.keys()]).toEqual(["lung.fake.store"]);
  expect(await fake.entities.NoduleMeasurement.list()).toEqual([]);
  store.set("lung.fake.saveFail", "1");
  await expect(fake.entities.NoduleMeasurement.create({})).rejects.toThrow("Fake save failure");
});
test("lung.fake.listDelay slows the two list calls by that many ms (the rows as they were when asked), and notes when each was asked", async () => {
  await fake.entities.Scan.create({ scan_ref: "x" });
  store.set("lung.fake.listDelay", "50");
  const t0 = Date.now(), asked = fake.entities.Scan.list();
  await fake.entities.Scan.create({ scan_ref: "y" }); // saved after the ask
  expect(await asked).toHaveLength(1);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  expect((globalThis as any).window.__fakeLists).toHaveLength(1); // the e2e times the Study table's loads by these
});
test("the fake client hands out a fixed fake token", () => {
  expect(fake.accessToken()).toBe("fake-base44-token");
});
