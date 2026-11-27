/**
 * Gateway no-code (mua sẵn, chỉ cấu hình: Teltonika, Milesight, USR, Robustel…) — giám sát (giai đoạn 1) + điều khiển
 * theo kiểu lệnh của hãng khai trong ánh xạ (giai đoạn 4, hiện: usr_rw_prot — USR-M100, cùng họ USR).
 * Thiết kế: docs/NOCODE-GATEWAY.md.
 *
 *  gateway ──mqtts──▶ gw/<id>/raw (payload của hãng)
 *     ingest → onNocodeRaw: áp ánh xạ (nocodeMap.js) → server (user `ctl`) phát gw/<id>/telemetry {schema:2,d} (retain)
 *     → bản tin quay lại ingest như telemetry thường (lưu lịch sử, gói, webapp xem live) — không nhân đôi đường lưu.
 *  status: gateway đặt LWT "offline" trên gw/<id>/status; server phát "online" khi có raw, "offline" khi im lặng quá lâu.
 *  ACL: gateway no-code chỉ GHI raw + status (không ghi được telemetry/config, không đọc cmd), chỉ qua MQTTS.
 *
 * Tạo / ánh xạ / xoay mật khẩu: CHỈ trên GatewayApp (gateway PC đã đăng ký, ký bằng khoá máy) — webapp không có giao diện này.
 * Tạo → tem (hardware_devices, không khoá máy) + MQTT + claim luôn cho chủ của gateway PC; webapp thấy như mọi gateway.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { provisionHardwareDevice, deleteHardwareDevice, audit, clientIp, rateLimit } from '@plciot/security';
import { gatewayAuth } from './gatewayLogic.js';
import { sanitizeMap, applyMap, writePoint, renderCommand, parseReply } from './nocodeMap.js';
import { applyGatewayConfig, getGatewayConfig } from './gatewayConfig.js';
import { ensureMqttForHardware } from './gatewayEnroll.js';
import { revokeDevice } from './tenants.js';
import { userGatewayLimit, gatewayIdFor } from './gatewayPairing.js';
import { setGatewayName, cleanName } from './gatewayNames.js';
import { addDeviceFromQr } from './userDevices.js';
import { rebuildAclFromUsers, reloadMosquitto } from './mqttProvision.js';
import { publishAsServer, setCmdInterceptor } from './controlPublisher.js';
import { deviceByMqttId } from './mqttIds.js';
import { mqttPublicEndpoints, topicBase, DEFAULT_TENANT } from './contract.js';
import { shardOf } from './shards.js';

const LIVE_REPUBLISH_MS = Number(process.env.NOCODE_REPUBLISH_MS || 10_000);   // giá trị không đổi: phát lại tối đa mỗi 10 s
const OFFLINE_MIN_MS = Number(process.env.NOCODE_OFFLINE_MIN_MS || 90_000);
const RATE_PER_MIN = Number(process.env.NOCODE_RAW_PER_MIN || 120);
const BACKFILL_AFTER_MS = 60_000;
const MAX_RAW_KEEP = 16384;

/* ---------------- DB ---------------- */

const migrated = new WeakSet();
export function migrateNocode(db) {
  if (migrated.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS nocode_gateways (
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      owner_id INTEGER,
      map_json TEXT,
      map_rev INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site, device)
    );
  `);
  // Gateway PC (GatewayApp) đã tạo + quản lý gateway no-code này (cài đặt chỉ qua GatewayApp, ký bằng khoá máy của gateway PC)
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('nocode_gateways')").all().map((c) => c.name));
  if (!cols.has('parent_site')) db.exec('ALTER TABLE nocode_gateways ADD COLUMN parent_site TEXT');
  if (!cols.has('parent_device')) db.exec('ALTER TABLE nocode_gateways ADD COLUMN parent_device TEXT');
  migrated.add(db);
}

/** Cache theo mqttId: { site, device, map } | null. Xoá khi lưu map / tạo / xoá. */
const gwCache = new Map();
export function clearNocodeCache() { gwCache.clear(); }
function gatewayByMqttId(db, mqttId, site, device) {
  const hit = gwCache.get(mqttId);
  if (hit !== undefined && Date.now() - hit.at < 30_000) return hit.v;
  let v = null;
  try {
    migrateNocode(db);
    const r = db.prepare('SELECT site, device, map_json, map_rev FROM nocode_gateways WHERE site = ? AND device = ?').get(site, device);
    if (r) {
      let map = null;
      try { map = r.map_json ? JSON.parse(r.map_json) : null; } catch { map = null; }
      v = { site: r.site, device: r.device, map, rev: r.map_rev };
    }
  } catch { v = null; }
  if (gwCache.size > 5000) gwCache.clear();
  gwCache.set(mqttId, { v, at: Date.now() });
  return v;
}

/* ---------------- Ingest: raw → telemetry, status ---------------- */

let publish = publishAsServer;
/** Test: thay đường phát (mặc định publishAsServer). */
export function setNocodePublisher(fn) { publish = fn || publishAsServer; }

const state = new Map();   // mqttId → { lastRaw, rawText, gaps[], status, lastPub, lastPubAt, bucket, bucketAt, bad[] }
const startedAt = Date.now();
function st(id) {
  let s = state.get(id);
  if (!s) { s = { gaps: [], bucket: RATE_PER_MIN, bucketAt: Date.now(), bad: [] }; state.set(id, s); }
  return s;
}
const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const offlineAfter = (s) => Math.max(OFFLINE_MIN_MS, 3 * median(s.gaps));

function send(mqttId, kind, payload, opts) {
  Promise.resolve().then(() => publish(mqttId, kind, payload, opts)).catch((e) => console.error(`[nocode] publish ${kind}`, e.message));
}

/**
 * Bản tin gw/<id>/raw. Chỉ gateway no-code mới có quyền ghi raw (ACL), nhưng vẫn kiểm lại ở đây.
 * @returns {{ ok:boolean, reason?:string, d?:object }}
 */
export function onNocodeRaw(db, parsed, buf, now = Date.now()) {
  const gw = gatewayByMqttId(db, parsed.mqttId, parsed.site, parsed.device);
  if (!gw) return { ok: false, reason: 'not_nocode' };
  const s = st(parsed.mqttId);
  // Chống dồn: token bucket theo phút
  s.bucket = Math.min(RATE_PER_MIN, s.bucket + ((now - s.bucketAt) / 60_000) * RATE_PER_MIN);
  s.bucketAt = now;
  if (s.bucket < 1) return { ok: false, reason: 'rate_limited' };
  s.bucket -= 1;

  const text = buf.toString();
  if (s.lastRaw) { s.gaps.push(now - s.lastRaw); if (s.gaps.length > 20) s.gaps.shift(); }
  s.lastRaw = now;
  s.rawText = text.slice(0, MAX_RAW_KEEP);   // chủ trạm xem "bản tin gần nhất" để soạn ánh xạ (chỉ bộ nhớ, không lưu DB)
  if (s.status !== 'online') { s.status = 'online'; send(parsed.mqttId, 'status', 'online', { retain: true }); }

  let payload;
  try { payload = JSON.parse(text); } catch { s.bad = ['(không phải JSON)']; return { ok: false, reason: 'invalid_json' }; }
  if (!gw.map?.devices?.length) return { ok: true, d: {} };   // chưa có ánh xạ: chỉ giữ bản tin để chủ trạm soạn
  const r = applyMap(gw.map, payload);
  s.bad = r.bad.slice(0, 50);
  if (!r.n) return { ok: false, reason: 'no_fields' };

  if (r.ts !== undefined && now - r.ts > BACKFILL_AFTER_MS) {
    // Gateway gửi bù dữ liệu cũ (có mốc thời gian): đi đường bù của ingest (backfill.js), không retain, không đụng live
    send(parsed.mqttId, 'telemetry', { schema: 2, bf: 1, ts: r.ts, d: r.d }, { retain: false });
    return { ok: true, d: r.d, backfill: true };
  }
  const sig = JSON.stringify(r.d);
  if (sig === s.lastPub && now - (s.lastPubAt || 0) < LIVE_REPUBLISH_MS) return { ok: true, d: r.d, skipped: true };
  s.lastPub = sig; s.lastPubAt = now;
  send(parsed.mqttId, 'telemetry', { schema: 2, ts: now, d: r.d }, { retain: true });
  return { ok: true, d: r.d };
}

/** Trạng thái đi qua broker (LWT của gateway, bản retain lúc server khởi động, hoặc chính server phát). */
export function onNocodeStatus(db, parsed, text) {
  if (!gatewayByMqttId(db, parsed.mqttId, parsed.site, parsed.device)) return;
  st(parsed.mqttId).status = String(text).trim();
}

/** Gateway im lặng quá lâu (mất điện/mạng mà LWT không tới) → server phát offline. Gọi định kỳ. */
export function sweepNocodeOffline(now = Date.now()) {
  let n = 0;
  for (const [id, s] of state) {
    if (s.status !== 'online') continue;
    if (now - (s.lastRaw || startedAt) > offlineAfter(s)) {
      s.status = 'offline';
      send(id, 'status', 'offline', { retain: true });
      n += 1;
    }
  }
  return n;
}
export function startNocodeSweep() {
  const t = setInterval(() => sweepNocodeOffline(), 15_000);
  t.unref?.();
  return t;
}
export function resetNocodeState() {
  state.clear(); gwCache.clear();
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
}

/* ---------------- Điều khiển (giai đoạn 4) ----------------
 * Lệnh đã qua /api/control/cmd (step-up, limits, toggleGuard) → publishCmd → chặn ở đây (setCmdInterceptor):
 * dịch { id, child, key, v } sang bản tin của hãng (nocodeMap.renderCommand) → ctl gửi gw/<id>/cmdraw, QoS 0, KHÔNG retain
 * (gateway mất mạng không nhận lại lệnh cũ). Phản hồi của hãng trên gw/<id>/ackraw → ack chuẩn gw/<id>/ack cho webapp;
 * không phản hồi trong control.timeoutMs → ack { ok:false, err:"no_confirm" }. Lệnh KHÔNG ký: gateway của hãng không kiểm được.
 */
const pending = new Map();   // `${mqttId}|${id}` → { timer, at, mqttId, id }
const PENDING_MAX = 5000;
const pendingKey = (mqttId, id) => `${mqttId}|${id}`;
const ackOut = (mqttId, ack) => send(mqttId, 'ack', ack, { retain: false });

/** @returns kết quả (đã xử lý: lệnh đi cmdraw hoặc bị từ chối bằng ack lỗi) hoặc null (không phải gateway no-code). */
export async function handleNocodeCmd(db, mqttId, payload) {
  const dev = deviceByMqttId(db, mqttId);
  if (!dev) return null;
  const gw = gatewayByMqttId(db, mqttId, dev.site, dev.device);
  if (!gw) return null;
  if (payload?.sys) return { topic: null, skipped: 'sys' };   // lệnh hệ thống (vd. "claimed") không áp dụng cho gateway của hãng
  const id = /^[A-Za-z0-9]{1,16}$/.test(String(payload?.id || '')) ? String(payload.id) : crypto.randomBytes(5).toString('hex');
  const fail = (err) => { ackOut(mqttId, { id, ok: false, err }); return { topic: null, rejected: err }; };
  const control = gw.map?.control;
  if (!control) return fail('control_disabled');
  if (payload.op === 'read' || payload.child == null || payload.key == null) return fail('not_supported');
  const point = writePoint(gw.map, String(payload.child), String(payload.key));
  if (!point) return fail('not_writable');
  const msg = renderCommand(control, { id, point, v: payload.v });
  if (!msg) return fail('not_supported');
  if (pending.size >= PENDING_MAX) return fail('busy');
  const k = pendingKey(mqttId, id);
  const timer = setTimeout(() => { if (pending.delete(k)) ackOut(mqttId, { id, ok: false, err: 'no_confirm' }); }, control.timeoutMs);
  timer.unref?.();
  pending.set(k, { timer, at: Date.now(), mqttId, id });
  try {
    await publish(mqttId, 'cmdraw', msg, { retain: false, qos: 0 });
  } catch (e) {
    clearTimeout(timer); pending.delete(k);
    throw e;   // nơi gọi trả mqtt_unavailable như lệnh thường
  }
  return { topic: `${topicBase({ mqttId })}/cmdraw`, nocode: true };
}

/** Phản hồi lệnh của hãng (gw/<id>/ackraw) → ack chuẩn. */
export function onNocodeAckRaw(db, parsed, buf) {
  const gw = gatewayByMqttId(db, parsed.mqttId, parsed.site, parsed.device);
  if (!gw?.map?.control) return { ok: false, reason: 'not_nocode' };
  let payload;
  try { payload = JSON.parse(buf.toString()); } catch { return { ok: false, reason: 'invalid_json' }; }
  const r = parseReply(gw.map.control, payload);
  if (!r) return { ok: false, reason: 'bad_reply' };
  let k = r.id ? pendingKey(parsed.mqttId, r.id) : null;
  if (!k) {
    // Lỗi giao thức của hãng không kèm id: gán cho lệnh CŨ NHẤT đang chờ của gateway này
    let oldest = null;
    for (const [key, p] of pending) if (p.mqttId === parsed.mqttId && (!oldest || p.at < oldest.at)) oldest = { key, at: p.at };
    k = oldest?.key || null;
  }
  const p = k ? pending.get(k) : null;
  if (!p) return { ok: false, reason: 'unknown_id' };
  clearTimeout(p.timer); pending.delete(k);
  ackOut(parsed.mqttId, r.ok ? { id: p.id, ok: true } : { id: p.id, ok: false, err: r.err });
  return { ok: true, id: p.id, accepted: r.ok };
}

/* ---------------- Tạo / xem / ánh xạ / xoay mật khẩu ---------------- */

const ownedCount = (db, userId) => db.prepare('SELECT COUNT(*) AS n FROM hardware_devices WHERE claimed_by = ?').get(userId).n;

/**
 * ctx = { user, parent: { site, device } }: chủ trạm (chủ của gateway PC) + gateway PC đang gọi (đã xác thực chữ ký).
 * Chỉ gateway PC đã TẠO gateway no-code mới quản lý được nó, và chủ phải còn là chủ của nó.
 */
function ownRow(db, ctx, device) {
  migrateNocode(db);
  const r = db.prepare(`SELECT n.*, h.claimed_by, d.mqtt_id, d.mqtt_user FROM nocode_gateways n
    JOIN hardware_devices h ON h.site = n.site AND h.device = n.device
    LEFT JOIN devices d ON d.site = n.site AND d.device = n.device AND d.tenant_id = ?
    WHERE n.site = ? AND n.device = ?`).get(DEFAULT_TENANT, `u${ctx.user.id}`, String(device));
  if (!r || r.claimed_by !== ctx.user.id) return null;
  if (r.parent_site !== ctx.parent?.site || r.parent_device !== ctx.parent?.device) return null;
  return r;
}

/** File CA của broker (chứng chỉ MQTTS, chỉ phần CERTIFICATE) để gateway nạp khi chứng chỉ là tự ký. */
export function brokerCaPem() {
  const f = process.env.MQTT_PUBLIC_CA_FILE || path.join(process.env.DATA_DIR || './data', 'mqtt-ca.crt');
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const certs = txt.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);   // tuyệt đối không trả khoá riêng nếu file lỡ chứa
    return certs ? certs.join('\n') + '\n' : null;
  } catch { return null; }
}

/** Phiếu cấu hình hiển thị cho chủ trạm (mật khẩu chỉ có khi vừa tạo/xoay). */
function sheet(mqttId, mqttUser, password) {
  const ep = mqttPublicEndpoints(shardOf(mqttId));
  const m = /^mqtts:\/\/([^:/]+):(\d+)/.exec(ep.mqtts || '');
  const base = topicBase({ mqttId });
  return {
    host: m ? m[1] : (ep.host || null),
    port: m ? Number(m[2]) : null,
    tls: true,
    tlsMin: '1.2',
    caUrl: brokerCaPem() ? '/api/nocode/ca.crt' : null,
    pinSha256: ep.pinSha256 || null,
    username: mqttUser,
    ...(password ? { password } : {}),
    clientId: `nc-${mqttId}`,
    topics: { publish: `${base}/raw`, status: `${base}/status`, cmd: `${base}/cmdraw`, reply: `${base}/ackraw` },
    lwt: { topic: `${base}/status`, payload: 'offline', retain: true, qos: 1 },
    payload: 'JSON bất kỳ của hãng (≤ 16 KB); ánh xạ sang thiết bị/field soạn trên GatewayApp',
  };
}

/**
 * Gateway PC tạo gateway no-code cho CHỦ của nó. Trả phiếu cấu hình kèm MẬT KHẨU (chỉ một lần).
 * @returns {{ ok, site, device, name, sheet } | { error, status }}
 */
export async function createNocodeGateway(db, ctx, { name, ip } = {}) {
  migrateNocode(db);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
  if (!u || u.disabled) return { error: 'unauthorized', status: 401 };
  if (String(u.role || '') === 'admin') return { error: 'admin_cannot_own', status: 403 };   // admin chỉ xem thử, không làm chủ gateway
  const limit = userGatewayLimit(u);
  if (ownedCount(db, u.id) >= limit) return { error: 'too_many_gateways', status: 429, limit };
  const label = cleanName(name) || 'Gateway mua sẵn';

  const site = `u${u.id}`;
  const hw = `nc${crypto.randomBytes(12).toString('hex')}`;   // không có khoá máy: mã "phần cứng" ngẫu nhiên, chỉ để cấp ID
  const device = gatewayIdFor(db, site, hw);
  if (!device) return { error: 'site_device_taken', status: 409 };
  const created = provisionHardwareDevice(db, { site, device, label, profile: 'iot-hub', uiMeta: { configRev: 1, nocode: true, seed: [] } });
  if (created.error) return created;
  const now = Date.now();
  const cleanup = (why) => {
    try { db.prepare('DELETE FROM nocode_gateways WHERE site = ? AND device = ?').run(site, device); } catch { /* bỏ qua */ }
    try { deleteHardwareDevice(db, { site, device, force: true }); } catch { /* bỏ qua */ }
    try { revokeDevice(db, DEFAULT_TENANT, site, device); } catch { /* chưa cấp MQTT */ }
    console.error('[nocode] tạo thất bại', why);
  };
  try {
    // Tem gắn sẵn mã "phần cứng" ngẫu nhiên: không ai enroll/lấy mật khẩu MQTT bằng ảnh QR được (không có khoá riêng)
    db.prepare('UPDATE hardware_devices SET activated_hw = ?, activated_at = ?, activations = 1 WHERE site = ? AND device = ?').run(hw, now, site, device);
    db.prepare(`INSERT INTO nocode_gateways (site, device, owner_id, map_json, map_rev, created_at, updated_at, parent_site, parent_device)
      VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`).run(site, device, u.id, now, now, ctx.parent.site, ctx.parent.device);
  } catch (e) { cleanup(e.message); return { error: 'create_failed', status: 500 }; }

  const mq = ensureMqttForHardware(db, { site, device, profile: 'iot-hub', rotate: true });   // ACL dựng lại sau khi đã có dòng nocode_gateways
  if (mq.error) { cleanup(mq.error); return { error: mq.error, status: mq.status || 500 }; }
  const claimed = await addDeviceFromQr(db, u, { qr: created.qr, ip });   // gắn vào tài khoản chủ → webapp thấy như mọi gateway
  if (claimed.error) { cleanup(claimed.error); return { error: claimed.error, status: claimed.status || 500 }; }
  try { setGatewayName(db, { site, device, name: label, userId: u.id }); } catch (e) { console.error('[nocode] name', e.message); }
  try { rebuildAclFromUsers(db); reloadMosquitto(); } catch (e) { console.error('[nocode] acl', e.message); }
  clearNocodeCache();
  audit(db, 'nocode_gateway_created', { userId: u.id, ip, detail: `${site}/${device} "${label}" qua gateway ${ctx.parent.site}/${ctx.parent.device}` });
  return { ok: true, site, device, name: label, sheet: sheet(mq.device.mqttId, mq.mqtt.username, mq.mqtt.password) };
}

export function listNocodeGateways(db, ctx) {
  migrateNocode(db);
  const rows = db.prepare(`SELECT n.site, n.device, n.map_rev, d.mqtt_id, g.name FROM nocode_gateways n
    JOIN hardware_devices h ON h.site = n.site AND h.device = n.device
    LEFT JOIN devices d ON d.site = n.site AND d.device = n.device AND d.tenant_id = ?
    LEFT JOIN gateway_names g ON g.site = n.site AND g.device = n.device
    WHERE h.claimed_by = ? AND n.parent_site = ? AND n.parent_device = ? ORDER BY n.created_at`)
    .all(DEFAULT_TENANT, ctx.user.id, ctx.parent.site, ctx.parent.device);
  return rows.map((r) => {
    const s = r.mqtt_id ? state.get(r.mqtt_id) : null;
    return { site: r.site, device: r.device, name: r.name || r.device, mapRev: r.map_rev, lastRawAt: s?.lastRaw || null, status: s?.status || null };
  });
}

export function getNocodeGateway(db, ctx, device) {
  const r = ownRow(db, ctx, device);
  if (!r) return { error: 'not_owner', status: 403 };
  const s = r.mqtt_id ? state.get(r.mqtt_id) : null;
  let map = null;
  try { map = r.map_json ? JSON.parse(r.map_json) : null; } catch { map = null; }
  return {
    ok: true, site: r.site, device: r.device, map, mapRev: r.map_rev,
    lastRaw: s?.rawText ? { text: s.rawText, at: s.lastRaw } : null,
    badFields: s?.bad || [],
    status: s?.status || null,
    sheet: r.mqtt_id ? sheet(r.mqtt_id, r.mqtt_user) : null,
  };
}

/** Xem thử: áp map lên bản tin (gửi kèm, hoặc bản gần nhất của gateway), không lưu. */
export function previewNocodeMap(db, ctx, device, { map, raw } = {}) {
  const r = ownRow(db, ctx, device);
  if (!r) return { error: 'not_owner', status: 403 };
  const clean = sanitizeMap(map);
  if (clean.error) return { ...clean, status: 400 };
  const text = typeof raw === 'string' && raw.trim() ? raw.slice(0, MAX_RAW_KEEP) : (r.mqtt_id ? state.get(r.mqtt_id)?.rawText : null);
  if (!text) return { error: 'no_raw_yet', status: 409 };
  let payload;
  try { payload = JSON.parse(text); } catch { return { error: 'raw_not_json', status: 400 }; }
  const out = applyMap(clean.map, payload);
  return { ok: true, d: out.d, bad: out.bad, ts: out.ts ?? null };
}

export async function saveNocodeMap(db, ctx, device, map, { ip } = {}) {
  const r = ownRow(db, ctx, device);
  if (!r) return { error: 'not_owner', status: 403 };
  const clean = sanitizeMap(map);
  if (clean.error) return { ...clean, status: 400 };
  const rev = (r.map_rev || 0) + 1;
  db.prepare('UPDATE nocode_gateways SET map_json = ?, map_rev = ?, updated_at = ? WHERE site = ? AND device = ?')
    .run(JSON.stringify(clean.map), rev, Date.now(), r.site, r.device);
  // Giao diện (thẻ/widget) sinh từ ánh xạ: áp ngay + phát retain lên <base>/config để webapp đang mở tự dựng lại
  const applied = applyGatewayConfig(db, { site: r.site, device: r.device, payload: clean.config });
  if (applied.error) return { error: applied.error, status: 400 };
  if (r.mqtt_id) {
    send(r.mqtt_id, 'config', { gw: r.device, devices: clean.config.devices }, { retain: true });
    const s = state.get(r.mqtt_id); if (s) { s.lastPub = null; s.bad = []; }
  }
  clearNocodeCache();
  audit(db, 'nocode_map', { userId: ctx.user.id, ip, detail: `${r.site}/${r.device} rev ${rev}: ${clean.map.devices.length} thiết bị${clean.map.control ? ', có điều khiển' : ''} (qua gateway ${ctx.parent.device})` });
  return { ok: true, rev, devices: clean.map.devices.length, control: Boolean(clean.map.control), config: getGatewayConfig(db, { site: r.site, device: r.device }) };
}

/** Xoay mật khẩu MQTT: gateway đang dùng mật khẩu cũ bị cắt; trả mật khẩu mới một lần. */
export function rotateNocodePassword(db, ctx, device, { ip } = {}) {
  const r = ownRow(db, ctx, device);
  if (!r) return { error: 'not_owner', status: 403 };
  const mq = ensureMqttForHardware(db, { site: r.site, device: r.device, profile: 'iot-hub', rotate: true });
  if (mq.error) return { error: mq.error, status: mq.status || 500 };
  audit(db, 'nocode_rotate', { userId: ctx.user.id, ip, detail: `${r.site}/${r.device} (qua gateway ${ctx.parent.device})` });
  return { ok: true, sheet: sheet(mq.device.mqttId, mq.mqtt.username, mq.mqtt.password) };
}

/* ---------------- Routes: CHỈ GatewayApp (gateway PC), ký bằng khoá máy ----------------
 * Cài đặt gateway no-code chỉ làm trên GatewayApp (webapp không có giao diện này). Mọi route nhận
 * { site, device, pubkey, ts, sig } của gateway PC; kind ký: "nocode-<op>" hoặc "nocode-<op>-<target>" (chữ ký gắn với
 * đúng gateway no-code đích). Chủ = người đang sở hữu gateway PC (hardware_devices.claimed_by).
 * Chặn thay đổi tại máy (mở khoá bằng mật khẩu gateway / đăng nhập webapp) do GatewayApp lo, như sửa cấu hình.
 */
const TARGET = /^[A-Za-z0-9_-]{1,48}$/;

/** Gateway (site, device) có phải gateway no-code không (thì không được làm "gateway PC" quản lý gateway khác). */
function isNocodeGateway(db, site, device) {
  try { return Boolean(db.prepare('SELECT 1 FROM nocode_gateways WHERE site = ? AND device = ?').get(site, device)); } catch { return false; }
}

/** Xác thực gateway PC (chữ ký khoá máy) → ctx { user: chủ, parent: { site, device } } | { error, status }. */
export function nocodeCaller(db, body, kind) {
  const g = gatewayAuth(db, body, kind);
  if (!g || isNocodeGateway(db, g.site, g.device)) return { error: 'not_allowed', status: 403 };
  const owner = db.prepare('SELECT u.* FROM hardware_devices h JOIN users u ON u.id = h.claimed_by WHERE h.site = ? AND h.device = ?').get(g.site, g.device);
  if (!owner || owner.disabled) return { error: 'gateway_unclaimed', status: 409 };
  return { user: owner, parent: { site: g.site, device: g.device } };
}

export function mountNocode(app, { db }) {
  migrateNocode(db);
  setCmdInterceptor((mqttId, payload) => handleNocodeCmd(db, mqttId, payload));   // lệnh tới gateway no-code đi cmdraw
  const reply = (res, r) => res.status(r.error ? (r.status || 400) : 200).json(r);
  const limit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => `${clientIp(req)}:gw-nocode` });

  app.get('/api/nocode/ca.crt', (_req, res) => {
    const pem = brokerCaPem();
    if (!pem) return res.status(404).json({ error: 'ca_not_configured' });
    res.type('application/x-pem-file').set('Content-Disposition', 'attachment; filename="plciot-mqtt-ca.crt"').send(pem);
  });
  app.post('/api/v1/gateway/nocode/list', limit, (req, res) => {
    const ctx = nocodeCaller(db, req.body, 'nocode-list');
    if (ctx.error) return reply(res, ctx);
    reply(res, { ok: true, gateways: listNocodeGateways(db, ctx), ca: Boolean(brokerCaPem()) });
  });
  app.post('/api/v1/gateway/nocode/create', limit, async (req, res) => {
    const ctx = nocodeCaller(db, req.body, 'nocode-create');
    if (ctx.error) return reply(res, ctx);
    reply(res, await createNocodeGateway(db, ctx, { name: req.body?.name, ip: clientIp(req) }));
  });
  for (const op of ['get', 'preview', 'map', 'rotate']) {
    app.post(`/api/v1/gateway/nocode/${op}`, limit, async (req, res) => {
      const t = String(req.body?.target || '');
      if (!TARGET.test(t)) return reply(res, { error: 'bad_request', status: 400 });
      const ctx = nocodeCaller(db, req.body, `nocode-${op}-${t}`);
      if (ctx.error) return reply(res, ctx);
      const ip = clientIp(req);
      if (op === 'get') return reply(res, getNocodeGateway(db, ctx, t));
      if (op === 'preview') return reply(res, previewNocodeMap(db, ctx, t, { map: req.body?.map, raw: req.body?.raw }));
      if (op === 'map') return reply(res, await saveNocodeMap(db, ctx, t, req.body?.map, { ip }));
      return reply(res, rotateNocodePassword(db, ctx, t, { ip }));
    });
  }
}
