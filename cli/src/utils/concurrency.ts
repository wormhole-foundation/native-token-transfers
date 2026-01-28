// Run async tasks with a fixed concurrency cap, preserving input order.
export async function runTaskPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const normalized = Math.max(1, Math.floor(concurrency) || 1);
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await task(items[index]!, index);
    }
  };
  const workerCount = Math.min(normalized, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Run tasks where a subset must execute sequentially (e.g., rate-limited chains),
// while the rest use a pool. Note: the sequential lane runs alongside the pool,
// so total in-flight work can be pool concurrency + 1.
export async function runTaskPoolWithSequential<T, R>(
  items: T[],
  concurrency: number,
  shouldRunSequential: (item: T, index: number) => boolean,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  const sequential: Array<{ item: T; index: number }> = [];
  const parallel: Array<{ item: T; index: number }> = [];

  items.forEach((item, index) => {
    if (shouldRunSequential(item, index)) {
      sequential.push({ item, index });
    } else {
      parallel.push({ item, index });
    }
  });

  const runSequential = async () => {
    for (const { item, index } of sequential) {
      results[index] = await task(item, index);
    }
  };

  const runParallel = async () => {
    if (parallel.length === 0) {
      return;
    }
    await runTaskPool(parallel, concurrency, async ({ item, index }) => {
      const value = await task(item, index);
      results[index] = value;
      return value;
    });
  };

  if (sequential.length === 0) {
    await runParallel();
    return results;
  }
  if (parallel.length === 0) {
    await runSequential();
    return results;
  }

  await Promise.all([runParallel(), runSequential()]);
  return results;
}
