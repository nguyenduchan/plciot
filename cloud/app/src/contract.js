/**
 * Hợp đồng tích hợp MQTT của nền tảng (platform contract).
 * Mọi adapter/thiết bị/partner chỉ cần tuân thủ file này + docs/PARTNER-INTEGRATION.md.
 *
 * Topic:
 *   Legacy (gateway hiện tại):  plc/{site}/{device}/{kind}
 *   Chuẩn đa tenant:            iot/{tenant}/{site}/{device}/{kind}
 *
 * kind ∈ telemetry | status | history | cmd | ack
 * Payload JSON có trường schema (số nguyên); hiện tại = 1.
 */
import crypto from 'crypto';

export const SCHEMA_VERSION = 1;
export const KINDS = Object.freeze(['telemetry', 'status', 'history', 'cmd', 'ack']);
export const LEGACY_NS = 'plc';
export const PLATFORM_NS = 'iot';
export const DEFAULT_TENANT = 'default';

/** true (mặc định): ACL + ingest hỗ trợ cả plc/ và iot/ trong giai chuyển. */
export function dualNamespace() {
  return String(process.env.MQTT_DUAL_NS || 'true').toLowerCase() !== 'false';
}

/**
 * Namespace ưu tiên khi cấp credential / publish cmd nếu thiết bị chưa khai báo riêng.
 * Giữ 'plc' để gateway/firmware cũ không cần nạp lại.
 */
export function preferredNamespace() {
  const v = String(process.env.MQTT_PREFERRED_NS || LEGACY_NS).toLowerCase();
  return v === PLATFORM_NS ? PLATFORM_NS : LEGACY_NS;
}

export function sanitizeId(s, max = 48) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max);
}

export function isValidId(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(s);
}

/**
 * @param {{ ns?: string, tenant?: string, site: string, device: string }} p
 * @returns {string} topic base không có /kind
 */
export function topicBase(p) {
  const site = sanitizeId(p.site);
  const device = sanitizeId(p.device);
  const ns = p.ns || preferredNamespace();
  if (ns === LEGACY_NS) return `${LEGACY_NS}/${site}/${device}`;
  const tenant = sanitizeId(p.tenant || DEFAULT_TENANT);
  return `${PLATFORM_NS}/${tenant}/${site}/${device}`;
}

/** Mọi base topic mà client/ACL cần (legacy + iot khi dual). */
export function topicBases(p) {
  const site = sanitizeId(p.site);
  const device = sanitizeId(p.device);
  const tenant = sanitizeId(p.tenant || DEFAULT_TENANT);
  const primary = topicBase({ ...p, site, device, tenant });
  if (!dualNamespace()) return [primary];
  const legacy = `${LEGACY_NS}/${site}/${device}`;
  const modern = `${PLATFORM_NS}/${tenant}/${site}/${device}`;
  return primary === legacy ? [legacy, modern] : [modern, legacy];
}

export function topicOf(p, kind) {
  if (!KINDS.includes(kind)) throw new Error(`bad_kind:${kind}`);
  return `${topicBase(p)}/${kind}`;
}

/**
 * Phân tích topic → { ns, tenant, site, device, kind } hoặc null.
 * Chấp nhận cả plc/… và iot/….
 */
export function parseTopic(topic) {
  const parts = String(topic || '').split('/');
  if (parts[0] === LEGACY_NS && parts.length >= 4) {
    const kind = parts[3];
    if (!KINDS.includes(kind)) return null;
    return {
      ns: LEGACY_NS,
      tenant: DEFAULT_TENANT,
      site: parts[1],
      device: parts[2],
      kind,
    };
  }
  if (parts[0] === PLATFORM_NS && parts.length >= 5) {
    const kind = parts[4];
    if (!KINDS.includes(kind)) return null;
    return {
      ns: PLATFORM_NS,
      tenant: parts[1],
      site: parts[2],
      device: parts[3],
      kind,
    };
  }
  return null;
}

/** Topic filter cho ingest (có thể nhiều). */
export function ingestTopicFilters() {
  const custom = process.env.MQTT_INGEST_TOPIC;
  if (custom) return custom.split(',').map((s) => s.trim()).filter(Boolean);
  const filters = [`${LEGACY_NS}/+/+/+`];
  if (dualNamespace() || preferredNamespace() === PLATFORM_NS) {
    filters.push(`${PLATFORM_NS}/+/+/+/+`);
  }
  return filters;
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
    kinds: [...KINDS],
    namespaces: { legacy: LEGACY_NS, platform: PLATFORM_NS },
    preferredNs: preferredNamespace(),
    dualNs: dualNamespace(),
    defaultTenant: DEFAULT_TENANT,
    endpoints: mqttPublicEndpoints(),
  };
}

export function hashApiKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

export function randomApiKey() {
  return `pk_${crypto.randomBytes(24).toString('base64url')}`;
}
