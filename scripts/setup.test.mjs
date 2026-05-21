import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePyVersion, isUsablePython } from './setup.mjs';

test('parsePyVersion extracts major.minor', () => {
  assert.deepEqual(parsePyVersion('Python 3.9.6'), { major: 3, minor: 9 });
  assert.deepEqual(parsePyVersion('Python 3.13.12'), { major: 3, minor: 13 });
  assert.equal(parsePyVersion('garbage'), null);
});

test('isUsablePython requires >= 3.9', () => {
  assert.equal(isUsablePython('Python 3.9.6'), true);
  assert.equal(isUsablePython('Python 3.13.0'), true);
  assert.equal(isUsablePython('Python 3.8.10'), false);
  assert.equal(isUsablePython('Python 2.7.18'), false);
});
