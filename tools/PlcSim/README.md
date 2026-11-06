# PlcSim — PLC giả lập (Windows)

Ứng dụng WinForms giả lập PLC để thử gateway C# (`scada/`) và webapp mà không cần phần cứng.

```powershell
dotnet run --project tools/PlcSim
```

## Giao thức

| Giao thức | Vai trò simulator | Cấu hình gateway C# (`ScadaConfig`) |
|---|---|---|
| Modbus TCP | slave, cổng 502 | `Source=ModbusTcp`, `PlcHost=<IP máy này>` |
| Mitsubishi MC 3E | server, cổng 5001 (Q/L và iQ-R) | `Source=MitsubishiMc`, `McPlcType` |
| Omron FINS UDP / TCP | server, cổng 9600 (DM) | `Source=OmronFins`, `FinsProtocol` |
| Siemens S7 | server ISO-on-TCP, cổng 102, DBW(2n) = D n | `Source=S7`, `S7Cpu`, `S7Db` |
| EtherNet/IP | server CIP, cổng 44818, tag INT[300] | `Source=EtherNetIp`, `EipTag` |
| OPC UA | server, cổng 4840 (`PLC_D`, `PLC_W<a>` ghi được) | `Source=OpcUa` |
| Beckhoff ADS | AMS router + PLC, cổng 48898 (gateway cùng máy, không cài TwinCAT) | `Source=BeckhoffAds` |
| MQTT → gateway | client, cổng 1883 | `Source=Gateway`, `LocalBrokerEnabled`, `LocalUsers` có `Role=Device` |

Ba giao thức đầu: gateway **poll** D0..D39 và **ghi** lệnh (D3/D4/D6/D7/D9) vào simulator — simulator log và cập nhật lưới ngay.
MQTT: simulator **đẩy** `plc/<site>/<device>/telemetry` = `{"schema":2,"r":[..],"d":{child:{field:v}}}`, `status`, nghe `cmd`, trả `ack`.
Gateway chuyển tiếp lên cloud → webapp. Lệnh từ webapp đi ngược lại đúng đường đó.

## Dữ liệu nhập

- Giao thức, địa chỉ/cổng, Site, Device, MQTT user/password, chu kỳ gửi.
- Tab **Thanh ghi D**: sửa giá trị D0..D39, hoặc ghi D bất kỳ (0–299).
- Tab **Thiết bị con**: `childId` / `field` / số (chỉ đi qua MQTT; phải trùng tem QR/pack trên server).
- *Mô phỏng băng tải*: D6=1 → D8=1 và đếm D14/D16 mỗi giây, dừng khi đủ D7.

Thiết bị con với giao thức thanh ghi: điền cột **D** + **scale** (D = giá trị × scale); gateway có bảng `Pack` cùng quy ước (D = field × scale) để đóng gói `d.<child>.<field>`.
Cấu hình lưu ở `%APPDATA%\PlcSim\settings.json` (không lưu mật khẩu).
