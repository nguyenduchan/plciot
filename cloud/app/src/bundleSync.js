import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { listBundleFiles, resolveBundleRoot } from './bundle.js';
import { folderOf, userBundleVersion, writeUserBundle, defaultSolution, BASIC } from './solutions.js';
import { gatewaysOfUser } from './mqttIds.js';
import { gatewaySolution } from './gatewaySolution.js';

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

/** Giải pháp (id) của các gateway user đang dùng — loại webapp do gateway quyết định. Gateway chưa đặt → DEFAULT_SOLUTION (mặc định cơ bản). */
export function userSolutionIds(db, user, shellDir) {
  const ids = new Set();
  for (const g of gatewaysOfUser(db, user)) {
    const id = gatewaySolution(db, g.site, g.device) || defaultSolution();
    if (id !== BASIC && folderOf(shellDir, id) !== BASIC) ids.add(id);
  }
  return [...ids].sort();
}

/** Dựng lại bundle của một user theo gateway của họ (gọi sau khi thêm/gỡ gateway hoặc đổi giải pháp gateway). */
export function refreshUserBundle(db, user, { dataDir, shellDir }) {
  if (!user?.folder_path) return null;
  const ids = userSolutionIds(db, user, shellDir);
  const v = userBundleVersion(shellDir, ids);
  if (user.version !== v) {
    writeUserBundle(shellDir, ids, resolveBundleRoot(dataDir, user.folder_path));
    db.prepare('UPDATE users SET version = ? WHERE id = ?').run(v, user.id);
  }
  return { version: v, ids };
}

export function syncBundles(db, { dataDir, shellDir }, { force = false } = {}) {
  const version = shellVersion(shellDir);   // phiên bản của shell cơ bản (giữ nguyên ý nghĩa cũ cho deploy/status)
  const users = db.prepare("SELECT * FROM users WHERE folder_path IS NOT NULL AND folder_path != ''").all();
  const vers = new Map();
  let updated = 0;
  for (const u of users) {
    const ids = userSolutionIds(db, u, shellDir);
    const key = ids.join(',');
    if (!vers.has(key)) vers.set(key, userBundleVersion(shellDir, ids));
    const v = vers.get(key);
    if (!force && u.version === v) continue;
    writeUserBundle(shellDir, ids, resolveBundleRoot(dataDir, u.folder_path));
    db.prepare('UPDATE users SET version = ? WHERE username = ?').run(v, u.username);
    updated++;
    console.log(`bundle ${u.username} [${key || BASIC}] -> ${v}`);
  }
  return { version, updated };
}

/**
 * Gọi khi người dùng tải lại / mở webapp (/api/me): so mã nguồn webapp hiện tại với bundle của họ NGAY (không chờ chu kỳ quét), dựng lại nếu khác.
 * Nhờ vậy sau khi sync webapp lên VPS, tải lại trang là thấy bản mới (client so version rồi tải lại các file đổi).
 * Trả user đã cập nhật (version mới) hoặc user cũ nếu không cần/không làm được.
 */
export function ensureUserBundleFresh(db, user, opts) {
  try {
    if (!user?.folder_path) return user;
    const r = refreshUserBundle(db, user, opts);
    return r && r.version !== user.version ? { ...user, version: r.version } : user;
  } catch (e) {
    console.warn('ensureUserBundleFresh', e.message);
    return user;
  }
}

export function startBundleSync(db, opts, everyMs = Math.max(2000, Number(process.env.BUNDLE_SYNC_MS) || 5000)) {
  if (String(process.env.BUNDLE_AUTOSYNC || 'true').toLowerCase() === 'false') return;
  const run = () => { try { syncBundles(db, opts); } catch (e) { console.error('bundle sync', e.message); } };
  run();
  setInterval(run, everyMs).unref();
}
