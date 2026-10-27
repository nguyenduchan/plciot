import mqtt from 'mqtt';

/**
 * Kênh duy nhất được phép ghi plc/<site>/<device>/cmd (user MQTT `ctl`, xem mqttProvision.js).
 * Điện thoại không còn quyền ghi cmd: lệnh phải đi qua /api/control/cmd để bị kiểm tra step-up.
 */
let client = null;
let override = null;

/** Dùng trong test: thay đường publish thật. */
export function setPublisher(fn) { override = fn; }

function ensure() {
  if (client) return client;
  client = mqtt.connect(process.env.MQTT_CONTROL_URL || 'mqtt://mqtt:1884' /* listener nội bộ có quyền cmd */, {
    username: process.env.MQTT_CONTROL_USER || 'ctl',
    password: process.env.MQTT_CONTROL_PASS || '',
    clientId: `plciot-ctl-${Math.random().toString(16).slice(2, 8)}`,
    reconnectPeriod: 3000,
  });
  client.on('error', (e) => console.error('control mqtt', e.message));
  return client;
}

export function publishCmd(site, device, cmd) {
  if (override) return override(site, device, cmd);
  const c = ensure();
  if (!c.connected) return Promise.reject(new Error('mqtt_unavailable'));
  return new Promise((resolve, reject) => {
    c.publish(`plc/${site}/${device}/cmd`, JSON.stringify(cmd), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
}
