// The practice servers: our engine in a Hugging Face Space. /api/info needs no token and does not take the hold.
export type PracticeState = "ready" | "busy" | "paused" | "unavailable" | "starting";

// The first call with a token can wait up to 5 s for the engine's Base44 check; a starting Space gives no answer for 15 to 120 s.
export const PROBE_MS = 8000;

/** The build-time list: https origins only (each one gets the visitor's token), without spaces or trailing slashes. */
export const servers = (raw: string | undefined) =>
  (raw ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => s.startsWith("https://"));

/** One look at a server, without the token: a simple GET needs no preflight, so Hugging Face's own 503 pages stay readable.
 * Hugging Face answers a paused Space with an immediate 503 and its "paused" page, and a starting one not at all
 * (our tests). A sleeping one (automatic sleep) also holds the request until it wakes, so it reads as starting:
 * our test woke one in about 50 s with no "paused" text. Its wording is not an API, so anything else unexpected is "unavailable".
 * Only our engine says busy, and it answers its own preflight: then ask once more with the token, so the holder (a reload) sees free. */
export async function probe(url: string, token: string | undefined, timeoutMs = PROBE_MS): Promise<PracticeState> {
  const state = await ask(url, undefined, timeoutMs);
  return state === "busy" && token ? ask(url, token, timeoutMs) : state;
}

async function ask(url: string, token: string | undefined, timeoutMs: number): Promise<PracticeState> {
  try {
    const r = await fetch(`${url}/api/info`, { headers: token ? { authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 503) return (await r.text()).includes("paused") ? "paused" : "unavailable";
    const busy = r.ok ? (await r.json())?.server?.busy : undefined;
    return busy === false ? "ready" : busy === true ? "busy" : "unavailable";
  } catch (e) {
    return (e as Error).name === "TimeoutError" ? "starting" : "unavailable";
  }
}

const HOPE: PracticeState[] = ["ready", "busy", "starting", "unavailable", "paused"]; // the state most likely to let the visitor in soon comes first
/** The first ready server in list order; with none ready, the most hopeful state, for its message. */
export const pickServer = (states: { url: string; state: PracticeState }[]) =>
  states.reduce((best, s) => (HOPE.indexOf(s.state) < HOPE.indexOf(best.state) ? s : best));

/** A server that has answered "starting" for this long without a break counts as stuck (no T4 free, a crash loop): the next one is asked too.
 *  A wake from sleep takes about 1 minute and a cold start about 4. */
export const STUCK_MS = 5 * 60_000;
/** When each server began answering "starting" without a break. */
export function waking(now = () => Date.now()) {
  const since = new Map<string, number>();
  return {
    seen: (url: string, s: PracticeState) => { if (s !== "starting") since.delete(url); else if (!since.has(url)) since.set(url, now()); },
    stuck: (url: string) => since.has(url) && now() - since.get(url)! >= STUCK_MS,
  };
}

/** The servers in list order, one at a time: the next is asked only when this one cannot serve (busy, paused, failing or stuck starting), never
 *  while it is ready or waking, because each ask wakes a sleeping server for an hour of T4 time (automatic sleep). The answer as pickServer gives it. */
export async function askInOrder(urls: string[], look: (url: string) => Promise<PracticeState>, stuck: (url: string) => boolean = () => false) {
  const seen: { url: string; state: PracticeState }[] = [];
  for (const url of urls) {
    const state = await look(url);
    seen.push({ url, state });
    if (state === "ready" || (state === "starting" && !stuck(url))) break;
  }
  return pickServer(seen);
}
