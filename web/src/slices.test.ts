import { expect, test, vi } from "vitest";
import { sliceQueue, wishes } from "./slices";

/** A fake slice source: each get waits until the test settles it, or rejects as fetch does when its signal aborts. */
function source() {
  const open = new Map<number, { ok: () => void; fail: () => void }>(), asked: number[] = [], aborted: number[] = [];
  const get = (z: number, signal: AbortSignal) => new Promise<Int16Array>((res, rej) => {
    asked.push(z);
    open.set(z, { ok: () => res(new Int16Array([z])), fail: () => rej(new Error("x")) });
    signal.addEventListener("abort", () => { aborted.push(z); open.delete(z); rej(new DOMException("aborted", "AbortError")); });
  });
  const settle = async (z: number, ok = true) => { const o = open.get(z)!; open.delete(z); if (ok) o.ok(); else o.fail(); await tick(); };
  return { get, asked, aborted, settle };
}
const tick = () => new Promise((r) => setTimeout(r));

test("at most `max` slices are fetched at once, the most wanted first", () => {
  const s = source(), q = sliceQueue(s.get, () => {}, () => {}, 2);
  q.want([5, 6, 7, 4]);
  expect(s.asked).toEqual([5, 6]);
});
test("a new wish drops the old wishes not started yet: a fast scroll never queues the slices it passed", async () => {
  const s = source(), q = sliceQueue(s.get, () => {}, () => {}, 2);
  q.want([1, 2, 3, 4]);
  q.want([20, 21, 22]);
  expect(s.asked).toEqual([1, 2, 20, 21]); // 3 and 4 are never asked for
  await s.settle(20);
  expect(s.asked).toEqual([1, 2, 20, 21, 22]);
});
test("when every slot is full, a new wish aborts the newest slice no longer wanted (the older ones are nearer done); an abort is not a failure", async () => {
  const s = source(), failed: number[] = [], q = sliceQueue(s.get, () => {}, (z) => failed.push(z), 2);
  q.want([1, 2]);
  q.want([2, 10]); // 2 is still wanted: only 1 makes room
  expect(s.aborted).toEqual([1]);
  expect(s.asked).toEqual([1, 2, 10]);
  await tick();
  expect(failed).toEqual([]);
  q.want([1]); // aborted, so never fetched: asked again; 2 and 10 are no longer wanted, and 10 is the newer
  expect(s.aborted).toEqual([1, 10]);
  expect(s.asked).toEqual([1, 2, 10, 1]);
  await s.settle(2);
  expect(q.have.get(2)).toEqual(new Int16Array([2])); // the older one was left to land
});
test("stop aborts every slice in flight, reports no failure and starts nothing more (unmount, scan change)", async () => {
  const s = source(), failed: number[] = [], loaded: number[] = [], q = sliceQueue(s.get, (z) => loaded.push(z), (z) => failed.push(z), 2);
  q.want([1, 2, 3, 4]);
  q.stop();
  expect(s.aborted).toEqual([1, 2]);
  await tick();
  expect(s.asked).toEqual([1, 2]); // 3 and 4 never start, though the aborted ones settled
  expect([failed, loaded]).toEqual([[], []]);
});
test("by default six slices are in flight at once", () => {
  const s = source(), q = sliceQueue(s.get, () => {}, () => {});
  q.want([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(s.asked).toEqual([1, 2, 3, 4, 5, 6]);
});
test("a fetched slice is kept, reported, and never fetched again; one in flight is not asked for twice", async () => {
  const s = source(), loaded: number[] = [], q = sliceQueue(s.get, (z) => loaded.push(z), () => {}, 2);
  q.want([1, 2]);
  q.want([2, 1, 3]); // both in flight: only 3 waits
  await s.settle(1);
  expect(loaded).toEqual([1]);
  expect(q.have.get(1)).toEqual(new Int16Array([1]));
  expect(s.asked).toEqual([1, 2, 3]);
  q.want([1]);
  expect(s.asked).toEqual([1, 2, 3]);
});
test("a failed slice is reported and asked for again on the next wish", async () => {
  const s = source(), failed: number[] = [], q = sliceQueue(s.get, () => {}, (z) => failed.push(z), 2);
  q.want([7]);
  await s.settle(7, false);
  expect(failed).toEqual([7]);
  expect(q.have.has(7)).toBe(false);
  q.want([7]);
  expect(s.asked).toEqual([7, 7]);
});
test("nearest: the fetched slice closest to z, or none", async () => {
  const s = source(), q = sliceQueue(s.get, () => {}, () => {}, 3);
  expect(q.nearest(5)).toBeUndefined();
  q.want([2, 9, 12]);
  await s.settle(2); await s.settle(9);
  expect(q.nearest(5)).toBe(2); // 12 is not fetched yet
  expect(q.nearest(8)).toBe(9);
  expect(q.nearest(9)).toBe(9);
});
test("wishes: this slice, then two ahead in the scroll's direction, then two behind, inside the scan", () => {
  expect(wishes(10, 9, 100)).toEqual([10, 11, 12, 9, 8]); // scrolling up the index
  expect(wishes(10, 11, 100)).toEqual([10, 9, 8, 11, 12]); // scrolling down
  expect(wishes(0, 0, 100)).toEqual([0, 1, 2]);
  expect(wishes(99, 98, 100)).toEqual([99, 98, 97]);
});
test("a slice with no answer in 20 s is aborted and reported as failed; a step away (it is a neighbour then) asks for it again", async () => {
  vi.useFakeTimers();
  try {
    const s = source(), failed: number[] = [], q = sliceQueue(s.get, () => {}, (z) => failed.push(z));
    q.want([5, 6, 7, 4, 3]);
    vi.advanceTimersByTime(19_999);
    expect(failed).toEqual([]);
    void s.settle(6); void s.settle(7); void s.settle(4); void s.settle(3); // the neighbours answer; 5 hangs
    for (let i = 0; i < 5; i++) await Promise.resolve(); // their answers are handled, as long before 20 s in a page
    vi.advanceTimersByTime(1);
    expect(failed).toEqual([5]);
    expect(s.aborted).toEqual([5]);
    q.want([6, 7, 8, 5, 4]); // one image away: 5 is a wish behind, and no longer in flight
    expect(s.asked.filter((z) => z === 5)).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
test("a slice aborted as stale is never reported as failed when its 20 s would have passed", () => {
  vi.useFakeTimers();
  try {
    const failed: number[] = [], q = sliceQueue(() => new Promise<Int16Array>(() => {}), () => {}, (z) => failed.push(z), 1); // a source that ignores the abort
    q.want([1]);
    q.want([2]); // 1 is stale: aborted for 2
    vi.advanceTimersByTime(19_999);
    expect(failed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failed).toEqual([2]); // only 2's own limit
  } finally {
    vi.useRealTimers();
  }
});
