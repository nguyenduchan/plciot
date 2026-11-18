#!/usr/bin/env node
/**
 * Tạo (hoặc dùng lại) tài khoản THỬ riêng cho kiểm thử PlcSim → GatewayApp → cloud → webapp, in ra JSON:
 *   { username, userId, regToken (đăng ký gateway, 30 phút), appToken, loginData (dán vào finishLogin() ở login.html) }
 * Chạy TRONG container app (cần ADMIN_SSH_LOGIN cho phiên admin cục bộ):
 *   docker cp cloud/app/scripts/make-sim-user.js plciot-app:/app/scripts/ && docker exec -w /app plciot-app node scripts/make-sim-user.js t_sim
 * Không đụng tài khoản thật; dọn bằng: docker exec -w /app plciot-app node scripts/make-sim-user.js t_sim --purge
 */
import { openDb, findUserByUsername } from '../src/db.js';
import { createAppSession, signToken } from '@plciot/security';
import { grantPlan } from '../src/entitlements.js';
import { listBundleFiles, resolveBundleRoot } from '../src/bundle.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3080';
const uname = process.argv[2] || 't_sim';
const db = openDb(process.env.DATA_DIR || '/app/data');
const j = async (p, opt = {}, tok) => {
  const r = await fetch(BASE + p, { ...opt, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
};
const adminTok = (await j('/api/admin/local-session')).body.token;
if (!adminTok) throw new Error('không lấy được phiên admin (ADMIN_SSH_LOGIN)');

if (process.argv.includes('--purge')) {
  const u = findUserByUsername(db, uname);
  if (u) {
    for (const row of db.prepare('SELECT device FROM hardware_devices WHERE site = ?').all(`u${u.id}`)) await j(`/api/admin/hardware/u${u.id}/${row.device}?force=1`, { method: 'DELETE' }, adminTok);
    const d = await j(`/api/admin/users/${u.id}`, { method: 'DELETE' }, adminTok);
    console.log(JSON.stringify({ purged: uname, ok: d.ok, status: d.status }));
  } else console.log(JSON.stringify({ purged: uname, ok: true, note: 'không có tài khoản' }));
  process.exit(0);
}

let u = findUserByUsername(db, uname);
if (!u) {
  const c = await j('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: uname, role: 'operator' }) }, adminTok);
  if (!c.ok) throw new Error('tạo tài khoản lỗi: ' + JSON.stringify(c.body));
  u = findUserByUsername(db, uname);
}
db.prepare('UPDATE users SET setup_complete = 1 WHERE id = ?').run(u.id);
grantPlan(db, u.id, 'factory', { expiresAt: null });
const sid = createAppSession(db, u.id, 'sim');
const appToken = signToken({ uid: u.id, tv: u.token_version | 0, sid }, process.env.APP_JWT_SECRET, 12 * 3600);
const regToken = signToken({ uid: u.id, tv: u.token_version | 0, scope: 'gateway_register' }, process.env.APP_JWT_SECRET, 1800);
u = findUserByUsername(db, uname);
const root = resolveBundleRoot(process.env.DATA_DIR || '/app/data', u.folder_path);
const files = listBundleFiles(root);
console.log(JSON.stringify({ username: uname, userId: u.id, regToken, appToken, loginData: { token: appToken, userId: u.id, username: uname, role: u.role, version: u.version, files } }));
process.exit(0);
