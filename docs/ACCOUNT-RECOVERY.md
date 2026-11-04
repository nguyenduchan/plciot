# Khôi phục tài khoản (không SĐT / Telegram / email)

> Danh tính theo thiết bị — xem [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md). Đổi số / OTP đã **tắt**.

## Cách khôi phục

1. **Máy cũ còn:** duyệt yêu cầu thêm thiết bị (`device_requests`) từ máy cũ.
2. **Mã khôi phục:** khi setup yếu tố, lưu 10 mã; dùng cùng mật khẩu hoặc passkey (`POST /api/login/recover` với `recoveryCode` + yếu tố thứ hai).
3. **Mất hết:** ticket admin gắn lại hardware / cấp mã khôi phục mới (ngoài băng).

## Không còn

- Đổi số điện thoại (`/api/account/phone/*` → 410)
- OTP Telegram / email
- Khôi phục qua kênh ngoài

## Thêm máy trình duyệt

Giữ luồng `device_requests`: duyệt từ máy cũ hoặc mã khôi phục (chờ 24 giờ nếu dùng recovery). Không còn nhánh email.
