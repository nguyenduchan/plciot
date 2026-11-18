/**
 * Smoke test gói bù dữ liệu (backfill): DB tạm trong bộ nhớ, không đụng dữ liệu thật.
 * Chạy: node scripts/smoke-backfill.js   (trong container app hoặc nơi có node_modules)
 */
import Database from 'better-sqlite3';
import { initHistoryTables, insertEvent } from '../src/historyStore.js';
import { evaluateBackfill } from '../src/backfill.js';
import { deviceRetentionDays } from '../src/retention.js';

let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };
const DAY = 86_400_000;

const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, notify_site TEXT, notify_device TEXT, retention_days INTEGER)');
initHistoryTables(db);
const site = 's1', device = 'gw1';
const now = Date.UTC(2026, 10, 18, 12, 0, 0);
const d = { tank: { level: 7.5 } };
const accept = (ts, extra = {}) => evaluateBackfill(db, { site, device, canonical: { schema: 2, bf: 1, ts, d, ...extra }, now, gapMs: 10_000 });

// gói mặc định (chưa ai chọn gói): 1 ngày
ok(deviceRetentionDays(db, site, device) === 1, 'không có gói → mặc định 1 ngày');
ok(accept(now - 3600_000).ok, 'mẫu 1 giờ trước: nhận');
ok(accept(now - 2 * DAY).reason === 'beyond_retention', 'mẫu 2 ngày trước (gói 1 ngày): từ chối');
ok(accept(now + 120_000).reason === 'future', 'mẫu ở tương lai: từ chối');
ok(accept('abc').reason === 'bad_ts', 'ts không phải số: từ chối');
ok(evaluateBackfill(db, { site, device, canonical: { bf: 1, ts: now - 5000, r: [1, 2] }, now }).reason === 'not_schema2', 'không có d (schema:1): từ chối');

// gói 7 ngày, 0 = không giới hạn
db.prepare('INSERT INTO users (notify_site, notify_device, retention_days) VALUES (?, ?, 7)').run(site, device);
ok(deviceRetentionDays(db, site, device) === 7, 'gói 7 ngày');
ok(accept(now - 6 * DAY).ok, 'mẫu 6 ngày trước (gói 7 ngày): nhận');
ok(accept(now - 8 * DAY).reason === 'beyond_retention', 'mẫu 8 ngày trước (gói 7 ngày): từ chối');
db.prepare('INSERT INTO users (notify_site, notify_device, retention_days) VALUES (?, ?, 0)').run(site, device);
ok(deviceRetentionDays(db, site, device) === Infinity, 'có tài khoản không giới hạn → người dài nhất thắng');
ok(accept(now - 400 * DAY).ok, 'không giới hạn: mẫu 400 ngày trước vẫn nhận');

// không chồng lên live
const t0 = now - 3 * 3600_000;
insertEvent(db, { ts: t0, site, device, kind: 'telemetry', payload: '{}', o: null, i: null, a: null, c: null, s: null });   // live (src mặc định NULL)
ok(accept(t0 + 4000).reason === 'overlaps_live', 'mẫu bù sát dòng live (4 s): từ chối');
ok(accept(t0 + 60_000).ok, 'mẫu bù cách live 60 s: nhận');

// ghi mẫu bù, rồi trùng
const r1 = accept(now - 5 * 3600_000);
ok(r1.ok && r1.row.src === 'bf' && JSON.parse(r1.row.payload).bf === 1, 'dòng bù mang src=bf và bf:1 trong payload');
insertEvent(db, r1.row);
ok(accept(now - 5 * 3600_000).reason === 'duplicate', 'mẫu bù trùng ts: từ chối');
ok(accept(now - 5 * 3600_000 + 10_000).ok, 'mẫu bù kế tiếp (+10 s, không phải live): nhận → các mẫu bù không chặn nhau');

// dòng bù KHÔNG được coi là live
const live = db.prepare("SELECT COUNT(*) n FROM mqtt_events WHERE src IS NULL").get().n;
const bf = db.prepare("SELECT COUNT(*) n FROM mqtt_events WHERE src = 'bf'").get().n;
ok(live === 1 && bf === 1, `phân tách nguồn: live=${live}, bù=${bf}`);

console.log(fail ? `\n${fail} lỗi` : '\nTất cả đạt');
process.exit(fail ? 1 : 0);
