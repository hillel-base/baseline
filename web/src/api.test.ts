import { afterEach, expect, test, vi } from "vitest";
import { ENGINE_STOPPED, IN_USE, PRACTICE_STOPPED, SIGN_IN_FIRST, getInfo, getSlice, listScans, onBlocked, paintStroke, postEvent, probeEngine, releaseSession, setApiBase, setAuth, setAxes, startNodule } from "./api";

afterEach(() => { setApiBase(""); setAuth(undefined); onBlocked(() => {}); vi.unstubAllGlobals(); });
const stub = (body: unknown = [], ok = true, status = ok ? 200 : 500) => { const f = vi.fn(async () => ({ ok, status, url: "u", json: async () => body, arrayBuffer: async () => new ArrayBuffer(4) })); vi.stubGlobal("fetch", f); return f; };
const authOf = (f: ReturnType<typeof stub>, i: number) => ((f.mock.calls[i] as unknown as [string, RequestInit?])[1]?.headers as Record<string, string> | undefined)?.authorization;

test("releaseSession posts /api/session/release once to the practice server with the token; never to the local engine; a lost answer is ignored", async () => {
  const f = stub();
  setApiBase("https://p.example", true); setAuth("tok");
  await releaseSession();
  expect(f).toHaveBeenCalledTimes(1);
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect([url, init.method, authOf(f, 0)]).toEqual(["https://p.example/api/session/release", "POST", "Bearer tok"]);
  setApiBase("http://localhost:8000"); setAuth(undefined);
  await releaseSession();
  expect(f).toHaveBeenCalledTimes(1);
  setApiBase("https://p.example", true); setAuth("tok");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(releaseSession()).resolves.toBeUndefined();
});
test("the local build keeps relative /api; setApiBase moves every call", async () => {
  const f = stub();
  await listScans();
  expect(f).toHaveBeenLastCalledWith("/api/scans", undefined);
  setApiBase("http://localhost:8000");
  await listScans();
  expect(f).toHaveBeenLastCalledWith("http://localhost:8000/api/scans", undefined);
});
test("probeEngine asks /api/info with a timeout and does not change the base", async () => {
  const f = stub({ commit: "abc123" });
  expect((await probeEngine("http://localhost:8000")).commit).toBe("abc123");
  expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://localhost:8000/api/info");
  expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);
  await listScans();
  expect(f).toHaveBeenLastCalledWith("/api/scans", undefined);
});
test("probeEngine waits 5 s by default, and as long as it is told (the practice server's PROBE_MS)", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  stub({ commit: "abc123" });
  await probeEngine("http://localhost:8000");
  await probeEngine("https://p.example", 8000);
  expect(timeout.mock.calls).toEqual([[5000], [8000]]);
  timeout.mockRestore();
});
test("on a practice server, a lost answer or a failed scan list says the practice server's own text, never the README one", async () => {
  setApiBase("https://p.example", true);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(startNodule("s", { z: 1, y: 2, x: 3 })).rejects.toThrow(PRACTICE_STOPPED);
  await expect(listScans()).rejects.toThrow(PRACTICE_STOPPED);
  stub({}, false, 500);
  await expect(listScans()).rejects.toThrow(PRACTICE_STOPPED);
});
test("the local engine keeps its own texts", async () => {
  setApiBase("http://localhost:8000");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(startNodule("s", { z: 1, y: 2, x: 3 })).rejects.toThrow(ENGINE_STOPPED);
  await expect(listScans()).rejects.toThrow("Failed to fetch");
  stub({}, false, 500);
  await expect(listScans()).rejects.toThrow("u: 500");
});
test("probeEngine rejects on an error status", async () => {
  stub({}, false);
  await expect(probeEngine("http://localhost:8000")).rejects.toThrow();
});
test("a stroke and hand-set axes post the engine's own bodies for the nodule on the page", async () => {
  const f = stub({});
  const sent = () => { const [url, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit]; return [url, init.method, JSON.parse(init.body as string)]; };
  await paintStroke({ scan: "s", nodule: 2 }, { z: 161, points: [[300, 310], [301, 312]], radius: 3, mode: "erase", snap: true });
  expect(sent()).toEqual(["/api/nodule/paint", "POST", { scan: "s", nodule: 2, z: 161, points: [[300, 310], [301, 312]], radius: 3, mode: "erase", snap: true }]);
  await setAxes({ scan: "s", nodule: 2 }, [[1, 2], [3.5, 4]], [[5, 6], [7, 8]]);
  expect(sent()).toEqual(["/api/nodule/axes", "POST", { scan: "s", nodule: 2, long_line: [[1, 2], [3.5, 4]], short_line: [[5, 6], [7, 8]] }]);
});
test("a save_failed with no engine connected (API base \"\") is dropped; other events still go to the page's own engine", () => {
  const f = stub();
  postEvent({ action: "save_failed", reason: "503" });
  expect(f).not.toHaveBeenCalled();
  postEvent({ action: "copy_row" }); // the engine-served page: base "" is its own engine
  expect(f).toHaveBeenLastCalledWith("/api/events", expect.anything());
  setApiBase("http://localhost:8000");
  postEvent({ action: "save_failed", reason: "503" });
  expect(f).toHaveBeenLastCalledWith("http://localhost:8000/api/events", expect.anything());
});
test("while a token is set, every engine call sends it: GET, slices, POST and events; cleared, none does", async () => {
  const f = stub({});
  setApiBase("https://p.example");
  setAuth("tok");
  await listScans();
  await getSlice("s", 3);
  await startNodule("s", { z: 1, y: 2, x: 3 });
  postEvent({ action: "zoom" });
  await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(4));
  for (let i = 0; i < 4; i++) expect(authOf(f, i)).toBe("Bearer tok");
  expect((f.mock.calls[2] as unknown as [string, RequestInit])[1].headers).toEqual({ "content-type": "application/json", authorization: "Bearer tok" });
  setAuth(undefined);
  await listScans();
  expect(authOf(f, 4)).toBeUndefined();
});
test("a 401 or 423 says the page's own text, never the raw body, and tells the status line; a later answer clears it", async () => {
  const heard: (string | undefined)[] = [];
  onBlocked((t) => heard.push(t));
  stub({ detail: "raw engine words" }, false, 423);
  await expect(startNodule("s", { z: 1, y: 2, x: 3 })).rejects.toThrow(IN_USE);
  await expect(listScans()).rejects.toThrow(IN_USE);
  stub({ detail: "raw engine words" }, false, 401);
  await expect(getSlice("s", 0)).rejects.toThrow(SIGN_IN_FIRST);
  stub({ device: "cuda" });
  await getInfo(); // /api/info answers everyone, holder or not: it says nothing about a refusal
  expect(heard).toEqual([IN_USE, IN_USE, SIGN_IN_FIRST]);
  stub([]);
  await listScans();
  expect(heard).toEqual([IN_USE, IN_USE, SIGN_IN_FIRST, undefined]);
});

test("on a practice server, a 502-504 mid-session (Hugging Face's own page) is the designed stopped state, never 'The engine failed'", async () => {
  setApiBase("https://p.example", true);
  for (const status of [502, 503, 504]) {
    stub("The space is paused, ask a maintainer to restart it", false, status);
    await expect(startNodule("RIDER-1286684383_test", { z: 1, y: 2, x: 3 })).rejects.toThrow(PRACTICE_STOPPED);
  }
  setApiBase("http://localhost:8000");
  stub({}, false, 503);
  await expect(startNodule("RIDER-1286684383_test", { z: 1, y: 2, x: 3 })).rejects.toThrow("The engine failed (503).");
});

test("on a practice server, a lost answer or a 502-504 tells the status line it stopped; the local engine never does", async () => {
  const heard: (string | undefined)[] = [];
  onBlocked((t) => heard.push(t));
  setApiBase("https://p.example", true);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(getSlice("s", 0)).rejects.toThrow(PRACTICE_STOPPED);
  postEvent({ action: "zoom" });
  await vi.waitFor(() => expect(heard).toHaveLength(2));
  stub("Hugging Face's page", false, 502);
  await expect(listScans()).rejects.toThrow(PRACTICE_STOPPED);
  stub([]);
  await listScans();
  expect(heard).toEqual([PRACTICE_STOPPED, PRACTICE_STOPPED, PRACTICE_STOPPED, undefined]);
  heard.length = 0;
  setApiBase("http://localhost:8000");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await expect(listScans()).rejects.toThrow("Failed to fetch");
  stub({}, false, 503);
  await expect(listScans()).rejects.toThrow("u: 503");
  expect(heard).toEqual([undefined]);
});

test("a slice request the page aborted is not a stopped practice server: the abort passes through, the status line hears nothing", async () => {
  setApiBase("https://practice.example", true);
  const heard: (string | undefined)[] = [];
  onBlocked((t) => heard.push(t));
  const f = vi.fn(async (_u: string, init?: RequestInit) => { if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError"); throw new TypeError("Failed to fetch"); });
  vi.stubGlobal("fetch", f);
  const c = new AbortController();
  c.abort();
  await expect(getSlice("s", 0, c.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.mock.calls[0][1]?.signal).toBe(c.signal);
  expect(heard).toEqual([]);
  await expect(getSlice("s", 0)).rejects.toThrow(PRACTICE_STOPPED); // a real loss still says stopped
  expect(heard).toEqual([PRACTICE_STOPPED]);
});
test("slice route: with the token (a practice server) a slice is one POST /api/slice; without it (the local engine, from either page) the same GET as before", async () => {
  const f = stub({});
  const c = new AbortController();
  const call = (i: number) => f.mock.calls[i] as unknown as [string, RequestInit | undefined];
  await getSlice("s", 3, c.signal); // the engine-served page
  setApiBase("http://localhost:8000"); // the hosted page with the local engine: no token
  await getSlice("s", 4);
  setApiBase("https://p.example", true);
  setAuth("tok"); // a practice server
  await getSlice("s", 5, c.signal);
  expect(call(0)).toEqual(["/api/scans/s/slices/3", { signal: c.signal }]);
  expect(call(1)).toEqual(["http://localhost:8000/api/scans/s/slices/4", { signal: undefined }]);
  expect(call(2)).toEqual(["https://p.example/api/slice",
    { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer tok" }, body: JSON.stringify({ scan: "s", z: 5 }), signal: c.signal }]);
});
test("404 fallback: a practice engine with no POST /api/slice (an older one) gets the same slice again by GET, then GET for good on that base; nothing says stopped", async () => {
  const heard: (string | undefined)[] = [];
  onBlocked((t) => heard.push(t));
  const f = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/api/slice")
    ? { ok: false, status: 404, url, json: async () => ({ detail: "Not Found" }), arrayBuffer: async () => new ArrayBuffer(0), clone() { return this; } }
    : { ok: true, status: 200, url, json: async () => ({}), arrayBuffer: async () => new Int16Array([7, 8]).buffer, clone() { return this; } });
  vi.stubGlobal("fetch", f);
  const seen = () => f.mock.calls.map(([u, i]) => [u, i?.method ?? "GET", (i?.headers as Record<string, string>)?.authorization, i?.signal]);
  setApiBase("https://old.example", true);
  setAuth("tok");
  const c = new AbortController();
  expect(await getSlice("s", 5, c.signal)).toEqual(new Int16Array([7, 8])); // the slice arrives, by GET
  expect(seen()).toEqual([["https://old.example/api/slice", "POST", "Bearer tok", c.signal], ["https://old.example/api/scans/s/slices/5", "GET", "Bearer tok", c.signal]]);
  await getSlice("s", 6);
  expect(seen()[2]).toEqual(["https://old.example/api/scans/s/slices/6", "GET", "Bearer tok", undefined]); // no POST first any more
  expect(f).toHaveBeenCalledTimes(3);
  setApiBase("https://other.example", true); // another practice server starts on POST again
  await getSlice("s", 7);
  expect(seen()[3].slice(0, 2)).toEqual(["https://other.example/api/slice", "POST"]);
  expect(heard.filter(Boolean)).toEqual([]); // no error and no "stopped" on the status line
});

test("404 fallback: a genuine 404 from a NEW engine (an unknown scan) shows its error and keeps POST for that base", async () => {
  const f = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: false, status: 404, url, json: async () => ({ detail: "unknown scan" }), arrayBuffer: async () => new ArrayBuffer(0), clone() { return this; } }));
  vi.stubGlobal("fetch", f);
  setApiBase("https://new.example", true);
  setAuth("tok");
  await expect(getSlice("D-00000000", 5)).rejects.toThrow();
  expect(f).toHaveBeenCalledTimes(1); // no GET retry: the route exists, the scan does not
  await getSlice("D-00000000", 6).catch(() => {});
  expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].method).toBe("POST"); // still POST on that base
});
