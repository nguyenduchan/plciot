# plciot — ghi chú cho Claude / agent

Repo SCADA + cloud IoT. Khi code trên **PC nhà hoặc cơ quan**, deploy lên VPS bằng sync (không bắt buộc GitHub).

## VPS

| | |
|---|---|
| IP | `14.225.224.218` |
| SSH | Host `plciot-vps` (xem `~/.ssh/config`) |
| Path | `/root/plciot` |
| Web | `https://plc.dieukhientudong.net` |
| MQTTS | `mqtts://14.225.224.218:48263` |

## Setup PC mới (1 lần)

```powershell
.\cloud\scripts\setup-dev-pc.ps1 -Test
```

Gắn `~/.ssh/id_ed25519_plciot.pub` vào VPS `authorized_keys`. Hướng dẫn đầy đủ: `docs/MAY-CHU-VIET-NAM.md` (mục *Code trên PC local / nhà*).

## Sync sau khi sửa code

```powershell
.\cloud\scripts\sync-vps.ps1           # cloud/ + webapp/ + packages/security
.\cloud\scripts\sync-vps.ps1 -Build    # đổi cloud/app hoặc packages/security
```

`sync-vps.ps1` cũng build GatewayApp (`cloud/scripts/publish-gateway.ps1` → `releases/gateway/`, tắt bằng `-SkipGateway`): gateway hỏi `GET /api/gateway/update`, version khác `version.txt` của nó thì hiện nút **Cập nhật** (tải zip, kiểm sha256, tự chép đè, giữ `server.json`, mở lại). Đổi route/compose → dùng `-Build`.

**Cập nhật gateway an toàn (quy tắc):**
- DB VPS phục vụ MỌI phiên bản còn chạy (số phiên bản schema = `PRAGMA user_version`, hằng `DB_SCHEMA_VERSION` trong cloud/app/src/db.js — tăng 1 mỗi migration mới): migration chỉ THÊM (bảng/cột mới có mặc định/NULL), cấm DROP/RENAME (`node cloud/app/scripts/smoke-db-compat.js` canh). Muốn bỏ gì: xem bảng `gateway_clients` (version/api_level/last_seen của từng gateway) xác nhận không còn bản cũ rồi mới làm.
- Đổi KHÔNG tương thích ngược giữa gateway↔server → tăng cùng lúc `AppUpdate.ApiLevel` (tools/GatewayApp/AppUpdate.cs) và `GATEWAY_API_LEVEL` (cloud/app/src/gatewayUpdate.js); bản gateway có apiLevel cao hơn = cập nhật bắt buộc; server cũ hơn thì không phát bản đó (409). `sync-vps.ps1` kiểm lại sau deploy.
- Cấu hình cục bộ: `ScadaConfig.ConfigSchema` + `tools/GatewayApp/ConfigMigrations.cs` (thêm bước, tăng `Current`; file gốc được sao lưu `config.json.bak-v<n>`).
- Sao lưu gateway (`tools/GatewayApp/Backup/BackupService.cs`, trang **Sao lưu**): gói `.gwbackup` mã hoá AES-GCM bằng **khoá khôi phục** (PBKDF2, KHÔNG dùng DPAPI) nên khôi phục được sang máy khác; bí mật được mã hoá lại bằng DPAPI máy mới. Tự động mỗi ngày + trước mỗi lần cập nhật + trước khi khôi phục; giữ 7 ngày + 4 tuần (auto), 10 (manual), 3 (pre-update/pre-restore); tuỳ chọn chép thêm sang thư mục USB/ổ mạng. Gateway báo `X-Gateway-Backup` → `gateway_clients.last_backup_at`. Thêm file cần sao lưu → `BackupService.Sources()`. Test: `BackupTests.cs`, `--backuptest KQ.txt` (cần `GATEWAYAPP_SETTINGS` riêng).
- GatewayApp (bản Release) **không có tuỳ chọn dòng lệnh**: chỉ mở bằng double-click, mọi tham số bị bỏ qua (`tools/GatewayApp/RunOptions.cs`). Cờ kiểm thử (`--selftest`, `--boarddo`, `--lanui`, `--wifisetup`, `--updatetest`, `--rollbacktest`…) chỉ có ở bản **Debug** — luôn test bằng `dotnet build -c Debug` (thêm `-o bin/dbg` nếu exe Debug đang chạy). Cài/đổi cấu hình qua giao diện, không qua cờ.
- Rollback gateway: bản cũ nằm ở `ProgramData\PlciotScadapp-prev`. Tự quay về khi bản mới chết trong 25 giây đầu hoặc khởi động 3 lần liền chưa chạy đủ 90 giây; người dùng bấm **↩ Bản trước**. Bản bị bỏ được ghi vào `update-failed.txt` để không đề nghị lại. Test không giao diện: `--updatetest KQ.txt [bad]`, `--rollbacktest KQ.txt`.

Không ghi đè: `cloud/.env`, `cloud/config/passwd`, `cloud/app/data`.

## Quy ước khác

- MQTT topic **một dạng**: `gw/<mqttId>/<kind>`. `mqttId` = id ngẫu nhiên (16 hex) **server cấp** khi enroll/ghép cặp, lưu `devices.mqtt_id` và ánh xạ site/device/cấu hình; gateway ghép id này vào mọi topic (`ScadaConfig.MqttId`). Đã bỏ `plc/…` và `iot/…` trên cloud. Test ACL trên broker thật: `bash cloud/scripts/test-broker-acl.sh`. Chi tiết: `docs/PROTOCOL.md`.
- MQTT telemetry **một shape**: `schema:2` + `d` (monitor/UI). Control: `cmd`/`ack`. Gateway enroll → `pack[]` + topics — **không** quản lý format/map thừa.
- Type/widget chỉ trên server (tem + `/api/v1/ui/dashboard`). Chi tiết: `docs/PROVISIONING-FLOW.md`.
- UI contract: `GET /api/v1/ui/dashboard` — web + C# cùng schema (`docs/UI-CONTRACT.md`).
- Đăng ký có rate-limit chống spam DB (`RATE_LIMIT_REGISTER*`, `REGISTER_MAX_*`).
- QR mẫu test: `tools/sample-qrs/` (gen: `cd cloud/app && node scripts/gen-sample-device-qrs.js`).
- Rule Cursor: `.cursor/rules/vps-dev-sync.mdc`.
