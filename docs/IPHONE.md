# Cài app lên iPhone (PWA, không cần Mac, không cần tài khoản Apple Developer)

Yêu cầu: iPhone chạy iOS 16.4 trở lên, dùng **Safari** (Chrome trên iOS không cài được PWA đúng cách).

App dùng **HTTPS** qua Cloudflare Tunnel tới server trên PC của bạn. Sau khi đăng nhập, iPhone tải toàn bộ file webapp của user đó vào Cache Storage; lần sau có thể mở offline. Trang HTTPS chỉ kết nối được `wss://` tới broker.

## Bước 1 và 2. App server + broker lên HTTPS

Làm theo [DEPLOY.md](DEPLOY.md): tunnel `plc` → app `:3080`, `plc-mqtt` → Mosquitto `:9001`, seed user webapp.

- App: `https://plc.dieukhientudong.net`
- Broker: `wss://plc-mqtt.dieukhientudong.net`

## Bước 3. Cài lên màn hình chính iPhone

1. Mở **cùng bot Telegram với mqtt_server** (link trên trang login) → **/start** → chia sẻ số điện thoại (một lần là đủ cho cả hai hệ thống).
2. Mở **Safari**, vào `https://plc.dieukhientudong.net`.
3. Bấm **Chia sẻ** → **Thêm vào Màn hình chính** → **Thêm**.
4. Mở icon: **Đăng ký** (OTP Telegram) hoặc **Đăng nhập** (mật khẩu / OTP). Đợi tải xong bundle.
5. Từ lần sau: mở app offline vẫn được (MQTT cần mạng). Tin nhắn Telegram “đếm đủ” có link **Mở Giám sát PLC** — bấm để mở lại app.

Nút **Chạy thử không đăng nhập** chỉ xem UI demo, không gắn bundle server.

## Bước 4. Nối với PLC thật

Trong app: tab **Cài đặt**:
1. Tắt **Chạy thử**.
2. Broker WebSocket URL: `wss://plc-mqtt.dieukhientudong.net`.
3. Tài khoản MQTT: `app`. Mật khẩu: mật khẩu user `app` trên Mosquitto (khác mật khẩu đăng nhập webapp nếu bạn đặt khác).
4. Site và Thiết bị: **trùng** `SITE` và `DEVICE` trong `gateway/src/config.h` (mặc định `factory1` / `plc01`).
5. **Lưu & kết nối**.

Nhãn góc trên: `online` / `PLC mất liên lạc` / `offline`.

**Đăng xuất** (Cài đặt): xoá session; bundle đã tải vẫn nằm trên máy đến khi đăng nhập user khác (cache cũ bị dọn).

## Kiểm tra nhanh
- Airplane mode, mở app: giao diện vẫn lên nếu đã login và tải bundle trước đó.
- Tab **Băng tải**: thử Chạy/Dừng khi online.

## Cập nhật bản mới
Trên PC: cập nhật folder `cloud/app/data/bundles/<user>/` và **tăng `version`** (xem DEPLOY.md, lệnh `seed-user.js` với version mới). Mở app khi còn mạng → bị chuyển về đăng nhập → đăng nhập lại để tải bundle mới.

## Giới hạn của iOS cần biết
- App ra nền / khoá màn hình: iOS ngắt WebSocket; mở lại tự nối.
- Biểu đồ lịch sử chỉ ghi lúc app mở. Số đếm/thời gian chạy do PLC giữ.
- PWA đủ cho giám sát/điều khiển; app native (`.ipa`) cần Mac + Capacitor nếu muốn sau này.
