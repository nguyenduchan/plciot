/**
 * Smoke test trang admin riêng: chạy server tách biệt (DATA_DIR tạm, cổng 3099) rồi gọi HTTP với header Host.
 *   docker exec plciot-app node scripts/smoke-admin-site.js
 * Không đụng DB thật.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const PORT = 3099;
const ADMIN = 'admin.test.local';
const APP = 'app.test.local';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminsite-'));
const env = {
  PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, SHELL_DIR: process.env.SHELL_DIR || '/app/shell',
  APP_JWT_SECRET: 'x'.repeat(40), ADMIN_HOST: ADMIN, ADMIN_USERNAMES: 'boss', ADMIN_DASHBOARD_USERS: 'boss',
  ADMIN_ONLY_CIDRS: '127.0.0.1/32', ADMIN_INTERNET_USERS: 'boss', ADMIN_REQUIRE_TOTP: 'true',
  WEBAPP_PUBLIC_URL: `https://${APP}`, MQTT_SHARDS: '1', NODE_ENV: 'test',
};

function req(host, method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: {
      Host: host, 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '9.9.9.9',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, j }); }); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ' ' + extra}`); };

const child = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const stop = () => { child.kill('SIGTERM'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };

try {
  for (let i = 0; i < 50 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 200));
  if (!log.includes('listening')) throw new Error('server không khởi động:\n' + log);

  const db = new Database(path.join(dir, 'app.db'));
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const row = { username: 'boss', role: 'admin', login_password_hash: bcrypt.hashSync('Correct-horse-1', 10), setup_complete: 1, disabled: 0 };
  const have = db.prepare('SELECT id FROM users WHERE username = ?').get('boss');
  if (!have) {
    const need = db.prepare('PRAGMA table_info(users)').all().filter((c) => c.notnull && c.dflt_value == null && c.name !== 'id').map((c) => c.name);
    for (const n of need) if (!(n in row)) row[n] = n.includes('folder') ? 'u_boss' : 'x';
    const ks = Object.keys(row).filter((k) => cols.includes(k));
    db.prepare(`INSERT INTO users (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => row[k]));
  } else db.prepare('UPDATE users SET login_password_hash = ?, role = ? WHERE username = ?').run(row.login_password_hash, 'admin', 'boss');
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'other'").get()) {
    const r2 = { ...row, username: 'other' };
    const need2 = db.prepare('PRAGMA table_info(users)').all().filter((c) => c.notnull && c.dflt_value == null && c.name !== 'id').map((c) => c.name);
    for (const n of need2) if (!(n in r2)) r2[n] = n.includes('folder') ? 'u_other' : 'x';
    const ks2 = Object.keys(r2).filter((k) => cols.includes(k));
    db.prepare(`INSERT INTO users (${ks2.join(',')}) VALUES (${ks2.map(() => '?').join(',')})`).run(...ks2.map((k) => r2[k]));
  }

  // 1) cổng theo tên miền
  check('admin host: trang đăng nhập', (await req(ADMIN, 'GET', '/admin-login.html')).status === 200);
  check('admin host: không phục vụ login.html của app', (await req(ADMIN, 'GET', '/login.html')).status === 404);
  check('app host: không phục vụ admin.html', (await req(APP, 'GET', '/admin.html')).status === 404);
  check('app host: không có /api/admin/users', (await req(APP, 'GET', '/api/admin/users')).status === 404);
  check('app host: không có API đăng nhập admin', (await req(APP, 'POST', '/api/admin-site/login', {})).status === 404);
  check('admin host: /api/admin cần đăng nhập', (await req(ADMIN, 'GET', '/api/admin/users')).status === 401);

  // 2) đăng nhập
  const bad = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'sai' });
  check('sai mật khẩu → 401', bad.status === 401 && bad.j?.error === 'invalid_credentials');
  const other = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'other', password: 'Correct-horse-1' });
  check('tài khoản không phải admin cao nhất bị từ chối', other.status === 401 && other.j?.error === 'invalid_credentials');
  const first = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1' });
  check('đúng mật khẩu, chưa có TOTP → bắt đăng ký', first.status === 200 && first.j?.setupRequired && first.j?.ticket);
  check('vé không dùng làm token được', (await req(ADMIN, 'GET', '/api/admin/users', null, first.j?.ticket)).status === 401);

  // 3) đăng ký TOTP + vào phiên
  const { hotp, stepOf, base32Decode } = await import('@plciot/security').then((m) => ({ hotp: m.hotp, stepOf: m.stepOf, base32Decode: m.base32Decode }));
  void base32Decode;
  const setup = await req(ADMIN, 'POST', '/api/admin-site/totp/setup', { ticket: first.j.ticket });
  check('lấy khoá TOTP', setup.status === 200 && setup.j?.secret);
  const wrong = await req(ADMIN, 'POST', '/api/admin-site/totp/enable', { ticket: first.j.ticket, code: '000000' });
  check('mã TOTP sai bị từ chối', wrong.status === 401);
  const step = stepOf();
  const en = await req(ADMIN, 'POST', '/api/admin-site/totp/enable', { ticket: first.j.ticket, code: hotp(setup.j.secret, step) });
  check('bật TOTP → có token', en.status === 200 && en.j?.token);
  const token = en.j?.token;
  check('token vào được /api/admin/users', (await req(ADMIN, 'GET', '/api/admin/users', null, token)).status === 200);
  const me = await req(ADMIN, 'GET', '/api/admin-site/me', null, token);
  check('trang cài đặt: /me', me.status === 200 && me.j?.totpEnabled === true && me.j.sessions?.length >= 1);

  // 4) đăng nhập lần sau: cần mã, mã đã dùng bị từ chối (chống phát lại)
  const need = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1' });
  check('lần sau cần mã TOTP', need.status === 401 && need.j?.error === 'totp_required');
  const replay = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1', code: hotp(setup.j.secret, step) });
  check('mã vừa dùng không dùng lại được', replay.status === 401 && replay.j?.error === 'totp_invalid');
  const ok2 = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'Correct-horse-1', code: hotp(setup.j.secret, step + 1) });
  check('mã bước kế tiếp được chấp nhận', ok2.status === 200 && ok2.j?.token);

  // 5) cài đặt
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();   // test không chờ 30 giây
  const weak = await req(ADMIN, 'POST', '/api/admin-site/password', { current: 'Correct-horse-1', code: hotp(setup.j.secret, step), next: 'short' }, token);
  check('mật khẩu yếu bị từ chối', weak.status === 400 && weak.j?.error === 'password_weak');
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();
  const chg = await req(ADMIN, 'POST', '/api/admin-site/password', { current: 'Correct-horse-1', code: hotp(setup.j.secret, step), next: 'New-Strong-Pass-9' }, token);
  check('đổi mật khẩu thành công', chg.status === 200 && chg.j?.ok);
  db.prepare("UPDATE users SET totp_last_step = 0 WHERE username = 'boss'").run();
  const relog = await req(ADMIN, 'POST', '/api/admin-site/login', { username: 'boss', password: 'New-Strong-Pass-9', code: hotp(setup.j.secret, step) });
  check('đăng nhập bằng mật khẩu mới', relog.status === 200 && relog.j?.token);
  const rv = await req(ADMIN, 'POST', '/api/admin-site/sessions/revoke-others', {}, token);
  check('đăng xuất máy khác', rv.status === 200 && rv.j?.revoked >= 1);
  check('phiên cũ (ok2) bị thu hồi', (await req(ADMIN, 'GET', '/api/admin/users', null, ok2.j.token)).status === 401);

  // 6) token app thường không dùng được ở tên miền admin
  const plain = db.prepare("SELECT id, token_version FROM users WHERE username='boss'").get();
  const { createAppSession, signToken } = await import('@plciot/security');
  void createAppSession; void signToken; void plain; // phiên tạo ngoài admin-site: kiểm bằng cách chèn session device khác
  const sid = 'f'.repeat(48);
  db.prepare('INSERT INTO app_sessions (id, user_id, device_id, last_seen) VALUES (?,?,?,?)').run(sid, plain.id, 'phone-1', Date.now());
  const jwt = (await import('jsonwebtoken')).default.sign({ scope: 'full', uid: plain.id, tv: plain.token_version | 0, sid }, env.APP_JWT_SECRET, { expiresIn: 600 });
  const viaApp = await req(ADMIN, 'GET', '/api/admin/users', null, jwt);
  check('token đăng nhập của app không dùng được ở tên miền admin', viaApp.status === 401 && viaApp.j?.error === 'admin_session_required');

  // 7) chat hỗ trợ: người dùng (tên miền app) ↔ admin (tên miền admin), chỉ văn bản
  const cust = db.prepare("SELECT id, token_version FROM users WHERE username='other'").get();
  const csid = 'e'.repeat(48);
  db.prepare('INSERT INTO app_sessions (id, user_id, device_id, last_seen) VALUES (?,?,?,?)').run(csid, cust.id, 'phone-2', Date.now());
  const JWT = (await import('jsonwebtoken')).default;
  const ctok = JWT.sign({ scope: 'full', uid: cust.id, tv: cust.token_version | 0, sid: csid }, env.APP_JWT_SECRET, { expiresIn: 600 });
  check('chat: tin rỗng bị từ chối', (await req(APP, 'POST', '/api/support/messages', { body: '   ' }, ctok)).status === 400);
  const html = '<script>alert(1)</script> https://pay.example/x';
  check('chat: người dùng gửi tin', (await req(APP, 'POST', '/api/support/messages', { body: html }, ctok)).status === 200);
  check('chat: tên miền admin không có API chat của người dùng', (await req(ADMIN, 'GET', '/api/support/messages', null, ctok)).status === 404);
  const thr = await req(ADMIN, 'GET', '/api/admin/support/threads', null, token);
  check('chat: admin thấy cuộc trò chuyện chưa đọc', thr.status === 200 && thr.j?.unread >= 1 && thr.j.threads[0]?.username === 'other');
  const conv = await req(ADMIN, 'GET', `/api/admin/support/threads/${cust.id}`, null, token);
  check('chat: nội dung giữ nguyên dạng văn bản (không lọc/biến đổi thành link)', conv.j?.messages?.[0]?.body === html);
  check('chat: người dùng thường không dùng được API admin chat', (await req(APP, 'GET', '/api/admin/support/threads', null, ctok)).status === 404);
  check('chat: admin trả lời', (await req(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}`, { body: 'Xin chào' }, token)).status === 200);
  const unread = await req(APP, 'GET', '/api/support/unread', null, ctok);
  check('chat: người dùng thấy 1 tin chưa đọc', unread.j?.unread === 1);
  const mine = await req(APP, 'GET', '/api/support/messages?read=1', null, ctok);
  check('chat: người dùng đọc được và đánh dấu đã đọc', mine.j?.messages?.length === 2 && (await req(APP, 'GET', '/api/support/unread', null, ctok)).j?.unread === 0);
  // ảnh chụp màn hình
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);
  const rawReq = (host, method, url, buf, tok, type = 'image/png') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '9.9.9.9', 'Content-Type': type, 'Content-Length': buf.length, Authorization: `Bearer ${tok}` } }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const b = Buffer.concat(ch); let j = null; try { j = JSON.parse(b.toString()); } catch { /* ảnh */ } resolve({ status: res.statusCode, j, b, type: res.headers['content-type'] }); });
    });
    r.on('error', reject); r.end(buf);
  });
  const upl = await rawReq(APP, 'POST', '/api/support/images?caption=' + encodeURIComponent('lỗi này'), png, ctok);
  check('ảnh: người dùng gửi PNG hợp lệ', upl.status === 200 && upl.j?.image);
  check('ảnh: tệp không phải ảnh bị từ chối', (await rawReq(APP, 'POST', '/api/support/images', Buffer.from('<html>not an image at all</html>'), ctok, 'image/png')).status === 400);
  check('ảnh: người dùng xem được ảnh của mình', (await rawReq(APP, 'GET', `/api/support/images/${upl.j.image}`, Buffer.alloc(0), ctok)).type === 'image/png');
  const view = await rawReq(ADMIN, 'GET', `/api/admin/support/images/${upl.j.image}`, Buffer.alloc(0), token);
  check('ảnh: admin xem được ảnh người dùng gửi', view.status === 200 && view.type === 'image/png' && view.b.equals(png));
  const adminImg = await rawReq(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}/image`, png, token);
  check('ảnh: admin gửi ảnh cho người dùng', adminImg.status === 200);
  check('ảnh: tin nhắn có kèm mã ảnh', (await req(APP, 'GET', '/api/support/messages', null, ctok)).j?.messages?.some((m) => m.image === upl.j.image && m.body === 'lỗi này'));
  // đồng ý / từ chối yêu cầu đổi gói
  check('plan: người dùng gửi yêu cầu kèm gói', (await req(APP, 'POST', '/api/support/messages', { body: 'Tôi muốn tư vấn gói Cơ bản', plan: 'monitor' }, ctok)).status === 200);
  check('plan: gói không hợp lệ bị bỏ qua (không lưu gợi ý)', (await req(APP, 'POST', '/api/support/messages', { body: 'x', plan: 'hack' }, ctok)).status === 200);
  const th = await req(ADMIN, 'GET', `/api/admin/support/threads/${cust.id}`, null, token);
  check('plan: admin thấy gói người dùng xin tư vấn', th.j?.requestedPlan === 'monitor' && th.j.plans?.length === 4);
  check('plan: gói sai bị từ chối', (await req(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}/approve`, { plan: 'nope' }, token)).status === 400);
  check('plan: người dùng thường không tự đồng ý được', (await req(APP, 'POST', `/api/admin/support/threads/${cust.id}/approve`, { plan: 'pro' }, ctok)).status === 404);
  const tl = await req(ADMIN, 'GET', '/api/admin/support/threads', null, token);
  check('chờ: yêu cầu lưu trong DB, admin thấy "chờ xử lý"', db.prepare('SELECT plan FROM support_requests WHERE user_id=?').get(cust.id)?.plan === 'monitor' && tl.j?.threads?.find((t) => t.userId === cust.id)?.pendingPlan === 'monitor' && tl.j.pending >= 1);
  const ap = await req(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}/approve`, { plan: 'monitor' }, token);
  check('plan: admin đồng ý → gói được gán', ap.status === 200 && ap.j?.subscription?.plan === 'monitor');
  check('chờ: đồng ý xong thì hết chờ', !db.prepare('SELECT 1 FROM support_requests WHERE user_id=?').get(cust.id));
  check('plan: người dùng nhận tin xác nhận', (await req(APP, 'GET', '/api/support/messages', null, ctok)).j?.messages?.some((m) => m.from === 'admin' && /đồng ý/.test(m.body) && /Cơ bản/.test(m.body)));
  const dc = await req(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}/decline`, { reason: 'Chưa nhận được chuyển khoản' }, token);
  check('plan: admin từ chối', dc.status === 200);
  check('plan: người dùng nhận tin từ chối kèm lý do', (await req(APP, 'GET', '/api/support/messages', null, ctok)).j?.messages?.some((m) => m.from === 'admin' && /chưa thể chuyển gói/.test(m.body) && /Chưa nhận được chuyển khoản/.test(m.body)));
  check('plan: từ chối không đổi gói', db.prepare("SELECT sub_plan FROM users WHERE username='other'").get().sub_plan === 'monitor');
  // giới hạn số tin / người dùng (cũ nhất bị xoá, mới nhất còn)
  const ins = db.prepare('INSERT INTO support_messages (user_id, from_admin, body, ts) VALUES (?, 1, ?, ?)');
  for (let i = 0; i < 230; i++) ins.run(cust.id, `bulk${i}`, Date.now());
  await req(ADMIN, 'POST', `/api/admin/support/threads/${cust.id}`, { body: 'tin-moi-nhat' }, token);
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE user_id=?').get(cust.id).n;
  check('giới hạn: mỗi người dùng tối đa 200 tin, giữ tin mới nhất', cnt === 200 && db.prepare("SELECT 1 FROM support_messages WHERE user_id=? AND body='tin-moi-nhat'").get(cust.id) && !db.prepare("SELECT 1 FROM support_messages WHERE user_id=? AND body='bulk0'").get(cust.id));
  // kho lưu trữ: tin cũ được chuyển (không mất), xem được qua history và export
  check('kho: tin cũ nằm trong support_archive', db.prepare("SELECT COUNT(*) AS n FROM support_archive WHERE user_id=?").get(cust.id).n > 0 && !!db.prepare("SELECT 1 FROM support_archive WHERE user_id=? AND body='bulk0'").get(cust.id));
  const hist = await req(APP, 'GET', '/api/support/history?limit=100', null, ctok);
  check('kho: người dùng xem lịch sử cũ qua /history (phân trang)', hist.status === 200 && Array.isArray(hist.j?.messages) && hist.j.messages.length === 100 && hist.j.more === true);
  const oldest = hist.j.messages[0].id;
  let cur = oldest; let found = false; let pages = 0; let more = true; let ordered = true;
  while (more && pages++ < 10) {
    const pg = await req(APP, 'GET', `/api/support/history?before=${cur}&limit=100`, null, ctok);
    if (!pg.j?.messages?.length) break;
    if (pg.j.messages.some((m) => m.body === 'bulk0')) found = true;
    if (!pg.j.messages.every((m) => m.id < cur)) ordered = false;
    cur = pg.j.messages[0].id; more = pg.j.more;
  }
  check('kho: lật trang cũ hơn tới tin bulk0, hết thì more=false', found && ordered && more === false);
  const ah = await req(ADMIN, 'GET', `/api/admin/support/threads/${cust.id}/history?limit=5`, null, token);
  check('kho: admin xem lịch sử cũ', ah.status === 200 && ah.j?.messages?.length === 5);
  const ex = await rawReq(ADMIN, 'GET', `/api/admin/support/threads/${cust.id}/export`, Buffer.alloc(0), token);
  check('kho: admin xuất hội thoại gồm cả kho lưu trữ', ex.status === 200 && ex.b.toString().includes('bulk0') && /attachment/.test('attachment'));
  check('kho: người dùng thường không xuất được', (await req(APP, 'GET', `/api/admin/support/threads/${cust.id}/export`, null, ctok)).status === 404);
  // chống spam / trùng
  const cid = 'cid-test-0001';
  const c1 = await req(APP, 'POST', '/api/support/messages', { body: 'thử cid', cid }, ctok);
  const c2 = await req(APP, 'POST', '/api/support/messages', { body: 'thử cid', cid }, ctok);
  check('chống trùng: gửi lại cùng cid không tạo tin mới', c1.status === 200 && c2.status === 200 && c2.j?.duplicate === true && c1.j.id === c2.j.id);
  const dup = await req(APP, 'POST', '/api/support/messages', { body: 'thử cid' }, ctok);
  check('chống spam: cùng nội dung trong 60 giây bị chặn', dup.status === 429 && dup.j?.error === 'duplicate');
  // hạn mức ảnh: nhét sẵn vào DB tới sát trần rồi thử gửi thêm
  db.prepare('INSERT INTO support_images (user_id, mime, data, ts) VALUES (?, ?, ?, ?)').run(cust.id, 'image/png', Buffer.alloc(31 * 1024 * 1024), Date.now());
  const qi = await rawReq(APP, 'POST', '/api/support/images?cid=cid-img-0001', png, ctok);
  check('hạn mức: vượt dung lượng ảnh / người dùng bị từ chối 413', qi.status === 413);
  check('chat: không có endpoint đơn hàng/thanh toán', (await req(APP, 'POST', '/api/support/order', {}, ctok)).status === 404 && (await req(APP, 'POST', '/api/support/pay', {}, ctok)).status === 404);
} catch (e) {
  fails++; console.error('LỖI', e.message);
} finally {
  stop();
}
console.log(fails ? `\n${fails} lỗi` : '\nTất cả OK');
process.exit(fails ? 1 : 0);
