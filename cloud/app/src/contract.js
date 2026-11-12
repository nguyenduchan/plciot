/**
 * Hợp đồng tích hợp MQTT của nền tảng (platform contract).
 * Mọi adapter/thiết bị/partner chỉ cần tuân thủ file này + docs/PARTNER-INTEGRATION.md.
 *
 * Topic (MỘT dạng duy nhất):  gw/{mqttId}/{kind}
 *   mqttId = id NGẪU NHIÊN do server cấp cho mỗi gateway (16 ký tự hex), lưu trong bảng devices
 *   và ánh xạ tới site/device/cấu hình. Topic không lộ tên site/device.
 *
 * kind ∈ telemetry | status | history | cmd | ack | config (gateway khai báo cấu trúc thiết bị)
 * Telemetry IoT: schema 2 + d.{childId}.{field}
 * Cmd / conveyor legacy: schema 1 (+ r[] khi băng tải)
 */
import crypto from 'crypto';

/** Schema lệnh / partner legacy (cmd, ack, r[]). */
export const SCHEMA_VERSION = 1;
/** Schema telemetry IoT (monitor + UI bind). */
export const TELEMETRY_SCHEMA = 2;
export const KINDS = Object.freeze(['telemetry', 'status', 'history', 'cmd', 'ack', 'config']);
/** Tiền tố topic của mọi gateway. */
export const GW_NS = 'gw';
export const DEFAULT_TENANT = 'default';

const MQTT_ID_RE = /^[a-f0-9]{16}$/;

/** Id MQTT ngẫu nhiên (64 bit) cấp cho gateway; không suy ra được từ site/device. */
export function newMqttId() {
  return crypto.randomBytes(8).toString('hex');
}

export function isValidMqttId(s) {
  return typeof s === 'string' && MQTT_ID_RE.test(s);
}

export function sanitizeId(s, max = 48) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max);
}

export function isValidId(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(s);
}

/**
 * @param {{ mqttId: string }} p
 * @returns {string} topic base không có /kind
 */
export function topicBase(p) {
  if (!isValidMqttId(p?.mqttId)) throw new Error('bad_mqtt_id');
  return `${GW_NS}/${p.mqttId}`;
}

/** Danh sách base topic mà client/ACL cần (một phần tử; giữ dạng mảng cho client). */
export function topicBases(p) {
  return [topicBase(p)];
}

export function topicOf(p, kind) {
  if (!KINDS.includes(kind)) throw new Error(`bad_kind:${kind}`);
  return `${topicBase(p)}/${kind}`;
}

/** Phân tích topic → { ns, mqttId, kind } hoặc null. site/device/tenant do nơi gọi tra từ bảng devices. */
export function parseTopic(topic) {
  const parts = String(topic || '').split('/');
  if (parts[0] === GW_NS && parts.length === 3 && isValidMqttId(parts[1]) && KINDS.includes(parts[2])) {
    return { ns: GW_NS, mqttId: parts[1], kind: parts[2] };
  }
  return null;
}

/** Topic filter cho ingest (có thể nhiều). */
export function ingestTopicFilters() {
  const custom = process.env.MQTT_INGEST_TOPIC;
  if (custom) return custom.split(',').map((x) => x.trim()).filter(Boolean);
  return [`${GW_NS}/+/+`];
}

/** Gắn schema vào payload lệnh/telemetry (không đè nếu đã có). */
export function withSchema(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  if (obj.schema != null) return obj;
  return { schema: SCHEMA_VERSION, ...obj };
}

/** Endpoint công khai trả cho partner/firmware khi provision. */
export function mqttPublicEndpoints() {
  const host = process.env.MQTT_PUBLIC_HOST || process.env.MQTT_DOMAIN || '';
  const mqttsPort = Number(process.env.MQTT_PUBLIC_MQTTS_PORT || process.env.PUB_PORT_MQTTS || 8883);
  const wssUrl = process.env.MQTT_PUBLIC_WSS
    || (host ? `wss://${host}` : (process.env.WEBAPP_PUBLIC_URL || '').replace(/^https/i, 'wss').replace(/\/$/, '') + '-mqtt');
  return {
    host: host || null,
    /** SHA-256 (hex, không dấu :) của chứng chỉ TLS broker khi tự ký; gateway ghim đúng chứng chỉ này (CloudPinSha256). Rỗng = chứng chỉ CA thật. */
    pinSha256: (process.env.MQTT_PUBLIC_PIN_SHA256 || '').replace(/[:\s]/g, '').toLowerCase() || null,
    mqtts: host ? `mqtts://${host}:${mqttsPort}` : (process.env.MQTT_PUBLIC_MQTTS || null),
    wss: process.env.MQTT_PUBLIC_WSS || (host ? `wss://${host}/mqtt` : null),
    /** Listener nội bộ Docker — không đưa cho thiết bị ngoài. */
    internalPlain: process.env.MQTT_URL || 'mqtt://mqtt:1883',
    internalControl: process.env.MQTT_CONTROL_URL || 'mqtt://mqtt:1884',
  };
}

export function contractInfo() {
  return {
    schema: SCHEMA_VERSION,
    telemetrySchema: TELEMETRY_SCHEMA,
    kinds: [...KINDS],
    topicPattern: `${GW_NS}/{mqttId}/{kind}`,
    defaultTenant: DEFAULT_TENANT,
    endpoints: mqttPublicEndpoints(),
    telemetry: { shape: 'd', example: { schema: TELEMETRY_SCHEMA, d: { childId: { field: 0 } } } },
    control: { shape: 'cmd', example: { schema: SCHEMA_VERSION, id: '…', a: 6, v: 1 } },
  };
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function randomApiKey() {
  return `pk_${crypto.randomBytes(24).toString('base64url')}`;
}
