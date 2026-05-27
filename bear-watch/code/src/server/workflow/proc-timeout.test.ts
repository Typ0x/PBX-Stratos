/**
 * Tests for armProcessTimeout — the kill-timer that bounds how long a
 * workflow subprocess (Python decoder, claude CLI) may run before it is
 * forcibly terminated.
 *
 * Run with:  npx tsx --test src/server/workflow/proc-timeout.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { armProcessTimeout } from './proc-timeout.js';

test('armProcessTimeout kills a process that exceeds the timeout', async () => {
  // A node child that would otherwise hang for a minute.
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  let timedOut = false;
  await new Promise<void>((resolve) => {
    armProcessTimeout(proc, 150, () => { timedOut = true; });
    proc.on('close', () => resolve());
  });
  assert.equal(timedOut, true, 'onTimeout should have fired');
  assert.equal(proc.killed, true, 'the hung process should have been killed');
});

test('armProcessTimeout does not fire when the process exits in time', async () => {
  const proc = spawn(process.execPath, ['-e', 'process.exit(0)']);
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const clear = armProcessTimeout(proc, 5000, () => { timedOut = true; });
    proc.on('close', () => { clear(); resolve(); });
  });
  assert.equal(timedOut, false, 'onTimeout must not fire for a fast process');
});
