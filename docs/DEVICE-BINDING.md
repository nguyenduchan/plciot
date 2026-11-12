# Liên kết thiết bị IoT ↔ thuê bao (subscribe)

## Làm sao biết gói tin là của người đã subscribe?

Ba lớp (không phụ thuộc “tự nhận” trong JSON):

```
Thiết bị  --MQTTS-->  Mosquitto ACL  --topic-->  Ingest  --DB-->  Lịch sử / webhook
              │                      │
         user/pass chỉ               topic khớp devices|users
         được ghi đúng topic         + gói tenant/user còn hạn
```

| Lớp | Cơ chế |
|---|---|
| **1. Credential** | Mỗi thiết bị/user có MQTT user riêng (`d_acme_plant1_gw01` hoặc `u12`). Sai pass → broker từ chối. |
| **2. ACL topic** | User đó chỉ `write` đúng `gw/{mqttId}/telemetry|…` của gateway mình (id ngẫu nhiên server cấp). Không giả topic của người khác. |
| **3. Ingest + gói** | App chỉ lưu khi `resolveSubscriber` tìm thấy device/user và (mặc định) **gói còn hạn**. |

Env:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `INGEST_REQUIRE_KNOWN` | `true` | Bỏ qua topic không có trong `devices` / `users` |
| `INGEST_REQUIRE_ACTIVE_SUB` | `true` | Bỏ qua nếu tenant/user hết hạn gói |

Quản lý trên web: **`/console.html`** (admin) — Gói, Thiết bị, Tenant, Database.

## Setup tương thích thiết bị công nghiệp / dân dụng

Chỉ cần client MQTT 3.1.1/5 hỗ trợ **TLS (MQTTS)** + username/password — hầu hết module IoT (ESP32, Quectel, SIMCom, gateway Advantech/USR, PLC có MQTT…) đều được.

### Tham số MQTT (admin tem + enroll)

Tạo tem **`admin.html`** → `POST /api/v1/gateway/enroll` `{ "qr" }` (hoặc admin **Hiện MQTT**). Xem [PROVISIONING-FLOW.md](PROVISIONING-FLOW.md).

| Dùng cho | Field enroll |
|---|---|
| Monitor | `topics.telemetry` + `pack` / `payloadExample` (`schema:2` + `d`) |
| Control | `topics.cmd` / `topics.ack` |
| UI | Type trên tem → `/api/v1/ui/dashboard` (không nằm trong MQTT) |

Không cấu hình “MQTT format” riêng — một shape telemetry. Legacy conveyor `r[]` chỉ nội bộ ingest.

### Không cần

- SDK riêng của plciot  
- HTTP polling (trừ khi dùng REST partner)  
- Certificate client (mTLS) — tuỳ chọn P3; mặc định user/pass đủ  

### Edge / PLC không có MQTT

Dùng Node-RED / gateway (`edge/`, `gateway/`) map Modbus/S7 → đúng topic + credential đã provision.

## Quy trình onboard

1. Admin mở `console.html` → Tenant (nếu partner) → gán gói `pro`/`factory`.  
2. **Thiết bị** → Provision → copy MQTTS + topic vào firmware/cấu hình gateway.  
3. Hoặc user điện thoại: đăng ký app → MQTT user `u{id}` gắn `site/device` → gán gói ở tab **Subscribe**.  
4. Thiết bị online → tab Database / Devices thấy telemetry; hết hạn gói → ingest bỏ qua (broker vẫn có thể nhận nhưng không lưu/không webhook).

## Chặn gói tin trái phép / vi phạm chính sách

Quản lý: **Console → tab Chặn / Policy**.

### Tự động

| Lý do | Hành động |
|---|---|
| `unknown_device` | Không lưu (không có trong devices/users) |
| `user_plan_expired` / `tenant_plan_expired` | Không lưu |
| `manual_block` / `device_blocked` | Khớp blocklist hoặc status blocked |
| `invalid_json` / `policy_telemetry_shape` / `schema_unsupported` | Payload sai chính sách |
| `payload_too_large` | Vượt `POLICY_MAX_PAYLOAD_BYTES` |
| `flood` | Quá nhiều msg / phút trên một site/device |
| Auto-block | Sau N deny → tạo block `mode=auto` có hạn |

Broker ACL vẫn là lớp 1 (sai user/pass/topic → không vào được).

### Thủ công (admin)

- Block **device / site / tenant / topic prefix** (có lý do, có thể hết hạn).  
- **Hard block** thiết bị: thêm blocklist + `devices.status=blocked` + xoay mật khẩu MQTT + rebuild ACL.  
- Gỡ chặn trên console; xem nhật ký deny gần đây.

## Simulator

```bash
python tools/gw_sim.py --ns iot --tenant acme --site plant1 --dev gw01 \
  --user d_acme_plant1_gw01 --password '...' --host … --port 8883
```
(Port MQTTS thật thường qua HAProxy; local Docker dùng 21883 plain monitor-only.)

## Kích hoạt gateway: có internet / không internet

| Trường hợp | Cách làm | Admin phải làm gì |
|---|---|---|
| **Có internet (phổ biến)** | Gateway gọi `POST /api/v1/gateway/enroll` `{ qr, hw }` (`hw` = ID máy / vân tay PC). Server gắn tem với `hw` ở lần đầu; `hw` khác → `409 device_already_activated`. Đặt `ENROLL_REQUIRE_HW=1` để bắt buộc gửi `hw`. | Không. Chuyển máy: nút **Gỡ máy đã gắn** (`POST /api/admin/hardware/:site/:device/unbind`). |
| **Không internet (chỉ LAN)** | Khoá bản quyền 20 ký tự như phần mềm thường: admin nhập ID máy ở trang admin (kiểu *Khoá bản quyền*), khách gõ khoá vào gateway; gateway tự kiểm bằng khoá riêng của máy, không cần mạng. Thư viện kiểm: `tools/GatewayLicense` (`ActivationCode.VerifyLicense`). | Tạo khoá trên trang admin (có thể kèm hạn dùng). |

Kiểu *theo thử thách* (gateway hiện mã yêu cầu, mã dùng một lần) vẫn có, chọn trong cùng ô. Thuật toán khoá bản quyền: `EXP(3)+MAC(16)+CHECK(1)`, `MAC = base32(HMAC-SHA256(K_dev, "lic1|ID|EXP")[0..10])`.

## Quy trình theo loại gateway (bảng chuẩn)

Server là nguồn duy nhất: **đăng ký trên server → gateway lấy về**. Bảng nằm ở `cloud/app/src/gatewayKinds.js` (`GET /api/v1/gateway/kinds`); tool nạp và trang admin theo đúng bảng này.

| Loại | Có internet | Không internet (chỉ LAN) |
|---|---|---|
| **MCU** (firmware) | Tool nạp QR + MQTT + topic qua COM/TCP. Không kích hoạt. | Như bên trái, kèm mã kích hoạt theo thử thách (đọc mã yêu cầu từ MCU). |
| **PC** (phần mềm khách) | Tool ghi kit ra file (`file:...`). Gateway enroll bằng QR kèm `hw`, server tự gắn máy. `LicenseMode=online` | Admin/tool tạo **giấy phép** theo ID máy (`*.license.json`) + kit có type/widget; khách chép vào máy, PC tự kiểm. `LicenseMode=offline` |
| **Mua sẵn** (chỉ topic MQTT) | Tool nạp QR + topic. Không kích hoạt. | Không hỗ trợ (cần cloud). |

- Tool: `GatewayProvisioner` chọn *Loại gateway* + *không internet*, hoặc headless `--kind mcu|pc|generic --offline true|false`. Link `file:C:\kit\gw01.json` ghi kit (và `gw01.license.json` nếu có giấy phép).
- Server: `POST /api/v1/factory/provision` nhận `kind` + `connectivity`; trả `plan`, `licenseFile` (PC offline), `offline` (type/widget của thiết bị con).
- Gateway PC (`scada/src/Plciot.Scada.Services/GatewayActivation.cs`): `ScadaConfig.LicenseMode` = `none` (mặc định, không đổi hành vi cũ) | `online` | `offline`; `ScadaHost.StartAsync` ném `LicenseRequiredException` (kèm ID máy) khi chưa được phép. ID máy = băm MachineGuid/`/etc/machine-id`, 12 ký tự.
- Giấy phép có hạn: gateway lưu mốc chạy gần nhất (`license.json.seen`) để phát hiện chỉnh lùi đồng hồ.
