/** CT slices fetched at most `max` at a time, the most wanted first (on a far server the image fell behind the indicator).
 *  A slice in flight that is no longer wanted keeps its slot, so it may still land and be shown on the way, until a new wish needs the
 *  slot: then the newest such slice is aborted (the older ones are nearer done). With 6 slots and at most 5 wishes every wish starts at
 *  once, so a scroll aborts stale slices rather than skipping them; `want` also drops wishes not started, for a smaller `max`.
 *  Measured on a 300 ms link: never slower than before by more than noise, and the picture moves in a steady scroll,
 *  where 3 slots, or aborting the oldest, left it frozen. 6 is also the most HTTP/1.1 connections a browser opens to one server.
 *  shortcut: `have` keeps every slice fetched (about 0.5 MB each, as the cache before it did); drop far ones if memory ever matters. */
export function sliceQueue(get: (z: number, signal: AbortSignal) => Promise<Int16Array>, onLoad: (z: number) => void, onFail: (z: number) => void, max = 6, limitMs = 20_000) {
  const have = new Map<number, Int16Array>(), busy = new Map<number, AbortController>(); // busy: in flight, oldest first
  let wanted: number[] = [], next: number[] = []; // next: wanted, not started
  const start = (z: number) => {
    const c = new AbortController();
    busy.set(z, c);
    const limit = setTimeout(() => { // no answer in time: a failure ("Scroll to retry"), and out of flight, so the next wish asks again
      if (c.signal.aborted) return; // already ours: stale or stopped
      c.abort(); // the queue's own abort: send() stays quiet, unlike a TimeoutError
      if (busy.get(z) === c) busy.delete(z);
      onFail(z);
      pump();
    }, limitMs);
    get(z, c.signal)
      .then((hu) => { have.set(z, hu); onLoad(z); }, () => { if (!c.signal.aborted) onFail(z); }) // an abort is ours, not a failure
      .finally(() => { clearTimeout(limit); if (busy.get(z) === c) busy.delete(z); pump(); });
  };
  const pump = () => {
    while (next.length) {
      if (busy.size >= max) {
        const stale = [...busy.keys()].reverse().find((k) => !wanted.includes(k)); // the newest first
        if (stale === undefined) return;
        busy.get(stale)!.abort();
        busy.delete(stale);
      }
      start(next.shift()!);
    }
  };
  return {
    have,
    /** The slices wanted now, most wanted first; any earlier wish not started yet is dropped. */
    want(zs: number[]) { wanted = zs; next = zs.filter((z) => !have.has(z) && !busy.has(z)); pump(); },
    /** Aborts everything in flight and wants nothing: the view is gone (an unmount, which a scan change also is). */
    stop() { wanted = []; next = []; for (const c of busy.values()) c.abort(); busy.clear(); },
    /** The fetched slice nearest to z, if any. */
    nearest(z: number) {
      let best: number | undefined;
      for (const k of have.keys()) if (best === undefined || Math.abs(k - z) < Math.abs(best - z)) best = k;
      return best;
    },
  };
}

/** What to fetch on reaching slice z from `from`: z, two ahead in the scroll's direction, then two behind, inside 0..depth-1. */
export const wishes = (z: number, from: number, depth: number) => {
  const d = z < from ? -1 : 1;
  return [z, z + d, z + 2 * d, z - d, z - 2 * d].filter((k) => k >= 0 && k < depth);
};
