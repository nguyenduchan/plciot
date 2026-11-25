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
import { plcControlConfig, validateCmd, validateChildCmd } from './plcCommands.js';
import { listUserDevices } from './userDevices.js';
import { gatewaysOfUser } from './mqttIds.js';
import { deviceToUiNode, applyWidgetLimit } from './uiContract.js';
import { controlConfigFor } from './profiles.js';
import { resolveDeviceForUser } from './tenants.js';
import { isGatewayLocked } from './hwBlock.js';
import { mayRemoteControl, planWidgetLimit, planDeviceLimit, takeRpcBudget } from './entitlements.js';
import { toggleWaitMs, toggleRecord } from './toggleGuard.js';

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
    return { mqttId: dev?.mqtt_id };   // topic gw/<mqttId>/cmd: id ngẫu nhiên của gateway (thiếu = gateway chưa đăng ký)
  }

  /** Đầu ra số có toggleMs: đổi trạng thái sớm hơn khoảng tối thiểu → trả { waitMs } (chưa phát lệnh). */
  const guardArgs = (user, cmd, toggleMs) => ({ site: user.notify_site, device: user.notify_device, child: cmd.child, key: cmd.key, v: cmd.v, toggleMs });
  function tooFast(res, user, cmd, toggleMs) {
    if (!toggleMs || cmd.key == null) return false;
    const waitMs = toggleWaitMs(guardArgs(user, cmd, toggleMs));
    if (!waitMs) return false;
    res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
    out(res, 429, { error: 'toggle_too_fast', waitMs, toggleMs });
    return true;
  }

  async function dispatch(user, cmd, via, ip, toggleMs = 0) {
    const t0 = Date.now();
    await publishCmd(user.notify_site, user.notify_device, cmd, publishOpts(user));
    if (toggleMs && cmd.key != null) toggleRecord(guardArgs(user, cmd, toggleMs));
    const ms = Date.now() - t0;
    if (ms > 50) console.warn(`[ctl] publish chậm ${ms} ms id=${cmd.id}`);
    // ghi audit SAU khi lệnh đã đi (không nằm trên đường trễ của lệnh)
    setImmediate(() => audit(db, 'control_cmd', { userId: user.id, ip, detail: `${via} ${cmd.op || 'w'} ${cmd.key ? `${cmd.child}.${cmd.key}` : `a=${cmd.a}`} ${cmd.v ?? cmd.n ?? ''}` }));
  }

  app.post('/api/control/cmd', requireAuth, cmdLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return out(res, 503, { error: 'remote_control_paused' });
    }
    const tIn = Date.now();
    // Webapp nhiều gateway: body.gw = "site/device" chọn gateway đích (phải là gateway user đã thêm); không gửi = gateway chính
    const gwSel = typeof req.body?.gw === "string" ? req.body.gw.trim() : "";
    let tu = req.user;
    if (gwSel) {
      const hit = gatewaysOfUser(db, req.user).find((g) => `${g.site}/${g.device}` === gwSel);
      if (!hit) return out(res, 403, { error: "forbidden_gateway" });
      tu = { ...req.user, notify_site: hit.site, notify_device: hit.device };
    }
    // gateway bị khoá (admin khoá hoặc chủ báo mất đang chờ duyệt): không phát lệnh nữa (board cũng tự từ chối)
    if (isGatewayLocked(db, tu.notify_site, tu.notify_device)) return out(res, 423, { error: 'gateway_locked' });
    const cfg = configForUser(tu);
    if (!canControl(req.user)) return out(res, 403, { error: 'forbidden' });
    // Ngân sách lệnh theo gói (DK10: 60 lệnh/phút/tài khoản; cửa sổ trượt 60 giây)
    const bud = takeRpcBudget(req.user);
    if (!bud.ok) { res.setHeader('Retry-After', String(bud.retryAfterSec)); return out(res, 429, { error: 'rpc_limit', max: bud.max, retryAfterSec: bud.retryAfterSec }); }
    // {child,key,v}: nút của thiết bị con (bơm, relay…) theo widget của loại thiết bị; còn lại là ghi/đọc thanh ghi D
    // Giới hạn widget của gói tính trên TOÀN BỘ thiết bị (cùng thứ tự với dashboard) rồi mới lọc theo gateway đích
    const rows = req.body?.key != null ? listUserDevices(db, req.user) : [];
    const limited = applyWidgetLimit(rows.map(deviceToUiNode), planWidgetLimit(req.user), planDeviceLimit(req.user)).nodes;
    const v = req.body?.key != null
      ? validateChildCmd(req.body, limited.filter((_, i) => !gwSel || (rows[i].site === tu.notify_site && rows[i].gatewayDevice === tu.notify_device)))
      : validateCmd(req.body, cfg);
    if (v.error) return out(res, 400, v);
    // bảo vệ tiếp điểm: kiểm trước bước xác thực để không bắt người dùng xác nhận một lệnh chắc chắn bị từ chối
    if (v.write && tooFast(res, tu, v.cmd, v.toggleMs)) return;
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
      if (a.error && (!v.critical || !(a.methods?.enrolled || a.methods?.password))) {
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
        const fingerprint = JSON.stringify([tu.notify_site, tu.notify_device, v.cmd]);
        if (!challenge || challenge.userId !== req.user.id || challenge.sessionId !== req.tokenPayload?.sid
          || challenge.fingerprint !== fingerprint || !proof.ok || proof.commandId !== challengeId) {
          if (commandChallenges.size >= 1000) return out(res, 429, { error: 'rate_limited' });
          const id = crypto.randomBytes(16).toString('hex');
          commandChallenges.set(id, { userId: req.user.id, sessionId: req.tokenPayload?.sid, fingerprint, expires: now + 60_000 });
          return out(res, 401, {
            error: 'step_up_required', reason: 'critical_command', commandChallenge: id,
            methods: security.methodsFor(req.user),          // passkey / totp / password (xác nhận đúng lệnh này)
            // giữ gateway đích (gw) trong lệnh trả về: webapp gửi lại đúng lệnh này sau khi xác nhận — thiếu gw thì lệnh rơi về gateway CHÍNH
            command: gwSel ? { ...v.cmd, gw: gwSel } : v.cmd, target: { site: tu.notify_site, device: tu.notify_device },
          });
        }
        commandChallenges.delete(challengeId);
        via = proof.method;
      }
      if (v.critical && cfg.physicalBit !== null) {
        const id = crypto.randomBytes(8).toString('hex');
        pendingConfirm.set(id, {
          userId: req.user.id, site: tu.notify_site, device: tu.notify_device,
          cmd: v.cmd, via, sessionId: req.tokenPayload?.sid, controlToken: String(req.headers['x-control-token'] || ''),
          bit: cfg.physicalBit, since: Date.now(), expires: Date.now() + cfg.physicalWaitMs, toggleMs: v.toggleMs,
        });
        audit(db, 'control_pending_physical', { userId: req.user.id, ip, detail: `a=${v.cmd.a}` });
        return out(res, 202, { pending: true, confirmId: id, bit: cfg.physicalBit, expiresIn: cfg.physicalWaitMs / 1000, id: v.cmd.id });
      }
    }
    // kiểm lại ngay trước khi phát: hai lệnh song song cùng qua bước kiểm đầu (xác thực xen giữa)
    if (v.write && tooFast(res, tu, v.cmd, v.toggleMs)) return;
    try {
      await dispatch(tu, v.cmd, via, ip, v.toggleMs);
    } catch (e) {
      return out(res, 503, { error: 'mqtt_unavailable' });
    }
    // serverMs = thời gian xử lý + phát lệnh trong server (không gồm mạng tới trình duyệt)
    res.json({ ok: true, id: v.cmd.id, via, serverMs: Date.now() - tIn });
  });

  /** Client hỏi lại sau khi bấm nút vật lý; lệnh chỉ phát khi PLC báo cạnh tín hiệu mới ở ngõ vào đó. */
  app.get('/api/control/confirm/:id', requireAuth, cmdLimit, async (req, res) => {
    if (!isOpsOpen('remote_control_open')) {
      return out(res, 503, { error: 'remote_control_paused' });
    }
    const p = pendingConfirm.get(req.params.id);
    if (!p || p.userId !== req.user.id) return out(res, 404, { error: 'not_found' });
    if (!canControl(req.user) || p.sessionId !== req.tokenPayload?.sid || !gatewaysOfUser(db, req.user).some((g) => g.site === p.site && g.device === p.device)) {
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
    if (tooFast(res, { notify_site: p.site, notify_device: p.device }, p.cmd, p.toggleMs)) return;
    try {
      await dispatch({ ...req.user, notify_site: p.site, notify_device: p.device }, p.cmd, `${p.via}+button`, clientIp(req), p.toggleMs);
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
