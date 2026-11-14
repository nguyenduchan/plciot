/**
 * Chụp bản sao NHẤT QUÁN của app.db khi app đang chạy (API backup của SQLite), dùng khi chuyển VPS:
 *   docker exec plciot-app node scripts/db-snapshot.js /app/data/backups/migrate-snapshot.db
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const out = process.argv[2];
if (!out) { console.error('usage: db-snapshot.js <file đích>'); process.exit(2); }
const src = path.join(process.env.DATA_DIR || '/app/data', 'app.db');
fs.mkdirSync(path.dirname(out), { recursive: true });
const db = new Database(src, { readonly: true, fileMustExist: true });
const t0 = Date.now();
await db.backup(out, { progress: () => 2000 });
db.close();
try { const c = new Database(out); c.pragma('journal_mode = DELETE'); c.close(); } catch { /* */ }
try { fs.chmodSync(out, 0o600); } catch { /* */ }
console.log(JSON.stringify({ file: out, bytes: fs.statSync(out).size, sec: Math.round((Date.now() - t0) / 100) / 10 }));
