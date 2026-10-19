# plciot

```
 Xinje XD3-16T-E ──RS485/Modbus RTU──> Gateway ESP32 ──Ethernet/wss MQTT──> Mosquitto (PC + Cloudflare Tunnel) <──wss── Webapp (điện thoại)
 (chạy offline)                        (WT32-ETH01+MAX485)               (chỉ quản lý kết nối)            (PWA, chạy từ file local)
```

| Thư mục | Nội dung |
|---|---|
| `plc/xd3_logic.st` | Chương trình điều khiển cho XD3-16T-E (XDPPro, ST). PLC tự chạy, không cần mạng. |
| `gateway/` | Firmware PlatformIO: poll Modbus (D0–D39) → MQTT, nhận lệnh ghi (whitelist) qua wss. |
| `cloud/` | Mosquitto + user/ACL. Không có code, không có giao diện. |
| `webapp/` | PWA thuần HTML/JS, không phụ thuộc thư viện ngoài, tự chứa MQTT client. |
| `edge/` | Node-RED (Docker) cầu nối PLC Siemens S7 / Modbus TCP vào cùng hợp đồng MQTT. |
| `tools/` | Bộ giả lập gateway/PLC, bộ sinh luồng Node-RED, tạo icon. |
| `docs/PROTOCOL.md` | Bản đồ thanh ghi và topic MQTT. |

## Chạy thử

**Webapp (demo, không cần phần cứng):** mở `webapp/index.html` (hoặc `python -m http.server` trong `webapp/`). App mặc định ở chế độ demo.

**Cloud (broker trên PC + Cloudflare Tunnel) và domain:** xem [docs/DEPLOY.md](docs/DEPLOY.md).
**Máy chủ MQTT tại Việt Nam (độ trễ thấp, nối thẳng):** xem [docs/MAY-CHU-VIET-NAM.md](docs/MAY-CHU-VIET-NAM.md).

**PLC khác (Siemens S7, Modbus TCP...):** dùng Node-RED làm cầu nối thay gateway, xem [docs/NODE-RED.md](docs/NODE-RED.md).

**Gateway:** sửa `gateway/src/config.h` (URI broker, mật khẩu, baud), rồi `pio run -t upload`.
Đấu nối: MAX485 RO→GPIO5, DI→GPIO17, DE+RE→GPIO4; A/B nối COM2 RS485 của PLC.

**PLC:** nạp `plc/xd3_logic.st` bằng XDPPro, bật Modbus slave cho COM2, đặt D3, D10–D35 vào vùng latched.

**App → thật:** Cài đặt → tắt Demo → nhập `wss://mqtt.<domain>`, user `app`, site/device trùng gateway.

## iPhone

Hướng dẫn từng bước (host HTTPS, wss, Thêm vào Màn hình chính): [docs/IPHONE.md](docs/IPHONE.md). Icon PNG tạo bằng `python tools/make_icons.py`.

## Dùng webapp trên điện thoại không cần server

- **Cách đơn giản:** đặt 7 file trong `webapp/` lên bất kỳ static host HTTPS (GitHub Pages…), mở một lần, "Thêm vào màn hình chính". Service worker cache toàn bộ, sau đó chạy offline hoàn toàn; host không xử lý gì.
- **Hoàn toàn local:** đóng gói bằng Capacitor (`npx cap add ios|android`, `webDir: webapp`) — file nằm trong app, không cần host.
- Trang HTTPS chỉ kết nối được `wss://`; TLS do Cloudflare Tunnel đảm nhiệm (xem DEPLOY.md).

## Băng tải (đếm & dừng)

Cảm biến sản phẩm vào X3, động cơ băng tải ra Y1. PLC đếm cạnh lên của X3, tự dừng khi đạt số lượng mục tiêu hoặc E-stop. Tab **Băng tải** trong app: chạy/dừng, đặt mục tiêu, xoá đếm, biểu đồ cột sản lượng theo 5 phút/30 phút/giờ. Số đếm hiện tại và tổng đều do PLC giữ, app chỉ đọc.

## Lưu ý quan trọng — chưa kiểm chứng trên phần cứng

- Đã chạy thử: webapp ở chế độ demo (UI, điều khiển, báo cáo). **Chưa** chạy: firmware gateway (chưa build), chương trình ST (chưa có XDPPro để biên dịch; cú pháp, tên rơ-le xung 1 s `M10`, và địa chỉ `DDn` cần đối chiếu với tài liệu XD), MQTT client với broker thật.
- XD3-16T-E nền không có ngõ vào analog: nhiệt độ/mức liên tục cần module mở rộng; hiện logic dùng 2 công tắc mức (X1, X2) và X0 E-stop. Đổi ý nghĩa I/O trong `.st` và tên trong Cài đặt của app.
- Lịch sử biểu đồ chỉ ghi khi app đang mở (cloud cố ý không lưu). Thống kê thời gian chạy/số lần khởi động do PLC tự đếm nên luôn đầy đủ.
- Điều khiển từ xa ghi thẳng đầu ra: ACL + TLS là bắt buộc nếu broker ra internet; khoá liên động an toàn (E-stop, chạy khô) nằm trong PLC, không phụ thuộc mạng.
# plciot
