/**
 * API vận hành: gói subscribe, thiết bị IoT, thống kê DB.
 * Chỉ admin; ghi cần reauth (caller gắn middleware).
 */
import { buildLicenseFile } from './gatewayKinds.js';
import { publicUser } from './adminUsers.js';
import { findUserById } from './db.js';
import {
  listPlans, grantPlan, setRemoteControl, grantTenantPlan, subscriptionInfo, PLAN_CATALOG,
} from './entitlements.js';
import {
  listTenants, getTenant, createTenant, rotateTenantKey, provisionDevice,
  listDevices, revokeDevice, publicTenant,
} from './tenants.js';
import { historyStats, queryLastTelemetry, queryLastEvent } from './historyStore.js';
import { contractInfo } from './contract.js';
import {
  audit, clientIp,
  listHardwareDevices, provisionHardwareDevice, getHardwareDeviceQr,
  reissueHardwareDeviceQr, updateHardwareDeviceMeta, deleteHardwareDevice,
  issueActivationCode, deriveDeviceKey, releaseGatewayHardware,
} from '@plciot/security';
import { attachGatewayBundle, bumpConfigRev, ensureMqttForHardware } from './gatewayEnroll.js';
import { createPairing, listPairings, getPairing, cancelPairing, approvePairing } from './gatewayPairing.js';
import { previewFromQr } from './userDevices.js';
import { retentionInfo } from './retention.js';
import { revokeDeviceBinding } from './sites.js';
import { notifyGateway } from './gatewayNotify.js';
import {
  listBlocks, createBlock, disableBlock, hardBlockDevice,
  listPolicyEvents, policyConfigPublic, peekRejectStats,
} from './policy.js';
import { requireAdminNetwork } from './adminGate.js';
import { homePcStatus, trustHomePc, revokeHomePc, deviceIdFromReq } from './homePc.js';
import { listOpsFlags, setOpsFlag, clearOpsFlag, isOpsOpen } from './opsFlags.js';
import { runDeploy, deployStatusFull } from './deploySync.js';

const SECURITY_EVENTS = [
  'login_ok', 'passkey_login_fail', 'passkey_fail', 'totp_fail', 'otp_fail',
  'control_denied', 'control_cmd', 'rate_limited',
  'policy_hard_block', 'policy_block_create', 'policy_block_disable',
  'ops_flag_enable', 'ops_flag_disable', 'ops_flag_reset',
  'admin_plan_grant', 'device_revoked', 'logout_all',
  'recovery_start', 'phone_change_unauthorised', 'pair_fail',
];

const ATTACK_HINT = [
  'passkey_login_fail', 'passkey_fail', 'totp_fail', 'otp_fail',
  'control_denied', 'pair_fail', 'phone_change_unauthorised',
  'rate_limited',
];

function enrichedUser(u) {
  return {
    ...publicUser(u),
    tenantId: u.tenant_id || 'default',
    mqttUser: u.mqtt_user || null,
    subscription: subscriptionInfo(u),
    ...retentionInfo(u),
  };
}

export function mountAdminOps(app, {
  db, requireAuth, requireAdmin, reauth, adminWrite,
  dataDir, shellDir,
}) {
  const gate = [requireAuth, requireAdmin];
  /** Ghi nhạy cảm (kích hoạt gói…): Passkey + giới hạn mạng admin */
  const writeGate = [...gate, requireAdminNetwork, adminWrite, reauth];
  const deployPaths = {
    dataDir: dataDir || process.env.DATA_DIR || './data',
    shellDir: shellDir || process.env.SHELL_DIR || './shell',
  };

  app.get('/api/admin/ops/overview', ...gate, (_req, res) => {
    const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const activeUsers = db.prepare('SELECT COUNT(*) n FROM users WHERE disabled = 0').get().n;
    const devices = db.prepare("SELECT COUNT(*) n FROM devices WHERE status = 'active'").get().n;
    const tenants = db.prepare('SELECT COUNT(*) n FROM tenants').get().n;
    const expired = db.prepare(`
      SELECT COUNT(*) n FROM users
      WHERE sub_expires_at IS NOT NULL AND sub_expires_at <= ?
    `).get(Date.now()).n;
    const hist = historyStats(db);
    res.json({
      users, activeUsers, devices, tenants, expiredPlans: expired,
      history: hist,
      plans: listPlans(),
      contract: contractInfo(),
      ingest: {
        requireKnown: String(process.env.INGEST_REQUIRE_KNOWN || 'true'),
        requireActiveSub: String(process.env.INGEST_REQUIRE_ACTIVE_SUB || 'true'),
      },
      flags: listOpsFlags(db),
    });
  });

  /* ---- Monitor server + tấn công + kill switches ---- */
  app.get('/api/admin/ops/monitor', ...gate, (_req, res) => {
    const now = Date.now();
    const day = now - 24 * 3600_000;
    const hour = now - 3600_000;
    const mem = process.memoryUsage();
    const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    const activeUsers = db.prepare('SELECT COUNT(*) n FROM users WHERE disabled = 0').get().n;
    const disabledUsers = db.prepare('SELECT COUNT(*) n FROM users WHERE disabled = 1').get().n;
    const devices = db.prepare("SELECT COUNT(*) n FROM devices WHERE status = 'active'").get().n;
    const blockedDev = db.prepare("SELECT COUNT(*) n FROM devices WHERE status = 'blocked'").get().n;
    const tenants = db.prepare('SELECT COUNT(*) n FROM tenants').get().n;
    const blocks = db.prepare('SELECT COUNT(*) n FROM policy_blocks WHERE enabled = 1').get().n;
    const denies24h = db.prepare('SELECT COUNT(*) n FROM policy_events WHERE action = ? AND ts >= ?')
      .get('deny', day).n;
    const denies1h = db.prepare('SELECT COUNT(*) n FROM policy_events WHERE action = ? AND ts >= ?')
      .get('deny', hour).n;
    const attackEvents = ATTACK_HINT;
    const placeholders = attackEvents.map(() => '?').join(',');
    const fails24h = db.prepare(
      `SELECT COUNT(*) n FROM audit_log WHERE ts >= ? AND event IN (${placeholders})`,
    ).get(day, ...attackEvents).n;
    const byAudit = db.prepare(`
      SELECT event, COUNT(*) AS n FROM audit_log
      WHERE ts >= ? AND event IN (${SECURITY_EVENTS.map(() => '?').join(',')})
      GROUP BY event ORDER BY n DESC LIMIT 20
    `).all(day, ...SECURITY_EVENTS);
    const byDenyReason = db.prepare(`
      SELECT reason, COUNT(*) AS n FROM policy_events
      WHERE action = 'deny' AND ts >= ?
      GROUP BY reason ORDER BY n DESC LIMIT 15
    `).all(day);
    const topIps = db.prepare(`
      SELECT ip, COUNT(*) AS n FROM audit_log
      WHERE ts >= ? AND event IN (${placeholders}) AND ip IS NOT NULL AND ip != ''
      GROUP BY ip ORDER BY n DESC LIMIT 10
    `).all(day, ...attackEvents);
    const recentAudit = db.prepare(`
      SELECT ts, user_id AS userId, event, ip, detail FROM audit_log
      WHERE ts >= ?
      ORDER BY ts DESC LIMIT 60
    `).all(day);
    const recentDenies = listPolicyEvents(db, { limit: 40 });
    res.json({
      server: {
        ok: true,
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
        node: process.version,
        memoryMb: {
          rss: Math.round(mem.rss / 1048576),
          heap: Math.round(mem.heapUsed / 1048576),
        },
        startedAt: now - Math.floor(process.uptime() * 1000),
      },
      counts: {
        users, activeUsers, disabledUsers, devices, blockedDevices: blockedDev,
        tenants, activeBlocks: blocks, denies24h, denies1h, securityFails24h: fails24h,
      },
      flags: listOpsFlags(db),
      live: {
        ingestOpen: isOpsOpen('mqtt_ingest_open'),
        rejectWindow: peekRejectStats(),
      },
      security: {
        byEvent: byAudit,
        byDenyReason,
        topIps,
        recentAudit,
        recentDenies,
      },
      config: {
        registrationEnv: String(process.env.REGISTRATION_OPEN || 'true'),
        subscribeAutoGrant: String(process.env.SUBSCRIBE_AUTO_GRANT || 'false'),
        ingestRequireKnown: String(process.env.INGEST_REQUIRE_KNOWN || 'true'),
        rateLimitApi: String(process.env.RATE_LIMIT_API || 120),
      },
    });
  });

  app.get('/api/admin/ops/flags', ...gate, (_req, res) => {
    res.json({ flags: listOpsFlags(db) });
  });

  app.patch('/api/admin/ops/flags/:key', ...writeGate, (req, res) => {
    const key = req.params.key;
    const body = req.body || {};
    if (body.reset === true) {
      const r = clearOpsFlag(db, key, { userId: req.user.id, ip: clientIp(req) });
      if (r.error) return res.status(r.status || 400).json(r);
      return res.json(r);
    }
    if (typeof body.open !== 'boolean') {
      return res.status(400).json({ error: 'open_required' });
    }
    const r = setOpsFlag(db, key, body.open, { userId: req.user.id, ip: clientIp(req) });
    if (r.error) return res.status(r.status || 400).json(r);
    res.json(r);
  });

  app.get('/api/admin/ops/users', ...gate, (_req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY id').all().map(enrichedUser);
    res.json({ users: rows, plans: listPlans() });
  });

  app.post('/api/admin/ops/users/:id/plan', ...writeGate, (req, res) => {
    const u = findUserById(db, Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'user_not_found' });
    const { plan, expiresAt, remoteControl } = req.body || {};
    if (plan) {
      const r = grantPlan(db, u.id, plan, { expiresAt: expiresAt || 'never' });
      if (r.error) return res.status(r.status || 400).json(r);
      audit(db, 'admin_plan_grant', {
        userId: req.user.id, ip: clientIp(req), detail: `${u.id} ${plan} ${expiresAt || 'never'}`,
      });
    }
    if (remoteControl === true || remoteControl === false) {
      setRemoteControl(db, u.id, remoteControl);
      audit(db, 'admin_remote_control', {
        userId: req.user.id, ip: clientIp(req), detail: `${u.id} ${remoteControl}`,
      });
    }
    res.json({ ok: true, user: enrichedUser(findUserById(db, u.id)) });
  });

  app.get('/api/admin/ops/tenants', ...gate, (_req, res) => {
    res.json({
      tenants: listTenants(db).map((t) => {
        const full = getTenant(db, t.id);
        return {
          ...t,
          ...publicTenant(full),
          subPlan: full?.sub_plan || null,
          subExpiresAt: full?.sub_expires_at || null,
        };
      }),
      plans: listPlans(),
    });
  });

  app.post('/api/admin/ops/tenants', ...writeGate, (req, res) => {
    const r = createTenant(db, req.body || {});
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'tenant_created', { userId: req.user.id, ip: clientIp(req), detail: r.tenant.id });
    res.json(r);
  });

  app.post('/api/admin/ops/tenants/:id/plan', ...writeGate, (req, res) => {
    const { plan, expiresAt } = req.body || {};
    if (!PLAN_CATALOG[plan]) return res.status(400).json({ error: 'unknown_plan' });
    const r = grantTenantPlan(db, req.params.id, plan, { expiresAt: expiresAt || 'never' });
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'tenant_subscription_grant', {
      userId: req.user.id, ip: clientIp(req), detail: `${req.params.id} ${plan}`,
    });
    res.json({ ok: true, tenant: publicTenant(getTenant(db, req.params.id)) });
  });

  app.post('/api/admin/ops/tenants/:id/rotate-key', ...writeGate, (req, res) => {
    const r = rotateTenantKey(db, req.params.id);
    if (r.error) return res.status(r.status || 400).json(r);
    res.json(r);
  });

  app.get('/api/admin/ops/devices', ...gate, (req, res) => {
    const tenantId = req.query.tenant;
    let devices = [];
    if (tenantId) {
      devices = listDevices(db, tenantId);
    } else {
      devices = db.prepare(`
        SELECT id, tenant_id AS tenantId, site, device, mqtt_user AS mqttUser,
               mqtt_id AS mqttId, profile, status, created_at AS createdAt, updated_at AS updatedAt
        FROM devices ORDER BY tenant_id, site, device
      `).all();
    }
    const enriched = devices.map((d) => {
      const last = queryLastTelemetry(db, { site: d.site, device: d.device });
      const st = queryLastEvent(db, { site: d.site, device: d.device, kind: 'status' });
      return {
        ...d,
        lastTelemetryAt: last?.t || null,
        lastStatus: st?.payload || null,
        onlineHint: last && (Date.now() - last.t < 15_000),
      };
    });
    res.json({ devices: enriched });
  });

  app.post('/api/admin/ops/devices', ...writeGate, (req, res) => {
    const { tenantId, site, device, profile, ns, rotate } = req.body || {};
    if (!tenantId) return res.status(400).json({ error: 'tenant_required' });
    const r = provisionDevice(db, tenantId, { site, device, profile, ns }, {
      rotate: Boolean(rotate), actor: `admin:${req.user.id}`,
    });
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'device_provisioned', {
      userId: req.user.id, ip: clientIp(req),
      detail: `${tenantId}/${site}/${device}`,
    });
    res.json(r);
  });

  app.delete('/api/admin/ops/devices/:tenant/:site/:device', ...writeGate, (req, res) => {
    const r = revokeDevice(db, req.params.tenant, req.params.site, req.params.device);
    if (r.error) return res.status(r.status || 400).json(r);
    res.json(r);
  });

  /* ---- PC nhà ---- */
  app.get('/api/admin/ops/home-pc', ...gate, (req, res) => {
    res.json(homePcStatus(db, req));
  });

  app.post('/api/admin/ops/home-pc/trust', ...gate, adminWrite, reauth, (req, res) => {
    // Lần đầu đánh dấu: Passkey + chữ ký khoá ECDSA của trình duyệt (không giả bằng copy UUID)
    const deviceId = deviceIdFromReq(req) || req.body?.deviceId;
    const r = trustHomePc(db, req.user.id, {
      deviceId,
      label: req.body?.label || 'PC nhà',
      ip: clientIp(req),
      publicKey: req.body?.publicKey,
      deviceProof: req.body?.deviceProof,
      action: '/api/admin/ops/home-pc/trust',
    });
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'admin_home_pc_trust', {
      userId: req.user.id, ip: clientIp(req), detail: deviceId,
    });
    res.json(r);
  });

  app.delete('/api/admin/ops/home-pc/:deviceId', ...gate, adminWrite, reauth, (req, res) => {
    const r = revokeHomePc(db, req.user.id, req.params.deviceId);
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'admin_home_pc_revoke', {
      userId: req.user.id, ip: clientIp(req), detail: req.params.deviceId,
    });
    res.json(r);
  });

  /* ---- Policy / chặn gói tin ---- */
  app.get('/api/admin/ops/policy', ...gate, (_req, res) => {
    res.json({
      config: policyConfigPublic(),
      blocks: listBlocks(db, { includeDisabled: false }),
      recentDenies: listPolicyEvents(db, { limit: 80 }),
    });
  });

  app.post('/api/admin/ops/policy/blocks', ...writeGate, (req, res) => {
    const b = req.body || {};
    const expiresAt = b.expiresAt && b.expiresAt !== 'never'
      ? (typeof b.expiresAt === 'number' ? b.expiresAt : Date.parse(b.expiresAt))
      : null;
    if (b.hard && b.scope === 'device') {
      const r = hardBlockDevice(db, {
        tenantId: b.tenantId, site: b.site, device: b.device,
        reason: b.reason || 'manual_hard_block',
        createdBy: `admin:${req.user.id}`,
      });
      if (r.error) return res.status(r.status || 400).json(r);
      audit(db, 'policy_hard_block', {
        userId: req.user.id, ip: clientIp(req), detail: `${b.site}/${b.device}`,
      });
      return res.json(r);
    }
    const r = createBlock(db, {
      scope: b.scope,
      tenantId: b.tenantId || null,
      site: b.site || null,
      device: b.device || null,
      topicPrefix: b.topicPrefix || null,
      reason: b.reason || 'manual',
      mode: 'manual',
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      createdBy: `admin:${req.user.id}`,
    });
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'policy_block_create', {
      userId: req.user.id, ip: clientIp(req), detail: `${b.scope} ${r.block.id}`,
    });
    res.json(r);
  });

  app.delete('/api/admin/ops/policy/blocks/:id', ...writeGate, (req, res) => {
    const r = disableBlock(db, req.params.id);
    if (r.error) return res.status(r.status || 400).json(r);
    audit(db, 'policy_block_disable', {
      userId: req.user.id, ip: clientIp(req), detail: req.params.id,
    });
    res.json(r);
  });

  app.get('/api/admin/ops/deploy', ...gate, async (_req, res) => {
    try {
      res.json(await deployStatusFull(deployPaths));
    } catch (e) {
      res.status(500).json({ error: 'deploy_status_failed', detail: e.message });
    }
  });

  app.post('/api/admin/ops/deploy', ...writeGate, async (req, res) => {
    const mode = req.body?.mode === 'full' ? 'full' : 'webapp';
    const r = await runDeploy(db, deployPaths, { mode, userId: req.user.id });
    if (r.error) {
      audit(db, 'deploy_failed', {
        userId: req.user.id, ip: clientIp(req), detail: `${mode} ${r.detail || r.error}`,
      });
      return res.status(r.status || 400).json(r);
    }
    audit(db, 'deploy_ok', {
      userId: req.user.id, ip: clientIp(req),
      detail: `${mode} ${r.after?.head || ''} bundles=${r.bundlesUpdated}`,
    });
    res.json(r);
  });

  app.get('/api/admin/ops/db', ...gate, (_req, res) => {
    const hist = historyStats(db);
    const byKind = db.prepare(`
      SELECT kind, COUNT(*) AS n, MAX(ts) AS lastTs FROM mqtt_events GROUP BY kind
    `).all();
    const topDevices = db.prepare(`
      SELECT site, device, COUNT(*) AS n, MAX(ts) AS lastTs
      FROM mqtt_events GROUP BY site, device ORDER BY lastTs DESC LIMIT 30
    `).all();
    const tables = ['users', 'tenants', 'devices', 'mqtt_events', 'webhooks', 'site_invites', 'hardware_devices']
      .map((name) => {
        try {
          return { name, rows: db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n };
        } catch {
          return { name, rows: null };
        }
      });
    res.json({ history: hist, byKind, topDevices, tables });
  });

  /** Admin quét/dán QR tem bất kỳ để xem giao diện (chỉ đọc): không gắn thiết bị, không thành chủ gateway. */
  app.post('/api/admin/qr-preview', ...gate, (req, res) => {
    const r = previewFromQr(db, { qr: req.body?.qr, ip: clientIp(req), adminId: req.user.id });
    res.status(r.error ? r.status || 400 : 200).json(r);
  });

  /* ---------- Ghép cặp gateway: admin phát mã → gateway gửi bản khai → admin xem trước + duyệt → QR ---------- */
  app.post('/api/admin/pairings', ...writeGate, (req, res) => {
    const r = createPairing(db, {
      adminId: req.user.id, label: req.body?.label, ttlMin: req.body?.ttlMin,
      site: req.body?.site, device: req.body?.device, auto: req.body?.auto,
    });
    if (!r.error) audit(db, 'pairing_create', { userId: req.user.id, ip: clientIp(req), detail: r.id });
    res.status(r.error ? r.status || 400 : 200).json(r);
  });
  app.get('/api/admin/pairings', ...gate, (_req, res) => res.json({ pairings: listPairings(db) }));
  app.get('/api/admin/pairings/:id', ...gate, (req, res) => {
    const r = getPairing(db, req.params.id);
    res.status(r.error ? r.status || 400 : 200).json(r);
  });
  app.post('/api/admin/pairings/:id/approve', ...writeGate, (req, res) => {
    const r = approvePairing(db, { id: req.params.id, site: req.body?.site, device: req.body?.device, label: req.body?.label });
    if (!r.error) audit(db, 'pairing_approve', { userId: req.user.id, ip: clientIp(req), detail: `${r.pairingId} → ${r.site}/${r.device}` });
    res.status(r.error ? r.status || 400 : 200).json(r);
  });
  app.delete('/api/admin/pairings/:id', ...writeGate, (req, res) => {
    const r = cancelPairing(db, req.params.id);
    if (!r.error) audit(db, 'pairing_cancel', { userId: req.user.id, ip: clientIp(req), detail: req.params.id });
    res.status(r.error ? r.status || 400 : 200).json(r);
  });

  /* ---------- Thiết bị cứng (QR claim): chỉ device đã add mới được user quét ---------- */
  const sendHw = (res, r) => (r?.error ? res.status(r.status || 400).json(r) : res.json(r));

  app.get('/api/admin/hardware', ...gate, (_req, res) => {
    const configured = Boolean(process.env.CLAIM_ROOT_PUBLIC_KEY && process.env.CLAIM_ROOT_PRIVATE_KEY);
    res.json({ configured, devices: listHardwareDevices(db) });
  });

  app.get('/api/admin/hardware/:site/:device/qr', ...gate, (req, res) => {
    const r = getHardwareDeviceQr(db, { site: req.params.site, device: req.params.device });
    sendHw(res, attachGatewayBundle(db, r, { rotateMqtt: false, includePassword: false }));
  });

  /** Kit MQTT đầy đủ (có password) — dùng copy vào gateway bán sẵn / DTU. */
  app.post('/api/admin/hardware/:site/:device/mqtt-kit', ...writeGate, (req, res) => {
    const r = getHardwareDeviceQr(db, { site: req.params.site, device: req.params.device });
    const bundled = attachGatewayBundle(db, r, {
      rotateMqtt: Boolean(req.body?.rotateMqtt),
      includePassword: true,
    });
    if (!bundled.error) {
      audit(db, 'hardware_mqtt_kit', {
        userId: req.user.id, ip: clientIp(req), detail: `${req.params.site}/${req.params.device}`,
      });
    }
    sendHw(res, bundled);
  });

  /** Thu hồi tem đã dùng + cấp QR mới (QR cũ, kit gateway cũ và mọi liên kết webapp đều mất hiệu lực). */
  app.post('/api/admin/hardware/:site/:device/revoke', ...writeGate, (req, res) => {
    const { site, device } = req.params;
    const row = db.prepare('SELECT 1 FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
    if (!row) return sendHw(res, { error: 'not_found', status: 404 });
    notifyGateway(db, site, device, 'unclaimed');
    const revoked = revokeDeviceBinding(db, site, device, { ip: clientIp(req), adminId: req.user.id });
    const r = reissueHardwareDeviceQr(db, { site, device, unclaim: true });
    if (!r.error) {
      audit(db, 'hardware_revoke', { userId: req.user.id, ip: clientIp(req), detail: `${site}/${device}` });
    }
    const out = attachGatewayBundle(db, r, { rotateMqtt: true, includePassword: false });
    if (!out.error) out.revoked = revoked;
    sendHw(res, out);
  });

  /** Kích hoạt gateway (kể cả offline): admin dán ID từ gateway → trả mã kích hoạt để nhập vào gateway. */
  app.post('/api/admin/hardware/:site/:device/activate', ...writeGate, (req, res) => {
    const { site, device } = req.params;
    const r = issueActivationCode(db, {
      site, device, request: req.body?.request, days: req.body?.days, force: Boolean(req.body?.force),
      mode: req.body?.mode === 'license' ? 'license' : 'challenge',
    });
    if (!r.error) {
      audit(db, 'hardware_activate', {
        userId: req.user.id, ip: clientIp(req),
        detail: `${site}/${device} hw=${r.hw.slice(0, 16)} lần=${r.activations}${r.rebound ? ' rebound' : ''}`,
      });
    }
    sendHw(res, r.ok && r.mode === 'license' ? { ...r, licenseFile: buildLicenseFile(r, { site, device }) } : r);
  });

  /** Gỡ ràng buộc máy (gateway có internet đã gắn máy) để tem dùng cho máy khác. */
  app.post('/api/admin/hardware/:site/:device/unbind', ...writeGate, (req, res) => {
    const r = releaseGatewayHardware(db, req.params);
    if (!r.error) audit(db, 'hardware_unbind', { userId: req.user.id, ip: clientIp(req), detail: `${req.params.site}/${req.params.device}` });
    sendHw(res, r);
  });

  /** Sản xuất: khoá riêng của máy (suy từ ID máy) để nạp vào gateway. Bí mật — không lưu, chỉ hiện cho admin. */
  app.post('/api/admin/gateway-key', ...writeGate, (req, res) => {
    const hw = String(req.body?.hw || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (!/^[0-9A-HJKMNP-TV-Z]{4,40}$/.test(hw)) return sendHw(res, { error: 'invalid_activation_request', status: 400 });
    audit(db, 'gateway_key_issued', { userId: req.user.id, ip: clientIp(req), detail: `hw=${hw}` });
    res.json({ ok: true, hw, key: deriveDeviceKey(hw) });
  });

  app.post('/api/admin/hardware/:site/:device/reissue', ...writeGate, (req, res) => {
    if (req.body?.unclaim) notifyGateway(db, req.params.site, req.params.device, 'unclaimed');
    if (req.body?.unclaim) revokeDeviceBinding(db, req.params.site, req.params.device, { ip: clientIp(req), adminId: req.user.id });
    const r = reissueHardwareDeviceQr(db, {
      site: req.params.site,
      device: req.params.device,
      unclaim: Boolean(req.body?.unclaim),
    });
    if (!r.error) {
      audit(db, 'hardware_reissue', {
        userId: req.user.id, ip: clientIp(req), detail: `${r.site}/${r.device}`,
      });
    }
    sendHw(res, attachGatewayBundle(db, r, { rotateMqtt: true, includePassword: false }));
  });

  app.patch('/api/admin/hardware/:site/:device', ...writeGate, (req, res) => {
    const site = req.params.site;
    const device = req.params.device;
    let uiMeta = req.body?.uiMeta ?? req.body?.ui_meta;
    if (uiMeta !== undefined) {
      const row = db.prepare('SELECT ui_meta FROM hardware_devices WHERE site = ? AND device = ?')
        .get(site, device);
      uiMeta = bumpConfigRev(row?.ui_meta, uiMeta);
    }
    const r = updateHardwareDeviceMeta(db, {
      site, device,
      label: req.body?.label,
      note: req.body?.note,
      profile: req.body?.profile,
      uiMeta,
    });
    if (!r.error) {
      const row = db.prepare('SELECT profile FROM hardware_devices WHERE site = ? AND device = ?')
        .get(site, device);
      try {
        ensureMqttForHardware(db, { site, device, profile: row?.profile, rotate: false });
      } catch { /* mosquitto có thể offline lúc patch */ }
    }
    sendHw(res, r);
  });

  app.delete('/api/admin/hardware/:site/:device', ...writeGate, (req, res) => {
    if (req.query?.force === '1' || req.body?.force) {
      notifyGateway(db, req.params.site, req.params.device, 'unclaimed');
      revokeDeviceBinding(db, req.params.site, req.params.device, { ip: clientIp(req), adminId: req.user.id });
    }
    const r = deleteHardwareDevice(db, {
      site: req.params.site,
      device: req.params.device,
      force: Boolean(req.query?.force === '1' || req.body?.force),
    });
    if (!r.error) {
      try { revokeDevice(db, 'default', req.params.site, req.params.device); } catch { /* ignore */ }
      audit(db, 'hardware_delete', {
        userId: req.user.id, ip: clientIp(req), detail: `${req.params.site}/${req.params.device}`,
      });
    }
    sendHw(res, r);
  });
}
