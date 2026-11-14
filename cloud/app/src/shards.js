/**
 * Chia nhóm broker: MQTT_SHARDS tiến trình Mosquitto, mỗi tiến trình (một core) giữ một tập gateway cố định.
 * Gateway thuộc nhóm theo id MQTT của nó (đăng ký sẵn, server cấp): shard = 8 hex đầu của mqttId mod N — ổn định, không cần tra bảng.
 * N=1 (mặc định) = hành vi cũ, một broker `plciot-mqtt`. Đổi N sau khi đã có gateway phải cấp lại cấu hình (xem docs/SHARDING.md).
 * Nhóm 0 giữ tên/thư mục cũ (plciot-mqtt, config/), nhóm k≥1: container plciot-mqtt-k, thư mục config/shard<k>/, host mqtt-k.
 */
export function shardCount() {
  const n = parseInt(process.env.MQTT_SHARDS || '1', 10);
  return Number.isInteger(n) ? Math.max(1, Math.min(64, n)) : 1;
}

export function shardOf(mqttId, n = shardCount()) {
  if (n <= 1 || !mqttId) return 0;
  const v = parseInt(String(mqttId).slice(0, 8), 16);
  return Number.isFinite(v) ? v % n : 0;
}

export const allShards = (n = shardCount()) => Array.from({ length: n }, (_, k) => k);
const baseContainer = () => process.env.MQTT_DOCKER_CONTAINER || 'plciot-mqtt';
export const shardContainer = (k) => (k === 0 ? baseContainer() : `${baseContainer()}-${k}`);
export const shardHost = (k) => (k === 0 ? 'mqtt' : `mqtt-${k}`);
export const shardSubdir = (k) => (k === 0 ? '' : `shard${k}`);

/** Danh sách URL kết nối nội bộ theo nhóm; biến dạng danh sách (phân cách dấu phẩy) ghi đè. N=1 → một URL như cũ. */
export function shardUrls(listEnv, singleEnv, defPort, n = shardCount()) {
  const list = String(process.env[listEnv] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const single = process.env[singleEnv];
  if (n <= 1) return [single || `mqtt://mqtt:${defPort}`];
  return allShards(n).map((k) => `mqtt://${shardHost(k)}:${defPort}`);
}

/** Cổng công khai MQTTS của nhóm k = cổng gốc + k (HAProxy sinh theo scripts/gen-shards.js). */
export const shardPort = (basePort, k) => Number(basePort) + k;
