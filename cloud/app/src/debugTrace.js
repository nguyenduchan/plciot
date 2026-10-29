/**
 * Debug trace Passkey/Face ID — chỉ SĐT allow-list.
 * Bật: DEBUG_CLIENT_TRACE=true
 * SĐT: DEBUG_TRACE_PHONES=09… (trống → ADMIN_DASHBOARD_PHONES / ADMIN_PHONES)
 */
import fs from 'fs';
import path from 'path';
import { rateLimit, clientIp, normalizePhone } from '@plciot/security';
import { dashboardAdminPhones } from './roles.js';

const MAX = Number(process.env.DEBUG_TRACE_MAX || 200);
const buf = [];
let seq = 0;

function enabled() {
  return String(process.env.DEBUG_CLIENT_TRACE || '').toLowerCase() === 'true'
    || process.env.DEBUG_CLIENT_TRACE === '1';
}

/** SĐT được phép debug. Không cấu hình list → không cho ai. */
export function debugTracePhones() {
  const raw = process.env.DEBUG_TRACE_PHONES;
  if (raw != null && String(raw).trim() !== '') {
    return [...new Set(String(raw).split(',').map((s) => normalizePhone(s.trim())).filter(Boolean))];
  }
  return dashboardAdminPhones();
}

export function phoneAllowedForDebug(phone) {
  const list = debugTracePhones();
  if (!list.length) return false;
  return list.includes(normalizePhone(phone || ''));
}

function tokenOk(req) {
  const want = process.env.DEBUG_TRACE_TOKEN || '';
  if (!want) return true;
  const got = String(req.query?.token || req.headers['x-debug-token'] || '');
  return got === want;
}

function phoneFromReq(req) {
  return normalizePhone(
    req.headers['x-debug-phone']
    || req.body?.phone
    || req.query?.phone
    || '',
  );
}

function dataFile() {
  const dir = process.env.DATA_DIR || './data';
  return path.join(dir, 'debug-trace.jsonl');
}

function sanitize(ev) {
  const out = { ...ev };
  delete out.token;
  delete out.password;
  delete out.otp;
  delete out.credential;
  delete out.publicKey;
  delete out.deviceProof;
  if (out.detail && typeof out.detail === 'object') {
    const d = { ...out.detail };
    for (const k of ['credential', 'attestationObject', 'signature', 'authenticatorData', 'clientDataJSON']) delete d[k];
    out.detail = d;
  }
  return out;
}

function push(ev, ip) {
  const row = {
    id: ++seq,
    ts: Date.now(),
    ip: ip || null,
    ...sanitize(ev),
  };
  buf.push(row);
  while (buf.length > MAX) buf.shift();
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    fs.appendFileSync(dataFile(), `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.warn('debug-trace write', e.message);
  }
  console.log('[debug-trace]', row.phone || '', row.level || 'info', row.action || '', row.message || '');
  return row;
}

export function mountDebugTrace(app) {
  app.get('/api/debug/allowed', (req, res) => {
    if (!enabled()) return res.json({ enabled: false, allowed: false });
    const phone = phoneFromReq(req);
    const allowed = Boolean(phone && phoneAllowedForDebug(phone));
    res.json({
      enabled: true,
      allowed,
      phone: phone || null,
      needPhone: !phone,
      hint: allowed
        ? 'Debug OK cho SĐT này'
        : (phone
          ? 'SĐT không được phép debug'
          : 'Thêm ?phone= hoặc header X-Debug-Phone (SĐT của bạn)'),
    });
  });

  if (!enabled()) {
    app.get('/api/debug/trace', (_req, res) => res.status(404).json({ error: 'debug_disabled' }));
    app.post('/api/debug/trace', (_req, res) => res.status(404).json({ error: 'debug_disabled' }));
    app.delete('/api/debug/trace', (_req, res) => res.status(404).json({ error: 'debug_disabled' }));
    return;
  }

  const limit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.DEBUG_TRACE_RATE || 120),
    keyFn: (req) => `${clientIp(req)}:dbg`,
  });

  const phones = debugTracePhones();
  console.warn(`[debug-trace] ENABLED — chỉ ${phones.length} SĐT allow-list`);

  function requireDebugActor(req, res) {
    if (!tokenOk(req)) {
      res.status(401).json({ error: 'debug_token_required' });
      return null;
    }
    const phone = phoneFromReq(req);
    if (!phone || !phoneAllowedForDebug(phone)) {
      res.status(403).json({ error: 'debug_phone_denied', needPhone: !phone });
      return null;
    }
    return phone;
  }

  app.get('/api/debug/trace', (req, res) => {
    const phone = requireDebugActor(req, res);
    if (!phone) return;
    const since = Number(req.query.since || 0) || 0;
    let events = buf.filter((e) => e.phone === phone);
    if (since) events = events.filter((e) => e.id > since || e.ts > since);
    res.json({
      ok: true,
      enabled: true,
      phone,
      count: events.length,
      total: buf.length,
      file: dataFile(),
      hint: 'Chỉ event của đúng SĐT bạn. iPhone: login.html?debug=1',
      events,
    });
  });

  app.post('/api/debug/trace', limit, (req, res) => {
    const phone = requireDebugActor(req, res);
    if (!phone) return;
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events : [body];
    const saved = events.slice(0, 20).map((e) => push({
      phone,
      scope: String(e.scope || 'client').slice(0, 40),
      action: String(e.action || 'event').slice(0, 80),
      level: String(e.level || 'info').slice(0, 16),
      message: String(e.message || '').slice(0, 400),
      detail: e.detail && typeof e.detail === 'object' ? e.detail : undefined,
      ua: String(req.headers['user-agent'] || '').slice(0, 160),
      deviceId: String(req.headers['x-device-id'] || e.deviceId || '').slice(0, 64),
      path: String(e.path || '').slice(0, 120),
    }, clientIp(req)));
    res.json({ ok: true, saved: saved.length, lastId: seq, phone });
  });

  app.delete('/api/debug/trace', (req, res) => {
    const phone = requireDebugActor(req, res);
    if (!phone) return;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].phone === phone) buf.splice(i, 1);
    }
    res.json({ ok: true, phone });
  });
}

export function debugTraceEnabled() {
  return enabled();
}
