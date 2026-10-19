# Triển khai: domain Cloudflare + broker chạy trên PC của bạn

Domain: `dieukhientudong.net`. Webapp ở `plc.dieukhientudong.net`, broker ở `plc-mqtt.dieukhientudong.net` (`mqtt.` đang do dự án khác dùng).

```
iPhone/PC (webapp chạy từ file đã cache) ──wss──┐
                                                ├─> Cloudflare ──tunnel──> PC của bạn: cloudflared -> Mosquitto :9001
Gateway ESP32 tại nhà máy ───────────wss────────┘
plc.dieukhientudong.net : chỉ là file tĩnh trên Cloudflare Pages (không có server, không tốn tiền vận hành)
plc-mqtt.dieukhientudong.net: đường vào broker
```

Không mở cổng router, không cần IP tĩnh, TLS do Cloudflare cấp. Sau này chuyển broker lên VPS: chạy lại đúng `docker compose up -d` với cùng token tunnel, điện thoại và gateway không phải sửa gì.

## 1. Webapp lên `plc.dieukhientudong.net` (Cloudflare Pages)

1. dash.cloudflare.com → **Workers & Pages** → **Create** → tab **Pages** → **Upload assets**.
2. Đặt tên project (ví dụ `plc-app`) → **Create project** → kéo thả thư mục `C:\workspace\embedded\plciot\webapp` → **Deploy**.
3. Vào project → **Custom domains** → **Set up a custom domain** → nhập `plc.dieukhientudong.net` → Cloudflare tự thêm bản ghi DNS.
4. Cập nhật bản mới: **Create deployment** và upload lại thư mục. Nhớ tăng `CACHE` trong `webapp/sw.js` (`plc-v3` → `plc-v4`).

## 2. Broker + tunnel trên PC

### 2.1 Tạo tunnel trên Cloudflare
1. one.dash.cloudflare.com → **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared** → tên `plc-broker`.
2. Ở màn hình chọn hệ điều hành, **chỉ cần copy phần token** (chuỗi dài sau `--token` hoặc `service install`). Không cần cài cloudflared trên Windows, vì docker sẽ chạy nó.
3. Bước **Public hostname**: Subdomain `plc-mqtt`, Domain `dieukhientudong.net`, Service type **HTTP**, URL `mqtt:9001`. Lưu.
   (WebSocket được Cloudflare hỗ trợ mặc định, không cần bật thêm.)

### 2.2 Chạy trên PC (Docker Desktop đã có)

Stack này **tách biệt hoàn toàn** khỏi các dự án Docker khác trên máy (ví dụ `mqtt_server` với EMQX/ThingsBoard): project `plciot`, container `plciot-mqtt` và `plciot-tunnel`, network `plciot_net`, volume `plciot_mqtt_data`, cổng host chỉ trên loopback `127.0.0.1:21883` (MQTT) và `127.0.0.1:29001` (WebSocket). Tunnel Cloudflare cũng là tunnel **riêng mới** cho dự án này, không dùng chung tunnel của dự án cũ. Dừng/xoá dự án này không ảnh hưởng dự án kia: `docker compose -p plciot down`.
```powershell
cd C:\workspace\embedded\plciot\cloud
copy .env.example .env          # mở .env, dán TUNNEL_TOKEN=...

# tạo user (đổi mật khẩu của bạn, dùng mật khẩu dài, ngẫu nhiên)
docker run --rm -v "${PWD}/config:/mosquitto/config" eclipse-mosquitto:2 sh -c "touch /mosquitto/config/passwd && mosquitto_passwd -b /mosquitto/config/passwd gw MATKHAU_GW && mosquitto_passwd -b /mosquitto/config/passwd app MATKHAU_APP"

docker compose up -d
docker compose logs -f tunnel   # thấy "Registered tunnel connection" là thông
```
Kiểm tra: Cloudflare Tunnels hiện trạng thái **Healthy**. Mở `https://plc-mqtt.dieukhientudong.net` bằng trình duyệt sẽ báo lỗi `Upgrade Required` hoặc tương tự, đó là bình thường (broker chỉ nói WebSocket).

### 2.3 Giữ PC chạy ổn định (vì PC đang làm server)
- Docker Desktop → Settings → General → **Start Docker Desktop when you sign in**.
- Windows → Power & sleep → Sleep = **Never** (khi cắm điện).
- `restart: unless-stopped` trong compose đã tự khởi động lại container sau khi bật máy.
- PC tắt/ngủ thì app và gateway mất kết nối; gateway tự nối lại, PLC vẫn chạy độc lập.

## 3. Gateway

Sửa `gateway/src/config.h`:
```c
#define MQTT_URI   "wss://plc-mqtt.dieukhientudong.net:443/mqtt"
#define MQTT_USER  "gw"
#define MQTT_PASS  "MATKHAU_GW"
```
Nạp lại firmware. Gateway cần ra internet qua cổng 443 (mạng nhà máy thường cho phép). Kiểm tra thấy `online`: `docker compose logs mqtt` hiện kết nối của `gw-plc01`.

Thử riêng broker từ PC (không cần gateway), chạy ngay trong container của stack này:
```powershell
docker exec plciot-mqtt mosquitto_sub -h localhost -u app -P MATKHAU_APP -t "plc/#" -v
```

## 4. iPhone

Làm theo [IPHONE.md](IPHONE.md), Bước 3 và 4, với:
- Địa chỉ cài app: `https://plc.dieukhientudong.net`
- Broker WebSocket URL trong app: `wss://plc-mqtt.dieukhientudong.net`
- Tài khoản `app` + mật khẩu `MATKHAU_APP`

## Bảo mật cần làm
- Mật khẩu `gw` và `app` dài và khác nhau. Quyền theo topic nằm trong `cloud/config/acl`: `app` chỉ ghi được `cmd`, `gw` chỉ ghi được `telemetry/status/ack`.
- Lệnh điều khiển từ internet đi thẳng xuống PLC: chỉ whitelist D3, D4, D6, D7, D9 trong gateway; E-stop và khoá liên động nằm trong PLC. Không đấu thiết bị nguy hiểm vào đầu ra điều khiển được từ xa khi chưa có người giám sát.
- Mất điện thoại: đổi mật khẩu user `app` (chạy lại lệnh `mosquitto_passwd` rồi `docker compose restart mqtt`).
- Chạy lại lệnh `mosquitto_passwd -b` với cùng tên user sẽ đổi mật khẩu. File `config/passwd` và `.env` không được commit lên git.
