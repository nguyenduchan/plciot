/**
 * Debug trace Passkey — allow-list username (DEBUG_TRACE_USERS / ADMIN_USERNAMES).
 */
import fs from 'fs';
import path from 'path';
import { rateLimit, clientIp } from '@plciot/security';
import { dashboardAdminUsers } from './roles.js';

const MAX = Number(process.env.DEBUG_TRACE_MAX || 200);
const buf = [];
let seq = 0;

function enabled() {
  return String(process.env.DEBUG_CLIENT_TRACE || '').toLowerCase() === 'true'
    || process.env.DEBUG_CLIENT_TRACE === '1';
}

export function debugTraceUsers() {
  const raw = process.env.DEBUG_TRACE_USERS;
  if (raw != null && String(raw).trim() !== '') {
    return [...new Set(String(raw).split(',').map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  }
  return dashboardAdminUsers();
}

export function userAllowedForDebug(username) {
  const list = debugTraceUsers();
  if (!list.length) return false;
  return list.includes(String(username || '').trim().toLowerCase());
}

function tokenOk(req) {
  const want = process.env.DEBUG_TRACE_TOKEN || '';
  if (!want) return true;
  const got = String(req.query?.token || req.headers['x-debug-token'] || '');
  return got === want;
}

function userFromReq(req) {
  return String(
    req.headers['x-debug-user']
    || req.body?.username
    || req.query?.user
    || '',
  ).trim().toLowerCase();
}

export function debugTraceEnabled() {
  return enabled();
}

export function mountDebugTrace(app) {
  if (!enabled()) return;
  const limit = rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => `${clientIp(req)}:dbg` });
  app.post('/api/debug/trace', limit, (req, res) => {
    if (!tokenOk(req) || !userAllowedForDebug(userFromReq(req))) return res.status(403).json({ error: 'forbidden' });
    const entry = {
      id: ++seq,
      ts: Date.now(),
      ip: clientIp(req),
      user: userFromReq(req),
      ...(req.body && typeof req.body === 'object' ? req.body : { raw: String(req.body || '') }),
    };
    buf.push(entry);
    while (buf.length > MAX) buf.shift();
    try {
      const dir = process.env.DATA_DIR || './data';
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'debug-trace.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch { /* ignore */ }
    res.json({ ok: true, id: entry.id });
  });
  app.get('/api/debug/trace', (req, res) => {
    if (!tokenOk(req) || !userAllowedForDebug(userFromReq(req))) return res.status(403).json({ error: 'forbidden' });
    res.json({ enabled: true, entries: buf.slice(-MAX) });
  });
}
