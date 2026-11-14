/**
 * Cảnh báo năng lực server: chỉ theo CPU, RAM, SSD (không giới hạn cứng số kết nối/gateway).
 * Dùng khi admin thêm gateway (ghép cặp / duyệt) và kiểm tra định kỳ; không chặn thao tác, chỉ trả `capacityWarnings`.
 */
import fs from 'node:fs';
import os from 'node:os';
import { FREE_TELEMETRY_MIN_MS } from './entitlements.js';
import { defaultDays } from './retention.js';

const MB = 1024 * 1024;
const BYTES_PER_ROW = Number(process.env.CAPACITY_BYTES_PER_ROW || 280);   // payload + index SQLite (ước lượng)

const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);

function memAvailableMb() {
  try {
    const m = /MemAvailable:\s+(\d+)\s*kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) / 1024;
  } catch { /* không phải Linux */ }
  return os.freemem() / MB;
}

/** Dung lượng DB ghi mỗi ngày cho 1 gateway gói miễn phí (MB). */
export function mbPerGatewayDay() {
  const rowsPerDay = 86_400_000 / Math.max(FREE_TELEMETRY_MIN_MS, 200);
  return (rowsPerDay * BYTES_PER_ROW) / MB;
}

export function gatewayCount(db) {
  try { return db.prepare('SELECT COUNT(*) n FROM hardware_devices').get().n | 0; } catch { return 0; }
}

/**
 * @param {{extraGateways?: number}} opt  extraGateways = số gateway sắp thêm (kiểm tra trước khi thêm)
 * @returns {{ok:boolean, warnings:string[], stats:object}}
 */
export function capacityStatus(db, dataDir, { extraGateways = 0 } = {}) {
  const cores = os.cpus().length || 1;
  const load1 = os.loadavg()[0];
  const loadPerCore = load1 / cores;
  const memFree = memAvailableMb();
  const memTotal = os.totalmem() / MB;
  let diskFree = null; let diskTotal = null;
  try { const s = fs.statfsSync(dataDir || process.env.DATA_DIR || './data'); diskFree = (s.bavail * s.bsize) / MB; diskTotal = (s.blocks * s.bsize) / MB; } catch { /* bỏ qua */ }

  const gws = gatewayCount(db);
  const days = Math.max(1, defaultDays());
  const perGw = mbPerGatewayDay() * days;
  const need = (gws + extraGateways) * perGw;
  const diskBudget = diskFree == null ? null : diskFree * (1 - num('CAPACITY_DISK_RESERVE', 0.2));

  const warnings = [];
  const warnLoad = num('CAPACITY_WARN_LOAD_PER_CORE', 0.7);
  if (loadPerCore >= warnLoad) warnings.push(`CPU cao: tải ${load1.toFixed(2)} trên ${cores} core (${Math.round(loadPerCore * 100)}%/core). Thêm gateway sẽ tăng tải ingest — cân nhắc nâng VPS.`);
  const warnMemMb = num('CAPACITY_WARN_MEM_MB', 300);
  if (memFree < warnMemMb || memFree / memTotal < 0.15) warnings.push(`RAM còn ít: khả dụng ${Math.round(memFree)} MB / ${Math.round(memTotal)} MB. Cân nhắc nâng RAM.`);
  if (diskFree != null) {
    if (diskFree / diskTotal < num('CAPACITY_WARN_DISK_FREE', 0.2)) warnings.push(`SSD còn ít: trống ${(diskFree / 1024).toFixed(1)} GB / ${(diskTotal / 1024).toFixed(1)} GB. Cần dọn dữ liệu hoặc nâng ổ đĩa.`);
    if (need > diskBudget) warnings.push(`SSD không đủ cho ${gws + extraGateways} gateway: cần ~${(need / 1024).toFixed(1)} GB lịch sử (${days} ngày, ${perGw.toFixed(0)} MB/gateway), còn dùng được ~${(diskBudget / 1024).toFixed(1)} GB.`);
  }
  return {
    ok: warnings.length === 0,
    warnings,
    stats: {
      cores, load1, loadPerCore, memAvailableMb: Math.round(memFree), memTotalMb: Math.round(memTotal),
      diskFreeMb: diskFree == null ? null : Math.round(diskFree), diskTotalMb: diskTotal == null ? null : Math.round(diskTotal),
      gateways: gws, mbPerGatewayRetained: Math.round(perGw), estimatedMaxGatewaysByDisk: diskBudget == null ? null : Math.floor(diskBudget / perGw),
    },
  };
}
