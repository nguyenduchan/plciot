/**
 * Smoke test bộ gói DK10 / DK20 / DK30 / DK100 / DK300: mã gói, giới hạn, ngân sách lệnh, gộp telemetry 1 phút, giới hạn thiết bị.
 * Chạy: node scripts/smoke-plans.js (DB tạm trong bộ nhớ, không đụng dữ liệu thật).
 */
import Database from 'better-sqlite3';
import {
  PLAN_CATALOG, resolvePlanId, planTitle, listPlans, planLimits, planRank, takeRpcBudget, grantPlan, subscriptionInfo, freePlan, loadPlans, validatePlansConfig, plansFilePath,
} from '../src/entitlements.js';
import { createTeleAggregator } from '../src/aggregate.js';
import { applyWidgetLimit } from '../src/uiContract.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); };

// ---- mã gói: DK + số thiết bị tối đa
const codes = Object.fromEntries(Object.entries(PLAN_CATALOG).map(([id, p]) => [id, p.code]));
ok(JSON.stringify(codes) === JSON.stringify({ free: 'DK10', plus: 'DK20', monitor: 'DK30', sme: 'DK50', pro: 'DK100', bizplus: 'DK200', factory: 'DK300' }), 'mã gói DK10/20/30/50/100/200/300 đúng thứ tự thấp → cao');
ok(Object.values(PLAN_CATALOG).every((p) => p.code === `DK${p.devices}`), 'số trong mã = số thiết bị tối đa của gói');
ok(new Set(Object.values(codes)).size === 7, 'mã gói không trùng nhau');
ok(Object.values(PLAN_CATALOG).every((p) => p.label && p.description && p.audience), 'mọi gói có tên, mô tả, đối tượng');
ok(resolvePlanId('dk30') === 'monitor' && resolvePlanId('DK-100') === 'pro' && resolvePlanId('dk 20') === 'plus', 'nhập mã không phân biệt hoa thường / dấu cách / gạch nối');
ok(resolvePlanId('monitor') === 'monitor' && resolvePlanId('FREE') === 'free', 'id nội bộ vẫn nhận');
ok(resolvePlanId('DK999') === null && resolvePlanId('') === null, 'mã lạ → null');
ok(planTitle('monitor').startsWith('DK30 · '), 'tên hiển thị có mã');
ok(listPlans().length === 7 && listPlans().every((p) => p.code && p.title), 'listPlans có mã + tên');

// ---- thang giới hạn tăng dần
const L = (id) => PLAN_CATALOG[id];
const ids = Object.keys(PLAN_CATALOG);
const inc = (k) => ids.every((id, i) => i === 0 || (L(id)[k] ?? Infinity) >= (L(ids[i - 1])[k] ?? Infinity));
ok(['devices', 'gateways', 'members', 'rpcPerMin', 'widgets'].every(inc), 'thiết bị / gateway / nhân viên / lệnh / widget tăng dần theo gói');
ok(ids.every((id, i) => i === 0 || (L(id).retention === 0 ? Infinity : L(id).retention) > (L(ids[i - 1]).retention === 0 ? Infinity : L(ids[i - 1]).retention)), 'thời hạn lưu tăng dần (gói trả phí luôn dài hơn gói miễn phí)');
ok(ids.every((id, i) => i === 0 || L(id).storeEveryMs <= L(ids[i - 1]).storeEveryMs), 'chu kỳ lưu càng gói cao càng mau');
ok(L('free').storeEveryMs === 60000 && L('free').telemetryMinMs === 2000 && L('free').retention === 30, 'DK10: gửi 2 giây, lưu 1 phút/lần, giữ 30 ngày');
ok(L('free').devices === 10 && L('free').gateways === 1 && L('free').members === 2 && L('free').rpcPerMin === 60 && L('free').exportDays === 7, 'DK10: 1 gateway + 10 thiết bị + 2 nhân viên + 60 lệnh/phút + xuất 7 ngày');
ok(!L('free').integrations && !L('free').advancedRules && !L('free').whiteLabel, 'DK10 khoá Webhook/API, quy tắc nâng cao, logo riêng');
ok(L('pro').integrations && !L('sme').integrations && L('bizplus').whiteLabel && !L('pro').whiteLabel, 'Webhook/API bắt đầu từ DK100, logo riêng từ DK200');
ok(L('plus').exportDays == null && L('monitor').exportDays == null, 'từ DK20 trở lên xuất báo cáo không giới hạn');
ok(ids.filter((id) => L(id).priceVndMonth != null).every((id, i, a) => i === 0 || L(id).priceVndMonth > L(a[i - 1]).priceVndMonth) && L('free').priceVndMonth === 0, 'giá tăng dần từng nấc');

// ---- giới hạn theo user (hết hạn → quay về DK10)
const free = { id: 1 };
ok(planLimits(free).plan === 'free' && planLimits(free).devices === 10, 'chưa gán gói → DK10');
const starter = { id: 2, sub_plan: 'monitor' };
ok(planLimits(starter).devices === 30 && planLimits(starter).gateways === 2 && planLimits(starter).exportDays === null, 'DK30: 30 thiết bị, 2 gateway, xuất không giới hạn');
const expired = { id: 3, sub_plan: 'pro', sub_expires_at: Date.now() - 1000 };
ok(planLimits(expired).plan === 'free' && planLimits(expired).integrations === false, 'gói hết hạn quay về DK10 (khoá API)');

// ---- ngân sách lệnh 60/phút (cửa sổ trượt)
const t0 = 1_000_000;
let allowed = 0;
for (let i = 0; i < 100; i++) if (takeRpcBudget(free, t0 + i * 100).ok) allowed++;   // 100 lệnh trong 10 giây
ok(allowed === 60, `DK10 cho đúng 60 lệnh/phút (đạt ${allowed})`);
const blocked = takeRpcBudget(free, t0 + 10_000);
ok(!blocked.ok && blocked.retryAfterSec >= 1 && blocked.max === 60, 'lệnh thứ 61 bị chặn kèm thời gian chờ');
ok(takeRpcBudget(free, t0 + 61_000).ok, 'sau 60 giây được gửi lại');
let a2 = 0; for (let i = 0; i < 100; i++) if (takeRpcBudget(starter, t0 + i * 100).ok) a2++;
ok(a2 === 90, `DK30 cho đúng 90 lệnh/phút (đạt ${a2})`);

// ---- khoá thiết bị vượt hạn mức
const node = (n) => ({ id: `d${n}`, widgets: [{ id: `w${n}a` }, { id: `w${n}b` }] });
const nodes = Array.from({ length: 12 }, (_, i) => node(i));
const lim = applyWidgetLimit(nodes, 30, 10);
ok(lim.nodes.slice(0, 10).every((d) => d.widgets.every((w) => !w.locked)), '10 thiết bị đầu mở');
ok(lim.nodes.slice(10).every((d) => d.widgets.every((w) => w.locked)), 'thiết bị thứ 11, 12 bị khoá');
ok(lim.locked === 4, 'đếm đúng widget bị khoá');
ok(applyWidgetLimit(nodes, null, null).locked === 0, 'không giới hạn thì không khoá');

// ---- gộp telemetry 1 phút: trung bình / nhỏ nhất / lớn nhất
const agg = createTeleAggregator();
const base = Date.UTC(2026, 10, 18, 10, 0, 0);
const rows = [];
for (let s = 0; s < 120; s += 2) {   // 2 phút, mỗi 2 giây một mẫu: level 10..? tăng dần, pump bật tắt
  const r = agg.add('t/s/d', base + s * 1000, { tank: { level: s }, pump: { run: s % 4 === 0 ? 1 : 0 } }, 60000, { site: 's', device: 'd' });
  if (r) rows.push(r);
}
ok(rows.length === 1, 'sau 2 phút có đúng 1 dòng hoàn chỉnh (phút đầu), phút sau chờ sweep');
const p0 = JSON.parse(rows[0].payload);
ok(rows[0].ts === base && p0.w === 60000 && p0.agg.n === 30, 'dòng đầu: ts = đầu phút, 30 mẫu');
ok(p0.d.tank.level === 29 && p0.agg.mn.tank.level === 0 && p0.agg.mx.tank.level === 58, 'trung bình 29, nhỏ nhất 0, lớn nhất 58');
ok(p0.d.pump.run === 0.5 && p0.agg.mx.pump.run === 1 && p0.agg.mn.pump.run === 0, 'trạng thái bật/tắt gộp thành tỉ lệ bật');
ok(agg.sweep(base + 90_000).length === 0, 'phút hai chưa kết thúc: chưa đẩy ra');
const tail = agg.sweep(base + 121_000);
ok(tail.length === 1 && tail[0].ts === base + 60000 && tail[0].meta.site === 's', 'phút hai được đẩy khi kết thúc (gateway ngừng gửi vẫn lưu đủ)');
ok(agg.size() === 0, 'không còn trạng thái treo');
ok(agg.add('x', base, { a: { s: 'text', n: NaN } }, 60000) === null && agg.sweep(base + 61_000).length === 0, 'giá trị không phải số bị bỏ, không tạo dòng rỗng');

// ---- trung bình THEO THỜI GIAN (mẫu thưa, không đều: gateway chỉ gửi khi đổi hoặc đủ chu kỳ lưu)
{
  const a = createTeleAggregator();
  const T = Date.UTC(2026, 10, 18, 11, 0, 0);
  const m = { site: 's', device: 'd' };
  a.add('k', T, { x: { v: 10 } }, 60000, m);             // đứng yên ở 10
  a.add('k', T + 55_000, { x: { v: 70 } }, 60000, m);    // đổi lên 70 ở giây 55
  const r1 = a.add('k', T + 70_000, { x: { v: 80 } }, 60000, m);   // sang cửa sổ sau (giây 70) → đẩy cửa sổ 1
  const w1 = JSON.parse(r1.payload);
  ok(Math.abs(w1.d.x.v - 15) < 1e-9, `đứng yên 55 s ở 10 rồi 5 s ở 70 → trung bình theo thời gian 15 (không phải 40): ${w1.d.x.v}`);
  ok(w1.agg.n === 2 && w1.agg.mn.x.v === 10 && w1.agg.mx.x.v === 70, 'n = số mẫu thật, min/max đúng');
  const r2 = a.sweep(T + 121_000)[0];
  const w2 = JSON.parse(r2.payload);
  ok(Math.abs(w2.d.x.v - (70 * 10 + 80 * 50) / 60) < 1e-4, `giá trị 70 được giữ từ đầu cửa sổ 2 tới khi đổi ở giây 70: ${w2.d.x.v}`);
  ok(w2.agg.mn.x.v === 70 && w2.agg.mx.x.v === 80, 'min/max cửa sổ 2 gồm giá trị giữ từ cửa sổ trước');
  // gateway gửi mỗi chu kỳ lưu một mẫu, dữ liệu không đổi
  const b2 = createTeleAggregator();
  const hb = [];
  for (let i = 0; i < 4; i++) { const r = b2.add('h', T + i * 60_000 + 5000, { y: { v: 42 } }, 60000, m); if (r) hb.push(JSON.parse(r.payload)); }
  ok(hb.length === 3 && hb.every((p) => p.d.y.v === 42 && p.agg.mn.y.v === 42 && p.agg.mx.y.v === 42 && p.agg.n === 1), 'không đổi, mỗi chu kỳ một mẫu: mỗi cửa sổ một dòng đúng giá trị');
  // gateway im lặng 5 phút: không giữ giá trị cũ qua khoảng mất liên lạc
  const c2 = createTeleAggregator();
  c2.add('g', T + 5000, { z: { v: 1 } }, 60000, m);
  c2.sweep(T + 61_000);
  c2.add('g', T + 6 * 60_000 + 5000, { z: { v: 9 } }, 60000, m);
  const w3 = JSON.parse(c2.sweep(T + 7 * 60_000 + 1000)[0].payload);
  ok(w3.d.z.v === 9 && w3.agg.mn.z.v === 9, `sau khi im lặng 5 phút không giữ giá trị cũ (trung bình ${w3.d.z.v})`);
}

// ---- cấp gói bằng mã
const db = new Database(':memory:');
db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, sub_plan TEXT, sub_expires_at INTEGER, remote_control INTEGER, retention_days INTEGER, sub_next_plan TEXT)');
db.prepare("INSERT INTO users (id, username) VALUES (1, 'a')").run();
const g = grantPlan(db, 1, 'DK30', { expiresAt: 'never' });
ok(g.ok && db.prepare('SELECT sub_plan, retention_days FROM users WHERE id = 1').get().sub_plan === 'monitor', 'cấp gói bằng mã DK30 → lưu id nội bộ monitor');
ok(db.prepare('SELECT retention_days FROM users WHERE id = 1').get().retention_days === 120, 'DK30 giữ 120 ngày');
ok(grantPlan(db, 1, 'DK999').error === 'unknown_plan', 'mã lạ bị từ chối');
const info = subscriptionInfo(db.prepare('SELECT * FROM users WHERE id = 1').get());
ok(info.planCode === 'DK30' && info.limits.devices === 30 && info.planTitle.startsWith('DK30'), 'subscriptionInfo trả mã + giới hạn cho app');
grantPlan(db, 1, 'DK10', { expiresAt: 'never' });
ok(db.prepare('SELECT retention_days FROM users WHERE id = 1').get().retention_days === freePlan().retention, 'DK10 giữ số ngày đúng cấu hình');
ok(planRank('free') < planRank('plus') && planRank('plus') < planRank('monitor'), 'thứ hạng gói');


// ---- cấu hình trong file, không hard-code: validate + đổi file là đổi gói (nạp lại nóng)
const bad = (cfg, re, m) => { try { validatePlansConfig(cfg); ok(false, m); } catch (e) { ok(re.test(e.message), `${m} → ${e.message}`); } };
const one = (over = {}) => ({ freePlan: 'a', plans: { a: { code: 'X1', label: 'A', retention: 5, telemetryMinMs: 1000, ...over } } });
ok(validatePlansConfig(one()).freePlan === 'a', 'cấu hình tối thiểu hợp lệ');
bad({}, /plans/, 'thiếu plans bị từ chối');
bad(one({ code: 'x y z!' }), /code/, 'mã gói sai định dạng bị từ chối');
bad({ plans: { a: { code: 'X1', label: 'A', retention: 1, telemetryMinMs: 1 }, b: { code: 'x1', label: 'B', retention: 1, telemetryMinMs: 1 } } }, /trùng/, 'mã gói trùng bị từ chối');
bad(one({ devices: -1 }), /devices/, 'số âm bị từ chối');
bad(one({ devices: '10' }), /devices/, 'số dạng chữ bị từ chối');
bad(one({ label: '' }), /label/, 'thiếu tên bị từ chối');
bad({ freePlan: 'zz', plans: one().plans }, /freePlan/, 'freePlan không tồn tại bị từ chối');
bad({ plans: { 'Bad-Id': { code: 'X1', label: 'A', retention: 1, telemetryMinMs: 1 } } }, /id gói/, 'id gói sai định dạng bị từ chối');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
const file = path.join(dir, 'plans.json');
const cfgOf = (devices, code = 'ZZ1') => ({ freePlan: 'zz', plans: { zz: { code, label: 'Thử', retention: 3, telemetryMinMs: 1500, devices, gateways: 2, storeEveryMs: 5000 }, yy: { code: 'ZZ2', label: 'Cao', retention: 9, telemetryMinMs: 500, devices: devices * 2 } } });
const keepRoot = fs.readFileSync(plansFilePath(), 'utf8');
process.env.PLANS_FILE = file;
fs.writeFileSync(file, JSON.stringify(cfgOf(7)));
ok(loadPlans({ force: true }).ok && PLAN_CATALOG.zz.devices === 7 && Object.keys(PLAN_CATALOG).join() === 'zz,yy', 'đổi file → danh mục gói đổi theo (không cần sửa mã)');
ok(planLimits({ id: 9 }).devices === 7 && planLimits({ id: 9 }).gateways === 2 && freePlan().id === 'zz', 'giới hạn + gói miễn phí đọc từ file');
ok(resolvePlanId('zz2') === 'yy' && listPlans().length === 2 && planRank('yy') === 1, 'mã gói, danh sách, thứ hạng theo file');
fs.writeFileSync(file, '{ hỏng');
const r2 = loadPlans({ force: true });
ok(!r2.ok && PLAN_CATALOG.zz.devices === 7, 'file hỏng → giữ cấu hình đang chạy, không sập');
fs.writeFileSync(file, JSON.stringify(cfgOf(11)));
ok(loadPlans({ force: true }).ok && PLAN_CATALOG.zz.devices === 11, 'sửa lại file → nạp lại');
fs.writeFileSync(file, JSON.stringify(cfgOf(11, 'ZZ1')) + ' ');
ok(loadPlans().changed === true || loadPlans().changed === false, 'nạp theo mtime không lỗi');
delete process.env.PLANS_FILE;
loadPlans({ force: true });
ok(PLAN_CATALOG.free?.code === 'DK10' && Object.keys(PLAN_CATALOG).length === 7, 'bỏ PLANS_FILE → quay về file mặc định/chạy thật');
fs.rmSync(dir, { recursive: true, force: true });
void keepRoot;
console.log(fail ? `\n${fail} lỗi` : '\nTất cả đạt');
process.exit(fail ? 1 : 0);
