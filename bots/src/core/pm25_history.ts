/**
 * Per-strategy rolling PM2.5 history. Each strategy instance gets its own
 * buffer so concurrent bots don't interfere.
 *
 * Source:
 *   refresh()  — every tick, hits /api/signals for live values.
 *   Hourly-bucketed so multiple ticks within the same hour don't
 *   inflate the sample count. The buffer warms up live over time.
 */
import { fetchBundles } from './scores.js';
import type { RegionKey } from '../regions.js';

export interface Pm25Sample {
  ts: number; // unix seconds
  values: Record<RegionKey, number | null>;
}

export class Pm25History {
  private buffer: Pm25Sample[] = [];
  private readonly maxLookbackHrs: number;
  /** Wall-clock ms of the last successful refresh(). Distinct from a
   *  sample's `ts`, which is bucketed to the top of the hour — this is
   *  the actual fetch time, so the dashboard can show a truthful
   *  "updated Ns ago" that ticks second by second. */
  private lastFetchMs: number | null = null;

  constructor(maxLookbackHrs: number) {
    this.maxLookbackHrs = maxLookbackHrs;
  }

  /** Wall-clock ms of the last successful refresh(), or null if none. */
  lastSuccessfulFetchMs(): number | null {
    return this.lastFetchMs;
  }

  /**
   * Pull current pm25 from /api/signals. Bucketed to the wall-clock hour
   * to match the backtest's 1h bar resolution: the latest hour's bucket
   * is overwritten as new readings arrive within that hour. Once the hour
   * rolls over, the bucket freezes and a new one opens.
   *
   * This guarantees the percentile/zscore math sees the same N hourly
   * observations the backtest worked on, regardless of how often the
   * runner ticks.
   */
  async refresh(): Promise<Pm25Sample> {
    const bundles = await fetchBundles();
    const hourTs = Math.floor(Date.now() / 3_600_000) * 3600;
    const sample: Pm25Sample = {
      ts: hourTs,
      values: { CHI: null, NYC: null, TOR: null },
    };
    for (const b of bundles) {
      sample.values[b.key] = b.currentPm25;
    }

    const last = this.buffer[this.buffer.length - 1];
    if (last && last.ts === hourTs) {
      // Same hour bucket: overwrite latest reading.
      last.values = sample.values;
    } else {
      this.buffer.push(sample);
    }

    const cutoff = hourTs - this.maxLookbackHrs * 3600;
    while (this.buffer.length > 0 && this.buffer[0].ts < cutoff) {
      this.buffer.shift();
    }
    this.lastFetchMs = Date.now();
    return sample;
  }

  /** Get last N hours of samples for one region (excludes nulls). */
  recent(region: RegionKey, hours: number): number[] {
    if (this.buffer.length === 0) return [];
    const cutoff = this.buffer[this.buffer.length - 1].ts - hours * 3600;
    return this.buffer
      .filter((s) => s.ts >= cutoff)
      .map((s) => s.values[region])
      .filter((v): v is number => v != null);
  }

  /** Latest sample (or null if empty). */
  current(): Pm25Sample | null {
    return this.buffer[this.buffer.length - 1] ?? null;
  }

  /** Number of samples currently held. Strategies use this to know if
   *  they have enough history yet. */
  size(): number {
    return this.buffer.length;
  }
}

/** Percentile of `value` within `samples` (0-100). Uses rank/length. */
export function percentile(value: number, samples: number[]): number {
  if (samples.length === 0) return 50;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = sorted.findIndex((s) => s >= value);
  return idx < 0 ? 100 : (idx / sorted.length) * 100;
}

/** Standard z-score of `value` against `samples`. */
export function zscore(value: number, samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (value - mean) / std;
}
