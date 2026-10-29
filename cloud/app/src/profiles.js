/**
 * Solution profiles: whitelist thanh ghi + khoảng giá trị theo từng loại giải pháp.
 * Tenant/device có thể gắn profile; không gắn → dùng env CONTROL_* như trước (conveyor mặc định).
 */
import { plcControlConfig } from './plcCommands.js';

/** Hồ sơ có sẵn — mở rộng khi thêm giải pháp partner. */
export const PROFILES = Object.freeze({
  'conveyor-v1': {
    label: 'Băng tải / đếm sản phẩm (XD3)',
    writable: [3, 4, 6, 7, 9],
    limits: { 3: [0, 1], 4: [0, 255], 6: [0, 1], 7: [0, 60000], 9: [1, 1] },
    critical: [4, 6],
  },
  'monitor-only': {
    label: 'Chỉ giám sát (không ghi)',
    writable: [],
    limits: {},
    critical: [],
  },
  'generic-holding-v1': {
    label: 'Holding register tổng quát (đối tác tự thu hẹp bằng limits)',
    writable: Array.from({ length: 40 }, (_, i) => i),
    limits: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, [0, 65535]])),
    critical: [],
  },
});

export function listProfiles() {
  return Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, writable: p.writable }));
}

/**
 * @param {string|null|undefined} profileId
 * @returns {{ limits: object, writable: Set, critical: Set, physicalBit: number|null, physicalWaitMs: number, profile: string|null }}
 */
export function controlConfigFor(profileId) {
  const base = plcControlConfig();
  const id = profileId && PROFILES[profileId] ? profileId : null;
  if (!id) return { ...base, profile: null };
  const p = PROFILES[id];
  return {
    limits: { ...p.limits },
    writable: new Set(p.writable),
    critical: new Set(p.critical),
    physicalBit: base.physicalBit,
    physicalWaitMs: base.physicalWaitMs,
    profile: id,
  };
}
