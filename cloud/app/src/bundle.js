import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SKIP = new Set(['.ds_store', 'thumbs.db']);

export function resolveBundleRoot(dataDir, folderPath) {
  const root = path.resolve(dataDir, 'bundles');
  const abs = path.resolve(root, folderPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error('Invalid folder_path');
  }
  return abs;
}

export function safeJoin(root, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.split('/').some((p) => p === '..')) {
    return null;
  }
  const abs = path.resolve(root, cleaned);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name.toLowerCase())) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push({ path: rel, full, size: st.size, mtimeMs: st.mtimeMs });
  }
}

/** Băm từng file được nhớ theo (đường dẫn, mtime, kích thước): kiểm tra bản webapp mới mỗi lần tải lại trang chỉ tốn một lần stat/file, file nào đổi mới đọc + băm lại. */
const hashCache = new Map();   // full -> { mtimeMs, size, hash }
export function listBundleFiles(bundleRoot) {
  if (!fs.existsSync(bundleRoot)) return [];
  const files = [];
  walk(bundleRoot, bundleRoot, files);
  if (hashCache.size > 20_000) hashCache.clear();
  return files.map(({ path: p, full, size, mtimeMs }) => {
    const c = hashCache.get(full);
    if (c && c.mtimeMs === mtimeMs && c.size === size) return { path: p, size, hash: c.hash };
    const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
    hashCache.set(full, { mtimeMs, size, hash });
    return { path: p, size, hash };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

export function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name.toLowerCase())) continue;
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}
