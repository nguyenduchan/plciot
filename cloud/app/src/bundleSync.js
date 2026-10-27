import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { listBundleFiles, resolveBundleRoot, copyDir } from './bundle.js';

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

export function syncBundles(db, { dataDir, shellDir }) {
  const version = shellVersion(shellDir);
  const stale = db.prepare("SELECT username, folder_path FROM users WHERE folder_path IS NOT NULL AND folder_path != '' AND version != ?").all(version);
  for (const u of stale) {
    const root = resolveBundleRoot(dataDir, u.folder_path);
    copyDir(shellDir, root);
    const keep = new Set(listBundleFiles(shellDir).map((f) => f.path));
    for (const f of listBundleFiles(root)) if (!keep.has(f.path)) fs.unlinkSync(path.join(root, f.path)); // file đã xoá khỏi webapp/
    db.prepare('UPDATE users SET version = ? WHERE username = ?').run(version, u.username);
    console.log(`bundle ${u.username} -> ${version}`);
  }
  return { version, updated: stale.length };
}

export function startBundleSync(db, opts, everyMs = 5000) {
  if (String(process.env.BUNDLE_AUTOSYNC || 'true').toLowerCase() === 'false') return;
  const run = () => { try { syncBundles(db, opts); } catch (e) { console.error('bundle sync', e.message); } };
  run();
  setInterval(run, everyMs).unref();
}
