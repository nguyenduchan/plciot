/**
 * Phần điều khiển RIÊNG của app PLC: nhận lệnh ghi/đọc thanh ghi, kiểm tra whitelist + khoảng giá trị, nút vật lý,
 * rồi publish qua MQTT. Mọi xác thực (Passkey/TOTP, khoá điều khiển, PC ghép cặp) do @plciot/security đảm nhiệm.
 */
import crypto from 'crypto';
import { rateLimit, clientIp, audit, enrollState, checkControlSession, factorSummary } from '@plciot/security';
import { canControl } from './roles.js';
import { edgeSince } from './plcProof.js';
import { publishCmd } from './controlPublisher.js';
import { isOpsOpen } from './opsFlags.js';
import { plcControlConfig, validateCmd } from './plcCommands.js';
import { controlConfigFor } from './profiles.js';
import { resolveDeviceForUser } from './tenants.js';
import { DEFAULT_TENANT, preferredNamespace, LEGACY_NS } from './contract.js';
import { mayRemoteControl } from './entitlements.js';

/** @param security giá trị trả về của mountSecurityRoutes(): { authorize, stationAuth, stationLimit, ... } */
export function mountPlcControl(app, { db, requireAuth, security }) {
  const { authorize, stationAuth: sAuth, stationLimit } = security;
  const pendingConfirm = new Map(); // id -> { userId, site, device, cmd, bit, since, expires }
  const commandChallenges = new Map();
  const out = (res, status, b) => res.status(status).json(b);
  const cmdLimit = rateLimit({
    windowMs: 10_000,
    max: Number(process.env.RATE_LIMIT_CONTROL_CMD || 20),
    keyFn: (req) => `${clientIp(req)}:ctlcmd:${req.user?.id || 'na'}`,
  });

  function configForUser(user) {
    const dev = resolveDeviceForUser(db, user);
    return controlConfigFor(dev?.profile) || plcControlConfig();
  }

  function publishOpts(user) {
    const dev = resolveDeviceForUser(db, user);
    return {
      tenant: user.tenant_id || dev?.tenant_id || DEFAULT_TENANT,
      ns: dev?.topic_ns || preferredNamespace() || LEGACY_NS,
    };
  }

  async function dispatch(user, cmd, via, ip) {
    await publishCmd(user.notify_site, user.notify_device, cmd, publishOpts(user));
    audit(db, 'control_cmd', { userId: user.id, ip, detail: `${via} ${cmd.op || 'w'} a=${cmd.a} ${cmd.v ?? cmd.n ?? ''}` });
  }

  app.post('/api/control/cmd', requireAuth, cmdLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return out(res, 503, { error: 'remote_control_paused' });
    }
    const cfg = configForUser(req.user);
    if (!canControl(req.user)) return out(res, 403, { error: 'forbidden' });
    const v = validateCmd(req.body, cfg);
    if (v.error) return out(res, 400, v);
    const ip = clientIp(req);
    let via = 'read';
    if (v.write) {
      const ent = mayRemoteControl(req.user, { ip });
      if (!ent.ok) {
        audit(db, 'control_denied', { userId: req.user.id, ip, detail: `entitlement ${ent.reason}` });
        return out(res, 403, { error: 'subscription_denied', reason: ent.reason });
      }
      const es = enrollState(db, req.user);
      if (es.locked) {
        audit(db, 'control_denied', { userId: req.user.id, ip, detail: `enroll_required a=${v.cmd.a}` });
        return out(res, 403, { error: 'enroll_required', deadline: es.deadline });
      }
      const a = authorize(req);
      if (a.error && (!v.critical || !a.methods?.enrolled)) {
        audit(db, 'control_denied', { userId: req.user.id, ip, detail: `${a.reason} a=${v.cmd.a}` });
        return out(res, a.status, a);
      }
      via = a.via || 'pending';
      if (v.critical && a.via !== 'station') {
        const now = Date.now();
        for (const [id, challenge] of commandChallenges) if (challenge.expires <= now) commandChallenges.delete(id);
        const challengeId = String(req.headers['x-command-challenge'] || '');
        const challenge = commandChallenges.get(challengeId);
        const proof = checkControlSession(db, req.user.id, String(req.headers['x-control-token'] || ''), ip);
        const fingerprint = JSON.stringify([req.user.notify_site, req.user.notify_device, v.cmd]);
        if (!challenge || challenge.userId !== req.user.id || challenge.sessionId !== req.tokenPayload?.sid
          || challenge.fingerprint !== fingerprint || !proof.ok || proof.commandId !== challengeId) {
          if (commandChallenges.size >= 1000) return out(res, 429, { error: 'rate_limited' });
          const id = crypto.randomBytes(16).toString('hex');
          commandChallenges.set(id, { userId: req.user.id, sessionId: req.tokenPayload?.sid, fingerprint, expires: now + 60_000 });
          const factors = factorSummary(db, req.user.id);
          return out(res, 401, {
            error: 'step_up_required', reason: 'critical_command', commandChallenge: id,
            methods: { passkey: factors.passkeys > 0, totp: factors.totp, enrolled: factors.passkeys > 0 || factors.totp },
            command: v.cmd, target: { site: req.user.notify_site, device: req.user.notify_device },
          });
        }
        commandChallenges.delete(challengeId);
        via = proof.method;
      }
      if (v.critical && cfg.physicalBit !== null) {
        const id = crypto.randomBytes(8).toString('hex');
        pendingConfirm.set(id, {
          userId: req.user.id, site: req.user.notify_site, device: req.user.notify_device,
          cmd: v.cmd, via, sessionId: req.tokenPayload?.sid, controlToken: String(req.headers['x-control-token'] || ''),
          bit: cfg.physicalBit, since: Date.now(), expires: Date.now() + cfg.physicalWaitMs,
        });
        audit(db, 'control_pending_physical', { userId: req.user.id, ip, detail: `a=${v.cmd.a}` });
        return out(res, 202, { pending: true, confirmId: id, bit: cfg.physicalBit, expiresIn: cfg.physicalWaitMs / 1000, id: v.cmd.id });
      }
    }
    try {
      await dispatch(req.user, v.cmd, via, ip);
    } catch (e) {
      return out(res, 503, { error: 'mqtt_unavailable' });
    }
    res.json({ ok: true, id: v.cmd.id, via });
  });

  /** Client hỏi lại sau khi bấm nút vật lý; lệnh chỉ phát khi PLC báo cạnh tín hiệu mới ở ngõ vào đó. */
  app.get('/api/control/confirm/:id', requireAuth, cmdLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return out(res, 503, { error: 'remote_control_paused' });
    }
    const p = pendingConfirm.get(req.params.id);
    if (!p || p.userId !== req.user.id) return out(res, 404, { error: 'not_found' });
    if (!canControl(req.user) || p.sessionId !== req.tokenPayload?.sid || p.site !== req.user.notify_site || p.device !== req.user.notify_device) {
      pendingConfirm.delete(req.params.id);
      return out(res, 403, { error: 'forbidden' });
    }
    if (p.via !== 'station' && !checkControlSession(db, req.user.id, p.controlToken, clientIp(req)).ok) {
      pendingConfirm.delete(req.params.id);
      return out(res, 401, { error: 'step_up_required' });
    }
    if (p.via === 'station' && authorize(req).error) return out(res, 401, { error: 'step_up_required' });
    if (Date.now() > p.expires) {
      pendingConfirm.delete(req.params.id);
      return out(res, 410, { error: 'confirm_expired' });
    }
    if (!edgeSince(p.site, p.device, p.bit, p.since)) return res.json({ waiting: true, bit: p.bit });
    pendingConfirm.delete(req.params.id);
    try {
      await dispatch(req.user, p.cmd, `${p.via}+button`, clientIp(req));
    } catch {
      return out(res, 503, { error: 'mqtt_unavailable' });
    }
    res.json({ ok: true, id: p.cmd.id, sent: true });
  });


  app.post('/api/station/cmd', sAuth, stationLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return out(res, 503, { error: 'remote_control_paused' });
    }
    const owner = req.stationOwner;
    const target = {
      id: owner.id,
      notify_site: req.station.site,
      notify_device: req.station.device,
      tenant_id: owner.tenant_id,
    };
    const cfg = configForUser(target);
    if (!canControl(owner)) return out(res, 403, { error: 'forbidden' });
    const v = validateCmd(req.body, cfg);
    if (v.error) return out(res, 400, v);
    const ip = clientIp(req);
    if (v.write && v.critical && cfg.physicalBit !== null) {
      const id = crypto.randomBytes(8).toString('hex');
      pendingConfirm.set(id, {
        userId: owner.id, site: target.notify_site, device: target.notify_device, cmd: v.cmd,
        via: 'station', bit: cfg.physicalBit, since: Date.now(), expires: Date.now() + cfg.physicalWaitMs,
      });
      audit(db, 'control_pending_physical', { userId: owner.id, ip, detail: `station ${req.station.id} a=${v.cmd.a}` });
      return out(res, 202, { pending: true, confirmId: id, bit: cfg.physicalBit, expiresIn: cfg.physicalWaitMs / 1000, id: v.cmd.id });
    }
    try {
      await dispatch(target, v.cmd, `station ${req.station.id}`, ip);
    } catch {
      return out(res, 503, { error: 'mqtt_unavailable' });
    }
    res.json({ ok: true, id: v.cmd.id, via: 'station' });
  });

  app.get('/api/station/confirm/:id', sAuth, stationLimit, async (req, res) => {
    const p = pendingConfirm.get(req.params.id);
    if (!p || p.userId !== req.stationOwner.id || p.site !== req.station.site) return out(res, 404, { error: 'not_found' });
    if (Date.now() > p.expires) { pendingConfirm.delete(req.params.id); return out(res, 410, { error: 'confirm_expired' }); }
    if (!edgeSince(p.site, p.device, p.bit, p.since)) return res.json({ waiting: true, bit: p.bit });
    pendingConfirm.delete(req.params.id);
    try {
      await dispatch({ id: p.userId, notify_site: p.site, notify_device: p.device }, p.cmd, `${p.via}+button`, clientIp(req));
    } catch {
      return out(res, 503, { error: 'mqtt_unavailable' });
    }
    res.json({ ok: true, id: p.cmd.id, sent: true });
  });
}
