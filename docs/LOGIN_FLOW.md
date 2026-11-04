# Quy trình đăng nhập / đăng ký (theo thiết bị)

> **Cập nhật:** OTP Telegram / SĐT / email đã bỏ. Nguồn chuẩn mới: [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md).

Code: `webapp/security/login.js`, `packages/security/client/`, `packages/security/src/flows.js`.

## 1. Quy trình

**Thêm thiết bị (tài khoản mới):** quét/dán QR tem → `POST /api/devices/claim` → phiên chờ → bắt buộc passkey (nếu máy hỗ trợ) và/hoặc mật khẩu → vào app.

**Mã mời:** `login.html?invite=…` → `POST /api/invites/redeem` → cùng bước setup.

**Đăng nhập lại:**
- Passkey discoverable (máy đã tin cậy), hoặc
- Username ẩn danh + mật khẩu (+ passkey nếu trình duyệt chưa tin cậy).

Không còn bước OTP.

## 2. API chính

| Endpoint | Vai trò |
|---|---|
| `POST /api/devices/claim` `{ qr }` | Claim tem → pending |
| `POST /api/invites/redeem` `{ token }` | Nhận lời mời → pending |
| `POST /api/login/start` `{ username? }` | Kế hoạch passkey/password |
| `POST /api/login/password` | Đăng nhập mật khẩu |
| `POST /api/login/passkey/*` | Đăng nhập passkey |
| `POST /api/login/complete` / `complete-basic` | Hoàn tất sau setup |
| `POST /api/login/request-otp` v.v. | **410 otp_disabled** |

## 3. Tin cậy trình duyệt

`known_devices.otp_verified*` đổi nghĩa thành **device trusted** (`markDeviceTrusted` / `isDeviceTrusted`), TTL `DEVICE_TRUST_DAYS` (mặc định 30).
