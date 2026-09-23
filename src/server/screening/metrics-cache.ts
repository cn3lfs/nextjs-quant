import type { Snapshot, Strategy, Metrics } from "~/lib/domain";
import { metrics } from "~/lib/screening/screening-metrics";

// Only accept snapshots whose hash describes the completed, filtered bars.
// The caller still independently recomputes the candidate research window.
export class MetricsCache {
  private entries = new Map<string, Metrics | null>();
  constructor(private readonly limit = 20000) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("Invalid cache limit");
  }
  get(snapshot: Snapshot, strategy: Strategy): Metrics | null {
    const key = JSON.stringify([
      "metrics-1",
      snapshot.symbol,
      snapshot.period,
      snapshot.adjustment,
      snapshot.hash,
      strategy.fast,
      strategy.slow,
      strategy.minChange,
      strategy.maxChange,
      strategy.minVolumeRatio,
    ]);
    if (this.entries.has(key)) {
      const value = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, value);
      return value ? { ...value } : null;
    }
    const value = metrics(snapshot.bars, strategy);
    this.entries.set(key, value ? { ...value } : null);
    if (this.entries.size > this.limit)
      this.entries.delete(this.entries.keys().next().value!);
    return value;
  }
}

export const screeningMetrics = new MetricsCache();
