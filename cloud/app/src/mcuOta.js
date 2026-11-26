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

/** Loại gateway theo phiên bản gateway báo lên (board: "mcu-…"). */
const kindOf = (version) => (String(version || '').startsWith('mcu') ? 'mcu' : 'pc');

/** @param security giá trị của mountSecurityRoutes(): authorize(req) = cùng mức xác thực với lệnh điều khiển (Face ID / TOTP). */
export function mountMcuOta(app, { db, requireAuth, security, releasesDir }) {
  const { authorize } = security;
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
    const a = authorize(req);
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `ota_approve ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    notifyGateway(db, g.site, g.device, 'ota_allow', { ttl: OTA_WINDOW_SEC, by, ver: rel.version });
    audit(db, 'ota_approve', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} ${cl?.version || '?'} → ${rel.version} (${OTA_WINDOW_SEC / 60} phút)` });
    res.json({ ok: true, until: Date.now() + OTA_WINDOW_SEC * 1000, version: rel.version });
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
        WHERE (event IN ('ota_approve', 'logic_propose', 'logic_approve', 'logic_reject', 'logic_timer', 'radmin_rpc', 'radmin_consent_on', 'radmin_consent_off', 'gateway_lost_report'))
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
    res.json({
      site: g.site, device: g.device, kind, version: cl?.version || null, lastSeen: cl?.lastSeen || null,
      release: rel ? { version: rel.version, builtAt: rel.builtAt, notes: rel.notes } : null,
      updateAvailable: Boolean(rel && cl?.version && rel.version !== cl.version),
      events: events.slice(0, 100),
    });
  });
}
