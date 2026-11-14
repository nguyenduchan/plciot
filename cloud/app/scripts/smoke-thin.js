// Gói không giới hạn: telemetry cũ hơn 30 ngày được gộp còn 1 mẫu / 5 phút; dữ liệu mới và gói khác không bị đụng.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { insertEvent } from '../src/historyStore.js';
import { thinOldTelemetry, thinOldTelemetryAsync, purgeByPlanAsync } from '../src/retention.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-'));
const db = openDb(dir);
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };

const cols = db.prepare('PRAGMA table_info(users)').all();
function addUser(name, site, device, retention) {
  const row = { username: name, notify_site: site, notify_device: device, retention_days: retention, role: 'operator', setup_complete: 1, disabled: 0 };
  for (const c of cols) if (c.notnull && c.dflt_value == null && !(c.name in row) && !c.pk) row[c.name] = typeof c.type === 'string' && /INT/i.test(c.type) ? 0 : 'x';
  const keys = Object.keys(row).filter((k) => cols.some((c) => c.name === k));
  db.prepare(`INSERT INTO users (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
}
addUser('big', 'siteA', 'gw1', 0);        // không giới hạn
addUser('small', 'siteB', 'gw2', 30);     // gói 30 ngày: không gộp thưa

const now = Date.now(); const DAY = 86400000;
const old0 = now - 60 * DAY;
for (const [site, device] of [['siteA', 'gw1'], ['siteB', 'gw2']]) {
  for (let i = 0; i < 3600; i++) insertEvent(db, { ts: old0 + i * 1000, site, device, kind: 'telemetry', payload: '{}', o: 1, i: 1, a: 0, c: 1, s: 1 });   // 1 giờ dữ liệu 1 mẫu/giây, cũ 60 ngày
  for (let i = 0; i < 600; i++) insertEvent(db, { ts: now - 1000 * i, site, device, kind: 'telemetry', payload: '{}', o: 1, i: 1, a: 0, c: 1, s: 1 });        // dữ liệu mới
}
const cnt = (site, lt) => db.prepare("SELECT COUNT(*) AS n FROM mqtt_events WHERE site=? AND kind='telemetry' AND ts " + (lt ? '<' : '>=') + ' ?').get(site, now - 30 * DAY).n;
const before = cnt('siteA', true);
const deleted = thinOldTelemetry(db, now);
const after = cnt('siteA', true);
ok(before === 3600 && after >= 12 && after <= 14, `gói không giới hạn: 3600 mẫu (1 giờ) → ${after} mẫu (1 mẫu/5 phút)`);
ok(deleted === before - after, 'số dòng xoá khớp');
ok(cnt('siteA', false) === 600, 'dữ liệu mới (< 30 ngày) giữ nguyên');
ok(cnt('siteB', true) === 3600, 'gói lưu 30 ngày: không bị gộp thưa');
ok(thinOldTelemetry(db, now + 1000) === 0, 'chạy lại ngay: không xử lý lại khoảng đã gộp');

// Lô nhỏ: xoá/gộp nhiều dòng bằng nhiều lệnh ngắn, nhường vòng lặp sự kiện giữa các lô.
process.env.PURGE_CHUNK_ROWS = '1000';
const ins = db.transaction(() => { for (let i = 0; i < 5500; i++) insertEvent(db, { ts: now - 40 * DAY - i * 1000, site: 'orphan', device: 'x', kind: 'telemetry', payload: '{}', o: 1, i: 1, a: 0, c: 1, s: 1 }); });
ins();
let ticks = 0; const timer = setInterval(() => ticks++, 0);
const purged = await purgeByPlanAsync(db, now);
clearInterval(timer);
ok(purged >= 5500, `xoá hết ${purged} dòng quá hạn theo lô 1000`);
ok(ticks >= 5, `vòng lặp sự kiện được nhường giữa các lô (${ticks} lượt)`);
ok(db.prepare("SELECT COUNT(*) n FROM mqtt_events WHERE site='orphan'").get().n === 0, 'không còn dòng quá hạn');
addUser('big2', 'siteC', 'gw3', 0);
// Gộp thưa nhiều cửa sổ 6 giờ: 2 ngày dữ liệu 1 mẫu/10 giây → 1 mẫu/5 phút
const t0 = now - 45 * DAY;
const ins2 = db.transaction(() => { for (let i = 0; i < 17280; i++) insertEvent(db, { ts: t0 + i * 10000, site: 'siteC', device: 'gw3', kind: 'telemetry', payload: '{}', o: 1, i: 1, a: 0, c: 1, s: 1 }); });
ins2();
const bigBefore = db.prepare("SELECT COUNT(*) n FROM mqtt_events WHERE site='siteC' AND ts>=? AND ts<?").get(t0, t0 + 2 * DAY).n;
await thinOldTelemetryAsync(db, now + 3600e3);
const bigAfter = db.prepare("SELECT COUNT(*) n FROM mqtt_events WHERE site='siteC' AND ts>=? AND ts<?").get(t0, t0 + 2 * DAY).n;
ok(bigBefore === 17280 && bigAfter >= 570 && bigAfter <= 600, `2 ngày 17280 mẫu → ${bigAfter} mẫu (~576)`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} lỗi` : 'smoke-thin OK');
process.exit(fails ? 1 : 0);
