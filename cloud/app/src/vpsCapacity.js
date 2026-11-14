/**
 * (Bổ sung cho capacity.js, cảnh báo CPU/RAM/SSD khi thêm gateway.) Sức chứa VPS cho admin: đĩa thật, kích thước DB, số widget theo gói, đĩa DỰ KIẾN khi các gói đầy thời gian lưu,
 * tốc độ tăng và số ngày còn lại đến khi đầy. Chỉ đọc; không gửi thông báo ra ngoài (ghi log cảnh báo khi đổi mức).
 *
 * Ngưỡng (đặt lại bằng biến môi trường): CAP_WARN_PCT=70, CAP_CRIT_PCT=85 (phần trăm đĩa), CAP_WIDGETS_WARN=800, CAP_WIDGETS_MAX=1000.
 * "Đĩa dùng được" lấy từ PRICING_DISK_USABLE_GB (cùng giả định với bảng giá).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectivePlan } from './entitlements.js';
import { costFloor, PRICING } from './pricing.js';
import { PLAN_CATALOG } from './entitlements.js';
import { listUserDevices } from './userDevices.js';
import { deviceToUiNode, applyWidgetLimit } from './uiContract.js';

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const T = () => ({ warn: num('CAP_WARN_PCT', 70), crit: num('CAP_CRIT_PCT', 85), wWarn: num('CAP_WIDGETS_WARN', 800), wMax: num('CAP_WIDGETS_MAX', 1000) });
const DAY = 86_400_000;
const MB = 1048576;

function ensure(db) {
  db.exec('CREATE TABLE IF NOT EXISTS capacity_samples (day TEXT PRIMARY KEY, ts INTEGER NOT NULL, db_bytes INTEGER NOT NULL, widgets INTEGER NOT NULL)');
}

function fileBytes(p) { try { return fs.statSync(p).size; } catch { return 0; } }

function widgetsByPlan(db) {
  const out = {};
  for (const id of Object.keys(PLAN_CATALOG)) out[id] = { users: 0, widgets: 0 };
  for (const u of db.prepare('SELECT * FROM users WHERE disabled = 0').all()) {
    let w = 0;
    try { w = applyWidgetLimit(listUserDevices(db, u).map(deviceToUiNode), null).total; } catch { w = 0; }
    const id = effectivePlan(u).id || 'free';
    const b = out[id] || (out[id] = { users: 0, widgets: 0 });
    b.users++; b.widgets += w;
  }
  return out;
}

function memInfo() {
  let limit = null;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const v = fs.readFileSync(f, 'utf8').trim(); if (/^\d+$/.test(v) && Number(v) < os.totalmem() * 2) { limit = Number(v); break; } } catch { /* */ }
  }
  return { rssMb: Math.round(process.memoryUsage().rss / MB), limitMb: limit ? Math.round(limit / MB) : null, hostMb: Math.round(os.totalmem() / MB) };
}

/** Ghi một mẫu mỗi ngày (kích thước DB + tổng widget) để ước tốc độ tăng. */
export function sampleCapacity(db, dataDir, now = Date.now()) {
  ensure(db);
  const day = new Date(now).toISOString().slice(0, 10);
  const dbBytes = fileBytes(path.join(dataDir, 'app.db')) + fileBytes(path.join(dataDir, 'app.db-wal'));
  const widgets = Object.values(widgetsByPlan(db)).reduce((a, b) => a + b.widgets, 0);
  db.prepare('INSERT INTO capacity_samples (day, ts, db_bytes, widgets) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET ts=excluded.ts, db_bytes=excluded.db_bytes, widgets=excluded.widgets').run(day, now, dbBytes, widgets);
  db.prepare('DELETE FROM capacity_samples WHERE ts < ?').run(now - 400 * DAY);
}

export function capacityInfo(db, dataDir, now = Date.now()) {
  ensure(db);
  const th = T();
  let disk = null;
  try {
    const st = fs.statfsSync(dataDir);
    const total = Number(st.blocks) * Number(st.bsize); const free = Number(st.bavail) * Number(st.bsize);
    disk = { totalGb: +(total / 1024 ** 3).toFixed(1), freeGb: +(free / 1024 ** 3).toFixed(1), usedPct: total ? Math.round(((total - free) / total) * 100) : null };
  } catch { /* nền tảng không hỗ trợ */ }
  const dbBytes = fileBytes(path.join(dataDir, 'app.db')) + fileBytes(path.join(dataDir, 'app.db-wal'));
  const backupsBytes = (() => { try { const d = path.join(dataDir, 'backups'); return fs.readdirSync(d).reduce((a, f) => a + fileBytes(path.join(d, f)), 0); } catch { return 0; } })();

  const byPlan = widgetsByPlan(db);
  const usableBytes = PRICING.diskUsableGb() * 1024 ** 3;
  const plans = Object.entries(byPlan).map(([id, v]) => {
    const per = PLAN_CATALOG[id] ? costFloor(PLAN_CATALOG[id]).bytesPerWidget : 0;
    return { id, label: PLAN_CATALOG[id]?.label || id, users: v.users, widgets: v.widgets, mbPerWidget: Math.round(per / MB), projectedMb: Math.round((per * v.widgets) / MB) };
  });
  const widgets = plans.reduce((a, p) => a + p.widgets, 0);
  const projectedBytes = plans.reduce((a, p) => a + p.projectedMb * MB, 0);
  const projectedPct = Math.round((projectedBytes / usableBytes) * 100);
  const dbPct = Math.round((dbBytes / usableBytes) * 100);

  // Tốc độ tăng: so mẫu cũ nhất trong 14 ngày với hiện tại
  const old = db.prepare('SELECT ts, db_bytes FROM capacity_samples WHERE ts >= ? ORDER BY ts ASC LIMIT 1').get(now - 14 * DAY);
  let growthMbPerDay = null; let daysLeft = null;
  if (old && now - old.ts >= 2 * DAY) {
    const g = ((dbBytes - old.db_bytes) / ((now - old.ts) / DAY));
    growthMbPerDay = Math.round(g / MB);
    if (g > 0) daysLeft = Math.max(0, Math.round((usableBytes - dbBytes) / g));
  }

  const alerts = [];
  let level = 'ok';
  const up = (l) => { if (l === 'crit' || (l === 'warn' && level === 'ok')) level = l; };
  const pct = Math.max(disk?.usedPct ?? 0, dbPct, projectedPct);
  if (pct >= th.crit) { up('crit'); alerts.push(`Đĩa ${pct}% (≥ ${th.crit}%): cần thêm đĩa/chuyển VPS ngay.`); }
  else if (pct >= th.warn) { up('warn'); alerts.push(`Đĩa ${pct}% (≥ ${th.warn}%): bắt đầu chuẩn bị đĩa lớn hơn.`); }
  if (widgets >= th.wMax) { up('crit'); alerts.push(`${widgets} widget (≥ ${th.wMax}): tới mốc chuyển VPS.`); }
  else if (widgets >= th.wWarn) { up('warn'); alerts.push(`${widgets} widget (≥ ${th.wWarn}): gần mốc ${th.wMax} widget.`); }
  if (daysLeft != null && daysLeft <= 60) { up(daysLeft <= 14 ? 'crit' : 'warn'); alerts.push(`Theo tốc độ tăng hiện tại, còn khoảng ${daysLeft} ngày thì đầy đĩa dùng được.`); }
  if (disk && disk.freeGb < (dbBytes * 1.2) / 1024 ** 3 + 0.25) { up('crit'); alerts.push('Chỗ trống không đủ để sao lưu DB (cần ≈ 1,2 × kích thước DB).'); }

  return {
    level, alerts, thresholds: th,
    disk, usableGb: PRICING.diskUsableGb(), db: { mb: Math.round(dbBytes / MB), pctOfUsable: dbPct }, backupsMb: Math.round(backupsBytes / MB),
    widgets, plans, projected: { mb: Math.round(projectedBytes / MB), pctOfUsable: projectedPct },
    growthMbPerDay, daysLeft, mem: memInfo(),
    assumptions: { vpsMonthVnd: PRICING.vpsMonthVnd(), note: 'Đĩa dùng được = PRICING_DISK_USABLE_GB; đặt lại theo VPS thật.' },
  };
}

export function mountCapacity(app, { db, requireAuth, requireAdmin, dataDir }) {
  ensure(db);
  let cache = null;   // 30 giây: tránh duyệt mọi người dùng ở mỗi lần admin mở/làm mới trang
  app.get('/api/admin/vps-capacity', requireAuth, requireAdmin, (_req, res) => {
    try { if (!cache || Date.now() - cache.at > 30_000) cache = { at: Date.now(), v: capacityInfo(db, dataDir) }; res.json(cache.v); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  let lastLevel = 'ok';
  const run = () => {
    try {
      sampleCapacity(db, dataDir);
      const c = capacityInfo(db, dataDir);
      if (c.level !== lastLevel) { lastLevel = c.level; if (c.level !== 'ok') console.warn(`[capacity] ${c.level.toUpperCase()}: ${c.alerts.join(' | ')}`); else console.log('[capacity] trở lại mức ok'); }
    } catch (e) { console.error('[capacity]', e.message); }
  };
  setTimeout(run, 90_000).unref?.();
  setInterval(run, 3600_000).unref?.();
}
