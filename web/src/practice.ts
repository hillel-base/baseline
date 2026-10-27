// The practice servers: our engine in a Hugging Face Space. /api/info needs no token and does not take the hold.
export type PracticeState = "ready" | "busy" | "paused" | "unavailable" | "starting";

// The first call with a token can wait up to 5 s for the engine's Base44 check; a starting Space gives no answer for 15 to 120 s.
export const PROBE_MS = 8000;

/** The build-time list: https origins only (each one gets the visitor's token), without spaces or trailing slashes. */
export const servers = (raw: string | undefined) =>
  (raw ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => s.startsWith("https://"));

/** One look at a server, without the token: a simple GET needs no preflight, so Hugging Face's own 503 pages stay readable.
 * Hugging Face answers a paused Space with an immediate 503 and its "paused" page, and a starting one not at all
 * (our tests). Its wording is not an API, so anything else unexpected is "unavailable".
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
