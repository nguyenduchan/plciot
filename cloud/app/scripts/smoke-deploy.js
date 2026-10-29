#!/usr/bin/env node
/**
 * Smoke: đồng bộ Git (fetch/reset) + sync bundle — không cần GitHub/Docker thật.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-deploy-'));
const remote = path.join(tmp, 'remote.git');
const repo = path.join(tmp, 'checkout');
const other = path.join(tmp, 'other');
const dataDir = path.join(tmp, 'data');
const shellDir = path.join(repo, 'webapp');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'smoke',
      GIT_AUTHOR_EMAIL: 'smoke@test',
      GIT_COMMITTER_NAME: 'smoke',
      GIT_COMMITTER_EMAIL: 'smoke@test',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

fs.mkdirSync(remote, { recursive: true });
git(tmp, ['init', '--bare', remote]);

git(tmp, ['clone', remote, repo]);
fs.mkdirSync(path.join(shellDir), { recursive: true });
fs.writeFileSync(path.join(shellDir, 'index.html'), '<h1>v1</h1>\n');
fs.writeFileSync(path.join(shellDir, 'app.js'), 'console.log("v1");\n');
git(repo, ['add', '-A']);
git(repo, ['commit', '-m', 'v1']);
git(repo, ['branch', '-M', 'main']);
git(repo, ['push', '-u', 'origin', 'main']);
git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

const headV1 = git(repo, ['rev-parse', 'HEAD']);

process.env.APP_JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.DEPLOY_ENABLED = 'false';
process.env.DEPLOY_REPO_DIR = repo;
process.env.DEPLOY_GIT_BRANCH = 'main';
process.env.DEPLOY_GIT_REMOTE = 'origin';
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt');
process.env.BUNDLE_AUTOSYNC = 'false';

const { openDb, upsertUser } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { shellVersion } = await import('../src/bundleSync.js');
const { runDeploy, deployStatusFull } = await import('../src/deploySync.js');
const { resolveBundleRoot, copyDir, listBundleFiles } = await import('../src/bundle.js');

const db = openDb(dataDir);
upsertUser(db, {
  username: '84909990001',
  passwordHash: hashPassword('x'),
  folderPath: 'u1',
  version: 'old',
  phone: '84909990001',
  notifySite: 's',
  notifyDevice: 'd',
});
const bundleRoot = resolveBundleRoot(dataDir, 'u1');
copyDir(shellDir, bundleRoot);
assert.equal(fs.readFileSync(path.join(bundleRoot, 'index.html'), 'utf8').includes('v1'), true);

let fails = 0;
const ok = (c, l) => {
  if (!c) { fails++; console.error('FAIL', l); }
  else console.log('ok  ', l);
};

// 1) Tắt DEPLOY → từ chối
{
  const r = await runDeploy(db, { dataDir, shellDir }, { mode: 'webapp' });
  ok(r.error === 'deploy_disabled', 'disabled when DEPLOY_ENABLED=false');
}

process.env.DEPLOY_ENABLED = 'true';

// 2) Status thấy git
{
  const st = await deployStatusFull({ dataDir, shellDir });
  ok(st.enabled === true, 'status enabled');
  ok(st.repo?.available === true, 'repo available');
  ok(st.repo?.head === headV1.slice(0, 12), `head v1 (${st.repo?.head})`);
  ok(Boolean(st.shellVersion), `shellVersion ${st.shellVersion}`);
}

// 3) Đẩy v2 lên remote (clone khác)
git(tmp, ['clone', '-b', 'main', remote, other]);
fs.mkdirSync(path.join(other, 'webapp'), { recursive: true });
fs.writeFileSync(path.join(other, 'webapp', 'index.html'), '<h1>v2-deploy</h1>\n');
fs.writeFileSync(path.join(other, 'webapp', 'app.js'), 'console.log("v2");\n');
git(other, ['add', '-A']);
git(other, ['commit', '-m', 'v2']);
git(other, ['push', 'origin', 'main']);
const headV2 = git(other, ['rev-parse', 'HEAD']);
ok(headV2 !== headV1, 'remote advanced to v2');

// checkout vẫn ở v1 trước deploy
ok(git(repo, ['rev-parse', 'HEAD']) === headV1, 'local still v1 before deploy');
ok(fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8').includes('v1'), 'shell still v1');

// 4) Chạy deploy webapp
{
  const r = await runDeploy(db, { dataDir, shellDir }, { mode: 'webapp' });
  if (!r.ok) console.error('deploy detail', r);
  ok(r.ok === true && !r.error, `deploy ok (${r.error || r.detail || 'ok'})`);
  ok(r.after?.headFull === headV2 || r.after?.head === headV2.slice(0, 12), 'after head = v2');
  ok(r.bundlesUpdated >= 1, `bundlesUpdated=${r.bundlesUpdated}`);
  ok(fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8').includes('v2-deploy'), 'shell updated to v2');
  ok(fs.readFileSync(path.join(bundleRoot, 'index.html'), 'utf8').includes('v2-deploy'), 'user bundle updated to v2');
  const u = db.prepare('SELECT version FROM users WHERE username = ?').get('84909990001');
  const ver = shellVersion(shellDir);
  ok(u.version === ver, `user.version=${u.version} matches shell ${ver}`);
  ok(listBundleFiles(bundleRoot).some((f) => f.path === 'app.js'), 'bundle has app.js');
}

// 5) Deploy lần 2 (đã mới) vẫn ok
{
  const r = await runDeploy(db, { dataDir, shellDir }, { mode: 'webapp' });
  ok(r.ok === true, 'idempotent deploy ok');
}

// 6) Status last
{
  const st = await deployStatusFull({ dataDir, shellDir });
  ok(st.last?.ok === true, 'last.ok');
  ok(Array.isArray(st.last?.log) && st.last.log.length > 0, 'last.log has lines');
}

if (fails) {
  console.error(`smoke-deploy: ${fails} failed`);
  process.exit(1);
}
console.log('smoke-deploy: all passed');
