/**
 * Đo khi DB ĐÃ ĐẦY (không cần MQTT; DB tạm trong thư mục tạm, không đụng app.db):
 *   node scripts/bench-fulldb.js <triệu dòng>
 * In: tốc độ ghi lô, thời gian truy vấn lịch sử 3 ngày, độ trễ vòng lặp sự kiện khi xoá/gộp theo lô và khi sao lưu.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { insertEvent, queryTelemetry } from '../src/historyStore.js';
import { backupOnce } from '../src/dbBackup.js';

const millions = Math.max(0.1, Number(process.argv[2]) || 2);
const total = Math.round(millions * 1e6);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bigdb-'));
process.env.PURGE_CHUNK_ROWS = process.env.PURGE_CHUNK_ROWS || '5000';
const { purgeByPlanAsync } = await import('../src/retention.js');
const db = openDb(dir);
const DAY = 86400000; const now = Date.now(); const base = now - 60 * DAY; const step = Math.max(1, Math.floor((60 * DAY) / total));
const dev = (i) => (i % 20).toString(16).padStart(16, '0');
const row = (i, ts) => ({ ts, site: 'bench', device: dev(i), kind: 'telemetry', payload: '{"schema":2,"d":{"w":{"level":62.1,"flow":48,"run":1}}}', o: 1, i: 1, a: 0, c: 1, s: 1 });
const fill = db.transaction((a, b) => { for (let i = a; i < b; i++) insertEvent(db, row(i, base + i * step)); });
let t = Date.now();
for (let a = 0; a < total; a += 100000) fill(a, Math.min(total, a + 100000));
db.pragma('wal_checkpoint(TRUNCATE)');
const out = { rows: total, fillSec: Math.round((Date.now() - t) / 1000), dbMB: Math.round(fs.statSync(path.join(dir, 'app.db')).size / 1048576) };

// độ trễ vòng lặp sự kiện
let maxLag = 0; let last = Date.now();
const lagTimer = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 10); last = n; }, 10);
const lagReset = () => { const m = maxLag; maxLag = 0; last = Date.now(); return m; };

// 1) ghi lô trên DB đầy
t = Date.now(); let n = 0;
const ins = db.transaction((k) => { for (let i = 0; i < k; i++) insertEvent(db, row(n + i, now - 1000 + (n + i))); });
while (Date.now() - t < 5000) { ins(1000); n += 1000; await new Promise((r) => setImmediate(r)); }
out.insertPerSec = Math.round(n / ((Date.now() - t) / 1000)); out.lagInsertMs = lagReset();

// 2) truy vấn lịch sử 3 ngày của 1 thiết bị
t = process.hrtime.bigint();
const q = queryTelemetry(db, { site: 'bench', device: dev(1), since: base, until: base + 3 * DAY, limit: 5000 });
out.query3dMs = Math.round(Number(process.hrtime.bigint() - t) / 1e5) / 10; out.query3dRows = q.length;

// 3) xoá quá hạn theo lô (mặc định giữ 1 ngày → xoá gần hết) — độ trễ lớn nhất của vòng lặp trong lúc xoá
lagReset(); t = Date.now();
out.purged = await purgeByPlanAsync(db, now); out.purgeSec = Math.round((Date.now() - t) / 100) / 10; out.lagPurgeMs = lagReset();

// 4) sao lưu
t = Date.now(); const r = await backupOnce(db, dir, { force: true });
out.backupSec = Math.round((Date.now() - t) / 100) / 10; out.backup = r.reason || r.size; out.lagBackupMs = lagReset();
clearInterval(lagTimer);
console.log(JSON.stringify(out));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
