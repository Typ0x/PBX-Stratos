import type { RegionKey } from '../regions.js';

/**
 * Per-region scoring from /api/signals. Two derived views:
 *   - RegionScore: scalar composite in [0,1] used by rotation + spread strategies
 *   - RegionBundle: raw signals per region used by mean-reversion strategy
 *
 * Score = avg(confidence) / 100 over non-zero signals. The /api/signals
 * endpoint returns confidence as 0–100 percentage, so divide by 100.
 * SEASONAL signals routinely have confidence=0 — filter them out.
 */

const API_BASE = process.env.BOT_API_BASE ?? 'https://pbx-mainnet-api.onrender.com';
const ACTIVE_KEYS: RegionKey[] = ['CHI', 'NYC', 'TOR'];

export interface SignalOut {
  category: string;
  confidence: number;
  magnitude: number;
  message?: string;
}

interface CityBundle {
  ticker: string;
  currentPm25: number | null;
  signals: SignalOut[];
}

interface SignalsResponse {
  cities: Record<string, CityBundle>;
  supportedCities: string[];
  updatedAt: string;
}

export interface RegionScore {
  key: RegionKey;
  score: number;
  signalCount: number;
  currentPm25: number | null;
}

export interface RegionBundle {
  key: RegionKey;
  score: number;
  currentPm25: number | null;
  signals: SignalOut[];
}

export interface PairSpread {
  a: RegionKey;
  b: RegionKey;
  spread: number; // score_a - score_b; negative means b > a
}

export async function fetchBundles(): Promise<RegionBundle[]> {
  const res = await fetch(`${API_BASE}/api/signals`);
  if (!res.ok) throw new Error(`[scores] /api/signals returned ${res.status}`);
  const payload = (await res.json()) as SignalsResponse;

  return ACTIVE_KEYS.map((key) => {
    const bundle = payload.cities[key];
    if (!bundle) return { key, score: 0, currentPm25: null, signals: [] };
    const meaningful = bundle.signals.filter((s) => s.confidence > 0);
    const avgConf =
      meaningful.length === 0
        ? 0
        : meaningful.reduce((s, sig) => s + sig.confidence, 0) / meaningful.length;
    return {
      key,
      score: Math.max(0, Math.min(1, avgConf / 100)),
      currentPm25: bundle.currentPm25,
      signals: bundle.signals,
    };
  });
}

export async function fetchScores(): Promise<RegionScore[]> {
  const bundles = await fetchBundles();
  return bundles.map((b) => ({
    key: b.key,
    score: b.score,
    signalCount: b.signals.filter((s) => s.confidence > 0).length,
    currentPm25: b.currentPm25,
  }));
}

export function bestRegion(scores: RegionScore[]): RegionScore | null {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  if (ranked.length === 0 || ranked[0].score <= 0) return null;
  return ranked[0];
}

/** All 3 pairs (CHI-NYC, CHI-TOR, NYC-TOR) with signed spreads. */
export function pairSpreads(scores: RegionScore[]): PairSpread[] {
  const out: PairSpread[] = [];
  for (let i = 0; i < scores.length; i++) {
    for (let j = i + 1; j < scores.length; j++) {
      out.push({ a: scores[i].key, b: scores[j].key, spread: scores[i].score - scores[j].score });
    }
  }
  return out;
}
