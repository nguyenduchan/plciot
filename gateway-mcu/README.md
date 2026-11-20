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
.\build.ps1                             # image thật cho board (mặc định) — lần đầu cũng tải thư viện ArduinoJson/PubSubClient
.\build.ps1 -Sim                        # bản giả lập → build-sim\gw-sim.exe (MinGW g++)
$env:SIM_API_PORT=8443; $env:SIM_HTTP_PORT=8081; .\build-sim\gw-sim.exe
```

- Biên dịch **chính mã `src/`** — kể cả `cloud.cpp`, `crypto.cpp`, `https.cpp`, PubSubClient và **mbedtls 3.6** (giải nén vào `sim/third_party/mbedtls`, không commit) —
  với lớp giả trong `sim/`: Ethernet/TCP/UDP = Winsock, TLS = mbedtls trên socket Windows, CA gốc = kho chứng chỉ Windows, LittleFS/NVS = file trong `simdata\`,
  DI = file `simdata\di.txt` (vd. `0x05`), DO trong bộ nhớ, RS485 = cổng COM thật nếu đặt `SIM_COM=COM5`. `ESP.restart()` = tự chạy lại chương trình.
- Biến môi trường: `SIM_API_PORT` (HTTPS, mặc định 443), `SIM_HTTP_PORT` (trang trạng thái, mặc định 80), `SIM_DATA`, `SIM_MAC`,
  `SIM_WINDOW_SEC` (cửa sổ ghép, mặc định 600), `SIM_PAIR_WAIT_SEC` (thời gian chờ PC mới, mặc định 86400).
- **Cách ly bằng cờ `GW_SIM`**: mọi file trong `sim/` bọc `#ifdef GW_SIM` và header giả báo `#error` nếu thiếu cờ; `gw.h` báo `#error` nếu cờ lọt vào bản ESP32. Image board không biên dịch `sim/`.
- Thử tự động với GatewayApp (PLC giả: `python tools/modbus_tcp_sim.py --port 5020`; chạy gw-sim với `SIM_WINDOW_SEC=120 SIM_PAIR_WAIT_SEC=6`):
  `GatewayApp.exe --lantest THƯ_MỤC --lan-target 127.0.0.1:8443 --lan-http 8081 --lan-mb 5020` — kênh HTTPS + ghim khoá, ghép/chờ/đồng ý/từ chối/tự kích hoạt,
  thêm/sửa/xoá thiết bị, ghi lệnh, đổi IP + tự đăng nhập lại, PC lạ bị từ chối sau khởi động lại.

### Giả lập đủ DI/DO + RS485 + Modbus TCP (không cần phần cứng)

`tools/esp32_field_sim.py` là "thế giới bên ngoài" của board giả lập: RS485 giả (khung Modbus RTU thô có CRC qua TCP :5485, slave 1 và 2, FC1/2/3/4/5/6/15/16),
Modbus TCP :5020 (cùng ngân hàng thanh ghi; D0 nhiệt độ x10, D1 bộ đếm +1/giây, D2 mức %, coil n → discrete n sau 1 giây), và **bảng web http://127.0.0.1:8090**
để bấm DI1..DI8 (ghi `di.txt`) và xem DO1..DO8 (board ghi `do.txt`).

```powershell
$d = "$PWD\gateway-mcu\simdata"
python tools\esp32_field_sim.py --data $d
$env:SIM_DATA=$d; $env:SIM_RS485_TCP='127.0.0.1:5485'; .\gateway-mcuuild-sim\gw-sim.exe    # SIM_RS485_TCP thay cho SIM_COM
```

Cài đặt từ GatewayApp như board thật: **Kết nối Waveshare (LAN)** → Thêm thiết bị: Modbus RTU (Địa chỉ `RS485`, Unit 0 = DI/DO board, Unit 1 = slave RS485 giả),
hoặc Modbus TCP `127.0.0.1:5020`. Thử tự động: `GatewayApp.exe --iotest KQ --lan-target 127.0.0.1:8443 --io-data <SIM_DATA>` (kết quả `iotest-result.txt`).

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
- **DI lọc rung + bộ đếm cạnh**: task nền lấy mẫu DI mỗi 2 ms; mức `D0`/`D10..D17` chỉ đổi khi tín hiệu ổn định ≥ **lọc rung** (tuỳ chọn *Lọc rung DI board* của kết nối Modbus RTU, mặc định 20 ms, 0 = tắt, tối đa 500). Bộ đếm cạnh lên (đếm SAU lọc, nên nhiễu ngắn không bị đếm): `D30..D37` = DI1..DI8 (16 bit, vòng 65535→0), `D40..D55` = 32 bit (DIn = D40+2(n-1), word cao trước); ghi vào ô đếm = đặt lại (thường 0). Trong GatewayApp → Thêm thiết bị chọn mẫu **"Đầu vào số (DI) trên board — mức"** hoặc **"— bộ đếm cạnh lên"** (tự đặt Modbus RTU, Unit 0, địa chỉ đúng).
- Giao thức khác (S7, FINS, MC, EtherNet/IP, ADS, OPC UA) bị từ chối khi lưu, kèm câu báo rõ.

## Mạng

- Mặc định **IP tĩnh `192.168.1.200/24`**, gateway `192.168.1.1`, DNS `8.8.8.8` (quy ước thiết bị Ethernet sẵn firmware của Waveshare); có tuỳ chọn DHCP.
- Đổi bằng GatewayApp → cửa sổ Waveshare → **"Mạng (IP)…"** (API `GET/PUT /api/network`); lưu xong board tự khởi động lại, GatewayApp tự nối lại bằng IP mới.
- Tìm thiết bị UDP **8751**: board trả lời cả **broadcast** kèm IP/subnet/MAC → PC khác mạng con vẫn thấy board (GatewayApp báo "⚠ khác mạng con").

## Cài đặt qua LAN — bảo mật, không mã/mật khẩu cho board

Nguyên tắc: **ai cầm thiết bị được setup** (người cầm thiết bị ưu tiên hơn tài khoản), nhưng **PC quản trị cũ giữ quyền từ chối** trong 24 giờ.

- **Kênh mã hoá**: HTTPS cổng **443**, chứng chỉ tự ký từ **chính khoá danh tính ECDSA P-256** của board. GatewayApp **ghim khoá** — dấu nhận dạng là
  **mã phần cứng** 20 ký tự (in ra cổng USB lúc khởi động, trang `http://<IP>/`; nên dán tem). Lần đầu: người dùng đối chiếu mã với tem **một lần**; sau đó board giả bị từ chối.
- **Cổng 80**: trang trạng thái chỉ đọc (không lộ bí mật); mọi `/api/*` trả `use_https`.
- **Đăng nhập bằng khoá của PC** (GatewayIdentity của GatewayApp): `GET /api/challenge` → ký `admin-login|<mã phần cứng>|<nonce>` → `POST /api/login`.
  Thử thách dùng một lần, không cần đồng hồ (chạy được hoàn toàn offline). Khoá PC chỉ dùng sau **mật khẩu GatewayApp** (hoặc đăng nhập webapp) — người dùng chỉ nhớ một mật khẩu của chính PC họ.
- **Ghép PC** (một lần cho mỗi PC):
  - board **chưa có PC quản trị** (mới / vừa reset): cửa sổ ghép mở 10 phút sau khi cấp điện hoặc nhấn BOOT → ghép là **dùng ngay**;
  - board **đã có PC quản trị**: cấp điện **không** mở cửa sổ ghép (người lạ rút điện cắm lại không ghép được); **nhấn BOOT** → PC mới ở trạng thái **chờ**:
    PC quản trị cũ **Đồng ý** (ngay) hoặc **Từ chối** trong GatewayApp → "PC quản trị…"; không ai từ chối → **tự kích hoạt sau 24 giờ** board có điện
    (đổi PC, mất máy/tài khoản cũ). Không gỡ được PC quản trị cuối cùng;
  - **chủ board xác nhận bằng webapp** (OTP, cần server — VPS hoặc server cài trên PC trong LAN): PC mới **dùng ngay**.
- **Giữ BOOT 10 giây** (còi kêu dài) rồi thả = reset: xoá cấu hình, tài khoản cloud, IP về `192.168.1.200`, **xoá danh sách PC quản trị** (cài lại từ đầu; người lạ reset không lấy được dữ liệu cũ).
- Lưu ý: không giữ BOOT lúc cấp điện / bấm RESET (GPIO0 là chân chọn chế độ khởi động → vào chế độ nạp firmware).
- Mật khẩu MQTT và danh sách PC lưu NVS, không bao giờ trả về qua API. Tối đa 8 PC quản trị, 4 phiên; phiên rảnh 30 phút thì hết; thử sai 5 lần/60 giây → khoá 60 giây.

## LED

xanh lá = PLC online + cloud ổn · vàng = PLC lỗi / chưa có thiết bị · xanh dương = đang nối cloud · đỏ = mất mạng.

## Chưa kiểm chứng trên phần cứng (cần board thật)

- Chân TCA9554 (giả định chung I2C với RTC: SDA 42 / SCL 41) và mức tích cực của DI/DO (`board.h`).
- Hướng RS485 bằng RTS (GPIO21) ở chế độ `UART_MODE_RS485_HALF_DUPLEX`.
- HTTPS tới server dùng bộ CA có sẵn của ESP-IDF (`esp_crt_bundle_attach`); MQTTS chỉ chạy khi server trao `pinSha256` (broker tự ký).
- Đồng hồ: NTP; chưa có NTP thì lấy giờ từ header `Date` của server. Lệnh cloud có `ts` bị từ chối (`clock_not_synced`) cho tới khi có giờ.

## Báo mất / khoá

Xem [../docs/GATEWAY-LOST.md](../docs/GATEWAY-LOST.md): chủ báo mất → khoá tạm → admin duyệt; board khoá giữ qua reset.

## Chưa làm

Cập nhật firmware qua mạng (OTA), CAN, xem/xuất lịch sử của board từ GatewayApp, gửi bù QoS 1 (PubSubClient chỉ QoS 0 — xoá khỏi hàng đợi khi gửi TCP xong).
