# Danh tính theo thiết bị (QR)

Hệ thống **không dùng** số điện thoại, Telegram, email hay OTP để định danh.

## Luồng

1. **Admin** mở `admin.html` → *Thêm thiết bị (QR in tem)* (hoặc CLI `provision-device-qr.js`).
2. Hệ thống chỉ chấp nhận claim nếu `site/device` đã có trong `hardware_devices`.
3. In tem QR (link `login.html?claim=…`) dán lên gateway.
4. Người dùng quét/dán QR → `POST /api/devices/claim` → verify chữ ký + `claim_hash` → map user ẩn danh với device.
5. Client bắt buộc passkey và/hoặc mật khẩu → `setup_complete=1`, cấp phiên đầy đủ.
6. Lần sau: passkey discoverable hoặc mật khẩu (+ deviceProof), không hỏi PII.

### API admin

| Method | Path | Việc |
|---|---|---|
| GET | `/api/admin/hardware` | Danh sách + trạng thái khoá ký |
| POST | `/api/admin/hardware` | Thêm device, trả `qr` / `loginUrl` |
| GET | `/api/admin/hardware/:site/:device/qr` | In lại tem (cùng secret) |
| POST | `/api/admin/hardware/:site/:device/reissue` | Xoay secret (tem cũ hết hạn) |
| DELETE | `/api/admin/hardware/:site/:device` | Xoá đăng ký |

## Mã mời thành viên

Chủ site: `POST /api/site/invites` `{ role }` → nhận `code` / URL `login.html?invite=…`.
Người nhận: `POST /api/invites/redeem` → tạo tài khoản ẩn danh gắn cùng site (không phải chủ).

## Biến môi trường

| Biến | Vai trò |
|---|---|
| `CLAIM_ROOT_PUBLIC_KEY` | PEM Ed25519 — server verify tem |
| `CLAIM_ROOT_PRIVATE_KEY` | Chỉ máy provision |
| `TELEGRAM_BOT_ENABLE=true` | Bật lại bot (mặc định tắt) |
| `DEVICE_TRUST_DAYS` | Số ngày tin cậy trình duyệt (mặc định 30) |

Sinh khoá: `node cloud/app/scripts/provision-device-qr.js gen-keys`.

## Kiểm thử

`node cloud/app/scripts/smoke-device-claim.js`
