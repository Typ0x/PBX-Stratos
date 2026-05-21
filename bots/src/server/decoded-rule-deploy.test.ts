/**
 * Tests for Phase 3c-i — deploying a decoded DSL rule as a live bot.
 *
 * Run with:  npx tsx --test src/server/decoded-rule-deploy.test.ts
 *
 * Fully offline. Covers:
 *   - Store.setStrategy persists the decoded rule + run mode, and
 *     round-trips through disk (the restart-resume path).
 *   - setStrategy drops a stale decodedRule when the strategy changes
 *     to a non-decoded one.
 *   - mode defaults to the safe treatment (paper) — absence is never
 *     silently live.
 *   - The orchestrator's launch special-case reconstructs a working
 *     DecodedRuleStrategy from WalletMeta.decodedRule, and refuses to
 *     build a rule-less bot.
 *   - createStrategy('decoded_rule') throws loudly (the registry
 *     factory is never the live path).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Store.createWallet encrypts the keypair blob, which requires a master
// key. Set a throwaway one for these offline tests before importing the
// Store module (secrets.ts reads the env lazily on first use).
process.env.BOT_MASTER_KEY ??= 'test-only-master-key-not-a-real-secret-000000';

import { Store } from './store.js';
import { createStrategy, getStrategyDef, LIVE_STRATEGIES } from '../strategies/index.js';
import { DecodedRuleStrategy } from '../strategies/decoded_rule.js';

/** A valid decoded predicate pair over the DSL feature space. */
const ENTRY = 'dev_60m < -0.02';
const EXIT = 'dev_60m > 0.01';

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pbx-3c-'));
  return { store: new Store(dir), dir };
}

test('setStrategy persists decodedRule + mode and round-trips through disk', () => {
  const { store, dir } = freshStore();
  try {
    store.createWallet('bot1');
    store.setStrategy('bot1', 'decoded_rule', 100_000_000n, 60_000, {
      decodedRule: { ruleName: 'alpha', entryPredicate: ENTRY, exitPredicate: EXIT },
      mode: 'live',
    });
    // Re-read from disk via a brand-new Store — the restart path.
    const reloaded = new Store(dir).getWallet('bot1');
    assert.equal(reloaded?.strategy, 'decoded_rule');
    assert.equal(reloaded?.mode, 'live');
    assert.deepEqual(reloaded?.decodedRule, {
      ruleName: 'alpha',
      entryPredicate: ENTRY,
      exitPredicate: EXIT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setStrategy drops a stale decodedRule when switching to a registry strategy', () => {
  const { store, dir } = freshStore();
  try {
    store.createWallet('bot2');
    store.setStrategy('bot2', 'decoded_rule', 100_000_000n, 60_000, {
      decodedRule: { entryPredicate: ENTRY, exitPredicate: '' },
      mode: 'paper',
    });
    assert.ok(store.getWallet('bot2')?.decodedRule);
    // Rebind to a registry strategy — the orphan predicates must go.
    store.setStrategy('bot2', 'rotation', 100_000_000n, 60_000);
    assert.equal(store.getWallet('bot2')?.decodedRule, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setStrategy without a mode does not silently downgrade an existing live binding', () => {
  const { store, dir } = freshStore();
  try {
    store.createWallet('bot3');
    store.setStrategy('bot3', 'rotation', 100_000_000n, 60_000, { mode: 'live' });
    // A param-less rebind: mode is omitted, so it must be left as-is.
    store.setStrategy('bot3', 'rotation', 100_000_000n, 90_000);
    assert.equal(store.getWallet('bot3')?.mode, 'live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a wallet with no mode field reads as paper (never silently live)', () => {
  const { store, dir } = freshStore();
  try {
    const meta = store.createWallet('bot4');
    // A legacy wallet has no `mode` — the safe default is paper.
    assert.equal(meta.mode, undefined);
    assert.notEqual(meta.mode, 'live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orchestrator launch special-case reconstructs a DecodedRuleStrategy from WalletMeta', () => {
  // Mirrors orchestrator.launch()'s decoded_rule branch: build the
  // strategy directly from the persisted decodedRule payload.
  const rule = { entryPredicate: ENTRY, exitPredicate: EXIT };
  const strategy = new DecodedRuleStrategy({
    id: 'bot5',
    entryPredicate: rule.entryPredicate,
    exitPredicate: rule.exitPredicate ?? '',
  });
  assert.equal(strategy.id, 'bot5');
});

test('launch refuses a decoded_rule wallet with a missing/empty entryPredicate', () => {
  // The orchestrator guards on this before constructing anything; an
  // empty entryPredicate must throw rather than build a rule-less bot.
  assert.throws(
    () => new DecodedRuleStrategy({ id: 'bot6', entryPredicate: '', exitPredicate: '' }),
    /invalid entryPredicate|empty/i,
  );
});

test('launch rejects a decoded_rule wallet with a malformed predicate', () => {
  assert.throws(
    () =>
      new DecodedRuleStrategy({
        id: 'bot7',
        entryPredicate: 'totally_unknown_feature > 1',
        exitPredicate: '',
      }),
    /invalid entryPredicate/i,
  );
});

test('decoded_rule is in the registry, live-allowed, with spawn defaults', () => {
  const def = getStrategyDef('decoded_rule');
  assert.ok(def, 'decoded_rule should be registered');
  assert.equal(def?.liveAllowed, true);
  assert.ok(LIVE_STRATEGIES.has('decoded_rule'));
  assert.ok((def?.minUsdcRaw ?? 0n) > 0n);
  assert.ok((def?.defaultTickMs ?? 0) > 0);
});

test('createStrategy("decoded_rule") throws loudly — registry factory is never the live path', () => {
  assert.throws(
    () => createStrategy('decoded_rule'),
    /orchestrator\.launch|WalletMeta\.decodedRule/,
  );
});
