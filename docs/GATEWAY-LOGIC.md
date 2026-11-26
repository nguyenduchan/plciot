# Chương trình logic của gateway (gateway PC C# và board Waveshare)

> **Thứ tự triển khai:** logic chạy ổn định trên **gateway PC (C#)** trước (đã test với PlcSim), rồi mới áp dụng cho board Waveshare (firmware 0.3.9 đã viết, chưa phát hành).

## Gateway PC (C#)

- Engine: `scada/src/Plciot.Scada.Core/GatewayLogic.cs`. Nối vào đường lệnh duy nhất `ScadaCore.ExecuteKeyAsync`, nên mọi nguồn lệnh đều đi qua: màn hình gateway, webapp, LAN, chính chương trình.
- Chương trình ghi bằng `ControlSource.Logic`, nhịp 500 ms. Vẫn qua chặn bật/tắt quá nhanh (`MinToggleMs`) và giới hạn Min/Max.
- Đầu ra là **field ghi được** (`"Out": "<thiết bị>.<field>"`, tên field nội bộ). Điều kiện và `follow` theo field; không có DI.
- Text: `pump1.run: need tank1.level>=10, hold | block pump1.boost | maxon 30m | timer 06:00-06:30 | offline 2m: level tank1.level on<=20 off>=90`. Viết `x=1` là cách gọn của `x>=1`.
- "Mất mạng" = cloud đã bật mà không nối được, quá `DelaySec`. Gateway không bật cloud thì không bao giờ rơi vào trạng thái mất mạng.
- Giá trị đọc từ PLC kèm thời điểm **bắt đầu** vòng đọc: lệnh vừa ghi không bị kết quả đọc cũ đè lên (nếu bị đè, liên động sẽ hở trong một chu kỳ).
- GatewayApp:
  - Lưu chương trình vào `<config.json>.logic.json` (ghi nguyên tử), nạp lại mỗi lần gateway chạy.
  - API `GET/PUT /api/offline`, `POST /api/offline/test` (thử mất mạng, chỉ tại chỗ).
  - Đổi từ xa (rpc) thiếu `appr` thì trả `owner_approval_required`.
- **Trang "Logic" trong GatewayApp** (có cả ở bản khách): bảng đang chạy và đề xuất đang chờ. Chủ trạm **duyệt / từ chối ngay tại gateway** sau khi mở khoá (mật khẩu gateway hoặc đăng nhập webapp).
  - Duyệt: gateway áp dụng đúng chương trình server gửi kèm, rồi báo `POST /api/v1/gateway/logic/decide`. Route này ký bằng khoá gateway, chữ ký `logic-<approve|reject>-<id>|site|device|ts`, gắn với đúng đề xuất và đúng quyết định.
  - Lấy đề xuất: `POST /api/v1/gateway/logic/pending`, ký `logic-pending|…`.
- Test:
  - `dotnet test scada/tests/Plciot.Scada.Tests --filter GatewayLogicTests` (6 test).
  - PlcSim (bản Debug): `GATEWAYAPP_SETTINGS=<file thử> GatewayApp.exe --pclogictest KQ --noauth --plc 127.0.0.1:<cổng PlcSim> [--cloud-down]`. PlcSim cần có `pump1.run` D51, `pump1.boost` D55, `pump1.ok` D56, `tank1.level` D50, tất cả ghi được. Kết quả 2026-11-26: 29/29 (thử mất mạng, 4 lần) và 30/30 (mất mạng thật `--cloud-down`, 2 lần).

## Board Waveshare

Mỗi gateway có **đúng một chương trình logic**: file `/offline.json` trên board (có `Rev` + `Sha`), mỗi lần sửa thì thay trọn gói.
Chương trình chạy **ngay trên board**, kể cả khi mất mạng. Không có script: chỉ dùng các kiểu luật mà firmware đã định nghĩa sẵn.
Muốn thêm kiểu luật mới thì phải ra bản firmware mới cho mọi người (bản này cập nhật bằng nút **Cập nhật**, xem `OTA-APPROVAL.md`).

| Thay đổi | Ai làm | Cách làm |
|---|---|---|
| Firmware (kiểu luật, giới hạn cứng, an toàn) | Nhà phát triển | Ký bản build → chủ trạm bấm **Cho phép cập nhật** (áp dụng cho mọi người dùng) |
| Logic của một gateway (điều kiện, liên động, khi mất mạng…) | Admin soạn trong **GatewayAdmin → 📝 Logic** bằng lệnh dạng text | Gửi **đề xuất** → chủ trạm xem **bảng** rồi **Duyệt**, trên webapp (Face ID / TOTP; server gửi xuống gateway) **hoặc** ngay trên GatewayApp (trang Logic, mở khoá tại chỗ; gateway tự áp dụng) |
| Hẹn giờ bật/tắt | Chủ trạm tự cài | Bấm **⏰** cạnh nút bật/tắt trên webapp (Face ID / TOTP) |

Webapp **chỉ cho xem** phần logic (Cài đặt → **Logic điều khiển gateway**). Ngoại lệ duy nhất chủ trạm tự sửa được là hẹn giờ.

## Cú pháp text (GatewayAdmin, `cloud/app/src/logicDsl.js`)

```
tz 7
# trạm bơm farm A
do1: need di3=1, hold | block do2 | maxon 30m | offline 2m: level bon.muc on<=20 off>=90 age 60s
do2: block do1 | offline 1m: off
do3: timer 18:00-05:30 t2-t6 | offline 5m: schedule 18:00-05:30
do4: need chuong.nhiet>=5 | offline: level chuong.nhiet on>=32 off<=29
do5: offline: follow di2 invert
do6: offline: cycle on 10m off 20m
```

| Mệnh đề | Ý nghĩa (luôn chạy, mọi nguồn lệnh: webapp, LAN, Modbus slave) |
|---|---|
| `need <đk>[, …][, hold]` | Chỉ cho **BẬT** khi mọi điều kiện đều thoả (tối đa 4). `<đk>`: `di3=1`, `di3=0`, `tb.field>=5`, `tb.field<=5` `[age 60s]`. Mất số liệu thì coi như không thoả. `hold`: đang bật mà mất điều kiện thì tự **TẮT**. |
| `block do2[, do5]` | Liên động **hai chiều**: không bật khi DO kia đang bật. |
| `maxon 30m` | Bật liên tục quá thời gian này thì tự tắt. |
| `timer 06:00-06:30 [ngày]` · `timer on 06:00` · `timer off 22:00` | Hẹn giờ (tối đa 4 mốc). Đúng phút **On** thì bật, đúng phút **Off** thì tắt (chạy theo sự kiện, nên giữa hai mốc vẫn bật/tắt tay được). Ngày: `t2-t6`, `t2,t4,cn`, `t7-cn`. Không có giờ tin được thì bỏ qua. Lệnh bật vẫn phải qua `need`/`block`. | **Chạy 1 lần** (kiểu báo thức iPhone): `timer 06:00-06:30 2026-11-27`, JSON `{Date, Days:[]}`. Giờ tắt nhỏ hơn giờ bật thì tắt vào hôm sau. `Days` rỗng là cố ý: gateway bản cũ không hiểu `Date` sẽ từ chối, thay vì chạy mỗi ngày. Webapp ⏰: không chọn ngày nào = 1 lần (lần tới của giờ đã đặt); mốc 1 lần đã qua bị bỏ khi lưu.
| `offline [chờ]: <kiểu>` | Khi mất mạng quá thời gian chờ (mặc định 60 s): `hold`, `off`, `on`, `schedule 18:00-05:30`, `follow di2 [invert]`, `level tb.field on<=20 off>=90 [age 30s]`, `cycle on 10m off 20m`. Chi tiết trong `gateway-mcu/src/offline.cpp`. |

### Đầu ra là thiết bị RS485 / Modbus TCP (board, firmware ≥ mcu-0.4.0)

Ngoài `do1`…`do8`, board điều khiển được **field ghi được** của thiết bị ngoài, tối đa 8 đầu ra. Các mệnh đề giống hệt DO.

```
tz 7
bientan.run: need di1=1, bon.muc>=10, hold | block do2 | maxon 2h | offline 2m: level bon.muc on<=20 off>=90
do2: block bientan.run                       # liên động trộn DO ↔ RS485, hai chiều
plc.van: need plc.apsuat>=2, hold | block do1 # Modbus TCP
do3: offline: level plc.apsuat on>=5 off<=1   # giá trị Modbus TCP điều khiển relay board
plc.cmd: offline: follow plc.apsuat           # follow theo field
```

- JSON: `{"Out":"<thiết bị>.<field>", …}` nằm chung `Do[]` với các mục `{"Ch":n}`. `Block` trộn được số (DO) và chuỗi (field). `follow` nhận `Di` hoặc `Field`.
- Trạng thái đầu ra field:
  - field đọc-ghi: lấy theo giá trị đọc lại;
  - field **chỉ ghi** (vd lệnh chạy biến tần): lấy theo giá trị ghi gần nhất;
  - không đọc được quá `max(10 s, 5 × PollMs)` (thiết bị mất kết nối) thì coi là **không rõ**.
- **Liên động coi "không rõ" như đang bật**: thiết bị bên kia mất kết nối thì không bật đầu ra này. Gateway PC (C#) làm giống hệt (`GatewayLogic.StateOf`).
- Lệnh ghi do chương trình quyết định được xếp hàng và chạy trên task đọc. Nhờ vậy RS485/TCP chậm không làm chậm DO/DI. Lệnh ghi lỗi (`plc_error`) thì 5 s sau thử lại.
- Chặn lệnh của người dùng tới field đầu ra nằm trong `engineWrite` (mọi nguồn: webapp, LAN).
- PC giữ lease (chế độ gateway) thì các mục field tạm dừng: PC lo thiết bị ngoài.
- Hẹn giờ ⏰ của chủ trạm dùng được cho đầu ra field (`keys` trong bản tin config có `"<thiết bị>.<field>"`).
- Trang Logic của GatewayApp **giữ nguyên** các mục field khi lưu: trang chỉ sửa DO, mục field soạn bằng GatewayAdmin.

### Kịch bản theo nguồn I/O

| Nguồn | Ví dụ | Ghi chú |
|---|---|---|
| Digital (DI/DO board) | `do1: need di3=1, hold` | DI đã lọc rung, đọc tức thời |
| RS485 (Modbus RTU) | `bientan.run: need bon.muc>=10 \| block do2` | chậm (19200 baud): `age` của điều kiện nên ≥ 3 × chu kỳ đọc |
| Modbus TCP | `plc.van: need plc.apsuat>=2, hold` | mất kết nối → điều kiện "mất số liệu", liên động chặn |
| Trộn | `do2: block bientan.run` | liên động hai chiều giữa mọi loại đầu ra |

Thời gian viết dạng `30s`, `5m`, `2h`, `1d` hoặc số giây. `tb.field` là tên field nội bộ (`<thiết bị>.<field>`), không phải khoá MQTT.
Text **copy được sang gateway khác**. Board kiểm lại tên field khi áp dụng; field sai thì board từ chối và đề xuất chuyển sang `failed`.

Những gì firmware giữ cố định, chương trình không vượt qua được:
- Lệnh **TẮT** luôn được phép.
- Thời gian tối thiểu giữa hai lần bật/tắt relay.
- Chế độ an toàn (chỉ cho TẮT).
- TẮT mọi DO trước khi khởi động lại có chủ đích.

## Luồng duyệt

```
GatewayAdmin ─text─▶ POST /api/v1/radmin/logic/check   (server dịch, trả bảng tiếng Việt + DO thay đổi)
             ─text─▶ POST /api/v1/radmin/logic/propose (gateway_logic_proposals: pending; đề xuất cũ → superseded; push báo chủ trạm)
Webapp  GET /api/v1/gateway-logic?gw=  → bảng đang chạy + đề xuất (hàng thay đổi tô màu)
        POST /api/v1/gateway-logic/approve {gw,id}  (step-up) → rpc PUT /api/offline {Rev hiện tại,…} kèm "appr" trong phần ký
        POST /api/v1/gateway-logic/reject  {gw,id}
        PUT  /api/v1/gateway-logic/timer   {gw,ch,timers}  (step-up) → chỉ thay Timer của DO đó
```

- Board **không nhận** `PUT /api/offline` qua rpc nếu thiếu `appr` (`owner_approval_required`). Relay chung `/api/v1/radmin/rpc` cũng **không còn** `PUT /api/offline` và `POST /api/offline/test`. Thử mất mạng (đóng/ngắt DO thật) chỉ làm được tại chỗ qua LAN.
- Nếu đề xuất **không** có `timer` cho một DO, khi duyệt sẽ **giữ nguyên** hẹn giờ chủ trạm đã cài ở DO đó.
- `Rev` lệch (có người vừa sửa tại chỗ qua GatewayApp LAN) thì trả `logic_rev_conflict`, không ghi đè. Admin cần đề xuất lại.
- Board báo chương trình đang chạy trong bản tin `config` (`logic: {rev, sha, tz, do, names, keys}`). Server lưu vào `gateway_logic` (DB v6). `keys` nối DO với nút điều khiển trên webapp, để biết đặt nút ⏰ ở đâu.
- Nhật ký:
  - Server: `audit_log` các sự kiện `logic_propose`, `logic_approve`, `logic_reject`, `logic_timer`, hiện trong Lịch sử hệ thống.
  - Board: `/events.log` sự kiện `logic_changed`, gửi kèm cảnh báo `sec.logic_changed` về điện thoại chủ trạm.
- Lệnh của người dùng bị chương trình chặn thì ack trả `logic_need` hoặc `logic_interlock`; webapp hiện câu giải thích tương ứng.

## Board nhận cài đặt từ xa (rpc)

Firmware từ `mcu-0.3.9` nghe topic `gw/<id>/rpc`:
- Kiểm chữ ký `rpc1|<mqttId>|<json>` bằng `CloudCmdKey`, `ts` lệch không quá ±60 s, `rid` không được lặp.
- Thân gói là base64 thường (`"enc":"b64"`, nằm trong phần được ký): board không giải nén gzip.
- Board trả lời lên `rpcr`, chia phần ≤ 3000 ký tự.
- Route mở cho rpc trên board: `GET /api/state|config|config-message|offline|events|ota` và `PUT /api/offline` (chỉ khi có `appr`). Mọi route khác bị chặn (`apiRpc` trong `api.cpp`).

## Logic tại biên: nạp qua internet, chạy không cần internet

- Chương trình và hẹn giờ lưu **trên gateway** (`/offline.json` của board, `<config>.logic.json` của gateway PC) và chạy ở đó. VPS chỉ:
  - lưu đề xuất;
  - chuyển lệnh rpc có chữ ký kèm mã duyệt;
  - giữ bản sao để webapp hiển thị.
- Đổi logic **không cần đổi firmware**: GatewayAdmin → duyệt → rpc → gateway áp dụng ngay (rev tăng, cảnh báo `sec.logic_changed`).
- Board ghi sự kiện `logic_act` mỗi lần hẹn giờ hoặc tự tắt, thêm "(đang mất mạng)" khi không có cloud. Mỗi lần logic đổi DO, board gửi telemetry ngay; nếu đang mất mạng thì gửi bù sau.
- Lỗi đã sửa nhờ thử trên board thật (2026-11-27):
  - Task `io` 3 KB stack tràn → **panic** mỗi khi logic tự hành động (hẹn giờ, tự tắt). Đã nâng lên 8 KB, chép chính sách ra heap, ghi sự kiện `stack_low` khi stack còn dưới 1,5 KB.
  - Maxon tắt **ngay** khi hẹn giờ vừa bật DO trong cùng nhịp (trừ không dấu tràn số). Đã chuyển sang so sánh có dấu.
- Gateway PC, kiểm qua cloud thật (bản Debug, BẢN SAO cấu hình gateway đã ghép):
  - Lệnh: `GATEWAYAPP_SETTINGS=<bản sao> GatewayApp.exe --pccloudlogictest KQ --noauth [--plc-port 15021]`.
  - PLC giả nhúng trong tiến trình; điều khiển từ ngoài bằng `KQ/cmd.txt` (`cloud-down` / `cloud-up` / `set D56=1` / `quit`).
  - Kết quả 2026-11-27 (u15/gw02):
    - GatewayAdmin đề xuất → duyệt → rev 1 (`need`, `hold`, `maxon 40s`);
    - ⏰ 1 lần 01:48 → rev 2;
    - cắt cloud thật: 01:48:00 tự bật, 01:48:40 tự tắt.

## Kiểm thử

- Server: `node cloud/app/scripts/smoke-gateway-logic.js` (31 kiểm tra), gồm:
  - cú pháp text, dịch text → JSON → text khớp nhau;
  - đề xuất, đề xuất cũ bị thay, quyền chủ trạm, step-up, mã duyệt `appr` trong gói ký;
  - giữ hẹn giờ của chủ trạm, `rev` lệch, relay chung bị chặn.
- Board (gw-sim, bản Debug): `GatewayApp.exe --offlinetest KQ --noauth --lan-target 127.0.0.1:<SIM_API_PORT> --io-data <SIM_DATA>`. Thêm 11 kiểm tra cho `need`, `hold`, lệnh tắt luôn được, `maxon`, `block`, hẹn giờ bật/tắt đúng phút và hẹn giờ sai. Lần chạy ngày 2026-11-26: 26/26.
- E2E không cần VPS/board: `node cloud/app/scripts/sim-logic-e2e.js --target 127.0.0.1:<SIM_API_PORT> --data <SIM_DATA>` (gw-sim vừa khởi động).
  Script tự dựng broker MQTTS tối giản (dùng `mqtt-packet`, chứng chỉ do `openssl` sinh), ghép PC rồi đẩy cấu hình cloud vào gw-sim, và chạy mã server thật. Gồm 24 kiểm tra:
  - rpc `enc b64`, trả lời chia nhiều phần;
  - thiếu mã duyệt / route bị chặn / sai chữ ký (kèm cảnh báo `sec.rpc_badsig`) / phát lại / gói cũ;
  - đề xuất → duyệt → board áp dụng → config gửi lại → server lưu;
  - lệnh cloud bị chặn (`logic_need`, `logic_interlock`), `hold` tự tắt;
  - hẹn giờ của chủ trạm.
  Lần chạy ngày 2026-11-26: 24/24.
- C#: `dotnet test scada/tests/Plciot.Scada.Tests --filter GatewayLogic` (12 test, gồm 6 kịch bản Digital / RS485 / Modbus TCP trong `GatewayLogicScenarioTests`).
- **Board thật** (bản Debug, `GATEWAYAPP_SETTINGS` riêng, nhấn BOOT để ghép lần đầu): `GatewayApp.exe --boardlogictest KQ --lan-target <IP board>:443 [--tcp-port 15020]`.
  - Bài test sao lưu cấu hình + chương trình của board, cài thiết bị thử, chạy kịch bản, rồi trả lại nguyên trạng.
  - Modbus TCP là PLC giả chạy trong tiến trình test; board nối tới nó qua mạng thật. Tường lửa cần cho `GatewayApp.exe` bản Debug nhận kết nối vào.
  - RS485 dùng Unit 7 không có trên bus, để thử kịch bản "thiết bị mất kết nối".
- **Chưa kiểm chứng**: broker mosquitto + ACL trên VPS thật, giao diện webapp/GatewayAdmin bấm tay, thiết bị RS485 thật có trả lời.
