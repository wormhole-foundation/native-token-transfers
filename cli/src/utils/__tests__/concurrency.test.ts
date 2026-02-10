import { describe, test, expect } from "bun:test";
import { runTaskPool, runTaskPoolWithSequential } from "../concurrency";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Delay helper that returns after `ms` milliseconds. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Creates a task function that tracks in-flight concurrency.
 * Returns `{ task, peakConcurrency }` where `peakConcurrency()` gives the
 * maximum number of tasks that were executing at the same time.
 */
function concurrencyTracker<T, R>(
  fn: (item: T, index: number) => Promise<R>
): { task: (item: T, index: number) => Promise<R>; peakConcurrency: () => number } {
  let inflight = 0;
  let peak = 0;
  const task = async (item: T, index: number): Promise<R> => {
    inflight++;
    if (inflight > peak) peak = inflight;
    try {
      return await fn(item, index);
    } finally {
      inflight--;
    }
  };
  return { task, peakConcurrency: () => peak };
}

// ---------------------------------------------------------------------------
// runTaskPool
// ---------------------------------------------------------------------------

describe("runTaskPool", () => {
  test("returns empty array for empty input", async () => {
    const result = await runTaskPool([], 4, async () => 1);
    expect(result).toEqual([]);
  });

  test("preserves input order", async () => {
    const items = [30, 10, 20, 5, 15];
    // Each task returns after a delay proportional to its value, so the
    // natural completion order differs from input order.
    const result = await runTaskPool(items, 5, async (ms) => {
      await delay(ms);
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40, 10, 30]);
  });

  test("single item", async () => {
    const result = await runTaskPool([42], 3, async (x) => x + 1);
    expect(result).toEqual([43]);
  });

  test("concurrency is respected", async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const { task, peakConcurrency } = concurrencyTracker(async (item: number) => {
      await delay(20);
      return item;
    });
    await runTaskPool(items, 3, task);
    expect(peakConcurrency()).toBeLessThanOrEqual(3);
    // With 12 items and sufficient delay, we should actually hit 3.
    expect(peakConcurrency()).toBe(3);
  });

  test("concurrency capped to item count when items < concurrency", async () => {
    const items = [1, 2];
    const { task, peakConcurrency } = concurrencyTracker(async (item: number) => {
      await delay(20);
      return item;
    });
    await runTaskPool(items, 10, task);
    expect(peakConcurrency()).toBe(2);
  });

  test("concurrency=1 runs sequentially", async () => {
    const order: number[] = [];
    const items = [1, 2, 3];
    await runTaskPool(items, 1, async (item) => {
      order.push(item);
      await delay(5);
      return item;
    });
    expect(order).toEqual([1, 2, 3]);
  });

  test("normalizes bad concurrency values to 1", async () => {
    // NaN, 0, negative, fractional
    for (const bad of [0, -1, NaN, 0.5]) {
      const result = await runTaskPool([10, 20], bad, async (x) => x);
      expect(result).toEqual([10, 20]);
    }
  });

  test("passes correct index to task", async () => {
    const items = ["a", "b", "c"];
    const indices: number[] = [];
    await runTaskPool(items, 2, async (_, i) => {
      indices.push(i);
      return i;
    });
    // All indices should be present (order may vary due to concurrency)
    expect(indices.sort()).toEqual([0, 1, 2]);
  });

  test("propagates task error", async () => {
    const items = [1, 2, 3];
    const promise = runTaskPool(items, 2, async (item) => {
      if (item === 2) throw new Error("boom");
      await delay(50);
      return item;
    });
    await expect(promise).rejects.toThrow("boom");
  });

  test("early error rejects the pool without processing all items", async () => {
    // Worker 2 throws on item 1 immediately. Promise.all rejects, so later
    // items (2, 3) should never start.
    const started: number[] = [];
    const items = [0, 1, 2, 3];
    try {
      await runTaskPool(items, 2, async (item) => {
        started.push(item);
        if (item === 1) throw new Error("fail");
        await delay(50);
        return item;
      });
    } catch {
      // expected
    }
    // Items 0 and 1 started (two workers), but not all 4.
    expect(started.length).toBeLessThan(items.length);
  });
});

// ---------------------------------------------------------------------------
// runTaskPoolWithSequential
// ---------------------------------------------------------------------------

describe("runTaskPoolWithSequential", () => {
  test("returns empty array for empty input", async () => {
    const result = await runTaskPoolWithSequential(
      [],
      4,
      () => true,
      async () => 1
    );
    expect(result).toEqual([]);
  });

  test("all items sequential", async () => {
    const order: number[] = [];
    const items = [1, 2, 3, 4];
    const result = await runTaskPoolWithSequential(
      items,
      4,
      () => true, // everything sequential
      async (item) => {
        order.push(item);
        await delay(5);
        return item * 10;
      }
    );
    // Sequential means strict input order.
    expect(order).toEqual([1, 2, 3, 4]);
    expect(result).toEqual([10, 20, 30, 40]);
  });

  test("all items parallel", async () => {
    const items = [30, 10, 20];
    const { task, peakConcurrency } = concurrencyTracker(async (item: number) => {
      await delay(item);
      return item;
    });
    const result = await runTaskPoolWithSequential(
      items,
      5,
      () => false, // nothing sequential
      task
    );
    expect(result).toEqual([30, 10, 20]); // order preserved
    expect(peakConcurrency()).toBe(3);
  });

  test("mixed: sequential items run serially, parallel items use pool", async () => {
    // Items: [seq, par, par, seq, par]
    const items = [
      { id: 0, seq: true },
      { id: 1, seq: false },
      { id: 2, seq: false },
      { id: 3, seq: true },
      { id: 4, seq: false },
    ];
    const seqOrder: number[] = [];
    const result = await runTaskPoolWithSequential(
      items,
      3,
      (item) => item.seq,
      async (item) => {
        if (item.seq) seqOrder.push(item.id);
        await delay(10);
        return item.id * 2;
      }
    );
    // Result order matches input order.
    expect(result).toEqual([0, 2, 4, 6, 8]);
    // Sequential items ran in their relative input order.
    expect(seqOrder).toEqual([0, 3]);
  });

  test("sequential lane runs concurrently with parallel lane", async () => {
    // If they ran one after the other, total time would be ~60ms.
    // If they run together, total should be ~30ms.
    const start = Date.now();
    const items = [
      { id: 0, seq: true },
      { id: 1, seq: false },
    ];
    await runTaskPoolWithSequential(
      items,
      2,
      (item) => item.seq,
      async () => {
        await delay(30);
        return 0;
      }
    );
    const elapsed = Date.now() - start;
    // Should be closer to 30ms than 60ms — allow generous margin for CI.
    expect(elapsed).toBeLessThan(55);
  });

  test("result indices are correct for mixed sequential/parallel", async () => {
    // Deliberately make parallel items finish faster to verify index mapping.
    const items = ["seq-slow", "par-fast", "par-fast", "seq-slow"];
    const result = await runTaskPoolWithSequential(
      items,
      4,
      (item) => item.startsWith("seq"),
      async (item, index) => {
        await delay(item.startsWith("seq") ? 30 : 5);
        return `${index}:${item}`;
      }
    );
    expect(result).toEqual([
      "0:seq-slow",
      "1:par-fast",
      "2:par-fast",
      "3:seq-slow",
    ]);
  });

  test("parallel lane respects concurrency cap", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let parallelInflight = 0;
    let parallelPeak = 0;
    const result = await runTaskPoolWithSequential(
      items,
      3,
      (item) => item < 2, // first 2 items are sequential
      async (item) => {
        if (item >= 2) {
          parallelInflight++;
          if (parallelInflight > parallelPeak) parallelPeak = parallelInflight;
        }
        await delay(15);
        if (item >= 2) {
          parallelInflight--;
        }
        return item;
      }
    );
    expect(result).toEqual(items);
    expect(parallelPeak).toBeLessThanOrEqual(3);
    // 8 parallel items with cap 3 should actually reach 3.
    expect(parallelPeak).toBe(3);
  });

  test("error in sequential lane propagates", async () => {
    const items = [1, 2, 3];
    const promise = runTaskPoolWithSequential(
      items,
      2,
      (item) => item === 2,
      async (item) => {
        if (item === 2) throw new Error("seq-boom");
        await delay(50);
        return item;
      }
    );
    await expect(promise).rejects.toThrow("seq-boom");
  });

  test("error in parallel lane propagates", async () => {
    const items = [1, 2, 3];
    const promise = runTaskPoolWithSequential(
      items,
      2,
      (item) => item === 1, // only 1 is sequential
      async (item) => {
        if (item === 3) throw new Error("par-boom");
        await delay(50);
        return item;
      }
    );
    await expect(promise).rejects.toThrow("par-boom");
  });
});
