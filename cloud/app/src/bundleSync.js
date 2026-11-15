import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { listBundleFiles, resolveBundleRoot } from './bundle.js';
import { solutionOf, solutionVersion, writeSolution } from './solutions.js';

/**
 * Giữ bundle của mọi user bằng đúng mã nguồn webapp trên PC: sửa webapp/ là điện thoại tự nhận bản mới.
 * `version` của user = băm nội dung webapp/, nên điện thoại chỉ cần so version (boot.js) để biết có bản mới.
 * Đặt BUNDLE_AUTOSYNC=false nếu cố ý sửa tay bundle của riêng một user (nếu không, lần quét kế sẽ ghi đè).
 */
export function shellVersion(shellDir) {
  const h = crypto.createHash('sha256');
  for (const f of listBundleFiles(shellDir)) h.update(`${f.path}:${f.hash}\n`);
  return h.digest('hex').slice(0, 12);
}

export function syncBundles(db, { dataDir, shellDir }, { force = false } = {}) {
  const version = shellVersion(shellDir);   // phiên bản của shell cơ bản (giữ nguyên ý nghĩa cũ cho deploy/status)
  const users = db.prepare("SELECT username, folder_path, version, solution FROM users WHERE folder_path IS NOT NULL AND folder_path != ''").all();
  const vers = new Map();
  let updated = 0;
  for (const u of users) {
    const sol = solutionOf(shellDir, u);
    if (!vers.has(sol)) vers.set(sol, solutionVersion(shellDir, sol));
    const v = vers.get(sol);
    if (!force && u.version === v) continue;
    writeSolution(shellDir, sol, resolveBundleRoot(dataDir, u.folder_path));
    db.prepare('UPDATE users SET version = ? WHERE username = ?').run(v, u.username);
    updated++;
    console.log(`bundle ${u.username} [${sol}] -> ${v}`);
  }
  return { version, updated };
}

export function startBundleSync(db, opts, everyMs = 5000) {
  if (String(process.env.BUNDLE_AUTOSYNC || 'true').toLowerCase() === 'false') return;
  const run = () => { try { syncBundles(db, opts); } catch (e) { console.error('bundle sync', e.message); } };
  run();
  setInterval(run, everyMs).unref();
}
