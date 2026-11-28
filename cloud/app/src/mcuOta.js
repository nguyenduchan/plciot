/**
 * Cập nhật firmware board Waveshare CÓ DUYỆT CỦA CHỦ TRẠM + "Lịch sử hệ thống" (minh bạch: ai đổi gì, lúc nào).
 *
 *   1. Nhà phát triển ký bản build (scripts/sign-mcu-firmware.js, khoá riêng NGOÀI repo) → releases/mcu/{manifest.json, firmware-<v>.bin}
 *      → sync-vps. Server KHÔNG ký firmware và không tự đẩy xuống board.
 *   2. Chủ trạm xem "Bản mới" trên webapp → bấm "Cho phép cập nhật" (Face ID / TOTP như lệnh điều khiển)
 *      → server gửi {sys:"ota_allow", ttl:900, by} (ký cmd1) → board mở cửa sổ 15 phút, tự tải /api/v1/mcu-firmware/download,
 *      kiểm chữ ký nhà phát triển (khoá gắn cứng trong firmware) + SHA-256, cài, tự quay về bản cũ nếu bản mới không chạy ổn.
 *   3. Mọi bước ghi nhật ký: server (audit_log: ota_approve, radmin_*), board (cảnh báo sec.* → mqtt_events kind alert).
 * Tải firmware công khai: file là chương trình đã ký, không chứa cấu hình/khoá; board không cài bản sai chữ ký.
 */
import fs from 'node:fs';
import path from 'node:path';
import { audit, clientIp, rateLimit } from '@plciot/security';
import { gatewaysOfUser } from './mqttIds.js';
import { notifyGateway } from './gatewayNotify.js';
import { queryEvents } from './historyStore.js';
import { signCmd } from './cmdSign.js';
import { withSchema, isValidMqttId } from './contract.js';
import { recordGatewayClient } from './gatewayUpdate.js';
import { publishSigned } from './controlPublisher.js';
import crypto from 'node:crypto';

export const OTA_WINDOW_SEC = 15 * 60;
const FILE_RE = /^firmware-[0-9A-Za-z._-]{1,32}\.bin$/;

/** Kênh phát hành: "" (chính thức, releases/mcu) | "dev" (bản thử cho board build dev, releases/mcu-dev — firmware dev tin thêm khoá ký dev). */
export const channelOf = (v) => (String(v || '') === 'dev' || /-dev$/.test(String(v || '')) ? 'dev' : '');

export function readMcuRelease(releasesDir, channel = '') {
  try {
    const dir = path.join(releasesDir, channel === 'dev' ? 'mcu-dev' : 'mcu');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!/^[0-9A-Za-z._-]{1,32}$/.test(String(m.version)) || !FILE_RE.test(String(m.file)) || !/^[0-9a-f]{64}$/.test(String(m.sha256)) || !m.sig) return null;
    const bin = path.join(dir, m.file);
    if (!fs.existsSync(bin)) return null;
    return { version: m.version, sha256: m.sha256, sig: String(m.sig), size: fs.statSync(bin).size, builtAt: m.builtAt || null, notes: String(m.notes || ''), bin };
  } catch { return null; }
}

// ------------------------------------------------------------------ firmware QUA MQTT (board: HTTPS hỏng mà MQTT vẫn nối)
// Board gửi gw/<mqttId>/fwq {q:"info",ch} | {q:"get",ch,ver,off,n}; server trả gw/<mqttId>/fw {t:"info",version,size,sha256,sig} |
// {t:"data",ver,off,z(base64)} | {t:"err",e}. Không cần duyệt ở đây: file đã công khai qua HTTPS; board chỉ CÀI khi chủ trạm đã cho phép
// (cửa sổ ota_allow) và chữ ký nhà phát triển + SHA-256 đúng. Chỉ server (user ctl) ghi được fw (ACL) — người khác không chen gói được.
export const FW_CHUNK_MAX = 8192;   // base64 ~11 KB < 16 KB/gói của broker
let s_releasesDir = null;
const fwRate = new Map();           // mqttId → { t, n } (≤ 100 yêu cầu / 10 s / board)
let binCache = { file: '', mtime: 0, buf: null };
function readBin(rel) {
  const st = fs.statSync(rel.bin);
  if (binCache.file !== rel.bin || binCache.mtime !== st.mtimeMs) binCache = { file: rel.bin, mtime: st.mtimeMs, buf: fs.readFileSync(rel.bin) };
  return binCache.buf;
}

/** Gọi từ mqttIngest khi có gw/<mqttId>/fwq. publish/releasesDir thay được trong test. */
export async function onFwRequest(db, mqttId, buf, { publish = publishSigned, releasesDir = s_releasesDir } = {}) {
  if (!releasesDir || !isValidMqttId(mqttId)) return;
  let q; try { q = JSON.parse(Buffer.from(buf).toString('utf8')); } catch { return; }
  const now = Date.now();
  const r = fwRate.get(mqttId) || { t: now, n: 0 };
  if (now - r.t > 10_000) { r.t = now; r.n = 0; }
  if (++r.n > 100) return;
  fwRate.set(mqttId, r);
  const dev = db.prepare('SELECT site, device FROM devices WHERE mqtt_id = ?').get(mqttId);
  if (!dev) return;
  const send = (o) => Promise.resolve(publish(mqttId, 'fw', JSON.stringify(o))).catch((e) => console.error('fw publish', e.message));
  // GIỜ cho board (không NTP bên thứ ba, không cần DNS): ký bằng khoá lệnh (cmd1, gắn mqttId), kèm nonce board vừa gửi → không phát lại được
  if (q?.q === 'time') {
    const n = String(q.n || '');
    if (!/^[0-9a-f]{16,64}$/.test(n)) return;
    const ms = Date.now();
    return Promise.resolve(publish(mqttId, 'fw', signCmd(mqttId, withSchema({ sys: 'time', ms, n, ts: ms })))).catch((e) => console.error('fw publish', e.message));
  }
  const rel = readMcuRelease(releasesDir, channelOf(q?.ch));
  if (!rel) return send({ t: 'err', e: 'no_release' });
  const key = `${dev.site}/${dev.device}`;
  if (q?.q === 'info') {
    if (!r.audited || now - r.audited > 600_000) {   // mỗi board ghi lịch sử tối đa 1 lần / 10 phút (board hỏi lại mỗi phút / mỗi 30 s khi kiểm tra sức khoẻ)
      r.audited = now;
      audit(db, 'ota_mqtt', { detail: `${key} hỏi firmware qua MQTT (HTTPS của board lỗi) → ${rel.version}` });
    }
    return send({ t: 'info', version: rel.version, size: rel.size, sha256: rel.sha256, sig: rel.sig });
  }
  if (q?.q === 'get') {
    if (String(q.ver || '') !== rel.version) return send({ t: 'err', e: 'version_changed' });
    const off = Number(q.off); const n = Math.min(Math.max(Number(q.n) || FW_CHUNK_MAX, 1), FW_CHUNK_MAX);
    if (!Number.isInteger(off) || off < 0 || off >= rel.size) return send({ t: 'err', e: 'bad_offset' });
    const chunk = readBin(rel).subarray(off, off + n);
    if (off + chunk.length >= rel.size) audit(db, 'ota_mqtt', { detail: `${key} đã nhận đủ firmware ${rel.version} qua MQTT (${rel.size} byte)` });
    return send({ t: 'data', ver: rel.version, off, z: chunk.toString('base64') });
  }
}

/** Loại gateway theo phiên bản gateway báo lên (board: "mcu-…"). */
const kindOf = (version) => (String(version || '').startsWith('mcu') ? 'mcu' : 'pc');

/** @param security giá trị của mountSecurityRoutes(): authorize(req) = cùng mức xác thực với lệnh điều khiển (Face ID / TOTP). */
export function mountMcuOta(app, { db, requireAuth, security, releasesDir }) {
  const { authorize } = security;
  s_releasesDir = releasesDir;
  const limit = rateLimit({ windowMs: 60_000, max: 20, keyFn: (req) => `${clientIp(req)}:ota:${req.user?.id || 'na'}` });
  const out = (res, st, b) => res.status(st).json(b);
  const mine = (req, gw) => gatewaysOfUser(db, req.user).find((g) => `${g.site}/${g.device}` === gw);

  app.get('/api/v1/mcu-firmware', (req, res) => {
    const r = readMcuRelease(releasesDir, channelOf(req.query.ch));
    if (!r) return out(res, 404, { error: 'no_release' });
    res.json({ version: r.version, size: r.size, sha256: r.sha256, sig: r.sig, builtAt: r.builtAt, notes: r.notes });
  });

  app.get('/api/v1/mcu-firmware/download', (req, res) => {
    const r = readMcuRelease(releasesDir, channelOf(req.query.ch));
    if (!r) return out(res, 404, { error: 'no_release' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(r.size));
    res.setHeader('Content-Disposition', `attachment; filename="firmware-${r.version}.bin"`);
    fs.createReadStream(r.bin).on('error', () => res.destroy()).pipe(res);
  });

  /** Chủ trạm cho phép cập nhật 15 phút. Thân: {gw:"site/device"}. */
  app.post('/api/v1/ota/approve', requireAuth, limit, async (req, res) => {
    const gw = typeof req.body?.gw === 'string' ? req.body.gw.trim() : '';
    const g = mine(req, gw);
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const cl = db.prepare('SELECT version FROM gateway_clients WHERE site = ? AND device = ?').get(g.site, g.device);
    if (kindOf(cl?.version) !== 'mcu') return out(res, 400, { error: 'not_mcu' });
    const rel = readMcuRelease(releasesDir, channelOf(cl?.version));   // board build dev ("…-dev") tải kênh dev
    if (!rel) return out(res, 404, { error: 'no_release' });
    if (cl?.version === rel.version) return out(res, 409, { error: 'already_latest', version: rel.version });   // webapp đã ẩn nút; chặn cả gọi thẳng API
    const a = authorize(req);
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `ota_approve ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    notifyGateway(db, g.site, g.device, 'ota_allow', { ttl: OTA_WINDOW_SEC, by, ver: rel.version });
    audit(db, 'ota_approve', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} ${cl?.version || '?'} → ${rel.version} (${OTA_WINDOW_SEC / 60} phút)` });
    res.json({ ok: true, until: Date.now() + OTA_WINDOW_SEC * 1000, version: rel.version });
  });

  /**
   * Chủ trạm KHỞI ĐỘNG LẠI board từ xa (gỡ kẹt: mạng/HTTPS hỏng, RAM phân mảnh…): {gw}. Cùng mức xác thực với lệnh điều khiển (Face ID /
   * TOTP). Server gửi {sys:"reboot", by, id} ký cmd1; board TẮT mọi DO rồi khởi động lại sau ~3 s, ghi sự kiện + cảnh báo đỏ.
   * Chỉ board Waveshare (gateway PC là máy tính — khởi động lại bằng cách khác).
   */
  app.post('/api/v1/gateway/reboot', requireAuth, limit, (req, res) => {
    const gw = typeof req.body?.gw === 'string' ? req.body.gw.trim() : '';
    const g = mine(req, gw);
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const cl = db.prepare('SELECT version FROM gateway_clients WHERE site = ? AND device = ?').get(g.site, g.device);
    if (kindOf(cl?.version) !== 'mcu') return out(res, 400, { error: 'not_mcu' });
    const a = authorize(req);
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `gateway_reboot ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    notifyGateway(db, g.site, g.device, 'reboot', { by, id: `rb-${crypto.randomBytes(6).toString('hex')}` });
    audit(db, 'gateway_reboot', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} (${cl?.version || '?'})` });
    res.json({ ok: true });
  });

  /**
   * Board là SLAVE của gateway PC (giữ lease → board tạm dừng MQTTS, không nhận được ota_allow): gateway PC hỏi thay.
   * Thân: { id: mqttId của board, nonce: mã dùng một lần board vừa cấp (GET /api/ota/nonce), version: bản board đang chạy }.
   * Chủ trạm đã cho phép (ota_approve trong 15 phút qua, ghi ở audit_log nên deploy lại không mất) → trả gói {sys:"ota_allow", ttl còn lại,
   * by, nonce} KÝ bằng khoá lệnh server (miền cmd1, gắn mqttId board). Gateway PC chỉ chuyển gói — không tự tạo được (không có khoá),
   * nonce chặn phát lại, board vẫn đòi chữ ký nhà phát triển trên firmware. Chưa cho phép → 404 not_approved (kèm thông tin bản mới).
   * Phiên bản board gửi kèm được ghi vào gateway_clients để webapp hiện "Bản mới" + nút cho phép cho board không tự lên cloud.
   */
  const relayLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `${clientIp(req)}:otarelay` });
  app.post('/api/v1/mcu-firmware/allow', relayLimit, (req, res) => {
    const id = String(req.body?.id || ''); const nonce = String(req.body?.nonce || ''); const ver = String(req.body?.version || '');
    if (!isValidMqttId(id) || !/^[0-9a-f]{16,64}$/.test(nonce)) return out(res, 400, { error: 'bad_request' });
    const dev = db.prepare('SELECT site, device FROM devices WHERE mqtt_id = ?').get(id);
    if (!dev) return out(res, 404, { error: 'unknown_gateway' });
    if (/^mcu-[0-9A-Za-z._-]{1,28}$/.test(ver)) recordGatewayClient(db, dev.site, dev.device, { 'x-gateway-version': ver });
    const rel = readMcuRelease(releasesDir, channelOf(ver));
    const release = rel ? { version: rel.version, size: rel.size, sha256: rel.sha256, sig: rel.sig } : null;
    const key = `${dev.site}/${dev.device}`;
    const ap = db.prepare("SELECT ts, user_id FROM audit_log WHERE event = 'ota_approve' AND detail LIKE ? ORDER BY ts DESC LIMIT 1").get(`${key} %`);
    const left = ap ? Math.floor((Number(ap.ts) + OTA_WINDOW_SEC * 1000 - Date.now()) / 1000) : 0;
    if (left < 30) return out(res, 404, { error: 'not_approved', release });
    const by = String(db.prepare('SELECT username FROM users WHERE id = ?').get(ap.user_id)?.username || 'chủ trạm').slice(0, 40);
    const packet = signCmd(id, withSchema({ sys: 'ota_allow', ttl: left, by, nonce, ts: Date.now() }));
    audit(db, 'ota_relay', { ip: clientIp(req), detail: `${key} ${ver || '?'} → ${release?.version || '?'} (qua gateway PC, còn ${Math.ceil(left / 60)} phút)` });
    res.json({ ok: true, packet, ttl: left, release });
  });

  /** Lịch sử hệ thống của một gateway (chủ xem): phiên bản, bản mới, sự kiện server + cảnh báo bảo mật của board. */
  app.get('/api/v1/system-history', requireAuth, (req, res) => {
    const gw = String(req.query.gw || '');
    const g = mine(req, gw);
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const cl = db.prepare('SELECT version, last_seen AS lastSeen FROM gateway_clients WHERE site = ? AND device = ?').get(g.site, g.device);
    const kind = kindOf(cl?.version);
    const rel = kind === 'mcu' ? readMcuRelease(releasesDir, channelOf(cl?.version)) : null;   // đúng kênh của board (dev / chính thức)
    const events = [];
    const key = `${g.site}/${g.device}`;
    for (const r of db.prepare(`SELECT ts, event, detail FROM audit_log
        WHERE (event IN ('ota_approve', 'ota_relay', 'ota_mqtt', 'gateway_reboot','logic_propose', 'logic_approve', 'logic_reject', 'logic_timer', 'radmin_rpc', 'radmin_consent_on', 'radmin_consent_off', 'gateway_lost_report'))
          AND (detail LIKE ? OR detail LIKE ?) ORDER BY ts DESC LIMIT 60`).all(`% ${key} %`, `%${key}%`)) {
      events.push({ ts: Number(r.ts), src: 'server', type: r.event, text: r.detail });
    }
    try {
      for (const e of queryEvents(db, { site: g.site, device: g.device, since: Date.now() - 90 * 86_400_000, until: Date.now() + 60_000, kinds: ['alert'], limit: 5000 })) {
        let a; try { a = JSON.parse(e.payload); } catch { continue; }
        if (!String(a?.k || '').startsWith('sec.')) continue;
        events.push({ ts: Number(e.ts), src: 'gateway', type: String(a.k).slice(4), text: String(a.txt || '').slice(0, 300), alert: true });
      }
    } catch { /* chưa có bảng lịch sử */ }
    events.sort((x, y) => y.ts - x.ts);
    const updateAvailable = Boolean(rel && cl?.version && rel.version !== cl.version);
    // Đã cho phép (≤ 15 phút) đúng bản mới này mà board chưa báo phiên bản mới → webapp hiện "đang chờ board cài", KHÔNG hiện lại nút duyệt
    let pending = null;
    if (updateAvailable) {
      const ap = db.prepare(`SELECT a.ts, a.detail, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.event = 'ota_approve' AND a.detail LIKE ? ORDER BY a.ts DESC LIMIT 1`).get(`${key} %`);
      const until = ap ? Number(ap.ts) + OTA_WINDOW_SEC * 1000 : 0;
      if (ap && until > Date.now() && String(ap.detail).includes(`→ ${rel.version} `)) pending = { at: Number(ap.ts), until, by: ap.username || '' };
    }
    res.json({
      site: g.site, device: g.device, kind, version: cl?.version || null, lastSeen: cl?.lastSeen || null,
      release: rel ? { version: rel.version, builtAt: rel.builtAt, notes: rel.notes } : null,
      updateAvailable, pending,
      events: events.slice(0, 100),
    });
  });
}
