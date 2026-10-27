import { rateLimit, clientIp, createPairCode, revokeStation } from '@plciot/security';
import {
  siteInfo, isSiteOwner, startClaim, checkClaim, createInvite, cancelInvite, answerInvite, removeMember, sweepInvites,
} from './sites.js';

/**
 * Quản lý nhà máy tự phục vụ. Thao tác của CHỦ SITE (mời/gỡ/ghép PC/thu hồi PC) đi qua `reauth`
 * (vân tay/Authenticator) vì chúng cấp quyền điều khiển máy móc.
 */
export function mountSite(app, { db, requireAuth, reauth }) {
  const limit = rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_SITE || 20),
    keyFn: (req) => `${clientIp(req)}:site:${req.user?.id || 'na'}`,
  });
  const send = (res, r) => (r.error ? res.status(r.status || 400).json(r) : res.json(r));
  const needOwner = (req, res, next) => (isSiteOwner(db, req.user) ? next() : res.status(403).json({ error: 'not_site_owner' }));
  const ip = (req) => clientIp(req);

  app.get('/api/site', requireAuth, (req, res) => { sweepInvites(db); res.json(siteInfo(db, req.user)); });

  /* nhận thiết bị chưa có chủ — chứng minh đang ở cạnh PLC */
  app.post('/api/site/claim/start', requireAuth, limit, reauth, (req, res) => {
    send(res, startClaim(db, req.user, { site: req.body?.site, device: req.body?.device, ip: ip(req) }));
  });
  app.post('/api/site/claim/check', requireAuth, limit, (req, res) => send(res, checkClaim(db, req.user, { ip: ip(req) })));

  /* lời mời */
  app.post('/api/site/invites', requireAuth, limit, needOwner, reauth, async (req, res) => {
    send(res, await createInvite(db, req.user, { phone: req.body?.phone, role: req.body?.role, ip: ip(req) }));
  });
  app.delete('/api/site/invites/:id', requireAuth, limit, needOwner, (req, res) => send(res, cancelInvite(db, req.user, req.params.id, { ip: ip(req) })));
  app.post('/api/invites/:id/accept', requireAuth, limit, (req, res) => send(res, answerInvite(db, req.user, req.params.id, true, { ip: ip(req) })));
  app.post('/api/invites/:id/decline', requireAuth, limit, (req, res) => send(res, answerInvite(db, req.user, req.params.id, false, { ip: ip(req) })));
  app.delete('/api/site/members/:id', requireAuth, limit, needOwner, reauth, (req, res) => send(res, removeMember(db, req.user, req.params.id, { ip: ip(req) })));

  /* ghép / thu hồi PC nhà máy */
  app.post('/api/site/pair-code', requireAuth, limit, needOwner, reauth, (req, res) => {
    const me = db.prepare('SELECT notify_site, notify_device FROM users WHERE id = ?').get(req.user.id);
    res.json({ ok: true, ...createPairCode(db, req.user, { name: req.body?.name, site: me.notify_site, device: me.notify_device }) });
  });
  app.delete('/api/site/stations/:id', requireAuth, limit, needOwner, reauth, (req, res) => {
    const me = db.prepare('SELECT notify_site, notify_device FROM users WHERE id = ?').get(req.user.id);
    send(res, revokeStation(db, req.user, req.params.id, { site: me.notify_site, device: me.notify_device, ip: ip(req) }));
  });
}
