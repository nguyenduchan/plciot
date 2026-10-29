#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-dbg-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const shell = fileURLToPath(new URL('../../../webapp', import.meta.url));
const publisher = new URL('../src/controlPublisher.js', import.meta.url).href;
const server = new URL('../src/server.js', import.meta.url).href;
const bootstrap = `const publisher = await import(${JSON.stringify(publisher)}); publisher.setPublisher(async () => {}); await import(${JSON.stringify(server)});`;
const MY = '84901112233';
const OTHER = '84909998877';

const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: path.join(tmp, 'data'),
    MQTT_CONFIG_DIR: path.join(tmp, 'mqtt'),
    SHELL_DIR: shell,
    WEBAPP_SRC: shell,
    WEBAPP_PUBLIC_URL: base,
    APP_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MQTT_INGEST: 'false',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_BOT_POLLING: 'false',
    TELEGRAM_SHARED_PG_HOST: '',
    TELEGRAM_SHARED_DATABASE_URL: '',
    SMTP_URL: '',
    ADMIN_PHONES: '',
    ADMIN_DASHBOARD_PHONES: '',
    BUNDLE_AUTOSYNC: 'false',
    DEBUG_CLIENT_TRACE: 'true',
    DEBUG_TRACE_PHONES: '0901112233',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let out = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (t) => { out += t; });
child.stderr.on('data', (t) => { out += t; });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${out}`)), 15000);
    const ready = () => { if (out.includes('plciot app listening')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
    child.once('exit', (c) => { clearTimeout(timer); reject(new Error(`exit ${c}: ${out}`)); });
    ready();
  });

  assert.equal((await (await fetch(`${base}/api/health`)).json()).debugTrace, true);

  const deny = await fetch(`${base}/api/debug/allowed?phone=${OTHER}`);
  assert.equal((await deny.json()).allowed, false);

  const allow = await (await fetch(`${base}/api/debug/allowed?phone=${MY}`)).json();
  assert.equal(allow.allowed, true);

  const badPost = await fetch(`${base}/api/debug/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Phone': OTHER },
    body: JSON.stringify({ events: [{ action: 'x', message: 'nope' }] }),
  });
  assert.equal(badPost.status, 403);

  const post = await fetch(`${base}/api/debug/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Phone': MY },
    body: JSON.stringify({
      phone: MY,
      events: [
        { action: 'login.start', message: 'test', level: 'info' },
        { action: 'login.verify_ok', message: 'ok', level: 'ok' },
      ],
    }),
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).saved, 2);

  const getOther = await fetch(`${base}/api/debug/trace?phone=${OTHER}`);
  assert.equal(getOther.status, 403);

  const get = await (await fetch(`${base}/api/debug/trace?phone=${MY}`)).json();
  assert.ok(get.events.some((e) => e.action === 'login.verify_ok'));
  assert.ok(get.events.every((e) => e.phone === MY));
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'debug-trace.jsonl')));

  console.log('smoke-debug-trace: passed (phone allow-list)');
} finally {
  if (child.exitCode == null && child.signalCode == null) {
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
}
