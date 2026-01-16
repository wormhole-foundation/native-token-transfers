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
