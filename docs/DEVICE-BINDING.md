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
| **2. ACL topic** | User đó chỉ `write` đúng `iot/{tenant}/{site}/{device}/telemetry|…` (hoặc `plc/...`). Không giả topic của người khác. |
| **3. Ingest + gói** | App chỉ lưu khi `resolveSubscriber` tìm thấy device/user và (mặc định) **gói còn hạn**. |

Env:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `INGEST_REQUIRE_KNOWN` | `true` | Bỏ qua topic không có trong `devices` / `users` |
| `INGEST_REQUIRE_ACTIVE_SUB` | `true` | Bỏ qua nếu tenant/user hết hạn gói |

Quản lý trên web: **`/console.html`** (admin) — Gói, Thiết bị, Tenant, Database.

## Setup tương thích thiết bị công nghiệp / dân dụng

Chỉ cần client MQTT 3.1.1/5 hỗ trợ **TLS (MQTTS)** + username/password — hầu hết module IoT (ESP32, Quectel, SIMCom, gateway Advantech/USR, PLC có MQTT…) đều được.

### Tham số cấp từ Console → Provision

| Tham số | Ví dụ |
|---|---|
| Host / port | `mqtts://plc-mqtt.example.com:8883` |
| Username | `d_acme_plant1_gw01` |
| Password | (chuỗi cấp một lần) |
| Client ID | gợi ý từ provision hoặc `{device}-{serial}` |
| Topic telemetry | `iot/acme/plant1/gw01/telemetry` |
| Topic status (LWT) | `…/status` = `offline` retain |
| Topic cmd | subscribe `…/cmd` |
| Topic ack | publish `…/ack` |

Payload khuyến nghị: `{"schema":1,"ts":…,"r":[…]}` — thiết bị cũ chỉ gửi `{"r":[…]}` vẫn được.

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
