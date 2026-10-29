/**
 * API nền tảng cho admin + partner (API key):
 *   Admin:  /api/admin/tenants…
 *   Partner:/api/v1/devices…  (Authorization: Bearer <api_key>)
 *   REST:   telemetry / history / cmd + webhooks
 */
import { rateLimit, clientIp, audit } from '@plciot/security';
import { isDashboardAdmin } from './roles.js';
import { contractInfo, DEFAULT_TENANT, isValidId } from './contract.js';
import { listProfiles, controlConfigFor } from './profiles.js';
import {
  listTenants, getTenant, createTenant, rotateTenantKey, findTenantByApiKey,
  provisionDevice, listDevices, revokeDevice, findDevice, publicTenant,
} from './tenants.js';
import { queryTelemetry, queryEvents, queryLastTelemetry, queryLastEvent } from './historyStore.js';
import { validateCmd } from './plcCommands.js';
import { publishCmd } from './controlPublisher.js';
import { createWebhook, listWebhooks, deleteWebhook } from './webhooks.js';
import { mayPartnerCmd } from './entitlements.js';
import { partnerApiGate, isOpsOpen } from './opsFlags.js';

function send(res, result) {
  if (!result) return res.status(500).json({ error: 'server_error' });
  if (result.error) return res.status(result.status || 400).json(result);
  return res.status(200).json(result);
}

function requireAdmin(req, res, next) {
  if (!isDashboardAdmin(req.user)) return res.status(403).json({ error: 'forbidden' });
  next();
}

function extractApiKey(req) {
  const h = req.headers.authorization || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return (req.headers['x-api-key'] || '').trim() || null;
}

export function mountPartnerRoutes(app, { db, requireAuth, reauth }) {
  const adminOnly = [requireAuth, requireAdmin];
  const adminWrite = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_ADMIN || 30),
    keyFn: (req) => `${clientIp(req)}:admin-tenant:${req.user?.id || 'na'}`,
  });
  const partnerLimit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PARTNER || 60),
    keyFn: (req) => `${clientIp(req)}:partner:${req.tenant?.id || 'na'}`,
  });

  app.use('/api/v1', partnerApiGate);

  function requirePartner(req, res, next) {
    const key = extractApiKey(req);
    if (!key) return res.status(401).json({ error: 'api_key_required' });
    const tenant = findTenantByApiKey(db, key);
    if (!tenant) return res.status(401).json({ error: 'invalid_api_key' });
    req.tenant = tenant;
    next();
  }

  /* ---- Public contract (không cần auth) ---- */
  app.get('/api/v1/contract', (_req, res) => {
    res.json({
      ...contractInfo(),
      profiles: listProfiles(),
    });
  });

  /* ---- Admin: tenants ---- */
  app.get('/api/admin/tenants', ...adminOnly, (_req, res) => {
    res.json({ tenants: listTenants(db), profiles: listProfiles(), contract: contractInfo() });
  });

  app.post('/api/admin/tenants', ...adminOnly, adminWrite, reauth, (req, res) => {
    const result = createTenant(db, req.body || {});
    if (result.ok) {
      audit(db, 'tenant_created', {
        userId: req.user.id, ip: clientIp(req), detail: result.tenant.id,
      });
    }
    send(res, result);
  });

  app.post('/api/admin/tenants/:id/rotate-key', ...adminOnly, adminWrite, reauth, (req, res) => {
    const result = rotateTenantKey(db, req.params.id);
    if (result.ok) {
      audit(db, 'tenant_key_rotated', {
        userId: req.user.id, ip: clientIp(req), detail: req.params.id,
      });
    }
    send(res, result);
  });

  app.get('/api/admin/tenants/:id/devices', ...adminOnly, (req, res) => {
    const t = getTenant(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ tenant: publicTenant(t), devices: listDevices(db, t.id) });
  });

  app.post('/api/admin/tenants/:id/devices', ...adminOnly, adminWrite, reauth, (req, res) => {
    const result = provisionDevice(db, req.params.id, req.body || {}, {
      rotate: Boolean(req.body?.rotate), actor: `admin:${req.user.id}`,
    });
    if (result.ok) {
      audit(db, 'device_provisioned', {
        userId: req.user.id, ip: clientIp(req),
        detail: `${result.device.tenantId}/${result.device.site}/${result.device.device}`,
      });
    }
    send(res, result);
  });

  /* ---- Partner API key ---- */
  app.get('/api/v1/me', requirePartner, partnerLimit, (req, res) => {
    res.json({
      tenant: publicTenant(req.tenant),
      profile: controlConfigFor(req.tenant.profile),
      contract: contractInfo(),
      profiles: listProfiles(),
    });
  });

  app.get('/api/v1/devices', requirePartner, partnerLimit, (req, res) => {
    res.json({ devices: listDevices(db, req.tenant.id) });
  });

  app.post('/api/v1/devices', requirePartner, partnerLimit, (req, res) => {
    const result = provisionDevice(db, req.tenant, req.body || {}, {
      rotate: Boolean(req.body?.rotate), actor: `partner:${req.tenant.id}`,
    });
    if (result.ok) {
      audit(db, 'device_provisioned', {
        userId: null, ip: clientIp(req),
        detail: `partner ${result.device.tenantId}/${result.device.site}/${result.device.device}`,
      });
    }
    send(res, result);
  });

  app.post('/api/v1/devices/:site/:device/rotate', requirePartner, partnerLimit, (req, res) => {
    const result = provisionDevice(db, req.tenant, {
      site: req.params.site, device: req.params.device, ns: req.body?.ns, profile: req.body?.profile,
    }, { rotate: true, actor: `partner:${req.tenant.id}` });
    send(res, result);
  });

  app.delete('/api/v1/devices/:site/:device', requirePartner, partnerLimit, (req, res) => {
    const result = revokeDevice(db, req.tenant.id, req.params.site, req.params.device);
    if (result.ok) {
      audit(db, 'device_revoked', {
        userId: null, ip: clientIp(req),
        detail: `${req.tenant.id}/${req.params.site}/${req.params.device}`,
      });
    }
    send(res, result);
  });

  function ownedDevice(req, res) {
    const { site, device } = req.params;
    if (!isValidId(site) || !isValidId(device)) {
      res.status(400).json({ error: 'invalid_site_or_device' });
      return null;
    }
    const row = findDevice(db, req.tenant.id, site, device);
    if (!row || row.status !== 'active') {
      res.status(404).json({ error: 'device_not_found' });
      return null;
    }
    return row;
  }

  /* ---- REST monitor (không cần MQTT phía partner) ---- */
  app.get('/api/v1/devices/:site/:device/telemetry/last', requirePartner, partnerLimit, (req, res) => {
    const row = ownedDevice(req, res);
    if (!row) return;
    const last = queryLastTelemetry(db, { site: row.site, device: row.device });
    const status = queryLastEvent(db, { site: row.site, device: row.device, kind: 'status' });
    res.json({
      site: row.site,
      device: row.device,
      tenantId: row.tenant_id,
      telemetry: last ? {
        t: last.t, o: last.o, i: last.i, a: last.a, c: last.c, s: last.s, payload: last.payload,
      } : null,
      status: status ? { t: status.ts, value: status.payload } : null,
    });
  });

  app.get('/api/v1/devices/:site/:device/history', requirePartner, partnerLimit, (req, res) => {
    const row = ownedDevice(req, res);
    if (!row) return;
    const until = Number(req.query.until || Date.now());
    const since = Number(req.query.since || until - 3600e3);
    const limit = Number(req.query.limit || 2000);
    if (!Number.isFinite(since) || !Number.isFinite(until)) {
      return res.status(400).json({ error: 'bad_range' });
    }
    const kind = String(req.query.kind || 'telemetry');
    if (kind === 'telemetry') {
      const samples = queryTelemetry(db, {
        site: row.site, device: row.device, since, until, limit,
      });
      return res.json({
        site: row.site, device: row.device, since, until,
        samples: samples.map(({ t, o, i, a, c, s }) => ({ t, o, i, a, c, s })),
      });
    }
    const events = queryEvents(db, {
      site: row.site, device: row.device, since, until,
      kinds: kind.split(',').map((k) => k.trim()).filter(Boolean),
      limit,
    });
    res.json({ site: row.site, device: row.device, since, until, events });
  });

  /* ---- REST control (API key = quyền M2M; không Passkey điện thoại) ---- */
  app.post('/api/v1/devices/:site/:device/cmd', requirePartner, partnerLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return res.status(503).json({ error: 'remote_control_paused' });
    }
    const ent = mayPartnerCmd(req.tenant, { ip: clientIp(req) });
    if (!ent.ok) return res.status(403).json({ error: 'subscription_denied', reason: ent.reason });
    const row = ownedDevice(req, res);
    if (!row) return;
    const cfg = controlConfigFor(row.profile || req.tenant.profile);
    const v = validateCmd(req.body, cfg);
    if (v.error) return res.status(400).json(v);
    try {
      await publishCmd(row.site, row.device, v.cmd, {
        tenant: row.tenant_id || DEFAULT_TENANT,
        ns: row.topic_ns,
      });
    } catch {
      return res.status(503).json({ error: 'mqtt_unavailable' });
    }
    audit(db, 'partner_control_cmd', {
      userId: null, ip: clientIp(req),
      detail: `${row.tenant_id}/${row.site}/${row.device} ${v.cmd.op || 'w'} a=${v.cmd.a}`,
    });
    res.json({ ok: true, id: v.cmd.id, via: 'partner_api' });
  });

  /* ---- Webhooks ---- */
  app.get('/api/v1/webhooks', requirePartner, partnerLimit, (req, res) => {
    res.json({ webhooks: listWebhooks(db, req.tenant.id) });
  });

  app.post('/api/v1/webhooks', requirePartner, partnerLimit, (req, res) => {
    const result = createWebhook(db, req.tenant.id, req.body || {});
    if (result.ok) {
      audit(db, 'webhook_created', {
        userId: null, ip: clientIp(req), detail: `${req.tenant.id} ${result.webhook.id}`,
      });
    }
    send(res, result);
  });

  app.delete('/api/v1/webhooks/:id', requirePartner, partnerLimit, (req, res) => {
    send(res, deleteWebhook(db, req.tenant.id, req.params.id));
  });
}
