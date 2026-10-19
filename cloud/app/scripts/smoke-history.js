import { openDb } from '../src/db.js';
import { insertEvent, queryTelemetry, historyStats } from '../src/historyStore.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const db = openDb(DATA_DIR);
const now = Date.now();
insertEvent(db, {
  ts: now - 1000, site: 'factory1', device: 'plc01', kind: 'telemetry',
  payload: '{}', o: 2, i: 1, a: 0, c: 10, s: 1,
});
insertEvent(db, {
  ts: now, site: 'factory1', device: 'plc01', kind: 'telemetry',
  payload: '{}', o: 2, i: 1, a: 0, c: 11, s: 1,
});
insertEvent(db, {
  ts: now, site: 'factory1', device: 'plc01', kind: 'status',
  payload: 'online', o: null, i: null, a: null, c: null, s: null,
});
const rows = queryTelemetry(db, {
  site: 'factory1', device: 'plc01', since: 0, until: now + 1, limit: 10,
});
console.log('samples', rows.length, historyStats(db));
