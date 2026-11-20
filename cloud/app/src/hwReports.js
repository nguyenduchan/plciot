/**
 * Chủ gateway BÁO MẤT TRỘM từ webapp (hwBlock.js): khoá tạm ngay, admin duyệt hoặc từ chối.
 *   POST /api/gateway/lost { gw:"site/device", reason }   — cần đăng nhập + step-up (TOTP/Face ID) như lệnh điều khiển; chỉ gateway của chính user
 *   GET  /api/gateway/lost                                 — báo cáo của user (trạng thái: pending | approved | rejected | cancelled | released)
 *   POST /api/gateway/lost/:id/cancel                      — tìm lại máy / báo nhầm: huỷ báo cáo CHƯA duyệt → mở khoá
 * Admin: GET /api/admin/hw-reports · POST /api/admin/hw-reports/:id/(approve|reject) { note } (adminOps.js).
 */
import { rateLimit, clientIp, audit } from '@plciot/security';
import { gatewaysOfUser } from './mqttIds.js';
import { reportLost, listReports, cancelReport } from './hwBlock.js';

export function mountHwReports(app, { db, requireAuth, security }) {
  const { authorize } = security;
  const limit = rateLimit({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_HW_REPORT || 10), keyFn: (req) => `${clientIp(req)}:hwreport:${req.user?.id || 'na'}` });
  const out = (res, status, b) => res.status(status).json(b);

  app.post('/api/gateway/lost', requireAuth, limit, (req, res) => {
    const gw = typeof req.body?.gw === 'string' ? req.body.gw.trim() : '';
    const mine = gatewaysOfUser(db, req.user).find((g) => `${g.site}/${g.device}` === gw);
    if (!mine) return out(res, 403, { error: 'forbidden_gateway' });
    const a = authorize(req);   // cùng mức xác thực với lệnh điều khiển: không có yếu tố thứ hai thì không khoá được (chống người cầm điện thoại đang mở)
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `lost_report ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const r = reportLost(db, { userId: req.user.id, site: mine.site, device: mine.device, reason: req.body?.reason });
    if (r.error) return out(res, r.status || 400, r);
    audit(db, 'gateway_lost_report', { userId: req.user.id, ip: clientIp(req), detail: `#${r.report.id} ${gw} ${r.report.hw}` });
    res.json(r);
  });

  app.get('/api/gateway/lost', requireAuth, (req, res) => res.json({ reports: listReports(db, { userId: req.user.id }) }));

  app.post('/api/gateway/lost/:id/cancel', requireAuth, limit, (req, res) => {
    const a = authorize(req);
    if (a.error) return out(res, a.status || 401, a);
    const r = cancelReport(db, Number(req.params.id), req.user.id);
    if (r.error) return out(res, r.status || 400, r);
    audit(db, 'gateway_lost_cancel', { userId: req.user.id, ip: clientIp(req), detail: `#${r.report.id} ${r.report.hw}` });
    res.json(r);
  });
}
