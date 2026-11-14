/**
 * Gói đăng ký quản lý tay (không thanh toán online).
 * Admin cấp trên VPS qua `node scripts/plan.js` — tiền/chuyển khoản xử lý ngoài hệ thống.
 *
 * Cột users:
 *   sub_plan         monitor | pro | factory | (null = theo role cũ)
 *   sub_expires_at   ms; null = không hết hạn
 *   remote_control   1 cho phép lệnh từ xa (nếu role + gói cho phép); 0 = chỉ xem
 */
import { canControl as roleCanControl } from './roles.js';
import { setRetention, parseRetention, retentionInfo, defaultDays } from './retention.js';
import { ipInCidrs, clientIp } from '@plciot/security';

/** Định nghĩa gói — không gắn giá tiền trong mã. */
/** Số widget tối đa của gói miễn phí (vượt quá: làm mờ, không cập nhật data, không điều khiển). */
export const FREE_WIDGET_LIMIT = Number(process.env.FREE_WIDGET_LIMIT || 5);

/** Gói miễn phí: tối đa 1 message data mỗi 2 giây mỗi gateway (server bỏ bớt phần vượt). Gói khác: không giới hạn thêm. */
export const FREE_TELEMETRY_MIN_MS = Number(process.env.FREE_TELEMETRY_MIN_MS || 2000);

export const PLAN_CATALOG = Object.freeze({
  // Gói miễn phí (mặc định khi chưa gán gói): có giám sát + điều khiển, nhưng giới hạn số widget (xem FREE_WIDGET_LIMIT).
  free: {
    label: 'Miễn phí',
    retention: 'default',
    remoteControl: true,
    partnerCmd: false,
    widgets: FREE_WIDGET_LIMIT,
    telemetryMinMs: FREE_TELEMETRY_MIN_MS,
  },
  // Cơ bản — trạm bơm / xưởng nhỏ: tối đa 30 widget, lịch sử 1 mẫu/10 giây giữ 7 ngày
  monitor: {
    label: 'Cơ bản',
    retention: 7,
    remoteControl: true,   // mọi gói đều có giám sát + điều khiển
    partnerCmd: false,
    widgets: Number(process.env.BASIC_WIDGET_LIMIT || 30),
    telemetryMinMs: Number(process.env.PAID_TELEMETRY_MIN_MS || 10000),
  },
  // Nâng cao — xưởng vừa, nhiều trạm: tối đa 100 widget, lịch sử 1 mẫu/10 giây giữ 30 ngày
  pro: {
    label: 'Nâng cao',
    retention: 30,
    remoteControl: true,
    partnerCmd: false,
    widgets: Number(process.env.PRO_WIDGET_LIMIT || 100),
    telemetryMinMs: Number(process.env.PAID_TELEMETRY_MIN_MS || 10000),
  },
  // Nhà máy / partner — TRẢ MỘT LẦN cho 10 năm: chi tiết 1 mẫu/10 giây giữ 30 ngày, sau đó gộp 1 mẫu/5 phút giữ đủ 10 năm
  factory: {
    label: 'Nhà máy / partner',
    retention: 0, // không xoá; dữ liệu cũ hơn hotDays được gộp thưa (thinOldTelemetry)
    remoteControl: true,
    partnerCmd: true,
    widgets: Number(process.env.FACTORY_WIDGET_LIMIT || 300),
    telemetryMinMs: Number(process.env.PAID_TELEMETRY_MIN_MS || 10000),
    hotDays: 30,
    coldSampleMs: 300000,
    oneTime10y: true,
  },
});

export function listPlans() {
  return Object.entries(PLAN_CATALOG).map(([id, p]) => ({
    id,
    ...p,
    retentionDays: p.retention === 'default' ? defaultDays() : p.retention === 0 ? null : p.retention,
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
  const p = String(process.env.SUBSCRIBE_DEFAULT_PLAN || 'monitor').toLowerCase();
  return PLAN_CATALOG[p] ? p : 'monitor';
}

export function planActive(user, now = Date.now()) {
  if (user?.sub_expires_at != null && Number(user.sub_expires_at) <= now) return false;
  return true;
}

export function effectivePlan(user) {
  const id = user?.sub_plan;
  if (id && PLAN_CATALOG[id]) return { id, ...PLAN_CATALOG[id] };
  if (requireSubscriptionActivation()) {
    // Chưa gán gói → gói MIỄN PHÍ (có giám sát + điều khiển, giới hạn widget); admin nâng gói trên Console/trang quản trị
    return { id: 'free', ...PLAN_CATALOG.free };
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
  if (tenant?.sub_plan === 'monitor') return { ok: false, reason: 'plan_monitor_only' };
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
export function grantPlan(db, userId, planId, { expiresAt = null, note = '' } = {}) {
  const plan = PLAN_CATALOG[planId];
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

export function grantTenantPlan(db, tenantId, planId, { expiresAt = null } = {}) {
  const plan = PLAN_CATALOG[planId];
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
  const plan = planActive(user) ? effectivePlan(user) : { telemetryMinMs: FREE_TELEMETRY_MIN_MS };
  return Number(plan.telemetryMinMs || 0);
}

/** Số widget tối đa user được dùng (null = không giới hạn). Gói hết hạn quay về mức gói miễn phí. */
export function planWidgetLimit(user) {
  const plan = planActive(user) ? effectivePlan(user) : { widgets: FREE_WIDGET_LIMIT };
  return plan.widgets == null ? null : Number(plan.widgets);
}

/** Thứ hạng gói theo thứ tự khai báo trong PLAN_CATALOG (free < monitor < pro < factory). */
export const planRank = (id) => Object.keys(PLAN_CATALOG).indexOf(id);
