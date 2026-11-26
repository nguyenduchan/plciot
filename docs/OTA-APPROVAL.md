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

## Nhật ký & cảnh báo đỏ

- Board: `/events.log` (LittleFS, vòng ~24 KB), `GET /api/events` (LAN; GatewayAdmin đọc được qua cloud), `GET /api/ota` (phiên bản, đang được duyệt không, ai duyệt, chờ xác nhận).
- Sự kiện bảo mật → `gw/<id>/alert` với `k = "sec.<loại>"` → server đẩy thông báo **🔴 Cảnh báo bảo mật gateway** về điện thoại chủ trạm, và hiện trong Lịch sử hệ thống:
  `pc_paired`, `pc_pair_request` (PC lạ ghép), `login_fail` (đăng nhập sai 5 lần/phút), `ota_denied` (nạp khi chưa duyệt / không chữ ký), `ota_badsig` (sai chữ ký / sai SHA), `ota_rollback`, `safe_mode`, `factory_reset`.
- Server: `audit_log` `ota_approve` (ai duyệt, bản nào → bản nào), `radmin_*` (cài đặt từ xa).
- Board không có SSH; "truy cập bất thường" = các sự kiện trên.

## Kiểm thử

- Server: `node cloud/app/scripts/smoke-mcu-ota.js` (18 kiểm tra).
- Board (gw-sim hoặc board thật, bản Debug): `GatewayApp.exe --otatest KQ.txt --noauth --lan-target IP:CỔNG --fw firmware.bin [--io-data SIM_DATA]` — không chữ ký / sai chữ ký / file cụt / có chủ chưa duyệt bị từ chối, nhật ký có sự kiện, chưa có chủ + đúng chữ ký thì nạp được.
- Bản giả lập không chạy được firmware mới: sau "khởi động lại" nó báo `ota_rollback` (đúng — phiên bản không đổi). Xác nhận / quay về thật chỉ kiểm được trên board.

## Kênh phát hành dev (thử OTA thật mà không cần khoá phát hành)

- Env `waveshare-dev` trong `gateway-mcu/platformio.ini` tin THÊM khoá dev `FW_DEV_PUBKEY` (khoá riêng `~/.plciot/fw-sign-dev.pem`, KHÔNG phải khoá phát hành) và tải bản mới ở `?ch=dev`.
  - Server: `releases/mcu-dev/`. Kênh của board suy ra từ phiên bản (đuôi `-dev`), dùng cho cả nút duyệt lẫn mục "Bản mới".
  - Env chính (bản phát hành) không có hai cờ này, nên không bao giờ nhận bản ký bằng khoá dev.
- Build: `$env:PLATFORMIO_BUILD_FLAGS='-DFW_VERSION=\"mcu-0.4.6-dev\"'; pio run -e waveshare-dev`. Thêm `-DFW_TEST_BREAK_CLOUD` để có bản **hỏng có chủ đích** (không nối cloud), dùng thử tự quay về.
- Ký: cùng định dạng `sign-mcu-firmware.js` (`FW_SIGN_KEY=~/.plciot/fw-sign-dev.pem`); manifest + bin chép vào `/root/plciot/releases/mcu-dev/` trên VPS.
- Đã kiểm trên board thật u15/gw03 qua Wi-Fi (2026-11-27):
  - 0.4.1 → 0.4.2 → 0.4.4 → 0.4.6: tải từ server, kiểm chữ ký, xác nhận sau 60 s.
  - 0.4.5 / 0.4.7 (hỏng): sau 5 phút tự quay về, lý do "không nối lại được cloud".
  - Trong 5 phút mất cloud đó, chương trình logic (hẹn giờ 1 lần đặt từ webapp + maxon) vẫn tự chạy (sự kiện `logic_act … (đang mất mạng)`).

## Lưu ý

- Board đang chạy bản **trước mcu-0.3.8** không có cơ chế này: lần đầu lên 0.3.8 phải nạp qua LAN (GatewayApp) hoặc USB.
- Mất khoá riêng: board không nhận bản mới nữa (phải nạp USB với khoá mới). Lộ khoá: ai cũng ký được — đổi khoá (sửa `fwkey.h`, nạp USB).
- Logic của từng gateway (không dùng script) có luồng duyệt riêng: admin đề xuất, chủ trạm duyệt bảng trên webapp — xem `GATEWAY-LOGIC.md`.
