/**
 * Bảo mật điều khiển (step-up) theo ngữ cảnh:
 *   1. PC trạm tại xưởng  — IP nằm trong CONTROL_LAN_CIDRS **và** khoá trạm (HWID/secret) hợp lệ → không hỏi mã.
 *   2. Điện thoại đời cao — Passkey (vân tay / Face ID), phiên ngắn (CONTROL_PASSKEY_TTL_SEC).
 *   3. Điện thoại đời thấp — TOTP một lần, phiên CONTROL_TOTP_TTL_DAYS ngày, gắn với mạng; đổi mạng → hỏi lại.
 *   4. Lệnh nguy hiểm — thêm nút nhấn vật lý (CONTROL_PHYSICAL_BIT) qua plcProof.
 */
import crypto from 'crypto';
import { canControl } from './roles.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const env = process.env;

export function controlConfig() {
  const bit = env.CONTROL_PHYSICAL_BIT;
  return {
    stepUp: String(env.CONTROL_STEPUP || 'true').toLowerCase() !== 'false',
    passkeyTtlMs: Number(env.CONTROL_PASSKEY_TTL_SEC || 300) * 1000,
    totpTtlMs: Number(env.CONTROL_TOTP_TTL_DAYS || 7) * 86_400_000,
    limits: regLimits(),
    bindNet: String(env.CONTROL_BIND_NET || 'true').toLowerCase() !== 'false',
    lanCidrs: String(env.CONTROL_LAN_CIDRS || '').split(',').map((s) => s.trim()).filter(Boolean),
    writable: new Set(String(env.CONTROL_WRITABLE || '3,4,6,7,9').split(',').map(Number).filter(Number.isInteger)),
    critical: new Set(String(env.CONTROL_CRITICAL_ADDRS || '4,6').split(',').map(Number).filter(Number.isInteger)),
    physicalBit: bit !== undefined && bit !== '' && Number.isInteger(Number(bit)) ? Number(bit) : null,
    physicalWaitMs: Number(env.CONTROL_PHYSICAL_WAIT_SEC || 30) * 1000,
  };
}

/**
 * Khoảng giá trị được ghi theo từng thanh ghi (khớp docs/PROTOCOL.md). Ghi đè bằng CONTROL_REG_LIMITS="7:0-5000,4:0-255".
 * D3 chế độ 0/1 · D4 mặt nạ Y0..Y7 · D6 chạy/dừng 0/1 · D7 số lượng mục tiêu · D9 chỉ nhận 1 (xoá số đếm).
 */
const DEFAULT_LIMITS = { 3: [0, 1], 4: [0, 255], 6: [0, 1], 7: [0, 60000], 9: [1, 1] };
function regLimits() {
  const out = { ...DEFAULT_LIMITS };
  for (const part of String(process.env.CONTROL_REG_LIMITS || '').split(',')) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[2]) <= Number(m[3])) out[Number(m[1])] = [Number(m[2]), Math.min(65535, Number(m[3]))];
  }
  return out;
}

/* ---------------- mạng / IP ---------------- */
function v4(ip) {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip || '');
  return m ? m.slice(1).map(Number) : null;
}

function expandV6(ip) {
  if (!ip.includes(':')) return null;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0').toLowerCase());
}

/** "Mạng" của một IP: /24 cho IPv4, /64 cho IPv6 — 4G đổi IP trong cùng nhà mạng thường vẫn giữ nhóm này. */
export function netOf(ip) {
  const a = v4(ip);
  if (a) return `${a[0]}.${a[1]}.${a[2]}`;
  const g = expandV6(String(ip || ''));
  return g ? g.slice(0, 4).join(':') : String(ip || 'unknown');
}

export function ipInCidrs(ip, cidrs) {
  const a = v4(ip);
  for (const c of cidrs) {
    const [base, bitsStr] = c.split('/');
    const b = v4(base);
    if (a && b) {
      const bits = bitsStr === undefined ? 32 : Number(bitsStr);
      if (!(bits >= 0 && bits <= 32)) continue;
      const toInt = (x) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if ((toInt(a) & mask) === (toInt(b) & mask)) return true;
    } else if (!a && !b && base.toLowerCase() === String(ip).toLowerCase()) {
      return true; // IPv6: chỉ khớp chính xác
    }
  }
  return false;
}

/* ---------------- phiên điều khiển ---------------- */
export function createControlSession(db, userId, method, ip, cfg = controlConfig()) {
  const now = Date.now();
  db.prepare('DELETE FROM control_sessions WHERE expires_at < ? OR revoked = 1').run(now - 86_400_000);
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = method === 'passkey' ? cfg.passkeyTtlMs : cfg.totpTtlMs;
  db.prepare(`
    INSERT INTO control_sessions (user_id, token_hash, method, net, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, sha(token), method, netOf(ip), now + ttl, now);
  return { token, method, expiresAt: now + ttl };
}

export function revokeControlSessions(db, userId, token = null) {
  if (token) db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ? AND token_hash = ?').run(userId, sha(token));
  else db.prepare('UPDATE control_sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

/** @returns {{ok:true, method:string, expiresAt:number}|{error:string, reason:string}} */
export function checkControlSession(db, userId, token, ip, cfg = controlConfig(), now = Date.now()) {
  if (!token) return { error: 'step_up_required', reason: 'no_token' };
  const row = db.prepare('SELECT * FROM control_sessions WHERE token_hash = ?').get(sha(token));
  if (!row || row.user_id !== userId || row.revoked) return { error: 'step_up_required', reason: 'invalid' };
  if (row.expires_at < now) return { error: 'step_up_required', reason: 'expired' };
  if (cfg.bindNet && row.net !== netOf(ip)) return { error: 'step_up_required', reason: 'network_changed' };
  return { ok: true, method: row.method, expiresAt: row.expires_at };
}

/**
 * Người có quyền điều khiển phải bật vân tay/Authenticator trong CONTROL_ENROLL_GRACE_DAYS ngày (mặc định 3, "off" = không ép).
 * Hết hạn → khoá điều khiển (vẫn xem được) cho tới khi bật. Hạn đặt lần đầu cần tới, nên người dùng cũ có đủ thời gian khi nâng cấp.
 */
export function enrollState(db, user, now = Date.now()) {
  const f = factorSummary(db, user.id);
  if (f.passkeys || f.totp || !canControl(user)) return { needed: false, locked: false, deadline: null };
  const raw = String(process.env.CONTROL_ENROLL_GRACE_DAYS ?? '3').toLowerCase();
  if (raw === 'off' || Number(raw) < 0) return { needed: true, locked: false, deadline: null };
  let deadline = db.prepare('SELECT enroll_deadline FROM users WHERE id = ?').get(user.id)?.enroll_deadline;
  if (!deadline) {
    deadline = now + (Number(raw) || 0) * 86_400_000;
    db.prepare('UPDATE users SET enroll_deadline = ? WHERE id = ?').run(deadline, user.id);
  }
  return { needed: true, locked: now > deadline, deadline };
}

export function factorSummary(db, userId) {
  const passkeys = db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
  const u = db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return { passkeys, totp: Boolean(u?.totp_enabled) };
}

/* ---------------- PC trạm ---------------- */
export function createStation(db, userId, name) {
  const id = `st_${crypto.randomBytes(6).toString('hex')}`;
  const key = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO stations (id, user_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, String(name || id).slice(0, 60), sha(key), Date.now());
  return { id, key };
}

export function listStations(db) {
  return db.prepare('SELECT id, user_id, name, created_at, last_seen_at FROM stations ORDER BY created_at').all();
}

export function deleteStation(db, id) {
  return db.prepare('DELETE FROM stations WHERE id = ?').run(String(id)).changes > 0;
}

/** Trạm hợp lệ = IP trong dải xưởng + id/khoá khớp + trạm thuộc chính user đang đăng nhập. */
export function stationOk(db, userId, headers, ip, cfg = controlConfig()) {
  const id = String(headers['x-station-id'] || '');
  const key = String(headers['x-station-key'] || '');
  if (!id || !key || !cfg.lanCidrs.length || !ipInCidrs(ip, cfg.lanCidrs)) return false;
  const row = db.prepare('SELECT * FROM stations WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  const a = Buffer.from(row.key_hash);
  const b = Buffer.from(sha(key));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  db.prepare('UPDATE stations SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  return true;
}

/* ---------------- kiểm tra lệnh ---------------- */
const u16 = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;

/** Chỉ cho ghi thanh ghi trong whitelist (trùng WRITABLE ở gateway) hoặc đọc 0–299 × 1–20. */
export function validateCmd(body, cfg = controlConfig()) {
  const b = body || {};
  const id = /^[a-z0-9]{1,16}$/i.test(String(b.id || '')) ? String(b.id) : crypto.randomBytes(5).toString('hex');
  const a = Number(b.a);
  if (b.op === 'read') {
    const n = Number(b.n ?? 1);
    if (!(Number.isInteger(a) && a >= 0 && a <= 299 && Number.isInteger(n) && n >= 1 && n <= 20)) return { error: 'bad_command' };
    return { cmd: { id, op: 'read', a, n }, write: false };
  }
  const v = Number(b.v);
  if (!cfg.writable.has(a) || !u16(v)) return { error: 'bad_command' };
  const [lo, hi] = cfg.limits[a] || [0, 65535];
  if (v < lo || v > hi) return { error: 'value_out_of_range', min: lo, max: hi };
  return { cmd: { id, a, v }, write: true, critical: cfg.critical.has(a) };
}
