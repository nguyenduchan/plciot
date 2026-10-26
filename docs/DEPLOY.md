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
   - Service type **HTTP**, URL `mqtt:9002` (listener WebSocket có CONTROL; Cloudflare đã mã hoá TLS phía trước. Trước đây là `9001` — đổi sang `9002`, vì `9001` giờ là kênh không mã hoá chỉ xem)
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

## MQTT broker: mã hóa, cô lập topic, chống DDoS (VPS)

`cloud/docker-compose.vps.yml` đặt **HAProxy** trước Mosquitto; Mosquitto không publish cổng nào ra ngoài.

| Cổng | Giao thức | Mã hóa | Qua |
|---|---|---|---|
| 38417 | MQTT/TCP | không | HAProxy |
| 48263 | MQTTS | TLS 1.2+ (dùng chung chứng chỉ Let's Encrypt của Caddy, tự nạp lại khi gia hạn) | HAProxy |
| 36921 | ws:// | không | HAProxy |
| 443 | wss:// | TLS | Caddy → HAProxy:9002 |

Muốn chỉ cho phép mã hóa: xoá hai dòng publish `…:1883` và `…:9001` trong compose. Trình duyệt trên trang HTTPS bắt buộc dùng `wss://`; gateway dùng được `mqtts://…:48263` hoặc `wss://…:443`. Kết nối không mã hóa gửi user/mật khẩu dạng rõ — chỉ dùng trong LAN/thử nghiệm.

```bash
cd cloud && docker compose -f docker-compose.vps.yml up -d
./scripts/firewall-vps.sh                # tuỳ chọn: lưới SYN flood/giới hạn ở nhân (root)
```

### Chống user khác đọc topic
- Mosquitto `allow_anonymous false` + ACL mặc định từ chối. Mỗi user app (`u<id>`) chỉ có `read …/{telemetry,status,ack,history}` và `write …/cmd` của đúng `plc/<site>/<device>`; không wildcard, không `$SYS`, tên site/device được lọc ký tự `+ # /`.
- Subscribe `#`, `plc/#`, `plc/+/+/telemetry`… của user thường đều bị SUBACK 0x80; retained message cũng chịu ACL.
- Kiểm tra bằng 2 tài khoản thật: `node cloud/app/scripts/smoke-mqtt-security.js` (xem biến môi trường đầu file).
- Còn lại: `gw` là **một** credential chung cho mọi gateway (đọc `cmd` của mọi site). Nên tách thành user theo gateway khi có nhiều khách hàng. Clientid trùng sẽ đá phiên cũ: webapp dùng clientid ngẫu nhiên nên khó đoán.

### Chống DDoS theo kịch bản
| Kịch bản | Biện pháp |
|---|---|
| SYN flood | `tcp_syncookies` + hashlimit/connlimit ở `DOCKER-USER` (`firewall-vps.sh`) |
| Lũ kết nối đồng thời | HAProxy `MAX_CONN_PER_IP` (30), `maxconn` toàn cục, Mosquitto `max_connections` |
| Lũ kết nối mới / dò mật khẩu | `MAX_CONN_RATE` 60/phút/IP; vượt `BAN_CONN_RATE` 300/phút → khoá IP tới khi im lặng 10 phút |
| Slowloris / socket treo / không phải MQTT | phải gửi trọn gói CONNECT trong 5 s; `timeout client 90s`; WS: `timeout http-request 5s`; `max_keepalive 120` |
| Lũ handshake TLS (tốn CPU) | giới hạn theo IP trước handshake + `maxsslrate` 100/s |
| Gói lớn / băng thông | `max_packet_size 4096`; IP vượt `MAX_BYTES_10S` bị từ chối kết nối mới |
| Cạn RAM bằng hàng đợi/phiên | `max_queued_messages/bytes`, `max_inflight_*`, `persistent_client_expiration`, `allow_zero_length_clientid false`, `memory_limit` |
| NAT/CGNAT hoặc nhà máy nhiều gateway chung IP | thêm IP vào `cloud/config/trusted.lst` (bỏ qua giới hạn) hoặc tăng ngưỡng bằng biến môi trường |

Thử trên hệ thống của bạn: `python cloud/scripts/ddos-probe.py plc-mqtt.dieukhientudong.net --port 48263 --tls`.

**Giới hạn đã biết:** Mosquitto không giới hạn tốc độ publish của một kết nối *đã đăng nhập*; HAProxy chỉ chặn nó ở lần kết nối kế tiếp. Lũ băng thông lớn (volumetric) phải chặn ở nhà cung cấp VPS/CDN. Cấu hình này chưa chạy thử trên Docker trong phiên làm việc (máy dev không có Docker) — hãy chạy `docker compose config` và `ddos-probe.py` + `smoke-mqtt-security.js` sau khi deploy.

**Cổng ngẫu nhiên:** cổng ngoài (38417/48263/36921) đặt qua `PUB_PORT_MQTT/MQTTS/WS` trong `cloud/.env`; hãy thay bằng số riêng của bạn (cổng bên trong container giữ 1883/8883/9001). Việc này chỉ giảm nhiễu từ bot quét cổng mặc định — nó **không** thay cho xác thực/ACL, vì quét toàn dải cổng vẫn tìm ra. Đổi cổng thì phải sửa URL trong gateway (`MQTT_URI`) và `firewall-vps.sh` đọc cùng biến (`PUB_PORT_* ./scripts/firewall-vps.sh`). Cổng 443 (wss) giữ nguyên vì trình duyệt cần.

## Phân quyền người dùng

| Vai trò | Quyền |
|---|---|
| `admin` | Trang **Quản lý người dùng** (thêm, đổi vai trò/site/thiết bị, đặt lại mật khẩu, khoá, xoá) + điều khiển thiết bị của mình |
| `operator` | Xem + điều khiển (gửi lệnh `…/cmd`). Mặc định cho tài khoản cũ và tự đăng ký |
| `viewer` | Chỉ xem. **Broker không cấp `topic write …/cmd`** nên không thể điều khiển dù sửa app; webapp cũng khoá nút |

- **Bootstrap admin:** đặt `ADMIN_PHONES=0912345678` trong `cloud/.env` (số đã có tài khoản) rồi khởi động lại `app`. Sau đó vào *Cài đặt → Quản trị → Quản lý người dùng* (`/admin.html`).
- **Chia sẻ một PLC cho nhiều người:** khi thêm user, nhập đúng `site`/`thiết bị` đã có, chọn `viewer` cho người chỉ xem. Mỗi user vẫn có tài khoản MQTT riêng; ACL mỗi người chỉ gồm đúng `plc/<site>/<device>`.
- **Khoá/xoá/đổi site:** thu hồi JWT ngay (`token_version`), đổi mật khẩu MQTT và ghi lại ACL + SIGHUP Mosquitto. Kết nối MQTT đang mở có thể còn tới khi ngắt; quyền ghi `cmd` bị thu hồi ngay ở lần publish kế tiếp.
- **Đóng đăng ký tự do:** `REGISTRATION_OPEN=false` — chỉ admin tạo được tài khoản.
- Không thể tự hạ quyền/khoá/xoá chính mình hoặc admin cuối cùng. Mọi thao tác ghi vào `audit_log` (`admin_user_*`).
- Bundle webapp của người dùng cũ cần cập nhật để có nút *Quản trị* trong Cài đặt (tăng `version` hoặc seed lại); `/admin.html` truy cập trực tiếp được ngay.
- Kiểm thử offline: `node cloud/app/scripts/smoke-roles.js`.

## Monitor / Control theo kênh kết nối và theo người dùng

Mosquitto dùng `per_listener_settings true`, mỗi listener một file ACL:

| Listener (nội bộ) | Đường vào | Mã hoá | ACL | Người dùng làm được |
|---|---|---|---|---|
| `1883`, `9001` | `mqtt://`, `ws://` công khai | không | `acl-monitor` | **Chỉ monitor** (đọc) |
| `1884`, `9002` | `mqtts://` :8883, `wss://` :443, Cloudflare Tunnel | TLS | `acl` | Monitor + **control** nếu vai trò là `operator`/`admin` |

- Control = `topic write plc/<site>/<device>/cmd`. Dòng này chỉ được ghi vào `acl` (kênh mã hoá) và chỉ cho `operator`/`admin`; `acl-monitor` không bao giờ có. Người dùng đăng nhập bằng kênh không mã hoá sẽ xem được nhưng broker từ chối lệnh, dù sửa app.
- Gateway (`gw`) và `ingest` giống nhau ở hai file: gateway là thiết bị, cần đọc `cmd` và ghi telemetry ở cả hai kênh (nên dùng `mqtts`/`wss` để không lộ mật khẩu).
- **Không bao giờ** publish cổng `1884`/`9002` của Mosquitto ra Internet hay trỏ proxy không TLS vào đó — chúng tin rằng TLS đã được kết thúc phía trước.
- Webapp chỉ cho điều khiển khi URL MQTT là `wss://` (nút bị khoá và báo lý do nếu là `ws://`).

### Phạm vi monitor theo từng người dùng (admin cấu hình)
Mỗi người dùng có tập nhóm thông tin được đọc: `telemetry` (số liệu), `status` (online/offline), `ack` (phản hồi lệnh), `history` (lịch sử giờ do PLC gửi). Admin tích chọn trong *Quản lý người dùng*; mặc định là tất cả.
- Áp dụng ở broker (ACL `topic read …/<nhóm>`) **và** ở API lịch sử trên máy chủ (`/api/history/*` trả 403 hoặc lọc bớt nhóm không được phép).
- Người điều khiển (operator/admin trên kênh mã hoá) luôn đọc được `ack` để biết lệnh có được PLC thực hiện.
