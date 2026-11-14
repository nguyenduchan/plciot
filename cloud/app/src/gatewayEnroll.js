/**
 * Gateway enroll — cấp MQTT + pack (id/fields) từ tem hardware.
 * Gateway chỉ gom/đóng gói số; type/UI ở server.
 *
 * POST /api/v1/gateway/enroll  → mqtt + topics + pack (+ password)
 * POST /api/v1/gateway/config  → pack/topics/configRev
 */
import { shardOf } from './shards.js';
import {
  decodeClaimQr, bindGatewayHardware, parseHardwareId, verifyClaimSignature, hashClaimSecret, rateLimit, clientIp, audit,
} from '@plciot/security';
import {
  DEFAULT_TENANT, mqttPublicEndpoints,
} from './contract.js';
import { ensureDefaultTenant, provisionDevice, getTenant } from './tenants.js';
import { getDeviceType, resolveDeviceTypeId } from './uiContract.js';
import { normalizeLimits } from './childControl.js';
import { submitPairing, pairingCodeValid } from './gatewayPairing.js';
import { verifyProof, requestMessage, ensureKeyColumns } from './gatewayKey.js';

/** Khoá theo dải mạng: IPv4 /24, IPv6 /64 (xấp xỉ theo 4 nhóm đầu). */
export function subnetOf(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (s.includes(':')) return s.split(':').slice(0, 4).join(':');
  return s.split('.').slice(0, 3).join('.');
}

function makeFailBudget(windowMs, max) {
  let hits = [];
  const prune = () => { const t = Date.now() - windowMs; hits = hits.filter((x) => x > t); };
  return {
    exceeded() { prune(); return hits.length >= max; },
    note() { prune(); hits.push(Date.now()); },
  };
}

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
    return { error: 'invalid_claim_secret', status: 401, site: verified.site, device: verified.device };
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
  const endpoints = mqttPublicEndpoints(shardOf(mqttId));   // nhiều nhóm broker: gateway nối đúng nhóm của nó
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
    // Tem chưa có user (chưa claim): gateway chỉ đồng bộ setting, KHÔNG gửi telemetry/history (server cũng bỏ nếu gửi)
    claimed: Boolean(hw.claimed_by),
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

/* ---------- Khoá tạm theo tem: kẻ cầm QR cũ / đoán hw không thử mãi được ---------- */
const ENROLL_FAIL_MAX = Number(process.env.ENROLL_FAIL_MAX || 10);
const ENROLL_FAIL_WINDOW_MS = Number(process.env.ENROLL_FAIL_WINDOW_MIN || 15) * 60_000;
const enrollFails = new Map();   // "site/device" → [timestamps]

function failsOf(key) {
  const t = Date.now() - ENROLL_FAIL_WINDOW_MS;
  const arr = (enrollFails.get(key) || []).filter((x) => x > t);
  if (arr.length) enrollFails.set(key, arr); else enrollFails.delete(key);
  return arr;
}
const noteEnrollFail = (key) => { const a = failsOf(key); a.push(Date.now()); enrollFails.set(key, a); if (enrollFails.size > 5000) enrollFails.delete(enrollFails.keys().next().value); };
export function resetEnrollFails() { enrollFails.clear(); }

export function enrollGateway(db, body = {}, opts = {}) {
  const fail = (err, site, device) => {
    if (site) noteEnrollFail(`${site}/${device}`);
    opts.onFail?.(err, site, device);
    return err;
  };
  const id = verifyGatewayIdentity(db, body);
  if (id.error) return id.site ? fail(id, id.site, id.device) : id;

  // Tem đã có KHOÁ CÔNG KHAI của gateway: bắt buộc chữ ký của khoá riêng (chỉ ảnh QR thì vô dụng). Tem cũ (không có khoá) dùng hw như trước.
  ensureKeyColumns(db);
  const pubkey = db.prepare('SELECT gw_pubkey FROM hardware_devices WHERE site = ? AND device = ?').get(id.site, id.device)?.gw_pubkey;
  let proven = false;
  if (pubkey) {
    if (opts.trusted === true) proven = true;
    else {
      proven = verifyProof(pubkey, requestMessage(opts.kind || 'enroll', id.site, id.device, body.ts), body.sig, body.ts);
      if (!proven) return fail({ error: 'proof_required', status: 401 }, id.site, id.device);
    }
    body = { ...body, hw: id.hardware.activated_hw };   // hw đã được khoá công khai chứng minh
  }
  // Tem đang bị khoá do quá nhiều lần sai: chỉ máy đã chứng minh (chữ ký hợp lệ) / đúng hw (tem cũ) mới qua — kẻ phá không khoá được gateway thật
  const key = `${id.site}/${id.device}`;
  const given = parseHardwareId(body.hw);
  const owner = id.hardware.activated_hw;
  if (failsOf(key).length >= ENROLL_FAIL_MAX && !(pubkey ? proven : (owner && given === owner))) {
    opts.onFail?.({ error: 'enroll_locked' }, id.site, id.device);
    return { error: 'enroll_locked', status: 429 };
  }

  // Gateway có internet: gắn máy lần đầu (hw = ID máy / vân tay PC). Máy khác dùng lại tem → 409.
  const bind = bindGatewayHardware(db, {
    site: id.site, device: id.device, hw: body.hw,
    required: process.env.ENROLL_REQUIRE_HW === '1',
  });
  if (bind.error) return fail(bind, id.site, id.device);

  // Xoay mật khẩu MQTT chỉ khi máy đã xác thực bằng hw (người chỉ có ảnh QR không được làm gateway thật rớt kết nối)
  const rotateMqtt = Boolean(opts.rotateMqtt ?? body.rotateMqtt) && (opts.trusted === true || bind.bound === true);
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

  // Mọi lần enroll/config thất bại đều để lại dấu vết (IP + tem + lý do) để phát hiện dò QR / hw
  let curReq = null;
  const auditEnrollFail = (err, site, device) => audit(db, 'gateway_enroll_fail', {
    ip: curReq ? clientIp(curReq) : undefined,
    detail: `${err.error}${site ? ` ${site}/${device}` : ''}`,
  });

  const send = (res, r) => {
    if (r?.error) return res.status(r.status || 400).json(r);
    return res.json(r);
  };

  app.post('/api/v1/gateway/enroll', limit, (req, res) => {
    curReq = req;
    const r = enrollGateway(db, req.body || {}, {
      rotateMqtt: Boolean(req.body?.rotateMqtt),
      includePassword: true,
      onFail: auditEnrollFail,
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
  // Cùng dải /24 (IPv4) hoặc /64 (IPv6): chặn botnet cùng nhà mạng xoay IP
  const pairNet = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_GATEWAY_PAIR_NET || 40),
    keyFn: (req) => `${subnetOf(clientIp(req))}:gw-pair-net`,
  });
  // Ngân sách LẦN THẤT BẠI toàn cục: hết ngân sách chỉ chặn mã sai; mã hợp lệ vẫn đi qua (kẻ phá không khoá được người lắp đặt thật)
  const failBudget = makeFailBudget(60_000, Number(process.env.RATE_LIMIT_GATEWAY_PAIR_FAIL_GLOBAL || 120));
  app.post('/api/v1/gateway/pair', pairIp, pairNet, (req, res) => {
    if (!pairingCodeValid(db, req.body?.code) && failBudget.exceeded()) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'rate_limited' });
    }
    const r = submitPairing(db, req.body || {});
    if (r.error === 'invalid_pairing') failBudget.note();
    if (r.ok) audit(db, 'gateway_pair_submit', { ip: clientIp(req), detail: `${r.id} devices=${r.devices}` });
    send(res, r);
  });

  app.post('/api/v1/gateway/config', limit, (req, res) => {
    curReq = req;
    const includePassword = Boolean(req.body?.includeCredentials);
    const r = enrollGateway(db, req.body || {}, {
      rotateMqtt: false,
      includePassword,
      kind: 'config',
      onFail: auditEnrollFail,
    });
    send(res, r);
  });
}
