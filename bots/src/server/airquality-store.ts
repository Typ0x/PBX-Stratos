/**
 * AirQualityStore — the central pm25 data layer.
 *
 * Holds per-region timestamped pm25 samples (rolling 48h window).
 * Sample-based, NOT fixed-interval buckets — hourly backfill points and
 * 5-minute live points coexist; percentile/zscore rank the current
 * reading against whatever samples exist. Persisted to disk so warmup
 * survives restarts.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { REGIONS, type RegionKey } from '../../../kernel/ts/src/regions.js';
import { percentile, zscore } from '../../../kernel/ts/src/pm25_history.js';

export interface Pm25Sample {
  ts: number;   // unix seconds
  pm25: number; // µg/m³
}

// Rolling retention window. Wide on purpose: the cold-start backfill
// pulls from the pbx-air-quality-dataset repo, whose newest data lags
// real time by several days — a short window would prune that backfill
// away the moment a fresh live sample landed, leaving percentile/zscore
// with nothing to rank against. 30 days comfortably holds stale backfill
// alongside live samples.
const WINDOW_HOURS = 30 * 24;
const WINDOW_SEC = WINDOW_HOURS * 3600;

function defaultStorePath(): string {
  const dir = process.env.STRATOS_BOTS_DATA_DIR ?? join(homedir(), '.pbx-bots');
  return join(dir, 'airquality.json');
}

interface PersistShape {
  samples: Partial<Record<RegionKey, Pm25Sample[]>>;
  lastFetchMs: number | null;
}

export class AirQualityStore {
  private samples: Record<RegionKey, Pm25Sample[]> = { CHI: [], NYC: [], TOR: [] };
  private lastFetchMs: number | null = null;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? defaultStorePath();
  }

  /** Append live readings (one per region) at ts=nowSec. */
  ingestLive(
    values: Partial<Record<RegionKey, number | null | undefined>>,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): void {
    for (const r of REGIONS) {
      const v = values[r.key];
      if (v != null && Number.isFinite(v)) this.append(r.key, { ts: nowSec, pm25: v });
    }
    this.lastFetchMs = Date.now();
    this.prune();
  }

  /** Seed historical backfill samples — may arrive out of order. */
  seedBackfill(byRegion: Partial<Record<RegionKey, Pm25Sample[]>>): void {
    for (const r of REGIONS) {
      for (const s of byRegion[r.key] ?? []) this.append(r.key, s);
    }
    this.prune();
  }

  private append(region: RegionKey, s: Pm25Sample): void {
    const arr = this.samples[region];
    const i = arr.findIndex((x) => x.ts === s.ts);
    if (i >= 0) arr[i] = s;
    else arr.push(s);
    arr.sort((a, b) => a.ts - b.ts);
  }

  /** Newest sample ts across all regions, or now — the window anchor. */
  private anchorSec(): number {
    let anchor: number | null = null;
    for (const r of REGIONS) {
      const arr = this.samples[r.key];
      if (arr.length) {
        const last = arr[arr.length - 1].ts;
        anchor = anchor == null ? last : Math.max(anchor, last);
      }
    }
    return anchor ?? Math.floor(Date.now() / 1000);
  }

  private prune(): void {
    const cutoff = this.anchorSec() - WINDOW_SEC;
    for (const r of REGIONS) {
      this.samples[r.key] = this.samples[r.key].filter((s) => s.ts >= cutoff);
    }
  }

  current(region: RegionKey): number | null {
    const arr = this.samples[region];
    return arr.length ? arr[arr.length - 1].pm25 : null;
  }

  recent(region: RegionKey, hours: number = WINDOW_HOURS): number[] {
    const cutoff = this.anchorSec() - hours * 3600;
    return this.samples[region].filter((s) => s.ts >= cutoff).map((s) => s.pm25);
  }

  size(region: RegionKey): number {
    return this.samples[region].length;
  }

  isEmpty(): boolean {
    return REGIONS.every((r) => this.samples[r.key].length === 0);
  }

  percentile(region: RegionKey): number | null {
    const cur = this.current(region);
    const samples = this.recent(region);
    if (cur == null || samples.length < 2) return null;
    // Rank the current reading against the prior history (exclude the
    // current sample itself) so a reading at the window max scores 100.
    return percentile(cur, samples.slice(0, -1));
  }

  zscore(region: RegionKey): number | null {
    const cur = this.current(region);
    const samples = this.recent(region);
    if (cur == null || samples.length < 2) return null;
    return zscore(cur, samples.slice(0, -1));
  }

  /** Wall-clock ms of the last successful live ingest, or null. */
  lastUpdatedMs(): number | null {
    return this.lastFetchMs;
  }

  /** Persist atomically (temp file + rename), mode 0600. */
  save(): void {
    const shape: PersistShape = { samples: this.samples, lastFetchMs: this.lastFetchMs };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape), { mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best-effort */ }
  }

  /** Load from disk. Missing/corrupt file -> empty store, never throws. */
  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as PersistShape;
      for (const r of REGIONS) this.samples[r.key] = raw.samples?.[r.key] ?? [];
      this.lastFetchMs = raw.lastFetchMs ?? null;
      this.prune();
    } catch {
      /* no file or corrupt — keep the empty store */
    }
  }
}
