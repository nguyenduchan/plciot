/**
 * Gói BÙ dữ liệu (telemetry có bf:1): gateway vừa nối lại gửi mẫu đã lưu lúc offline kèm thời điểm gốc (ts, ms).
 * Tách riêng khỏi đường live để không bao giờ lẫn: không đụng trạng thái online / nhịp / cảnh báo, và dòng lưu có src='bf'.
 *
 * Từ chối khi: ts không hợp lệ hoặc ở tương lai (> now + 60 s); cũ hơn thời hạn lưu của gói; không phải schema:2;
 * đã có dòng LIVE trong ±gapMs (không chồng lên dữ liệu live); đã có mẫu bù cùng ts.
 */
import { hasLiveTelemetryNear } from './historyStore.js';
import { deviceRetentionDays } from './retention.js';

const DAY = 86_400_000;

/** @returns {{ok:true,row:object}|{ok:false,reason:string}} */
export function evaluateBackfill(db, { site, device, canonical, now = Date.now(), gapMs = 1000 }) {
  const bts = Number(canonical?.ts);
  if (!Number.isFinite(bts)) return { ok: false, reason: 'bad_ts' };
  const ts = Math.round(bts);
  if (ts > now + 60_000) return { ok: false, reason: 'future' };
  const days = deviceRetentionDays(db, site, device);
  if (Number.isFinite(days) && ts < now - days * DAY) return { ok: false, reason: 'beyond_retention' };
  if (!canonical.d || typeof canonical.d !== 'object') return { ok: false, reason: 'not_schema2' };
  if (hasLiveTelemetryNear(db, { site, device, ts, gapMs: Math.max(gapMs, 1000) })) return { ok: false, reason: 'overlaps_live' };
  const dup = db.prepare("SELECT 1 FROM mqtt_events WHERE site = ? AND device = ? AND kind = 'telemetry' AND src = 'bf' AND ts = ? LIMIT 1").get(site, device, ts);
  if (dup) return { ok: false, reason: 'duplicate' };
  return {
    ok: true,
    row: { ts, site, device, kind: 'telemetry', payload: JSON.stringify({ schema: 2, bf: 1, ts, d: canonical.d }), o: null, i: null, a: null, c: null, s: null, src: 'bf' },
  };
}
