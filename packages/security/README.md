# @plciot/security — lõi bảo mật dùng chung

Phần bảo mật **cố định** (không đổi theo từng khách hàng) tách riêng để mọi app/giải pháp mới dùng lại, thay vì viết lại: đăng nhập
bằng vân tay, xác nhận khi điều khiển, thêm thiết bị, ghép PC, chống lạm dụng. Lõi **không biết** app của bạn điều khiển PLC,
dùng MQTT hay nhắn Telegram — app cắm các *adapter* vào một lần.

## Trong gói (cố định) và ngoài gói (riêng từng app)

| Trong gói `packages/security` | Nằm trong app (ví dụ `cloud/app`) |
|---|---|
| Passkey/WebAuthn, TOTP, mã khôi phục | Cách đăng nhập lần đầu (OTP Telegram/SMS/email…), `loginPayload` (JWT) |
| Phiên điều khiển (step-up), hạn bắt buộc bật yếu tố | Route lệnh riêng của app (PLC: `plcControlRoutes.js`, `plcCommands.js`) |
| Thêm thiết bị mới (máy cũ duyệt / mã khôi phục / email / chờ 24 giờ) | Gửi tin Telegram/email thật (`notify`, `email` adapter) |
| Cảnh báo thiết bị lạ, chỉ thiết bị đầu tiên bật yếu tố ngay | Quy tắc "ai được điều khiển" (`canControl`), vai trò, nhà máy/thành viên |
| Ghép PC bằng mã + chữ ký ECDSA P-256 (`stationAuth`) | Việc PC đó làm được gì (whitelist thanh ghi…) |
| `clientIp` chỉ tin proxy tin cậy, giới hạn tần suất, CSP + CORS | Giới hạn OTP theo SĐT, đổi số điện thoại, khôi phục tài khoản |
| Client trình duyệt (`client/`): hộp thoại vân tay/TOTP, banner, mã khôi phục | Giao diện riêng và JS gửi lệnh của app |

## Dùng trong app mới (Node/Express + better-sqlite3)

```js
import {
  configure, migrateSecurity, mountSecurityRoutes, securityHeaders, buildCorsOptions, enrollState,
} from '@plciot/security';

configure({
  secret: () => process.env.APP_SECRET,                    // ≥ 16 ký tự, giữ bí mật
  publicUrl: () => process.env.PUBLIC_URL,                  // dùng trong link huỷ gửi cho chủ tài khoản
  notify: async (db, user, { subject, html, text }) => {…}, // báo cho chủ tài khoản; không được ném lỗi
  email: { available: (user) => …, send: async (user, subject, text) => … }, // tuỳ chọn; email ĐÃ XÁC MINH
  canControl: (user) => user.role === 'operator',           // ai phải bật yếu tố
  brand: { rpName: 'Tên app' },                             // tên hiện trên hộp thoại vân tay
});

app.use(securityHeaders);                 // CSP, nosniff, frame-ancestors none…
app.use(cors(buildCorsOptions()));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })); // rawBody: chữ ký PC ghép cặp

migrateSecurity(db);                      // sau khi app đã tạo bảng users

const sec = mountSecurityRoutes(app, {
  db,
  requireAuth,      // middleware đặt req.user {id, username, role…} và req.tokenPayload {iat}
  loginPayload,     // (user) => payload đăng nhập của app (hoặc {error, status}); dùng cho đăng nhập passkey
  authStrict,       // giới hạn tần suất cho route chưa đăng nhập
  adminOnly,        // [requireAuth, requireAdmin] cho route quản trị trạm kiểu cũ (tuỳ chọn)
  extraStatus: (req) => ({ …trường riêng trộn vào GET /api/control/status }),
});

// Route nhạy cảm của app:
app.post('/api/safe/open', requireAuth, (req, res) => {
  if (enrollState(db, req.user).locked) return res.status(403).json({ error: 'enroll_required' });
  const a = sec.authorize(req);                 // đã vân tay / mã Authenticator chưa?
  if (a.error) return res.status(a.status).json(a);
  …
});
app.post('/api/account/rename', requireAuth, sec.reauth, handler); // thay cho "nhập mật khẩu hiện tại"
```

### Hợp đồng bảng `users`
App tự tạo `users(id INTEGER PK, username, role, disabled)`. `migrateSecurity` thêm: `token_version`, `totp_secret`, `totp_enabled`,
`totp_last_step`, `totp_pending`, `enroll_deadline`; và các bảng `passkeys`, `control_sessions`, `device_requests`, `known_devices`,
`pair_codes`, `stations`, `recovery_codes`, `audit_log`. Chạy lại nhiều lần không sao. (`stations`/`pair_codes` có cột `site`/`device`:
phạm vi thiết bị mà PC được phép tác động — app khác có thể dùng như "khu vực".)

### Client trình duyệt
`client/security-client.js` → `window.Security` (api, unlock, loginWithPasskey, offerEnroll, renderBanner, reviewDevices, addErrors…);
`client/session.js` gia hạn token trượt. Chép vào webapp của app bằng:

```bash
node packages/security/scripts/sync-client.js <webapp>/security   # hoặc: npm run sync-client  (mặc định ../../webapp/security)
node packages/security/scripts/sync-client.js <webapp>/security --check   # CI: báo lệch
```
Hợp đồng DOM/lưu trữ ghi ở đầu `security-client.js`. Trang cần `<script src="security/session.js">` rồi `<script src="security/security-client.js">`.
App PLC bọc thêm `webapp/control.js` (thêm lỗi riêng + `send()` lệnh) và đặt `window.Ctl = { ...Security, send }`.

## Biến môi trường của lõi

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CONTROL_STEPUP` | `true` | Bật yêu cầu xác nhận khi điều khiển |
| `CONTROL_PASSKEY_TTL_SEC` | 300 | Phiên sau khi chạm vân tay |
| `CONTROL_TOTP_TTL_DAYS` | 7 | Phiên sau khi nhập mã Authenticator |
| `CONTROL_BIND_NET` | `true` | Phiên gắn với mạng (/24 IPv4, /64 IPv6) |
| `CONTROL_ENROLL_GRACE_DAYS` | 3 | Hạn bật yếu tố; `off` = không ép |
| `CONTROL_LAN_CIDRS` | — | Dải IP cho PC trạm kiểu cũ / siết thêm PC ghép cặp |
| `DEVICE_ADD_COOLING_HOURS` | 24 | Chờ khi thêm thiết bị bằng mã khôi phục/email |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` | từ `publicUrl` | Tên miền gắn với vân tay |
| `TRUST_PROXY_CIDRS` | loopback + dải riêng | Proxy được tin khi đọc `CF-Connecting-IP`/`X-Forwarded-For` |
| `CSP_CONNECT_EXTRA`, `CORS_ORIGINS` | — | Nguồn kết nối thêm cho CSP; allowlist CORS |
| `RATE_LIMIT_CONTROL_AUTH`, `RATE_LIMIT_STATION_CMD` | 8, 40 | Giới hạn tần suất |

## Quy tắc khi sửa
1. **Chỉ đưa vào gói thứ mà mọi app đều cần.** Thứ gắn với một nghiệp vụ (PLC, Telegram, đổi số điện thoại) ở lại app.
2. Lõi không import app và không đọc `process.env` của app ngoài các biến ở bảng trên; cần gì thì thêm vào `configure()`.
3. Đổi hành vi bảo mật ⇒ thêm test trong `test/smoke-security.js` (app đồ chơi, không PLC) **và** test tích hợp của app.
4. Sửa client ở `client/` rồi `npm run sync-client`; `smoke-security.js` báo lỗi nếu bản trong webapp lệch.
5. Dữ liệu cũ giải mã bằng khoá dẫn xuất từ `secret()` với tiền tố cố định (`plciot-totp|`, `recovery:`, `pair:`): **đổi tiền tố hoặc secret là mất mã khôi phục/TOTP đã lưu**.

## Kiểm thử
```bash
node packages/security/test/smoke-security.js      # lõi + app đồ chơi + kiểm tra lệch client
node cloud/app/scripts/smoke-control.js            # tích hợp app PLC (cùng các smoke khác trong cloud/app/scripts)
```
