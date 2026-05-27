/**
 * Cold-start backfill for AirQualityStore — pulls recent hourly pm25
 * history from a public CC-BY air-quality dataset repo and aggregates
 * it to per-city hourly medians.
 *
 * The dataset URL is configurable via `STRATOS_AIRQ_DATASET_URL` so
 * forks can point at their own mirror; if unset we try the default
 * `Typ0x/pbx-air-quality-dataset` repo. This backfill is best-effort
 * cold-start data only — live PurpleAir/AirNow APIs are the primary
 * signal, so a 404/network failure here is non-fatal and returns
 * empty regions silently.
 *
 * Dataset layout (raw.githubusercontent.com):
 *   manifest.csv  — city,provider,locationid,name,lat,lng,n_days,first_day,last_day
 *   data/hourly/{CITY}/{provider_lower}/{locationid}/{YYYYMMDD}.csv.gz
 * Each daily CSV: location_id,sensors_id,location,datetime,lat,lon,parameter,units,value
 */
import { gunzipSync } from 'node:zlib';
import { REGIONS, type RegionKey } from '../../../../kernel/ts/src/regions.js';
import type { Pm25Sample } from './airquality-store.js';

const DATASET_RAW =
  process.env.STRATOS_AIRQ_DATASET_URL?.replace(/\/$/, '') ??
  'https://raw.githubusercontent.com/Typ0x/pbx-air-quality-dataset/main';

export interface ManifestRow {
  city: string;
  provider: string;
  locationid: string;
  lastDay: string;
}

/**
 * Split one CSV line into fields, honoring double-quoted fields:
 * commas inside quotes are not separators, and surrounding quotes
 * (plus doubled `""` escapes) are stripped from each field.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Parse one sensor's daily CSV text (already gunzipped). pm25 rows only. */
export function parseSensorCsv(text: string): Pm25Sample[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]);
  const dtIdx = header.indexOf('datetime');
  const valIdx = header.indexOf('value');
  const parIdx = header.indexOf('parameter');
  if (dtIdx < 0 || valIdx < 0) return [];
  const out: Pm25Sample[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (parIdx >= 0 && cols[parIdx] !== 'pm25') continue;
    const ts = Math.floor(new Date(cols[dtIdx]).getTime() / 1000);
    const v = Number(cols[valIdx]);
    if (Number.isFinite(ts) && Number.isFinite(v) && v >= 0 && v < 500) {
      out.push({ ts, pm25: v });
    }
  }
  return out;
}

/** Median pm25 per wall-clock hour across multiple sensors' samples. */
export function hourlyCityMedian(perSensor: Pm25Sample[][]): Pm25Sample[] {
  const byHour = new Map<number, number[]>();
  for (const sensor of perSensor) {
    for (const s of sensor) {
      const hr = Math.floor(s.ts / 3600) * 3600;
      const arr = byHour.get(hr) ?? [];
      arr.push(s.pm25);
      byHour.set(hr, arr);
    }
  }
  const out: Pm25Sample[] = [];
  for (const [hr, vals] of byHour) {
    vals.sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const med = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    out.push({ ts: hr, pm25: med });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Parse manifest.csv into rows. */
export function parseManifest(text: string): ManifestRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const h = splitCsvLine(lines[0]);
  const ci = h.indexOf('city');
  const pi = h.indexOf('provider');
  const li = h.indexOf('locationid');
  const di = h.indexOf('last_day');
  const out: ManifestRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (!c[ci] || !c[li]) continue;
    // last_day values carry a `.csv` suffix in the real dataset.
    const lastDay = (c[di] ?? '').replace(/\.csv$/i, '');
    out.push({ city: c[ci], provider: c[pi], locationid: c[li], lastDay });
  }
  return out;
}

/** Minimal fetch surface so tests can inject an offline implementation. */
type FetchLike = (url: string) => Promise<{
  ok: boolean;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Parse a clean `YYYYMMDD` string into a UTC Date. */
function parseYmd(s: string): Date {
  return new Date(
    Date.UTC(
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)) - 1,
      Number(s.slice(6, 8)),
    ),
  );
}

/**
 * Fetch ~`daysBack` days of hourly pm25 from the dataset repo and
 * aggregate to per-city hourly medians. Best-effort: any failure for a
 * file/city is swallowed; a total failure returns empty regions.
 */
export async function fetchBackfill(
  daysBack = 3,
  fetchImpl: FetchLike = (url) => fetch(url) as unknown as ReturnType<FetchLike>,
): Promise<Record<RegionKey, Pm25Sample[]>> {
  const result: Record<RegionKey, Pm25Sample[]> = { CHI: [], NYC: [], TOR: [] };
  let rows: ManifestRow[];
  try {
    const res = await fetchImpl(`${DATASET_RAW}/manifest.csv`);
    if (!res.ok) {
      // Bug #5 fix: the default dataset URL (Typ0x/pbx-air-quality-dataset)
      // doesn't exist publicly yet, so on fresh installs this 404s on
      // every cold boot. Demoted from console.warn to console.info and
      // shortened the message — live PurpleAir / AirNow is the primary
      // data source anyway; the dataset backfill is purely a "give the
      // user historical context on day 1" nice-to-have. Override with
      // STRATOS_AIRQ_DATASET_URL if you stand up your own dataset mirror.
      console.info(
        `[airquality-backfill] no cold-start dataset at ${DATASET_RAW} (status ${res.status}). Live data only -- this is fine.`,
      );
      return result;
    }
    rows = parseManifest(await res.text());
  } catch (err) {
    console.info(
      `[airquality-backfill] cold-start dataset unreachable (${err instanceof Error ? err.message : String(err)}). Live data only -- this is fine.`,
    );
    return result;
  }
  // The dataset lags reality by several days, so anchor the day window on
  // the most recent `last_day` across the manifest (string-max of the clean
  // 8-digit dates) rather than today — otherwise every CSV request 404s.
  const anchorYmd = rows
    .map((r) => r.lastDay)
    .filter((d) => /^\d{8}$/.test(d))
    .reduce((max, d) => (d > max ? d : max), '');
  if (!anchorYmd) return result;
  const anchor = parseYmd(anchorYmd);
  const days: string[] = [];
  for (let i = 0; i < daysBack; i++) {
    days.push(ymd(new Date(anchor.getTime() - i * 86400_000)));
  }
  for (const region of REGIONS) {
    const cityRows = rows.filter((r) => r.city === region.key);
    const perSensor: Pm25Sample[][] = [];
    for (const row of cityRows) {
      for (const day of days) {
        const url =
          `${DATASET_RAW}/data/hourly/${row.city}/${row.provider.toLowerCase()}` +
          `/${row.locationid}/${day}.csv.gz`;
        try {
          const res = await fetchImpl(url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          const text = gunzipSync(buf).toString('utf8');
          perSensor.push(parseSensorCsv(text));
        } catch {
          /* missing day / sensor — skip */
        }
      }
    }
    result[region.key] = hourlyCityMedian(perSensor);
  }
  return result;
}
