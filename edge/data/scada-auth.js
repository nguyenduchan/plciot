// Đăng nhập (HTTP Basic) nhiều tài khoản + vai trò cho trang /scada của Node-RED (httpNodeMiddleware).
//   SCADA_USERS="operator:operator:matkhau1;viewer:viewer:matkhau2"      (user:vai trò:mật khẩu, cách nhau bằng ;)
//   vai trò: operator = xem + điều khiển, viewer = chỉ xem. Tài khoản không có mật khẩu bị bỏ qua.
// Chỉ bảo vệ đường dẫn /scada*. Khoá IP 5 phút sau 5 lần sai. Dùng HTTP trong LAN tin cậy; muốn mã hoá hãy đặt reverse proxy TLS phía trước.
const crypto = require('crypto');

function parseUsers(raw) {
  const users = new Map();
  for (const item of String(raw || '').split(';')) {
    const [user, role, ...rest] = item.split(':');
    const pass = rest.join(':');
    if (!user || !pass || !['operator', 'viewer'].includes(role)) continue;
    users.set(user, { role, hash: crypto.createHash('sha256').update(pass).digest() });
  }
  return users;
}

const fails = new Map();   // ip -> {n, until}

module.exports = function scadaAuth(req, res, next) {
  if (!req.path.startsWith('/scada')) return next();
  // nginx (scada-web) ghi X-Real-IP; cổng Node-RED không mở ra LAN nên header này không giả mạo được từ ngoài
  const ip = req.headers['x-real-ip'] || req.ip || req.socket.remoteAddress || '?';
  const f = fails.get(ip);
  if (f && f.n >= 5 && f.until > Date.now()) { res.status(429).send('Too many attempts'); return; }

  const users = parseUsers(process.env.SCADA_USERS);
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m) {
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const u = users.get(user);
    const given = crypto.createHash('sha256').update(rest.join(':')).digest();
    if (u && crypto.timingSafeEqual(u.hash, given)) {
      fails.delete(ip);
      req.scadaUser = user;
      req.scadaRole = u.role;
      return next();
    }
    fails.set(ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60 * 1000 });
  }
  res.set('WWW-Authenticate', 'Basic realm="SCADA", charset="UTF-8"').status(401).send('Unauthorized');
};
