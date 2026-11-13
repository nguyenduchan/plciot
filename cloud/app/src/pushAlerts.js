/**
 * Cảnh báo nguy hiểm → Web Push. Hai nguồn:
 *  1. Telemetry `d.<child>.<field>` vượt ngưỡng `low`/`high` mà gateway đã khai trong config (server tự so sánh).
 *  2. Trạng thái gateway: offline / plc_fault / fault.
 * Chỉ báo khi CHUYỂN trạng thái (bình thường → thấp/cao), và có thời gian chờ giữa hai lần báo cùng một giá trị.
 */
import { pushToGatewayUsers } from './webPush.js';

const COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_SEC || 300) * 1000;
const state = new Map();       // `${tenant}/${site}/${device}/${child}.${key}` → 'ok' | 'low' | 'high'
const lastSent = new Map();    // key → ts
const cfgCache = new Map();    // `${tenant}/${site}/${device}` → { at, map }

function limitsFor(db, tenantId, site, device, now) {
  const ck = `${tenantId}/${site}/${device}`;
  const hit = cfgCache.get(ck);
  if (hit && now - hit.at < 30_000) return hit.map;
  const map = new Map();
  try {
    const row = db.prepare('SELECT devices FROM gateway_configs WHERE tenant_id = ? AND site = ? AND device = ?').get(tenantId, site, device);
    const devs = row ? JSON.parse(row.devices) : [];
    for (const d of Array.isArray(devs) ? devs : []) {
      for (const f of d.fields || []) {
        if (typeof f.low === 'number' || typeof f.high === 'number') {
          map.set(`${d.id}.${f.key}`, { low: f.low, high: f.high, title: d.name || d.id, label: f.lbl || f.key, unit: f.unit || '' });
        }
      }
    }
  } catch { /* config lỗi: không có ngưỡng */ }
  if (cfgCache.size > 2000) cfgCache.clear();
  cfgCache.set(ck, { at: now, map });
  return map;
}

function cooled(key, now) {
  if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 20000) lastSent.clear();
  return true;
}

/** `d` = telemetry.d. Trả về số cảnh báo đã phát đi (để test). */
export function evaluateTelemetryAlerts(db, { tenantId, site, device, d, now = Date.now() }) {
  if (!d || typeof d !== 'object') return [];
  const limits = limitsFor(db, tenantId, site, device, now);
  if (!limits.size) return [];
  const fired = [];
  for (const [path, lim] of limits) {
    const [child, key] = path.split('.');
    const v = Number(d?.[child]?.[key]);
    if (!Number.isFinite(v)) continue;
    const next = typeof lim.high === 'number' && v > lim.high ? 'high' : typeof lim.low === 'number' && v < lim.low ? 'low' : 'ok';
    const sk = `${tenantId}/${site}/${device}/${path}`;
    const was = state.get(sk) || 'ok';
    state.set(sk, next);
    if (state.size > 20000) state.clear();
    if (next === 'ok' || next === was) continue;
    if (!cooled(`${sk}/${next}`, now)) continue;
    const lbl = `${lim.title}: ${lim.label}`;
    const text = `${lbl} ${next === 'high' ? 'vượt ngưỡng cao' : 'xuống dưới ngưỡng thấp'} (${Math.round(v * 10) / 10}${lim.unit ? ' ' + lim.unit : ''})`;
    fired.push({ path, level: next, value: v, text });
    pushToGatewayUsers(db, site, device, { t: '⚠ Cảnh báo nguy hiểm', b: text, tag: `${site}/${device}/${path}`, url: '/' })
      .catch((e) => console.error('push alert', e.message));
  }
  return fired;
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

export function resetAlertState() { state.clear(); lastSent.clear(); cfgCache.clear(); }
