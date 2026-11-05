# Provisioning: tem QR → MQTT → monitor / control / UI

## Phân công

| Tầng | Việc | Không |
|---|---|---|
| **Gateway** | Gom + đóng gói số `d.<id>.<field>` | Phân loại, vẽ UI, chọn format tuỳ biến |
| **Server** | Type/seed trên tem → dashboard widgets + cmd whitelist | Đọc PLC/GPIO |
| **App** | Monitor / control / vẽ theo `/api/v1/ui/dashboard` | Đoán type từ MQTT |

**Một format MQTT telemetry:** `{ "schema": 2, "d": { "env1": { "t": 28.5 } } }`  
**Control:** publish `{base}/cmd` (whitelist server); ack `{base}/ack`.  
Gateway **không** quản lý “MQTT format” — chỉ publish đúng `pack[]` từ enroll.

## 4 kiểu kết nối (cùng tem)

| Kiểu | Lấy MQTT + pack |
|---|---|
| MCU firmware | `POST /api/v1/gateway/enroll` `{ "qr" }` |
| PC C# | `GatewayEnrollClient.EnrollAsync(qr)` |
| Hộp bán sẵn | Admin **Hiện MQTT (pass)** → dán host/user/pass/topic + `payloadExample` |
| Device lẻ | Tem loại `pump`/`env`/… (không `iot-hub`) + enroll/kit |

## Admin (một lần)

`admin.html` → site + mã tem + loại:

- **Hub:** `iot-hub` + danh sách con (`childId` + **type** cho UI).
- **Lẻ:** một loại (`pump`…) — mã tem = deviceId.

Server tự cấp MQTT. In tem QR (user claim + gateway enroll cùng QR).

## Runtime

1. Gateway enroll → lưu mqtt + `pack` + topics.  
2. Publish `topics.telemetry` = `payloadExample` shape; LWT `topics.status`; sub `topics.cmd`.  
3. User quét QR → `user_devices` + dashboard (type → widget).  
4. App bind `d[childId][field]` để monitor; nút control theo `widgets[].cmd`.

Đổi danh sách con: sửa seed admin → gateway `POST /api/v1/gateway/config` (cùng QR).

## Tài liệu

- [UI-CONTRACT.md](UI-CONTRACT.md) — widget / dashboard  
- [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md) — QR claim  
- [PROTOCOL.md](PROTOCOL.md) — topic kinds  
