# Quản lý gói đăng ký (không thanh toán online)

**Không tích hợp cổng thanh toán / ví điện tử / tự động trừ tiền** — tránh vướng quy định kinh doanh dịch vụ trung gian thanh toán.  
Thu tiền bằng chuyển khoản / hóa đơn ngoài hệ thống → bạn **cấp tay** quyền trên VPS.

## 1. Mô hình vận hành kín

Webapp điện thoại **cũng subscribe trên cloud** giống thiết bị/partner. **`SUBSCRIBE_AUTO_GRANT=false`** (mặc định): đăng ký → trạng thái chờ → bạn kích hoạt tay (`monitor`/`pro`/…) trên Console hoặc `plan.js`. Không nạp tiền trong app.

Kích hoạt từ Internet an toàn: [ADMIN-REMOTE.md](ADMIN-REMOTE.md) (SSH tunnel / Cloudflare Access / `ADMIN_OPS_ALLOW_CIDRS`).

```
Khách chuyển khoản (ngoài app)  — tuỳ chọn
        │
Bạn (SSH / CF Access / IP allow → Console hoặc plan.js)
        │  grant pro …
        ▼
SQLite trên máy chủ  →  webapp + thiết bị đọc cùng quyền
```

| Làm ở đâu | Việc |
|---|---|
| **VPS / PC (khuyến nghị)** | SSH + `docker exec` chạy `plan.js` — không mở UI thanh toán |
| **Cloudflare** | Chỉ DNS + WAF + (tuỳ chọn) **Access** chặn `/api/admin` — **không** dùng CF để “bán gói” |
| App / webapp | Chỉ hiển thị trạng thái gói (`/api/me` → `subscription`) |

## 2. Các gói sẵn có

| Mã | Ý nghĩa | Điều khiển từ xa | Lưu lịch sử |
|---|---|---|---|
| `monitor` | Chỉ xem | Tắt | mặc định (3 ngày) |
| `pro` | Xem + điều khiển | Bật | 30 ngày |
| `factory` | Nhà máy / partner API | Bật | không giới hạn |

```bash
# Trong container app (DATA_DIR=/app/data)
docker exec -it plciot-app node scripts/plan.js catalog
docker exec -it plciot-app node scripts/plan.js list
docker exec -it plciot-app node scripts/plan.js grant 0901234567 pro 2027-01-01
docker exec -it plciot-app node scripts/plan.js revoke-control 0901234567   # khách hết hạn / chỉ giám sát
docker exec -it plciot-app node scripts/plan.js tenant acme factory 2027-01-01
```

Ghi chú sổ tay (Excel/Notion): SĐT, ngày nhận tiền, mã GD, lệnh `grant` đã chạy. Không cần lưu trong app.

## 3. Siết điều khiển từ Internet (kín đáo / giảm tấn công)

Mặc định khuyến nghị trên VPS production:

```env
# .env trên VPS
REGISTRATION_OPEN=false          # chỉ admin thêm user
PARTNER_CMD_ENABLED=false        # tắt REST cmd qua Internet
CONTROL_FROM_INTERNET=false      # lệnh ghi chỉ từ IP xưởng
CONTROL_LAN_CIDRS=203.0.113.0/24 # IP công cộng nhà máy (cập nhật đúng)
CONTROL_VIA_SERVER=true          # luôn qua app server + Passkey/TOTP
CONTROL_PHYSICAL_BIT=5           # (tuỳ chọn) nút vật lý cho lệnh nguy hiểm
```

Hệ quả:

| Kênh | Monitor (xem) | Control (ghi) |
|---|---|---|
| Điện thoại 4G/Wifi nhà | Có (MQTTS/WSS đọc) | **Chặn** nếu `CONTROL_FROM_INTERNET=false` |
| PC / điện thoại trong IP xưởng | Có | Có (Passkey/TOTP + gói `pro`/`factory`) |
| Partner REST `/cmd` | — | Tắt trừ khi bật `PARTNER_CMD_ENABLED` **và** IP LAN |
| SCADA local (`edge/` / `scada/`) | Trong LAN nhà máy | Không phụ thuộc Internet |

**An toàn vật lý vẫn nằm trong PLC** (E-stop, liên động) — mạng chỉ là lớp thêm.

## 4. Cloudflare — dùng gì / không dùng gì

**Nên**

- Proxy cam cho **HTTPS webapp** (`plc.…`) → WAF, bot fight, rate limit  
- DNS only (xám) cho **MQTTS** nếu đặt broker VPS VN (độ trễ thấp, xem `MAY-CHU-VIET-NAM.md`)  
- **Cloudflare Access** (Zero Trust) bảo vệ đường quản trị nếu lỡ expose:  
  - Application → hostname `plc.…`  
  - Policy: chỉ email của bạn  
  - Path: `/api/admin*` (và tuỳ chọn `/admin*`)  
- Giữ tunnel / origin chỉ nhận từ Cloudflare hoặc firewall VPS chỉ 80/443/22

**Không nên**

- Cloudflare Workers / Pages làm cổng thanh toán  
- Expose Mosquitto 1883 ra Internet  
- Mở UI “mua gói” công khai  

Admin gói: **SSH vào VPS** là kênh chính (ed25519, tắt password, fail2ban).

## 5. Checklist triển khai kín

1. `REGISTRATION_OPEN=false`, bootstrap `ADMIN_PHONES=`  
2. `CONTROL_FROM_INTERNET=false` + `CONTROL_LAN_CIDRS=` đúng IP xưởng  
3. `PARTNER_CMD_ENABLED=false`  
4. Firewall VPS: chỉ 22, 80, 443 (và cổng MQTTS nếu dùng HAProxy công khai)  
5. Cấp gói bằng `plan.js` sau khi nhận tiền ngoài hệ thống  
6. Hết hạn: `grant … monitor` hoặc `revoke-control`  
7. (Tuỳ chọn) Cloudflare Access cho `/api/admin*`  

## 6. API chỉ đọc trạng thái

`GET /api/me` → `subscription: { plan, active, expiresAt, remoteControl, retentionDays }`  
Không có API công khai tự nâng gói / thanh toán.
