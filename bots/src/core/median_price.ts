/**
 * Per-region rolling median + realized-vol buffer for short-window
 * mean-reversion strategies.
 *
 * Differs from `pm25_history` in two ways:
 *   - Sub-minute resolution (samples carry their own timestamps; pruning
 *     is by wall-clock window, not hourly buckets).
 *   - Operates on the prices the bot can actually trade against
 *     (Jupiter USDC-per-token from `prices.ts`), so the median IS
 *     the strategy's reference fair-value.
 *
 * Caller pushes one sample per tick, then asks for `median()` (used as
 * fair-value reference) or `volatility()` (used as a regime filter).
 *
 * Returns `null` if not enough samples to span the window — caller should
 * skip decisions during warm-up rather than trade on a noisy estimate.
 */

export interface PriceSample {
  /** unix sec */
  ts: number;
  /** USDC per 1 region token, human units (e.g. 0.078) */
  price: number;
}

export class MedianBuffer {
  private buffer: PriceSample[] = [];

  constructor(private readonly windowMin: number) {
    if (windowMin <= 0) throw new Error(`MedianBuffer windowMin must be > 0, got ${windowMin}`);
  }

  /** Add a sample. Prunes anything older than `windowMin` from the head. */
  push(price: number, nowSec: number = Math.floor(Date.now() / 1000)): void {
    if (!Number.isFinite(price) || price <= 0) return;       // skip junk
    this.buffer.push({ ts: nowSec, price });
    const cutoff = nowSec - this.windowMin * 60;
    while (this.buffer.length > 0 && this.buffer[0]!.ts < cutoff) {
      this.buffer.shift();
    }
  }

  /** Sample count in the current window. */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Median of samples in the window. Requires the buffer to span at least
   * 80% of the window (so we don't median-of-3 in a 5-min window) and have
   * at least 5 samples — otherwise null. Tunable; the floor exists so a
   * cold start doesn't trade on a near-empty buffer.
   */
  median(minSamples = 5): number | null {
    if (this.buffer.length < minSamples) return null;
    const span = this.buffer[this.buffer.length - 1]!.ts - this.buffer[0]!.ts;
    if (span < this.windowMin * 60 * 0.8) return null;

    const sorted = this.buffer.map((s) => s.price).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  }

  /**
   * Realized volatility = stddev / mean over the last `lookbackMin` minutes.
   * Returns null if the buffer doesn't have enough samples in the lookback.
   * Used as a regime filter (skip when vol is "too high to mean-revert").
   *
   * Note: lookbackMin can be different from the median window — vol is
   * usually computed over a wider window (e.g. 60 min) than the
   * fair-value reference (e.g. 30 min).
   */
  volatility(lookbackMin: number, minSamples = 10): number | null {
    const now = this.buffer[this.buffer.length - 1]?.ts;
    if (now == null) return null;
    const cutoff = now - lookbackMin * 60;
    const slice = this.buffer.filter((s) => s.ts >= cutoff).map((s) => s.price);
    if (slice.length < minSamples) return null;

    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    if (mean <= 0) return null;
    const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / slice.length;
    return Math.sqrt(variance) / mean;
  }

  /**
   * Arithmetic MEAN of samples within the last `lookbackMin` minutes.
   *
   * Added for the DSL live-feature layer (Phase 2): the Python decoder's
   * `dev_60m/240m/1440m` features divide the current price by the
   * arithmetic mean of the trailing window — NOT the median. This
   * accessor reproduces `mean_over` from `lab/runners/wallet-evolve.py`:
   * it returns the mean iff there are at least `minSamples` (default 2,
   * matching Python's `len(vals) >= 2`) samples in the window, else null.
   *
   * Unlike `median()`/`volatility()`, this does NOT impose an 80%-span
   * floor — Python's `mean_over` has no such guard, and matching it is
   * required for snapshot parity.
   */
  mean(lookbackMin: number, minSamples = 2): number | null {
    const now = this.buffer[this.buffer.length - 1]?.ts;
    if (now == null) return null;
    const cutoff = now - lookbackMin * 60;
    const slice = this.buffer.filter((s) => s.ts >= cutoff).map((s) => s.price);
    if (slice.length < minSamples) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  /** Latest price (for spread = price / median - 1). */
  latest(): number | null {
    return this.buffer[this.buffer.length - 1]?.price ?? null;
  }

  /** Read-only snapshot of all samples in the buffer. Used by the
   *  /debug/strategy-state endpoint to surface buffer contents — lets
   *  us tell "buffer is full of identical samples (oracle stuck)" from
   *  "buffer has variation but median was higher than entry threshold". */
  samples(): ReadonlyArray<PriceSample> {
    return this.buffer;
  }
}
