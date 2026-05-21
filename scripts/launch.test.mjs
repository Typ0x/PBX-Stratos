import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOpenCommand } from './launch.mjs';

test('browser open command per platform', () => {
  assert.deepEqual(browserOpenCommand('darwin', 'http://x'), ['open', ['http://x']]);
  assert.deepEqual(browserOpenCommand('win32', 'http://x'), ['cmd', ['/c', 'start', '', 'http://x']]);
  assert.deepEqual(browserOpenCommand('linux', 'http://x'), ['xdg-open', ['http://x']]);
});
