export interface MetricSample {
  labels: Record<string, string>;
  value: number;
  suffix?: "_bucket" | "_sum" | "_count";
}

/** Retains a fixed number of label sets; excess observations share one overflow series. */
export class MetricSeries<T> {
  private readonly data = new Map<string, { labels: Record<string, string>; value: T }>();
  private overflow?: { labels: Record<string, string>; value: T };

  private readonly limit: number;

  constructor(limit = 1000) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("metrics.maxSeries must be a positive safe integer");
    }
    this.limit = limit;
  }

  get(labels: Record<string, string>, init: () => T): T {
    const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
    const existing = this.data.get(key);
    if (existing) return existing.value;
    if (this.data.size >= this.limit) {
      this.overflow ??= { labels: { overflow: "true" }, value: init() };
      return this.overflow.value;
    }
    const entry = { labels: { ...labels }, value: init() };
    this.data.set(key, entry);
    return entry.value;
  }

  entries(): Array<{ labels: Record<string, string>; value: T }> {
    return [...this.data.values(), ...(this.overflow ? [this.overflow] : [])];
  }

  reset(): void {
    this.data.clear();
    this.overflow = undefined;
  }
}

interface HistogramState {
  buckets: number[];
  sum: number;
  count: number;
}

export const DURATION_BUCKETS_SECONDS = [
  0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/** Stores disjoint bucket counts; exported buckets are cumulative and include +Inf. */
export class MetricHistogram {
  private readonly series: MetricSeries<HistogramState>;
  private readonly bounds: readonly number[];

  constructor(bounds: readonly number[], maxSeries = 1000) {
    this.bounds = bounds;
    this.series = new MetricSeries(maxSeries);
  }

  observe(labels: Record<string, string>, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const state = this.series.get(labels, () => ({
      buckets: new Array(this.bounds.length + 1).fill(0),
      sum: 0,
      count: 0,
    }));
    const index = this.bounds.findIndex((bound) => value <= bound);
    const bucket = index < 0 ? this.bounds.length : index;
    state.buckets[bucket] = (state.buckets[bucket] ?? 0) + 1;
    state.sum += value;
    state.count++;
  }

  values(): MetricSample[] {
    return this.series.entries().flatMap(({ labels, value }) => {
      let cumulative = 0;
      const buckets: MetricSample[] = value.buckets.map((count, index) => {
        cumulative += count;
        return {
          labels: { ...labels, le: this.bounds[index]?.toString() ?? "+Inf" },
          value: cumulative,
          suffix: "_bucket",
        };
      });
      return [
        ...buckets,
        { labels: { ...labels }, value: value.sum, suffix: "_sum" as const },
        { labels: { ...labels }, value: value.count, suffix: "_count" as const },
      ];
    });
  }

  reset(): void {
    this.series.reset();
  }
}

export function renderMetricSample(name: string, sample: MetricSample): string {
  const labels = Object.entries(sample.labels)
    .map(
      ([key, value]) =>
        `${key}="${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`,
    )
    .join(",");
  return `${name}${sample.suffix ?? ""}${labels ? `{${labels}}` : ""} ${sample.value}`;
}
