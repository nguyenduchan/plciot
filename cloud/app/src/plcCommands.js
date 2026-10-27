/**
 * Quy tắc lệnh PLC (RIÊNG của app này, không thuộc lõi bảo mật): thanh ghi nào được ghi, khoảng giá trị từng thanh ghi,
 * lệnh nào "nguy hiểm" cần nút vật lý. Khớp docs/PROTOCOL.md và WRITABLE ở gateway.
 */
import crypto from 'crypto';

const env = process.env;

/**
 * Khoảng giá trị được ghi theo từng thanh ghi. Ghi đè bằng CONTROL_REG_LIMITS="7:0-5000,4:0-255".
 * D3 chế độ 0/1 · D4 mặt nạ Y0..Y7 · D6 chạy/dừng 0/1 · D7 số lượng mục tiêu · D9 chỉ nhận 1 (xoá số đếm).
 */
const DEFAULT_LIMITS = { 3: [0, 1], 4: [0, 255], 6: [0, 1], 7: [0, 60000], 9: [1, 1] };
function regLimits() {
  const out = { ...DEFAULT_LIMITS };
  for (const part of String(env.CONTROL_REG_LIMITS || '').split(',')) {
    const m = /^\s*(\d+)\s*:\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    if (m && Number(m[2]) <= Number(m[3])) out[Number(m[1])] = [Number(m[2]), Math.min(65535, Number(m[3]))];
  }
  return out;
}

export function plcControlConfig() {
  const bit = env.CONTROL_PHYSICAL_BIT;
  return {
    limits: regLimits(),
    writable: new Set(String(env.CONTROL_WRITABLE || '3,4,6,7,9').split(',').map(Number).filter(Number.isInteger)),
    critical: new Set(String(env.CONTROL_CRITICAL_ADDRS || '4,6').split(',').map(Number).filter(Number.isInteger)),
    physicalBit: bit !== undefined && bit !== '' && Number.isInteger(Number(bit)) ? Number(bit) : null,
    physicalWaitMs: Number(env.CONTROL_PHYSICAL_WAIT_SEC || 30) * 1000,
  };
}

const u16 = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;

/** Chỉ cho ghi thanh ghi trong whitelist (trùng WRITABLE ở gateway) hoặc đọc 0–299 × 1–20. */
export function validateCmd(body, cfg = plcControlConfig()) {
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
