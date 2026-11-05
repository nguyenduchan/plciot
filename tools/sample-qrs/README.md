# QR mẫu — mọi loại thiết bị

Site: `demo_home`  
Types: `conveyor`, `env`, `switch`, `relay`, `di`, `do`, `pump`, `motor`, `energy`, `tank`, `iot-hub`, `generic`

## Test nhanh (API webapp + C#)

```powershell
cd cloud\app
node scripts/e2e-add-devices-qr.js              # webapp API — mọi type
node scripts/e2e-add-devices-qr.js --serve      # giữ server :3099

# terminal khác:
dotnet run --project tools/CsUiQrE2e -- --session tools/sample-qrs/e2e-session.json
```

Webapp UI: sync/deploy app → đăng nhập → Tổng quan → **+ Thêm thiết bị** → dán `.txt` hoặc quét `.png`.

Khuyến nghị: `demo_home_gw01.txt` trước (seed all). Tem lẻ: `env1`, `pump1`, `switch1`, `relay1`, `di1`, `do1`, `motor1`, `energy1`, `tank1`, `plc01`, `generic1`.

## Danh sách

- **gw01** (`iot-hub`) — Gateway nhà (seed all) → `demo_home_gw01.txt`
- **plc01** (`conveyor`) — Băng tải → `demo_home_plc01.txt`
- **env1** (`env`) — Môi trường → `demo_home_env1.txt`
- **switch1** (`switch`) — Công tắc → `demo_home_switch1.txt`
- **relay1** (`relay`) — Relay → `demo_home_relay1.txt`
- **di1** (`di`) — Đầu vào số → `demo_home_di1.txt`
- **do1** (`do`) — Đầu ra số → `demo_home_do1.txt`
- **pump1** (`pump`) — Bơm → `demo_home_pump1.txt`
- **motor1** (`motor`) — Động cơ → `demo_home_motor1.txt`
- **energy1** (`energy`) — Điện năng → `demo_home_energy1.txt`
- **tank1** (`tank`) — Bồn / mức → `demo_home_tank1.txt`
- **generic1** (`generic`) — Tuỳ chọn → `demo_home_generic1.txt`
