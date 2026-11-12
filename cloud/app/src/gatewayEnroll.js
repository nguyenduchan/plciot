/**
 * Gateway enroll — cấp MQTT + pack (id/fields) từ tem hardware.
 * Gateway chỉ gom/đóng gói số; type/UI ở server.
 *
 * POST /api/v1/gateway/enroll  → mqtt + topics + pack (+ password)
 * POST /api/v1/gateway/config  → pack/topics/configRev
 */
import {
  decodeClaimQr, bindGatewayHardware, verifyClaimSignature, hashClaimSecret, rateLimit, clientIp, audit,
} from '@plciot/security';
import {
  DEFAULT_TENANT, mqttPublicEndpoints,
} from './contract.js';
import { ensureDefaultTenant, provisionDevice, getTenant } from './tenants.js';
import { getDeviceType, resolveDeviceTypeId } from './uiContract.js';
import { normalizeLimits } from './childControl.js';
import { submitPairing } from './gatewayPairing.js';

function parseUiMeta(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export function controlProfileForHardware(hwProfile) {
  const id = resolveDeviceTypeId(hwProfile);
  if (id === 'conveyor') return 'conveyor-v1';
  return 'monitor-only';
}

export function bumpConfigRev(prevMeta, nextMeta) {
  if (nextMeta == null) return null;
  const next = typeof nextMeta === 'string' ? parseUiMeta(nextMeta) : { ...nextMeta };
  if (!next || typeof next !== 'object') return nextMeta;
  const prev = parseUiMeta(prevMeta);
  const prevRev = Number(prev?.configRev) || 0;
  const requested = Number(next.configRev) || 0;
  next.configRev = Math.max(prevRev + 1, requested);
  return next;
}

function extractClaimPayload(body = {}) {
  if (body.qr != null || body.claimQr != null) {
    let raw = String(body.qr ?? body.claimQr).trim();
    if (!raw) return null;
    if (raw.includes('claim=')) {
      try {
        const u = new URL(raw, 'http://local.invalid');
        raw = u.searchParams.get('claim') || raw;
      } catch { /* keep */ }
    }
    return decodeClaimQr(raw);
  }
  if (body.payload && typeof body.payload === 'object') return body.payload;
  if (body.site && body.device && body.claim && body.sig) {
    return {
      v: body.v ?? 1,
      site: body.site,
      device: body.device,
      claim: body.claim,
      sig: body.sig,
    };
  }
  return null;
}

export function verifyGatewayIdentity(db, body) {
  const decoded = extractClaimPayload(body);
  if (!decoded) return { error: 'invalid_claim_payload', status: 400 };
  const verified = verifyClaimSignature(decoded);
  if (verified.error) return verified;

  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?')
    .get(verified.site, verified.device);
  if (!row) return { error: 'unknown_device', status: 404 };
  if (row.claim_hash !== hashClaimSecret(verified.claim)) {
    return { error: 'invalid_claim_secret', status: 401 };
  }
  return { ok: true, site: verified.site, device: verified.device, hardware: row, claim: verified.claim };
}

function childFields(typeId) {
  const t = getDeviceType(typeId);
  return [...new Set((t?.widgets || []).map((w) => w.bind).filter(Boolean))];
}

/** Pack + type server-side từ hardware (type không đưa xuống gateway publish). */
export function seedFromHardware(hw) {
  const meta = parseUiMeta(hw.ui_meta);
  const configRev = Number(meta?.configRev) || 1;
  const seeds = Array.isArray(meta?.seed) ? meta.seed : null;
  const children = [];

  if (seeds?.length) {
    for (const s of seeds) {
      const id = String(s.childId || s.id || '').trim();
      if (!id || !/^[a-zA-Z0-9_-]{1,48}$/.test(id)) continue;
      const type = resolveDeviceTypeId(s.type || s.profile) || 'generic';
      children.push({
        id,
        type,
        title: s.title ? String(s.title).slice(0, 120) : null,
        fields: type === 'dynamic' && Array.isArray(s.fields)
          ? s.fields.map((k) => String(k)).filter((k) => /^[A-Za-z0-9_]{1,32}$/.test(k)).slice(0, 32)
          : childFields(type),
        limits: normalizeLimits(s.limits),
      });
    }
  } else {
    const type = resolveDeviceTypeId(hw.profile) || 'generic';
    if (type !== 'iot-hub') {
      children.push({
        id: hw.device,
        type,
        title: hw.label || null,
        fields: childFields(type),
        limits: normalizeLimits(meta?.limits),
      });
    }
  }

  return { children, configRev, meta };
}

export function ensureMqttForHardware(db, { site, device, profile, rotate = false } = {}) {
  ensureDefaultTenant(db);
  return provisionDevice(db, DEFAULT_TENANT, {
    site,
    device,
    profile: controlProfileForHardware(profile),
  }, { rotate: Boolean(rotate), actor: 'hardware' });
}

function publicBaseUrl() {
  return (process.env.WEBAPP_PUBLIC_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

function mqttPortOf(mqtt) {
  if (Number.isFinite(Number(mqtt?.port))) return Number(mqtt.port);
  const url = String(mqtt?.mqtts || '');
  const m = url.match(/:(\d+)\s*$/);
  if (m) return Number(m[1]);
  return Number(process.env.MQTT_PUBLIC_MQTTS_PORT || process.env.PUB_PORT_MQTTS || 8883);
}

function payloadExample(children) {
  const d = {};
  for (const c of children) {
    const sample = {};
    for (const f of c.fields || []) sample[f] = 0;
    if (!Object.keys(sample).length) sample.v = 0;
    d[c.id] = sample;
  }
  return { schema: 2, d };
}

function buildGatewayKit(db, hw, mqttResult, { includePassword = true } = {}) {
  const { children, configRev } = seedFromHardware(hw);
  const site = hw.site;
  const device = hw.device;
  const tenant = getTenant(db, DEFAULT_TENANT);
  // Topic dùng id MQTT NGẪU NHIÊN do server cấp (lưu trong devices.mqtt_id), không chứa tên site/device
  const mqttId = mqttResult?.device?.mqttId;
  const base = mqttResult?.device?.topicBase;
  const endpoints = mqttPublicEndpoints();
  const mqtt = mqttResult?.mqtt ? { ...mqttResult.mqtt } : { ...endpoints, useTls: true };
  if (!includePassword) delete mqtt.password;

  const port = mqttPortOf(mqtt);
  const topics = {
    telemetry: `${base}/telemetry`,
    status: `${base}/status`,
    cmd: `${base}/cmd`,
    ack: `${base}/ack`,
    config: `${base}/config`,
    history: `${base}/history`,
  };
  const role = resolveDeviceTypeId(hw.profile) === 'iot-hub' || children.length > 1 ? 'hub' : 'leaf';
  // limits: khoảng giá trị mỗi trường do tem đặt — gateway tự kiểm lại trước khi ghi xuống PLC (phòng thủ nhiều lớp)
  const pack = children.map(({ id, fields, limits }) => ({
    id, fields: fields || [], ...(limits && Object.keys(limits).length ? { limits } : {}),
  }));
  const baseUrl = publicBaseUrl();

  return {
    ok: true,
    site,
    device,
    label: hw.label || null,
    profile: hw.profile || null,
    role,
    schema: 2,
    configRev,
    mqttId,
    topicBase: base,
    topics,
    pack,
    payloadExample: payloadExample(children),
    mqtt: {
      ...mqtt,
      host: mqtt.host || null,
      port,
      tls: true,
    },
    tenantId: tenant?.id || DEFAULT_TENANT,
    enroll: {
      url: baseUrl ? `${baseUrl}/api/v1/gateway/enroll` : '/api/v1/gateway/enroll',
      configUrl: baseUrl ? `${baseUrl}/api/v1/gateway/config` : '/api/v1/gateway/config',
    },
  };
}

export function enrollGateway(db, body = {}, opts = {}) {
  const id = verifyGatewayIdentity(db, body);
  if (id.error) return id;

  // Gateway có internet: gắn máy lần đầu (hw = ID máy / vân tay PC). Máy khác dùng lại tem → 409.
  const bind = bindGatewayHardware(db, {
    site: id.site, device: id.device, hw: body.hw,
    required: process.env.ENROLL_REQUIRE_HW === '1',
  });
  if (bind.error) return bind;

  const rotateMqtt = Boolean(opts.rotateMqtt ?? body.rotateMqtt);
  const includePassword = opts.includePassword !== false;

  const mqttResult = ensureMqttForHardware(db, {
    site: id.site,
    device: id.device,
    profile: id.hardware.profile,
    rotate: rotateMqtt,
  });
  if (mqttResult.error) return mqttResult;

  return { ...buildGatewayKit(db, id.hardware, mqttResult, { includePassword }), activated: bind.bound };
}

export function attachGatewayBundle(db, hwResult, { rotateMqtt = false, includePassword = false } = {}) {
  if (!hwResult || hwResult.error) return hwResult;
  const hwRow = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?')
    .get(hwResult.site, hwResult.device);
  const profile = hwResult.profile || hwRow?.profile;
  const mqttResult = ensureMqttForHardware(db, {
    site: hwResult.site,
    device: hwResult.device,
    profile,
    rotate: rotateMqtt,
  });
  if (mqttResult.error) {
    return { ...hwResult, gatewayError: mqttResult };
  }
  const gateway = buildGatewayKit(db, hwRow || {
    site: hwResult.site,
    device: hwResult.device,
    label: hwResult.label,
    profile,
    ui_meta: hwResult.uiMeta ? JSON.stringify(hwResult.uiMeta) : null,
  }, mqttResult, { includePassword });
  return {
    ...hwResult,
    gateway: {
      ...gateway,
      enrollBody: hwResult.qr ? { qr: hwResult.qr } : undefined,
    },
  };
}

export function mountGatewayEnroll(app, { db } = {}) {
  const limit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_GATEWAY_ENROLL || 20),
    keyFn: (req) => `${clientIp(req)}:gw-enroll`,
  });

  const send = (res, r) => {
    if (r?.error) return res.status(r.status || 400).json(r);
    return res.json(r);
  };

  app.post('/api/v1/gateway/enroll', limit, (req, res) => {
    const r = enrollGateway(db, req.body || {}, {
      rotateMqtt: Boolean(req.body?.rotateMqtt),
      includePassword: true,
    });
    if (!r.error) {
      audit(db, 'gateway_enroll', {
        ip: clientIp(req),
        detail: `${r.site}/${r.device}`,
      });
    }
    send(res, r);
  });

  // Ghép cặp bằng mã do admin phát. Giới hạn theo IP rồi toàn cục; mã sai trả lỗi chung, không ghi DB.
  const pairIp = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_GATEWAY_PAIR || 10),
    keyFn: (req) => `${clientIp(req)}:gw-pair`,
  });
  const pairAll = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_GATEWAY_PAIR_GLOBAL || 120),
    keyFn: () => 'gw-pair:global',
  });
  app.post('/api/v1/gateway/pair', pairIp, pairAll, (req, res) => {
    const r = submitPairing(db, req.body || {});
    if (r.ok) audit(db, 'gateway_pair_submit', { ip: clientIp(req), detail: `${r.id} devices=${r.devices}` });
    send(res, r);
  });

  app.post('/api/v1/gateway/config', limit, (req, res) => {
    const includePassword = Boolean(req.body?.includeCredentials);
    const r = enrollGateway(db, req.body || {}, {
      rotateMqtt: false,
      includePassword,
    });
    send(res, r);
  });
}
