import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-server-'));
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const shell = fileURLToPath(new URL('../../../webapp', import.meta.url));
const publisher = new URL('../src/controlPublisher.js', import.meta.url).href;
const server = new URL('../src/server.js', import.meta.url).href;
const bootstrap = `const publisher = await import(${JSON.stringify(publisher)}); publisher.setPublisher(async () => {}); await import(${JSON.stringify(server)});`;
const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
  env: {
    ...process.env,
    PORT: String(port), DATA_DIR: path.join(tmp, 'data'), MQTT_CONFIG_DIR: path.join(tmp, 'mqtt'),
    SHELL_DIR: shell, WEBAPP_SRC: shell, WEBAPP_PUBLIC_URL: base,
    APP_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    MQTT_INGEST: 'false', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_POLLING: 'false',
    TELEGRAM_SHARED_PG_HOST: '', TELEGRAM_SHARED_DATABASE_URL: '', SMTP_URL: '',
    ADMIN_PHONES: '', BUNDLE_AUTOSYNC: 'true', REGISTRATION_OPEN: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
let errors = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (text) => { output += text; });
child.stderr.on('data', (text) => { errors += text; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${errors}`)), 15000);
    const ready = () => {
      if (output.includes('plciot app listening on')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', ready);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited during startup (${code}): ${errors}`)); });
    ready();
  });
  const get = (route, options = {}) => fetch(base + route, { signal: AbortSignal.timeout(10000), ...options });
  assert.equal((await get('/api/health')).status, 200);
  const config = await get('/api/auth/config');
  assert.equal(config.status, 200);
  assert.equal((await config.json()).presence, true);
  assert.match(config.headers.get('Cache-Control'), /no-store/);
  const root = await get('/', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('Location'), '/login.html');
  for (const route of ['/login.html', '/recover.html', '/auth-app.js', '/security/login.js', '/security/recover.js', '/security/account.js', '/security/device-proof.js']) {
    assert.equal((await get(route)).status, 200, route);
  }
  assert.equal((await get('/api/me')).status, 401);
  assert.equal((await get('/api/bundle/index.html')).status, 401);
  const invalid = await get('/api/login/request-otp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '123' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_phone');
  const cancel = await get('/api/phone/cancel?id=missing&t=missing');
  assert.equal(cancel.status, 200);
  assert.match(await cancel.text(), /<form method="post"/);
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'app.db')));
  console.log('Production server: startup, core routes, generated clients, auth gate and safe cancel passed');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}