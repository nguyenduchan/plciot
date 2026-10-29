# Bảo mật đăng nhập & điều khiển

> Muốn hiểu **nguyên lý và lý do** đằng sau từng lớp bảo mật: đọc [SECURITY-DESIGN.md](SECURITY-DESIGN.md). Tài liệu này là cấu hình/API chi tiết.

> **Mã nguồn bảo mật cố định nằm ở một vùng riêng: [`packages/security`](../packages/security/README.md) (`@plciot/security`)** để tái sử dụng cho mọi app/khách hàng.
> Gói chứa Passkey/TOTP, phiên điều khiển, thêm thiết bị, ghép PC, CSP/giới hạn tần suất và client trình duyệt; **không biết** app điều khiển PLC hay nhắn Telegram.
> Core nay sở hữu cả OTP login/register, JWT/session, đổi số/khôi phục và controller xác thực. App PLC giữ `securityAdapter.js` (gửi tin, bundle, MQTT), `plcCommands.js`, `plcControlRoutes.js`, `sites.js`/`siteRoutes.js` và dashboard. Các module xác thực cũ trong app chỉ chuyển tiếp API. Hướng dẫn webapp mới: README của gói.

**Không có mật khẩu.** Đăng nhập chính là **Passkey** (vân tay / Face ID / mã khoá thiết bị, không gõ SĐT): `POST /api/login/passkey/{options,verify}`. **OTP Telegram không còn đủ để vào ứng dụng**: OTP chỉ cấp token `login_pending` trong 10 phút, không có bundle hay thông tin MQTT. Tài khoản đã bật bảo vệ phải xác thực passkey/TOTP; tài khoản chưa có yếu tố phải thiết lập trước khi hoàn tất. Huỷ thiết lập không cấp phiên đầy đủ. Passkey có thể đồng bộ qua iCloud Keychain / Google Password Manager; đây không phải bằng chứng phần cứng gắn với một điện thoại duy nhất, cũng không phải eKYC.

## Luồng đăng nhập và khoá ứng dụng

1. Máy có passkey: người dùng bấm đăng nhập bằng passkey, server xác minh rồi cấp phiên app và quyền điều khiển ngắn hạn. Không hỏi thêm OTP.
2. Đăng nhập/đăng ký OTP: server trả token chờ, gắn với tài khoản, `X-Device-Id` và challenge trong DB. Client giữ token chờ trong bộ nhớ, không lưu thành phiên app.
3. Client xác thực passkey/TOTP bằng các API gắn với đúng tài khoản. Chưa có yếu tố thì bắt buộc thiết lập. Máy không thể dùng yếu tố hiện có đi qua "Máy mới / mất máy cũ?" để xin phê duyệt; OTP không thay thế bước này.
4. `POST /api/login/complete` kiểm tra bằng chứng được cấp cho chính challenge đó, dùng challenge một lần rồi mới trả JWT đầy đủ, bundle manifest và thông tin MQTT. Token chờ không gọi được API dữ liệu, quản trị, bundle, lệnh PLC hoặc duyệt máy khác; không được gia hạn trượt.
5. Mở lại trang phải mở khoá. Ở nền từ 60 giây hoặc không hoạt động 5 phút thì khoá. Server lưu trạng thái phiên và kiểm tra thời hạn trên mỗi API; polling tự động không kéo dài thời gian hoạt động. Chạm/phím/cuộn gửi heartbeat tối đa một lần mỗi 30 giây.
6. Khoá dừng MQTT và xoá thông tin MQTT lưu trong cấu hình trình duyệt. Mở khoá dùng `POST /api/login/resume` để nhận challenge mới rồi xác thực và hoàn tất như bước 3–4. Phiên cũ vẫn khoá; huỷ không tự vào dashboard. Khi mất mạng, không mở khoá mới được.
7. Khoá/đăng xuất không xoá bundle cache. Cùng tài khoản và source version chỉ tải file cache bị thiếu; source mới thì tải bundle mới. Không yêu cầu nhập OTP chỉ để tải lại source.

API phiên: `POST /api/login/{complete,resume,lock,activity,background}` và `POST /api/logout`. Đăng xuất thu hồi phiên app ở server. Khi triển khai bản này, JWT cũ chưa có bản ghi phiên sẽ bị từ chối, nên cần đăng nhập lại một lần; không cần xoá cache.

WebAuthn yêu cầu `userVerification: required`, nhưng hệ điều hành có thể cho dùng Face ID, vân tay hoặc mã khoá thiết bị. Không cam kết "chỉ Face ID". Token app vẫn ở localStorage và dữ liệu lịch sử/cache chưa mã hoá tại chỗ: khoá ứng dụng bảo vệ truy cập UI/API, không chống người kiểm soát trình duyệt hoặc đọc trực tiếp dữ liệu trên máy.

Các thao tác nhạy cảm trước đây hỏi "mật khẩu hiện tại" (đổi số, email khôi phục, mã khôi phục, xoá lịch sử) giờ yêu cầu **xác nhận lại bằng vân tay / Authenticator** (middleware `reauth`); người chưa có yếu tố nào chỉ cần vừa đăng nhập ≤ 10 phút. Đường đăng nhập bằng mật khẩu (`POST /api/login`) và mọi ô nhập/đặt mật khẩu (kể cả trang admin) đã bị gỡ. Cột `password_hash` còn trong DB chỉ vì ràng buộc NOT NULL cũ, chứa chuỗi ngẫu nhiên không ai biết.

Lớp mới nằm ở **điều khiển**: mọi lệnh ghi PLC phải qua app server, và server chỉ phát lệnh lên MQTT khi người gửi vượt được lớp xác thực phù hợp ngữ cảnh.

```
Điện thoại ──HTTPS──> POST /api/control/cmd ──(kiểm tra)──> MQTT user "ctl" ──> plc/<site>/<dev>/cmd ──> Gateway/PLC
   (JWT + X-Control-Token)       │
                                 ├─ PC trạm trong LAN xưởng: IP + khoá trạm      → không hỏi mã
                                 ├─ Passkey (vân tay / Face ID)                  → 1 chạm, phiên 5 phút
                                 ├─ TOTP (Authenticator)                         → phiên tối đa 5 phút, gắn mạng
                                 └─ Lệnh nguy hiểm (D4, D6)                      → xác thực mới + nút vật lý (tuỳ chọn)
```

## Vì sao phải đi qua server
Trước đây điện thoại giữ mật khẩu MQTT có quyền `topic write …/cmd`, nên ai lấy được mật khẩu đó có thể điều khiển mà không cần vân tay/OTP nào. Giờ ACL (`cloud/app/src/mqttProvision.js`) **bỏ quyền ghi `cmd` của mọi user điện thoại**; chỉ user `ctl` (app server, kênh nội bộ cổng 1884) được ghi. Điện thoại vẫn đọc telemetry/ack qua MQTT như cũ. Đặt `CONTROL_VIA_SERVER=false` để quay lại chế độ cũ (không khuyến nghị).

## Các lớp

| Ngữ cảnh | Cơ chế | Chi tiết |
|---|---|---|
| Điện thoại đời cao | **Passkey / WebAuthn** | `src/webauthn.js`. Bắt buộc User Verification, attestation `none`, ES256/RS256, kiểm tra origin + rpId (khoá gắn tên miền → chống phishing), bộ đếm chống sao chép. Phiên `CONTROL_PASSKEY_TTL_SEC` (300 s). |
| Điện thoại đời thấp | **TOTP** (RFC 6238) | `src/totp.js`. Bí mật mã hoá AES-GCM trong DB; mã chỉ dùng một lần; sai 5 lần → khoá 15 phút. Phiên `CONTROL_TOTP_TTL_SEC` (300 giây), **gắn với mạng** (/24 IPv4, /64 IPv6). Cấu hình ngày cũ không còn dùng; phiên cũ quá 5 phút cũng bị chặn. |
| PC tại xưởng | **IP LAN + khoá trạm** | Admin cấp trạm (`POST /api/admin/stations`), PC gửi `X-Station-Id`/`X-Station-Key`; chỉ có hiệu lực khi IP nằm trong `CONTROL_LAN_CIDRS` và trạm thuộc chính user đăng nhập. Server nằm trên VPS nên đây là **IP công cộng của xưởng**. |
| Lệnh nguy hiểm | **Nút nhấn vật lý** | Đặt `CONTROL_PHYSICAL_BIT` (0–7 = X0..X7 của D0) và `CONTROL_CRITICAL_ADDRS`. Server giữ lệnh, chỉ phát khi telemetry cho thấy **cạnh tín hiệu mới** ở ngõ vào đó trong `CONTROL_PHYSICAL_WAIT_SEC` giây (dùng lại `plcProof.js`). Áp dụng cả với PC trạm. |

Thiết lập yếu tố **đầu tiên** yêu cầu vừa đăng nhập bằng OTP Telegram (≤ 10 phút); thêm/xoá yếu tố về sau yêu cầu phiên điều khiển đang mở, nên người nhặt được điện thoại đang đăng nhập không tự đăng ký vân tay của họ được. Xoá yếu tố thu hồi mọi phiên điều khiển.

Tài khoản chưa thiết lập yếu tố nào phải hoàn tất thiết lập ngay trong luồng đăng nhập. Không cấp chế độ chỉ xem bằng OTP trong chính sách hiện tại; vai trò viewer vẫn không có quyền điều khiển sau khi đăng nhập.

Lệnh nhạy cảm từ phiên người dùng có thêm challenge ngẫu nhiên 60 giây, gắn với tài khoản, phiên app, site/device và nội dung lệnh (gồm ID). Client hiện site/device, thanh ghi và giá trị trước khi xác thực mới. Bằng chứng passkey/TOTP mang `X-Command-Challenge`; chỉ đúng challenge và nội dung mới được thực thi một lần. Sửa lệnh/phát lại không qua được. Phiên người dùng đã hết hạn/thu hồi không được tiếp tục bước chờ vật lý. PC trạm tin cậy là luồng riêng, giữ kiểm tra khoá/chữ ký và xác nhận vật lý hiện có.

## Thêm máy điện thoại mới (không cần admin)
Đổi máy hoặc mất máy: sau OTP, máy mới vẫn chờ xác thực, chưa xem được dữ liệu. Bấm **"Máy mới / mất máy cũ?"** trong hộp thoại xác nhận. Server cấp một **vé đăng ký** (15 phút, dùng một lần, chỉ có tác dụng đăng ký vân tay/Authenticator) theo một trong ba đường (`src/deviceApproval.js`):

| Đường | Điều kiện | Hiệu lực |
|---|---|---|
| Duyệt từ máy cũ | Máy cũ mở khoá bằng vân tay/Authenticator rồi bấm **Cho phép** (Cài đặt → "Duyệt thiết bị mới", hoặc tự hiện) | Ngay |
| Mã khôi phục | 1 mã trong 10 mã (đã tự tạo khi bật yếu tố đầu tiên) | Chờ `DEVICE_ADD_COOLING_HOURS` (24 giờ) |
| Email đã xác minh | OTP gửi vào email (email phải qua kỳ cách ly 72 giờ) | Chờ 24 giờ |

Trong thời gian chờ chủ tài khoản được báo (Telegram + email) kèm **link huỷ 1 chạm**, và mọi máy cũ thấy yêu cầu để **Từ chối**. Yêu cầu hết hạn sau 30 phút nếu không ai xử lý; yêu cầu bị huỷ/từ chối không bao giờ cấp vé. Máy mới dùng TOTP sẽ **thay** bí mật Authenticator cũ (bí mật cũ chỉ bị thay sau khi nhập đúng mã đầu tiên).

**Mã khôi phục tự tạo** ngay khi bật yếu tố đầu tiên (vân tay hoặc Authenticator): hộp thoại hiện 10 mã một lần và chỉ đóng được khi người dùng tích "Tôi đã lưu".
Nếu mất cả máy cũ lẫn mã khôi phục và email thì vẫn còn luồng ticket cho admin (docs/ACCOUNT-RECOVERY.md).

API: `POST /api/devices/request` · `POST /api/devices/requests/:id/{poll,recovery,email/start,email/confirm}` (máy mới) · `GET /api/devices/requests` · `POST /api/devices/requests/:id/{approve,deny}` (máy cũ, cần phiên điều khiển) · `GET /api/device/cancel?id=&t=` (link huỷ). Vé gửi trong header `X-Enroll-Ticket`.

## PC không có vân tay / Face ID / Windows Hello
Máy không có passkey có thể dùng **Authenticator** để đăng nhập và mở khoá điều khiển; phiên điều khiển tối đa 5 phút, gắn mạng. Passkey tạo trên điện thoại có thể dùng trên PC nếu nền tảng đồng bộ (iCloud/Google). Gợi ý `client-device` không bảo đảm trình duyệt chỉ dùng khoá trên chính máy đó.

## Không có bậc bảo mật thấp để điều khiển
Điều khiển **chỉ** có hai phương thức: Passkey hoặc mã Authenticator (TOTP). **OTP Telegram/SMS không bao giờ đủ để điều khiển**, và cũng không đủ cấp phiên xem dữ liệu. OTP chỉ mở luồng chờ xác thực/thiết lập yếu tố. Không dùng OTP làm đường vòng bỏ qua yếu tố đã bật.
Máy không hỗ trợ passkey cần dùng ứng dụng Authenticator (có thể trên thiết bị khác). Vai trò viewer chỉ hạn chế quyền thao tác, không bỏ qua bước xác thực đăng nhập.

## Bắt buộc bật yếu tố, cảnh báo và các chốt chặn
- **Chống chiếm Telegram tự bật yếu tố đầu tiên:** chỉ **thiết bị đầu tiên** đăng nhập vào tài khoản (`known_devices`) được bật ngay. Máy khác (hoặc không gửi `X-Device-Id`) nhận `first_device_required` và phải qua vé: email đã xác minh hoặc chờ 24 giờ, trong thời gian chờ chủ được báo và huỷ được. Máy đời thấp thông thường bật ngay trên máy đầu tiên nên không bị phiền. Giới hạn: nếu kẻ tấn công đăng nhập trước chủ thật trên tài khoản cũ chưa từng ghi nhận thiết bị, nó trở thành "thiết bị đầu tiên".
- **Token:** JWT mặc định **72 giờ** (`JWT_TTL_HOURS`) nhưng **gia hạn trượt**: khi quá nửa hạn, server gửi `X-Renewed-Token` và `webapp/session.js` cập nhật; dùng hằng ngày thì không phải đăng nhập lại, bỏ quá 3 ngày mới phải đăng nhập (vân tay một chạm hoặc OTP).
- **CSP:** `script-src 'self'` (không script nội tuyến/nguồn lạ), `object-src 'none'`, `frame-ancestors 'none'`; `connect-src` mở `wss:/ws:` cho broker (thêm nguồn khác bằng `CSP_CONNECT_EXTRA`). XSS khó lấy được JWT và token điều khiển hơn, nhưng token vẫn nằm trong localStorage (chưa chuyển sang cookie HttpOnly).
- **Giá trị ghi theo từng thanh ghi** (lỗi `value_out_of_range`): D3 0/1 · D4 0–255 · D6 0/1 · D7 0–60000 · D9 chỉ 1. Siết thêm: `CONTROL_REG_LIMITS="7:0-5000,4:0-15"`. Đây là lớp ở server; khoá an toàn thật vẫn phải nằm trong PLC.
- **Hạn bật yếu tố (vân tay/Authenticator):** người có quyền điều khiển phải bật trong `CONTROL_ENROLL_GRACE_DAYS` ngày (mặc định 3, tính từ lần đầu cần; `off` = không ép). Quá hạn mà chưa bật → **khoá điều khiển** (lệnh ghi trả `enroll_required`; vẫn xem và đọc thanh ghi được). Tab **Điều khiển** hiện banner: còn bao nhiêu ngày, hoặc "Điều khiển đã bị khoá" kèm nút **Bật ngay** / **Đăng nhập lại rồi bật**. Bật xong là mở khoá ngay.
- **Thiết bị lạ:** webapp gửi `X-Device-Id`; đăng nhập từ thiết bị chưa từng thấy (khi tài khoản đã có thiết bị khác) → cảnh báo Telegram + email kèm hướng dẫn "Đăng xuất mọi máy". Bật yếu tố đầu tiên cũng gửi cảnh báo. Giới hạn: kẻ chiếm Telegram cũng đọc được cảnh báo Telegram, nên nên xác minh một email làm kênh độc lập.
- **Đăng xuất mọi máy** (Cài đặt → Điều khiển): `POST /api/account/logout-all`, cần xác nhận lại; tăng `token_version` và thu hồi mọi phiên điều khiển.
- **Admin:** thao tác ghi (tạo/sửa/xoá người dùng, trạm kiểu cũ) phải qua xác nhận lại bằng vân tay/Authenticator.
- **`clientIp`:** chỉ tin `CF-Connecting-IP`/`X-Forwarded-For` khi kết nối TCP đến từ proxy tin cậy (`TRUST_PROXY_CIDRS`, mặc định loopback + dải riêng Docker/LAN); XFF đọc từ phải sang trái bỏ hop tin cậy. Truy cập thẳng không giả được IP, nên giới hạn tần suất, ràng buộc mạng TOTP và kiểm tra IP của trạm không bị qua mặt.
- **OTP theo số điện thoại (bất kể IP):** tối đa `OTP_REQ_PER_PHONE_HOUR` (6) lần xin/giờ và `OTP_FAIL_PER_PHONE_15MIN` (10) lần nhập sai/15 phút; vượt thì khoá cả khi xin mã mới.

## Nhà máy tự phục vụ (không cần admin)
Cài đặt → **Nhà máy & thành viên** (`src/sites.js`, `src/stationAuth.js`, `webapp/site.js`). **Chủ site** (`users.site_owner`) là người đầu tiên của site; nếu site chưa có chủ thì operator/admin có id nhỏ nhất tự được nâng lên.

| Việc | Cách làm | Bảo vệ |
|---|---|---|
| **Nhận thiết bị** (site chưa có người dùng) | Nhập tên site/device in trên gateway; bật-tắt một ngõ vào X do server chọn trong 2 phút | Gateway phải đang gửi telemetry + chứng minh có mặt tại PLC (plcProof). Site đã có người dùng thì không nhận được, phải được mời |
| **Mời thành viên** | Chủ site nhập SĐT + quyền (điều khiển / chỉ xem); người được mời đăng nhập và bấm Chấp nhận | Cần xác nhận vân tay/Authenticator; lời mời 7 ngày; người được mời tự chấp nhận (vì sẽ chuyển namespace) |
| **Gỡ thành viên** | Chủ site bấm Gỡ | Thành viên về vùng riêng, đổi mật khẩu MQTT, thu hồi phiên điều khiển và token |
| **Ghép PC nhà máy** | Chủ site bấm "Thêm PC" → mã `XXXX-XXXX` (10 phút, một lần) → nhập vào phần mềm SCADA trên PC | PC sinh khoá ECDSA P-256; khoá riêng nằm trong DPAPI, không rời máy |
| **Đổi PC** | Ghép PC mới, thu hồi PC cũ | PC bị thu hồi mất quyền ngay; chủ site được báo khi có PC mới |

Lệnh từ PC đã ghép: `POST /api/station/cmd` ký bằng khoá thiết bị — header `X-Station-Id`, `X-Station-Ts`, `X-Station-Sig`; chuỗi ký `ts\nMETHOD\npath\nsha256hex(body)`, chữ ký IEEE-P1363. Server chặn lệch giờ > 60 s, phát lại chữ ký, sửa nội dung sau khi ký, khoá lạ. Whitelist thanh ghi và nút vật lý cho lệnh nguy hiểm áp dụng như điện thoại. Không phụ thuộc IP (mạng xưởng hay đổi IP công cộng); `CONTROL_LAN_CIDRS` chỉ là lớp siết thêm nếu admin muốn. Phía C#: `StationClient` trong `Plciot.Scada.Services` (`PairAsync`, `WriteAsync`, `PingAsync`, `ConfirmAsync`).

API: `GET /api/site` · `POST /api/site/claim/{start,check}` · `POST|DELETE /api/site/invites` · `POST /api/invites/:id/{accept,decline}` · `DELETE /api/site/members/:id` · `POST /api/site/pair-code` · `DELETE /api/site/stations/:id` · `POST /api/station/pair` · `GET /api/station/ping` · `POST /api/station/cmd` · `GET /api/station/confirm/:id`.

## Cấu hình bắt buộc khi triển khai
0. Đặt `TRUST_PROXY_CIDRS` nếu proxy/tunnel của bạn không nằm trong dải riêng mặc định (nếu sai, mọi người dùng bị coi chung một IP).
1. Tạo user MQTT `ctl` (xem DEPLOY.md), điền `MQTT_CONTROL_PASS`.
2. HTTPS + tên miền cố định (Passkey chỉ chạy trên HTTPS). `WEBAPP_PUBLIC_URL` hoặc `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` phải khớp tên miền người dùng mở.
3. Người dùng cũ đang cache bundle webapp: **tăng `version`** để máy tải lại `control.js`; bản cũ không có `control.js` sẽ không gửi được lệnh khi `CONTROL_VIA_SERVER=true`.
4. Muốn PC trạm: điền `CONTROL_LAN_CIDRS`, tạo trạm qua API admin và lưu khoá (chỉ hiện một lần).
5. Muốn nút vật lý: đấu nút vào ngõ vào X còn trống, không dùng X3 (cảm biến đếm), đặt `CONTROL_PHYSICAL_BIT`.

## API
`GET /api/control/status` · `POST /api/control/totp/{setup,enable,disable}` · `POST /api/control/{unlock,lock,cmd}` · `GET /api/control/confirm/:id` · `POST /api/webauthn/{register,auth}/{options,verify}` · `GET|DELETE /api/webauthn/credentials` · `GET|POST|DELETE /api/admin/stations`.
Token điều khiển gửi trong header `X-Control-Token`; server chỉ lưu băm SHA-256, mọi sự kiện ghi `audit_log` (`control_unlock`, `control_cmd`, `control_denied`, `totp_fail`, …).

## Kiểm thử
`node cloud/app/scripts/smoke-control.js` và `node cloud/app/scripts/smoke-sites.js` (không cần broker), `dotnet test scada/tests/Plciot.Scada.Tests --filter StationClient` (kiểm chứng chéo với server thật: đặt `PLCIOT_PAIR_URL`, `PLCIOT_PAIR_CODE`): vector TOTP RFC 6238, authenticator giả lập (đăng ký/đăng nhập, origin giả, chữ ký sai, bộ đếm lùi), đổi mạng, chống phát lại, khoá sai mã, PC trạm, nút vật lý, whitelist lệnh.

## Chưa có / giới hạn
- Chưa kiểm chứng trên iPhone/Android thật và với broker thật (chỉ test tự động bằng authenticator giả lập).
- `StationClient` (C#) đã có và đã kiểm chứng chéo với server, nhưng **chưa gắn vào giao diện** của phần mềm SCADA (màn hình nhập mã ghép, nút Thu hồi cục bộ) và chưa dùng để cấp thông tin đăng nhập MQTT cho `CloudBridge` (hiện vẫn cấu hình tay `CloudUser/CloudPassword`).
- Mã ghép PC chỉ chứng minh người cầm mã là chủ site; nếu chủ site bị chiếm tài khoản thì kẻ đó ghép được PC giả — vì vậy ghép/thu hồi đều đòi vân tay/Authenticator và có báo Telegram.
- Nút vật lý dựa vào D0 qua Modbus (không xác thực): chỉ là yếu tố bổ trợ, khoá liên động an toàn vẫn phải nằm trong PLC.
- Mất hết thiết bị có passkey/Authenticator: không tự thêm yếu tố mới chỉ bằng OTP Telegram (cố ý, chống chiếm Telegram). Dùng mã khôi phục / email (chờ 24 giờ) như trên; hết cách mới cần ticket admin (docs/ACCOUNT-RECOVERY.md).
- OTP Telegram vẫn đăng nhập được vào phần xem; điều khiển luôn đòi yếu tố đã đăng ký.
