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
5. Bản mới ở trạng thái "chờ xác nhận" (bootloader ESP-IDF, `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`): chạy ổn ≥ 60 s **và** nối lại được cloud (nếu có cài) trong 3 phút → xác nhận. Không thì **tự quay về bản cũ**; treo / crash / watchdog trước đó → bootloader cũng tự quay về. Lần khởi động sau ghi sự kiện + cảnh báo đỏ `ota_rollback`.

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

## Lưu ý

- Board đang chạy bản **trước mcu-0.3.8** không có cơ chế này: lần đầu lên 0.3.8 phải nạp qua LAN (GatewayApp) hoặc USB.
- Mất khoá riêng: board không nhận bản mới nữa (phải nạp USB với khoá mới). Lộ khoá: ai cũng ký được — đổi khoá (sửa `fwkey.h`, nạp USB).
- Logic của từng gateway (không dùng script) có luồng duyệt riêng: admin đề xuất, chủ trạm duyệt bảng trên webapp — xem `GATEWAY-LOGIC.md`.
