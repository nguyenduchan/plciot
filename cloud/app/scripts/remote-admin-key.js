#!/usr/bin/env node
/**
 * Đăng ký máy GatewayAdmin (chạy TRÊN VPS qua SSH — chỉ ai có SSH mới thêm được máy cài đặt từ xa):
 *   node scripts/remote-admin-key.js add <tên-máy> <khoá-công-khai SPKI base64url>   (GatewayAdmin hiện sẵn dòng lệnh này)
 *   node scripts/remote-admin-key.js list
 *   node scripts/remote-admin-key.js disable <key_id>
 * Trong container: docker compose exec app node scripts/remote-admin-key.js …
 */
import { openDb } from '../src/db.js';
import { addAdminKey } from '../src/remoteAdmin.js';

const [cmd, a, b] = process.argv.slice(2);
const db = openDb(process.env.DATA_DIR || './data');
if (cmd === 'add' && a && b) {
  console.log(`Đã thêm máy "${a}" — key_id ${addAdminKey(db, a, b)}`);
} else if (cmd === 'list') {
  for (const r of db.prepare('SELECT key_id, label, disabled, created_at, last_seen, last_ip FROM remote_admin_keys ORDER BY created_at').all()) {
    console.log(`${r.key_id}  ${r.disabled ? 'TẮT ' : 'bật '} ${r.label}  thêm ${new Date(r.created_at).toISOString()}  dùng gần nhất ${r.last_seen ? new Date(r.last_seen).toISOString() : '—'} ${r.last_ip || ''}`);
  }
} else if (cmd === 'disable' && a) {
  console.log(db.prepare('UPDATE remote_admin_keys SET disabled = 1 WHERE key_id = ?').run(a).changes ? 'Đã tắt' : 'Không có key_id này');
} else {
  console.log('Dùng: add <tên> <spki-base64url> | list | disable <key_id>');
  process.exit(1);
}
