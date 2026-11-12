/**
 * Server → gateway: tín hiệu hệ thống qua gw/<mqttId>/cmd (không phải lệnh điều khiển PLC).
 *   { sys: 'claimed' }    tem vừa có user  → gateway bắt đầu gửi telemetry/history
 *   { sys: 'unclaimed' }  tem bị gỡ chủ    → gateway ngừng gửi data (chỉ còn đồng bộ setting)
 * Best-effort: mất gói thì gateway tự hỏi lại /gateway/config mỗi 60 giây (claimed:true/false).
 */
import { publishCmd } from './controlPublisher.js';

export function notifyGateway(db, site, device, sys) {
  try {
    const mqttId = db.prepare('SELECT mqtt_id FROM devices WHERE site = ? AND device = ?').get(site, device)?.mqtt_id;
    if (!mqttId) return;
    publishCmd(site, device, { sys }, { mqttId }).catch((e) => console.error(`notify ${sys}`, e.message));
  } catch { /* tem không có gateway MQTT: bỏ qua, không ảnh hưởng thao tác chính */ }
}
