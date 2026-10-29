# Debug Passkey / Face ID (hỗ trợ LLM + test iPhone)

## Bật debug (chỉ SĐT của bạn)

**Server** (`cloud/.env`):

```env
DEBUG_CLIENT_TRACE=true
# Chỉ số này (hoặc để trống = dùng ADMIN_DASHBOARD_PHONES / ADMIN_PHONES)
DEBUG_TRACE_PHONES=0901234567
ADMIN_DASHBOARD_PHONES=0901234567
```

Restart app. Health: `GET /api/health` → `"debugTrace": true`.

SĐT khác dù mở `?debug=1` cũng **không** ghi được event (`debug_phone_denied`).

**iPhone (Safari):**  
`https://plc.…/login.html?debug=1`  
→ panel DEBUG → nhập **đúng SĐT của bạn** → Xác nhận → mới gửi event.

Tắt: `?debug=0`.

## LLM / Claude xem kết quả từ điện thoại

```bash
curl -s "https://plc.…/api/debug/trace?phone=84901234567" | jq .
# hoặc:
tail -n 50 cloud/app/data/debug-trace.jsonl
```

Phải kèm `?phone=` (cùng SĐT allow-list).

Trong Cursor, nhờ agent: *“đọc `/api/debug/trace` hoặc `debug-trace.jsonl` rồi giải thích lỗi Passkey”*.

Sự kiện quan trọng:

| action | Ý nghĩa |
|---|---|
| `env` | HTTPS? có platform authenticator (Face ID)? |
| `login.start` → `login.gesture_ok` → `login.verify_ok` | Đăng nhập Face ID OK |
| `*.gesture_fail` + `NotAllowedError` | User huỷ / không hiện Face ID |
| `*.verify_fail` | Server từ chối (rpId, credential lạ…) |
| `register.*` | Lần đầu bật Passkey sau OTP |

## Máy PC không có Finger ID — test thế nào?

**Bạn có iPhone 14 → dùng iPhone làm máy chính để test Face ID.**  
PC không vân tay **không** mô phỏng Face ID thật được; dùng PC cho các phần khác:

| Việc | Ở đâu |
|---|---|
| Đăng ký / đăng nhập Face ID | **iPhone 14 Safari** (HTTPS) |
| OTP Telegram + luồng sau OTP | PC hoặc iPhone |
| Step-up không sinh trắc | PC: bật **Authenticator (TOTP)** trong Cài đặt |
| Kiểm tra WebAuthn API trên PC | Chrome DevTools → *Sensors / WebAuthn* → **Virtual authenticator** (test protocol, không phải Face ID) |

### Quy trình khuyến nghị (iPhone 14)

1. Bật `DEBUG_CLIENT_TRACE=true`, mở `login.html?debug=1` trên iPhone.  
2. Lần đầu: OTP Telegram → khi được mời, bấm **Dùng vân tay / Face ID** → nhìn Face ID.  
3. Lần sau: nút **Đăng nhập bằng vân tay / Face ID**.  
4. Gửi cho LLM output của `/api/debug/trace` nếu lỗi.

### PC không biometric

- Dùng **TOTP** (Google Authenticator / Microsoft Authenticator) cho unlock/step-up.  
- Hoặc Chrome **Virtual Authenticator** chỉ để verify code path WebAuthn.  
- **Không** kỳ vọng nút “Face ID” hoạt động trên laptop không có Windows Hello / Touch ID.

## Lưu ý bảo mật

Chỉ bật debug trên môi trường đang sửa lỗi. Tắt `DEBUG_CLIENT_TRACE` trên production ổn định. Không log OTP/credential thô (đã lọc).
