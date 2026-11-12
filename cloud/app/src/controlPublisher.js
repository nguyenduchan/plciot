import mqtt from 'mqtt';
import { topicOf, withSchema } from './contract.js';

/**
 * Kênh duy nhất được phép ghi …/cmd (user MQTT `ctl`, xem mqttProvision.js).
 * Điện thoại không còn quyền ghi cmd: lệnh phải đi qua /api/control/cmd để bị kiểm tra step-up.
 */
let client = null;
let override = null;
const CONNECT_WAIT_MS = 2500;

/** Dùng trong test: thay đường publish thật. */
export function setPublisher(fn) { override = fn; }

function ensure() {
  if (client) return client;
  client = mqtt.connect(process.env.MQTT_CONTROL_URL || 'mqtt://mqtt:1884' /* listener nội bộ có quyền cmd */, {
    username: process.env.MQTT_CONTROL_USER || 'ctl',
    password: process.env.MQTT_CONTROL_PASS || '',
    clientId: `plciot-ctl-${Math.random().toString(16).slice(2, 8)}`,
    // Kết nối giữ nóng: rớt thì nối lại sau 0,5 s (không để lệnh chờ 3 s), keepalive ngắn để phát hiện rớt sớm
    reconnectPeriod: 500,
    connectTimeout: 3000,
    keepalive: 15,
  });
  client.on('error', (e) => console.error('control mqtt', e.message));
  return client;
}

/** Kết nối sẵn lúc server khởi động để lệnh đầu tiên không rơi vào lúc chưa kết nối. */
export function startControlPublisher() {
  if (!override) ensure();
}

/** Nếu đang kết nối dở (vừa khởi động / đang tự nối lại) thì chờ một chút thay vì từ chối ngay. */
function whenConnected(c) {
  if (c.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.off('connect', ok); reject(new Error('mqtt_unavailable')); }, CONNECT_WAIT_MS);
    const ok = () => { clearTimeout(t); resolve(); };
    c.once('connect', ok);
  });
}

/**
 * @param {string} site
 * @param {string} device
 * @param {object} cmd
 * @param {{ mqttId: string }} opts  id MQTT ngẫu nhiên của gateway (devices.mqtt_id) — topic gw/<mqttId>/cmd
 */
export async function publishCmd(site, device, cmd, opts = {}) {
  // ts = lúc server phát lệnh (ms epoch): gateway dùng để đo thời gian server → gateway
  const payload = withSchema({ ...cmd, ts: Date.now() });
  if (override) return override(site, device, payload, opts);
  const c = ensure();
  await whenConnected(c);
  const topic = topicOf({ mqttId: opts.mqttId }, 'cmd');
  return new Promise((resolve, reject) => {
    c.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => (err ? reject(err) : resolve({ topic })));
  });
}
