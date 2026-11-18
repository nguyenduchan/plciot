/**
 * DB trên VPS phải phục vụ MỌI phiên bản gateway/webapp còn chạy ngoài hiện trường:
 *  1) Migration chỉ THÊM (bảng/cột mới, có mặc định hoặc NULL) — cấm DROP/RENAME làm gateway/webapp bản cũ hỏng. Muốn bỏ cột: đợi gateway_clients cho thấy không còn bản cũ, rồi mới làm (và sửa allowlist dưới đây có chủ đích).
 *  2) Mở DB nhiều lần (mỗi lần deploy) không đổi/mất dữ liệu.
 *  3) Ghi nhận được version gateway đang nối.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DB_SCHEMA_VERSION } from '../src/db.js';
import { recordGatewayClient } from '../src/gatewayUpdate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(here, '..', 'src'), path.join(here, '..', '..', '..', 'packages', 'security', 'src')];
const ALLOW = [/ALTER TABLE user_devices RENAME TO user_devices_legacy_old/];   // chuyển bảng cũ sang bảng mới một lần (userDevices.js), dữ liệu được giữ
const bad = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  for (const f of fs.readdirSync(root).filter((n) => n.endsWith('.js'))) {
    fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\b(DROP\s+(TABLE|COLUMN)|RENAME\s+(COLUMN|TO))\b/i.test(line) && !ALLOW.some((a) => a.test(line))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
}
assert.deepEqual(bad, [], 'Migration phá schema (gateway/webapp bản cũ sẽ hỏng):\n' + bad.join('\n'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbcompat-'));
const db1 = openDb(dir);
db1.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('t1','x',1)").run();
db1.close?.();
const db2 = openDb(dir);   // deploy lần sau: migrate lại phải giữ dữ liệu
assert.equal(db2.prepare("SELECT name FROM tenants WHERE id='t1'").get()?.name, 'x');

assert.equal(Number(db2.pragma('user_version', { simple: true })), DB_SCHEMA_VERSION, 'DB được đóng dấu phiên bản schema');
recordGatewayClient(db2, 's', 'd', { 'x-gateway-version': 'abc123', 'x-gateway-api': '1' });
recordGatewayClient(db2, 's', 'd', { 'x-gateway-version': 'def456', 'x-gateway-api': '2' });
recordGatewayClient(db2, 's', 'd', { 'x-gateway-version': 'def456', 'x-gateway-api': '2', 'x-gateway-backup': '1700000000' });
assert.equal(db2.prepare("SELECT last_backup_at FROM gateway_clients WHERE device='d'").get().last_backup_at, 1700000000000, 'ghi thời điểm sao lưu');
recordGatewayClient(db2, 's', 'd', { 'x-gateway-version': 'def456' });   // lần sau không gửi: giữ giá trị cũ
assert.equal(db2.prepare("SELECT last_backup_at FROM gateway_clients WHERE device='d'").get().last_backup_at, 1700000000000);
recordGatewayClient(db2, 's', 'd2', { 'x-gateway-version': '../../etc' });   // sai định dạng: bỏ qua
const rows = db2.prepare('SELECT * FROM gateway_clients ORDER BY device').all();
assert.equal(rows.length, 1);
assert.equal(rows[0].version, 'def456');
assert.equal(rows[0].api_level, 2);
db2.close?.();
fs.rmSync(dir, { recursive: true, force: true });
console.log('DB compat smoke passed');
