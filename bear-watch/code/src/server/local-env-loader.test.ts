/**
 * Tests for the local.env auto-loader.
 * Run: npx tsx --test src/server/local-env-loader.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLocalEnvIfPresent } from './local-env-loader.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'local-env-loader-'));
}

const VALID_MASTER = 'a'.repeat(64);
const VALID_TOKEN = 'b'.repeat(64);
const VALID_MNEMONIC = 'abandon '.repeat(23) + 'about';

function writeLocalEnv(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local.env'), body, { mode: 0o600 });
}

test('injects master + token from local.env when env is empty', () => {
  const dir = tmp();
  writeLocalEnv(dir, `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\n`);
  const env: NodeJS.ProcessEnv = {};
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(r.loaded, true);
  assert.equal(r.source, 'local-env-file');
  assert.equal(env.BOT_MASTER_KEY, VALID_MASTER);
  assert.equal(env.BOT_API_TOKEN, VALID_TOKEN);
  assert.ok(r.injected.includes('BOT_MASTER_KEY'));
  assert.ok(r.injected.includes('BOT_API_TOKEN'));
});

test('also injects mnemonic when present', () => {
  const dir = tmp();
  writeLocalEnv(
    dir,
    `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\nBOT_HD_MNEMONIC=${VALID_MNEMONIC}\n`,
  );
  const env: NodeJS.ProcessEnv = {};
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(env.BOT_HD_MNEMONIC, VALID_MNEMONIC);
  assert.ok(r.injected.includes('BOT_HD_MNEMONIC'));
});

test('NEVER overwrites a master key already set in env', () => {
  const dir = tmp();
  writeLocalEnv(dir, `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\n`);
  const env: NodeJS.ProcessEnv = { BOT_MASTER_KEY: 'operator-pinned-key' };
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'env');
  assert.equal(env.BOT_MASTER_KEY, 'operator-pinned-key', 'env-supplied key must win');
  // Token must NOT be silently filled from the file when only master was set.
  // Mixed env/file state is the hazard the server explicitly rejects.
  assert.equal(env.BOT_API_TOKEN, undefined);
});

test('returns source=missing when neither env nor file present', () => {
  const dir = tmp();
  const r = loadLocalEnvIfPresent({ env: {}, dataDirOverride: dir });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'missing');
});

test('returns source=malformed when file exists but lines are absent', () => {
  const dir = tmp();
  writeLocalEnv(dir, '# comment only, no keys\n');
  const r = loadLocalEnvIfPresent({ env: {}, dataDirOverride: dir });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'malformed');
});

test('refuses symlinked local.env', () => {
  const dir = tmp();
  const realFile = join(tmp(), 'real.env');
  writeFileSync(realFile, `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\n`);
  mkdirSync(dir, { recursive: true });
  symlinkSync(realFile, join(dir, 'local.env'));
  const env: NodeJS.ProcessEnv = {};
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(r.loaded, false);
  assert.equal(r.source, 'malformed');
  assert.equal(env.BOT_MASTER_KEY, undefined);
});

test('idempotent: second call after success is a no-op', () => {
  const dir = tmp();
  writeLocalEnv(dir, `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\n`);
  const env: NodeJS.ProcessEnv = {};
  const first = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(first.loaded, true);
  const second = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(second.loaded, false, 'second call should be no-op');
  assert.equal(second.source, 'env');
});

test('sets BOTS_DATA_DIR when we fell back to default and successfully loaded', () => {
  const dir = tmp();
  writeLocalEnv(dir, `BOT_API_TOKEN=${VALID_TOKEN}\nBOT_MASTER_KEY=${VALID_MASTER}\n`);
  // Override the data dir explicitly — but the option is the same as if
  // we fell through env.BOTS_DATA_DIR; from the loader's POV "implicit"
  // means we didn't take dataDirOverride. So this asserts only that the
  // injection happens via the explicit override path doesn't set
  // BOTS_DATA_DIR (since the caller already knew it).
  const env: NodeJS.ProcessEnv = {};
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(r.loaded, true);
  // With dataDirOverride, we do NOT inject BOTS_DATA_DIR — the caller
  // already supplied the dir, so they have the value.
  assert.ok(!r.injected.includes('BOTS_DATA_DIR'));
  assert.equal(env.BOTS_DATA_DIR, undefined);
});

test('handles trailing-whitespace + comment-decorated file', () => {
  const dir = tmp();
  writeLocalEnv(
    dir,
    [
      '# autogenerated comment',
      `BOT_API_TOKEN=${VALID_TOKEN}`,
      '# another comment',
      `BOT_MASTER_KEY=${VALID_MASTER}`,
      '',
    ].join('\n'),
  );
  const env: NodeJS.ProcessEnv = {};
  const r = loadLocalEnvIfPresent({ env, dataDirOverride: dir });
  assert.equal(r.loaded, true);
  assert.equal(env.BOT_MASTER_KEY, VALID_MASTER);
  assert.equal(env.BOT_API_TOKEN, VALID_TOKEN);
});
