/**
 * API cho tool nạp gateway (PC sản xuất, C# GatewayProvisioner).
 *
 *   POST /api/v1/factory/provision   (Bearer fac_… do admin cấp)
 *     body { site, device, request, profile?, label?, days? }
 *       request = mã yêu cầu gateway hiển thị (ID máy + mã thử thách 8 ký tự)
 *     → { qr, loginUrl, key, code, exp, activations }  — tool ghi tất cả vào gateway
 *
 *   Admin (trang quản trị): GET/POST/DELETE /api/admin/factory-tokens
 *     Token chỉ hiện MỘT lần lúc tạo; DB chỉ lưu băm. Thu hồi là hết hiệu lực ngay.
 */
import crypto from 'node:crypto';
import {
  rateLimit, clientIp, audit,
  provisionHardwareDevice, getHardwareDeviceQr, issueActivationCode, deriveDeviceKey,
} from '@plciot/security';
import { requireAdminNetwork } from './adminGate.js';
import { attachGatewayBundle } from './gatewayEnroll.js';
import { planFor, listKinds, buildLicenseFile, offlineBundle } from './gatewayKinds.js';

const SAFE = /^[a-zA-Z0-9_-]{1,48}$/;
const hashToken = (t) => crypto.createHash('sha256').update(`plciot-factory:${t}`).digest('hex');

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER
    );
  `);
}

export function mountFactoryApi(app, {
  db, requireAuth, requireAdmin, reauth, adminWrite,
}) {
  ensureTable(db);
  const gate = [requireAuth, requireAdmin];
  const writeGate = [...gate, requireAdminNetwork, adminWrite, reauth];

  /* ---------- admin quản lý token ---------- */
  app.get('/api/admin/factory-tokens', ...gate, (_req, res) => {
    const rows = db.prepare(`
      SELECT id, label, created_at, last_used_at, uses, revoked_at FROM factory_tokens ORDER BY id DESC
    `).all();
    res.json({
      tokens: rows.map((r) => ({
        id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at || null,
        uses: r.uses, revoked: Boolean(r.revoked_at),
      })),
    });
  });

  app.post('/api/admin/factory-tokens', ...writeGate, (req, res) => {
    const label = String(req.body?.label || '').trim().slice(0, 80);
    if (!label) return res.status(400).json({ error: 'invalid_label' });
    const token = `fac_${crypto.randomBytes(24).toString('base64url')}`;
    const r = db.prepare('INSERT INTO factory_tokens (label, token_hash, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(label, hashToken(token), req.user.id, Date.now());
    audit(db, 'factory_token_created', { userId: req.user.id, ip: clientIp(req), detail: `#${r.lastInsertRowid} ${label}` });
    res.json({ ok: true, id: Number(r.lastInsertRowid), label, token });
  });

  app.delete('/api/admin/factory-tokens/:id', ...writeGate, (req, res) => {
    const r = db.prepare('UPDATE factory_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'not_found' });
    audit(db, 'factory_token_revoked', { userId: req.user.id, ip: clientIp(req), detail: `#${req.params.id}` });
    res.json({ ok: true });
  });

  /** Cảnh báo nghi gateway bị chép (hai máy cùng ID) — xem dupDetect.js. */
  app.get('/api/admin/duplicate-suspects', ...gate, (_req, res) => {
    const rows = db.prepare(`
      SELECT ts, detail FROM audit_log WHERE event = 'device_duplicate_suspect' ORDER BY id DESC LIMIT 30
    `).all();
    res.json({ items: rows.map((r) => ({ ts: r.ts, detail: r.detail })) });
  });

  /** Bảng loại gateway × online/offline (tool nạp và trang admin dùng chung). */
  app.get('/api/v1/gateway/kinds', (_req, res) => res.json({ kinds: listKinds() }));

  /* ---------- tool nạp ---------- */
  const limit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_FACTORY || 60),
    keyFn: (req) => `${clientIp(req)}:factory`,
  });

  function factoryAuth(req, res, next) {
    const m = /^Bearer (fac_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization || ''));
    const row = m && db.prepare('SELECT * FROM factory_tokens WHERE token_hash = ?').get(hashToken(m[1]));
    if (!row || row.revoked_at) return res.status(401).json({ error: 'factory_token_invalid' });
    db.prepare('UPDATE factory_tokens SET last_used_at = ?, uses = uses + 1 WHERE id = ?').run(Date.now(), row.id);
    req.factoryToken = row;
    return next();
  }

  app.post('/api/v1/factory/provision', limit, factoryAuth, (req, res) => {
    const b = req.body || {};
    const site = String(b.site || '').trim();
    const device = String(b.device || '').trim();
    if (!SAFE.test(site) || !SAFE.test(device)) return res.status(400).json({ error: 'invalid_site_or_device' });

    // Tem: dùng lại nếu chưa ai gắn; tạo mới nếu chưa có. Không bao giờ thu hồi thiết bị đang dùng ở đây.
    const existing = db.prepare('SELECT claimed_by FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
    if (existing?.claimed_by) return res.status(409).json({ error: 'device_already_claimed' });
    let hw = existing ? getHardwareDeviceQr(db, { site, device }) : provisionHardwareDevice(db, {
      site, device, label: b.label, profile: b.profile || 'generic',
    });
    if (hw.error) return res.status(hw.status || 400).json(hw);

    // kind + connectivity (nếu có) quyết định cách kích hoạt; không có → hành vi cũ theo activate.
    const plan = b.kind ? planFor(b.kind, b.connectivity) : null;
    if (plan?.error) return res.status(plan.status).json(plan);
    // activate:false → gateway bán kèm cấu hình (MCU/mua sẵn): không mã kích hoạt, chỉ QR + kit MQTT.
    const wantActivation = plan ? ['challenge', 'license'].includes(plan.activation) : b.activate !== false;
    const actMode = plan ? plan.activation : (b.mode === 'license' ? 'license' : 'challenge');
    let act = null;
    let hwId = null;
    if (wantActivation) {
      act = issueActivationCode(db, { site, device, request: b.request, days: b.days, mode: actMode });
      if (act.error) return res.status(act.status || 400).json(act);
      hwId = act.hw;
    } else if (b.request) {
      // ID máy (tuỳ chọn) chỉ để ghi nhật ký; chấp nhận cả "ID+nonce" hoặc riêng ID.
      hwId = String(b.request).toUpperCase().replace(/[\s-]/g, '').slice(0, 40) || null;
    }

    // Kit MQTT (topic + tài khoản). Không xoay mật khẩu: nạp lại cùng một máy giữ nguyên tài khoản.
    const bundled = attachGatewayBundle(db, hw, { rotateMqtt: false, includePassword: true });
    if (bundled.error || bundled.gatewayError) {
      return res.status(500).json({ error: 'provision_failed', detail: bundled.gatewayError?.error });
    }

    audit(db, 'factory_provision', {
      ip: clientIp(req),
      detail: `${site}/${device} hw=${hwId || '-'} token#${req.factoryToken.id} ${wantActivation ? `kích hoạt lần=${act.activations}` : 'không kích hoạt'}`,
    });
    const licenseFile = wantActivation && act.mode === 'license' ? buildLicenseFile(act, { site, device }) : null;
    return res.json({
      ok: true, site, device, hw: hwId,
      plan: plan ? { kind: plan.kind, connectivity: plan.connectivity, activation: plan.activation } : null,
      licenseFile,
      offline: plan?.offlineKit ? offlineBundle(db, site, device) : null,
      qr: hw.qr, loginUrl: hw.loginUrl,
      gateway: bundled.gateway,
      activation: wantActivation
        ? { key: deriveDeviceKey(act.hw), code: act.code, exp: act.exp, activations: act.activations }
        : null,
      createdNewTem: !existing,
    });
  });
}
