/**
 * Kiểm tra một bản sao lưu DB có KHÔI PHỤC được không (không đụng DB thật):
 *   node scripts/verify-backup.js <file.db> [file đối chiếu số dòng: DB đang chạy]
 * In kết quả integrity_check, số dòng các bảng chính, thời điểm mẫu telemetry mới nhất. Thoát mã 1 nếu hỏng.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';

const f = process.argv[2];
if (!f || !fs.existsSync(f)) { console.error('usage: verify-backup.js <file.db>'); process.exit(2); }
const db = new Database(f, { readonly: true, fileMustExist: true });
const t0 = Date.now();
const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
const ok = integrity.length === 1 && integrity[0] === 'ok';
const tables = {};
for (const t of ['users', 'devices', 'hardware_devices', 'mqtt_events', 'support_messages', 'support_archive']) {
  try { tables[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { tables[t] = null; }
}
let newest = null; try { newest = db.prepare("SELECT MAX(ts) t FROM mqtt_events").get().t; } catch { /* */ }
console.log(JSON.stringify({ file: f, integrity: ok ? 'ok' : integrity.slice(0, 5), sizeMB: Math.round(fs.statSync(f).size / 1048576), tables, newestEvent: newest ? new Date(newest).toISOString() : null, sec: Math.round((Date.now() - t0) / 100) / 10 }));
db.close();
process.exit(ok ? 0 : 1);
