import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSensorCsv, hourlyCityMedian, parseManifest } from './airquality-backfill.js';

test('parseSensorCsv extracts pm25 rows as {ts,pm25} from quoted CSV', () => {
  const csv = [
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"',
    '857,1,"Fort Lee","2026-05-18T00:00:00+00:00","40.8","-73.9","pm25","µg/m³","7.5"',
    '857,1,"Fort Lee","2026-05-18T01:00:00+00:00","40.8","-73.9","pm25","µg/m³","9.0"',
    '857,9,"Fort Lee","2026-05-18T01:00:00+00:00","40.8","-73.9","temperature","c","18"',
  ].join('\n');
  const out = parseSensorCsv(csv);
  assert.equal(out.length, 2); // temperature row skipped
  assert.equal(out[0].pm25, 7.5);
  assert.equal(out[1].ts, Math.floor(Date.parse('2026-05-18T01:00:00+00:00') / 1000));
});

test('parseSensorCsv handles a location field with an embedded comma', () => {
  const csv = [
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"',
    '1370216,6664821,"West Albany Park, Chicago-1340269","2026-05-13T11:00:00-05:00","41.962434","-87.737472","pm25","µg/m³","2.6"',
  ].join('\n');
  const out = parseSensorCsv(csv);
  assert.equal(out.length, 1);
  assert.equal(out[0].pm25, 2.6);
  assert.equal(out[0].ts, Math.floor(Date.parse('2026-05-13T11:00:00-05:00') / 1000));
});

test('parseSensorCsv drops out-of-range values', () => {
  const csv = [
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"',
    '1,1,"x","2026-05-18T00:00:00+00:00","0","0","pm25","µg/m³","-3"',
    '1,1,"x","2026-05-18T01:00:00+00:00","0","0","pm25","µg/m³","99999"',
    '1,1,"x","2026-05-18T02:00:00+00:00","0","0","pm25","µg/m³","12"',
  ].join('\n');
  assert.deepEqual(parseSensorCsv(csv).map((s) => s.pm25), [12]);
});

test('parseSensorCsv handles CRLF line endings (value is last column)', () => {
  const csv = [
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"',
    '857,1,"Fort Lee","2026-05-18T00:00:00+00:00","40.8","-73.9","pm25","µg/m³","7.5"',
    '857,1,"Fort Lee","2026-05-18T01:00:00+00:00","40.8","-73.9","pm25","µg/m³","9.0"',
  ].join('\r\n');
  const out = parseSensorCsv(csv);
  assert.equal(out.length, 2);
  assert.equal(out[0].pm25, 7.5);
  assert.equal(out[1].pm25, 9.0);
});

test('hourlyCityMedian medians across sensors per wall-clock hour', () => {
  const h0 = 1747526400; // some hour boundary
  const out = hourlyCityMedian([
    [{ ts: h0 + 60, pm25: 4 }, { ts: h0 + 3600, pm25: 10 }],
    [{ ts: h0 + 120, pm25: 8 }, { ts: h0 + 3660, pm25: 20 }],
    [{ ts: h0 + 180, pm25: 6 }],
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { ts: h0, pm25: 6 });        // median(4,8,6)
  assert.deepEqual(out[1], { ts: h0 + 3600, pm25: 15 }); // median(10,20)
});

test('parseManifest yields city/provider/locationid rows', () => {
  const m = [
    'city,provider,locationid,name,lat,lng,parameters,n_days,first_day,last_day',
    'NYC,AirNow,857,Fort Lee,40.8,-73.9,pm25,2961,20180102,20260518.csv',
    'CHI,AirGradient,991,Loop,41.8,-87.6,pm25,400,20231101,20260517.csv',
  ].join('\n');
  const rows = parseManifest(m);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { city: 'NYC', provider: 'AirNow', locationid: '857', lastDay: '20260518' });
});

test('parseManifest strips .csv suffix from last_day', () => {
  const m = [
    'city,provider,locationid,name,lat,lng,parameters,n_days,first_day,last_day',
    'CHI,AirNow,1,a,0,0,pm25,1,20260513,20260513.csv',
  ].join('\n');
  const rows = parseManifest(m);
  assert.equal(rows[0].lastDay, '20260513');
});

test('parseManifest handles CRLF line endings (last_day is last column)', () => {
  const m = [
    'city,provider,locationid,name,lat,lng,parameters,n_days,first_day,last_day',
    'NYC,AirNow,857,Fort Lee,40.8,-73.9,pm25,2961,20180102,20260518.csv',
  ].join('\r\n');
  const rows = parseManifest(m);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastDay, '20260518');
});

test('fetchBackfill aggregates per city using injected fetch', async () => {
  const { fetchBackfill } = await import('./airquality-backfill.js');
  const manifest = [
    'city,provider,locationid,name,lat,lng,parameters,n_days,first_day,last_day',
    'CHI,AirNow,1,a,0,0,pm25,1,20260518,20260518.csv',
    'NYC,AirNow,2,b,0,0,pm25,1,20260518,20260518.csv',
    'TOR,AirNow,3,c,0,0,pm25,1,20260518,20260518.csv',
  ].join('\n');
  const csv = (v: number) =>
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"\n' +
    `1,1,"x","2026-05-18T00:00:00+00:00","0","0","pm25","µg/m³","${v}"`;
  const fetchImpl = async (url: string) => {
    if (url.endsWith('manifest.csv')) return { ok: true, text: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
    // CSV requests: return gzipped bytes
    const { gzipSync } = await import('node:zlib');
    const body = gzipSync(Buffer.from(csv(url.includes('/1/') ? 5 : url.includes('/2/') ? 9 : 20)));
    return { ok: true, text: async () => '', arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const out = await fetchBackfill(2, fetchImpl as never);
  assert.ok(out.CHI.length >= 1);
  assert.equal(out.CHI[0].pm25, 5);
  assert.equal(out.NYC[0].pm25, 9);
  assert.equal(out.TOR[0].pm25, 20);
});

test('fetchBackfill anchors the day window on the manifest last_day, not today', async () => {
  const { fetchBackfill } = await import('./airquality-backfill.js');
  // last_day well in the past relative to "today"
  const manifest = [
    'city,provider,locationid,name,lat,lng,parameters,n_days,first_day,last_day',
    'CHI,AirNow,1,a,0,0,pm25,1,20260101,20260513.csv',
  ].join('\n');
  const csv =
    '"location_id","sensors_id","location","datetime","lat","lon","parameter","units","value"\n' +
    '1,1,"x","2026-05-13T00:00:00+00:00","0","0","pm25","µg/m³","4.2"';
  const requested: string[] = [];
  const fetchImpl = async (url: string) => {
    if (url.endsWith('manifest.csv')) return { ok: true, text: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
    requested.push(url);
    const { gzipSync } = await import('node:zlib');
    const body = gzipSync(Buffer.from(csv));
    return { ok: true, text: async () => '', arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const out = await fetchBackfill(3, fetchImpl as never);
  // The window must start at 20260513 (the manifest last_day) and go back 3 days.
  assert.ok(requested.some((u) => u.includes('/20260513.csv.gz')), 'should request the anchor day');
  assert.ok(requested.some((u) => u.includes('/20260512.csv.gz')), 'should request anchor-1');
  assert.ok(requested.some((u) => u.includes('/20260511.csv.gz')), 'should request anchor-2');
  // No request should reference today's date (2026-05-19).
  assert.ok(!requested.some((u) => u.includes('/20260519.csv.gz')), 'must not request today');
  assert.equal(out.CHI[0].pm25, 4.2);
});

test('fetchBackfill returns empty regions when manifest fetch fails', async () => {
  const { fetchBackfill } = await import('./airquality-backfill.js');
  const fetchImpl = async () => { throw new Error('network down'); };
  const out = await fetchBackfill(2, fetchImpl as never);
  assert.deepEqual(out, { CHI: [], NYC: [], TOR: [] });
});
