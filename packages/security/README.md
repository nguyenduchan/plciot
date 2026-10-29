# @plciot/security — lõi bảo mật dùng chung

Phần bảo mật **cố định** (không đổi theo từng khách hàng) tách riêng để mọi app/giải pháp mới dùng lại, thay vì viết lại: đăng nhập
bằng vân tay, xác nhận khi điều khiển, thêm thiết bị, ghép PC, chống lạm dụng. Lõi **không biết** app của bạn điều khiển PLC,
dùng MQTT hay nhắn Telegram — app cắm các *adapter* vào một lần.

## Trong gói (cố định) và ngoài gói (riêng từng app)

| Trong gói `packages/security` | Nằm trong app (ví dụ `cloud/app`) |
|---|---|
| Toàn bộ OTP login/register, JWT, phiên app, Passkey/WebAuthn, TOTP, mã khôi phục | Gửi OTP thật, tạo user theo nghiệp vụ và metadata `appPayload` |
| Phiên điều khiển (step-up), hạn bắt buộc bật yếu tố | Route lệnh riêng của app (PLC: `plcControlRoutes.js`, `plcCommands.js`) |
| Thêm/chuyển máy, khoá ECDSA của trình duyệt, mã ghép, vé một lần gắn khoá | Gửi tin Telegram/email thật (`notify`, `email` adapter) |
| Cảnh báo thiết bị lạ, chỉ thiết bị đầu tiên bật yếu tố ngay | Quy tắc "ai được điều khiển" (`canControl`), vai trò, nhà máy/thành viên |
| Ghép PC bằng mã + chữ ký ECDSA P-256 (`stationAuth`) | Việc PC đó làm được gì (whitelist thanh ghi…) |
| Giới hạn OTP, đổi số, khôi phục mất máy, thông báo/retry, thu hồi và thiết lập lại yếu tố | Xoay credential của nghiệp vụ, adapter xác minh ngoài kênh (tuỳ chọn) |
| Controller login/register, tài khoản, khôi phục, khoá app và client ký thiết bị | HTML/CSS/branding, dashboard, báo cáo, hiển thị và JS gửi lệnh của app |

## Điểm tích hợp chính

`mountAuthentication()` là điểm mount cho app mới. Không viết lại route login/register/phone/recovery trong host. `mountSecurityRoutes()` vẫn được giữ cho host cũ chỉ dùng step-up, nhưng không mount cả hai trên cùng app.

```js
import { configure, migrateSecurity, mountAuthentication } from '@plciot/security';

configure({
  secret: () => process.env.APP_SECRET,
  publicUrl: () => process.env.PUBLIC_URL,
  identity: {
    resolveContact: async (db, phone) => resolveVerifiedContact(phone),
    contact: user => user.primary_contact,
    sendCode: async (contact, code, purpose) => sendOtp(contact, code, purpose),
  },
  notify: async (db, user, message) => ({ delivered: await notifyTrustedOwner(user, message) }),
});
migrateSecurity(db);
const auth = mountAuthentication(app, {
  db,
  appPayload: user => ({ version: 'v1', files: [] }),
  // registrationContext: dữ liệu nghiệp vụ chuyển cho identity.createAccount, nếu host cần.
});
app.get('/api/private', auth.requireAuth, privateHandler);
// auth.reauth: thao tác nhạy cảm; auth.authorize: quyền thao tác ngắn hạn.
// auth.close(): dừng job retry/khôi phục khi đóng host.
```

Host tạo bảng tối thiểu `users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT, disabled INTEGER DEFAULT 0)` trước migration. Schema có ràng buộc riêng như `password_hash`/`folder_path` phải cung cấp `identity.createAccount`. Core không yêu cầu mật khẩu, bundle, MQTT hoặc PLC.

### Adapter bắt buộc và ranh giới an toàn

- `identity.normalize`, `valid`, `format`: mặc định số Việt Nam; host có thể cấu hình quy tắc nhận dạng khác.
- `identity.resolveContact(db, phone)` trả ID kênh đã xác minh hoặc `null`. Gửi OTP qua Telegram chỉ chứng minh tiếp cận Telegram, không tự chứng minh SIM.
- `identity.contact(user)` đọc kênh tin cậy hiện có. Không tự thay kênh này từ contact chưa qua quy trình đổi số.
- `identity.sendCode(contact, code, purpose)` gửi thật hoặc ném lỗi; không được trả thành công giả.
- `identity.createAccount(db, { phone, contact, ...registrationContext })` tạo dữ liệu riêng của host, nếu schema host cần.
- `identity.applyContact(db, user, contact, phone)` cập nhật kênh chính bên trong transaction đổi số; phải đồng bộ, không gọi mạng.
- `identity.beforePhoneApplied(db, user)` thu hồi/xoay credential nghiệp vụ; phải ném lỗi nếu không thành công. Core giữ yêu cầu chưa áp dụng khi hook lỗi.
- `notify(...)` trả `{ delivered: true }` chỉ khi ít nhất một kênh tin cậy gửi thành công. Thiếu trạng thái này không được tự động áp dụng yêu cầu chờ. Core retry và tính lại cửa sổ chờ sau khi gửi thành công.
- `email.configured/validate/sendAddress`, `email.available/send`: email xác minh và email khôi phục đủ tuổi.
- `accountExtra(user)` chỉ thêm metadata hồ sơ/hiển thị; không quyết định đăng nhập. `appPayload` không cấp JWT: core luôn tự cấp token.
- `presence` là adapter bằng chứng phụ, không tự thay thế xác minh của người duyệt. Tên route/column `plc` cũ được giữ tương thích; core không import phần cứng.

Adapter tham khảo: `cloud/app/src/securityAdapter.js`. Dashboard/hiển thị tham khảo: `webapp/auth-app.js`, `app.js`, `dash.js`; chúng không sở hữu quy trình xác thực.

Host chỉ import API từ `@plciot/security`, không import trực tiếp `packages/security/src/...`. Các module tương thích phải export cùng hàm của package, không giữ bản triển khai riêng; điều này cũng tránh hai singleton cấu hình khi URL ổ đĩa khác chữ hoa/thường trên Windows.

### Chuyển máy và khôi phục

Máy mới giữ khoá ECDSA P-256 không export trong IndexedDB. Yêu cầu/vé đăng ký gắn với khoá, tài khoản và device ID; chữ ký có nonce, hành động và hạn 60 giây. Máy cũ xác thực và nhập mã ghép đang hiện trên máy mới. Không có đường "chỉ chờ là được cấp quyền".

Chuyển máy bình thường thêm passkey mà không xoá các passkey đang dùng. Chọn "máy cũ bị mất" sẽ thu hồi yếu tố/phiên cũ khi yếu tố mới hoàn tất và tạo mã khôi phục mới. Authenticator hiện là một khoá TOTP cho mỗi tài khoản: thiết lập khoá mới thay khoá cũ, không thêm hai khoá TOTP song song.

Khôi phục đổi số sau mất máy thu hồi JWT, phiên app/step-up, passkey, TOTP và mã khôi phục cũ. Quyền thiết lập lại chỉ dùng trên khoá của trình duyệt tạo yêu cầu, một lần, trong 7 ngày sau khi áp dụng. Hoàn tất OTP và thiết lập yếu tố mới mới cấp phiên đầy đủ. Không xoá IndexedDB của trình duyệt đó khi đang khôi phục.

Admin phải lưu tham chiếu bằng chứng xác minh ngoài kênh và không được rút ngắn thời gian chờ cấu hình. GET link huỷ chỉ hiện form; POST mới thay trạng thái.

### Client dùng chung và giao diện riêng

Chạy `node packages/security/scripts/sync-client.js <webapp>/security`; không sửa bản sinh ra. Trang login nạp `device-proof.js`, `security-client.js`, adapter UI của host (tuỳ chọn), rồi `login.js` từ thư mục security. Trang app nạp `session.js` và `boot.js` ở head; các controller hồ sơ/khôi phục chỉ nạp trên trang tương ứng.

`window.AuthApp` là hook hiển thị/nghiệp vụ: `onAuthenticated`, `onDemo`, `onAuthConfig`, `onSecuritySummary`, `contactLabel`. Không hook nào được bỏ qua quyết định xác thực của server. Menu riêng có thể phát sự kiện `security-profile-refresh` để tải lại hồ sơ. Client không cần `control.js` hoặc `window.Ctl` để đăng nhập.

### Migration và vận hành

Core sở hữu các bảng OTP, email, JWT/session, đổi số/khôi phục và thiết bị; migration idempotent. `new_chat_id` cũ được chuyển sang `new_contact` tổng quát. Yêu cầu thêm máy/khôi phục cũ không có khoá thiết bị không được tự cấp quyền; cần tạo yêu cầu mới. Không xoá DB hay đổi secret khi nâng cấp. Phải triển khai server và client cùng phiên bản.

Kiểm thử core độc lập: `test/smoke-auth-flows.js` không import host PLC, Telegram hoặc MQTT; test fixture dùng DB tạm và adapter gửi OTP/cảnh báo giả.

## Host Cũ Chỉ Dùng Step-Up

Ví dụ tương thích dưới đây dành cho host đã có hệ thống đăng nhập riêng. App mới dùng `mountAuthentication()` ở trên; không sao chép lại route xác thực.

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
| `CONTROL_TOTP_TTL_SEC` | 300 | Phiên sau khi nhập mã Authenticator, tối đa 5 phút |
| `FIRST_DEVICE_ONLY` | `false` | Chỉ thiết bị đầu tiên được bật yếu tố đầu tiên ngay |
| `CONTROL_BIND_NET` | `false` | Phiên gắn với mạng (/24 IPv4, /64 IPv6) |
| `CONTROL_ENROLL_GRACE_DAYS` | 3 | Hạn bật yếu tố; `off` = không ép |
| `CONTROL_LAN_CIDRS` | — | Dải IP cho PC trạm kiểu cũ / siết thêm PC ghép cặp |
| `DEVICE_ADD_COOLING_HOURS` | 24 | Chờ khi thêm thiết bị bằng mã khôi phục/email |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS` | từ `publicUrl` | Tên miền gắn với vân tay |
| `TRUST_PROXY_CIDRS` | loopback + dải riêng | Proxy được tin khi đọc `CF-Connecting-IP`/`X-Forwarded-For` |
| `CSP_CONNECT_EXTRA`, `CORS_ORIGINS` | — | Nguồn kết nối thêm cho CSP; allowlist CORS |
| `RATE_LIMIT_CONTROL_AUTH`, `RATE_LIMIT_STATION_CMD` | 8, 40 | Giới hạn tần suất |

## Quy tắc khi sửa
1. **Quy trình danh tính nằm trong core.** OTP, login/register, đổi máy, đổi số, khôi phục và quyết định cấp quyền không được sao chép vào host. PLC/MQTT/transport gửi tin và dashboard ở adapter/app.
2. Lõi không import app và không đọc `process.env` của app ngoài các biến ở bảng trên; cần gì thì thêm vào `configure()`.
3. Đổi hành vi bảo mật ⇒ thêm test trong `test/smoke-security.js` (app đồ chơi, không PLC) **và** test tích hợp của app.
4. Sửa client ở `client/` rồi `npm run sync-client`; `smoke-security.js` báo lỗi nếu bản trong webapp lệch.
5. Dữ liệu cũ giải mã bằng khoá dẫn xuất từ `secret()` với tiền tố cố định (`plciot-totp|`, `recovery:`, `pair:`): **đổi tiền tố hoặc secret là mất mã khôi phục/TOTP đã lưu**.

## Kiểm thử

Từ `cloud/app`, chạy `npm test` để chạy đủ 14 nhóm. Runner dừng khi lỗi và in tổng số nhóm đã qua; có thể xuất báo cáo JSON bằng `node scripts/test.js --report=<duong-dan-bao-cao.json>`.

Test gồm 16 nhóm trạng thái login UI, 5 nhóm recovery UI (chuẩn hoá danh tính, phục hồi bước OTP, retry mất mạng, adapter hiện diện và hướng dẫn thiết lập lại), core độc lập, cache, khởi động server app thật và các nhóm nghiệp vụ PLC. Compile bot dùng chung trên Windows bằng `py -3.11 -m py_compile cloud/telegram-bot/tele_bot.py` từ gốc repo.

Build image vẫn cần Docker engine đang chạy. Face ID trên thiết bị thật, gửi Telegram/email và thu hồi credential/kết nối MQTT thật phải được kiểm chứng trong môi trường triển khai; mock/test Node không thay thế các gate này.

```bash
node packages/security/test/smoke-security.js      # lõi + app đồ chơi + kiểm tra lệch client
node cloud/app/scripts/smoke-control.js            # tích hợp app PLC (cùng các smoke khác trong cloud/app/scripts)
```
