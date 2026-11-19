# gateway-mcu — gateway Waveshare ESP32-S3 (C++)

Board: **Waveshare ESP32-S3-POE-ETH-8DI-8DO** (ESP32-S3-WROOM-1U-N16R8, Ethernet W5500 + PoE, RS485, CAN, 8 DI, 8 DO qua TCA9554).

Board **chạy độc lập** như gateway C#: tự đọc PLC, tự nối cloud, tự nhận lệnh từ webapp — không cần PC.
GatewayApp (C#) chỉ dùng để **cài đặt qua LAN**: nút **🔌 Kết nối Waveshare (LAN)** → cùng các trang Thiết bị / Cloud / Tổng quan như gateway PC.
Hệ thống thật có thể dùng cả gateway PC lẫn nhiều board Waveshare; mỗi cái là một gateway riêng (id MQTT riêng).

```powershell
cd gateway-mcu
pio run                      # biên dịch
pio run -t upload            # nạp qua USB-C
pio device monitor           # log + mã kết nối admin (115200)
```

Windows: gói Arduino-ESP32 có đường dẫn rất sâu, giải nén vào `%USERPROFILE%\.platformio` vượt giới hạn 260 ký tự → đặt thư mục PlatformIO ngắn
(`$env:PLATFORMIO_CORE_DIR='D:\pio'`) hoặc bật Long Paths. Chạy `pio` từ PowerShell/cmd — bộ cài pioarduino từ chối Git Bash (MSYS).

## Thử trên PC, không cần board (bản giả lập)

```powershell
pio pkg install                         # lần đầu: tải thư viện (ArduinoJson) của bản board
.\build-sim.ps1                         # → build-sim\gw-sim.exe (MinGW g++)
$env:SIM_API_PORT=8760; .\build-sim\gw-sim.exe
```

- Biên dịch **chính mã `src/`** (API LAN, cấu hình, đọc/ghi Modbus, cảnh báo, gửi bù, I/O) với lớp giả phần cứng trong `sim/`: Ethernet/HTTP/UDP = Winsock, LittleFS/NVS = file trong `simdata\`, DI = file `simdata\di.txt` (vd. `0x05`), DO trong bộ nhớ, RS485 = cổng COM thật nếu đặt `SIM_COM=COM5`.
- **Cách ly bằng cờ `GW_SIM`**: mọi file trong `sim/` bọc `#ifdef GW_SIM` và header giả báo `#error` nếu thiếu cờ; `gw.h` báo `#error` nếu cờ lọt vào bản ESP32. `pio run` (bản nạp xuống board) không biên dịch `sim/`.
- Không có trên PC: cloud (MQTTS/HTTPS) và mật mã mbedtls — `sim/sim_stubs.cpp` thay bằng bản tắt; cảnh báo ngưỡng vẫn tính và in log.
- Thử với GatewayApp: `GatewayApp.exe --lantest THƯ_MỤC --lan-target 127.0.0.1:8760 --lan-code <mã in lúc khởi động> --lan-mb 5020` (PLC giả: `python tools/modbus_tcp_sim.py --port 5020`).

## Giống gateway C# ở đâu

| Việc | Gateway C# | Board |
|---|---|---|
| Cấu hình | `ScadaConfig` + metadata hiển thị | cùng JSON `ApiConfig` (`/config.json` trên LittleFS), trả lại nguyên vẹn mọi trường |
| Đọc PLC | `PackDriverPool` + `PackCodec` | `engine.cpp` — gom field cùng PLC (≤ 8 word cách, ≤ 100 word/lần), cùng kiểu UINT/INT/BOOL/UDINT/DINT/REAL/LREAL, đảo word, hệ số |
| Ghi lệnh | `ScadaCore.ExecuteKeyAsync` | `engineWrite` — Min/Max, `read_only`, `bad_value`, `plc_error` |
| Telemetry | `{"schema":2,"d":{child:{khoá:số}}}`, `TelemetryGate` | giống hệt (vừa có lệnh → ngay; có người xem `sys:live` → `CloudTelemetryMinMs`; không ai xem → `CloudIdleTelemetryMs`) |
| Status / LWT | `online` / `plc_fault` / `offline` retain | giống |
| Config | `ConfigBuilder` → `<base>/config` retain | `configMessage()` — cùng nhãn/đơn vị/widget/ngưỡng |
| Lệnh cloud | chữ ký server (`CmdSignature`), chống phát lại, `sys:*`, `RemoteCmdPerSec` | `cloud.cpp` — giống; không có `CloudCmdKey` thì từ chối điều khiển (`otp_required`, board không có mở khoá tại máy) |
| Cảnh báo | `AlertEngine` | `alert.cpp` — cùng low/high, 5 phút giữa hai lần |
| Bù dữ liệu offline | `history.db` + `BackfillAsync` | `backfill.cpp` — hàng đợi trên flash (tối đa ~2 MB), `{"schema":2,"bf":1,"ts":…}` ~10 tin/giây, bỏ mốc quá `CloudRetentionDays` |
| Đăng ký cloud | đăng nhập webapp trên máy | admin đăng nhập webapp trong GatewayApp, board nhận phiên rồi tự ký `register|uid|ts` bằng khoá riêng (P-256, NVS) |
| Hỏi lại server | `PollClaimed` (60 s / 5 phút) | giống: user/khoá ký lệnh/gói cloud |

## Giao thức trên board

- **Modbus RTU (RS485)**: kết nối "Modbus RTU" trong GatewayApp — ô *Địa chỉ* ghi gì cũng được (vd. `RS485`), ô *Cổng* = baud, *Parity* Even/None/Odd (8 bit, 1 stop). Unit ID theo từng thiết bị.
- **Modbus TCP**: qua cổng Ethernet của board.
- **I/O trên board** = Modbus RTU **Unit ID 0** (địa chỉ broadcast, không slave thật nào trả lời): `D0` = DI1..DI8 (bit 0 = DI1), `D1` = DO1..DO8 (ghi được), `D10..D17` = từng DI (0/1), `D20..D27` = từng DO (0/1, ghi được). Vẫn cần khai báo kết nối Modbus RTU.
- Giao thức khác (S7, FINS, MC, EtherNet/IP, ADS, OPC UA) bị từ chối khi lưu, kèm câu báo rõ.

## Cài đặt qua LAN (bảo mật)

- API cổng **8750**, cùng hợp đồng với gateway PC (`tools/GatewayApp/Remote/Contract.cs`); tìm thiết bị UDP **8751** (`Kind: "mcu"`).
- Mã kết nối 8 số **cố định** (sinh lần đầu, lưu NVS, in ra cổng USB lúc khởi động — dán tem lúc xuất xưởng).
- Chỉ đăng nhập được trong **cửa sổ cài đặt**: 10 phút sau khi cấp điện, hoặc 10 phút sau khi **nhấn BOOT**. Phải có mặt cạnh board mới cài được.
- Sai mã 5 lần/60 giây → khoá 60 giây. Tối đa 4 phiên, phiên rảnh 30 phút thì hết.
- **Giữ BOOT 10 giây** (còi kêu dài) rồi thả = xoá cấu hình (giữ khoá danh tính + mã kết nối).
- Mật khẩu MQTT lưu NVS, không bao giờ trả về qua API. HTTP thường: chỉ dùng trong LAN tin cậy.
- `http://<IP>:8750/` = trang trạng thái (không lộ mã/bí mật).

## LED

xanh lá = PLC online + cloud ổn · vàng = PLC lỗi / chưa có thiết bị · xanh dương = đang nối cloud · đỏ = mất mạng.

## Chưa kiểm chứng trên phần cứng (cần board thật)

- Chân TCA9554 (giả định chung I2C với RTC: SDA 42 / SCL 41) và mức tích cực của DI/DO (`board.h`).
- Hướng RS485 bằng RTS (GPIO21) ở chế độ `UART_MODE_RS485_HALF_DUPLEX`.
- HTTPS tới server dùng bộ CA có sẵn của ESP-IDF (`esp_crt_bundle_attach`); MQTTS chỉ chạy khi server trao `pinSha256` (broker tự ký).
- Đồng hồ: NTP; chưa có NTP thì lấy giờ từ header `Date` của server. Lệnh cloud có `ts` bị từ chối (`clock_not_synced`) cho tới khi có giờ.

## Chưa làm

IP tĩnh (đang DHCP), cập nhật firmware qua mạng (OTA), CAN, xem/xuất lịch sử của board từ GatewayApp, gửi bù QoS 1 (PubSubClient chỉ QoS 0 — xoá khỏi hàng đợi khi gửi TCP xong).
