# Cài đặt board Waveshare bằng điện thoại (kỹ thuật viên, không cần laptop)

Hai tầng tách biệt:

| Ai | Ở đâu | Làm gì |
|---|---|---|
| Kỹ sư (bạn) | **GatewayAdmin → 📚 Thiết bị mẫu** | Khai báo bảng thanh ghi MỘT LẦN cho mỗi model (FC, địa chỉ, kiểu, thứ tự byte, hệ số, đơn vị, hiện/ẩn, đọc thử) → lưu lên server |
| Kỹ thuật viên lắp tủ | Trình duyệt điện thoại → `https://<IP board>/m` | Cổng RS485 (baud, khung, chu kỳ) · thêm thiết bị = chọn loại + Slave ID + tên · đặt tên DI/DO · đọc/ghi thử |

Kỹ thuật viên không bao giờ thấy địa chỉ hex, mã lệnh hay kiểu dữ liệu.

## Luồng

```
GatewayAdmin ──PUT /api/v1/radmin/templates/:id (ký khoá máy)──▶ server: bảng device_templates
board ──GET /api/v1/device-templates?since=<rev> (304 nếu không đổi)──▶ /tpl.json trên flash
điện thoại ──https://<IP>/m──▶ board: /api/m/*  ──▶ chép field vào cấu hình board (ApiConfig, như GatewayApp)
```

- Board tải lại danh sách mỗi lần kỹ thuật viên mở "Thêm thiết bị" → kỹ sư sửa mẫu là thấy ngay. Mất mạng → dùng bản đã lưu.
- Thiết bị đã thêm KHÔNG phụ thuộc server: cấu hình nằm trên board (Pack/Fields/Devices, `Devices.<child>.Model` = mã mẫu).
  Sửa mẫu không đổi thiết bị đang chạy; bấm **Sửa → Lưu** trên điện thoại để áp mẫu mới (giữ child → khoá MQTT, lịch sử không đổi).
- Xoá mẫu trên GatewayAdmin = ẩn khỏi danh sách (lưu lại để dùng lại).
- Mẫu khởi đầu (nháp, kiểm lại theo tài liệu hãng): `tools/GatewayAdmin/templates/*.json` → nút **⇩ Nhập JSON**.

## Đăng nhập + bảo mật

- Chỉ qua **HTTPS** (chứng chỉ tự ký của board → trình duyệt cảnh báo một lần, bấm *Nâng cao → Tiếp tục*). Cổng 80: trang trạng thái có nút
  "📱 Cài đặt bằng điện thoại" dẫn sang HTTPS; `/api/m/*` qua cổng 80 bị từ chối.
- **Nhấn nút BOOT** trên board (cửa sổ cài đặt 10 phút; board mới chưa có PC quản trị thì mở sẵn 10 phút sau khi cấp điện) → nhập tên → **phiên kỹ thuật viên**
  (tối đa 3, rảnh 30 phút thì hết). Khác ghép PC: KHÔNG xoá dữ liệu chủ cũ, nhưng phạm vi hẹp — chỉ `/api/m/*`: cổng RS485, thiết bị RS485/DI/DO, đọc/ghi thử.
  Không thấy/đổi cloud, chương trình logic, PC quản trị, mạng, firmware, nhật ký (`/api/config`… trả 401).
- Mỗi lần kỹ thuật viên đăng nhập → cảnh báo đỏ về điện thoại chủ trạm (`sec.tech_login`); mọi thay đổi ghi nhật ký sự kiện kèm tên kỹ thuật viên.
- PC quản trị đã đăng nhập (token GatewayApp) cũng gọi được `/api/m/*`.
- Ghi thử đi qua đúng đường ghi thật: Min/Max, chỉ đọc, thời gian tối thiểu bật/tắt DO, chế độ an toàn, chương trình logic vẫn chặn.

## Gắn board vào tài khoản chủ trạm (tab "Tài khoản")

Giản lược "Đăng ký" của GatewayApp — điện thoại KHÔNG nhập mật khẩu:
1. KTV bấm **Lấy mã gắn tài khoản** → board gọi `POST /api/v1/gateway/login/start` (giữ `deviceCode` trong RAM), điện thoại chỉ thấy mã 8 số + link.
2. Chủ trạm mở link (`gateway-login.html?code=…`) — trên chính điện thoại KTV nếu đứng cạnh, hoặc nút "Gửi cho chủ trạm" — đăng nhập như thường
   (Face ID / TOTP) rồi **Duyệt**.
3. Board hỏi `login/poll` → token đăng ký 30 phút → tự ký `register|uid|ts` bằng khoá của board (giống GatewayApp đăng ký board) → server cấp tem +
   MQTT, bật cloud; thiết bị KTV đã cài hiện trên app chủ trạm. Board đang thuộc tài khoản khác → server tạo yêu cầu chuyển chủ (chủ cũ duyệt).
- Chỉ KTV tại chỗ (không qua GatewayAdmin). "Hoàn tất lắp đặt" khi chưa gắn tài khoản → hỏi lại.
- Cài đặt chuyên sâu (logic biên, cloud, mạng, cấu hình field tự do): GatewayApp (LAN) và GatewayAdmin (từ xa) như cũ.

## GatewayAdmin cài cùng kỹ thuật viên (📱 Cài đặt hiện trường)

GatewayAdmin → chọn board → **📱 Cài đặt hiện trường** (`tools/GatewayAdmin/FieldSetupForm.cs`): thấy đúng những gì KTV đang cài (cổng, thiết bị RS485,
DI/DO + trạng thái, giá trị, KTV nào đang đăng nhập, ai sửa gần nhất) và sửa được — gọi cùng `/api/m/*` qua relay MQTT (chủ trạm phải bật
"Cho phép hỗ trợ từ xa"). Tự làm mới mỗi 4 giây.
- Từ xa được: xem, cổng RS485, thêm/sửa/xoá thiết bị RS485, đặt tên DI/DO, **đọc thử**. Chỉ tại chỗ: ghi thử, bật/tắt DO, hoàn tất, gắn tài khoản.
- Board chỉ cho sửa từ xa khi cài đặt hiện trường đang BẬT (đang lắp đặt); đã tắt → chỉ xem, nút **⏻ Bật cài đặt hiện trường** mở lại.
- Hai nơi sửa cùng lúc: mỗi lần lưu tăng `Rev` cấu hình; lưu với `Rev` cũ → 409 `rev_conflict` ("GatewayAdmin (PC kỹ sư) vừa sửa (…) — đã tải lại"),
  bên kia tải lại rồi làm lại. Điện thoại tự vẽ lại + báo "… vừa sửa: …" khi thấy `Rev` đổi; `LastChange` trong `/api/m/state`.
- Thêm loại thiết bị mới lên server: **📚 Thiết bị mẫu** (ở trên).

## Tắt khi chạy thật

- Kỹ thuật viên bấm **✓ Hoàn tất lắp đặt** → NVS `m_off`: `/m` hiện "đã tắt", đăng nhập bị từ chối **kể cả khi nhấn BOOT**, phiên đang mở bị huỷ.
- Bật lại: PC quản trị `PUT /api/mobile {"Enabled":true}` qua LAN, hoặc **GatewayAdmin → 📱 Cài đặt hiện trường → ⏻ Bật** (relay, chủ trạm phải bật
  "Cho phép hỗ trợ từ xa"). `GET /api/mobile` xem trạng thái. Bật/tắt ghi nhật ký sự kiện (bật lại = cảnh báo chủ trạm).
- Reset board (giữ BOOT 10 giây) KHÔNG đổi cờ này.

## Định dạng mẫu (`cloud/app/src/deviceLibrary.js`)

```json
{ "id": "invt-gd20", "name": "Biến tần INVT GD20", "brand": "INVT", "model": "GD20", "icon": "vfd", "note": "",
  "serial": { "baud": 9600, "parity": "Even" }, "test": ["f", "a"],
  "fields": [ { "key": "f", "label": "Tần số ngõ ra", "access": "r", "fc": 3, "addr": 12288, "type": "UInt16", "order": "AB",
                "scale": 100, "unit": "Hz", "kind": "gauge", "min": 0, "max": 50, "show": true, "wfc": 16, "on": "", "off": "" } ] }
```

- `access` r / rw / w · `fc` 3 (holding) / 4 (input, chỉ đọc) · `addr` 0–65535 (địa chỉ PDU, 40001 → 0) · `type` UInt16 Int16 UInt32 Int32 Float32 Float64 Bool
- `order`: 16 bit AB / BA; 32–64 bit ABCD / CDAB (đảo word) / BADC (đảo byte) / DCBA · `scale` = hệ số CHIA (giá trị = thô ÷ scale)
- `wfc: 16` = luôn ghi bằng FC16 (thiết bị không nhận FC06); mặc định 1 word → FC06, nhiều word → FC16
- Nút Chạy/Dừng kiểu biến tần (chỉ `kind: toggle`, kiểu 1 thanh ghi): `von` / `voff` = số thô ghi khi Bật / Tắt (vd GD20 2000H: 1 / 5, thay cho 1 / 0);
  `raddr` = đọc trạng thái ở thanh ghi khác (vd 2100H) — có `raddr` thì field tự thành đọc-ghi; `ron` = số thô nghĩa là "đang bật" (mặc định = `von`), khác → 0.
  Board báo 1/0 cho webapp; ghi giá trị khác 0/1 bị chặn. Trên board: `Params.raddr/von/voff/ron`. GatewayApp/GatewayAdmin lưu từ trang Thiết bị vẫn GIỮ các
  khoá Params riêng này (và `Devices.<child>.Model`).
- `show` = dấu tích mặc định "hiện trên app chủ xưởng" (bỏ tích = không đọc, không tốn đường truyền) · `test` = tối đa 3 thông số hiện khi "Đọc thử"
- Trên board: `Params.fc`, `Params.wfc`, `Params.bswap` của Pack (gateway PC giữ nguyên nhưng CHƯA dùng — chỉ firmware Waveshare đọc FC04/đảo byte/ép FC16).
  Vòng đọc tự gom thanh ghi gần nhau (≤ 8 word cách, ≤ 100 word/lần, tách FC03/FC04).

## Chống cài nhầm (trên trang điện thoại)

- Trùng Slave ID trên cùng cổng → viền đỏ + "Địa chỉ ID 1 đã dùng cho Quạt hút 1, vui lòng chọn số khác (gợi ý: ID 2)" (board kiểm lại, trả 409 + `Suggest`).
- Trùng kênh DO/DI giữa hai thiết bị → báo trùng.
- Mẫu có baud/khung khác cổng hiện tại → nhắc "mọi thiết bị trên cùng dây phải cùng tốc độ".
- Đọc thử lỗi → câu chẩn đoán: không trả lời (dây A+/B-, ID, baud), nhiễu/CRC (baud, parity, điện trở cuối), sai địa chỉ (mẫu không hợp model).

## Giới hạn hiện tại

- Chỉ RS485 (Modbus RTU) và DI/DO của board. Modbus TCP, coil (FC01/05), mã lỗi dạng bitmask: chưa.
- Địa chỉ thanh ghi 0–65535 cho thiết bị Modbus (firmware, `ScadaConfig.Validate`, trang Thiết bị của GatewayApp); I/O board Unit 0 vẫn D0–D299.

## Thử

- Firmware (bản giả lập, không cần board): `.\gateway-mcu\build.ps1 -Sim` rồi `python tools\mobile_setup_test.py` (59 kiểm tra: HTTPS/cổng 80, BOOT, phạm vi phiên,
  tải mẫu/304/offline, GatewayAdmin qua relay + xung đột Rev, gắn tài khoản, FC03/04/06/16, CDAB, đảo byte, địa chỉ 0x3000, Chạy/Dừng ghi 1/5 + đọc 2100H, GatewayAdmin lưu cấu hình đầy đủ giữ thông số cloud, trùng ID/kênh, ẩn/hiện, DI/DO, hoàn tất → tắt).
- Server: `node cloud/app/scripts/smoke-device-library.js`.
- Trọn vòng thật (2026-11-28, biến tần GD20 giả `python tools/gd20_sim.py --port 5490` + gw-sim `SIM_RS485_TCP=127.0.0.1:5490` nối VPS thật):
  GatewayAdmin `--templateput KQ.txt --file templates/invt-gd20.json` (qua bảng 📚) → board tải mẫu từ server → KTV (API của trang `/m`) đặt cổng 19200 8E1, đọc thử,
  thêm "Bơm cấp nước 1", ghi thử → lấy mã → chủ trạm Duyệt trên `gateway-login.html` → board tự đăng ký, nối MQTTS → webapp: Chạy (2000H=1), 35 Hz (2001H=3500),
  thấy tần số/dòng, Dừng (2000H=5) → chủ trạm bật Hỗ trợ từ xa → `GatewayAdmin --fieldtest` (xem REMOTE-ADMIN.md). Trình duyệt tích hợp của Claude không mở được
  HTTPS tự ký của board, nên bước KTV gọi đúng API của trang thay vì bấm trên trang.
