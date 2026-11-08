/**
 * Loại gateway × kết nối (có internet / chỉ LAN) → cách kích hoạt và gói cấu hình.
 * Một nơi duy nhất quyết định; tool nạp, trang admin và gateway đều theo bảng này.
 *
 *   loại      online                         offline (chỉ LAN)
 *   mcu       none  (nạp USB, bán kèm cấu hình)   challenge (mã theo thử thách, đọc ID từ MCU qua USB)
 *   pc        bind  (tự gắn máy khi enroll)       license (file giấy phép theo ID máy + kit đủ để chạy LAN)
 *   generic   none  (mua sẵn, chỉ topic MQTT)     — không hỗ trợ (cần cloud)
 *
 * activation: none = không kích hoạt; bind = server gắn máy khi gateway enroll kèm hw;
 *             challenge = mã 20 ký tự theo mã yêu cầu của gateway; license = khoá bản quyền theo ID máy.
 */
import { deriveDeviceKey } from '@plciot/security';
import { seedFromHardware } from './gatewayEnroll.js';
import { getDeviceType } from './uiContract.js';

export const GATEWAY_KINDS = {
  mcu: { title: 'Gateway MCU (firmware, nối USB/LAN)', online: 'none', offline: 'challenge' },
  pc: { title: 'Gateway PC (phần mềm cài trên máy khách)', online: 'bind', offline: 'license' },
  generic: { title: 'Gateway mua sẵn (chỉ cấu hình topic MQTT)', online: 'none', offline: null },
};

const NEEDS_HW = new Set(['bind', 'license']);

/** → { kind, connectivity, activation, needsHw, offlineKit } hoặc { error, status }. */
export function planFor(kind, connectivity) {
  const k = GATEWAY_KINDS[String(kind || '')];
  if (!k) return { error: 'invalid_gateway_kind', status: 400 };
  const conn = connectivity === 'offline' ? 'offline' : 'online';
  const activation = k[conn];
  if (!activation) return { error: 'offline_not_supported', status: 400 };
  return {
    kind, connectivity: conn, activation,
    needsHw: NEEDS_HW.has(activation),
    offlineKit: conn === 'offline',
  };
}

export const listKinds = () => Object.entries(GATEWAY_KINDS).map(([id, k]) => ({
  id, title: k.title, online: k.online, offline: k.offline,
}));

/** Giấy phép một file: gateway PC đọc, tự kiểm với ID máy của chính nó (xem tools/GatewayLicense). */
export function buildLicenseFile(act, { site, device } = {}) {
  return {
    v: 1, type: 'plciot-license', site: site || null, device: device || null,
    hw: act.hw, key: deriveDeviceKey(act.hw), code: act.code,
    mode: act.mode || 'license', exp: act.exp || 0,
  };
}

/** Kit chạy LAN không cần cloud: định nghĩa type/widget của các thiết bị con (nguồn duy nhất vẫn là server). */
export function offlineBundle(db, site, device) {
  const row = db.prepare('SELECT * FROM hardware_devices WHERE site = ? AND device = ?').get(site, device);
  if (!row) return null;
  const { children, configRev } = seedFromHardware(row);
  const types = {};
  for (const c of children) {
    const t = getDeviceType(c.type);
    if (t) types[c.type] = t;
  }
  return {
    schema: 1, configRev,
    children: children.map((c) => ({ id: c.id, type: c.type, title: c.title, fields: c.fields })),
    types,
  };
}
