import { expect, test, vi } from "vitest";
import { INVITE_ONLY, NO_BASE44, resolveSession } from "./session";

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const user = { id: "u-1", email: "user-a", full_name: "A" };

test("not signed in (401): one redirect", async () => {
  const signIn = vi.fn();
  expect(await resolveSession(async () => null, signIn, mem())).toEqual({ kind: "signin" });
  expect(signIn).toHaveBeenCalledTimes(1);
});
test("a 403 after the one sign-in redirect says the app is invite-only", async () => {
  const [signIn, store] = [vi.fn(), mem()];
  const forbidden = async () => { throw Object.assign(new Error("x"), { status: 403 }); };
  expect(await resolveSession(forbidden, signIn, store)).toEqual({ kind: "signin" });
  expect(await resolveSession(forbidden, signIn, store)).toEqual({ kind: "error", message: INVITE_ONLY });
  expect(signIn).toHaveBeenCalledTimes(1);
});
test("any other failure (500, network): the message, no redirect", async () => {
  const signIn = vi.fn();
  expect(await resolveSession(async () => { throw Object.assign(new Error("x"), { status: 500 }); }, signIn, mem())).toEqual({ kind: "error", message: NO_BASE44 });
  expect(signIn).not.toHaveBeenCalled();
});
test("a second 401 after a redirect shows the message; a signed-in load clears the guard", async () => {
  const [signIn, store] = [vi.fn(), mem()];
  await resolveSession(async () => null, signIn, store);
  expect(await resolveSession(async () => null, signIn, store)).toEqual({ kind: "error", message: NO_BASE44 });
  expect(signIn).toHaveBeenCalledTimes(1);
  await resolveSession(async () => null, signIn, store); // the message cleared the guard: a reload tries once
  expect(signIn).toHaveBeenCalledTimes(2);
  expect((await resolveSession(async () => user, signIn, store)).kind).toBe("user");
  await resolveSession(async () => null, signIn, store);
  expect(signIn).toHaveBeenCalledTimes(3);
});
test("a build without an app id shows its message and calls nothing", async () => {
  const [cu, signIn] = [vi.fn(), vi.fn()];
  expect(await resolveSession(cu, signIn, mem(), "no id")).toEqual({ kind: "error", message: "no id" });
  expect(cu).not.toHaveBeenCalled(); expect(signIn).not.toHaveBeenCalled();
});

test("blocked sessionStorage never redirects a signed-out visitor: it shows the message (no loop)", async () => {
  const { guardStore, resolveSession, NO_BASE44 } = await import("./session");
  const blocked = guardStore(() => { throw new Error("SecurityError"); });
  const signIn = vi.fn();
  expect(await resolveSession(async () => null, signIn, blocked)).toEqual({ kind: "error", message: NO_BASE44 });
  expect(signIn).not.toHaveBeenCalled();
  const user = { id: "u-1", email: "user-a", full_name: "A" };
  expect(await resolveSession(async () => user, signIn, blocked)).toEqual({ kind: "user", user });  // signed-in users still work
});
