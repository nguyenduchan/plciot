#!/usr/bin/env node
/**
 * E2E tìm kiếm admin trên server THẬT (chạy trong container app): GET /api/admin/search trả đủ trường sửa được cho người dùng + gateway,
 * KHÔNG lộ thông tin đăng nhập; sửa qua các API mà trang admin dùng rồi tìm lại thấy giá trị mới; trả về như cũ.
 *   docker cp cloud/app/scripts/e2e-admin-search.js plciot-app:/app/scripts/ && docker exec -w /app plciot-app node scripts/e2e-admin-search.js
 * Dùng tài khoản test t_water (có sẵn sau e2e-solutions.js); không đụng người dùng/gateway thật.
 */
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3080';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const tok = (await (await fetch(`${BASE}/api/admin/local-session`)).json()).token;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const j = async (p, method = 'GET', body) => { const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const search = async (q) => (await j(`/api/admin/search?limit=50&q=${encodeURIComponent(q)}`)).body;

const all = await search('');
ok(all.users?.length > 0 && all.gateways !== undefined && all.options?.roles?.length === 3, 'tìm rỗng trả danh sách mới nhất + tuỳ chọn');
ok(all.totals.users >= all.users.length, 'có tổng số người dùng / gateway');
const raw = JSON.stringify(all);
ok(!/password|passkey|totp|recovery|token_version|login_password|mqtt_pass|"token"/i.test(raw), 'kết quả KHÔNG chứa thông tin đăng nhập / mật khẩu / token');
const u0 = all.users[0];
for (const k of ['id', 'username', 'role', 'scopes', 'site', 'device', 'disabled', 'solution', 'plan', 'gateways', 'widgets']) ok(k in u0, `người dùng có trường ${k}`);
for (const k of ['id', 'label', 'expiresAt', 'remoteControl']) ok(k in u0.plan, `gói có trường ${k}`);

// tìm theo từng loại trường
const t = (await search('t_water')).users.find((x) => x.username === 't_water');
if (!t) { console.error('thiếu t_water: chạy e2e-solutions.js water trước'); process.exit(2); }
ok((await search('t_wat')).users.some((x) => x.id === t.id), 'tìm theo một phần tên đăng nhập');
ok((await search('T_WATER')).users.some((x) => x.id === t.id), 'không phân biệt hoa/thường');
ok((await search(`operator ${t.username}`)).users.some((x) => x.id === t.id), 'nhiều từ phải khớp tất cả (vai trò + tên)');
ok(!(await search(`admin ${t.username}`)).users.some((x) => x.id === t.id), 'từ không khớp thì loại');
ok((await search(t.solutionTitle || 'Cấp nước')).users.some((x) => x.id === t.id), 'tìm theo tên giải pháp');
ok((await search(t.plan.id)).users.some((x) => x.id === t.id), 'tìm theo gói');
ok((await search('khong_ton_tai_xyz')).users.length === 0 && (await search('khong_ton_tai_xyz')).gateways.length === 0, 'không khớp → rỗng');

// gateway: tìm theo site / thiết bị con / người dùng đã gắn
const gws = (await search('')).gateways;
const g = gws.find((x) => x.children.length);
if (g) {
  ok((await search(g.site)).gateways.some((x) => x.site === g.site && x.device === g.device), 'tìm gateway theo site');
  ok((await search(g.children[0].id)).gateways.some((x) => x.site === g.site && x.device === g.device), 'tìm gateway theo thiết bị con');
  for (const k of ['label', 'note', 'profile', 'solution', 'claimed', 'activatedHw', 'mqttId', 'config', 'children']) ok(k in g, `gateway có trường ${k}`);
  if (g.claimedUsername) ok((await search(g.claimedUsername)).gateways.some((x) => x.site === g.site), 'tìm gateway theo người dùng đã gắn');
}

// sửa người dùng qua API của trang admin rồi tìm lại; trả về như cũ
const before = { scopes: t.scopes, plan: t.plan.id, remote: t.plan.remoteControl };
let r = await j(`/api/admin/users/${t.id}`, 'PATCH', { scopes: ['telemetry', 'status'] });
ok(r.status === 200, 'PATCH phạm vi xem');
let t2 = (await search('t_water')).users.find((x) => x.id === t.id);
ok(t2.scopes.length === 2 && t2.scopes.includes('status') && !t2.scopes.includes('history'), 'tìm lại thấy phạm vi mới');
r = await j(`/api/admin/users/${t.id}`, 'PATCH', { scopes: before.scopes }); ok(r.status === 200, 'trả phạm vi như cũ');
r = await j(`/api/admin/ops/users/${t.id}/plan`, 'POST', { remoteControl: !before.remote }); ok(r.status === 200, 'POST điều khiển từ xa');
t2 = (await search('t_water')).users.find((x) => x.id === t.id);
ok(t2.plan.remoteControl === !before.remote || before.remote === false, 'tìm lại thấy điều khiển từ xa đổi (hoặc gói không cho phép)');
await j(`/api/admin/ops/users/${t.id}/plan`, 'POST', { remoteControl: before.remote });

// sửa gateway
if (g) {
  const oldNote = g.note;
  r = await j(`/api/admin/hardware/${encodeURIComponent(g.site)}/${encodeURIComponent(g.device)}`, 'PATCH', { note: 'ghi chú e2e tìm kiếm' });
  ok(r.status === 200, 'PATCH ghi chú gateway');
  ok((await search('e2e tìm kiếm')).gateways.some((x) => x.site === g.site && x.note === 'ghi chú e2e tìm kiếm'), 'tìm theo ghi chú mới thấy gateway');
  await j(`/api/admin/hardware/${encodeURIComponent(g.site)}/${encodeURIComponent(g.device)}`, 'PATCH', { note: oldNote });
}
// thông tin đăng nhập không sửa được qua các API này
r = await j(`/api/admin/users/${t.id}`, 'PATCH', { username: 'hacker', password: 'x' });
ok(r.status === 400 && (await search('hacker')).users.length === 0, 'API không cho đổi tên đăng nhập / mật khẩu');

console.log(fails ? `\n${fails} FAIL` : '\ne2e-admin-search: OK');
process.exit(fails ? 1 : 0);
