// Test build only (VITE_BASE44_FAKE=1): never imports the SDK, so nothing can reach Base44.
const flag = (k: string) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const out = () => flag("lung.fake.signedOut");
// localStorage "lung.fake.notInvited"=1: Base44's 403 for a signed-in person the app is not open to
export const currentUser = async () => { if (flag("lung.fake.notInvited")) throw Object.assign(new Error("Forbidden"), { status: 403 }); return out() ? null : { id: "fake-user-1", email: "test-user", full_name: "Test User" }; };
export const signIn = () => { const w = window as unknown as { __fakeSignIn?: number }; w.__fakeSignIn = (w.__fakeSignIn ?? 0) + 1; }; // the e2e reads this
export const accessToken = () => "fake-base44-token"; // what a practice server gets in the e2e
export const signOut = () => { try { localStorage.setItem("lung.fake.signedOut", "1"); } catch { /* the reload still shows the flag-less state */ } window.location.reload(); };
// Kept under lung.fake.store, so a reload keeps the rows as Base44 would; a test page starts empty (each Playwright test has its own browser storage).
// localStorage "lung.fake.saveFail"=1 makes every create fail.
const KEY = "lung.fake.store";
const fail = () => { try { return localStorage.getItem("lung.fake.saveFail") === "1"; } catch { return false; } };
const load = (): Record<string, Record<string, unknown>[]> => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
const store = (name: string) => ({
  filter: async (q: Record<string, unknown>) => (load()[name] ?? []).filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)) as never[],
  create: async (o: Record<string, unknown>) => {
    if (fail()) throw new Error("Fake save failure");
    const all = load(), rows = (all[name] ??= []), r = { ...o, id: `${name}${rows.length + 1}` };
    rows.push(r);
    localStorage.setItem(KEY, JSON.stringify(all));
    return r as never;
  },
  list: async () => (load()[name] ?? []) as never[],
});
export const entities = { Scan: store("Scan"), NoduleMeasurement: store("NoduleMeasurement") };
