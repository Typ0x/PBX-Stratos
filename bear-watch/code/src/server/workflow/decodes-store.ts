// Persistence for decoded strategies. One JSON file per decoded wallet
// under ~/.pbx-lab/decodes/, keyed by pubkey — the latest decode of a
// wallet overwrites the prior one. Mirrors the evolution-runs store.
//
// Pure file-IO plus one pure mapper (toPersistedDecode). No imports from
// the workflow modules — the mapper takes loose structural types so this
// file stays self-contained and unit-testable.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DECODES_DIR = join(process.env.STRATOS_LAB_HOME ?? join(homedir(), '.pbx-lab'), 'decodes');

export interface PersistedDecode {
  pubkey: string;
  ruleName: string;
  entryPredicate: string;
  exitPredicate: string;
  /** Epoch ms when the decode finished. */
  decodedAt: number;
  /** Headline backtest metrics, when the decode was back-tested. */
  backtest?: {
    returnPerTrip?: number;
    winRate?: number | null;
    trips?: number;
  };
}

/** Map an agentic decode's rule + held-out test metrics onto a
 *  PersistedDecode. Loose structural params keep this module decoupled
 *  from the workflow types; the caller passes `agentic.rule` and
 *  `backtest.test`. */
export function toPersistedDecode(
  pubkey: string,
  rule: {
    ruleName?: string;
    entryWhen?: { predicate?: string };
    exitWhen?: { predicate?: string };
  },
  testMetrics: { avgTradePct?: number; winRate?: number | null; trades?: number } | null,
): PersistedDecode {
  return {
    pubkey,
    ruleName: rule.ruleName ?? 'decoded rule',
    entryPredicate: rule.entryWhen?.predicate ?? '',
    exitPredicate: rule.exitWhen?.predicate ?? '',
    decodedAt: Date.now(),
    backtest: testMetrics
      ? {
          returnPerTrip: testMetrics.avgTradePct,
          winRate: testMetrics.winRate,
          trips: testMetrics.trades,
        }
      : undefined,
  };
}

/** Write a decode to <dir>/<pubkey>.json, atomically (temp + rename).
 *  Overwrites any existing file for that pubkey. */
export function saveDecode(decode: PersistedDecode, dir: string = DECODES_DIR): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${decode.pubkey}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(decode, null, 2));
  renameSync(tmp, path);
}

/** All persisted decodes, newest first. Never throws: a missing dir
 *  yields [], a malformed file is skipped. */
export function listDecodes(dir: string = DECODES_DIR): PersistedDecode[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: PersistedDecode[] = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PersistedDecode;
      if (d && typeof d.pubkey === 'string') out.push(d);
    } catch {
      // skip malformed file
    }
  }
  return out.sort((a, b) => (b.decodedAt ?? 0) - (a.decodedAt ?? 0));
}
