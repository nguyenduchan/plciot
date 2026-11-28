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
- ACL Mosquitto: mỗi gateway chỉ ghi `gw/<id của mình>/{telemetry,status,ack,history,config,alert,rpcr,fwq}` và đọc `gw/<id>/{cmd,rpc,fw}`; user app chỉ đọc topic của gateway được xem; chỉ `ctl` ghi `gw/+/{cmd,rpc,fw}`.
- `rpc`/`rpcr`: cài đặt từ xa (docs/REMOTE-ADMIN.md). `fwq`/`fw`: board Waveshare tải firmware qua MQTT khi HTTPS hỏng (docs/OTA-APPROVAL.md).
- **Đã bỏ** hẳn `plc/<site>/<device>` và `iot/<tenant>/<site>/<device>` trên cloud (không còn song song). Gateway/firmware cũ phải **đăng ký lại** để nhận id (firmware: đặt `MQTT_ID` trong `config.h`). Gateway chưa đăng ký chỉ dùng topic cục bộ `plc/<site>/<device>` trên broker LAN của chính nó (cloud không nhận dạng).
- DB cũ: lần mở đầu tiên server thêm cột `mqtt_id` và cấp id ngẫu nhiên cho thiết bị đã có (`ensureMqttIdColumn`).

Cùng các `kind` dưới đây. Chi tiết onboard partner, MQTTS, schema: [PARTNER-INTEGRATION.md](PARTNER-INTEGRATION.md). Contract runtime: `GET /api/v1/contract`.

| Topic | Chiều | Nội dung | Retain |
|---|---|---|---|
| `<base>/telemetry` | gw → app | `{"schema":1,"r":[D0..D39]}` hoặc `schema:2` kèm `"d":{ childId: {…} }` (nhiều thiết bị con / UI contract) | có |
| `<base>/history` | gw → app | `{"c":[49],"s":giây,"n":số giờ,"r":giây chạy,"m":[49]}` mỗi 60 s (lịch sử theo giờ do PLC giữ) | có |
| `<base>/status` | gw → app | `online` / `plc_fault` / `offline` (LWT) | có |
| `<base>/cmd` | app → gw | `{"schema":1,"id":"x","a":4,"v":5}` ghi D4 = 5 (chỉ user `ctl`) | không |
| `<base>/alert` | gw → app | `{"schema":1,"k":"tank1.level","lv":"high","v":95.2,"txt":"Bồn nước: Mức nước vượt ngưỡng cao (95.2 %)","ts":…}` — cảnh báo ngưỡng low/high do **gateway tự tính** (`AlertEngine`, báo khi chuyển trạng thái, tối thiểu 5 phút giữa hai lần cùng mức); server chỉ lưu vào DB và chuyển tiếp Web Push tới đúng tài khoản của gateway | không |
| `<base>/ack` | gw → app | `{"id":"x","ok":true}`; từ chối: `{"id":"x","ok":false,"err":"…"}` — `toggle_too_fast` (đầu ra số đổi trạng thái sớm hơn `toggleMs`) kèm `"waitMs"` = số ms còn phải chờ (gateway C#; firmware board chỉ trả `err`) | không |
| `<base>/cmd` (đọc) | app → gw | `{"id":"x","op":"read","a":100,"n":4}` → ack `{"id":"x","ok":true,"a":100,"v":[..4 số..]}` | không |
| `<base>/raw` | gateway **no-code** → server | payload JSON bất kỳ của hãng (≤ 16 KB); server áp ánh xạ rồi user `ctl` phát lại `<base>/telemetry` `{schema:2,d}` + `status`/`config` thay gateway. Gateway no-code chỉ ghi `raw` + `status`, chỉ qua MQTTS — [NOCODE-GATEWAY.md](NOCODE-GATEWAY.md) | không |
| `<base>/cmdraw` | server (`ctl`) → gateway **no-code** | lệnh đã dịch sang định dạng của hãng (vd. USR `{"rw_prot":{…"dir":"down"…}}`), **không ký**, QoS 0, không retain | không |
| `<base>/ackraw` | gateway **no-code** → server | phản hồi lệnh của hãng; server đổi thành `<base>/ack` chuẩn (`ctl` phát), hết giờ → `no_confirm` | không |

Tài khoản `gw` / `edge` (thiết bị) và user app được phân quyền riêng trong `cloud/config/acl`:
app không thể giả mạo telemetry; chỉ `ctl` (app server) được ghi lệnh.

## Lịch sử theo giờ
PLC tự lưu 48 giờ gần nhất, không cần đồng hồ thời gian thực: app tính mốc của giờ hiện tại từ `s` (giây đã trôi qua) và đồng hồ của máy người dùng. Khi PLC mất điện, thời gian tắt máy không được đếm, nên một khung giờ có thể dài hơn 60 phút thực.

## Lịch sử trên server (app ingest)
`plciot-app` subscribe `gw/+/+`, ghi mọi sự kiện (`telemetry`, `status`, `history`, `ack`, …) vào SQLite `mqtt_events`, retention mặc định 1 ngày (`HISTORY_DEFAULT_DAYS`); lịch sử đăng nhập/điều khiển (`audit_log`) giữ 365 ngày (`AUDIT_RETENTION_DAYS`), mỗi tài khoản có thể có gói riêng `users.retention_days` (NULL = mặc định, 0 = không giới hạn, N ≥ 4 = N ngày; site/device dùng chung lấy mức dài nhất).

**Bù dữ liệu offline (backfill).** Gateway lưu lịch sử giá trị vào SQLite cục bộ (`history.db`, số ngày giữ + chu kỳ ghi do người dùng đặt trên gateway, 0 ngày = không giới hạn). Mẫu ghi lúc không nối được cloud được đánh dấu chưa gửi; khi nối lại gateway gửi bù lên `<base>/telemetry` (QoS 1, không retain) dạng `{"schema":2,"bf":1,"ts":<ms gốc>,"d":{…}}`, cũ nhất trước, ~10 bản tin/giây. Server chỉ nhận mẫu có `ts` trong thời hạn lưu của gói (`deviceRetentionDays`, người dài nhất thắng; cũ hơn thì bỏ), không sau hiện tại quá 60 giây, bỏ mẫu trùng `ts`, và KHÔNG đụng trạng thái online/nhịp/cảnh báo. Kit enroll có `retentionDays` (0 = không giới hạn) để gateway không gửi mẫu chắc chắn bị bỏ. Gói bù có bucket chống dồn riêng (`POLICY_BACKFILL_MAX`, mặc định 1200/phút).

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
- **`toggleMs`** (field ghi được, thường `switch`): thời gian tối thiểu (ms, 1…3 600 000) giữa hai lần **đổi** trạng thái — bảo vệ tiếp điểm relay / máy nén. Nguồn: `PackMap.MinToggleMs` (GatewayApp: ô *Tối thiểu giữa 2 lần bật/tắt* khi thêm thiết bị). Chỉ lần ĐỔI giá trị mới tính; gửi lại đúng trạng thái đang có luôn được.
  Chặn ở 4 lớp: webapp (nút khoá + đếm ngược), server `/api/control/cmd` → **429** `{"error":"toggle_too_fast","waitMs","toggleMs"}` + `Retry-After` (bộ nhớ trong tiến trình, `cloud/app/src/toggleGuard.js`), gateway C# `ToggleGuard` (mọi nguồn lệnh: màn hình, màn hình phụ, cloud, MQTT LAN) và firmware board (mọi đường ghi DO). Server sanitize: bỏ nếu field không `writable` hoặc ≤ 0.

## Lệnh cloud có chữ ký, mật khẩu cục bộ, đổi PC

- **Lệnh server → gateway được ký** (`cloud/app/src/cmdSign.js`, ECDSA P-256/SHA-256, IEEE P1363). JSON lệnh có thuộc tính cuối `"sig"`; thông điệp ký = `cmd1|<mqttId>|<JSON lệnh không sig>`. Khoá công khai của server (`cmdKey`, SPKI base64url) đi trong kit enroll/config qua HTTPS. Gateway có `CloudCmdKey` thì **từ chối lệnh không ký/sai chữ ký** (`bad_sig`); lệnh ký đúng đã qua step-up Face ID/TOTP ở server nên **không cần OTP tại gateway** (`ScadaCore.ExecuteAsync(..., trusted: true)`). Whitelist, `AllowsControl`, giới hạn min/max, chống phát lại (`ts` + `id`) vẫn áp dụng. Khoá ký: `CMD_SIGN_KEY_PEM` hoặc `DATA_DIR/cmd-sign.pem` (tự sinh) — **phải sao lưu cùng DB**; mất khoá thì gateway tự nhận khoá mới ở lần đồng bộ config kế (~1–5 phút).
- **Lệnh nhanh cho board (`"mac"`, từ mcu-0.4.24):** server biết khoá danh tính gateway (`hardware_devices.gw_pubkey`) thì thêm `"mac"` ngay trước `"sig"`: `mac = HMAC-SHA256(K, cmd1|<mqttId>|<JSON không mac, không sig>)`, `K = HMAC-SHA256(Z, "plciot-cmdmac1|<mqttId>")`, `Z` = ECDH(khoá lệnh server, khoá danh tính gateway). `"sig"` ký trên chuỗi **có** `mac` → gateway cũ (board cũ, GatewayApp) kiểm như trước, bỏ qua `mac`. Board mới kiểm `mac` (~1 ms thay vì ~228 ms ECDSA phần mềm), `mac` thiếu/sai thì kiểm `sig`. Test: `node scripts/smoke-cmd-mac.js`.
- `ack` của board có thể kèm `"t":[kiểm lệnh ms, ghi đầu ra ms, loop() dài nhất ~10 s ms]` (chẩn đoán độ trễ; client bỏ qua được).
- **Mật khẩu cục bộ** (`LocalAdminHash`, PBKDF2-SHA256): mở khoá sửa cấu hình/điều khiển tại máy, không cần webapp/Internet. Quên → xác nhận bằng webapp (OTP/Authenticator) rồi đặt lại.
- **Gắn máy**: khoá riêng ECDSA + mật khẩu cloud mã hoá DPAPI theo máy; `BoundMachineId` phát hiện config bị sao chép sang PC khác (gateway không nối cloud, mời chuyển).
- **Đổi PC**: PC mới → "Chuyển gateway sang PC này" → đăng nhập chủ tài khoản (Authenticator/OTP) → chọn gateway cũ → `GET /api/v1/gateway/mine`, `POST /api/v1/gateway/rebind` (chữ ký `rebind|site|device|ts` của khoá PC mới). Server đổi `gw_pubkey`/`activated_hw`, xoay mật khẩu MQTT (PC cũ bị cắt), **giữ nguyên QR/id MQTT/thiết bị/lịch sử**. Thiết bị PLC (Pack, giao thức, thanh ghi) khai báo cục bộ nên cần xuất/nhập file cấu hình từ PC cũ.
