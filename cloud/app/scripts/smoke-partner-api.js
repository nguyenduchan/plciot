#!/usr/bin/env node
/** Offline: partner REST (telemetry/history/cmd) + webhooks. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plc-partner-'));
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'cfg');
process.env.APP_JWT_SECRET = 'x'.repeat(32);
process.env.MQTT_DOCKER_CONTAINER = 'no-such-container';
process.env.WEBHOOK_ALLOW_HTTP = 'true';
process.env.PARTNER_CMD_ENABLED = 'true';
process.env.MQTT_PREFERRED_NS = 'plc';

const { openDb } = await import('../src/db.js');
const { createTenant, provisionDevice } = await import('../src/tenants.js');
const { insertEvent } = await import('../src/historyStore.js');
const { mountPartnerRoutes } = await import('../src/partnerRoutes.js');
const { setPublisher } = await import('../src/controlPublisher.js');
const { emitWebhook } = await import('../src/webhooks.js');

const db = openDb(tmp);
let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const t = createTenant(db, { id: 'acme', name: 'ACME', profile: 'conveyor-v1' });
ok(t.ok, 'tenant');
const key = t.apiKey;
provisionDevice(db, 'acme', { site: 'p1', device: 'gw1' });

const now = Date.now();
insertEvent(db, {
  ts: now - 1000, site: 'p1', device: 'gw1', kind: 'telemetry',
  payload: '{"r":[]}', o: 2, i: 1, a: 0, c: 10, s: 1,
});
insertEvent(db, {
  ts: now, site: 'p1', device: 'gw1', kind: 'status',
  payload: 'online', o: null, i: null, a: null, c: null, s: null,
});

const published = [];
setPublisher(async (site, device, cmd, opts) => {
  published.push({ site, device, cmd, opts });
});

const app = express();
app.use(express.json());
const noop = (_req, _res, next) => next();
mountPartnerRoutes(app, { db, requireAuth: noop, reauth: noop });

const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, url, body) {
  const r = await fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

const contract = await (await fetch(`${base}/api/v1/contract`)).json();
ok(contract.schema === 1 && contract.profiles?.length >= 1, 'public contract');

const last = await api('GET', '/api/v1/devices/p1/gw1/telemetry/last');
ok(last.telemetry?.c === 10 && last.status?.value === 'online', 'telemetry/last');

const hist = await api('GET', `/api/v1/devices/p1/gw1/history?since=${now - 5000}&until=${now + 1}`);
ok(hist.samples?.length === 1, 'history telemetry');

const bad = await api('GET', '/api/v1/devices/other/gw1/telemetry/last');
ok(bad.error === 'device_not_found' || bad.status === 404, 'tenant isolation');

const cmd = await api('POST', '/api/v1/devices/p1/gw1/cmd', { a: 6, v: 1 });
ok(cmd.ok && published.length === 1 && published[0].opts.ns === 'iot', 'partner cmd → mqtt');
ok(published[0].cmd.schema === 1 || published[0].cmd.a === 6, 'cmd payload');

const denied = await api('POST', '/api/v1/devices/p1/gw1/cmd', { a: 99, v: 1 });
ok(denied.error === 'bad_command', 'profile whitelist');

// webhook receiver
let got = null;
const whServer = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    got = { headers: req.headers, body: JSON.parse(buf) };
    res.end('ok');
  });
});
await new Promise((r) => whServer.listen(0, '127.0.0.1', r));
const whPort = whServer.address().port;
const wh = await api('POST', '/api/v1/webhooks', {
  url: `http://127.0.0.1:${whPort}/hook`,
  events: ['status', 'alarm', 'count_done'],
});
ok(wh.ok && wh.secret, 'create webhook + secret');

emitWebhook(db, {
  tenantId: 'acme', site: 'p1', device: 'gw1', event: 'status',
  data: { status: 'offline', previous: 'online' },
});
await new Promise((r) => setTimeout(r, 200));
ok(got?.body?.event === 'status' && got.body.tenant === 'acme', 'webhook delivered');
ok(String(got?.headers['x-plciot-signature'] || '').startsWith('sha256='), 'webhook signature');

const listed = await api('GET', '/api/v1/webhooks');
ok(listed.webhooks?.length === 1, 'list webhooks');
ok((await api('DELETE', `/api/v1/webhooks/${wh.webhook.id}`)).ok, 'delete webhook');

server.close();
whServer.close();
console.log(fails ? `FAILED ${fails}` : 'smoke-partner-api OK');
process.exit(fails ? 1 : 0);
