/**
 * Chia nhóm broker: MQTT_SHARDS tiến trình Mosquitto trong MỘT container (config/mqtt-entrypoint.sh tự tạo và ghim core theo cấu hình này),
 * mỗi tiến trình giữ một tập gateway cố định. MQTT_SHARDS = số (1..16) hoặc "auto" = số core - MQTT_RESERVE_CORES (mặc định 1).
 * Gateway thuộc nhóm theo id MQTT của nó (đăng ký sẵn, server cấp): shard = 8 hex đầu của mqttId mod N - ổn định, không cần tra bảng.
 * N=1 (mặc định) = hành vi cũ. Đổi N sau khi đã có gateway thật làm đổi nhóm của nhiều gateway (xem docs/SHARDING.md).
 * Nhóm k nghe cổng nội bộ = cổng gốc + 10k (1883/1884/1885/9001/9002), cổng mqtts công khai = cổng gốc + k, wss ở đường dẫn /mqtt-k.
 * passwd/acl: nhóm 0 ở config/, nhóm k ở config/shard<k>/.
 */
import os from 'node:os';

export const MAX_SHARDS = 16;
export const PORT_STRIDE = 10;

export function shardCount() {
  const raw = String(process.env.MQTT_SHARDS || '1').trim().toLowerCase();
  let n;
  if (raw === 'auto') n = os.cpus().length - Math.max(0, parseInt(process.env.MQTT_RESERVE_CORES || '1', 10) || 0);
  else n = parseInt(raw, 10);
  return Number.isInteger(n) ? Math.max(1, Math.min(MAX_SHARDS, n)) : 1;
}

export function shardOf(mqttId, n = shardCount()) {
  if (n <= 1 || !mqttId) return 0;
  const v = parseInt(String(mqttId).slice(0, 8), 16);
  return Number.isFinite(v) ? v % n : 0;
}

export const allShards = (n = shardCount()) => Array.from({ length: n }, (_, k) => k);
/** Mọi nhóm nằm trong cùng một container (mỗi nhóm một tiến trình), nên tên container và host nội bộ không đổi. */
export const shardContainer = () => process.env.MQTT_DOCKER_CONTAINER || 'plciot-mqtt';
export const shardHost = () => 'mqtt';
export const shardSubdir = (k) => (k === 0 ? '' : `shard${k}`);
export const shardConfigDirInContainer = (k) => (k === 0 ? '/mosquitto/config' : `/mosquitto/config/shard${k}`);

/** URL kết nối nội bộ theo nhóm: cổng gốc + 10k; biến dạng danh sách (phân cách dấu phẩy) ghi đè. N=1 -> một URL như cũ. */
export function shardUrls(listEnv, singleEnv, defPort, n = shardCount()) {
  const list = String(process.env[listEnv] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const single = process.env[singleEnv];
  if (n <= 1) return [single || `mqtt://mqtt:${defPort}`];
  return allShards(n).map((k) => `mqtt://mqtt:${defPort + PORT_STRIDE * k}`);
}

/** Cổng công khai MQTTS của nhóm k = cổng gốc + k (haproxy sinh tự động, xem config/haproxy-entrypoint.sh). */
export const shardPort = (basePort, k) => Number(basePort) + k;
