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

### PC đọc thẳng RS485 (không gateway ESP32)
Máy SCADA nối bộ chuyển USB–RS485 vào COM2 của PLC (A↔A, B↔B). Trong cài đặt chọn nguồn **Modbus RTU RS485**:
địa chỉ PLC = tên cổng (`COM3`), cổng PLC = baud (0 → 19200), `SerialParity` trong `config.json` (mặc định `Even` → 19200 8E1, trùng XDPPro), `ModbusUnit` = số trạm.
Cùng bản đồ D như trên; giao diện PC, web nhiều màn hình và điện thoại (qua cloud) dùng chung đường này. Mỗi cổng COM chỉ một master: không chạy đồng thời gateway ESP32 trên cùng bus.

## 2. MQTT (Gateway ⇄ Cloud ⇄ App)

Base topic: **`gw/<mqttId>`** — một dạng duy nhất.

`mqttId` là **id MQTT ngẫu nhiên (16 ký tự hex, 64 bit) do server cấp** cho mỗi gateway khi đăng ký (enroll/ghép cặp). Server lưu trong bảng `devices.mqtt_id` và **ánh xạ id → tenant/site/device → cấu hình gateway** (`gateway_configs`, `user_devices`). Gateway nhận id trong kết quả enroll (`mqttId`, `topicBase`, `topics`) và **ghép id này vào mọi topic**; topic không lộ tên site/device và không đoán được.

- Cấp một lần, **giữ nguyên khi xoay mật khẩu MQTT**; chỉ đổi khi cấp lại thiết bị (thu hồi + enroll mới).
- Ingest tra ngược `gw/<id>/<kind>` → thiết bị trong DB; id lạ, đã thu hồi hoặc bị khoá thì **bỏ gói** (không ghi gì).
- ACL Mosquitto: mỗi gateway chỉ ghi `gw/<id của mình>/{telemetry,status,ack,history,config}` và đọc `gw/<id>/cmd`; user app chỉ đọc topic của gateway được xem; chỉ `ctl` ghi `gw/+/cmd`.
- **Đã bỏ** hẳn `plc/<site>/<device>` và `iot/<tenant>/<site>/<device>` trên cloud (không còn song song). Gateway/firmware cũ phải **đăng ký lại** để nhận id (firmware: đặt `MQTT_ID` trong `config.h`). Gateway chưa đăng ký chỉ dùng topic cục bộ `plc/<site>/<device>` trên broker LAN của chính nó (cloud không nhận dạng).
- DB cũ: lần mở đầu tiên server thêm cột `mqtt_id` và cấp id ngẫu nhiên cho thiết bị đã có (`ensureMqttIdColumn`).

Cùng các `kind` dưới đây. Chi tiết onboard partner, MQTTS, schema: [PARTNER-INTEGRATION.md](PARTNER-INTEGRATION.md). Contract runtime: `GET /api/v1/contract`.

| Topic | Chiều | Nội dung | Retain |
|---|---|---|---|
| `<base>/telemetry` | gw → app | `{"schema":1,"r":[D0..D39]}` hoặc `schema:2` kèm `"d":{ childId: {…} }` (nhiều thiết bị con / UI contract) | có |
| `<base>/history` | gw → app | `{"c":[49],"s":giây,"n":số giờ,"r":giây chạy,"m":[49]}` mỗi 60 s (lịch sử theo giờ do PLC giữ) | có |
| `<base>/status` | gw → app | `online` / `plc_fault` / `offline` (LWT) | có |
| `<base>/cmd` | app → gw | `{"schema":1,"id":"x","a":4,"v":5}` ghi D4 = 5 (chỉ user `ctl`) | không |
| `<base>/ack` | gw → app | `{"id":"x","ok":true}` | không |
| `<base>/cmd` (đọc) | app → gw | `{"id":"x","op":"read","a":100,"n":4}` → ack `{"id":"x","ok":true,"a":100,"v":[..4 số..]}` | không |

Tài khoản `gw` / `edge` (thiết bị) và user app được phân quyền riêng trong `cloud/config/acl`:
app không thể giả mạo telemetry; chỉ `ctl` (app server) được ghi lệnh.

## Lịch sử theo giờ
PLC tự lưu 48 giờ gần nhất, không cần đồng hồ thời gian thực: app tính mốc của giờ hiện tại từ `s` (giây đã trôi qua) và đồng hồ của máy người dùng. Khi PLC mất điện, thời gian tắt máy không được đếm, nên một khung giờ có thể dài hơn 60 phút thực.

## Lịch sử trên server (app ingest)
`plciot-app` subscribe `gw/+/+`, ghi mọi sự kiện (`telemetry`, `status`, `history`, `ack`, …) vào SQLite `mqtt_events`, retention mặc định 3 ngày (`HISTORY_DEFAULT_DAYS`), mỗi tài khoản có thể có gói riêng `users.retention_days` (NULL = mặc định, 0 = không giới hạn, N ≥ 4 = N ngày; site/device dùng chung lấy mức dài nhất).

Webapp (đã đăng nhập) khi mở gọi `GET /api/history/telemetry?site=&dev=&since=` (Bearer JWT), ghi vào IndexedDB để xem offline / khi app từng đóng. Live vẫn qua MQTT trực tiếp.

Dashboard widget (web + C#): [UI-CONTRACT.md](UI-CONTRACT.md) — `GET /api/v1/ui/dashboard`, thêm thiết bị bằng QR (`POST /api/devices`).

## 3. Dynamic Discovery — gateway tự khai báo thiết bị (`<base>/config`)

Gateway (Node-RED / GatewayApp) thêm/bớt thiết bị → publish **retain** một bản tin cấu trúc lên `<base>/config`
(khi Deploy và khi khởi động lại). Server upsert vào `gateway_configs`, đồng bộ thiết bị con (type `dynamic`) cho
chủ gateway, webapp nhận config qua MQTT và tự dựng lại dashboard — không sửa code backend/frontend.

```json
{ "gw": "GW01", "devices": [
  { "id": "bien_ap_01", "name": "Biến áp", "fields": [
    { "key": "temp", "lbl": "Nhiệt độ dầu", "unit": "°C", "widget": "gauge", "min": 0, "max": 120 },
    { "key": "volt", "lbl": "Điện áp", "unit": "V", "widget": "chart" } ] },
  { "id": "quat_hut_02", "name": "Quạt hút", "fields": [
    { "key": "status",  "lbl": "Trạng thái", "widget": "led_status" },
    { "key": "control", "lbl": "Điều khiển", "widget": "switch", "writable": true } ] } ] }
```

Telemetry vẫn là `<base>/telemetry`: `{"schema":2,"ts":…,"data":{"bien_ap_01":{"temp":75.2}}}` (`data` ≡ `d`).

- `widget`: `gauge | chart(line) | bar | sparkline | ring | kpi | text | chip | led_status | switch | slider`; lạ → `kpi`.
- Widget chỉ là gợi ý hiển thị. `switch/slider` chỉ điều khiển được khi `writable:true`; lệnh vẫn qua `/api/control/cmd` (step-up, limits/critical).
- `id` `[A-Za-z0-9_-]{1,48}`, `key` `[A-Za-z0-9_]{1,32}`; tối đa 64 thiết bị × 32 field, 16 KB (khớp `max_packet_size` của broker) (`POLICY_MAX_CONFIG_BYTES`).
- Config trùng bản cũ (hash) → bỏ qua; thiết bị `dynamic` vắng trong config mới → gỡ khỏi dashboard. Thiết bị gắn bằng QR giữ nguyên.
- Topic `config` được ghi bởi `gw`/`edge`/thiết bị, đọc bởi ingest và user có scope `telemetry`.
