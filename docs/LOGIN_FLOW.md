# Quy trình đăng nhập / đăng ký (theo thiết bị)

> **Cập nhật:** OTP Telegram / SĐT / email đã bỏ. Nguồn chuẩn mới: [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md).

Code: `webapp/security/login.js`, `packages/security/client/`, `packages/security/src/flows.js`.

## 1. Quy trình

**Đăng ký tài khoản:** tab Đăng ký → chọn username → `POST /api/register` → phiên chờ → bắt buộc passkey (nếu máy hỗ trợ) và/hoặc mật khẩu → vào app. **Không** tạo tài khoản từ QR tem (chống spam DB).

**Gắn thiết bị (QR tem):** chỉ **sau khi đã đăng nhập** → Cài đặt → Nhà máy → dán QR → `POST /api/devices/claim` (Bearer). Deeplink `login.html?claim=…` chỉ lưu `sessionStorage.pendingClaimQr` rồi nhắc đăng nhập trước.

**Mã mời:** `login.html?invite=…` → `POST /api/invites/redeem` → cùng bước setup tài khoản thành viên.

**Đăng nhập lại:**
- Passkey discoverable (máy đã tin cậy), hoặc
- Username + mật khẩu (+ passkey nếu trình duyệt chưa tin cậy).

Không còn bước OTP.

## 2. API chính

| Endpoint | Vai trò |
|---|---|
| `POST /api/register` `{ username, consent }` | Tạo tài khoản (rate-limit IP + trần ngày) |
| `POST /api/devices/claim` `{ qr }` **+ auth** | Gắn tem vào user đã login |
| `POST /api/invites/redeem` `{ token }` | Nhận lời mời → pending |
| `POST /api/login/start` `{ username? }` | Kế hoạch passkey/password |
| `POST /api/login/password` | Đăng nhập mật khẩu |
| `POST /api/login/passkey/*` | Đăng nhập passkey |
| `POST /api/login/complete` / `complete-basic` | Hoàn tất sau setup |
| `POST /api/login/request-otp` v.v. | **410 otp_disabled** |

## 3. Chống spam đăng ký

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `RATE_LIMIT_REGISTER` | 3 / giờ / IP | Đăng ký |
| `RATE_LIMIT_REGISTER_DAY` | 5 / ngày / IP | Đăng ký |
| `REGISTER_MAX_PER_DAY` | 50 | Trần đăng ký mới / 24h |
| `REGISTER_MAX_INCOMPLETE` | 100 | Trần user `setup_complete=0` |
| `REGISTER_ABANDON_MS` | 6h | Dọn user bỏ dở |
| `REGISTRATION_OPEN` | true | `false` = khoá đăng ký |

## 4. Tin cậy trình duyệt

`known_devices.otp_verified*` đổi nghĩa thành **device trusted** (`markDeviceTrusted` / `isDeviceTrusted`), TTL `DEVICE_TRUST_DAYS` (mặc định 30).
