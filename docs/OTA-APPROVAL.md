# Cập nhật firmware board Waveshare có duyệt — "chìa khoá 2 lớp"

Mục tiêu: nhà phát triển **không thể** tự đẩy code xuống trạm đang chạy; chủ trạm giữ chìa khoá, mọi thay đổi đều có nhật ký.

## Hai lớp khoá

| Lớp | Ai giữ | Kiểm ở đâu |
|---|---|---|
| **Chữ ký nhà phát triển** `fw1\|<sha256>\|<phiên bản>` (ECDSA P-256) | Khoá riêng NGOÀI repo: `%USERPROFILE%\.plciot\fw-sign.pem` (sao lưu ngoài máy!) | Board, bằng khoá công khai gắn cứng `gateway-mcu/src/fwkey.h` — trước khi xoá phân vùng, và đối chiếu SHA-256 thật sau khi ghi |
| **Chủ trạm duyệt** — cửa sổ 15 phút | Chủ gateway trên webapp (Cài đặt → **Lịch sử hệ thống & cập nhật** → "Cho phép cập nhật"), cần Face ID / TOTP như lệnh điều khiển | Server gửi `{sys:"ota_allow", ttl:900, by}` có chữ ký server (`cmd1`); board chỉ mở cửa sổ khi chữ ký đúng. Cài xong / hết giờ → đóng |

Board **chưa gắn tài khoản** (chưa có chủ): PC quản trị đã ghép nạp được qua LAN như trước — vẫn phải đúng chữ ký.

## Luồng

1. Build → ký → đưa lên VPS:
   ```powershell
   cd gateway-mcu; .\build.ps1 -Pio D:\pio\penv\Scripts\pio.exe
   node ..\cloud\app\scripts\sign-mcu-firmware.js sign .pio\build\waveshare-s3-eth-8di-8do\firmware.bin mcu-0.3.8 --notes "Nội dung thay đổi" --out ..\releases\mcu
   cd ..; .\cloud\scripts\sync-vps.ps1 -SkipGateway
   ```
   Lệnh ký cũng tạo `firmware.bin.json` cạnh file `.bin` — GatewayApp (nút **Firmware…**) đọc file này khi nạp qua LAN.
2. Server chỉ **thông báo**: webapp của chủ trạm hiện "Bản mới" + ghi chú. Server không tự đẩy.
3. Chủ trạm bấm **Cho phép cập nhật (15 phút)** → board tự tải `/api/v1/mcu-firmware/download`, kiểm chữ ký + SHA-256, cài.
4. Trước khi khởi động lại: `enterSafeState()` — **TẮT mọi DO**, lưu bộ đếm xung DI (đọc lại sau khi khởi động). Cũng chạy trước khi khởi động lại do đổi mạng / xoá cấu hình.
5. Bản mới chạy ở trạng thái **chờ xác nhận**, và phải qua **kiểm tra sức khoẻ** trong 5 phút (`/api/ota` → `Health`). Không đạt thì **tự quay về bản cũ**:
   - **up**: chạy liên tục ≥ 60 s.
   - **net**: lấy lại mức mạng như **trước khi cập nhật**. Trước đó cloud đang nối thì phải nối lại cloud; trước đó chỉ có LAN thì phải có IP; trước đó đã mất mạng sẵn thì không đòi (không quay về oan).
   - **ota**: còn cập nhật tiếp được. Phải có phân vùng OTA kế tiếp và cổng HTTPS LAN đã mở; nếu trước đó cloud đang nối thì còn phải tải được thông tin firmware từ server qua HTTPS. Bản mới làm hỏng đường cập nhật thì không được giữ, vì giữ nó là mất luôn cách sửa từ xa.
   - **io**: DO trên board (TCA9554) trả lời và vòng đọc thiết bị đang chạy.
   - Khởi động lại 3 lần liền mà chưa xác nhận (crash / watchdog / panic) thì quay về ngay, không chờ đủ 5 phút.

   **Quay về làm trong ứng dụng**, không trông vào bootloader. Đã thử trên board thật: bootloader dựng sẵn của Arduino không đưa ảnh mới vào `PENDING_VERIFY` (`ImgState` = 2 ngay sau khi cài). Vì vậy:
   - bản mới tự nhận ra mình qua NVS `try`, đếm số lần khởi động qua NVS `boots`;
   - khi quay về: gọi `esp_ota_mark_app_invalid_rollback_and_reboot()`; nếu bootloader không làm được thì tự `esp_ota_set_boot_partition(phân vùng kia)` rồi khởi động lại;
   - bản cũ đọc NVS `why` để ghi lý do vào sự kiện + cảnh báo đỏ `ota_rollback`, vd "không đạt kiểm tra sau 5 phút: không nối lại được cloud".

## Đường cập nhật: board tự lên internet HAY qua gateway PC

Board cập nhật bằng **đường internet đang dùng**:

| Board đang chạy | Ai tải firmware | Lệnh "cho phép" tới board bằng |
|---|---|---|
| **Độc lập** (tự nối cloud qua Ethernet hoặc Wi-Fi) | board tự tải `/api/v1/mcu-firmware/download` | MQTT `gw/<id>/cmd` `{sys:"ota_allow"}` (server ký) |
| **Slave của gateway PC** (GatewayApp giữ lease, board tạm dừng MQTTS) | GatewayApp tải từ server rồi đẩy qua LAN `POST /api/ota` | GatewayApp chuyển gói server ký qua LAN `POST /api/ota/allow` |

Slave — `tools/GatewayApp/Remote/BoardOtaRelay.cs`, chạy trong nhịp lease, mỗi phút một lần / board:
1. `GET /api/ota` trên board: `Version`, `Channel`, `CloudId` (mqttId), `Enrolled`, `Lease`. Bản đang chờ xác nhận thì thôi.
2. `GET /api/ota/nonce` trên board → mã dùng một lần (2 phút). Board slave có thể không có NTP, nên **dùng nonce thay cho kiểm giờ**.
3. `POST {server}/api/v1/mcu-firmware/allow {id, nonce, version}`:
   - server ghi phiên bản board vào `gateway_clients`, để webapp hiện "Bản mới" + nút cho phép cả khi board không tự lên cloud;
   - chủ trạm đã cho phép trong 15 phút qua (`audit_log` `ota_approve`, nên deploy lại không mất) → trả gói `{sys:"ota_allow", ttl còn lại, by, nonce}` **ký bằng khoá lệnh server** (miền `cmd1`, gắn mqttId board) + thông tin bản mới. Chưa cho phép → 404 `not_approved`.
4. `POST /api/ota/allow {Packet}` → board kiểm chữ ký server + đúng nonce (dùng một lần) → mở cửa sổ. Người duyệt ghi là `ndhan1 · qua gateway LAN <IP PC>`.
5. GatewayApp tải firmware, đối chiếu SHA-256, `POST /api/ota`. Board vẫn kiểm **chữ ký nhà phát triển**, cài, kiểm tra sức khoẻ, tự quay về như mọi đường khác. Server ghi `ota_relay` vào Lịch sử hệ thống.

GatewayApp **không tạo được** lệnh cho phép (không có khoá server) và không sửa được firmware (chữ ký nhà phát triển). Board slave không tự tải song song, vì board chỉ tự tải khi MQTT đang nối.
Kiểm thử thật: `GATEWAYAPP_SETTINGS=<bản sao cấu hình gateway PC> GatewayApp.exe --boardotarelaytest THƯ_MỤC --board IP --hw <mã phần cứng>` (bản Debug).

**Ethernet và Wi-Fi cùng dải** (vd. dây cắm thẳng PC 192.168.1.200, Wi-Fi 192.168.1.15):
- Board đưa cloud sang Wi-Fi khi dây không ra internet. Nhưng gói tới địa chỉ trong dải, như DNS 192.168.1.1 của router Wi-Fi, vẫn bị lwIP đẩy ra Ethernet → phân giải tên hỏng.
- Hậu quả: MQTT theo IP vẫn chạy, còn HTTPS theo tên (thông tin bản mới, tải firmware) thì lỗi `HTTP -1`.
- Từ 0.4.10, khi DNS của Wi-Fi nằm trong dải Ethernet, board dùng DNS 8.8.8.8 / 1.1.1.1 (đi theo đường mặc định = Wi-Fi), kiểm lại mỗi phút.
- Từ 0.4.13, tải lỗi thì **thử lại mỗi phút** trong cửa sổ cho phép, nhật ký ghi tên lỗi ESP-IDF + RAM trống.

## Cập nhật được khi HTTPS hỏng mà MQTT vẫn nối (từ mcu-0.4.16-dev)

Sự cố 2026-11-27 (u15/gw03, board ở nhà, người ở văn phòng): board nhận `ota_allow` qua MQTT, nhưng mọi HTTPS tới server đều `ESP_ERR_HTTP_CONNECT` từ khoảng 1 giờ sau khi khởi động. MQTT theo IP vẫn chạy. Không tải được firmware, không khởi động lại được, không biết lỗi do đâu.
- **Nguyên nhân nghi nhiều nhất:** framework build với `CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC=y`, tức mọi bộ đệm TLS nằm trong RAM trong, không dùng PSRAM. Kết nối MQTT TLS mở từ lúc khởi động nên không sao. Mỗi lần HTTPS mới cần một khối RAM trong liền khoảng 17 KB; RAM trong bị phân mảnh thì bắt tay hỏng. Nhật ký cũ chỉ ghi "khối lớn nhất 8063 KB", là PSRAM, nên không thấy được.
- **Sửa (ba phần):**
  1. **Tải firmware qua MQTT:** HTTPS lỗi (lấy thông tin hoặc tải giữa chừng) mà MQTT đang nối thì board chuyển sang kết nối MQTT có sẵn.
     - Board → `gw/<id>/fwq`: `{q:"info",ch}` / `{q:"get",ch,ver,off,n}`. Server → `gw/<id>/fw`: `{t:"info",…}` / `{t:"data",ver,off,z}` (8 KB/đoạn, base64) / `{t:"err",e}`.
     - Board hỏi từng đoạn, hỏi lại sau 15 s (tối đa 6 lần). Mất MQTT hoặc hết cửa sổ cho phép thì bỏ, 1 phút sau thử lại từ HTTPS.
     - An toàn như HTTPS: chữ ký nhà phát triển kiểm trước khi ghi, SHA-256 thật kiểm sau khi ghi, chỉ cài trong cửa sổ chủ trạm cho phép. Chỉ server (user `ctl`) ghi được `fw` (ACL). Server giới hạn 100 yêu cầu / 10 s / board.
     - Kiểm tra sức khoẻ bản mới: HTTPS hỏng nhưng hỏi được thông tin qua MQTT thì vẫn tính là "còn cập nhật được", không quay về oan.
     - Mã: `ota.cpp` (`otaOnFw`, `mqStart`), `mcuOta.js` (`onFwRequest`), `mqttIngest.js`, ACL trong `mqttProvision.js`.
  2. **Khởi động lại từ xa:** webapp → Cài đặt → Lịch sử hệ thống → **Khởi động lại board** (Face ID/TOTP).
     - Server gửi `POST /api/v1/gateway/reboot` → `{sys:"reboot", by, id}`, ký `cmd1`; `id` + `ts` chống phát lại.
     - Board ack, gửi cảnh báo đỏ `sec.reboot_remote`, TẮT mọi DO rồi khởi động lại sau 3 s. Ghi `audit_log` `gateway_reboot`.
  3. **Chẩn đoán + DNS dự phòng:**
     - HTTPS lỗi thì nhật ký ghi rõ: DNS lỗi / TCP 443 không nối được / TCP nối được nhưng bắt tay TLS lỗi, kèm **RAM trong** trống và khối liền lớn nhất (`netDiag`, `heapText`).
     - Mỗi phút điền DNS phụ 1.1.1.1 (hoặc 8.8.8.8) nếu ô DNS phụ còn trống (IP tĩnh và đa số DHCP chỉ có một DNS); lwIP tự chuyển sang DNS phụ khi DNS chính không trả lời.
  4. **Giờ không cần DNS:** NTP thêm hai máy chủ theo IP (`216.239.35.0` time.google.com, `162.159.200.123` time.cloudflare.com).
     Lý do: sau khi tắt/bật nguồn lúc 11:58, board nối lại MQTT nhưng **không lấy được giờ** (`clock_not_synced`), vì NTP theo tên và giờ lấy từ HTTPS đều cần DNS. Không có giờ thì board từ chối mọi lệnh ký (kể cả `ota_allow`, `reboot`, rpc).
     Từ đó suy ra sự cố 27/11 nhiều khả năng do **DNS ở mạng nhà**, hơn là do RAM.
- **Lưu ý:** board chạy bản cũ hơn 0.4.16-dev chưa có các phần trên. Bản đầu tiên có chúng phải vào board bằng đường cũ (HTTPS chạy, hoặc LAN qua GatewayApp).
- Sau khi deploy server phải dựng lại ACL broker: `docker exec plciot-app node scripts/sync-mqtt-acl.js`, cho các quyền `fwq`/`fw`.

## Nhật ký & cảnh báo đỏ

- Board: `/events.log` (LittleFS, vòng ~24 KB), `GET /api/events` (LAN; GatewayAdmin đọc được qua cloud), `GET /api/ota` (phiên bản, đang được duyệt không, ai duyệt, chờ xác nhận).
- Sự kiện bảo mật → `gw/<id>/alert` với `k = "sec.<loại>"` → server đẩy thông báo **🔴 Cảnh báo bảo mật gateway** về điện thoại chủ trạm, và hiện trong Lịch sử hệ thống:
  `pc_paired`, `pc_pair_request` (PC lạ ghép), `login_fail` (đăng nhập sai 5 lần/phút), `ota_denied` (nạp khi chưa duyệt / không chữ ký), `ota_badsig` (sai chữ ký / sai SHA), `ota_rollback`, `safe_mode`, `factory_reset`.
- Server: `audit_log` `ota_approve` (ai duyệt, bản nào → bản nào), `radmin_*` (cài đặt từ xa).
- Board không có SSH; "truy cập bất thường" = các sự kiện trên.

## Kiểm thử

- Server: `node cloud/app/scripts/smoke-mcu-ota.js` (51 kiểm tra, gồm đường chuyển tiếp qua gateway PC, tải qua MQTT, khởi động lại từ xa).
- Tải qua MQTT + khởi động lại trên gw-sim (HTTPS cố ý hỏng): `node cloud/app/scripts/sim-ota-mqtt-e2e.js --fw <firmware.bin đã ký, có .bin.json>`.
  Script tự chạy bản sao gw-sim + broker thử. Lần chạy ngày 2026-11-27: 22/22, 199 đoạn trong 48 s, SHA-256 đúng.
- Board thật qua internet (chạy trong container VPS): `docker exec -w /app plciot-app node scripts/live-board-internet.js <site/device> status|logic|ota`.
- Board (gw-sim hoặc board thật, bản Debug): `GatewayApp.exe --otatest KQ.txt --noauth --lan-target IP:CỔNG --fw firmware.bin [--io-data SIM_DATA]` — không chữ ký / sai chữ ký / file cụt / có chủ chưa duyệt bị từ chối, nhật ký có sự kiện, chưa có chủ + đúng chữ ký thì nạp được.
- Bản giả lập không chạy được firmware mới: sau "khởi động lại" nó báo `ota_rollback` (đúng — phiên bản không đổi). Xác nhận / quay về thật chỉ kiểm được trên board.

## Kênh phát hành dev (thử OTA thật mà không cần khoá phát hành)

- Env `waveshare-dev` trong `gateway-mcu/platformio.ini` tin THÊM khoá dev (KHÔNG phải khoá phát hành) và tải bản mới ở `?ch=dev`.
- **Khoá dev nằm trên VPS** (từ mcu-0.4.16-dev, `FW_DEV_PUBKEY2`): `/root/.plciot/fw-sign-dev.pem`, chỉ root đọc, ngoài container app. PC dev không giữ khoá.
  - Ký + đưa lên kênh dev: `.\cloud\scripts\sign-fw-vps.ps1 -Bin <firmware.bin> -Version mcu-x.y.z-dev -Notes "…"`. Ký trong container dùng một lần (`--network none`, khoá gắn chỉ đọc); bản trước sao lưu ở `releases/mcu-dev-bak/`.
  - Ai có SSH root vào VPS thì phát hành được bản dev. Chiếm root VPS = có cả khoá ký firmware dev lẫn khoá lệnh (`ota_allow`) → cài được firmware tuỳ ý lên **board dev**. Board phát hành không tin khoá này.
  - `FW_DEV_PUBKEY` (khoá cũ ở PC nhà, `~/.plciot/fw-sign-dev.pem`) còn giữ để chuyển tiếp; bỏ khi không dùng nữa.
  - Chuyển board dev đang chạy ở xa sang khoá mới: bản chuyển tiếp 0.4.16-dev ký **một lần** bằng khoá phát hành (chỉ để ở kênh dev, thay ngay bằng 0.4.17-dev do VPS ký) — 2026-11-27.
- Bản **phát hành chính thức** vẫn ký bằng khoá trên PC (`~/.plciot/fw-sign.pem`) — chưa quyết chuyển.
  - Server: `releases/mcu-dev/`. Kênh của board suy ra từ phiên bản (đuôi `-dev`), dùng cho cả nút duyệt lẫn mục "Bản mới".
  - Env chính (bản phát hành) không có hai cờ này, nên không bao giờ nhận bản ký bằng khoá dev.
- Build: `$env:PLATFORMIO_BUILD_FLAGS='-DFW_VERSION=\"mcu-0.4.6-dev\"'; pio run -e waveshare-dev`. Thêm `-DFW_TEST_BREAK_CLOUD` để có bản **hỏng có chủ đích** (không nối cloud), dùng thử tự quay về.
- Ký: `cloud/scripts/sign-fw-vps.ps1` (khoá VPS, ở trên) → `/root/plciot/releases/mcu-dev/`.
- Đã kiểm trên board thật u15/gw03 qua Wi-Fi (2026-11-27):
  - 0.4.1 → 0.4.2 → 0.4.4 → 0.4.6: tải từ server, kiểm chữ ký, xác nhận sau 60 s.
  - 0.4.5 / 0.4.7 (hỏng): sau 5 phút tự quay về, lý do "không nối lại được cloud".
  - Trong 5 phút mất cloud đó, chương trình logic (hẹn giờ 1 lần đặt từ webapp + maxon) vẫn tự chạy (sự kiện `logic_act … (đang mất mạng)`).

## Lưu ý

- Board đang chạy bản **trước mcu-0.3.8** không có cơ chế này: lần đầu lên 0.3.8 phải nạp qua LAN (GatewayApp) hoặc USB.
- Mất khoá riêng: board không nhận bản mới nữa (phải nạp USB với khoá mới). Lộ khoá: ai cũng ký được — đổi khoá (sửa `fwkey.h`, nạp USB).
- Logic của từng gateway (không dùng script) có luồng duyệt riêng: admin đề xuất, chủ trạm duyệt bảng trên webapp — xem `GATEWAY-LOGIC.md`.
