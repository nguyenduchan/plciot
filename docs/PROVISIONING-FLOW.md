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

## Ghép cặp gateway bằng mã admin (gateway chưa đăng ký)

Gateway tự khai thiết bị + setting + UI (GatewayApp) nhưng **không tự đăng ký**: admin phát mã, gateway gửi bản khai kèm mã.

1. Admin (`admin.html` → *Ghép cặp gateway*) bấm **Tạo mã ghép cặp** → mã `XXXX-XXXX` (dùng một lần, hết hạn ~15 phút, tối đa 10 mã mở / admin; server chỉ lưu hash).
2. Người lắp đặt nhập mã vào GatewayApp (trang **Cloud** → *Mã ghép cặp* → **Gửi bản khai cho admin**).  
   Gateway `POST /api/v1/gateway/pair { code, fp, config }` — `config` = đúng bản tin `<base>/config` (devices, fields, khoá MQTT, icon, màu, chữ Bật/Tắt, ngưỡng); `fp` = vân tay ngắn của gateway để admin đối chiếu.
3. Admin xem trước bản khai (đánh dấu *chưa xác thực*), nhập site + mã tem → **Duyệt & tạo QR**: server tạo `hardware_devices` (profile `iot-hub`, seed `type: dynamic`), lưu `gateway_configs`, trả QR.
4. Gateway dán QR vào ô *Mã QR của tem* → **Enroll**: nhận site/device/MQTT; field đã khai báo cục bộ (giao thức, thanh ghi D, khoá MQTT) được giữ nguyên.
5. User quét cùng QR trên webapp → `user_devices` (type `dynamic`) → thấy đúng UI gateway đã khai.

Chống spam: mã sai / hết hạn / đã dùng / đã khoá trả **cùng một lỗi** `invalid_pairing` (không ghi DB, không báo admin); giới hạn tốc độ theo IP (`RATE_LIMIT_GATEWAY_PAIR`) + toàn cục (`RATE_LIMIT_GATEWAY_PAIR_GLOBAL`); mỗi mã nhận tối đa 5 lần gửi; bản khai ≤ `POLICY_MAX_CONFIG_BYTES` và đi qua `sanitizeConfig`.

Kiểm thử: `cloud/app/scripts/smoke-gateway-pairing.js`; GatewayApp `--pairtest <thư mục>` (thêm thiết bị bằng hộp thoại thật → gửi bản khai → enroll).
