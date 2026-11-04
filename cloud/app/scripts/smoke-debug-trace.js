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
const MY = 'u_debug';
const OTHER = 'u_other';

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
    ADMIN_USERNAMES: '',
    ADMIN_DASHBOARD_USERS: '',
    BUNDLE_AUTOSYNC: 'false',
    DEBUG_CLIENT_TRACE: 'true',
    DEBUG_TRACE_USERS: MY,
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

  const badPost = await fetch(`${base}/api/debug/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-User': OTHER },
    body: JSON.stringify({ events: [{ action: 'x', message: 'nope' }] }),
  });
  assert.equal(badPost.status, 403);

  const post = await fetch(`${base}/api/debug/trace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-User': MY },
    body: JSON.stringify({
      username: MY,
      events: [
        { action: 'login.start', message: 'test', level: 'info' },
        { action: 'login.verify_ok', message: 'ok', level: 'ok' },
      ],
    }),
  });
  assert.equal(post.status, 200);
  assert.equal((await post.json()).ok, true);

  const getOther = await fetch(`${base}/api/debug/trace?user=${OTHER}`);
  assert.equal(getOther.status, 403);

  const get = await (await fetch(`${base}/api/debug/trace?user=${MY}`)).json();
  assert.ok(get.entries?.length >= 1);
  assert.ok(get.entries.every((e) => e.user === MY));
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'debug-trace.jsonl')));

  console.log('smoke-debug-trace: passed');
} finally {
  if (child.exitCode == null && child.signalCode == null) {
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
}
