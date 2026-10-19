# Triển khai: domain Cloudflare + broker + app server trên PC của bạn

Domain: `dieukhientudong.net`. Webapp (login + bundle theo user) ở `plc.dieukhientudong.net`, broker ở `plc-mqtt.dieukhientudong.net` (`mqtt.` đang do dự án khác dùng).

```
iPhone ──HTTPS──> Cloudflare Tunnel ──> PC: plciot-app :3080
      │                                   (login/OTP Telegram, bundle theo user,
      │                                    MQTT→Telegram khi đếm đủ + link mở app)
      └─wss────> Cloudflare Tunnel ──> PC: Mosquitto :9001
Gateway ESP32 ──wss─────────────────────> Mosquitto
Telegram user ←── Bot API ←───────────── plciot-app (polling + sendMessage)
```

Không mở cổng router, không cần IP tĩnh, TLS do Cloudflare cấp. Sau này chuyển lên VPS: chạy lại `docker compose up -d` với cùng token tunnel.

## 1. Tunnel: hai hostname

1. one.dash.cloudflare.com → **Networks** → **Tunnels** → tunnel dự án (ví dụ `plc-broker`).
2. **Public hostname** (giữ MQTT):
   - Subdomain `plc-mqtt`, Domain `dieukhientudong.net`
   - Service type **HTTP**, URL `mqtt:9001` (tên service Docker trong compose)
3. **Thêm Public hostname** cho webapp:
   - Subdomain `plc`, Domain `dieukhientudong.net`
   - Service type **HTTP**, URL `app:3080`
4. Copy **TUNNEL_TOKEN** vào `cloud/.env` (xem dưới).

Nếu trước đây `plc.dieukhientudong.net` trỏ Cloudflare Pages: xoá custom domain Pages hoặc đổi DNS về tunnel (CNAME do Zero Trust quản lý).

## 2. Chạy stack trên PC (Docker Desktop)

Stack tách biệt: project `plciot`, container `plciot-mqtt` / `plciot-app` / `plciot-tunnel`, network `plciot_net`, cổng loopback `127.0.0.1:21883` (MQTT), `127.0.0.1:29001` (WS), `127.0.0.1:3080` (app).

```powershell
cd C:\workspace\embedded\plciot\cloud
copy .env.example .env
# .env: TUNNEL_TOKEN, APP_JWT_SECRET, MQTT_NOTIFY_PASS (= mật khẩu user MQTT app),
#       TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, WEBAPP_PUBLIC_URL

# User Mosquitto (MQTT): gw=gateway, app=điện thoại (có quyền cmd), ingest=server chỉ đọc
docker run --rm -v "${PWD}/config:/mosquitto/config" eclipse-mosquitto:2 sh -c "touch /mosquitto/config/passwd && mosquitto_passwd -b /mosquitto/config/passwd gw MATKHAU_GW && mosquitto_passwd -b /mosquitto/config/passwd app MATKHAU_APP && mosquitto_passwd -b /mosquitto/config/passwd ingest MATKHAU_INGEST"

docker compose up -d --build
docker compose logs -f tunnel   # "Registered tunnel connection"
```

### Telegram — dùng chung bot với `mqtt_server`

**Một bot chỉ được một process long-polling.** Giữ `telegram_bot` của `D:\Project\mqtt_server` chạy như hiện tại; plciot **không** poll.

| Vai trò | Ai làm |
|---|---|
| `/start` + chia sẻ SĐT → `telegram_users` | `mqtt_server` container `telegram_bot` |
| Gửi OTP / tin “đếm đủ” (`sendMessage`) | `plciot-app` (cùng `TELEGRAM_BOT_TOKEN`) |
| Tra `phone → chat_id` | plciot đọc Postgres `telegram_users` của mqtt_server |

1. Copy cùng `TELEGRAM_BOT_TOKEN` (và username bot) từ `mqtt_server/.env` sang `cloud/.env`.
2. `TELEGRAM_BOT_POLLING=false` (mặc định).
3. Kết nối DB chung (map cổng `5432` của `scada_db` đã có trong mqtt_server compose):

```env
TELEGRAM_SHARED_PG_HOST=host.docker.internal
TELEGRAM_SHARED_PG_PORT=5432
TELEGRAM_SHARED_PG_USER=...   # = POSTGRES_USER mqtt_server
TELEGRAM_SHARED_PG_PASSWORD=...
TELEGRAM_SHARED_PG_DB=iot_postgres
TELEGRAM_BOT_USERNAME=TenBot
WEBAPP_PUBLIC_URL=https://plc.dieukhientudong.net
MQTT_NOTIFY_PASS=<mật khẩu MQTT user app>
```

4. User đã `/start` + chia sẻ SĐT trên bot mqtt_server → đăng ký/OTP trên webapp PLC dùng luôn liên kết đó.
5. Khi PLC `D8` → **2** (đếm đủ), plciot gửi Telegram + link mở webapp. Tuỳ chọn `TELEGRAM_NOTIFY_CHAT_IDS`.

Chỉ bật `TELEGRAM_BOT_POLLING=true` khi **tắt** bot mqtt_server (không chạy song song).

### Lưu lịch sử MQTT trên server (offline khi mở app)

`plciot-app` ghi mọi topic `plc/<site>/<device>/*` vào SQLite (`mqtt_events`), mặc định **3 ngày** (`HISTORY_DEFAULT_DAYS`); gói cao hơn đặt riêng từng tài khoản (≥ 4 ngày hoặc không giới hạn, xem `docs/ACCOUNT-RECOVERY.md`/`scripts/plan.js`).

```env
MQTT_INGEST=true
MQTT_NOTIFY_PASS=<mật khẩu user MQTT app>
HISTORY_DEFAULT_DAYS=3
# MQTT_INGEST_MIN_MS=10000   # tuỳ chọn: chỉ ghi telemetry tối đa mỗi 10s
```

Webapp đã login: khi mở (và khi trở lại foreground) gọi `/api/history/telemetry` → ghi IndexedDB → biểu đồ/báo cáo dùng được offline. Live vẫn MQTT trực tiếp. History chỉ trả `site`/`dev` trùng `notify_site`/`notify_device` của user (trừ `HISTORY_OPEN_ACCESS=true`).

### Bảo mật app (đã có trong code)
- Rate limit login/OTP; CORS theo `CORS_ORIGINS` / `WEBAPP_PUBLIC_URL`
- Header cơ bản (`X-Frame-Options`, …); `/api/health` chỉ `{ok:true}`
- Broker: **Eclipse Mosquitto 2** (C, không phải framework Node). Chống DDoS chính: **Cloudflare Tunnel** + bind localhost

### Định danh user = SĐT Việt Nam ↔ Telegram
- **Username** lưu dạng chuẩn `84xxxxxxxxx` (11 số); nhập `09…` cũng được, server đổi sang `84…`.
- **Bắt buộc** đã chia sẻ đúng SĐT đó với bot Telegram (mqtt_server hoặc bot plciot) trước khi nhận OTP.
- Đăng ký/đăng nhập OTP gửi về `chat_id` tra theo SĐT; mỗi lần OTP login có thể làm mới `users.chat_id` từ DB Telegram chung.
- Seed: `seed-user.js 0987654321 MATKHAU factory1 plc01`

### Cách ly multi-tenant (chống user A đọc/ghi PLC của B)
- **HTTP history**: luôn theo `notify_site`/`notify_device` của JWT user (query `site`/`dev` không đổi được tenant).
- **Bundle**: chỉ folder của user đăng nhập.
- **MQTT**: mỗi user có `mqtt_user`/`mqtt_pass` riêng; ACL chỉ `plc/<site>/<device>/{telemetry,status,ack,history,cmd}`. Không còn user `app` wildcard trên ACL.
- Đăng ký tự gán `site=s<phone>`, `device=plc01`. Seed: `seed-user.js <user> <pass> <site> <device>`.
- Gateway khách phải dùng đúng `SITE`/`DEVICE` đã cấp.
- Sau seed/register, app ghi `config/acl` + `passwd` và `SIGHUP` Mosquitto (cần docker.sock hoặc chạy `docker kill -s HUP plciot-mqtt`).

### Tạo user webapp thủ công (không qua Telegram)

Mỗi user có thư mục `cloud/app/data/bundles/<folder>/`. SQLite lưu `username` → `folder_path` + `version`.

```powershell
# Trong container (WEBAPP_SRC đã mount từ ../webapp)
docker compose exec app node scripts/seed-user.js 84987654321 MATKHAU factory1 1
```

Hoặc trên máy host (đã `npm install` trong `cloud/app`):

```powershell
cd C:\workspace\embedded\plciot\cloud\app
$env:DATA_DIR="$PWD\data"
$env:WEBAPP_SRC="$PWD\..\..\webapp"
node scripts/seed-user.js alice MATKHAU_ALICE factory1 1
```

Kiểm tra nhanh API:

```powershell
curl http://127.0.0.1:3080/api/health
# Đăng nhập: POST http://127.0.0.1:3080/api/login  {"username":"alice","password":"..."}
```

Mở `https://plc.dieukhientudong.net` → form đăng nhập → sau khi tải xong bundle, app chạy từ Cache Storage (offline được).

### Cập nhật source của một user

1. Sửa file trong `cloud/app/data/bundles/<folder>/` (hoặc seed lại từ `webapp/`).
2. Tăng `version` (seed lại với version mới, hoặc SQL):

```powershell
docker compose exec app node scripts/seed-user.js alice MATKHAU_ALICE factory1 2
```

3. User mở app khi còn mạng: `boot.js` / login phát hiện version mới → yêu cầu đăng nhập lại để tải bundle.

### Giữ PC ổn định

- Docker Desktop → Start when you sign in.
- Sleep = Never khi cắm điện.
- `restart: unless-stopped` đã bật.

## 3. Gateway

Sửa `gateway/src/config.h`:
```c
#define MQTT_URI   "wss://plc-mqtt.dieukhientudong.net:443/mqtt"
#define MQTT_USER  "gw"
#define MQTT_PASS  "MATKHAU_GW"
```
Nạp lại firmware. Thử broker:

```powershell
docker exec plciot-mqtt mosquitto_sub -h localhost -u app -P MATKHAU_APP -t "plc/#" -v
```

## 4. iPhone

Làm theo [IPHONE.md](IPHONE.md):
- Cài PWA từ `https://plc.dieukhientudong.net` (màn hình đăng nhập)
- MQTT trong Cài đặt: `wss://plc-mqtt.dieukhientudong.net`, user Mosquitto `app`

## Bảo mật

- `APP_JWT_SECRET`, mật khẩu webapp user, mật khẩu MQTT `gw`/`app` đều dài và khác nhau. Không commit `cloud/.env`, `cloud/config/passwd`, `cloud/app/data/app.db`.
- ACL MQTT trong `cloud/config/acl` không đổi: `app` chỉ ghi `cmd`, `gw` ghi telemetry/status/ack.
- Mất điện thoại: đổi mật khẩu user webapp (seed lại) và/hoặc MQTT `app`; JWT cũ hết hạn tối đa 7 ngày.
- Lệnh điều khiển từ internet vẫn qua whitelist gateway; E-stop nằm trong PLC.
