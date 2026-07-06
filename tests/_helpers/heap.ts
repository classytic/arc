/**
 * Shared heap-measurement helpers for the perf lane (`npm run test:perf`,
 * run with `--expose-gc`). Kept in one place so every leak/efficiency test
 * measures the same way — median-of-N sampling to filter GC noise, forced GC
 * when available, microtask/immediate yields to drain pending work.
 */

/** Force GC if exposed (`--expose-gc`), otherwise just yield the event loop. */
export async function gc(): Promise<void> {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    // Second pass gives the collector a chance to clean up GC artifacts.
    await new Promise((r) => setTimeout(r, 10));
    globalThis.gc();
  }
  await new Promise((r) => setImmediate(r));
}

/** Current heap usage in MB. */
export function heapUsedMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Median heap (MB) across N GC'd samples — filters out GC-timing noise. */
export async function measureHeapMedian(samples: number): Promise<number> {
  const readings: number[] = [];
  for (let i = 0; i < samples; i++) {
    await gc();
    readings.push(heapUsedMB());
  }
  readings.sort((a, b) => a - b);
  return readings[Math.floor(readings.length / 2)] ?? 0;
}
