/**
 * Cấu hình điều khiển của từng thiết bị con, đặt LÚC PROVISIONING (hardware_devices.ui_meta.seed[]):
 *   { "childId": "pump1", "type": "pump",
 *     "limits":   { "run": { "min": 0, "max": 1 } },     // khoảng giá trị được ghi cho từng trường
 *     "critical": ["run"] }                               // lệnh nguy hiểm: mỗi lần phải xác nhận (Face ID / TOTP / mật khẩu)
 * Thiết bị lẻ (không seed): "limits"/"critical" nằm thẳng ở gốc ui_meta.
 * Người dùng có thể đánh dấu THÊM lệnh nguy hiểm (user_devices.critical_keys) nhưng không bỏ được cái do tem đặt.
 */
const KEY = /^[A-Za-z0-9_]{1,32}$/;

export function parseMeta(raw) {
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** { key: {min,max} } hợp lệ (số hữu hạn, min <= max); bỏ phần còn lại. */
export function normalizeLimits(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!KEY.test(k) || !v || typeof v !== 'object') continue;
    const min = Number(v.min); const max = Number(v.max);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) out[k] = { min, max };
  }
  return out;
}

export function normalizeKeys(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => KEY.test(k)))];
}

/** Đặc tả của một child theo tem của gateway chứa nó. */
export function specFor(db, { site, gatewayDevice, childId }) {
  const hw = db.prepare('SELECT ui_meta FROM hardware_devices WHERE site = ? AND device = ?').get(site, gatewayDevice);
  const meta = parseMeta(hw?.ui_meta);
  if (!meta) return { limits: {}, critical: [] };
  const seeds = Array.isArray(meta.seed) ? meta.seed : null;
  const s = seeds ? seeds.find((x) => String(x.childId || x.id) === childId) : meta;
  return { limits: normalizeLimits(s?.limits), critical: normalizeKeys(s?.critical) };
}

export function parseUserKeys(raw) {
  if (!raw) return [];
  try { return normalizeKeys(JSON.parse(raw)); } catch { return []; }
}

/** Gắn limits/critical vào cmd của widget (nút) theo đặc tả tem + dấu của người dùng. */
export function applyControlSpec(widgets, { spec, userCritical }) {
  return widgets.map((w) => {
    if (!w.cmd || w.cmd.key == null) return w;
    const locked = (spec?.critical || []).includes(w.cmd.key);
    const critical = locked || (userCritical || []).includes(w.cmd.key);
    const lim = spec?.limits?.[w.cmd.key];
    return { ...w, cmd: { ...w.cmd, critical, criticalLocked: locked, ...(lim ? { limits: lim } : {}) } };
  });
}
