/**
 * Sao lưu tự động DB SQLite (an toàn khi app đang ghi: dùng API backup của better-sqlite3).
 *  - Mỗi ngày 1 bản: data/backups/app-auto-YYYYMMDD.db (quyền 0600 — chứa băm mật khẩu, bí mật TOTP).
 *  - Giữ DB_BACKUP_DAILY bản ngày gần nhất (mặc định 7) + DB_BACKUP_WEEKLY bản Chủ nhật (mặc định 4).
 *  - Bản NGOÀI VPS: kéo về máy cá nhân bằng cloud/scripts/pull-backup.ps1 (sao lưu cùng ổ đĩa không cứu được khi hỏng VPS).
 *  Tắt: DB_BACKUP=0.
 */
import fs from 'node:fs';
import path from 'node:path';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const RE = /^app-auto-(\d{4})(\d{2})(\d{2})\.db$/;

export function pruneBackups(dir, { daily = 7, weekly = 4 } = {}) {
  const files = fs.readdirSync(dir).filter((f) => RE.test(f)).sort().reverse();   // mới → cũ
  const keep = new Set(files.slice(0, daily));
  let w = 0;
  for (const f of files) {
    const m = RE.exec(f);
    if (new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() === 0 && w < weekly) { keep.add(f); w++; }
  }
  for (const f of files) if (!keep.has(f)) { try { fs.rmSync(path.join(dir, f)); } catch { /* */ } }
  return files.filter((f) => !keep.has(f)).length;
}

export async function backupOnce(db, dataDir, opts = {}) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const name = `app-auto-${ymd(new Date())}.db`;
  const target = path.join(dir, name);
  if (fs.existsSync(target) && !opts.force) return { skipped: true, file: name };
  const tmp = `${target}.tmp`;
  await db.backup(tmp);
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
  fs.renameSync(tmp, target);
  const pruned = pruneBackups(dir, { daily: Number(process.env.DB_BACKUP_DAILY || 7), weekly: Number(process.env.DB_BACKUP_WEEKLY || 4) });
  return { file: name, size: fs.statSync(target).size, pruned };
}

export function startBackups(db, dataDir) {
  if (String(process.env.DB_BACKUP ?? '1') === '0') return;
  const run = () => backupOnce(db, dataDir).then((r) => { if (!r.skipped) console.log('[backup]', r.file, r.size, 'bytes, pruned', r.pruned); }).catch((e) => console.error('[backup]', e.message));
  setTimeout(run, 60_000).unref?.();             // sau khi khởi động xong
  setInterval(run, 3600_000).unref?.();          // mỗi giờ kiểm tra: qua ngày mới thì tạo bản mới
}
