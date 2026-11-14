/**
 * Cảnh báo → Web Push. Server KHÔNG tính toán cảnh báo dữ liệu: gateway tự so ngưỡng low/high và gửi sự kiện
 * `gw/<mqttId>/alert`; server chỉ lưu sự kiện vào DB (mqttIngest) và chuyển tiếp đúng các tài khoản của gateway đó.
 * Riêng trạng thái gateway (offline / plc_fault / fault) vẫn do server báo vì gateway mất kết nối thì không tự gửi được.
 */
import { pushToGatewayUsers } from './webPush.js';

const COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_SEC || 300) * 1000;
const lastSent = new Map();    // key → ts

function cooled(key, now) {
  if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 20000) lastSent.clear();
  return true;
}

/** Payload sự kiện từ gateway: {"schema":1,"k":"tank1.level","lv":"low|high","v":12.3,"txt":"…"}. Trả về văn bản hoặc null nếu sai dạng. */
export function parseGatewayAlert(text) {
  let a;
  try { a = JSON.parse(text); } catch { return null; }
  if (!a || typeof a !== 'object') return null;
  const txt = typeof a.txt === 'string' ? a.txt.trim().slice(0, 300) : '';
  if (!txt) return null;
  return { key: String(a.k || '').slice(0, 80), level: a.lv === 'low' ? 'low' : 'high', value: Number(a.v), text: txt };
}

/** Chuyển tiếp cảnh báo của gateway tới các tài khoản đang xem gateway đó (không tính toán gì thêm). */
export function forwardGatewayAlert(db, { site, device, alert }) {
  pushToGatewayUsers(db, site, device, { t: '⚠ Cảnh báo nguy hiểm', b: alert.text, tag: `${site}/${device}/${alert.key || 'alert'}`, url: '/' })
    .catch((e) => console.error('push alert', e.message));
}

const STATUS_TEXT = {
  offline: 'Gateway mất kết nối',
  plc_fault: 'Lỗi kết nối PLC',
  fault: 'Gateway báo lỗi',
};

export function evaluateStatusAlert(db, { site, device, text, now = Date.now() }) {
  const msg = STATUS_TEXT[String(text).trim()];
  if (!msg) return false;
  const k = `${site}/${device}/status/${String(text).trim()}`;
  if (!cooled(k, now)) return false;
  pushToGatewayUsers(db, site, device, { t: '⚠ Cảnh báo hệ thống', b: `${site}/${device}: ${msg}`, tag: `${site}/${device}/status`, url: '/' })
    .catch((e) => console.error('push status', e.message));
  return true;
}

export function resetAlertState() { lastSent.clear(); }
