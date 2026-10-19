# Đặt máy chủ MQTT tại Việt Nam

## Vì sao
Hiện nay dữ liệu đi: điện thoại (VN) → Cloudflare **Hong Kong** → tunnel → PC. Đo thực tế: khoảng **57 ms** mỗi lượt lệnh, chỉ riêng việc đi vòng qua Hong Kong.
Đặt broker trên VPS tại Việt Nam và nối thẳng (không qua Cloudflare proxy): điện thoại → VPS, thường **5–20 ms** nếu cùng nhà mạng lớn trong nước. Gateway tại nhà máy cũng nối thẳng vào cùng máy chủ đó.

Phần giao diện (file tĩnh) vẫn để trên Cloudflare: chỉ tải lần đầu, sau đó chạy từ bộ nhớ đệm trên máy người dùng nên không ảnh hưởng độ trễ điều khiển.

## 1. Chọn VPS
Cấu hình đủ dùng: **1 vCPU, 512 MB–1 GB RAM, 10 GB ổ đĩa**, Ubuntu 22.04/24.04, có **IPv4 công cộng**, đặt tại Việt Nam.
Một số nhà cung cấp trong nước: Viettel IDC / Viettel Cloud, VNPT Cloud, FPT Cloud, BizFly Cloud, Vietnix, Nhân Hòa. Chọn gói rẻ nhất cùng khu vực với nhà máy; hỏi nhà cung cấp cổng **80 và 443 có mở** (một số gói yêu cầu đăng ký).

## 2. Chuẩn bị máy chủ (SSH vào VPS)
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 ufw
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```
Không mở cổng 1883 hay 9001: Mosquitto chỉ nói chuyện với Caddy trong mạng nội bộ Docker.

## 3. Chép cấu hình lên VPS (chạy trên PC Windows)
Thay `IP_VPS` bằng địa chỉ IP của VPS. Không chép `.env` (token tunnel cũ không cần nữa).
```powershell
cd C:\workspace\embedded\plciot
ssh root@IP_VPS "mkdir -p /opt/plciot/config"
scp cloud\docker-compose.vps.yml cloud\Caddyfile root@IP_VPS:/opt/plciot/
scp cloud\config\mosquitto.conf cloud\config\acl cloud\config\passwd root@IP_VPS:/opt/plciot/config/
```
File `passwd` chứa mật khẩu đã băm của `gw` và `app`, giữ nguyên nên không phải đổi gì ở app và gateway.

Trên VPS, chạy với quyền đúng cho Mosquitto rồi khởi động:
```bash
cd /opt/plciot
sudo chown 1883:1883 config/passwd && sudo chmod 600 config/passwd
docker compose -f docker-compose.vps.yml up -d mqtt
```
(Chưa bật Caddy; Caddy cần DNS trỏ về VPS trước, xem bước 4.)

## 4. Đổi DNS sang VPS (trên Cloudflare)
Làm theo đúng thứ tự để gián đoạn ngắn nhất (vài chục giây):

1. Vào https://dash.cloudflare.com → domain `dieukhientudong.net` → **DNS** → **Records**.
2. Tìm bản ghi `plc-mqtt` (loại CNAME, trỏ vào `…cfargotunnel.com`) và **xoá**.
3. **Add record**: Type `A`, Name `plc-mqtt`, IPv4 address `IP_VPS`, **Proxy status = DNS only** (đám mây xám, không phải cam). Save.
4. Trên VPS bật Caddy, nó tự xin chứng chỉ Let's Encrypt (khoảng 10–30 giây):
   ```bash
   docker compose -f docker-compose.vps.yml up -d caddy
   docker logs plciot-caddy 2>&1 | tail -5     # thấy "certificate obtained successfully"
   ```
5. Trên PC Windows, tắt stack cũ (nếu muốn dùng PC làm việc khác):
   ```powershell
   cd C:\workspace\embedded\plciot\cloud; docker compose -p plciot down
   ```
   Có thể xoá tunnel `plc-broker` trong Cloudflare sau khi mọi thứ ổn.

Gateway và app **không cần sửa gì**, vì vẫn dùng `wss://plc-mqtt.dieukhientudong.net`. Chúng tự nối lại sau khi DNS đổi (có thể đến vài phút do bộ nhớ đệm DNS).

## 5. Kiểm tra
```powershell
python -c "import socket,time;t=time.time();s=socket.create_connection(('plc-mqtt.dieukhientudong.net',443),timeout=10);print('TCP %.0f ms'%((time.time()-t)*1000))"
```
Kết quả mong đợi từ mạng trong nước: **dưới 30 ms** (trước đây ~147 ms). Mở app, nhãn phải là **Trực tuyến**.

## Hoàn tác
Xoá bản ghi `A` `plc-mqtt`, vào tunnel `plc-broker` → Routes → Add route lại `plc-mqtt.dieukhientudong.net` → `http://mqtt:9001`, rồi `docker compose -p plciot up -d` trên PC.

## Chi phí vận hành
Mosquitto + Caddy cùng chiếm chừng 20–30 MB RAM và gần 0% CPU, nên VPS nhỏ nhất là đủ. Cập nhật ứng dụng không cần chạm VPS: chỉ upload lại thư mục `webapp/`.
