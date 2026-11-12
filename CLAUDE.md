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

Không ghi đè: `cloud/.env`, `cloud/config/passwd`, `cloud/app/data`.

## Quy ước khác

- MQTT topic **một dạng**: `gw/<mqttId>/<kind>`. `mqttId` = id ngẫu nhiên (16 hex) **server cấp** khi enroll/ghép cặp, lưu `devices.mqtt_id` và ánh xạ site/device/cấu hình; gateway ghép id này vào mọi topic (`ScadaConfig.MqttId`). Đã bỏ `plc/…` và `iot/…` trên cloud. Test ACL trên broker thật: `bash cloud/scripts/test-broker-acl.sh`. Chi tiết: `docs/PROTOCOL.md`.
- MQTT telemetry **một shape**: `schema:2` + `d` (monitor/UI). Control: `cmd`/`ack`. Gateway enroll → `pack[]` + topics — **không** quản lý format/map thừa.
- Type/widget chỉ trên server (tem + `/api/v1/ui/dashboard`). Chi tiết: `docs/PROVISIONING-FLOW.md`.
- UI contract: `GET /api/v1/ui/dashboard` — web + C# cùng schema (`docs/UI-CONTRACT.md`).
- Đăng ký có rate-limit chống spam DB (`RATE_LIMIT_REGISTER*`, `REGISTER_MAX_*`).
- QR mẫu test: `tools/sample-qrs/` (gen: `cd cloud/app && node scripts/gen-sample-device-qrs.js`).
- Rule Cursor: `.cursor/rules/vps-dev-sync.mdc`.
