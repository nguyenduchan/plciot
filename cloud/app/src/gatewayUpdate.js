import fs from 'fs';
import path from 'path';

/**
 * Cập nhật GatewayApp: gateway hỏi bản mới nhất rồi tự tải về.
 * Bản build do máy lập trình tạo (cloud/scripts/publish-gateway.ps1) và đẩy lên VPS cùng sync-vps → releases/gateway/{manifest.json, GatewayApp-<version>.zip}.
 *   GET /api/gateway/update           → { version, size, sha256, sig, builtAt }   (404 nếu chưa có bản)
 *   GET /api/gateway/update/download  → file zip
 * Công khai (file chỉ là chương trình, không chứa cấu hình/khoá). `sig` = chữ ký ECDSA của máy phát hành (sign-gateway-release.js);
 * gateway kiểm chữ ký bằng khoá công khai gắn cứng (UpdateSignature.cs) — server KHÔNG giữ khoá ký, chiếm server cũng không phát được bản lạ.
 */
/**
 * Mức tương thích gateway ↔ server. TĂNG khi đổi KHÔNG tương thích ngược (đổi định dạng kit/config/MQTT mà gateway cũ không hiểu).
 * - Gateway build ra mang `apiLevel` (hằng AppUpdate.ApiLevel trong tools/GatewayApp) → manifest. Gateway cần mức cao hơn server đang chạy thì server KHÔNG phát bản đó (409) — tránh cài bản mà server chưa hiểu.
 * - Bản gateway có apiLevel cao hơn bản đang chạy = cập nhật BẮT BUỘC (gateway cũ không còn chạy đúng với server mới).
 * Đổi nhỏ, tương thích ngược → giữ nguyên số. DB server tự migrate khi khởi động (db.js), nên cập nhật server luôn đi TRƯỚC/CÙNG bản gateway (sync-vps.ps1 kiểm lại sau khi deploy).
 */
export const GATEWAY_API_LEVEL = 1;

const ZIP_RE = /^GatewayApp-[0-9a-f]{6,32}\.zip$/;

export function readGatewayRelease(releasesDir) {
  try {
    const dir = path.join(releasesDir, 'gateway');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (!/^[0-9a-f]{6,32}$/.test(String(m.version)) || !ZIP_RE.test(String(m.file))) return null;
    const zip = path.join(dir, m.file);
    if (!fs.existsSync(zip)) return null;
    return { version: m.version, apiLevel: Number(m.apiLevel) || 1, sha256: String(m.sha256 || ''), sig: String(m.sig || ''), size: fs.statSync(zip).size, builtAt: m.builtAt || null, zip };
  } catch { return null; }
}

export function mountGatewayUpdate(app, { releasesDir }) {
  app.get('/api/gateway/update', (_req, res) => {
    const r = readGatewayRelease(releasesDir);
    if (!r) return res.status(404).json({ error: 'no_release' });
    if (r.apiLevel > GATEWAY_API_LEVEL) return res.status(409).json({ error: 'server_outdated', apiLevel: r.apiLevel, serverApiLevel: GATEWAY_API_LEVEL });
    res.json({ version: r.version, apiLevel: r.apiLevel, serverApiLevel: GATEWAY_API_LEVEL, size: r.size, sha256: r.sha256, sig: r.sig, builtAt: r.builtAt });
  });
  app.get('/api/gateway/update/download', (_req, res) => {
    const r = readGatewayRelease(releasesDir);
    if (!r) return res.status(404).json({ error: 'no_release' });
    if (r.apiLevel > GATEWAY_API_LEVEL) return res.status(409).json({ error: 'server_outdated' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(r.size));
    res.setHeader('Content-Disposition', `attachment; filename="GatewayApp-${r.version}.zip"`);
    fs.createReadStream(r.zip).on('error', () => res.destroy()).pipe(res);
  });
}

/**
 * Ghi lại phiên bản gateway đang nối (gateway gửi X-Gateway-Version / X-Gateway-Api khi lấy cấu hình).
 * Cho biết còn gateway nào chạy bản/mức tương thích cũ để server giữ hành vi cũ cho đến khi tất cả đã cập nhật.
 */
export function recordGatewayClient(db, site, device, headers) {
  try {
    const v = String(headers?.['x-gateway-version'] || '').slice(0, 32);
    const api = Number.parseInt(headers?.['x-gateway-api'], 10);
    if (!site || !device || !/^[0-9a-z._-]{1,32}$/i.test(v)) return;
    const now = Date.now();
    const bk = Number.parseInt(headers?.['x-gateway-backup'], 10);   // giây epoch; không gửi = giữ giá trị cũ
    const backupMs = Number.isFinite(bk) && bk > 0 && bk * 1000 <= now + 86_400_000 ? bk * 1000 : null;
    db.prepare(`INSERT INTO gateway_clients (site, device, version, api_level, first_seen, last_seen, last_backup_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, device) DO UPDATE SET version = excluded.version, api_level = COALESCE(excluded.api_level, gateway_clients.api_level), last_seen = excluded.last_seen,
        last_backup_at = COALESCE(excluded.last_backup_at, gateway_clients.last_backup_at)`)
      .run(String(site), String(device), v, Number.isFinite(api) ? api : null, now, now, backupMs);
  } catch { /* chỉ thống kê: không bao giờ làm hỏng việc cấp cấu hình */ }
}
