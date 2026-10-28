import { afterEach, expect, test, vi } from "vitest";
import { PROBE_MS, STUCK_MS, askInOrder, pickServer, probe, servers, waking, type PracticeState } from "./practice";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const answer = (status: number, body: unknown) => {
  const f = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
};
const info = (busy: boolean) => ({ commit: "abc", model: "m", device: "cuda", server: { busy, idle_min: 10 } });
const sent = (f: ReturnType<typeof answer>) => f.mock.calls[0] as unknown as [string, RequestInit];

test("a free server is ready, asked at /api/info with a time limit", async () => {
  const f = answer(200, info(false));
  expect(await probe("https://p.example", undefined)).toBe("ready");
  expect(sent(f)[0]).toBe("https://p.example/api/info");
  expect(sent(f)[1].signal).toBeInstanceOf(AbortSignal);
});
test("the probe asks without the token first (no preflight); only a busy answer is asked again, once, with the token", async () => {
  const replies = [info(true), info(false)]; // the engine says busy to a stranger, free to its own holder
  const f = vi.fn(async () => new Response(JSON.stringify(replies.shift())));
  vi.stubGlobal("fetch", f);
  expect(await probe("https://p.example", "tok")).toBe("ready");
  expect(f).toHaveBeenCalledTimes(2);
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toBeUndefined();
  expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({ authorization: "Bearer tok" });
});
test("a free server, or a busy one with no token to show, is asked only once, with no header", async () => {
  let f = answer(200, info(false));
  expect(await probe("https://p.example", "tok")).toBe("ready");
  expect(f).toHaveBeenCalledTimes(1);
  expect(sent(f)[1].headers).toBeUndefined();
  f = answer(200, info(true));
  expect(await probe("https://p.example", undefined)).toBe("busy");
  expect(f).toHaveBeenCalledTimes(1);
});
test("paused and the other Hugging Face pages are read from the token-free ask, never asked with the token", async () => {
  const f = answer(503, "The space is paused, ask a maintainer to restart it");
  expect(await probe("https://p.example", "tok")).toBe("paused");
  expect(f).toHaveBeenCalledTimes(1);
});
test("the time limit is one constant, 8000 ms, for both asks: room for the engine's 5 s Base44 check", async () => {
  expect(PROBE_MS).toBe(8000);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  answer(200, info(true));
  await probe("https://p.example", "tok");
  expect(timeout.mock.calls).toEqual([[PROBE_MS], [PROBE_MS]]);
});
test("the server list keeps https origins only, without spaces or trailing slashes; unset or empty is no server", () => {
  expect(servers(" https://a.hf.space/ ,http://b.example,https://c.hf.space//,,ftp://d, https://e.hf.space")).toEqual(["https://a.hf.space", "https://c.hf.space", "https://e.hf.space"]);
  expect(servers(undefined)).toEqual([]);
  expect(servers("")).toEqual([]);
});
test("a held server is busy", async () => {
  answer(200, info(true));
  expect(await probe("https://p.example", "tok")).toBe("busy");
});
test("503 with Hugging Face's paused text is paused", async () => {
  answer(503, "The space is paused, ask a maintainer to restart it");
  expect(await probe("https://p.example", "tok")).toBe("paused");
});
test("any other answer is unavailable: another 503, a 500, an engine without the server block", async () => {
  answer(503, "Your space is in error, check its status on hf.co");
  expect(await probe("https://p.example", "tok")).toBe("unavailable");
  answer(500, "oops");
  expect(await probe("https://p.example", "tok")).toBe("unavailable");
  answer(200, { commit: "abc", model: "m" });
  expect(await probe("https://p.example", "tok")).toBe("unavailable");
});
test("an immediate network error is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  expect(await probe("https://p.example", "tok")).toBe("unavailable");
});
test("no answer within the time limit is starting: a starting Space, and a sleeping one that is waking", async () => {
  vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason)))));
  expect(await probe("https://p.example", "tok", 30)).toBe("starting");
});
test("the first ready server in list order wins; with none ready, the most hopeful state shows", () => {
  expect(pickServer([{ url: "a", state: "busy" }, { url: "b", state: "ready" }, { url: "c", state: "ready" }])).toEqual({ url: "b", state: "ready" });
  expect(pickServer([{ url: "a", state: "paused" }, { url: "b", state: "starting" }])).toEqual({ url: "b", state: "starting" });
  expect(pickServer([{ url: "a", state: "unavailable" }, { url: "b", state: "busy" }])).toEqual({ url: "b", state: "busy" });
  expect(pickServer([{ url: "a", state: "paused" }])).toEqual({ url: "a", state: "paused" });
});

// Automatic sleep: each ask wakes a sleeping server for an hour of T4 time, so the next server is asked only when this one cannot serve.
const looks = (states: Record<string, PracticeState>) => { const asked: string[] = []; return { asked, look: async (u: string) => { asked.push(u); return states[u]; } }; };
test("askInOrder: server 1 ready or waking is the answer, and server 2 is never asked (never woken)", async () => {
  for (const one of ["ready", "starting"] as const) {
    const { asked, look } = looks({ a: one, b: "ready" });
    expect(await askInOrder(["a", "b"], look)).toEqual({ url: "a", state: one });
    expect(asked).toEqual(["a"]);
  }
});
test("askInOrder: server 1 busy, paused or failing asks server 2; the first ready wins, else the most hopeful state", async () => {
  for (const one of ["busy", "paused", "unavailable"] as const) {
    const { asked, look } = looks({ a: one, b: "ready" });
    expect(await askInOrder(["a", "b"], look)).toEqual({ url: "b", state: "ready" });
    expect(asked).toEqual(["a", "b"]);
  }
  expect(await askInOrder(["a", "b"], looks({ a: "busy", b: "busy" }).look)).toEqual({ url: "a", state: "busy" });
  expect(await askInOrder(["a", "b"], looks({ a: "paused", b: "starting" }).look)).toEqual({ url: "b", state: "starting" });
});
test("askInOrder: server 1 starting for STUCK_MS (stuck: no T4, a crash loop) asks server 2 as well; before that, never", async () => {
  expect(STUCK_MS).toBe(5 * 60_000);
  let t = 0;
  const w = waking(() => t), { asked, look } = looks({ a: "starting", b: "ready" });
  const ask = () => askInOrder(["a", "b"], async (u) => { const s = await look(u); w.seen(u, s); return s; }, w.stuck);
  expect(await ask()).toEqual({ url: "a", state: "starting" });
  t = STUCK_MS - 1;
  expect(await ask()).toEqual({ url: "a", state: "starting" });
  expect(asked).toEqual(["a", "a"]); // server 2 still asleep
  t = STUCK_MS;
  expect(await ask()).toEqual({ url: "b", state: "ready" }); // 5 minutes of starting: server 2 is asked and wins
  expect(asked).toEqual(["a", "a", "a", "b"]);
  w.seen("a", "unavailable"); w.seen("a", "starting"); // a break restarts the 5 minutes
  expect(w.stuck("a")).toBe(false);
});
