# Đổi số điện thoại & khôi phục tài khoản

> Không còn mật khẩu: nơi nào trước đây hỏi "mật khẩu hiện tại" nay yêu cầu xác nhận lại bằng vân tay/Authenticator. **Đổi máy điện thoại (giữ nguyên số)** xem [CONTROL-SECURITY.md](CONTROL-SECURITY.md#thêm-máy-điện-thoại-mới-không-cần-admin).

## Core Dùng Chung

Mọi quyết định login/register, đổi máy, đổi số và khôi phục hiện nằm trong `packages/security` (`mountAuthentication`). `cloud/app/src/accountSecurity.js`, `auth.js`, `otp.js`, `phone.js` chỉ là đường import tương thích. Adapter Telegram/email/MQTT ở `cloud/app/src/securityAdapter.js`; dashboard và hiển thị PLC không nằm trong core.

Sau mất máy, khôi phục số thu hồi passkey/TOTP/mã khôi phục cũ và mọi phiên app/điều khiển. Chỉ khoá của trình duyệt tạo yêu cầu được thiết lập lại yếu tố một lần, trong 7 ngày sau áp dụng; không xoá IndexedDB hoặc chuyển trình duyệt trong lúc chờ. Đăng nhập OTP sau khôi phục chưa đủ vào app: phải thiết lập yếu tố mới.

Máy mới cần khoá ECDSA và chữ ký chống phát lại. Máy cũ nhập mã ghép hiện trên máy mới trước khi duyệt. Chuyển máy bình thường có bước xem/thu hồi máy cũ sau đăng nhập; chọn máy cũ bị mất sẽ thu hồi yếu tố/phiên cũ khi máy mới hoàn tất. Không có đường chỉ chờ rồi tự có quyền.

Cảnh báo phải có trạng thái gửi thành công. Nếu gửi thất bại, yêu cầu chưa áp dụng; core retry và bắt đầu lại cửa sổ chờ sau khi gửi được. Adapter xoay credential lỗi cũng chặn áp dụng. Reload broker không thay thế kiểm thử thu hồi kết nối MQTT đang hoạt động trên môi trường triển khai.

GET link huỷ chỉ hiện form; POST mới huỷ yêu cầu. Khi nâng cấp, yêu cầu cũ thiếu khoá thiết bị không được tự cấp quyền và cần tạo lại. Triển khai server và client cùng phiên bản, giữ nguyên DB/secret.

SĐT là **danh tính** (username = SĐT, OTP qua Telegram). Vì vậy đổi SĐT được bảo vệ theo 3 mức:

| Mức | Bằng chứng | Hiệu lực |
|---|---|---|
| Mạnh | Phiên đầy đủ + xác nhận passkey/TOTP + OTP kênh **cũ** + OTP vào kênh đã xác minh của **số mới** | Ngay khi cảnh báo và xoay credential thành công |
| Yếu | Như trên nhưng thay OTP kênh cũ bằng **mã khôi phục** (dùng 1 lần) | Sau `PHONE_CHANGE_COOLING_HOURS` (24h) |
| Mất hết | Ticket tại `recover.html` + OTP số mới (+ ghi chú, thử thách PLC) → **admin duyệt** | Sau `RECOVERY_COOLING_HOURS` (48h) |

Nếu có mã khôi phục hợp lệ trong ticket, bỏ qua bước duyệt (vẫn chờ 24h).

Mọi đường đều: báo cho chủ cũ (Telegram + email) kèm **link huỷ 1 chạm** (`/api/phone/cancel`), ghi `audit_log`,
khi áp dụng thì tăng `token_version` (đăng xuất mọi phiên cũ) và xoay mật khẩu MQTT.

## Thành phần
- **Số mới phải chứng minh sở hữu**: OTP gửi vào Telegram đã liên kết với số đó (bot kiểm tra `contact.user_id == from.id`).
- **Email khôi phục**: `SMTP_URL` bắt buộc. Email mới thêm chỉ làm "kênh cũ" được sau `EMAIL_QUARANTINE_HOURS` (72h), và kênh cũ được báo khi thêm.
- **Mã khôi phục**: 10 mã `XXXX-XXXX-XXXX` (60 bit), lưu HMAC, dùng 1 lần; tối đa 10 lần sai/24h/tài khoản.
- **Thử thách PLC**: ticket yêu cầu tác động vào một đầu vào X (bit D0) trong 2 phút; server thấy cạnh chuyển qua telemetry MQTT.
  Modbus không có xác thực, nên đây chỉ là **bằng chứng phụ cho admin**, không tự động duyệt.

## Admin (trên máy chủ)
```bash
docker compose exec app node scripts/recovery.js list            # ticket chờ duyệt
docker compose exec app node scripts/recovery.js show <id>
docker compose exec app node scripts/recovery.js approve <id> 48 "tham-chieu-xac-minh-doc-lap"
docker compose exec app node scripts/recovery.js reject <id> "lý do"
docker compose exec app node scripts/recovery.js audit 0987654321
```
Trước khi duyệt: xem `show` (OTP số mới, PLC, mã khôi phục, ghi chú) và đối chiếu ngoài kênh (CCCD, hóa đơn, ảnh nhãn serial).
Core bắt buộc lưu tham chiếu bằng chứng và không cho CLI rút ngắn thời gian chờ cấu hình. Bằng chứng PLC chỉ là phụ; không tự đủ để duyệt.

## API
Đăng nhập: `GET /api/account/security`, `POST /api/account/{email/request,email/verify,recovery-codes,phone/start,phone/confirm,phone/cancel}`.
Công khai: `POST /api/recovery/{start,confirm,status,plc/start,plc/check}`, `GET /api/phone/cancel?id=&t=`.

## Triển khai
- Sau khi cập nhật webapp, tăng `version` của user (hoặc seed lại) để bundle đã cache có `account.js` / `recover.html`.
- Kiểm thử offline: `node scripts/smoke-account.js`.

## Thời gian lưu dữ liệu (gói)
- Mặc định **3 ngày** (`HISTORY_DEFAULT_DAYS`). Mỗi tài khoản có `users.retention_days`: `NULL` = mặc định, `0` = không giới hạn, `N ≥ 4` = N ngày (không cố định mức).
- Dọn mỗi giờ theo gói; site/device dùng chung nhiều tài khoản lấy mức **dài nhất**. API lịch sử cũng chặn đọc quá cửa sổ gói.
- Admin: `node scripts/plan.js set <SĐT> <số ngày ≥4 | unlimited | default>`, `show`, `list`. Hạ gói sẽ xoá dữ liệu cũ hơn cửa sổ mới.

## Chuyển nhượng thiết bị / xoá dữ liệu
- Chủ tài khoản: Cài đặt → "Dữ liệu lịch sử" → xoá lịch sử trên máy chủ (cần xác nhận lại bằng vân tay/Authenticator).
- Admin: `node scripts/plan.js transfer <SĐT_cũ> <SĐT_mới>` — xoá lịch sử, giao site/device cho chủ mới, chủ cũ chuyển sang namespace trống, xoay mật khẩu MQTT, thu hồi phiên cũ của cả hai.
- Kiểm thử: `node scripts/smoke-retention.js`.
