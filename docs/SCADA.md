# SCADA nội bộ nhà máy (C# / .NET 8)

```
 PLC ──Modbus TCP · S7 · EtherNet/IP · MC · FINS · ADS · OPC UA──► ScadaCore ◄── giao diện (WPF / của khách hàng): ĐIỀU KHIỂN TRỰC TIẾP
                                       │   (không broker, không HTTP, không client-server khi điều khiển)
                                       ├─► [tuỳ chọn] cầu nối TLS lên MQTT server ──► điện thoại / webapp
                                       ├─► [tuỳ chọn] web + máy khách giám sát từ xa   ── CHỈ XEM ──► máy khác / trình duyệt
                                       ├─► [tuỳ chọn] server Modbus TCP / OPC UA       ── CHỈ ĐỌC ─► HMI / MES khác
                                       ├─► [tuỳ chọn] ghi InfluxDB ──► Grafana
                                       └─► [tuỳ chọn] broker LAN (gateway ESP32 / HMI MQTT)
```
> Framework và giải pháp theo từng khách hàng (một/nhiều màn hình, quyền điều khiển, điện thoại): [SCADA-FRAMEWORK.md](SCADA-FRAMEWORK.md).

Phần mềm local song song với bản Node-RED + Grafana ([EDGE-LOCAL.md](EDGE-LOCAL.md)); đo hiệu năng hai bên: [PERFORMANCE.md](PERFORMANCE.md).

## Tách lõi và giao diện (để làm cho nhiều khách hàng)
| Dự án | Vai trò | Phụ thuộc |
|---|---|---|
| `Plciot.Scada.Core` | **Lõi**: driver PLC, `ScadaCore` (đọc + điều khiển trực tiếp), `DeviceState`, whitelist lệnh, cấu hình, `IScadaView` | chỉ thư viện giao thức PLC; **không** WPF/web/MQTT (có test kiểm tra) |
| `Plciot.Scada.Services` | Dịch vụ tuỳ chọn: cầu nối cloud, web giám sát, `RemoteScreenClient`, server Modbus/OPC UA, InfluxDB, broker LAN, `ScadaHost` (ghép nối theo cấu hình) | Core + ASP.NET + MQTTnet |
| `Plciot.Scada.Framework` | Phần cố định cho mọi khách hàng: `IScadaSolution`, `SolutionRunner`, chế độ một/nhiều màn hình, điện thoại | Services |
| `solutions/Plciot.Solution.Conveyor` | Giải pháp tham chiếu có giao diện WPF | Framework |
| `solutions/Plciot.Solution.Template` | Mẫu trống cho khách hàng mới | Framework |
| `Plciot.Scada.Host` | Chạy nền không giao diện (NSSM/Task Scheduler), `DefaultSolution` | Framework |
| `Plciot.Scada.Tests` | 102 test xUnit | Framework |

Giao diện chỉ cần `IScadaView` (trạng thái + `WriteAsync` + `CanControl`). Một khách hàng mới tạo dự án giao diện riêng (WPF, WinForms, web, kiosk…) tham chiếu Core, tự quyết định bật dịch vụ nào:

```csharp
var cfg = ConfigStore.Load(path);                       // hoặc dựng ScadaConfig bằng mã
await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));   // chỉ lõi: điều khiển thẳng PLC
await core.StartAsync();
IScadaView view = core;                                  // → đưa cho giao diện
var err = await view.WriteAsync(6, 1);                   // chạy băng tải; null = thành công
```
Cần cả cloud/server/InfluxDB thì dùng `ScadaHost` (`host.View` cũng là `IScadaView`). Giao diện hiện có chạy được cả ở chế độ "tại máy" lẫn "giám sát từ xa" vì chỉ biết `IScadaView`.

## Điều khiển trực tiếp
`IScadaView.WriteAsync` → `ScadaCore.ExecuteAsync` → driver → PLC. Không đi qua broker/HTTP/hàng đợi; sau khi ghi lõi đọc lại ngay nên giao diện thấy kết quả sớm nhất. Đo được ≈ 0,85 ms (ghi Modbus thô 0,69 ms). Chỉ D3, D4, D6, D7, D9 ghi được (0–65535); đọc tối đa 60 thanh ghi. Khoá liên động (E-stop, đủ số lượng) vẫn do PLC quyết định.

## Client-server: chỉ để GIÁM SÁT từ máy khác
- **Máy chủ** (máy SCADA chính, `Topology = MultiScreen`): web `http://<ip>:8080` (đăng nhập `monitor`/`operator`, cookie HttpOnly + SameSite=Strict, khoá IP sau 5 lần sai, SSE). `Control.RemoteScreens=false` (mặc định) → lệnh ghi bị từ chối `monitor_only`, kể cả tài khoản operator. Ở `SingleScreen` không mở cổng này.
- **Máy màn hình phụ**: `RemoteScreenClient` (cài đặt `IScadaView`; `CanControl` do máy chủ quyết định theo chính sách + vai trò tài khoản; lệnh ghi được máy chủ kiểm tra lại). Chạy cùng giải pháp với `--station screen`.
- Cho màn hình phụ điều khiển: `.UseMultiScreen(remoteScreensCanControl: true)` (tài khoản operator); mặc định chỉ xem.

## Giao thức PLC (client) — `Source`
| Source | Thư viện / cách làm | Trạng thái kiểm chứng |
|---|---|---|
| `ModbusTcp` | tự cài đặt (FC03/FC06) | **chạy thật** với PLC giả, đo hiệu năng |
| `MitsubishiMc` | tự cài đặt MC 3E nhị phân (Q/L và iQ-R) | khung yêu cầu/đáp kiểm thử với PLC giả viết theo đặc tả — **chưa có PLC Mitsubishi** |
| `OmronFins` | tự cài đặt FINS UDP + TCP (vùng DM) | như trên — **chưa có PLC Omron** |
| `OpcUa` | OPC Foundation .NET (client) | **chạy thật** với server OPC UA của chính dự án |
| `S7` | S7netplus (DB `INT[300]`) | chỉ kiểm tra lỗi kết nối — chưa có CPU Siemens |
| `EtherNetIp` | libplctag (tag `INT[300]`) | chỉ kiểm tra lỗi kết nối — chưa có PLC Rockwell |
| `BeckhoffAds` | Beckhoff.TwinCAT.Ads (symbol `INT[300]`) | chỉ kiểm tra lỗi kết nối; cần router ADS/TwinCAT trên máy này |
| `Gateway` | ESP32 nối vào broker LAN (tự bật broker) | kiểm thử qua broker thật |
Cấu hình riêng từng hãng (`S7Db`, `EipTag`, `AdsSymbol`, `OpcUaImageNode`, `FinsProtocol`, …) nằm trong `config.json`.

## Server cho HMI/MES khác (chỉ đọc)
- **Modbus TCP server** (`ModbusServerEnabled`): holding/input 0–299; ghi bị từ chối (illegal function); PLC mất liên lạc → exception 4 thay vì dữ liệu cũ; tối đa 20 client, cắt kết nối im lặng 60 s.
- **OPC UA server** (`OpcUaServerEnabled`): thư mục `PLC` với `Status, Online, Inputs, Outputs, Alarms, Mode, RunRequest, Target, Conveyor, Count, Total, RunSeconds, PumpStarts` và mảng `PLC_D` UInt16[300] (`ns=2;s=PLC_D`). Cho phép ẩn danh, không biến nào ghi được → chỉ mở trong LAN tin cậy.
- S7/EtherNet/IP/MC/FINS/ADS chỉ làm client (giao thức riêng của hãng).

## Cloud, InfluxDB, broker LAN
- **Cầu nối cloud TLS**: `mqtts://…:8883` hoặc `wss://…:443` (TLS 1.2+), ghim chứng chỉ SHA-256 tuỳ chọn; đẩy telemetry/status/ack/history (retained đồng bộ lại khi nối lại), chỉ `…/cmd` đi xuống. Lệnh từ cloud: whitelist → công tắc `Mobile` (Off/MonitorOnly/Control; không phải Control → `ack remote_disabled`, vẫn cho đọc) → giới hạn `RemoteCmdPerSec` → đi thẳng vào lõi.
- **InfluxDB 2** (`InfluxEnabled`): cùng sơ đồ và **cùng kiểu float** với luồng Node-RED nên chung bucket và dashboard Grafana (`edge/grafana`); có test đối chiếu tên trường với `tools/gen_flows.py`.
- **Broker LAN** (`LocalBrokerEnabled`, tự bật ở chế độ Gateway): không mã hoá, chỉ trong LAN; vai trò `device` / `monitor` / `operator`; chỉ topic `plc/<site>/<device>/*`, không wildcard. HMI vai trò operator gửi `cmd` cũng đi thẳng vào lõi với cùng whitelist.

## Chạy
```bash
cd scada
dotnet run --project src/Plciot.Scada.Host -- init       # tạo config + mật khẩu ngẫu nhiên (hiện một lần)
# sửa C:\ProgramData\PlciotScada\config.json (Source, PlcHost, CloudPassword …)
dotnet run --project src/Plciot.Scada.Host               # hoặc giải pháp có giao diện: dotnet run --project solutions/Plciot.Solution.Conveyor
dotnet test tests/Plciot.Scada.Tests                     # 102 test
```
Mật khẩu trong `config.json` được mã hoá DPAPI (theo máy). Mở cổng Windows Firewall chỉ cho LAN: `netsh advfirewall firewall add rule name="SCADA" dir=in action=allow protocol=TCP localport=8080` (thêm 1502/4840/1883 nếu bật server/broker).

## Đồng bộ với bản Node-RED
| Tính năng | C# | Node-RED |
|---|---|---|
| Giao thức PLC | Modbus, S7, EtherNet/IP, MC, FINS, ADS, OPC UA, gateway | Modbus, S7, OPC UA, EtherNet/IP, MC, FINS, ADS |
| Server Modbus TCP / OPC UA (chỉ đọc) | có | có |
| InfluxDB + Grafana | có (cùng sơ đồ) | có |
| MQTT lên cloud + cổng điều khiển từ xa | có (TLS, ghim chứng chỉ) | có |
| Điều khiển tại chỗ | **trực tiếp** (WPF/giao diện riêng) | trang `/scada` → luồng Node-RED |
| Máy khác | màn hình phụ (web + `RemoteScreenClient`), chỉ xem hoặc điều khiển theo chính sách | trang `/scada` có điều khiển cho operator |
| Broker LAN cho gateway ESP32 | có | chưa có (Node-RED đọc PLC trực tiếp) |

## Chưa kiểm chứng
PLC Mitsubishi/Omron/Siemens/Rockwell/Beckhoff thật; WPF chạy thật (chỉ build, nay là `solutions/Plciot.Solution.Conveyor`); server OPC UA với client của hãng khác (chỉ thử với client của chính dự án); chạy dài ngày; Windows service.
