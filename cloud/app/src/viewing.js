/**
 * "Đang xem": webapp đang mở gửi nhịp POST /api/viewing mỗi ~20 giây; server báo (tín hiệu hệ thống ký, gw/<id>/cmd { sys:'live', ttl })
 * cho các gateway của người dùng đó tăng tốc gửi data (telemetryMinMs của gói, vd. 2 giây). Hết nhịp > ttl thì gateway tự quay về
 * tốc độ LƯU của gói (storeEveryMs, vd. 1 phút) — không ai xem thì không tốn băng thông/CPU.
 * Báo lại tối đa mỗi RENEW_MS cho mỗi gateway (nhiều người cùng xem vẫn chỉ một tín hiệu).
 */
import { gatewaysOfUser } from './mqttIds.js';
import { notifyGateway } from './gatewayNotify.js';

export const LIVE_TTL_SEC = Number(process.env.LIVE_TTL_SEC || 60);
export const LIVE_RENEW_MS = Number(process.env.LIVE_RENEW_MS || 30_000);
const lastSent = new Map();   // "site/device" -> ms

/** Trả { gateways, notified }. `notify` để test thay bằng hàm giả. */
export function markViewing(db, user, { now = Date.now(), notify = notifyGateway } = {}) {
  const gws = gatewaysOfUser(db, user).filter((g) => g.mqttId);
  let notified = 0;
  for (const g of gws) {
    const k = `${g.site}/${g.device}`;
    if (now - (lastSent.get(k) || 0) < LIVE_RENEW_MS) continue;
    if (lastSent.size > 20_000) lastSent.clear();
    lastSent.set(k, now);
    notify(db, g.site, g.device, 'live', { ttl: LIVE_TTL_SEC });
    notified += 1;
  }
  return { ok: true, ttl: LIVE_TTL_SEC, gateways: gws.length, notified };
}

/** Chỉ dùng trong test. */
export function resetViewing() { lastSent.clear(); }
