/**
 * Giải pháp (kiểu giao diện) theo GATEWAY — mapping 1-1 webapp ↔ gateway:
 *   admin chọn giải pháp lúc phát mã ghép cặp (hoặc đổi sau trên trang Gateway) → lưu ở đây →
 *   (1) kit/config trả cho gateway có `solution` → GatewayApp hiện đúng giao diện của giải pháp đó;
 *   (2) user quét QR của gateway mà chưa đặt giải pháp → webapp của user tự map cùng giải pháp (xem adoptSolution).
 * Bảng riêng (không đụng bảng hardware_devices của gói security). Chuỗi rỗng / 'basic' = bản cơ bản.
 */
const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;

export const cleanSolution = (v) => {
  const s = String(v ?? '').trim();
  return s === '' || s === 'basic' ? '' : (ID_RE.test(s) ? s : null);   // null = sai định dạng
};

export function migrateGatewaySolutions(db) {
  db.exec('CREATE TABLE IF NOT EXISTS gateway_solutions (site TEXT NOT NULL, device TEXT NOT NULL, solution TEXT NOT NULL DEFAULT \'\', PRIMARY KEY (site, device))');
}

export function gatewaySolution(db, site, device) {
  try { migrateGatewaySolutions(db); return db.prepare('SELECT solution FROM gateway_solutions WHERE site = ? AND device = ?').get(site, device)?.solution || ''; } catch { return ''; }
}

export function setGatewaySolution(db, site, device, solution) {
  migrateGatewaySolutions(db);
  const s = cleanSolution(solution);
  if (s === null) return { error: 'invalid_solution', status: 400 };
  if (!s) db.prepare('DELETE FROM gateway_solutions WHERE site = ? AND device = ?').run(site, device);
  else db.prepare('INSERT INTO gateway_solutions (site, device, solution) VALUES (?, ?, ?) ON CONFLICT(site, device) DO UPDATE SET solution = excluded.solution').run(site, device, s);
  return { ok: true, solution: s };
}

export function allGatewaySolutions(db) {
  try { migrateGatewaySolutions(db); return new Map(db.prepare('SELECT site, device, solution FROM gateway_solutions').all().map((r) => [`${r.site}/${r.device}`, r.solution])); } catch { return new Map(); }
}

/* ---------- Giao diện của giải pháp dạng DỮ LIỆU cho gateway: solutions/<thư mục>/gateway/ui.json ----------
 * Kit (enroll / config / pair) kèm `ui` để GatewayApp (một bản dùng chung, không build riêng) vẽ đúng giao diện của giải pháp. */
import fs from 'node:fs';
import path from 'node:path';
import { folderOf, solutionDir, BASIC } from './solutions.js';

let shellDirCtx = process.env.WEBAPP_SRC || process.env.SHELL_DIR || '';
export const setSolutionsContext = (shellDir) => { shellDirCtx = shellDir; };
const uiCache = new Map();   // đường dẫn → { mtime, ui }

export function solutionUi(solution) {
  const id = cleanSolution(solution);
  if (!id || !shellDirCtx) return null;
  const folder = folderOf(shellDirCtx, id, 'gateway');   // thư mục gateway riêng: giải pháp có thể chỉ có webapp hoặc chỉ có gateway
  if (folder === BASIC) return null;
  const file = path.join(solutionDir(shellDirCtx, folder), 'gateway', 'ui.json');
  try {
    const st = fs.statSync(file);
    const hit = uiCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.ui;
    const ui = JSON.parse(fs.readFileSync(file, 'utf8'));
    uiCache.set(file, { mtime: st.mtimeMs, ui });
    return ui;
  } catch { return null; }
}
