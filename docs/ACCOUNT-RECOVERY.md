# Đổi số điện thoại & khôi phục tài khoản

SĐT là **danh tính** (username = SĐT, OTP qua Telegram). Vì vậy đổi SĐT được bảo vệ theo 3 mức:

| Mức | Bằng chứng | Hiệu lực |
|---|---|---|
| Mạnh | Đăng nhập + mật khẩu + OTP kênh **cũ** (Telegram hoặc email đã xác minh) + OTP vào Telegram của **số mới** | Ngay |
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
docker compose exec app node scripts/recovery.js approve <id> [giờ]
docker compose exec app node scripts/recovery.js reject <id> "lý do"
docker compose exec app node scripts/recovery.js audit 0987654321
```
Trước khi duyệt: xem `show` (OTP số mới, PLC, mã khôi phục, ghi chú) và đối chiếu ngoài kênh (CCCD, hóa đơn, ảnh nhãn serial).

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
- Chủ tài khoản: Cài đặt → "Dữ liệu lịch sử" → xoá lịch sử trên máy chủ (cần mật khẩu).
- Admin: `node scripts/plan.js transfer <SĐT_cũ> <SĐT_mới>` — xoá lịch sử, giao site/device cho chủ mới, chủ cũ chuyển sang namespace trống, xoay mật khẩu MQTT, thu hồi phiên cũ của cả hai.
- Kiểm thử: `node scripts/smoke-retention.js`.
