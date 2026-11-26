# Cài đặt gateway từ xa — GatewayAdmin

GatewayAdmin (`tools/GatewayAdmin`) là app desktop của chủ hệ thống: cài đặt gateway của khách **qua internet**, dùng lại nguyên các trang thiết lập của GatewayApp (`RemoteForm`) — như kỹ thuật viên ngồi tại chỗ. App client thuần: **không chạy gateway** trên máy admin. GatewayApp của khách vẫn chỉ cài đặt trong cùng mạng LAN.

```
GatewayAdmin ──HTTPS, ký bằng khoá máy──▶ server (remoteAdmin.js) ──gw/<mqttId>/rpc, server ký rpc1|…──▶ gateway
             ◀──────────── {status, body} ◀── ghép các phần gw/<mqttId>/rpcr ◀────────────────────────┘
```

## Ai được làm gì

| | |
|---|---|
| Máy admin | Khoá ECDSA tự sinh lần đầu (`%LOCALAPPDATA%\PlciotGatewayAdmin\admin-key.bin`, DPAPI). Server chỉ nhận khoá **đăng ký qua SSH**: nút "🔑 Khoá máy này" chép sẵn lệnh `docker compose exec -T app node scripts/remote-admin-key.js add <tên> <SPKI>`. `list` / `disable <key_id>` để xem / thu hồi. Không có màn hình đăng nhập. |
| Mỗi yêu cầu | Header `X-Radm-Key/Ts/Nonce/Sig`, ký `radm1\|METHOD\|path\|ts\|nonce\|sha256(thân)`. Lệch giờ > 60 s hoặc nonce dùng lại → 401. |
| Chủ gateway | Webapp → Cài đặt → **Hỗ trợ từ xa**: bật/tắt từng gateway (mặc định **TẮT**, tắt có hiệu lực ngay). API `GET/PUT /api/v1/remote-support`. |
| Route được phép | `GET/PUT /api/config`, `GET /api/state`, `GET /api/config-message`, `POST /api/write`, `POST /api/device`, `GET /api/offline` (đổi chương trình logic: đề xuất → chủ trạm duyệt, xem `GATEWAY-LOGIC.md`; thử mất mạng chỉ tại chỗ), `GET /api/network`, `GET /api/wifi` (`ALLOWED` trong `remoteAdmin.js`). Chạy/dừng gateway, đăng ký cloud, đổi mạng/Wi-Fi, OTA, PC quản trị, lease: **chỉ tại chỗ**. |
| Gateway PC | `ScadaHost.RpcHandler` = `MainForm.HandleRpcAsync` (cùng bộ xử lý API LAN). Lưu cấu hình từ xa **giữ nguyên thông số cloud** (site/device/MqttId/host/khoá…) và trả lời trước rồi mới khởi động lại. |
| Nhật ký | `audit_log`: `radmin_rpc` (mọi lệnh ghi + đọc cấu hình: tên máy, route, gateway, mã trả lời), `radmin_consent_on/off`. |

## Gói tin

- `rpc` (server → gateway): `{"rid","ts","m","p","b":<base64 gzip thân>,"adm":<tên máy>,"sig"}`. Gateway kiểm chữ ký `rpc1|<mqttId>|<json>` bằng `CloudCmdKey` (chữ ký `cmd1` của lệnh điều khiển không dùng được ở đây và ngược lại), `ts` ±60 s, `rid` không lặp.
- `rpcr` (gateway → server): `{"rid","i","n","st","z"}` — gzip+base64 của trả lời, chia phần ≤ 3000 ký tự (đường ingest chặn gói > 4 KB). Server chỉ nhận phần từ đúng `mqttId` của yêu cầu, chờ tối đa 25 s.
- ACL broker (`mqttProvision.js`): `ctl` ghi `gw/+/rpc`; `ingest` đọc `gw/+/rpcr`; gateway đọc `gw/<id>/rpc`, ghi `gw/<id>/rpcr`. Người dùng app không đọc/ghi được.

## Kiểm thử

- Server: `node cloud/app/scripts/smoke-remote-admin.js` (26 kiểm tra: chữ ký, phát lại, lệch giờ, sửa thân, quyền chủ, route bị chặn, tách miền chữ ký, ghép trả lời lớn, gateway khác trả lời, ACL).
- Qua internet thật (bản Debug): `GatewayAdmin.exe --relaytest KQ --gw site/device` — đọc trạng thái/cấu hình, lưu cấu hình (gateway khởi động lại và nối lại cloud), thông số cloud không đổi được, route bị chặn, mở cửa sổ. 2026-11-26: 11/11 với gateway PC thử trên VPS, ~390 ms mỗi vòng.
- Board Waveshare (từ `mcu-0.3.9`): nghe `rpc`, thân gói base64 thường (`"enc":"b64"`), chỉ mở route xem + `PUT /api/offline` có mã duyệt của chủ trạm — xem `GATEWAY-LOGIC.md`. Chưa kiểm chứng qua VPS thật.
