# GatewayApp — gateway C# có giao diện

```powershell
dotnet run --project tools/GatewayApp
```

- PropertyGrid chứa toàn bộ `ScadaConfig`: `Source` (ModbusTcp, MitsubishiMc, OmronFins, S7, EtherNetIp, OpcUa, BeckhoffAds, Gateway=MQTT), host/cổng, `Pack`, cloud…
- Dán mã QR tem + **Enroll từ QR** để lấy site/device/MQTT/pack từ server (pack tự gán D50.. liên tiếp).
- Bảng traffic: `PLC→GW`, `GW→PLC`, `GW→Cloud`, `Cloud→GW` (lệnh từ webapp) kèm nội dung JSON.
