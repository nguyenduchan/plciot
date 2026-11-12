/**
 * API trang kích hoạt gateway trên điện thoại (/activate.html) — mở ra Internet, nhưng KHÓA CHẶT:
 *   - phải đăng nhập tài khoản admin (requireAuth + requireAdmin, phiên đầy đủ);
 *   - MỌI lời gọi (kể cả chỉ xem danh sách) cần phiên điều khiển loại PASSKEY (Face ID / vân tay) còn hạn:
 *     không có Face ID (hoặc chỉ có TOTP / mật khẩu) thì không vào được;
 *   - thao tác ghi thêm `reauth` như các API admin khác + giới hạn tốc độ theo tài khoản + ghi audit.
 * Chỉ lộ đúng 5 việc của quy trình ghép cặp (tạo mã, danh sách, xem bản khai, duyệt, huỷ) — không lộ phần còn lại của /api/admin.
 * Tắt hẳn bằng ACTIVATE_OPEN=false (khi đó mọi đường dẫn trả 404).
 */
import { rateLimit, clientIp, audit, checkControlSession, getHardwareDeviceQr } from '@plciot/security';
import {
  createPairing, listPairings, getPairing, approvePairing, cancelPairing,
} from './gatewayPairing.js';

export function activateOpen() {
  return String(process.env.ACTIVATE_OPEN ?? 'true').toLowerCase() !== 'false';
}

/**
 * PHASE TEST: ACTIVATE_FACEID_DISABLED=true bỏ bắt buộc Face ID cho trang kích hoạt (vẫn phải đăng nhập admin + reauth như cấu hình server).
 * PRODUCTION: để false (mặc định). Với NODE_ENV=production cờ này bị BỎ QUA dù có đặt — không thể bỏ Face ID nhầm trên production.
 */
export function faceIdBypass() {
  return String(process.env.ACTIVATE_FACEID_DISABLED ?? 'false').toLowerCase() === 'true' && process.env.NODE_ENV !== 'production';
}

export function mountActivateApi(app, { db, requireAuth, requireAdmin, reauth }) {
  if (faceIdBypass()) console.warn('[activate] ⚠ ACTIVATE_FACEID_DISABLED=true: trang kích hoạt KHÔNG đòi Face ID (chỉ dùng khi test; production phải để false)');
  else if (String(process.env.ACTIVATE_FACEID_DISABLED).toLowerCase() === 'true') console.warn('[activate] ACTIVATE_FACEID_DISABLED bị bỏ qua vì NODE_ENV=production: Face ID vẫn bắt buộc');
  const killSwitch = (_req, res, next) => (activateOpen() ? next() : res.status(404).type('text/plain').send('Not found'));

  const fullScope = (req, res, next) => {
    if (req.tokenPayload?.scope && req.tokenPayload.scope !== 'full') return res.status(401).json({ error: 'login_step_up_required' });
    next();
  };

  /** Face ID bắt buộc: phiên điều khiển phải được mở bằng passkey (không chấp nhận TOTP / mật khẩu). */
  const requireFaceId = (req, res, next) => {
    if (faceIdBypass()) return next();   // PHASE TEST
    const c = checkControlSession(db, req.user.id, String(req.headers['x-control-token'] || ''), clientIp(req));
    if (c.ok && c.method === 'passkey') { req.faceId = c; return next(); }
    audit(db, 'activate_denied', { userId: req.user.id, ip: clientIp(req), detail: c.ok ? `method=${c.method}` : (c.reason || 'no_session') });
    return res.status(401).json({ error: 'faceid_required', reason: c.ok ? 'not_passkey' : c.reason });
  };

  const readLimit = rateLimit({
    windowMs: 60_000, max: Number(process.env.RATE_LIMIT_ACTIVATE_READ || 90),
    keyFn: (req) => `${clientIp(req)}:activate-r:${req.user?.id || 0}`,
  });
  const writeLimit = rateLimit({
    windowMs: 60_000, max: Number(process.env.RATE_LIMIT_ACTIVATE_WRITE || 15),
    keyFn: (req) => `${clientIp(req)}:activate-w:${req.user?.id || 0}`,
  });

  const read = [killSwitch, requireAuth, fullScope, requireAdmin, requireFaceId, readLimit];
  const write = [killSwitch, requireAuth, fullScope, requireAdmin, requireFaceId, writeLimit, reauth];
  const send = (res, r) => res.status(r?.error ? r.status || 400 : 200).json(r);

  // Trạng thái phiên Face ID cho trang (để hiện đếm ngược / yêu cầu mở khoá) — cũng cần đăng nhập admin
  app.get('/api/activate/status', killSwitch, requireAuth, fullScope, requireAdmin, (req, res) => {
    const c = checkControlSession(db, req.user.id, String(req.headers['x-control-token'] || ''), clientIp(req));
    const bypass = faceIdBypass();
    res.json({ open: true, bypass, faceId: bypass || Boolean(c.ok && c.method === 'passkey'), expiresAt: !bypass && c.ok ? c.expiresAt : null, reason: c.ok ? null : c.reason });
  });

  app.get('/api/activate/pairings', ...read, (_req, res) => {
    const sites = db.prepare('SELECT DISTINCT site FROM hardware_devices ORDER BY site LIMIT 50').all().map((r) => r.site);
    res.json({ pairings: listPairings(db).filter((p) => ['open', 'received', 'approved'].includes(p.status)).slice(0, 30), sites });
  });

  app.get('/api/activate/pairings/:id', ...read, (req, res) => send(res, getPairing(db, req.params.id)));

  app.post('/api/activate/pairings', ...write, (req, res) => {
    const r = createPairing(db, {
      adminId: req.user.id, label: req.body?.label, ttlMin: req.body?.ttlMin,
      site: req.body?.site, device: req.body?.device, auto: req.body?.auto,
    });
    if (!r.error) audit(db, 'pairing_create', { userId: req.user.id, ip: clientIp(req), detail: `${r.id} (activate)` });
    send(res, r);
  });

  app.post('/api/activate/pairings/:id/approve', ...write, (req, res) => {
    const r = approvePairing(db, {
      id: req.params.id, site: req.body?.site, device: req.body?.device, label: req.body?.label,
    });
    if (r.error) return send(res, r);
    audit(db, 'pairing_approve', { userId: req.user.id, ip: clientIp(req), detail: `${r.pairingId} → ${r.site}/${r.device} (activate)` });
    // Chỉ trả những gì trang cần: QR + link. Không trả kit MQTT.
    res.json({
      ok: true, pairingId: r.pairingId, site: r.site, device: r.device, label: r.label || null, qr: r.qr, loginUrl: r.loginUrl,
    });
  });

  // QR của tem đã duyệt (để user quét): cần Face ID như mọi API khác của trang
  app.get('/api/activate/pairings/:id/qr', ...read, (req, res) => {
    const p = getPairing(db, req.params.id);
    if (p.error) return send(res, p);
    if (p.status !== 'approved' || !p.site || !p.device) return send(res, { error: 'pairing_not_approved', status: 409 });
    const q = getHardwareDeviceQr(db, { site: p.site, device: p.device });
    if (q.error) return send(res, q);
    audit(db, 'pairing_qr_view', { userId: req.user.id, ip: clientIp(req), detail: `${p.site}/${p.device} (activate)` });
    res.json({ ok: true, site: p.site, device: p.device, label: p.label || null, qr: q.qr, loginUrl: q.loginUrl });
  });

  app.delete('/api/activate/pairings/:id', ...write, (req, res) => {
    const r = cancelPairing(db, req.params.id);
    if (!r.error) audit(db, 'pairing_cancel', { userId: req.user.id, ip: clientIp(req), detail: `${req.params.id} (activate)` });
    send(res, r);
  });
}
