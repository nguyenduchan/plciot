/**
 * Đồng bộ mã nguồn từ GitHub rồi cập nhật bundle webapp (+ tuỳ chọn rebuild container app).
 * Cần: DEPLOY_ENABLED=true, mount repo tại DEPLOY_REPO_DIR, có `git` trong image.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { syncBundles, shellVersion } from './bundleSync.js';

const execFileAsync = promisify(execFile);

let busy = false;
let last = {
  at: null,
  ok: null,
  mode: null,
  before: null,
  after: null,
  bundleVersion: null,
  bundlesUpdated: 0,
  rebuild: null,
  error: null,
  log: [],
};

function enabled() {
  return String(process.env.DEPLOY_ENABLED || 'false').toLowerCase() === 'true';
}

function repoDir() {
  return path.resolve(process.env.DEPLOY_REPO_DIR || '/repo');
}

function branch() {
  return String(process.env.DEPLOY_GIT_BRANCH || 'main').trim() || 'main';
}

function remote() {
  return String(process.env.DEPLOY_GIT_REMOTE || 'origin').trim() || 'origin';
}

function composeFile() {
  return process.env.DEPLOY_COMPOSE_FILE
    || path.join(repoDir(), 'cloud', 'docker-compose.yml');
}

function composeProject() {
  return process.env.DEPLOY_COMPOSE_PROJECT || 'plciot';
}

function appService() {
  return process.env.DEPLOY_APP_SERVICE || 'app';
}

function pushLog(line) {
  const s = String(line || '').slice(0, 500);
  last.log = [...(last.log || []).slice(-40), s];
  console.log('[deploy]', s);
}

async function git(args, cwd = repoDir()) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (stderr && /error|fatal/i.test(stderr) && !stdout) {
    throw new Error(stderr.trim().slice(0, 300));
  }
  return String(stdout || '').trim();
}

async function gitInfo() {
  const dir = repoDir();
  if (!fs.existsSync(path.join(dir, '.git'))) {
    return { available: false, error: 'repo_not_mounted', dir };
  }
  try {
    const [head, remoteHead, status, describe] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      git(['rev-parse', `${remote()}/${branch()}`]).catch(() => null),
      git(['status', '--porcelain']),
      git(['log', '-1', '--pretty=format:%h %s (%cr)']),
    ]);
    return {
      available: true,
      dir,
      branch: branch(),
      remote: remote(),
      head: head.slice(0, 12),
      headFull: head,
      remoteHead: remoteHead ? remoteHead.slice(0, 12) : null,
      behind: remoteHead && remoteHead !== head,
      dirty: Boolean(status),
      describe,
    };
  } catch (e) {
    return { available: false, error: e.message || 'git_error', dir };
  }
}

async function runRebuild() {
  const file = composeFile();
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'compose_file_missing', file };
  }
  // Path compose phải trùng path trên Docker host (đặt DEPLOY_REPO_HOST tuyệt đối trên VPS)
  const cwd = path.dirname(file);
  try {
    pushLog(`docker compose -f ${file} up -d --build --no-deps ${appService()}`);
    await execFileAsync('docker', [
      'compose', '-p', composeProject(), '-f', file,
      'up', '-d', '--build', '--no-deps', appService(),
    ], {
      cwd,
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env },
    });
    pushLog('rebuild done (container may restart)');
    return { ok: true, via: 'docker_compose' };
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || 'rebuild_failed').toString().slice(0, 400);
    pushLog(`rebuild failed: ${msg}`);
    pushLog('Webapp đã sync; backend: SSH rồi `docker compose up -d --build app`');
    return { ok: false, error: msg };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ dataDir: string, shellDir: string }} paths
 * @param {{ mode?: 'webapp'|'full', userId?: number }} opts
 */
export async function runDeploy(db, paths, opts = {}) {
  if (!enabled()) return { error: 'deploy_disabled', status: 403 };
  if (busy) return { error: 'deploy_busy', status: 409 };
  const mode = opts.mode === 'full' ? 'full' : 'webapp';
  busy = true;
  last = {
    at: Date.now(), ok: null, mode, before: null, after: null,
    bundleVersion: null, bundlesUpdated: 0, rebuild: null, error: null, log: [],
  };
  try {
    pushLog(`start mode=${mode}`);
    const before = await gitInfo();
    last.before = before;
    if (!before.available) {
      throw new Error(before.error || 'repo_unavailable');
    }

    pushLog(`fetch ${remote()} ${branch()}`);
    await git(['fetch', '--prune', remote(), branch()]);
    pushLog(`reset --hard ${remote()}/${branch()}`);
    await git(['reset', '--hard', `${remote()}/${branch()}`]);

    const after = await gitInfo();
    last.after = after;
    pushLog(`now ${after.describe || after.head}`);

    // webapp/ đã cập nhật trên volume → đồng bộ mọi user bundle (version hash đổi → client tải lại)
    const shellDir = paths.shellDir;
    if (!fs.existsSync(shellDir)) throw new Error('shell_dir_missing');
    const sync = syncBundles(db, { dataDir: paths.dataDir, shellDir }, { force: true });
    last.bundleVersion = sync.version;
    last.bundlesUpdated = sync.updated;
    pushLog(`bundles synced version=${sync.version} users=${sync.updated}`);

    if (mode === 'full') {
      // Trả response trước; rebuild có thể kill chính container này
      setTimeout(() => {
        runRebuild().then((r) => {
          last.rebuild = r;
          last.ok = r.ok !== false;
          if (!r.ok) last.error = r.error;
          busy = false;
        }).catch((e) => {
          last.rebuild = { ok: false, error: e.message };
          last.ok = false;
          last.error = e.message;
          busy = false;
        });
      }, 800);
      last.ok = true;
      last.rebuild = { ok: true, pending: true };
      // giữ busy=true đến khi rebuild xong hoặc process chết
      return {
        ok: true,
        mode,
        pendingRebuild: true,
        before,
        after,
        bundleVersion: sync.version,
        bundlesUpdated: sync.updated,
        hint: 'Server đang rebuild; chờ ~1–2 phút rồi refresh. User mở app sẽ tự tải bundle mới.',
      };
    }

    last.ok = true;
    busy = false;
    return {
      ok: true,
      mode,
      before,
      after,
      bundleVersion: sync.version,
      bundlesUpdated: sync.updated,
      hint: 'Webapp đã cập nhật. User refresh / mở lại app sẽ tải bản mới (version đổi).',
    };
  } catch (e) {
    last.ok = false;
    last.error = e.message || String(e);
    pushLog(`error: ${last.error}`);
    busy = false;
    return { error: 'deploy_failed', detail: last.error, status: 500, last };
  }
}

export function deployStatus(paths) {
  return {
    enabled: enabled(),
    busy,
    last,
    repo: null, // filled async by caller or sync peek
    shellVersion: (() => {
      try {
        return fs.existsSync(paths.shellDir) ? shellVersion(paths.shellDir) : null;
      } catch {
        return null;
      }
    })(),
    config: {
      repoDir: repoDir(),
      branch: branch(),
      remote: remote(),
      composeFile: composeFile(),
      appService: appService(),
    },
  };
}

export async function deployStatusFull(paths) {
  const base = deployStatus(paths);
  base.repo = enabled() ? await gitInfo() : { available: false, error: 'deploy_disabled' };
  return base;
}
