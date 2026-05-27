import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDecode, listDecodes, toPersistedDecode } from './decodes-store.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'pbx-decodes-'));
}

test('saveDecode then listDecodes round-trips a decode', () => {
  const dir = freshDir();
  try {
    const d = {
      pubkey: 'WALLET1', ruleName: 'r',
      entryPredicate: 'a', exitPredicate: 'b', decodedAt: 1000,
    };
    saveDecode(d, dir);
    const list = listDecodes(dir);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], d);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('re-saving the same pubkey overwrites — latest wins', () => {
  const dir = freshDir();
  try {
    saveDecode({ pubkey: 'W', ruleName: 'old', entryPredicate: 'a', exitPredicate: 'b', decodedAt: 1 }, dir);
    saveDecode({ pubkey: 'W', ruleName: 'new', entryPredicate: 'a', exitPredicate: 'b', decodedAt: 2 }, dir);
    const list = listDecodes(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].ruleName, 'new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listDecodes sorts newest decodedAt first', () => {
  const dir = freshDir();
  try {
    saveDecode({ pubkey: 'A', ruleName: 'a', entryPredicate: '', exitPredicate: '', decodedAt: 100 }, dir);
    saveDecode({ pubkey: 'B', ruleName: 'b', entryPredicate: '', exitPredicate: '', decodedAt: 300 }, dir);
    saveDecode({ pubkey: 'C', ruleName: 'c', entryPredicate: '', exitPredicate: '', decodedAt: 200 }, dir);
    assert.deepEqual(listDecodes(dir).map((d) => d.pubkey), ['B', 'C', 'A']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listDecodes skips a malformed file and returns the rest', () => {
  const dir = freshDir();
  try {
    saveDecode({ pubkey: 'GOOD', ruleName: 'g', entryPredicate: '', exitPredicate: '', decodedAt: 1 }, dir);
    writeFileSync(join(dir, 'BAD.json'), '{ not json');
    const list = listDecodes(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].pubkey, 'GOOD');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listDecodes returns [] when the dir does not exist', () => {
  assert.deepEqual(listDecodes(join(tmpdir(), `pbx-decodes-nope-${Date.now()}`)), []);
});

test('toPersistedDecode maps an agentic rule + test metrics', () => {
  const d = toPersistedDecode(
    'WALLET',
    { ruleName: 'region_arb', entryWhen: { predicate: 'rank == 0' }, exitWhen: { predicate: 'dev > 0.03' } },
    { avgTradePct: 1.2, winRate: 0.6, trades: 9 },
  );
  assert.equal(d.pubkey, 'WALLET');
  assert.equal(d.ruleName, 'region_arb');
  assert.equal(d.entryPredicate, 'rank == 0');
  assert.equal(d.exitPredicate, 'dev > 0.03');
  assert.equal(typeof d.decodedAt, 'number');
  assert.deepEqual(d.backtest, { returnPerTrip: 1.2, winRate: 0.6, trips: 9 });
});

test('toPersistedDecode tolerates missing fields', () => {
  const d = toPersistedDecode('W', {}, null);
  assert.equal(d.ruleName, 'decoded rule');
  assert.equal(d.entryPredicate, '');
  assert.equal(d.exitPredicate, '');
  assert.equal(d.backtest, undefined);
});
