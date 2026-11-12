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

## Cấp QR gateway: MỘT đường duy nhất (ghép cặp bằng mã admin)

Không còn tạo tem trực tiếp (`POST /api/admin/hardware`, form "Thêm thiết bị", factory API/GatewayProvisioner đã bỏ).
Gateway MCU/C# lấy MQTT + pack bằng `POST /api/v1/gateway/enroll { qr }` hoặc `GatewayEnrollClient.EnrollAsync(qr)`.

Gateway **chưa có cấu hình** vẫn ghép cặp được: gửi bản khai rỗng (`devices: []`), admin vẫn duyệt và cấp QR;
setting khai sau đó gateway publish retain lên `<base>/config` (server tự `applyGatewayConfig`).

**Tem chưa có user (chưa claim):** gateway chỉ đồng bộ setting (`config`) + `status`. Enroll/config trả `claimed:false` →
gateway đặt `CloudSendData=false`, KHÔNG publish `telemetry`/`history`, và hỏi lại `/gateway/config` mỗi 60 giây;
khi `claimed:true` mới bắt đầu gửi data. Server cũng im lặng bỏ `telemetry`/`history` của tem chưa claim (`mqttIngest`).

## Kích hoạt gửi data khi user quét QR (webapp chỉ nói chuyện với server)

1. User quét QR trên webapp → server ghi `claimed_by` (webapp không nối gateway).
2. Server **đẩy ngay** `{ "sys": "claimed" }` xuống `gw/<mqttId>/cmd` (qos 1) → gateway đặt `CloudSendData=true`, bắt đầu publish `telemetry`/`history`.
3. Dự phòng: gateway offline lúc đó thì tự hỏi `/gateway/config` mỗi 60 giây, thấy `claimed:true` là bật.
4. Data đi gateway → MQTT → `mqttIngest` (nay không còn bị bỏ) → DB/WebSocket → webapp.

## Vòng đời tem ghép cặp

- Enroll/config thất bại đều ghi audit `gateway_enroll_fail` (IP + tem + lý do). Quá `ENROLL_FAIL_MAX` (10) lần sai trong `ENROLL_FAIL_WINDOW_MIN` (15) phút → tem khoá tạm `enroll_locked` (429); máy thật đúng `hw` vẫn vào được.
- Tem ghép cặp quá `PAIRING_TEM_TTL_DAYS` (30) ngày chưa ai claim tự thu hồi (xoá tem + thu hồi MQTT, audit `tem_expired`); quét lúc khởi động rồi mỗi giờ.
- Trang admin hiện cả vân tay lẫn ID máy của bản khai; GatewayApp hiện ID máy lúc chưa đăng ký và trạng thái "chưa có user → chỉ đồng bộ setting".

## Runtime

1. Gateway enroll → lưu mqtt + `pack` + topics.
2. Publish `config` (retain). Có user rồi mới publish `topics.telemetry`; LWT `topics.status`; sub `topics.cmd`.
3. User quét QR → `user_devices` + dashboard (type → widget).
4. App bind `d[childId][field]` để monitor; nút control theo `widgets[].cmd`.

## Tài liệu

- [UI-CONTRACT.md](UI-CONTRACT.md) — widget / dashboard
- [DEVICE-IDENTITY.md](DEVICE-IDENTITY.md) — QR claim
- [PROTOCOL.md](PROTOCOL.md) — topic kinds

## Luồng chính (đơn giản nhất): nhập mã là xong

1. **Admin** nhập *site* ở trang admin (hoặc `/activate.html` trên điện thoại, cần Face ID) rồi bấm **Tạo mã** → mã `XXXX-XXXX` (dùng một lần, ~15 phút).
2. **Người lắp đặt** nhập mã vào GatewayApp (Cloud → *Mã ghép cặp* → **Kết nối bằng mã**). Không cần admin duyệt, không cần dán QR.
3. Gateway gửi **khoá công khai** + chữ ký + bản khai (có thể rỗng). Server tự duyệt: cấp tem, MQTT, `mqttId`, lưu khoá công khai, rồi **trả luôn kit** (site/device/MQTT/pack) + QR trong cùng phản hồi. Gateway tự áp cấu hình, nối cloud, publish `config` (và lại publish mỗi lần khởi động / đổi setting).
4. **User** quét QR (admin bấm *Hiện QR* trên trang admin hoặc trang kích hoạt) → server báo `{sys:claimed}` → gateway bắt đầu gửi data.

Mã **duyệt tay** (`auto:false` / không chọn site): gateway chỉ gửi bản khai; admin xem trước, đặt site/mã tem rồi *Duyệt & tạo QR* (mục dưới).

### Khoá công khai của gateway
- Gateway sinh cặp khoá **ECDSA P-256**, khoá riêng nằm trên máy (`ScadaConfig.GatewayKey`, mã hoá DPAPI khi lưu), **khoá công khai gửi server lúc ghép cặp** (`pubkey` = SPKI DER base64url).
- **ID máy `hw` = 20 ký tự Crockford đầu của SHA-256(SPKI)** — server tự tính, gateway không tự khai.
- Ghép cặp ký `pair|<MÃ chuẩn hoá>|<ts>`; `enroll`/`config` ký `<enroll|config>|<site>|<device>|<ts>` (site/device lấy từ QR). Chữ ký IEEE P1363, cửa sổ ±5 phút (`GATEWAY_PROOF_WINDOW_SEC`), mỗi chữ ký dùng một lần (chống phát lại).
- Server lưu khoá ở `hardware_devices.gw_pubkey`. Tem đã có khoá thì **bắt buộc chữ ký**: chỉ có ảnh QR thì không enroll, không lấy mật khẩu MQTT, không xoay mật khẩu. Tem cũ (không khoá) vẫn dùng `hw` như trước.
- Kiểm chéo C# ↔ Node: `GW_FIXTURE_OUT=<file> dotnet test scada/tests/Plciot.Scada.Tests --filter Xuat_fixture` rồi `node cloud/app/scripts/verify-cs-proof.js <file>`.

## Ghép cặp duyệt tay (gateway chưa đăng ký)

Gateway tự khai thiết bị + setting + UI (GatewayApp) nhưng **không tự đăng ký**: admin phát mã, gateway gửi bản khai kèm mã.

1. Admin (`admin.html` → *Ghép cặp gateway*) bấm **Tạo mã ghép cặp** → mã `XXXX-XXXX` (dùng một lần, hết hạn ~15 phút, tối đa 10 mã mở / admin; server chỉ lưu hash).
2. Người lắp đặt nhập mã vào GatewayApp (không cần có sẵn thiết bị nào) (trang **Cloud** → *Mã ghép cặp* → **Gửi bản khai cho admin**).  
   Gateway `POST /api/v1/gateway/pair { code, fp, config }` — `config` = đúng bản tin `<base>/config` (devices, fields, khoá MQTT, icon, màu, chữ Bật/Tắt, ngưỡng); `fp` = vân tay ngắn của gateway để admin đối chiếu.
3. Admin xem trước bản khai (đánh dấu *chưa xác thực*), nhập site + mã tem → **Duyệt & tạo QR**: server tạo `hardware_devices` (profile `iot-hub`, seed `type: dynamic`), lưu `gateway_configs`, trả QR.
4. Gateway dán QR vào ô *Mã QR của tem* → **Enroll**: nhận site/device/MQTT; field đã khai báo cục bộ (giao thức, thanh ghi D, khoá MQTT) được giữ nguyên.
5. User quét cùng QR trên webapp → `user_devices` (type `dynamic`) → thấy đúng UI gateway đã khai.

Ràng buộc máy: gateway gửi khoá công khai (xem trên), `hw` = băm khoá. Lần gửi đầu **khoá mã vào hw đó** (máy khác biết mã cũng không ghi đè, nhận lỗi chung `invalid_pairing`); khi admin duyệt, tem được gắn sẵn với hw (`activated_hw`). Từ đó `enroll`/`config` **bắt buộc** gửi đúng hw (`hw_required` / `device_already_activated`) và `rotateMqtt` chỉ chạy khi hw đã xác thực → chỉ có ảnh QR thì không lấy được mật khẩu MQTT hay xoay mật khẩu.

Chống spam: mã sai / hết hạn / đã dùng / đã khoá trả **cùng một lỗi** `invalid_pairing` (không ghi DB, không báo admin); giới hạn tốc độ theo IP (`RATE_LIMIT_GATEWAY_PAIR`) + theo dải /24 hoặc /64 (`RATE_LIMIT_GATEWAY_PAIR_NET`) + ngân sách lần THẤT BẠI toàn cục (`RATE_LIMIT_GATEWAY_PAIR_FAIL_GLOBAL`, hết ngân sách chỉ chặn mã sai, mã hợp lệ vẫn qua); mỗi mã nhận tối đa 5 lần gửi; bản khai ≤ `POLICY_MAX_CONFIG_BYTES` và đi qua `sanitizeConfig`.

Kiểm thử: `cloud/app/scripts/smoke-gateway-pairing.js`; GatewayApp `--pairtest <thư mục>` (thêm thiết bị bằng hộp thoại thật → gửi bản khai → enroll).

## Admin quét QR: chỉ xem thử, không thành chủ gateway

- Tài khoản **admin** quét/dán QR tem nào cũng chỉ vào **chế độ xem thử**: server dựng đúng giao diện user sẽ thấy nhưng **không** ghi `user_devices`, **không** đổi `notify_site/device`, **không** claim tem (không thành chủ).
- Webapp (`+ Thêm` → QR) với tài khoản admin hiện hộp "Xem thử (admin) — chưa gắn vào tài khoản" kèm các thẻ chỉ đọc.
- Trang admin có ô **Xem thử QR**: `POST /api/admin/qr-preview { qr }` (nhận chuỗi QR hoặc link `login.html?claim=…`), vẫn kiểm chữ ký + secret của tem nên không dò được cấu hình bằng cách đoán site/device.
- Chủ gateway là **user thường quét QR đầu tiên** (cơ chế claim hiện có).
