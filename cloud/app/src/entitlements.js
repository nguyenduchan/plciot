/**
 * Gói đăng ký quản lý tay (không thanh toán online).
 * Admin cấp trên VPS qua `node scripts/plan.js` — tiền/chuyển khoản xử lý ngoài hệ thống.
 *
 * Cột users:
 *   sub_plan         id gói trong plans.json (free | plus | monitor | pro | factory…) | (null = gói miễn phí)
 *   sub_expires_at   ms; null = không hết hạn
 *   remote_control   1 cho phép lệnh từ xa (nếu role + gói cho phép); 0 = chỉ xem
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canControl as roleCanControl } from './roles.js';
import { setRetention, parseRetention, retentionInfo, defaultDays } from './retention.js';
import { ipInCidrs, clientIp } from '@plciot/security';

/**
 * DANH MỤC GÓI — KHÔNG có số liệu gói trong mã nguồn. Toàn bộ nằm trong file cấu hình plans.json (xem trường "_doc" trong file đó):
 *   1) $PLANS_FILE nếu đặt biến môi trường
 *   2) <DATA_DIR>/plans.json — bản chạy thật trên VPS (cloud/app/data/plans.json, không bị ghi đè khi sync)
 *   3) cloud/app/config/plans.json — bản mặc định đi kèm mã nguồn
 * File được nạp lại tự động (kiểm tra mỗi PLANS_RELOAD_MS, mặc định 30 giây) khi có thay đổi: sửa file là đổi gói, không build/khởi động lại.
 * File sai (JSON hỏng, trùng mã, số âm…) thì BỎ QUA và giữ cấu hình đang chạy, ghi cảnh báo — không bao giờ làm sập server.
 *
 * Mỗi gói có id (khoá lưu DB users.sub_plan, đừng đổi), code (MÃ NÓI VỚI KHÁCH kiểu "VT30": DK + số thiết bị tối đa), label/audience/description,
 * priceVndMonth và các hạn mức / cờ tính năng. Thứ tự khai báo trong file = thứ hạng gói (planRank).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLANS_FILE = path.resolve(HERE, '../config/plans.json');
const NUMERIC_KEYS = ['retention', 'widgets', 'telemetryMinMs', 'storeEveryMs', 'devices', 'gateways', 'members', 'rpcPerMin', 'exportDays',
  'priceVndMonth', 'chatAlertsPerMonth', 'hotDays', 'coldSampleMs'];
const FLAG_KEYS = ['remoteControl', 'partnerCmd', 'integrations', 'advancedRules', 'whiteLabel', 'oneTime10y'];

/** Đối tượng SỐNG: nạp lại thì thay nội dung tại chỗ (các module khác giữ tham chiếu vẫn thấy dữ liệu mới). */
export const PLAN_CATALOG = {};
let freePlanId = 'free';
let loaded = { file: '', mtimeMs: 0, at: 0 };
let lastCheckAt = 0;

export function plansFilePath() {
  if (process.env.PLANS_FILE) return path.resolve(process.env.PLANS_FILE);
  const live = path.resolve(process.env.DATA_DIR || './data', 'plans.json');
  return fs.existsSync(live) ? live : DEFAULT_PLANS_FILE;
}

/** Kiểm tra nội dung file; ném Error có thông báo tiếng Việt. Trả { plans, freePlan }. */
export function validatePlansConfig(raw) {
  if (!raw || typeof raw !== 'object' || !raw.plans || typeof raw.plans !== 'object') throw new Error('thiếu mục "plans"');
  const ids = Object.keys(raw.plans).filter((k) => !k.startsWith('_'));
  if (!ids.length) throw new Error('"plans" rỗng');
  const codes = new Set();
  const plans = {};
  for (const id of ids) {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id)) throw new Error(`id gói "${id}" không hợp lệ (chữ thường/số/_, bắt đầu bằng chữ)`);
    const p = raw.plans[id];
    if (!p || typeof p !== 'object') throw new Error(`gói "${id}" phải là object`);
    const code = String(p.code ?? '').toUpperCase().replace(/[\s_-]/g, '');
    if (!/^[A-Z0-9]{2,12}$/.test(code)) throw new Error(`gói "${id}": mã gói (code) không hợp lệ`);
    if (codes.has(code)) throw new Error(`gói "${id}": mã "${code}" bị trùng`);
    codes.add(code);
    if (typeof p.label !== 'string' || !p.label.trim()) throw new Error(`gói "${id}": thiếu label`);
    const out = { code, label: p.label.trim(), audience: String(p.audience || ''), description: String(p.description || '') };
    for (const k of NUMERIC_KEYS) {
      const v = p[k];
      if (v == null) { out[k] = null; continue; }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`gói "${id}": "${k}" phải là số >= 0 hoặc null`);
      out[k] = v;
    }
    for (const k of FLAG_KEYS) out[k] = Boolean(p[k]);
    if (out.retention == null) throw new Error(`gói "${id}": thiếu "retention" (0 = không xoá)`);
    if (out.telemetryMinMs == null) throw new Error(`gói "${id}": thiếu "telemetryMinMs"`);
    plans[id] = out;
  }
  const freePlan = String(raw.freePlan || ids[0]);
  if (!plans[freePlan]) throw new Error(`freePlan "${freePlan}" không có trong danh sách gói`);
  return { plans, freePlan };
}

function applyPlans({ plans, freePlan }) {
  for (const k of Object.keys(PLAN_CATALOG)) delete PLAN_CATALOG[k];
  Object.assign(PLAN_CATALOG, plans);
  freePlanId = freePlan;
}

/** Nạp file gói. force=false: chỉ nạp khi file đổi. Trả { ok, file, error?, changed }. Lần đầu lỗi → ném lỗi (không có gì để giữ). */
export function loadPlans({ force = false } = {}) {
  const file = plansFilePath();
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (!Object.keys(PLAN_CATALOG).length) throw new Error(`không đọc được file gói ${file}: ${e.message}`);
    return { ok: false, file, error: e.message, changed: false };
  }
  if (!force && loaded.file === file && loaded.mtimeMs === st.mtimeMs) return { ok: true, file, changed: false };
  try {
    applyPlans(validatePlansConfig(JSON.parse(fs.readFileSync(file, 'utf8'))));
    loaded = { file, mtimeMs: st.mtimeMs, at: Date.now() };
    return { ok: true, file, changed: true };
  } catch (e) {
    loaded = { ...loaded, file, mtimeMs: st.mtimeMs };   // không thử lại cho tới khi file đổi nữa
    if (!Object.keys(PLAN_CATALOG).length) {
      if (file !== DEFAULT_PLANS_FILE) { console.warn(`[plans] ${file} lỗi (${e.message}) — dùng bản mặc định`); applyPlans(validatePlansConfig(JSON.parse(fs.readFileSync(DEFAULT_PLANS_FILE, 'utf8')))); return { ok: false, file, error: e.message, changed: true }; }
      throw new Error(`file gói không hợp lệ: ${e.message}`);
    }
    console.warn(`[plans] ${file} không hợp lệ, giữ cấu hình đang chạy: ${e.message}`);
    return { ok: false, file, error: e.message, changed: false };
  }
}

/** Gọi trên đường nóng: kiểm tra file đổi tối đa mỗi PLANS_RELOAD_MS. */
function refreshPlans() {
  const now = Date.now();
  const every = Number(process.env.PLANS_RELOAD_MS || 30_000);
  if (now - lastCheckAt < every) return;
  lastCheckAt = now;
  try { loadPlans(); } catch { /* giữ cấu hình đang chạy */ }
}

loadPlans({ force: true });

/** Gói miễn phí (gói mặc định cho tài khoản chưa gán gói) — id do trường "freePlan" trong file quyết định. */
export function freePlan() { refreshPlans(); return { id: freePlanId, ...PLAN_CATALOG[freePlanId] }; }
export const freeTelemetryMinMs = () => Number(freePlan().telemetryMinMs || 0);

/** Mã khách (DK30…) hoặc id nội bộ (monitor…) → id nội bộ; không nhận ra → null. Không phân biệt hoa thường. */
export function resolvePlanId(input) {
  refreshPlans();
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (PLAN_CATALOG[s.toLowerCase()]) return s.toLowerCase();
  const up = s.toUpperCase().replace(/[\s_-]/g, '');
  return Object.keys(PLAN_CATALOG).find((id) => PLAN_CATALOG[id].code === up) || null;
}

/** Tên đầy đủ để nói với khách: "DK30 · Khởi đầu (Starter)". */
export function planTitle(id) {
  const p = PLAN_CATALOG[id];
  return p ? `${p.code} · ${p.label}` : String(id || '');
}

/** Thông tin gói để HIỂN THỊ cho khách (không có chi phí nội bộ): mã, tên, mô tả, giá, hạn mức, tính năng. */
export function publicPlans() {
  return listPlans().map((p) => ({
    id: p.id, code: p.code, label: p.label, title: p.title, audience: p.audience, description: p.description,
    priceVndMonth: p.priceVndMonth, isFree: p.isFree, oneTime10y: Boolean(p.oneTime10y),
    retentionDays: p.retentionDays, unlimited: p.unlimited, storeEveryMs: p.storeEveryMs, telemetryMinMs: p.telemetryMinMs,
    devices: p.devices, gateways: p.gateways, members: p.members, rpcPerMin: p.rpcPerMin, exportDays: p.exportDays,
    integrations: p.integrations, advancedRules: p.advancedRules, whiteLabel: p.whiteLabel,
  }));
}

export function listPlans() {
  refreshPlans();
  return Object.entries(PLAN_CATALOG).map(([id, p]) => ({
    id,
    ...p,
    title: planTitle(id),
    isFree: id === freePlanId,
    retentionDays: p.retention === 0 ? null : p.retention,
    unlimited: p.retention === 0,
  }));
}

/** true (mặc định): webapp/user mới phải được admin gán gói — thống nhất với thiết bị/partner. */
export function requireSubscriptionActivation() {
  return String(process.env.SUBSCRIBE_REQUIRE_ACTIVATION || 'true').toLowerCase() !== 'false';
}

/**
 * false (mặc định): không tự gán gói khi đăng ký — chỉ admin kích hoạt thủ công.
 * true: đăng ký xong tự grant SUBSCRIBE_DEFAULT_PLAN (thường monitor).
 */
export function subscribeAutoGrant() {
  return String(process.env.SUBSCRIBE_AUTO_GRANT || 'false').toLowerCase() === 'true';
}

export function defaultSubscribePlan() {
  return resolvePlanId(process.env.SUBSCRIBE_DEFAULT_PLAN) || freePlan().id;   // mặc định: gói miễn phí theo plans.json
}

export function planActive(user, now = Date.now()) {
  if (user?.sub_expires_at != null && Number(user.sub_expires_at) <= now) return false;
  return true;
}

export function effectivePlan(user) {
  refreshPlans();
  const id = user?.sub_plan;
  if (id && PLAN_CATALOG[id]) return { id, ...PLAN_CATALOG[id] };
  if (requireSubscriptionActivation()) {
    // Chưa gán gói → gói MIỄN PHÍ (có giám sát + điều khiển, giới hạn widget); admin nâng gói trên Console/trang quản trị
    return freePlan();
  }
  // Tắt REQUIRE_ACTIVATION: hành vi cũ (legacy)
  return {
    id: null,
    label: 'legacy',
    retention: user?.retention_days == null ? 'default' : user.retention_days,
    remoteControl: true,
    partnerCmd: true,
  };
}

/**
 * Có được gửi lệnh ghi qua Internet/API không.
 * Layer: role → remote_control flag → gói còn hạn → catalog.remoteControl → CONTROL_FROM_INTERNET
 */
export function mayRemoteControl(user, { ip } = {}) {
  if (!roleCanControl(user)) return { ok: false, reason: 'role' };
  if (!planActive(user)) return { ok: false, reason: 'plan_expired' };
  if (user.remote_control === 0 || user.remote_control === false) return { ok: false, reason: 'remote_control_off' };
  const plan = effectivePlan(user);
  if (!plan.remoteControl) {
    return { ok: false, reason: plan.id === 'pending' ? 'pending_activation' : 'plan_monitor_only' };
  }
  if (!internetControlAllowed(ip)) return { ok: false, reason: 'control_lan_only' };
  return { ok: true };
}

/** false = chỉ IP trong CONTROL_LAN_CIDRS (hoặc loopback) được ghi lệnh. */
export function internetControlAllowed(ip) {
  if (String(process.env.CONTROL_FROM_INTERNET || 'true').toLowerCase() !== 'false') return true;
  const raw = String(process.env.CONTROL_LAN_CIDRS || '').trim();
  if (!raw) {
    // Không cấu hình LAN → chỉ cho loopback / Docker nội bộ
    return isLoopback(ip);
  }
  try {
    return ipInCidrs(ip, raw.split(',').map((s) => s.trim()).filter(Boolean)) || isLoopback(ip);
  } catch {
    return isLoopback(ip);
  }
}

function isLoopback(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  return s === '127.0.0.1' || s === '::1';
}

export function mayPartnerCmd(tenant, { ip } = {}) {
  if (String(process.env.PARTNER_CMD_ENABLED || 'false').toLowerCase() === 'false') {
    return { ok: false, reason: 'partner_cmd_disabled' };
  }
  if (!internetControlAllowed(ip)) return { ok: false, reason: 'control_lan_only' };
  // Tenant gắn plan_code tùy chọn trên bảng tenants (cột sub_plan)
  const tplan = PLAN_CATALOG[resolvePlanId(tenant?.sub_plan)];
  if (tplan && !tplan.integrations) return { ok: false, reason: 'plan_monitor_only' };   // gói không có tích hợp (Webhook/API) thì tenant không gửi lệnh đối tác
  if (tenant?.sub_expires_at != null && Number(tenant.sub_expires_at) <= Date.now()) {
    return { ok: false, reason: 'plan_expired' };
  }
  return { ok: true };
}

export function subscriptionInfo(user) {
  const plan = effectivePlan(user);
  const active = planActive(user);
  const pendingActivation = false;   // không còn trạng thái chờ: chưa gán gói = gói miễn phí
  const remoteControl = active
    && !pendingActivation
    && user?.remote_control !== 0
    && user?.remote_control !== false
    && Boolean(plan.remoteControl);
  return {
    ...retentionInfo(user),   // trước các khoá plan/… bên dưới (retentionInfo cũng có khoá "plan" riêng, không được ghi đè gói thật)
    plan: plan.id || 'legacy',
    planCode: plan.code || null,                       // mã nói với khách: DK10 / DK20 / DK30 / DK100 / DK300
    planTitle: plan.id ? planTitle(plan.id) : 'legacy',
    limits: planLimits(user),
    widgetLimit: planWidgetLimit(user),
    planLabel: plan.label,
    active: active && !pendingActivation,
    pendingActivation,
    expiresAt: user?.sub_expires_at ?? null,
    // Hạ gói đã lên lịch: giữ gói hiện tại đến hết hạn rồi tự chuyển sang gói này
    nextPlan: user?.sub_next_plan && PLAN_CATALOG[user.sub_next_plan] ? user.sub_next_plan : null,
    nextPlanLabel: user?.sub_next_plan && PLAN_CATALOG[user.sub_next_plan] ? PLAN_CATALOG[user.sub_next_plan].label : null,
    remoteControl,
  };
}

/** Gán gói mặc định khi tạo tài khoản — tắt mặc định (SUBSCRIBE_AUTO_GRANT=false). */
export function applyDefaultSubscription(db, userId) {
  if (!requireSubscriptionActivation()) return { ok: true, skipped: true };
  if (!subscribeAutoGrant()) return { ok: true, skipped: true, pending: true };
  return grantPlan(db, userId, defaultSubscribePlan(), { expiresAt: 'never', note: 'default_on_register' });
}

/** Gán gói + hạn + retention + remote_control trong một giao dịch. */
export function grantPlan(db, userId, planInput, { expiresAt = null, note = '' } = {}) {
  const planId = resolvePlanId(planInput);   // nhận mã khách (DK30) hoặc id nội bộ (monitor)
  const plan = planId ? PLAN_CATALOG[planId] : null;
  if (!plan) return { error: 'unknown_plan', status: 400 };
  let exp = null;
  if (expiresAt != null && expiresAt !== '' && expiresAt !== 'never') {
    const t = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));
    if (!Number.isFinite(t)) return { error: 'bad_expires', status: 400 };
    exp = t;
  }
  const ret = plan.retention === 'default' ? null : plan.retention;
  db.prepare(`
    UPDATE users
    SET sub_plan = ?, sub_expires_at = ?, remote_control = ?, retention_days = ?
    WHERE id = ?
  `).run(planId, exp, plan.remoteControl ? 1 : 0, ret, userId);
  try { db.prepare('UPDATE users SET sub_next_plan = NULL WHERE id = ?').run(userId); } catch { /* cột chưa có */ }
  return {
    ok: true,
    note: String(note || '').slice(0, 200),
    subscription: subscriptionInfo(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)),
  };
}

export function setRemoteControl(db, userId, enabled) {
  db.prepare('UPDATE users SET remote_control = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  return { ok: true, remoteControl: !!enabled };
}

export function grantTenantPlan(db, tenantId, planInput, { expiresAt = null } = {}) {
  const planId = resolvePlanId(planInput);
  const plan = planId ? PLAN_CATALOG[planId] : null;
  if (!plan) return { error: 'unknown_plan', status: 400 };
  let exp = null;
  if (expiresAt != null && expiresAt !== '' && expiresAt !== 'never') {
    const t = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));
    if (!Number.isFinite(t)) return { error: 'bad_expires', status: 400 };
    exp = t;
  }
  db.prepare('UPDATE tenants SET sub_plan = ?, sub_expires_at = ? WHERE id = ?')
    .run(planId, exp, tenantId);
  return { ok: true };
}

// re-export helpers used by plan.js
export { parseRetention, setRetention, clientIp };

/** Khoảng cách tối thiểu (ms) giữa hai message data của gateway thuộc user này (0 = không giới hạn). Gói hết hạn → mức miễn phí. */
export function planTelemetryMinMs(user) {
  const plan = planActive(user) ? effectivePlan(user) : freePlan();
  return Number(plan.telemetryMinMs || 0);
}

/** Số widget tối đa user được dùng (null = không giới hạn). Gói hết hạn quay về mức gói miễn phí. */
export function planWidgetLimit(user) {
  const plan = planActive(user) ? effectivePlan(user) : freePlan();
  return plan.widgets == null ? null : Number(plan.widgets);
}

/**
 * Toàn bộ giới hạn/tính năng của gói đang áp dụng cho user (gói hết hạn → mức gói miễn phí). null = không giới hạn.
 * Tài khoản "legacy" (tắt SUBSCRIBE_REQUIRE_ACTIVATION) không bị giới hạn mới.
 */
export function planLimits(user) {
  const p = planActive(user) ? effectivePlan(user) : freePlan();
  const legacy = !p.id;
  const pick = (k) => (p[k] === undefined ? null : p[k]);
  return {
    plan: p.id || 'legacy',
    code: p.code || null,
    devices: pick('devices'),
    gateways: pick('gateways'),
    members: pick('members'),
    widgets: pick('widgets'),
    rpcPerMin: pick('rpcPerMin'),
    exportDays: pick('exportDays'),
    storeEveryMs: pick('storeEveryMs'),
    telemetryMinMs: pick('telemetryMinMs'),
    integrations: legacy ? true : Boolean(p.integrations),
    advancedRules: legacy ? true : Boolean(p.advancedRules),
    whiteLabel: legacy ? true : Boolean(p.whiteLabel),
    chatAlertsPerMonth: pick('chatAlertsPerMonth'),
  };
}
export const planDeviceLimit = (user) => planLimits(user).devices;
export const planMaxGateways = (user) => planLimits(user).gateways;
export const planMemberLimit = (user) => planLimits(user).members;
export const planExportDays = (user) => planLimits(user).exportDays;
/** Khoảng cách (ms) giữa hai dòng LƯU vào DB (0/null = lưu theo nhịp telemetry như cũ). */
export const planStoreEveryMs = (user) => Number(planLimits(user).storeEveryMs || 0);

/** Ngân sách lệnh điều khiển: tối đa rpcPerMin lệnh / phút / tài khoản (cửa sổ trượt 60 giây). null = không giới hạn. */
const rpcWindows = new Map();   // userId -> [ts...]
export function takeRpcBudget(user, now = Date.now()) {
  const max = planLimits(user).rpcPerMin;
  if (max == null || !user?.id) return { ok: true };
  let arr = rpcWindows.get(user.id);
  if (!arr) { if (rpcWindows.size > 20_000) rpcWindows.clear(); arr = []; rpcWindows.set(user.id, arr); }
  while (arr.length && now - arr[0] >= 60_000) arr.shift();
  if (arr.length >= max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((60_000 - (now - arr[0])) / 1000)), max };
  arr.push(now);
  return { ok: true };
}

/** Thứ hạng gói theo thứ tự khai báo trong PLAN_CATALOG (free < monitor < pro < factory). */
export const planRank = (id) => Object.keys(PLAN_CATALOG).indexOf(id);
