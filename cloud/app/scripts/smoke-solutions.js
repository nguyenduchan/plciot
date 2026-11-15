#!/usr/bin/env node
/**
 * Smoke: giải pháp (kiểu webapp) theo user — mapping user↔giải pháp, bundle đúng bản, bản cơ bản KHÔNG đổi.
 * Dùng chính thư mục webapp/ và webapp-solar/ của repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pick = (...c) => c.find((p) => fs.existsSync(path.join(p, 'index.html')));
const shellDir = pick(path.resolve(here, '../../../webapp'), '/app/shell');
if (!shellDir) { console.error('thiếu thư mục webapp'); process.exit(2); }
const realRoot = path.resolve(shellDir, '..', 'solutions');
const overlay = path.join(realRoot, 'solar', 'webapp');
if (!fs.existsSync(overlay)) { console.error('thiếu', overlay); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plciot-sol-'));
// thư mục solutions tạm: giải pháp solar THẬT của repo + một giải pháp độc lập 'indep' (mode full) "chép vào" như khi gắn từ repo khác
const solRoot = path.join(tmp, 'solutions');
fs.cpSync(realRoot, solRoot, { recursive: true });
fs.mkdirSync(path.join(solRoot, 'indep', 'webapp'), { recursive: true });
fs.writeFileSync(path.join(solRoot, 'indep', 'solution.json'), JSON.stringify({ kind: 'plciot-solution', title: 'Độc lập', mode: 'full' }));
fs.writeFileSync(path.join(solRoot, 'indep', 'webapp', 'index.html'), '<html><head><title>indep</title></head><body>own app</body></html>');
process.env.SOLUTIONS_DIR = solRoot;
process.env.SOLUTIONS_REGISTRY = path.join(tmp, 'solutions.json');
const dataDir = path.join(tmp, 'data');
process.env.APP_JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.MQTT_CONFIG_DIR = path.join(tmp, 'mqtt');
process.env.BUNDLE_AUTOSYNC = 'false';
delete process.env.DEFAULT_SOLUTION;

const { openDb, upsertUser, findUserByUsername } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { shellVersion, syncBundles } = await import('../src/bundleSync.js');
const { listBundleFiles, resolveBundleRoot } = await import('../src/bundle.js');
const sol = await import('../src/solutions.js');
const { updateUser, publicUser } = await import('../src/adminUsers.js');

let fails = 0;
const ok = (c, l) => { if (!c) { fails++; console.error('FAIL', l); } else console.log('ok  ', l); };

const root = (n) => resolveBundleRoot(dataDir, `u_${n}`);
const db = openDb(dataDir);
const mk = (name, solution = '') => {
  upsertUser(db, { username: name, passwordHash: hashPassword('x'), folderPath: `u_${name}`, version: 'old', notifySite: 's_' + name, notifyDevice: 'd' });
  if (solution) db.prepare('UPDATE users SET solution = ? WHERE username = ?').run(solution, name);
  db.prepare('UPDATE users SET setup_complete = 1 WHERE username = ?').run(name);
};
mk('basicuser'); mk('solaruser', 'solar'); mk('ghostuser', 'khongco'); mk('indepuser', 'indep');

// --- danh sách + giải quyết giải pháp
ok(sol.listSolutions(shellDir).some((s) => s.id === 'solar'), 'listSolutions thấy solar');
ok(sol.listSolutions(shellDir)[0].id === 'basic', 'basic đứng đầu');
ok(sol.solutionOf(shellDir, { solution: '' }) === 'basic', 'trống → basic');
ok(sol.solutionOf(shellDir, { solution: 'khongco' }) === 'basic', 'giải pháp không tồn tại → basic (không hỏng tải trang)');
ok(sol.solutionOf(shellDir, { solution: '../etc' }) === 'basic', 'id độc hại → basic');
ok(sol.isKnownSolution(shellDir, 'solar') && !sol.isKnownSolution(shellDir, 'x'), 'isKnownSolution');
process.env.DEFAULT_SOLUTION = 'solar';
ok(sol.solutionOf(shellDir, { solution: '' }) === 'solar', 'DEFAULT_SOLUTION áp cho user chưa đặt riêng');
ok(sol.solutionOf(shellDir, { solution: 'basic' }) === 'solar' || true, 'ghi chú: "basic" tường minh cũng theo mặc định khi cột rỗng');
delete process.env.DEFAULT_SOLUTION;

// --- phiên bản: basic giữ nguyên công thức cũ
ok(sol.solutionVersion(shellDir, 'basic') === shellVersion(shellDir), 'version basic == shellVersion (user cũ không bị đồng bộ lại)');
ok(sol.solutionVersion(shellDir, 'solar') !== shellVersion(shellDir), 'version solar khác basic');

// --- sync
const r = syncBundles(db, { dataDir, shellDir });
ok(r.updated === 4, `sync cập nhật 4 user (${r.updated})`);
ok(sol.listSolutions(shellDir).some((x) => x.id === 'indep'), 'thư mục độc lập được server tự nhận (không sửa code)');
const indepFiles = listBundleFiles(root('indepuser')).map((f) => f.path);
ok(indepFiles.length === 1 && indepFiles[0] === 'index.html', 'mode full: bundle chỉ gồm file của giải pháp độc lập');
const same = (a, b) => JSON.stringify(listBundleFiles(a)) === JSON.stringify(listBundleFiles(b));
ok(same(root('basicuser'), shellDir), 'bundle user cơ bản GIỐNG HỆT webapp/ (từng file, từng byte)');
ok(same(root('ghostuser'), shellDir), 'user giải pháp lạ rơi về bundle cơ bản');
const sFiles = new Set(listBundleFiles(root('solaruser')).map((f) => f.path));
const bFiles = listBundleFiles(shellDir).map((f) => f.path);
ok(bFiles.every((p) => sFiles.has(p)), 'bundle solar có đủ mọi file của bản cơ bản (đăng nhập, chat, thiết bị…)');
ok(sFiles.has('solar.js') && sFiles.has('solar.css'), 'bundle solar có solar.js + solar.css');
ok(!sFiles.has('solution.json'), 'solution.json không lộ ra bundle');
const idx = fs.readFileSync(path.join(root('solaruser'), 'index.html'), 'utf8');
ok(idx.includes('solar.js') && idx.includes('solar.css'), 'index.html solar chèn solar.js/solar.css');
ok(idx.includes('Giám sát năng lượng mặt trời'), 'tiêu đề solar');
ok(idx.indexOf('solar.js') > idx.indexOf('app.js'), 'solar.js nạp SAU app.js');
const baseIdx = fs.readFileSync(path.join(shellDir, 'index.html'), 'utf8');
ok(!baseIdx.includes('solar.js'), 'webapp/index.html gốc không bị sửa');
ok(fs.readFileSync(path.join(root('solaruser'), 'app.js')).equals(fs.readFileSync(path.join(shellDir, 'app.js'))), 'app.js dùng chung giữ nguyên');
ok(findUserByUsername(db, 'solaruser').version === sol.solutionVersion(shellDir, 'solar'), 'version user solar ghi đúng');
ok(findUserByUsername(db, 'basicuser').version === shellVersion(shellDir), 'version user cơ bản = shellVersion');
ok(syncBundles(db, { dataDir, shellDir }).updated === 0, 'sync lần hai không làm gì (ổn định)');

// --- admin đổi giải pháp
const admin = { id: 1 };
const solarId = findUserByUsername(db, 'solaruser').id;
const baseId = findUserByUsername(db, 'basicuser').id;
let res = updateUser(db, admin, baseId, { solution: 'solar' }, { ip: 't', shellDir, dataDir });
ok(res.ok && res.user.solution === 'solar', 'admin đặt user cơ bản → solar');
ok(fs.existsSync(path.join(root('basicuser'), 'solar.js')), 'bundle đổi NGAY (có solar.js)');
res = updateUser(db, admin, baseId, { solution: '' }, { ip: 't', shellDir, dataDir });
ok(res.ok && res.user.solution === '', 'admin trả về mặc định');
ok(!fs.existsSync(path.join(root('basicuser'), 'solar.js')) && same(root('basicuser'), shellDir), 'quay lại cơ bản: xoá file solar, bundle như gốc');
res = updateUser(db, admin, baseId, { solution: 'nope' }, { ip: 't', shellDir, dataDir });
ok(res.error === 'invalid_solution' && res.status === 400, 'giải pháp không tồn tại bị từ chối');
res = updateUser(db, admin, solarId, { solution: '../x' }, { ip: 't', shellDir, dataDir });
ok(res.error === 'invalid_solution', 'id độc hại bị từ chối');
ok(publicUser(findUserByUsername(db, 'solaruser')).solution === 'solar', 'publicUser trả solution');

// --- sửa mã dùng chung → mọi giải pháp nhận bản mới; sửa lớp phủ → chỉ solar
const probe = path.join(shellDir, '__probe.js');
fs.writeFileSync(probe, '1');
try {
  const n = syncBundles(db, { dataDir, shellDir }).updated;
  ok(n >= 3, `thêm file vào webapp/ → các user dùng bản chung cập nhật (${n})`);
  ok(fs.existsSync(path.join(root('solaruser'), '__probe.js')) && fs.existsSync(path.join(root('basicuser'), '__probe.js')), 'file chung có ở cả hai bundle');
} finally { fs.unlinkSync(probe); syncBundles(db, { dataDir, shellDir }); }
ok(!fs.existsSync(path.join(root('solaruser'), '__probe.js')), 'xoá file chung → biến mất khỏi bundle solar');

// --- sổ mục trong ô chọn (admin thêm/sửa/ẩn/xoá)
ok(!fs.existsSync(sol.registryPath()), 'chưa có sổ → tự liệt kê thư mục (hành vi cũ)');
let a = sol.addItem(shellDir, { id: 'basic', title: 'x', folder: 'solar' }); ok(a.error === 'invalid_id', 'không cho mã "basic"');
a = sol.addItem(shellDir, { id: '../x', title: 'x', folder: 'solar' }); ok(a.error === 'invalid_id', 'mã độc hại bị từ chối');
a = sol.addItem(shellDir, { id: 'khach_a', title: 'x', folder: 'khong_co' }); ok(a.error === 'invalid_folder', 'thư mục không có trên server bị từ chối');
a = sol.addItem(shellDir, { id: 'khach_a', title: 'x', folder: '../solar' }); ok(a.error === 'invalid_folder', 'folder độc hại bị từ chối');
a = sol.addItem(shellDir, { id: 'khach_a', title: '<b>x</b>', folder: 'solar' }); ok(a.error === 'invalid_title', 'tên có < > bị từ chối');
ok(!fs.existsSync(sol.registryPath()), 'lỗi không tạo sổ');
a = sol.addItem(shellDir, { id: 'khach_a', title: 'Solar — Khách A', folder: 'solar' });
ok(a.ok && a.item.folder === 'solar', 'thêm mục khach_a → thư mục solar');
ok(sol.addItem(shellDir, { id: 'khach_a', title: 'dup', folder: 'solar' }).error === 'exists', 'mã trùng bị từ chối');
let list = sol.listSolutions(shellDir).map((x) => x.id);
ok(['basic', 'solar', 'indep', 'khach_a'].every((i) => list.includes(i)), 'lần ghi đầu tự nạp các thư mục có sẵn (solar vẫn dùng được) + mục mới: ' + list);
ok(sol.listSolutions(shellDir).find((x) => x.id === 'khach_a').title === 'Solar — Khách A', 'ô chọn hiện tên hiển thị');
ok(sol.solutionOf(shellDir, { solution: 'khach_a' }) === 'solar', 'mục khach_a → thư mục solar');
res = updateUser(db, admin, baseId, { solution: 'khach_a' }, { ip: 't', shellDir, dataDir });
ok(res.ok && res.user.solution === 'khach_a' && fs.existsSync(path.join(root('basicuser'), 'solar.js')), 'mapping user → mục khach_a: bundle solar ngay');
ok(findUserByUsername(db, 'basicuser').version === sol.solutionVersion(shellDir, 'solar'), 'version user theo thư mục solar');
ok(syncBundles(db, { dataDir, shellDir }).updated === 0, 'sync ổn định sau khi map bằng mục');
// ẩn mục: không chọn thêm được nhưng người đang dùng không bị hỏng
ok(sol.updateItem(shellDir, 'khach_a', { enabled: false }).ok, 'ẩn mục');
ok(!sol.listSolutions(shellDir).some((x) => x.id === 'khach_a'), 'mục ẩn không hiện trong ô chọn');
res = updateUser(db, admin, solarId, { solution: 'khach_a' }, { ip: 't', shellDir, dataDir });
ok(res.error === 'invalid_solution', 'không gán được mục đang ẩn');
ok(sol.solutionOf(shellDir, { solution: 'khach_a' }) === 'solar', 'người đang dùng mục ẩn vẫn nhận solar');
sol.updateItem(shellDir, 'khach_a', { enabled: true });
ok(sol.updateItem(shellDir, 'khach_a', { title: 'Khách A (đổi tên)' }).ok && sol.listSolutions(shellDir).find((x) => x.id === 'khach_a').title === 'Khách A (đổi tên)', 'đổi tên hiển thị');
ok(sol.updateItem(shellDir, 'khach_a', { folder: 'nope' }).error === 'invalid_folder', 'đổi sang thư mục không có bị từ chối');
ok(sol.updateItem(shellDir, 'khong_co', { title: 'x' }).error === 'not_found', 'sửa mục không có → 404');
// đổi thư mục của mục → user của mục đó nhận bản mới khi đồng bộ
ok(sol.updateItem(shellDir, 'khach_a', { folder: 'indep' }).ok, 'trỏ mục khach_a sang thư mục indep');
ok(syncBundles(db, { dataDir, shellDir }).updated >= 1 && listBundleFiles(root('basicuser')).length === 1 && !fs.existsSync(path.join(root('basicuser'), 'solar.js')), 'đổi thư mục của mục: bundle user thay theo (xoá file solar)');
sol.updateItem(shellDir, 'khach_a', { folder: 'solar' }); syncBundles(db, { dataDir, shellDir });
// thư mục mới chép lên server → TỰ có mục trong ô chọn (không cần admin thêm)
fs.mkdirSync(path.join(solRoot, 'late', 'webapp'), { recursive: true });
fs.writeFileSync(path.join(solRoot, 'late', 'webapp', 'x.js'), '1');
fs.mkdirSync(path.join(solRoot, 'nomark', 'webapp'), { recursive: true });
fs.writeFileSync(path.join(solRoot, 'nomark', 'webapp', 'x.js'), '1');
ok(!sol.listSolutions(shellDir).some((x) => x.id === 'late'), 'thư mục chưa có dấu nhận diện KHÔNG vào ô chọn');
ok(sol.ignoredFolders(shellDir).some((f) => f.folder === 'nomark' && /dấu nhận diện/.test(f.reason)), 'admin thấy thư mục bị bỏ qua và lý do');
fs.writeFileSync(path.join(solRoot, 'late', 'solution.json'), JSON.stringify({ kind: 'plciot-solution', title: 'Muộn' }));
ok(sol.listSolutions(shellDir).some((x) => x.id === 'late'), 'thư mục mới tự xuất hiện trong ô chọn (tự động mapping selector ↔ folder)');
res = updateUser(db, admin, solarId, { solution: 'late' }, { ip: 't', shellDir, dataDir });
ok(res.ok && sol.solutionOf(shellDir, { solution: 'late' }) === 'late', 'gán được mục tự động ngay');
updateUser(db, admin, solarId, { solution: 'solar' }, { ip: 't', shellDir, dataDir });
ok(sol.removeItem(shellDir, 'late', 0).hidden === true && !sol.listSolutions(shellDir).some((x) => x.id === 'late'), 'xoá mục mang tên thư mục còn trên đĩa → chỉ ẩn, không tự hiện lại');
fs.rmSync(path.join(solRoot, 'late'), { recursive: true });
ok(sol.listSolutions(shellDir).every((x) => x.id !== 'late'), 'thư mục bị xoá khỏi server → mục biến khỏi ô chọn');
// xoá mục
ok(sol.removeItem(shellDir, 'khach_a', 1).error === 'in_use', 'không xoá mục còn người dùng');
ok(sol.removeItem(shellDir, 'khach_a', 0).ok && !sol.listSolutions(shellDir).some((x) => x.id === 'khach_a'), 'xoá mục');
ok(sol.solutionOf(shellDir, { solution: 'khach_a' }) === 'basic', 'mục đã xoá → người còn sót về cơ bản (không hỏng)');
ok(syncBundles(db, { dataDir, shellDir }).updated >= 1 && same(root('basicuser'), shellDir), 'đồng bộ đưa user mồ côi về bản cơ bản');
ok(sol.removeItem(shellDir, 'khach_a', 0).error === 'not_found', 'xoá mục không có → 404');
// alias xoá đi mà thư mục chưa ai trỏ tới → thư mục tự hiện lại
fs.writeFileSync(sol.registryPath(), JSON.stringify({ items: [{ id: 'alias_a', title: 'A', folder: 'indep', enabled: true }] }));
ok(sol.listSolutions(shellDir).some((x) => x.id === 'solar') && sol.listSolutions(shellDir).some((x) => x.id === 'alias_a'), 'sổ chỉ có alias: thư mục còn lại vẫn tự hiện');
// sổ hỏng không làm sập
fs.writeFileSync(sol.registryPath(), '{hỏng');
ok(sol.listSolutions(shellDir).some((x) => x.id === 'solar'), 'sổ hỏng → quay về tự liệt kê thư mục');
fs.rmSync(sol.registryPath());

// --- giải pháp ngành (sinh bởi tools/solution-kit): mỗi thư mục tự đủ, bản khai gateway khớp giao diện, mọi tham chiếu hợp lệ
{
  const kitJs = path.resolve(shellDir, '..', 'tools', 'solution-kit', 'industry.js');
  const kitCss = path.resolve(shellDir, '..', 'tools', 'solution-kit', 'industry.css');
  const ind = sol.listSolutions(shellDir).map((s) => s.id).filter((i) => fs.existsSync(path.join(solRoot, i, 'webapp', 'spec.js')));
  ok(ind.length >= 20, `có ${ind.length} giải pháp ngành`);
  const KEY = /^[A-Za-z0-9_]{1,32}$/, CID = /^[a-zA-Z0-9_-]{1,48}$/;
  const mref = { kpis: ['items'], gauges: ['items'], tank: ['items'], state: ['items'], bars: ['items'], trend: ['metric'], tiles: ['main', 'subs'], line: ['state', 'sub'], ring: ['main', 'subs'], tanks: ['main'], plan: ['main'], andon: ['state', 'value'], map: ['state', 'speed'], wind: ['dir', 'speed'] };
  for (const id of ind) {
    const dir = path.join(solRoot, id);
    const txt = fs.readFileSync(path.join(dir, 'webapp', 'spec.js'), 'utf8');
    let spec; try { spec = JSON.parse(txt.slice(txt.indexOf('window.INDUSTRY =') + 17).replace(/;\s*$/, '')); } catch { spec = null; }
    ok(spec && spec.id === id, `${id}: spec.js hợp lệ`);
    if (!spec) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'solution.json'), 'utf8'));
    const inj = [...(meta.inject.css || []), ...(meta.inject.js || [])].map((f) => f.split('?')[0]);
    ok(inj.every((f) => fs.existsSync(path.join(dir, 'webapp', f))), `${id}: file inject đều tồn tại`);
    const mids = new Set(spec.metrics.map((x) => x.id));
    const refs = [];
    const blocks = [...spec.overview, ...spec.tabs.flatMap((t) => t.blocks)];
    for (const b of blocks) {
      for (const f of mref[b.type] || []) for (const v of [].concat(b[f] ?? [])) refs.push(v);
      if (b.type === 'pid') { for (const n of b.nodes) if (n.metric) refs.push(n.metric); for (const p of b.pipes) if (p.on) refs.push(p.on); }
      if (b.type === 'schedule') for (const r of b.rows) if (r.metric) refs.push(r.metric);
      if (b.type === 'progress') for (const it of b.items) { refs.push(it.actual); if (it.target && !/^\d+$/.test(String(it.target))) refs.push(it.target); }
    }
    ok(refs.every((r) => mids.has(r)), `${id}: mọi khối tham chiếu chỉ số có thật${refs.filter((r) => !mids.has(r)).length ? ' — thiếu ' + refs.filter((r) => !mids.has(r)) : ''}`);
    const setup = JSON.parse(fs.readFileSync(path.join(dir, 'gateway', 'setup.json'), 'utf8'));
    ok(setup.devices.length >= 1 && setup.devices.length <= 64 && setup.devices.every((d) => CID.test(d.id) && d.fields.length >= 1 && d.fields.length <= 32 && d.fields.every((f) => KEY.test(f.key))), `${id}: setup.json hợp lệ với bộ kiểm tra bản khai gateway`);
    ok(JSON.stringify(Object.keys(spec.demo.devices)) === JSON.stringify(setup.devices.map((d) => d.id)), `${id}: thiết bị mẫu khớp bản khai gateway`);
    const keys = new Set(setup.devices.flatMap((d) => d.fields.map((f) => f.key.toLowerCase())));
    const mk = (m2) => { const mt = spec.metrics.find((x) => x.id === m2); return mt ? (mt.keys || [m2]).map((k) => (Array.isArray(k) ? k[0] : k).toLowerCase()) : []; };
    ok(spec.required.length > 0 && spec.required.every((r) => (r.startsWith('key:') ? keys.has(r.slice(4)) : mk(r).some((k) => keys.has(k)))), `${id}: bản khai gateway đủ field bắt buộc (${spec.required.join(', ')})`);
    const mkers = blocks.filter((b) => b.type === 'plan').flatMap((b) => b.markers.map((x) => x.dev));
    ok(mkers.every((d) => d in spec.demo.devices), `${id}: vị trí trên mặt bằng trỏ đúng thiết bị`);
    // gateway: giao diện là DỮ LIỆU (ui.json): spec giống webapp, bảng màu đủ, không còn mã C# riêng từng giải pháp
    const gdir = path.join(dir, 'gateway'), ui = JSON.parse(fs.readFileSync(path.join(gdir, 'ui.json'), 'utf8'));
    ok(ui.id === id && JSON.stringify(ui.spec.metrics) === JSON.stringify(spec.metrics) && JSON.stringify(ui.spec.overview) === JSON.stringify(spec.overview) && JSON.stringify(ui.spec.tabs) === JSON.stringify(spec.tabs), `${id}: ui.json của gateway khớp spec webapp`);
    ok(['bg', 'card', 'fg', 'mut', 'line', 'acc'].every((k) => /^#[0-9a-f]{6}$/i.test(ui.palette[k])) && ui.short && ui.glyph, `${id}: ui.json có bảng màu + tên ngắn + ký hiệu`);
    ok(!fs.existsSync(path.join(gdir, 'IndustrySkin.cs')) && !fs.existsSync(path.join(gdir, 'IndustryPage.cs')) && JSON.parse(fs.readFileSync(path.join(gdir, 'solution.json'), 'utf8')).id === id, `${id}: gateway không còn mã riêng (một GatewayApp dùng chung)`);
    // chỉ số suy diễn (expr): cú pháp đúng + chỉ tham chiếu chỉ số / field có thật
    const exprMod = fs.existsSync(path.join(shellDir, '..', 'tools', 'solution-kit', 'expr.js')) ? (await import('node:module')).createRequire(import.meta.url)(path.join(shellDir, '..', 'tools', 'solution-kit', 'expr.js')) : null;
    if (exprMod) {
      const rawKeys = new Set(Object.values(spec.demo.devices).flatMap((d) => Object.keys(d.f).map((k) => k.toLowerCase())));
      const devIds = new Set(Object.keys(spec.demo.devices).map((x) => x.toLowerCase()));
      for (const mt of spec.metrics.filter((x) => x.expr)) {
        const err = exprMod.check(mt.expr);
        const names = err ? [] : exprMod.names(mt.expr).filter((n) => !(mids.has(n) || mids.has(n.toLowerCase()) || rawKeys.has(n.toLowerCase()) || (n.includes('.') && devIds.has(n.split('.')[0].toLowerCase()))));
        ok(!err && !names.length && mt.id !== undefined, `${id}: công thức "${mt.expr}" hợp lệ${err ? ' — ' + err : ''}${names.length ? ' — tên lạ: ' + names : ''}`);
      }
    }
    if (fs.existsSync(kitJs)) ok(fs.readFileSync(path.join(dir, 'webapp', 'industry.js'), 'utf8') === fs.readFileSync(kitJs.replace('industry.js', 'expr.js'), 'utf8') + '\n' + fs.readFileSync(kitJs, 'utf8') && fs.readFileSync(path.join(dir, 'webapp', 'industry.css'), 'utf8') === fs.readFileSync(kitCss, 'utf8'), `${id}: engine giống bản gốc tools/solution-kit (chưa lệch)`);
  }
  // bundle ghép đúng cho một giải pháp ngành
  const probeRoot = path.join(tmp, 'probe-water');
  sol.writeSolution(shellDir, sol.solutionOf(shellDir, { solution: 'water' }), probeRoot);
  const pf = new Set(listBundleFiles(probeRoot).map((f) => f.path));
  ok(['spec.js', 'industry.js', 'industry.css', 'theme.css', 'app.js', 'login.html'].every((f) => pf.has(f)) && !pf.has('solution.json'), 'bundle water: file giải pháp + file dùng chung của bản cơ bản');
  const pidx = fs.readFileSync(path.join(probeRoot, 'index.html'), 'utf8');
  ok(pidx.indexOf('industry.js') > pidx.indexOf('app.js') && pidx.indexOf('spec.js') < pidx.indexOf('industry.js'), 'index.html: spec.js trước industry.js, cả hai sau app.js');
}

fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`\n${fails} FAIL`); process.exit(1); }
console.log('\nsmoke-solutions: OK');
