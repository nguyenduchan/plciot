# Gateway no-code (mua sẵn, chỉ cấu hình)

> Trạng thái: giám sát + điều khiển đã làm, **hỗ trợ trước USR-M100** (relay trên thân máy); hãng/model khác chưa làm. **Cài đặt CHỈ qua GatewayApp (C#)** — webapp KHÔNG có giao diện no-code
> (đã gỡ phần đã làm trên webapp). Gateway mua sẵn nối THẲNG VPS; GatewayApp chỉ dùng lúc cài đặt. Chưa thử với gateway thật.
> Giai đoạn 2–3 vẫn là thiết kế.
> Mã: `cloud/app/src/nocode.js` (tạo, ingest, route), `nocodeMap.js` (ánh xạ thuần); GatewayApp: `Pages/NocodePage.cs`,
> `MainForm.Nocode.cs`, `NocodeDraft.cs`; client `GatewayEnrollClient.NocodeAsync`.
> Test: `node cloud/app/scripts/smoke-nocode.js`; ACL trên broker thật: `bash cloud/scripts/test-broker-acl.sh` (gateway C).

## 0. Giai đoạn 1 — đã làm (khác thiết kế ban đầu ở đâu)

| Mục | Thực tế |
|---|---|
| Ai tạo | **GatewayApp** (gateway PC đã đăng ký + đã có chủ), trang **Gateway mua sẵn** → *+ Thêm*: gateway PC bắt tay với VPS bằng khoá máy, server tạo gateway no-code cho **chủ của gateway PC** (`gateway_unclaimed` nếu PC chưa có chủ). Sửa cần mật khẩu gateway (`RequireEdit`). Admin bị từ chối (`admin_cannot_own`). Gateway no-code không tự làm gateway PC được. |
| Hạn mức | Tính chung số gateway của gói (`userGatewayLimit`, đếm tem `claimed_by`). |
| Điều khiển | Giai đoạn 1 không. Giai đoạn 4 (mục 6): chỉ khi ánh xạ có `control` + field có `point`; gateway đọc `cmdraw`, ghi `ackraw`, không bao giờ đọc `cmd`. |
| Tài khoản phát lại | Dùng luôn user **`ctl`** của server (thêm quyền ghi `gw/+/{telemetry,status,config}`), không tạo user `norm` (không phải cấp mật khẩu broker mới). |
| DB | Bảng `nocode_gateways(site, device, owner_id, map_json, map_rev, …)` — **không** thêm cột vào `hardware_devices`. Schema v8. |
| Telemetry | Server phát `{schema:2, ts, d}` retain lên `<base>/telemetry`; bản tin đó quay lại ingest như mọi gateway (lưu lịch sử, gói, webapp live) — không có đường lưu thứ hai. Ingest tin telemetry của id no-code vì ACL chỉ cho `ctl` ghi. |
| Giao diện | Lưu ánh xạ → `applyGatewayConfig` ngay + phát retain `<base>/config` (không có `path`) → webapp đang mở tự dựng lại. |
| Soạn ánh xạ | GatewayApp, trang **Gateway mua sẵn**: danh sách, bản tin gần nhất, ô JSON (*Tạo nháp từ bản tin*: mọi giá trị số → field), **Xem thử**, **Lưu ánh xạ**, *Thông số kết nối*, *Xoay mật khẩu*, *Lưu file CA…*. Chỉ gateway PC đã TẠO gateway no-code mới quản lý được nó (`parent_site/parent_device`). |
| Topic con `raw/<x>` | Chưa hỗ trợ (chỉ `gw/<id>/raw`). |
| `last_ip` / cảnh báo đổi IP | Chưa làm (MQTT không cho ingest biết IP người gửi). |
| CA | `GET /api/nocode/ca.crt` đọc `DATA_DIR/mqtt-ca.crt` (hoặc `MQTT_PUBLIC_CA_FILE`), chỉ trả khối `CERTIFICATE`. **Phải đặt file này trên VPS một lần** (mục 8). Chưa có file → phiếu chỉ hiện SHA-256. |
| Ánh xạ cache | 30 s trong ingest; lưu map thì xoá cache ngay. Bản tin gần nhất + trạng thái online chỉ trong bộ nhớ (mất khi khởi động lại server — status retain trên broker vẫn đúng, server tự báo offline nếu sau đó gateway im lặng). |

Biến môi trường (tuỳ chọn): `NOCODE_REPUBLISH_MS` (10000), `NOCODE_OFFLINE_MIN_MS` (90000), `NOCODE_RAW_PER_MIN` (120), `MQTT_PUBLIC_CA_FILE`.

Route (chỉ GatewayApp, body `{site, device, pubkey, ts, sig}` của gateway PC, `gatewayAuth`): `POST /api/v1/gateway/nocode/list` (ký `nocode-list`),
`…/create {name}` (`nocode-create`), `…/get|preview|map|rotate {target, …}` (ký `nocode-<op>-<target>` — gắn với đúng gateway đích).
Công khai: `GET /api/nocode/ca.crt`. Không còn route dùng phiên webapp. Kiểm chéo chữ ký C#↔Node: `NocodeClientTests` (`NOCODE_FIXTURE_OUT`).

## 1. Mục tiêu và phạm vi

Gateway công nghiệp bán sẵn (Teltonika TRB/RUT, Milesight UG/UC, USR-IOT, Robustel, Advantech…) chỉ cho
**cấu hình**: broker, cổng, TLS/CA, user/pass, client ID, topic, mẫu JSON (đôi khi), chu kỳ gửi, LWT. Chúng
không chạy được code của ta: không có khoá ECDSA, không kiểm chữ ký lệnh, không gửi `config`, payload theo
định dạng riêng của hãng.

Mục tiêu: chủ trạm **tự thêm** loại gateway này (qua GatewayApp), thấy dữ liệu trên **cùng dashboard** như gateway
PC/board, và (tuỳ gateway) **điều khiển** được — **không sửa webapp/C# phía hiển thị, không đổi hợp đồng
`gw/<mqttId>/telemetry`**.

Ngoài phạm vi: chương trình logic, OTA, sao lưu, cài đặt từ xa (GatewayAdmin), bù dữ liệu kiểu `bf` của GatewayApp,
gateway chỉ có TLS < 1.2.

## 2. Ý tưởng chính: chuẩn hoá ở server, republish đúng hợp đồng cũ

```
gateway no-code ──mqtts──▶ gw/<id>/raw   (payload của hãng)
                                │  ingest (user `ingest` đọc raw)
                                ▼
                     nocodeMap: áp ánh xạ → { schema:2, d:{child:{field:số}} }
                                │  ghi history như telemetry thường
                                ▼
           user `ctl` publish gw/<id>/telemetry (retain) + gw/<id>/status
                                │
             webapp / app C# đọc như mọi gateway khác (không đổi)

lệnh: webapp → /api/control/cmd (step-up, whitelist, toggleMs như cũ)
      → nocodeCmd: lệnh field → mẫu lệnh của hãng → gw/<id>/cmdraw (KHÔNG ký)
```

Vì sao republish thay vì để webapp đọc `raw`: webapp đọc live **trực tiếp từ broker**, nên chuẩn hoá chỉ ở DB là
không đủ. Republish giữ nguyên một shape telemetry (quy ước trong CLAUDE.md), webapp và C# không biết gateway
là loại gì.

Đây là **ngoại lệ có chủ đích** với nguyên tắc "đã bỏ ingest map" (`telemetryNormalize.js`): ánh xạ chỉ áp cho
gateway `kind = 'nocode'`, và mọi gateway của ta vẫn phải đóng gói đúng `pack[]`.

## 3. Đăng ký (tạo tem không cần khoá máy)

Bảng `GATEWAY_KINDS.generic` trong `gatewayKinds.js` đã mô tả loại này (`activation: none`) nhưng chưa nơi nào dùng —
dùng lại tên `nocode` cho rõ.

GatewayApp → **Gateway mua sẵn** → *+ Thêm* (mật khẩu gateway):
1. `POST /api/v1/gateway/nocode/create { name }` ký khoá gateway PC; chủ = chủ của gateway PC; tính vào hạn mức gói,
   rate-limit 60/phút/IP.
2. Server tạo, trong **một transaction**:
   - `hardware_devices`: site `u<id>`, device = `gatewayIdFor` với hw = `nc` + 18 ký tự ngẫu nhiên (không suy từ
     phần cứng vì không có khoá), `claimed_by = user` ngay (người tạo là chủ, không cần quét QR),
     `gw_pubkey = NULL`; dòng `nocode_gateways` ghi gateway PC đã tạo (`parent_site/parent_device`).
   - `devices`: `mqtt_user`, `mqtt_pass`, `mqtt_id` như `provisionDevice`.
3. Trả **một lần** "phiếu cấu hình": host, cổng, user, mật khẩu, client ID gợi ý, các topic, file CA để tải, mẫu
   payload. Mật khẩu không hiện lại; muốn xem lại thì **xoay** (mật khẩu gateway, gateway mua sẵn cũ bị cắt).
4. Thu hồi / xoá / chuyển chủ dùng lại đường hiện có (`gatewayTransfer.js`, `hwBlock.js` theo hw giả).

Không có ràng buộc phần cứng → **mật khẩu MQTT là bí mật duy nhất**. Bù lại:
- chỉ cho kết nối **MQTTS** (không thêm dòng ACL của gateway nocode vào `acl-monitor`, tức cổng 1883 trơn bị chặn);
- server ghi `last_ip` của raw; đổi IP/ASN bất thường → thông báo chủ (không chặn, gateway 4G hay đổi IP);
- nút "Xoay mật khẩu" và "Tạm khoá" trên thẻ gateway.

## 4. Topic và ACL

| Topic | Ai ghi | Ai đọc | Ghi chú |
|---|---|---|---|
| `gw/<id>/raw` | gateway nocode | `ingest` | payload của hãng, ≤ 16 KB |
| `gw/<id>/status` | gateway (LWT) **và** `ctl` | `ingest`, user | gateway đặt LWT `offline`; `ctl` tự phát `online` |
| `gw/<id>/cmdraw` | `ctl` | gateway nocode | lệnh đã dịch sang định dạng hãng |
| `gw/<id>/ackraw` | gateway nocode (nếu có) | `ingest` | phản hồi lệnh của hãng |
| `gw/<id>/telemetry` | **chỉ `ctl`** | user | gateway nocode KHÔNG được ghi (chống giả shape) |

- User `ctl` của server (listener nội bộ 1884) được thêm `topic write gw/+/telemetry`, `gw/+/status`, `gw/+/config` (giai đoạn 4 thêm `ack`).
- `deviceAclBlock` tách theo kind: nocode chỉ có raw/status/ackraw (ghi) + cmdraw (đọc).
- `mqttIngest.processMessage` thêm `raw`, `ackraw` vào danh sách kind.
- **Client ID**: Mosquitto không ràng buộc được client ID theo user; gợi ý `nc-<id>` cho dễ tra log.

## 5. Ánh xạ payload (`nocode_gateways.map_json`)

Một bản / gateway, có phiên bản (`map_rev`). Dạng = đúng bản tin `config` (devices/fields) + thuộc tính trích xuất
trên từng field, nên phần hiển thị dùng lại `sanitizeConfig`:

```json
{
  "v": 1,
  "mode": "object",
  "ts": "$.time",
  "devices": [
    { "id": "bom1", "name": "Bơm 1", "fields": [
      { "key": "dong", "lbl": "Dòng điện", "unit": "A", "widget": "gauge", "min": 0, "max": 50, "path": "$.data.I1", "scale": 0.1 },
      { "key": "chay", "lbl": "Chạy", "widget": "led_status", "path": "$.data.DI1" } ] },
    { "id": "bon", "name": "Bồn", "fields": [
      { "key": "muc", "lbl": "Mức", "unit": "%", "widget": "ring", "path": "$.sensors[0].val" } ] }
  ]
}
```

- **Đường dẫn**: tập con JSONPath tự viết — `$`, `.ten`, `[số]`, `['ten có cách']`. **Không** filter, wildcard,
  biểu thức, `eval`. Độ sâu ≤ 8.
- **`mode: "list"`** cho hãng gửi mảng điểm (`{"values":[{"n":"I1","v":12}]}`): `"list": "$.values", "name": "n", "value": "v"`,
  khi đó field dùng `"name": "I1"` thay cho `path`.
- **`topicKey`** (tuỳ chọn): một số hãng gửi mỗi thanh ghi một bản tin; gateway đặt topic con
  `gw/<id>/raw/<x>` → ánh xạ theo `<x>`. ACL cho `gw/<id>/raw/#`.
- Biến đổi: chỉ `scale`, `offset`, `bool` (`"1"/"on"/true` → 1). Kết quả bắt buộc là số hữu hạn; lỗi → bỏ field
  đó, đếm vào `nocode_stats` để hiển thị "field không đọc được" trên trang ánh xạ.
- `ts` (giây, ms hoặc chuỗi ngày): cũ hơn hiện tại > 60 s → server phát `{bf:1, ts}` không retain → đường bù của
  ingest (`backfill.js`, cùng giới hạn retention); không có → giờ server nhận.
- Giá trị không đổi trong `NOCODE_REPUBLISH_MS` → không phát lại.
- Ràng buộc giống `config`: `child` `[A-Za-z0-9_-]{1,48}`, `key` `[A-Za-z0-9_]{1,32}`, ≤ 64 child × 32 field.
- **UI sinh từ ánh xạ**: lưu map → server dựng payload `config` (`lbl/unit/widget/min/max/writable/toggleMs`) và gọi
  thẳng `applyGatewayConfig` — không qua MQTT, gateway không cần gửi `config`.
- **Preset** (`cloud/app/src/nocodePresets.js`): khung `mode/path/cmd` cho từng hãng phổ biến + "JSON phẳng"
  (`{"I1":12,"DI1":1}`). Chọn preset rồi chỉ điền tên field.

### Soạn ánh xạ trên GatewayApp

Trang **Gateway mua sẵn** (bản đầy đủ của GatewayApp; sửa cần mật khẩu gateway):
1. "Bản tin gần nhất": server giữ **1 bản raw mới nhất** / gateway (bộ nhớ, không vào DB).
2. *Tạo nháp từ bản tin* (`NocodeDraft`): mọi giá trị số/bool → field `kpi` của một thiết bị; chủ trạm sửa tên, đơn vị, widget.
3. *Xem thử* áp map lên bản tin đó (server, không lưu). *Lưu ánh xạ* → `rev+1`, audit `nocode_map`, webapp tự dựng lại.

Chọn bằng click trên cây JSON (thay cho ô JSON) để giai đoạn 2.

## 6. Điều khiển — ĐÃ LÀM cho USR-M100 (preset `usr_rw_prot`)

Bật bằng ánh xạ (chủ trạm, step-up khi lưu):

```json
{ "control": "usr_rw_prot",
  "devices": [{ "id": "bom1", "name": "Bơm 1", "fields": [
    { "key": "chay", "lbl": "Đang chạy", "widget": "led_status", "path": "$.DI1" },
    { "key": "lenh", "lbl": "Bật bơm", "widget": "switch", "writable": true, "point": "DO1", "path": "$.DO1", "fb": "chay", "toggleMs": 5000 } ] }] }
```

- `control`: `"usr_rw_prot"` hoặc `{ "preset": "usr_rw_prot", "valueType": "string"|"number", "timeoutMs": 1000–30000 }`
  (mặc định chuỗi — sổ tay M100 ghi `"value":"15"` — và chờ 8 s). Không có `control` → mọi `writable` bị bỏ (chỉ giám sát).
- Field ghi: `writable: true` + `point` = **tên điểm trên gateway** (bảng điểm của M100, vd. `DO1`). Không cần `path` nếu chỉ ghi;
  có `path` thì vừa đọc vừa ghi. `fb`, `toggleMs`, `min/max/step` như `config` thường. `point` không lộ ra webapp.
- Đường lệnh **giữ nguyên** `/api/control/cmd` (step-up, critical, limits, `toggleGuard`, ngân sách lệnh, audit).
  `publishCmd` → `setCmdInterceptor` (nocode.js) thấy id no-code → `renderCommand`:
  `{"rw_prot":{"Ver":"1.0.1","dir":"down","id":"<id lệnh>","w_data":[{"name":"<point>","value":"<v>"}]}}`
  → user `ctl` gửi `gw/<id>/cmdraw`, **QoS 0, không retain** (gateway mất mạng không nhận lại lệnh cũ).
  Chỉ thay `id`, `point` (đã lọc lúc lưu map), `v` (số đã qua limits) — không chèn chuỗi người dùng.
- **Không ký**: gateway của hãng không kiểm được. Chỉ `ctl` ghi được `cmdraw` (ACL). Webapp nhắc trong ⚙ Ánh xạ khi bật.
- Phản hồi: M100 gửi `gw/<id>/ackraw` → `parseReply`: `dir:"up"`, `err` của gói và của từng `w_data` = `"0"` → ack
  `{id, ok:true}`; `err:"1"` → `write_failed` / `gateway_error`. Lỗi giao thức của hãng không có `id` → gán cho lệnh đang chờ
  CŨ NHẤT của gateway đó. Server phát ack chuẩn `gw/<id>/ack` → webapp hiển thị như mọi gateway.
- Không phản hồi trong `timeoutMs` → ack `{ok:false, err:"no_confirm"}` (sổ tay M100: lệnh sai có thể không được trả lời).
- Từ chối bằng ack lỗi (không gửi gì xuống gateway): `control_disabled`, `not_writable`, `not_supported` (lệnh đọc thanh ghi
  `op:read`, lệnh `a/v` kiểu cũ), `busy`. Lệnh hệ thống `{sys:"claimed"}` bị bỏ qua.
- Hàng chờ phản hồi chỉ trong bộ nhớ: server khởi động lại giữa chừng → lệnh đó không có ack (webapp tự hết giờ).

### Cấu hình USR-M100 (theo sổ tay USR-M100-HM, chưa thử trên máy thật)

GatewayApp → *Gateway mua sẵn* → **Mẫu USR-M100**: điền ánh xạ Relay 1–2 (ghi được) + Đầu vào 1–2 và chép mẫu báo dữ liệu
`{"DO1":"DO1","DO2":"DO2","DI1":"DI1","DI2":"DI2"}` vào clipboard (`NocodeDraft.M100Template` / `M100ReportTemplate`).

Trên trang web của M100:
1. **MQTT** (northbound): MQTT 3.1.1; server/cổng/user/mật khẩu/client ID theo phiếu cấu hình; *Clean session* bật;
   *Last will* `gw/<id>/status` = `offline`, retain; **SSL/TLS bật, Protocol = TLSv1.2**, nạp file CA (*Lưu file CA…*).
2. **IO / Edge gateway**: điểm tên `DO1`, `DO2` (coil 00001/00002, mã hàm 01), `DI1`, `DI2` (10001/10002, mã hàm 02) trên
   slave I/O của M100 (Modbus Slave ID đặt ở trang IO). Module mở rộng: DO3…, DI3…
3. **Data report**: kênh MQTT, topic `gw/<id>/raw`, gửi theo chu kỳ + khi đổi, mẫu như trên (thêm `"t":"sys_unix_time"`
   và ánh xạ `"ts":"$.t"` chỉ khi đã bật NTP).
4. **Protocol conversion**: JSON, topic nhận `gw/<id>/cmdraw`, topic trả lời `gw/<id>/ackraw`.
5. **IO function → Restart Hold: TẮT** — relay về mặc định (NC/hở) sau khởi động lại, không tự bật lại tải.
6. Tuỳ chọn: **Linkage control** (điểm vượt ngưỡng → đổi DO) chạy tại M100 kể cả mất mạng — cấu hình tay trên M100,
   hệ thống KHÔNG quản lý/không thấy luật này.

Cần kiểm trên máy thật: cách gắn điểm DO/DI của chính M100 trong mục Edge gateway, `value` chuỗi được nhận, TLS 1.2 với
bộ mã ECDHE-GCM của cổng 48263, trạng thái relay khi mất điện / mất mạng.
Model: sổ tay dùng là **USR-M100-HM** (ghi rõ TLSv1.2); bản thông số USR-M100 cũ chỉ ghi "SSL v3" — mua đúng bản có TLSv1.2.

Chưa làm: hãng/model khác (Teltonika, Milesight, Shelly, N720 chưa thử), xác nhận bằng đọc lại cho hãng không có phản hồi.

## 7. Trạng thái và cảnh báo

- Online: bất kỳ `raw` hợp lệ → nếu đang offline thì `ctl` phát `status=online` (retain).
- Offline: LWT của gateway (`offline` trên `gw/<id>/status`), **hoặc** im lặng quá `max(3 × chu kỳ ước lượng, 90 s)`
  → `ctl` phát `offline`. Chu kỳ ước lượng = trung vị khoảng cách 20 bản tin gần nhất.
- Cảnh báo ngưỡng: gateway của ta tự tính (`AlertEngine`); nocode thì **server tính** từ `lo/hi` trong map, cùng
  quy tắc (báo khi chuyển mức, ≥ 5 phút cùng mức) → `forwardGatewayAlert`. Viết thành hàm dùng chung, đặt ở
  `pushAlerts.js`.

## 8. TLS

- MQTTS hiện tại (`:48263`) dùng chứng chỉ **tự ký**, gateway của ta ghim SHA-256. Gateway no-code: phiếu cấu hình
  cho tải file CA (chính chứng chỉ đó). Gateway kiểm tên máy theo IP có thể lỗi nếu SAN không có IP (`MQTT_PUBLIC_IP`).
- Đặt file CA trên VPS (một lần, và mỗi lần đổi chứng chỉ — docs/MQTT-CERT-ROTATION.md): lấy phần chứng chỉ của
  `/tmp/mqtt.pem` trong container HAProxy ghi vào `cloud/app/data/mqtt-ca.crt`, ví dụ
  `docker exec <haproxy> sh -c "openssl x509 -in /tmp/mqtt.pem" > /root/plciot/cloud/app/data/mqtt-ca.crt`.
  Server chỉ trả khối `CERTIFICATE` dù file lỡ chứa khoá.
- **Đề xuất**: thêm frontend HAProxy cổng riêng (vd. `:48264`) dùng chứng chỉ **Let's Encrypt** cho
  `mqtt.dieukhientudong.net` → gateway nocode dùng kho CA sẵn có, không phải nạp file. Không đụng cổng cũ nên
  không ảnh hưởng ghim chứng chỉ của gateway PC/board. Cần gia hạn tự động và reload HAProxy.
- Giữ `ssl-min-ver TLSv1.2`; ghi rõ trong phiếu: gateway chỉ có TLS 1.0/1.1 → không hỗ trợ.

## 9. DB (schema v8, chỉ THÊM)

- `nocode_gateways(site, device, owner_id, map_json, map_rev, created_at, updated_at, PRIMARY KEY(site, device))`.
  Gateway no-code = tem thường (`hardware_devices`, `activated_hw = nc…` ngẫu nhiên, `gw_pubkey` NULL) + một dòng ở đây.
- Số liệu "field không đọc được", bản tin gần nhất: chỉ bộ nhớ (chưa có bảng thống kê).
- `DB_SCHEMA_VERSION` = 8; `smoke-db-compat.js` phải qua. Gateway PC/board cũ không bị ảnh hưởng vì không
  có route/topic nào cũ đổi nghĩa → **không** tăng `GATEWAY_API_LEVEL`.

## 10. Tải và giới hạn

- Chuẩn hoá chạy trong `mqttIngest` (cùng tiến trình): parse ≤ 16 KB + ≤ 2048 path đơn giản → không đáng kể.
- Dùng lại bucket `evaluateIngest` theo gateway; `raw` dày hơn `POLICY_*` → bỏ như telemetry.
- `ctl` republish **chỉ khi có field đổi** hoặc theo nhịp 10 s, để không nhân đôi lưu lượng tới webapp.

## 11. Chia giai đoạn

| Giai đoạn | Nội dung | Kiểm thử |
|---|---|---|
| 1. Giám sát — **đã làm** | schema v8, tạo gateway no-code + phiếu cấu hình, ACL `raw` + `ctl` phát thay, map `object`/`list`, UI sinh từ map, status | `smoke-nocode.js` (ánh xạ + DB + ACL file), `test-broker-acl.sh` (gateway C trên broker thật — chưa chạy vì máy dev không có Docker) |
| 2. Trang ánh xạ GatewayApp (chọn bằng click) | cây JSON bản tin, click chọn path thay ô JSON | thử tay với 1 gateway thật (đề xuất Teltonika hoặc Milesight đang có) |
| 3. Cảnh báo + TLS LE | ngưỡng phía server, frontend `:48264` | ca chuyển mức + chặn lặp 5 phút |
| 4. Điều khiển — **đã làm (USR-M100)** | preset `usr_rw_prot`, `cmdraw`/`ackraw`, hết giờ → `no_confirm` | `smoke-nocode.js` mục 3, `smoke-mqtt-id-broker.js` (cmdraw/ackraw trên broker thật) |

## 12. Câu hỏi còn mở

Giai đoạn 1 đã chọn mặc định: chủ trạm tự tạo, tính chung hạn mức gói, chỉ giám sát. Còn:
1. Có làm cổng MQTTS Let's Encrypt riêng (giai đoạn 3) không?
2. Gateway cụ thể nào dùng làm mẫu thử đầu tiên?
