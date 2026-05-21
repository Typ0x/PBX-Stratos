/**
 * Engine-cycle feed for the DSL live-feature layer (Phase 2).
 *
 * The Python decoder (`compute_snapshots` in `bear-scout/runners/wallet-evolve.py`)
 * builds, per engine rebalance cycle, four signed "flow" features
 * (`flow_1/2/5/10`) plus the raw `cycle_sold` / `cycle_bought` labels.
 * `flow_history.ts` cannot serve these: it computes *net USDC* (not a
 * signed cycle count) and is gated on `DATABASE_URL`. This module is the
 * replacement â€” it pulls recent engine rebalance cycles from the PUBLIC
 * lab API (`/api/lab/cycles`), works with no `DATABASE_URL` (explore
 * mode), and exposes the exact signed cycle-count flow the decoder uses.
 *
 * â”€â”€ Faithful reproduction of a Python quirk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * The Python `flow()` does `c['bought'] == region` / `c['sold'] == region`
 * where `region` is one of the short codes 'NYC' / 'CHI' / 'TOR'. But the
 * `/api/lab/cycles` endpoint returns `sold`/`bought` as a MIX of labels:
 * 'NYC' uses the short code, while Chicago/Toronto come back as the FULL
 * city name ('Chicago' / 'Toronto'). So in Python, `flow()` only ever
 * matches NYC â€” CHI and TOR flow are structurally always 0. Verified
 * against real `snapshots.json` files: every CHI/TOR snapshot has
 * flow_1/2/5/10 == 0, while NYC snapshots carry the full Â±N range.
 *
 * This is a bug in the Python decoder, but the live layer's job is
 * PARITY with the decoder, not correctness â€” a decoded rule was fitted
 * against these exact (NYC-only) flow values. So `flowFor()` deliberately
 * reproduces the label-mismatch: it compares cycle labels to the region
 * using the SAME asymmetric matching, yielding NYC-only flow. See the
 * parity harness for the assertion that locks this in.
 *
 * `cycle_sold` / `cycle_bought` are surfaced verbatim (whatever label the
 * API returned â€” 'NYC' / 'Chicago' / 'Toronto' / null), matching what
 * the decoder stores in the snapshot dict.
 *
 * Cache: ~60s. Engine cycles fire ~every 6 min, so a per-tick (15-60s)
 * bot must not re-fetch on every tick.
 */

export interface EngineCycle {
  /** unix seconds */
  ts: number;
  /** raw label as returned by the API: 'NYC' | 'Chicago' | 'Toronto' | null */
  sold: string | null;
  /** raw label as returned by the API: 'NYC' | 'Chicago' | 'Toronto' | null */
  bought: string | null;
}

const DEFAULT_API_BASE = 'https://pbx-mainnet-api.onrender.com';

interface RawCycle {
  ts: string;
  sold: string | null;
  bought: string | null;
}

export class CycleHistory {
  /** Cycles sorted ascending by ts. */
  private cycles: EngineCycle[] = [];
  private lastRefreshMs = 0;
  private readonly refreshIntervalMs: number;
  private readonly days: number;
  private inFlight: Promise<EngineCycle[]> | null = null;

  /**
   * @param days             history window for the `/api/lab/cycles` query.
   * @param refreshIntervalMs cache TTL. 60s default â€” cycles fire ~6 min apart.
   */
  constructor(days = 2, refreshIntervalMs = 60_000) {
    this.days = days;
    this.refreshIntervalMs = refreshIntervalMs;
  }

  /**
   * Returns the current cycle list, refreshing from the public API if the
   * cache is stale. Returns whatever is cached (possibly empty) on failure.
   */
  async getCycles(): Promise<EngineCycle[]> {
    const age = Date.now() - this.lastRefreshMs;
    if (this.lastRefreshMs > 0 && age < this.refreshIntervalMs) {
      return this.cycles;
    }
    if (this.inFlight != null) return this.inFlight;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async refresh(): Promise<EngineCycle[]> {
    try {
      const apiBase = process.env.STRATOS_LAB_API_BASE ?? process.env.STRATOS_API_BASE ?? DEFAULT_API_BASE;
      const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/lab/cycles?days=${this.days}`);
      if (!res.ok) {
        console.warn(`[cycle-history] fetch failed: HTTP ${res.status}`);
        return this.cycles;
      }
      const body = (await res.json()) as { cycles?: RawCycle[] };
      const rows = body.cycles ?? [];
      const parsed: EngineCycle[] = rows.map((c) => ({
        ts: Math.floor(new Date(c.ts).getTime() / 1000),
        sold: c.sold ?? null,
        bought: c.bought ?? null,
      })).filter((c) => Number.isFinite(c.ts));
      parsed.sort((a, b) => a.ts - b.ts);
      this.cycles = parsed;
      this.lastRefreshMs = Date.now();
      return this.cycles;
    } catch (err) {
      console.warn('[cycle-history] refresh error:', (err as Error).message);
      return this.cycles;
    }
  }

  /** Directly seed the cycle list (used by tests / preseed). */
  seed(cycles: EngineCycle[]): void {
    this.cycles = [...cycles].sort((a, b) => a.ts - b.ts);
    this.lastRefreshMs = Date.now();
  }

  /** Read-only view of cached cycles (ascending). */
  all(): ReadonlyArray<EngineCycle> {
    return this.cycles;
  }

  /**
   * Index of the most recent cycle at or before `tsSec`, or -1 if none.
   * Mirrors the decoder's per-cycle iteration: at engine cycle `idx`,
   * features are computed using cycles `[0 .. idx]`.
   */
  indexAt(tsSec: number): number {
    let idx = -1;
    for (let i = 0; i < this.cycles.length; i++) {
      if (this.cycles[i]!.ts <= tsSec) idx = i;
      else break;
    }
    return idx;
  }

  /** The cycle at or before `tsSec` (the "current" engine cycle), or null. */
  cycleAt(tsSec: number): EngineCycle | null {
    const idx = this.indexAt(tsSec);
    return idx >= 0 ? this.cycles[idx]! : null;
  }

  /**
   * Signed cycle-count flow for `region` as of the cycle at `tsSec`.
   *
   * Verbatim port of the Python `flow(region, idx, lookback)`:
   *
   *     start = max(0, idx - lookback)
   *     f = 0
   *     for i in range(start, idx + 1):
   *       if cycles[i]['bought'] == region: f += 1
   *       if cycles[i]['sold']   == region: f -= 1
   *
   * i.e. it sums over `lookback + 1` cycles. `flow_1` => 2 cycles, etc.
   *
   * `region` must be a short code ('NYC' | 'CHI' | 'TOR'). Because the
   * API returns Chicago/Toronto as full names, CHI/TOR flow is always 0
   * here â€” exactly as in the Python decoder (see file header).
   */
  flowFor(region: string, tsSec: number, lookback: number): number {
    const idx = this.indexAt(tsSec);
    if (idx < 0) return 0;
    const start = Math.max(0, idx - lookback);
    let f = 0;
    for (let i = start; i <= idx; i++) {
      const c = this.cycles[i]!;
      if (c.bought === region) f += 1;
      if (c.sold === region) f -= 1;
    }
    return f;
  }
}

// Module-level singleton so a multi-bot fleet shares one cache and does
// not hammer the public API with N concurrent fetches per tick.
let _instance: CycleHistory | null = null;
export function getCycleHistory(days = 2, refreshIntervalMs = 60_000): CycleHistory {
  if (_instance == null) _instance = new CycleHistory(days, refreshIntervalMs);
  return _instance;
}
