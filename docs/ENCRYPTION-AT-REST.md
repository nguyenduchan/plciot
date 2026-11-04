# Mã hoá dữ liệu nghỉ (at-rest)

## Tầng ứng dụng (đã có trong code)

| Dữ liệu | Cách bảo vệ |
|---|---|
| Mật khẩu đăng nhập | bcrypt |
| Mã khôi phục | HMAC-SHA256 |
| TOTP secret / claim sticker secret | AES-256-GCM (`sealSecret`) |
| `users.mqtt_pass` | AES-256-GCM (`sealMqttPass`) — plaintext cũ được mở và reseal khi provision |
| Token phiên điều khiển | lưu hash |

Khoá dẫn xuất từ `APP_JWT_SECRET`. Đổi secret → dữ liệu seal cũ không mở được (cần rotate/provision lại).

## Tầng hạ tầng (bắt buộc vận hành)

SQLite `app.db` **không** phải SQLCipher full-DB. Để đạt yêu cầu mã hoá nghỉ trên đám mây / VPS:

1. **Mã hoá ổ / volume:** LUKS (Linux), BitLocker (Windows), encrypted disk cloud (ví dụ volume encrypted của nhà cung cấp VN).
2. **Quyền file:** `DATA_DIR` chỉ user chạy app; không share NFS plaintext.
3. **Backup:** mã hoá bản sao (`age`/`gpg`/snapshot encrypted); khoá backup tách khỏi máy app.
4. **Bộ nhớ tạm:** hạn chế copy `app.db` ra máy laptop không mã hoá.

## Kiểm tra nhanh

```bash
# Sau provision, mqtt_pass phải bắt đầu bằng v1.
sqlite3 data/app.db "SELECT substr(mqtt_pass,1,3) FROM users WHERE mqtt_user IS NOT NULL LIMIT 5;"
```
