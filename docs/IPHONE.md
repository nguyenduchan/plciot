# Cài app lên iPhone (PWA, không cần Mac, không cần tài khoản Apple Developer)

Yêu cầu: iPhone chạy iOS 16.4 trở lên, dùng **Safari** (Chrome trên iOS không cài được PWA đúng cách).

Webapp là file tĩnh. iOS chỉ cho cài và chạy offline khi file được tải qua **HTTPS** một lần, nên cần đặt thư mục `webapp/` lên một host tĩnh miễn phí. Trang HTTPS cũng chỉ kết nối được `wss://`, không phải `ws://`. Host này không xử lý dữ liệu gì, mật khẩu broker chỉ nhập và lưu trên điện thoại.

## Bước 1 và 2. Đưa app và broker lên HTTPS

Với domain Cloudflare của bạn, làm theo [DEPLOY.md](DEPLOY.md) (app ở `https://plc.dieukhientudong.net`, broker ở `wss://plc-mqtt.dieukhientudong.net`).
Nếu chưa có domain, tạm dùng Netlify Drop (https://app.netlify.com/drop, kéo thả thư mục `webapp`) và `cloudflared tunnel --url http://localhost:9001` (cho địa chỉ `wss://xxxx.trycloudflare.com` đổi mỗi lần chạy).

## Bước 3. Cài lên màn hình chính iPhone

1. Mở **Safari**, vào địa chỉ ở Bước 1.
2. Bấm nút **Chia sẻ** (hình vuông có mũi tên lên) → kéo xuống chọn **Thêm vào Màn hình chính** → **Thêm**.
3. Đóng Safari, mở app **PLC** từ màn hình chính. Lần đầu mở khi còn mạng để app tải xong file; từ lần sau chạy được cả khi không có mạng.

App mở ra ở chế độ **demo** (dữ liệu giả), đủ để xem giao diện.

## Bước 4. Nối với PLC thật

Trong app: tab **Cài đặt**:
1. Tắt **Chế độ demo**.
2. Broker WebSocket URL: địa chỉ `wss://...` ở Bước 2.
3. Tài khoản: `app`. Mật khẩu: mật khẩu bạn đặt cho user `app` khi tạo broker.
4. Site và Thiết bị: **trùng** `SITE` và `DEVICE` trong `gateway/src/config.h` (mặc định `factory1` / `plc01`).
5. Tên đầu vào/ra: tuỳ chọn, ví dụ đầu vào `Estop,Mức thấp,Mức cao,Cảm biến SP,,,,` đầu ra `Bơm,Băng tải,,,,,,`.
6. **Lưu & kết nối**.

Nhãn ở góc trên phải: `online` (xanh) là đã thông, `PLC mất liên lạc` là gateway còn nhưng PLC không trả lời (kiểm tra dây RS485, số trạm, baud), `offline` là chưa tới broker hoặc gateway.

## Kiểm tra nhanh
- Airplane mode, mở app: giao diện vẫn lên (dữ liệu không cập nhật được, nhãn `offline`).
- Tab **Băng tải**: bấm Chạy, nghe/ thấy Y1 đóng; chạy tới số lượng mục tiêu thì dừng.

## Cập nhật bản mới
Upload lại thư mục `webapp/` (Cloudflare Pages: Create deployment). Trong `webapp/sw.js` đổi `CACHE = 'plc-v3'` thành `plc-v4` để iPhone nhận bản mới. Mở app 2 lần (lần đầu tải ngầm, lần hai dùng bản mới). Nếu vẫn cũ: xoá icon và Thêm vào Màn hình chính lại.

## Giới hạn của iOS cần biết
- Khi app ra nền hoặc khoá màn hình, iOS ngắt kết nối WebSocket. Mở lại app là tự nối lại, dữ liệu retained từ broker hiện ngay. Không có thông báo đẩy.
- Biểu đồ lịch sử chỉ ghi lúc app đang mở. Số đếm/thời gian chạy tổng do PLC giữ nên không mất.
- Nếu muốn app native thật (file `.ipa`, App Store/TestFlight) thì cần máy Mac + Xcode + Capacitor và tài khoản Apple Developer; PWA ở trên đã đủ cho điều khiển và giám sát.
