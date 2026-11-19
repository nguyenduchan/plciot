/**
 * Gateway enroll — cấp MQTT + pack (id/fields) từ tem hardware.
 * Gateway chỉ gom/đóng gói số; type/UI ở server.
 *
 * POST /api/v1/gateway/enroll  → mqtt + topics + pack (+ password)
 * POST /api/v1/gateway/config  → pack/topics/configRev
 */
import { recordGatewayClient } from './gatewayUpdate.js';
import { shardOf } from './shards.js';
import { effectiveDays, defaultDays } from './retention.js';
import { planTelemetryMinMs, freeTelemetryMinMs, planStoreEveryMs, freePlan } from './entitlements.js';
import {
  decodeClaimQr, bindGatewayHardware, parseHardwareId, verifyClaimSignature, hashClaimSecret, rateLimit, clientIp, audit, getHardwareDeviceQr,
} from '@plciot/security';
import {
  DEFAULT_TENANT, mqttPublicEndpoints,
} from './contract.js';
import { ensureDefaultTenant, provisionDevice, getTenant } from './tenants.js';
import { getDeviceType, resolveDeviceTypeId } from './uiContract.js';
import { normalizeLimits } from './childControl.js';
import { verifyProof, requestMessage, ensureKeyColumns, parsePubkey } from './gatewayKey.js';
import { cmdPublicKey } from './cmdSign.js';
import { gatewaySolution, solutionUi, cleanSolution, setGatewaySolution } from './gatewaySolution.js';
import { isHwBlocked, hwOfPubkey, BLOCKED } from './hwBlock.js';

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
  const solution = gatewaySolution(db, hw.site, hw.device);   // giao diện gateway = giải pháp của webapp (mapping 1-1)
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
    solution,
    ...(solution && solutionUi(solution) ? { ui: solutionUi(solution) } : {}),   // giao diện gateway dạng dữ liệu (xem gatewaySolution.js)
    configRev,
    // Tem chưa có user (chưa claim): gateway chỉ đồng bộ setting, KHÔNG gửi telemetry/history (server cũng bỏ nếu gửi)
    claimed: Boolean(hw.claimed_by),
    // Gateway tự gửi chậm theo gói của chủ (ms giữa hai bản telemetry; 0 = không giới hạn). Chưa có chủ → mức gói miễn phí.
    telemetryMinMs: telemetryMinMsFor(db, hw),
    // Tốc độ gửi khi KHÔNG ai xem webapp = chu kỳ LƯU của gói (ms); có người xem thì gửi nhanh theo telemetryMinMs (server báo qua sys:'live')
    storeEveryMs: storeEveryMsFor(db, hw),
    // Số ngày cloud lưu data theo gói của chủ (0 = không giới hạn): gateway chỉ bù dữ liệu offline trong khoảng này (server cũng chặn)
    retentionDays: retentionDaysFor(db, hw),
    mqttId,
    // Khoá công khai của server: gateway kiểm chữ ký lệnh cloud (cmdSign.js) → không cần OTP riêng để nhận lệnh đã qua step-up
    cmdKey: cmdPublicKey(),
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

/** Chu kỳ lưu (ms) theo gói của chủ gateway; gateway gửi bằng tốc độ này khi không ai xem webapp. */
function storeEveryMsFor(db, hw) {
  try {
    const owner = hw.claimed_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(hw.claimed_by) : null;
    return owner ? planStoreEveryMs(owner) : Number(freePlan().storeEveryMs || 0);
  } catch { return 0; }
}

/** Khoảng cách tối thiểu giữa hai bản telemetry theo gói của chủ gateway (chưa claim → gói miễn phí). */
function telemetryMinMsFor(db, hw) {
  try {
    const owner = hw.claimed_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(hw.claimed_by) : null;
    return owner ? planTelemetryMinMs(owner) : freeTelemetryMinMs();
  } catch { return freeTelemetryMinMs(); }
}

/** Số ngày lưu theo gói của chủ gateway (0 = không giới hạn; chưa có chủ → mặc định). */
function retentionDaysFor(db, hw) {
  try {
    const owner = hw.claimed_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(hw.claimed_by) : null;
    const d = owner ? effectiveDays(owner) : defaultDays();
    return Number.isFinite(d) ? d : 0;
  } catch { return defaultDays(); }
}

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
  // Thiết bị báo MẤT TRỘM (admin khoá theo mã phần cứng): từ chối mọi enroll/config — board nhận mã này thì tự vào chế độ khoá
  if (isHwBlocked(db, body.hw, id.hardware.activated_hw, hwOfPubkey(pubkey))) return fail({ ...BLOCKED }, id.site, id.device);
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
  // Giải pháp (UI) do QUẢN TRỊ VIÊN gán và khoá: `body.solution` gateway báo lên bị bỏ qua. Gateway chỉ NHẬN giải pháp trong kit trả về.

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

/**
 * Gateway lấy lại QR HIỆN HÀNH của tem mình (tem được cấp lại QR / đổi khoá ký → QR cũ trên máy bị từ chối: invalid_claim_signature/secret).
 * Không cần QR cũ, không cần đăng nhập: chứng minh bằng KHOÁ RIÊNG của gateway, chữ ký "qr|<site>|<device>|<ts>".
 *  - Tem có khoá công khai: khoá gửi lên phải TRÙNG khoá đã lưu.
 *  - Tem cũ (chưa lưu khoá): hw của tem = 20 ký tự đầu SHA-256(khoá công khai) (gatewayKey.js) → khoá phải sinh ra đúng hw đã gắn;
 *    qua được thì GẮN luôn khoá công khai vào tem (nâng cấp lên xác thực bằng chữ ký, như tem mới).
 * Mọi lỗi trả cùng một mã (không lộ tem nào tồn tại / đã gắn máy nào).
 */
export function refreshGatewayQr(db, body = {}) {
  const bad = { error: 'not_allowed', status: 403 };
  const site = String(body.site || '').trim(); const device = String(body.device || '').trim();
  const pk = parsePubkey(body.pubkey);
  if (!site || !device || !pk) return bad;
  ensureKeyColumns(db);
  const row = db.prepare('SELECT site, device, activated_hw, gw_pubkey FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
  if (!row) return bad;
  const keyOk = row.gw_pubkey ? row.gw_pubkey === pk.spki : Boolean(row.activated_hw) && row.activated_hw === pk.hw;
  if (!keyOk || !verifyProof(body.pubkey, requestMessage('qr', site, device, body.ts), body.sig, body.ts)) return { ...bad, site, device };
  if (isHwBlocked(db, pk.hw)) return { ...BLOCKED, site, device };
  if (!row.gw_pubkey) db.prepare('UPDATE hardware_devices SET gw_pubkey = ? WHERE site = ? AND device = ? AND gw_pubkey IS NULL').run(pk.spki, site, device);
  const q = getHardwareDeviceQr(db, { site, device });
  if (q.error) return bad;
  return { ok: true, site, device, qr: q.qr, keyBound: !row.gw_pubkey };
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

  // Phần mềm gateway lấy danh sách giải pháp để người dùng CHỌN trên gateway (mỗi gateway đúng một loại UI)

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
    if (!r.error) recordGatewayClient(db, r.site, r.device, req.headers);
    send(res, r);
  });

  app.post('/api/v1/gateway/qr', limit, (req, res) => {
    curReq = req;
    const r = refreshGatewayQr(db, req.body || {});
    if (r.error) { if (r.site) noteEnrollFail(`${r.site}/${r.device}`); auditEnrollFail({ error: 'qr_refresh_denied' }, r.site, r.device); return res.status(r.status).json({ error: r.error }); }
    audit(db, 'gateway_qr_refresh', { ip: clientIp(req), detail: `${r.site}/${r.device}${r.keyBound ? ' +key' : ''}` });
    res.json({ ok: true, qr: r.qr });
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
    if (!r.error) recordGatewayClient(db, r.site, r.device, req.headers);
    send(res, r);
  });
}
