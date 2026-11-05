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

- QR tem gắn **sau đăng nhập** (Cài đặt → Nhà máy), không tạo user tại login.
- Đăng ký có rate-limit chống spam DB (`RATE_LIMIT_REGISTER*`, `REGISTER_MAX_*`).
- Rule Cursor: `.cursor/rules/vps-dev-sync.mdc`.
