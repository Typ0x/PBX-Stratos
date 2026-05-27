import test from 'node:test';
import assert from 'node:assert/strict';
import { AirQualityStore, type Pm25Sample } from './airquality-store.js';

test('ingestLive appends one sample per region and current() returns latest', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  s.ingestLive({ CHI: 5, NYC: 9, TOR: 20 }, 1000);
  s.ingestLive({ CHI: 6, NYC: 8, TOR: 21 }, 1300);
  assert.equal(s.current('CHI'), 6);
  assert.equal(s.current('NYC'), 8);
  assert.equal(s.size('CHI'), 2);
});

test('ingestLive skips null/non-finite values', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  s.ingestLive({ CHI: 5, NYC: undefined, TOR: NaN }, 1000);
  assert.equal(s.current('CHI'), 5);
  assert.equal(s.current('NYC'), null);
  assert.equal(s.size('TOR'), 0);
});

test('seedBackfill dedups by ts (overwrite) and keeps sorted', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  s.seedBackfill({
    CHI: [{ ts: 2000, pm25: 5 }, { ts: 1000, pm25: 4 }, { ts: 2000, pm25: 7 }],
    NYC: [], TOR: [],
  });
  assert.equal(s.size('CHI'), 2);
  assert.equal(s.current('CHI'), 7); // ts=2000 overwritten, latest
  assert.equal(s.recent('CHI', 48)[0], 4); // sorted oldest-first
});

test('isEmpty true on fresh store, false after ingest', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  assert.equal(s.isEmpty(), true);
  s.ingestLive({ CHI: 5 }, 1000);
  assert.equal(s.isEmpty(), false);
});

test('percentile/zscore are null with fewer than 2 samples', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  s.ingestLive({ CHI: 5 }, 1000);
  assert.equal(s.percentile('CHI'), null);
  assert.equal(s.zscore('CHI'), null);
});

test('percentile/zscore computed from >=2 samples', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  const now = Math.floor(Date.now() / 1000);
  s.seedBackfill({
    CHI: [
      { ts: now - 7200, pm25: 2 },
      { ts: now - 3600, pm25: 4 },
      { ts: now - 60, pm25: 10 },
    ],
    NYC: [], TOR: [],
  });
  // current = 10, the max of [2,4,10] -> 100th percentile
  assert.equal(s.percentile('CHI'), 100);
  assert.ok((s.zscore('CHI') ?? 0) > 0);
});

test('lastUpdatedMs advances on ingestLive only', () => {
  const s = new AirQualityStore('/tmp/aq-test-ignore.json');
  assert.equal(s.lastUpdatedMs(), null);
  s.ingestLive({ CHI: 5 }, 1000);
  assert.ok((s.lastUpdatedMs() ?? 0) > 0);
});

import { rmSync } from 'node:fs';

test('save then load round-trips samples and lastFetchMs', () => {
  const path = `/tmp/aq-roundtrip-${process.pid}.json`;
  rmSync(path, { force: true });
  const a = new AirQualityStore(path);
  a.ingestLive({ CHI: 5, NYC: 9 }, Math.floor(Date.now() / 1000) - 60);
  a.save();
  const b = new AirQualityStore(path);
  b.load();
  assert.equal(b.current('CHI'), 5);
  assert.equal(b.current('NYC'), 9);
  assert.ok((b.lastUpdatedMs() ?? 0) > 0);
  rmSync(path, { force: true });
});

test('load on a missing file leaves an empty store (no throw)', () => {
  const s = new AirQualityStore(`/tmp/aq-missing-${process.pid}.json`);
  s.load();
  assert.equal(s.isEmpty(), true);
});
