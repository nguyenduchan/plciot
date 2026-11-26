/**
 * CHƯƠNG TRÌNH LOGIC CỦA GATEWAY (board Waveshare) — một chương trình / gateway, xem docs/GATEWAY-LOGIC.md.
 *
 *   Board báo chương trình đang chạy trong bản tin config (logic: {rev,sha,tz,do,names,keys}) → bảng gateway_logic.
 *   Admin (GatewayAdmin, khoá máy) viết TEXT (logicDsl.js) → kiểm → ĐỀ XUẤT (gateway_logic_proposals, push báo chủ trạm).
 *   Chủ trạm xem BẢNG tiếng Việt trên webapp → DUYỆT (Face ID / TOTP như lệnh điều khiển) → server gửi rpc PUT /api/offline
 *   có mã duyệt "appr" (trong phần ký) → board kiểm, thay trọn gói, báo lại. Từ chối → không làm gì.
 *   HẸN GIỜ bật/tắt: chủ trạm tự cài cạnh nút điều khiển (cũng cần Face ID / TOTP), server chỉ thay phần Timer của DO đó.
 * Webapp KHÔNG sửa được phần khác (điều kiện, liên động, khi mất mạng).
 */
import crypto from 'node:crypto';
import { audit, clientIp, rateLimit } from '@plciot/security';
import { gatewaysOfUser } from './mqttIds.js';
import { callGateway } from './remoteAdmin.js';
import { pushToGatewayUsers } from './webPush.js';
import { parseLogic, formatLogic, describeLogic, LogicError, idOf, sortOuts } from './logicDsl.js';
import { verifyProof, requestMessage, ensureKeyColumns, parsePubkey } from './gatewayKey.js';
import { isHwBlocked } from './hwBlock.js';

/**
 * Gateway tự chứng minh danh tính (khoá riêng của gateway, như /api/v1/gateway/qr): {site, device, pubkey, ts, sig}, sig ký `${kind}|site|device|ts`.
 * → {site, device} | null. Dùng cho DUYỆT TẠI CHỖ trên GatewayApp (chủ trạm đứng ở gateway, đã mở khoá bằng mật khẩu gateway / đăng nhập webapp).
 */
export function gatewayAuth(db, body, kind) {
  const site = String(body?.site || '').trim(), device = String(body?.device || '').trim();
  const pk = parsePubkey(body?.pubkey);
  if (!site || !device || !pk) return null;
  ensureKeyColumns(db);
  const row = db.prepare('SELECT activated_hw, gw_pubkey FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
  if (!row) return null;
  const keyOk = row.gw_pubkey ? row.gw_pubkey === pk.spki : Boolean(row.activated_hw) && row.activated_hw === pk.hw;
  if (!keyOk || !verifyProof(body.pubkey, requestMessage(kind, site, device, body.ts), body.sig, body.ts)) return null;
  if (isHwBlocked(db, pk.hw)) return null;
  return { site, device };
}

let inited = false;
export function initGatewayLogicTables(db) {
  if (inited) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_logic (
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      rev INTEGER,
      sha TEXT,
      program TEXT NOT NULL,
      names TEXT,
      keys TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site, device)
    );
    CREATE TABLE IF NOT EXISTS gateway_logic_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site TEXT NOT NULL,
      device TEXT NOT NULL,
      program TEXT NOT NULL,
      text TEXT,
      note TEXT,
      base_rev INTEGER,
      proposed_by TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at INTEGER,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logic_prop_gw ON gateway_logic_proposals (site, device, created_at);
  `);
  inited = true;
}

const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** Từ mqttIngest: board gửi bản tin config có "logic". Chỉ ghi khi đổi. */
export function recordReportedLogic(db, { site, device, logic }) {
  if (!logic || typeof logic !== 'object' || !Array.isArray(logic.do)) return;
  initGatewayLogicTables(db);
  const program = JSON.stringify({ TzMin: Number(logic.tz ?? 420), Do: logic.do.slice(0, 32) });
  if (program.length > 16000) return;
  const names = JSON.stringify(logic.names || {}), keys = JSON.stringify(logic.keys || {});
  const prev = db.prepare('SELECT rev, sha, program, names, keys FROM gateway_logic WHERE site = ? AND device = ?').get(site, device);
  if (prev && prev.rev === Number(logic.rev) && prev.sha === String(logic.sha || '') && prev.program === program && prev.names === names && prev.keys === keys) return;
  db.prepare(`INSERT INTO gateway_logic (site, device, rev, sha, program, names, keys, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(site, device) DO UPDATE SET rev = excluded.rev, sha = excluded.sha, program = excluded.program, names = excluded.names,
      keys = excluded.keys, updated_at = excluded.updated_at`)
    .run(site, device, Number(logic.rev) || 0, String(logic.sha || '').slice(0, 64), program, names, keys, Date.now());
}

export function currentLogic(db, site, device) {
  initGatewayLogicTables(db);
  const r = db.prepare('SELECT * FROM gateway_logic WHERE site = ? AND device = ?').get(site, device);
  if (!r) return null;
  return { rev: r.rev, sha: r.sha, program: j(r.program, { TzMin: 420, Do: [] }), names: j(r.names, {}), keys: j(r.keys, {}), updatedAt: r.updated_at };
}

/** Chương trình thật sự sẽ gửi khi duyệt: đề xuất KHÔNG có hẹn giờ cho DO nào thì giữ hẹn giờ hiện tại của chủ trạm ở DO đó. */
export function mergeOwnerTimers(proposal, current) {
  const out = { TzMin: proposal.TzMin, Do: proposal.Do.map((o) => ({ ...o })) };
  for (const c of current?.Do || []) {
    if (!c.Timer?.length) continue;
    const o = out.Do.find((x) => idOf(x) === idOf(c));
    if (!o) out.Do.push({ ...(c.Out ? { Out: c.Out } : { Ch: c.Ch }), Mode: 'hold', DelaySec: 60, Timer: c.Timer });
    else if (!o.Timer) o.Timer = c.Timer;
  }
  out.Do = sortOuts(out.Do);
  return out;
}

/** Đầu ra nào khác giữa hai chương trình (để webapp tô đậm hàng thay đổi): số DO (board) hoặc tên field (gateway PC). */
export function changedChannels(a, b) {
  const norm = (o) => JSON.stringify(o ? { ...o, Ch: undefined, Out: undefined } : { Mode: 'hold' });
  const plain = (o) => !o || (o.Mode === 'hold' && Object.keys(o).length <= 3);
  const ids = [...new Set([...(a?.Do || []), ...(b?.Do || [])].map(idOf))];
  const out = [];
  for (const id of ids) {
    const x = (a?.Do || []).find((o) => idOf(o) === id), y = (b?.Do || []).find((o) => idOf(o) === id);
    if (plain(x) && plain(y)) continue;
    if (norm(x) !== norm(y)) out.push(/^\d+$/.test(id) ? Number(id) : id);
  }
  return out.sort((p, q) => (typeof p === 'number' && typeof q === 'number' ? p - q : 0));
}

const kindOf = (db, site, device) => (String(db.prepare('SELECT version FROM gateway_clients WHERE site = ? AND device = ?').get(site, device)?.version || '').startsWith('mcu') ? 'mcu' : 'pc');

/** Gửi chương trình xuống gateway (rpc PUT /api/offline có mã duyệt; board: base64 thường, gateway PC: gzip). → {ok, rev} | {error, status} */
async function sendProgram(db, { site, device, program, rev, label, appr }) {
  const dev = db.prepare('SELECT mqtt_id FROM devices WHERE site = ? AND device = ?').get(site, device);
  if (!dev?.mqtt_id) return { error: 'gateway_not_found', status: 404 };
  const body = JSON.stringify({ Rev: rev, TzMin: program.TzMin, Do: program.Do });
  const r = await callGateway(dev.mqtt_id, { method: 'PUT', path: '/api/offline', body, label, appr, mcu: kindOf(db, site, device) === 'mcu' });
  const b = j(r.body, {});
  if (r.status === 200 && b.Ok) {
    // ghi ngay (board cũng gửi lại bản tin config — sẽ khớp)
    const cur = currentLogic(db, site, device);
    db.prepare(`INSERT INTO gateway_logic (site, device, rev, sha, program, names, keys, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site, device) DO UPDATE SET rev = excluded.rev, program = excluded.program, updated_at = excluded.updated_at`)
      .run(site, device, Number(b.Rev) || 0, cur?.sha || '', JSON.stringify(program), JSON.stringify(cur?.names || {}), JSON.stringify(cur?.keys || {}), Date.now());
    return { ok: true, rev: Number(b.Rev) || 0 };
  }
  if (r.status === 504) return { error: 'gateway_timeout', status: 504 };
  if (r.status === 409 || b.Err === 'rev_conflict') return { error: 'logic_rev_conflict', status: 409 };
  return { error: 'logic_rejected', status: 422, detail: String(b.Err || r.status) };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Kiểm danh sách hẹn giờ của chủ trạm (webapp). → mảng sạch hoặc chuỗi lỗi. */
/**
 * Hẹn giờ của chủ trạm (kiểu báo thức iPhone): Days = các ngày LẶP LẠI; mốc CHẠY 1 LẦN = {Date:"YYYY-MM-DD", Days:[]}
 * (ngày theo giờ địa phương của gateway). Days RỖNG là cố ý: gateway bản cũ không hiểu Date sẽ TỪ CHỐI chương trình
 * thay vì chạy mỗi ngày. Mốc 1 lần đã qua (trước hôm qua) bị bỏ khi lưu. tzMin = múi giờ của chương trình.
 */
/** "YYYY-MM-DD" là ngày có thật. */
export const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function cleanTimers(list, tzMin = 420) {
  if (!Array.isArray(list) || list.length > 4) return 'timer_invalid';
  const out = [];
  const yesterday = new Date(Date.now() + tzMin * 60000 - 86400000).toISOString().slice(0, 10);
  for (const t of list) {
    const e = {};
    if (t?.On) { if (!TIME_RE.test(t.On)) return 'timer_invalid'; e.On = t.On; }
    if (t?.Off) { if (!TIME_RE.test(t.Off)) return 'timer_invalid'; e.Off = t.Off; }
    if (!e.On && !e.Off) return 'timer_invalid';
    if (e.On && e.On === e.Off) return 'timer_invalid';
    if (t?.Date != null) {   // chạy 1 lần
      if (!validDate(t.Date) || (Array.isArray(t.Days) && t.Days.length)) return 'timer_invalid';
      if (t.Date < yesterday) continue;   // đã qua: bỏ
      e.Date = t.Date; e.Days = [];
      out.push(e);
      continue;
    }
    if (t?.Days != null) {
      if (!Array.isArray(t.Days) || !t.Days.length || t.Days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return 'timer_invalid';
      const d = [...new Set(t.Days)].sort((a, b) => a - b);
      if (d.length < 7) e.Days = d;
    }
    out.push(e);
  }
  return out;
}

/**
 * @param admin  giá trị trả về của mountRemoteAdmin (requireAdminKey, limit)
 * @param security controlApi: authorize(req) = mức xác thực như lệnh điều khiển (Face ID / TOTP)
 */
export function mountGatewayLogic(app, { db, requireAuth, security, admin }) {
  initGatewayLogicTables(db);
  const { authorize } = security;
  const { requireAdminKey, limit: radmLimit } = admin;
  const limit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `${clientIp(req)}:logic:${req.user?.id || 'na'}` });
  const out = (res, st, b) => res.status(st).json(b);
  const mine = (req, gw) => gatewaysOfUser(db, req.user).find((g) => `${g.site}/${g.device}` === gw);
  const devOf = (site, device) => db.prepare('SELECT site, device, mqtt_id FROM devices WHERE site = ? AND device = ?').get(String(site || ''), String(device || ''));
  const propRow = (p, cur) => {
    const prog = mergeOwnerTimers(j(p.program, { TzMin: 420, Do: [] }), cur?.program);
    return {
      id: p.id, status: p.status, note: p.note || '', by: p.proposed_by, createdAt: p.created_at, decidedBy: p.decided_by, decidedAt: p.decided_at,
      result: p.result || '', rows: describeLogic(prog, cur?.names), changed: changedChannels(cur?.program, prog), text: p.text || formatLogic(prog),
    };
  };

  // ------------------------------------------------------------ admin (GatewayAdmin)
  /** Kiểm text: {site, device, text} → {program, text (chuẩn hoá), rows, changed} hoặc {error, message}. */
  app.post('/api/v1/radmin/logic/check', radmLimit, requireAdminKey, (req, res) => {
    const dev = devOf(req.body?.site, req.body?.device);
    if (!dev) return out(res, 404, { error: 'gateway_not_found' });
    const cur = currentLogic(db, dev.site, dev.device);
    try {
      const program = parseLogic(String(req.body?.text || ''), { kind: kindOf(db, dev.site, dev.device) });
      const eff = mergeOwnerTimers(program, cur?.program);
      res.json({ ok: true, program, text: formatLogic(program), rows: describeLogic(eff, cur?.names), changed: changedChannels(cur?.program, eff) });
    } catch (e) {
      if (e instanceof LogicError) return out(res, 400, { error: 'logic_syntax', message: e.message });
      throw e;
    }
  });

  /** Chương trình hiện tại (text) + các đề xuất gần đây của một gateway. */
  app.get('/api/v1/radmin/logic', radmLimit, requireAdminKey, (req, res) => {
    const dev = devOf(req.query.site, req.query.device);
    if (!dev) return out(res, 404, { error: 'gateway_not_found' });
    const cur = currentLogic(db, dev.site, dev.device);
    const props = db.prepare('SELECT * FROM gateway_logic_proposals WHERE site = ? AND device = ? ORDER BY id DESC LIMIT 10').all(dev.site, dev.device);
    res.json({
      kind: kindOf(db, dev.site, dev.device),
      current: cur ? { rev: cur.rev, sha: cur.sha, text: formatLogic(cur.program), rows: describeLogic(cur.program, cur.names), names: cur.names, updatedAt: cur.updatedAt } : null,
      proposals: props.map((p) => propRow(p, cur)),
    });
  });

  /** Gửi đề xuất cho chủ trạm duyệt: {site, device, text, note}. Đề xuất cũ đang chờ → "superseded". */
  app.post('/api/v1/radmin/logic/propose', radmLimit, requireAdminKey, (req, res) => {
    const dev = devOf(req.body?.site, req.body?.device);
    if (!dev) return out(res, 404, { error: 'gateway_not_found' });
    let program;
    try { program = parseLogic(String(req.body?.text || ''), { kind: kindOf(db, dev.site, dev.device) }); } catch (e) {
      if (e instanceof LogicError) return out(res, 400, { error: 'logic_syntax', message: e.message });
      throw e;
    }
    const cur = currentLogic(db, dev.site, dev.device);
    const note = String(req.body?.note || '').trim().slice(0, 300);
    const now = Date.now();
    const id = db.transaction(() => {
      db.prepare(`UPDATE gateway_logic_proposals SET status = 'superseded', decided_at = ? WHERE site = ? AND device = ? AND status = 'pending'`).run(now, dev.site, dev.device);
      return db.prepare(`INSERT INTO gateway_logic_proposals (site, device, program, text, note, base_rev, proposed_by, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(dev.site, dev.device, JSON.stringify(program), formatLogic(program), note, cur?.rev ?? null, req.radmin.label, now).lastInsertRowid;
    })();
    audit(db, 'logic_propose', { ip: clientIp(req), detail: `${req.radmin.label} ${dev.site}/${dev.device} #${id}${note ? ` — ${note}` : ''}`.slice(0, 500) });
    pushToGatewayUsers(db, dev.site, dev.device, {
      t: 'Đề xuất đổi logic gateway', b: `${dev.site}/${dev.device}: ${note || 'có thay đổi logic điều khiển'} — mở để xem và duyệt.`, tag: `${dev.site}/${dev.device}/logic`, url: '/#set',
    }).catch(() => {});
    res.json({ ok: true, id: Number(id) });
  });

  // ------------------------------------------------------------ chủ trạm duyệt TẠI GATEWAY (GatewayApp, ký bằng khoá gateway)
  const gwLimit = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `${clientIp(req)}:gw-logic` });

  /** Đề xuất đang chờ (kèm chương trình sẽ áp dụng) + bảng bản đang chạy. kind ký: "logic-pending". */
  app.post('/api/v1/gateway/logic/pending', gwLimit, (req, res) => {
    const g = gatewayAuth(db, req.body, 'logic-pending');
    if (!g) return out(res, 403, { error: 'not_allowed' });
    const cur = currentLogic(db, g.site, g.device);
    const p = db.prepare(`SELECT * FROM gateway_logic_proposals WHERE site = ? AND device = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(g.site, g.device);
    res.json({
      current: cur ? { rev: cur.rev, rows: describeLogic(cur.program, cur.names) } : null,
      pending: p ? { ...propRow(p, cur), program: mergeOwnerTimers(j(p.program, { TzMin: 420, Do: [] }), cur?.program) } : null,
    });
  });

  /**
   * Gateway báo chủ trạm đã quyết TẠI CHỖ: {id, decision:"approve"|"reject", by, rev}. kind ký: "logic-<decision>-<id>" (chữ ký gắn với đúng đề xuất + quyết định).
   * approve = gateway ĐÃ áp dụng chương trình (rev mới) trước khi báo.
   */
  app.post('/api/v1/gateway/logic/decide', gwLimit, (req, res) => {
    const id = Number(req.body?.id), decision = String(req.body?.decision || '');
    if (!Number.isInteger(id) || !['approve', 'reject'].includes(decision)) return out(res, 400, { error: 'bad_request' });
    const g = gatewayAuth(db, req.body, `logic-${decision}-${id}`);
    if (!g) return out(res, 403, { error: 'not_allowed' });
    const p = db.prepare('SELECT * FROM gateway_logic_proposals WHERE id = ? AND site = ? AND device = ?').get(id, g.site, g.device);
    if (!p || p.status !== 'pending') return out(res, 409, { error: 'logic_not_pending' });
    const by = `${String(req.body?.by || 'chủ trạm').slice(0, 40)} (tại gateway)`;
    if (decision === 'approve') {
      decide(p.id, 'applied', by, `rev ${Number(req.body?.rev) || 0}`);
      audit(db, 'logic_approve', { ip: clientIp(req), detail: `${g.site}/${g.device} #${p.id} (${p.proposed_by}) → rev ${Number(req.body?.rev) || 0} · ${by}` });
    } else {
      decide(p.id, 'rejected', by);
      audit(db, 'logic_reject', { ip: clientIp(req), detail: `${g.site}/${g.device} #${p.id} (${p.proposed_by}) · ${by}` });
    }
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ chủ trạm (webapp)
  /** Bảng logic của một gateway: hiện tại + đề xuất đang chờ + lịch sử. */
  app.get('/api/v1/gateway-logic', requireAuth, (req, res) => {
    const g = mine(req, String(req.query.gw || ''));
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const kind = kindOf(db, g.site, g.device);
    const cur = currentLogic(db, g.site, g.device);
    const props = db.prepare('SELECT * FROM gateway_logic_proposals WHERE site = ? AND device = ? ORDER BY id DESC LIMIT 10').all(g.site, g.device);
    const pending = props.find((p) => p.status === 'pending');
    const timers = {};
    for (const o of cur?.program?.Do || []) if (o.Timer?.length) timers[idOf(o)] = o.Timer;
    res.json({
      site: g.site, device: g.device, kind,
      current: cur ? { rev: cur.rev, updatedAt: cur.updatedAt, tz: cur.program.TzMin ?? 420, rows: describeLogic(cur.program, cur.names), keys: cur.keys, names: cur.names, timers } : null,
      pending: pending ? propRow(pending, cur) : null,
      history: props.filter((p) => p.status !== 'pending').slice(0, 8).map((p) => ({ id: p.id, status: p.status, note: p.note || '', by: p.proposed_by, createdAt: p.created_at, decidedBy: p.decided_by, decidedAt: p.decided_at, result: p.result || '' })),
    });
  });

  const decide = (id, status, by, result = '') => db.prepare('UPDATE gateway_logic_proposals SET status = ?, decided_by = ?, decided_at = ?, result = ? WHERE id = ?')
    .run(status, by, Date.now(), String(result).slice(0, 300), id);

  /** Chủ trạm DUYỆT đề xuất: {gw, id}. Gửi xuống board ngay (board phải đang online). */
  app.post('/api/v1/gateway-logic/approve', requireAuth, limit, async (req, res) => {
    const g = mine(req, String(req.body?.gw || ''));
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const p = db.prepare(`SELECT * FROM gateway_logic_proposals WHERE id = ? AND site = ? AND device = ?`).get(Number(req.body?.id), g.site, g.device);
    if (!p || p.status !== 'pending') return out(res, 409, { error: 'logic_not_pending' });
    const a = authorize(req);
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `logic_approve ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    const cur = currentLogic(db, g.site, g.device);
    const program = mergeOwnerTimers(j(p.program, { TzMin: 420, Do: [] }), cur?.program);
    const appr = `${by}#${p.id}-${crypto.randomBytes(3).toString('hex')}`;
    const r = await sendProgram(db, { site: g.site, device: g.device, program, rev: cur?.rev ?? 0, label: p.proposed_by || 'GatewayAdmin', appr });
    if (!r.ok) {
      if (r.error === 'logic_rejected') decide(p.id, 'failed', by, `Gateway từ chối: ${r.detail}`);
      audit(db, 'logic_approve', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} #${p.id} → lỗi ${r.error}${r.detail ? ` ${r.detail}` : ''}`.slice(0, 500) });
      return out(res, r.status, { error: r.error, message: r.detail });
    }
    decide(p.id, 'applied', by, `rev ${r.rev}`);
    audit(db, 'logic_approve', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} #${p.id} (${p.proposed_by}) → rev ${r.rev}` });
    res.json({ ok: true, rev: r.rev });
  });

  /** Chủ trạm TỪ CHỐI đề xuất: {gw, id}. */
  app.post('/api/v1/gateway-logic/reject', requireAuth, limit, (req, res) => {
    const g = mine(req, String(req.body?.gw || ''));
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const p = db.prepare(`SELECT * FROM gateway_logic_proposals WHERE id = ? AND site = ? AND device = ?`).get(Number(req.body?.id), g.site, g.device);
    if (!p || p.status !== 'pending') return out(res, 409, { error: 'logic_not_pending' });
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    decide(p.id, 'rejected', by);
    audit(db, 'logic_reject', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} #${p.id} (${p.proposed_by})` });
    res.json({ ok: true });
  });

  /**
   * HẸN GIỜ của chủ trạm cho một đầu ra: {gw, id, timers:[{On,Off,Days}]} ([] = xoá). id = số DO (board) hoặc "<thiết bị>.<field>" (gateway PC);
   * {ch} cũ vẫn nhận. Chỉ thay phần Timer của đầu ra đó; đầu ra phải là nút điều khiển gateway đã báo (keys).
   */
  app.put('/api/v1/gateway-logic/timer', requireAuth, limit, async (req, res) => {
    const g = mine(req, String(req.body?.gw || ''));
    if (!g) return out(res, 403, { error: 'forbidden_gateway' });
    const kind = kindOf(db, g.site, g.device);
    const id = String(req.body?.id ?? req.body?.ch ?? '');
    // board: số DO 1…8 HOẶC đầu ra field (thiết bị RS485/Modbus TCP, firmware ≥ mcu-0.4.0); gateway PC: luôn field
    const isField = /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(id);
    const ch = kind === 'mcu' && !isField ? Number(id) : id;
    if (!isField && !(kind === 'mcu' && Number.isInteger(ch) && ch >= 1 && ch <= 8)) return out(res, 400, { error: 'bad_request' });
    const timers = cleanTimers(req.body?.timers, currentLogic(db, g.site, g.device)?.program?.TzMin ?? 420);
    if (typeof timers === 'string') return out(res, 400, { error: timers });
    const cur = currentLogic(db, g.site, g.device);
    if (!cur) return out(res, 409, { error: 'logic_unknown' });   // gateway chưa báo chương trình (firmware / app cũ, chưa nối)
    if (isField && !Object.prototype.hasOwnProperty.call(cur.keys || {}, id)) return out(res, 400, { error: 'bad_request' });   // không phải đầu ra gateway báo
    const a = authorize(req);
    if (a.error) { audit(db, 'control_denied', { userId: req.user.id, ip: clientIp(req), detail: `logic_timer ${a.reason || a.error}` }); return out(res, a.status || 401, a); }
    const by = String(req.user.username || `user${req.user.id}`).slice(0, 40);
    const program = { TzMin: cur.program.TzMin, Do: cur.program.Do.map((o) => ({ ...o })) };
    let o = program.Do.find((x) => idOf(x) === String(ch));
    if (!o) {
      o = { ...(isField ? { Out: ch } : { Ch: ch }), Mode: 'hold', DelaySec: 60 };
      program.Do.push(o); program.Do = sortOuts(program.Do);
    }
    if (timers.length) o.Timer = timers; else delete o.Timer;
    const r = await sendProgram(db, { site: g.site, device: g.device, program, rev: cur.rev, label: 'webapp', appr: `${by}#timer` });
    const txt = timers.map((t) => `${t.On || '—'}→${t.Off || '—'}${t.Days ? ` [${t.Days.join(',')}]` : ''}`).join(' · ') || 'xoá';
    audit(db, 'logic_timer', { userId: req.user.id, ip: clientIp(req), detail: `${g.site}/${g.device} ${isField ? ch : `DO${ch}`}: ${txt} → ${r.ok ? `rev ${r.rev}` : `lỗi ${r.error}`}`.slice(0, 500) });
    if (!r.ok) return out(res, r.status, { error: r.error, message: r.detail });
    res.json({ ok: true, rev: r.rev });
  });
}
