# Giao thức

## 1. Modbus RTU (Gateway ⇄ PLC Xinje XD3-16T-E)

Gateway là master, PLC là slave. Địa chỉ Modbus holding register = số thanh ghi D (D0 → 0).
Chỉ dùng FC03 (đọc) và FC06 (ghi một thanh ghi). Cài đặt cổng nối tiếp (COM2 RS485) trong XDPPro:
Modbus slave, số trạm 1, baud/parity trùng `gateway/src/config.h` (mặc định 19200 8E1).

| Thanh ghi | Nội dung | R/W |
|---|---|---|
| D0 | bitmask đầu vào X0..X7 | R |
| D1 | bitmask đầu ra Y0..Y7 | R |
| D2 | cảnh báo: bit0 E-stop, bit1 lỗi cảm biến mức | R |
| D3 | chế độ: 0 tự động, 1 thủ công | R/W |
| D4 | mặt nạ đầu ra khi thủ công (bit n → Yn, Y7 là đèn báo) | R/W |
| D6 | yêu cầu băng tải: 0 dừng, 1 chạy (Y1) | R/W |
| D7 | số lượng mục tiêu, 0 = không giới hạn; PLC tự dừng khi đủ | R/W |
| D8 | trạng thái băng tải: 0 dừng, 1 chạy, 2 đủ số lượng, 3 E-stop | R |
| D9 | ghi 1 = xoá số đếm hiện tại (PLC tự về 0) | W |
| D14–D15 | số đếm hiện tại, 32 bit (cảm biến X3, cạnh lên) | R |
| D16–D17 | tổng số đếm từ đầu, không bao giờ xoá | R |
| D10–D11 | thời gian chạy PLC, giây (32 bit, D10 thấp) | R |
| D12–D13 | số lần khởi động bơm Y0 | R |
| D100 | số sản phẩm đếm trong giờ hiện tại | R |
| D101–D148 | số sản phẩm 48 giờ trước (D101 = giờ liền trước) | R |
| D149 | số giây đã trôi qua trong giờ hiện tại | R |
| D150 | bộ đếm số lần sang giờ mới | R |
| D199 | số giây băng tải chạy trong giờ hiện tại | R |
| D200–D248 | số phút băng tải chạy mỗi giờ (D201 = giờ liền trước) | R |
| D20 + 2n | thời gian chạy của Yn, giây (32 bit) | R |

Gateway chỉ cho ghi D3, D4, D6, D7, D9 (`WRITABLE` trong config.h).

Băng tải: Y1 do khối băng tải điều khiển ở cả hai chế độ (bit Y1 của D4 bị bỏ qua). Dừng ngay trong cùng chu kỳ quét khi đếm đủ D7 hoặc khi E-stop; việc dừng không phụ thuộc mạng. Cảm biến cần xung đủ rộng so với thời gian quét PLC (X3 là ngõ vào thường; nếu băng tải nhanh, dùng ngõ vào tốc độ cao của XD3 thay cho đếm bằng scan).

## 2. MQTT (Gateway ⇄ Cloud ⇄ App)

Base topic: `plc/<site>/<device>`

| Topic | Chiều | Nội dung | Retain |
|---|---|---|---|
| `<base>/telemetry` | gw → app | `{"r":[D0..D39]}` mỗi 1 s | có |
| `<base>/history` | gw → app | `{"c":[49],"s":giây,"n":số giờ,"r":giây chạy,"m":[49]}` mỗi 60 s (lịch sử theo giờ do PLC giữ) | có |
| `<base>/status` | gw → app | `online` / `plc_fault` / `offline` (LWT) | có |
| `<base>/cmd` | app → gw | `{"id":"x","a":4,"v":5}` ghi D4 = 5 | không |
| `<base>/ack` | gw → app | `{"id":"x","ok":true}` | không |
| `<base>/cmd` (đọc) | app → gw | `{"id":"x","op":"read","a":100,"n":4}` → ack `{"id":"x","ok":true,"a":100,"v":[..4 số..]}` | không |

Tài khoản `gw` và `app` được phân quyền riêng trong `cloud/config/acl`:
app không thể giả mạo telemetry, gateway không thể gửi lệnh.

## Lịch sử theo giờ
PLC tự lưu 48 giờ gần nhất, không cần đồng hồ thời gian thực: app tính mốc của giờ hiện tại từ `s` (giây đã trôi qua) và đồng hồ của máy người dùng. Khi PLC mất điện, thời gian tắt máy không được đếm, nên một khung giờ có thể dài hơn 60 phút thực.

## Lịch sử trên server (app ingest)
`plciot-app` subscribe `plc/+/+/+`, ghi mọi sự kiện (`telemetry`, `status`, `history`, `ack`, …) vào SQLite `mqtt_events`, retention mặc định 3 ngày (`HISTORY_DEFAULT_DAYS`), mỗi tài khoản có thể có gói riêng `users.retention_days` (NULL = mặc định, 0 = không giới hạn, N ≥ 4 = N ngày; site/device dùng chung lấy mức dài nhất).

Webapp (đã đăng nhập) khi mở gọi `GET /api/history/telemetry?site=&dev=&since=` (Bearer JWT), ghi vào IndexedDB để xem offline / khi app từng đóng. Live vẫn qua MQTT trực tiếp.
