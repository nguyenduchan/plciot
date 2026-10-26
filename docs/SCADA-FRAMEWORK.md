# Framework SCADA và giải pháp theo khách hàng

Phần **cố định** (framework) tách khỏi phần **riêng của từng nhà máy** (giải pháp), để sửa một khách hàng không đụng khách hàng khác và để LLM/người sửa ở đúng chỗ. Quy tắc làm việc ngắn gọn: `scada/CLAUDE.md`. Kiến trúc chạy bên trong: [SCADA.md](SCADA.md).

```
 solutions/Plciot.Solution.<KhachA>   ┐
 solutions/Plciot.Solution.<KhachB>   ├─ chỉ tham chiếu ─►  Plciot.Scada.Framework ─► Services ─► Core
 solutions/Plciot.Solution.Template   ┘      (IScadaSolution, SolutionRunner, UseSingleScreen…)
```

## Phần cố định (framework) cung cấp
| Chế độ | Chọn bằng | Ý nghĩa |
|---|---|---|
| **Một màn hình** | `.UseSingleScreen()` | Chỉ màn hình trên máy chính, điều khiển **trực tiếp** PLC. Không client-server: không mở web, không mở cổng màn hình phụ. |
| **Nhiều màn hình** | `.UseMultiScreen(remoteScreensCanControl)` | Máy chính phục vụ màn hình phụ (client-server). `false`: màn hình phụ chỉ giám sát; `true`: tài khoản operator được điều khiển, máy chủ kiểm tra lại mọi lệnh. |
| **Điện thoại** | `.UseMobile(Off \| MonitorOnly \| Control)` | Off: không nối cloud. MonitorOnly: xem, lệnh ghi bị từ chối `remote_disabled`. Control: xem + điều khiển (qua mqtts, giới hạn tốc độ). |
| **Thanh ghi ghi được** | `.UseWritableRegisters(3,4,6,7,9)` | Danh sách D mà mọi nguồn được ghi; ngoài danh sách luôn bị từ chối. |
| **Nguồn PLC** | `.UsePlc(PlcSource.X, host)` | Modbus, S7, EtherNet/IP, MC, FINS, ADS, OPC UA, gateway. |
| **Vai trò máy** | `Station = Main \| Screen` | Máy chính nối PLC; máy phụ (`.AsScreenStation(url,user,pass)` hoặc `--station screen`) chỉ nối tới máy chính. |

Quyền điều khiển **kiểm tra tại một chỗ** (`ScadaCore.ExecuteAsync` + `AllowsControl`) cho 4 nguồn: `LocalScreen`, `RemoteScreen`, `Mobile`, `Lan`. Đọc luôn được phép. Ma trận quyền có test (`ControlPolicyTests`); đặc biệt: bật điện thoại điều khiển **không** kéo theo màn hình phụ, một màn hình thì không có màn hình phụ.

## Phần riêng của khách hàng (giải pháp) — một dự án, một thư mục
Một giải pháp implement `IScadaSolution`:

| Thành phần | Việc |
|---|---|
| `CreateDefaultConfig()` | Giá trị khởi tạo lần chạy đầu (file `config.json` được tạo ra, nhân viên hiện trường sửa IP/mật khẩu). |
| `Enforce(cfg)` | **Khoá** quyết định nhà máy không được đổi bằng file (ép topology, ép điện thoại chỉ xem, thanh ghi ghi được). Chạy sau khi nạp file. |
| `CreateModules()` | Logic riêng (cảnh báo, báo cáo ca, tag dẫn xuất…), mỗi module một file. Chỉ dùng `SolutionContext`. |
| `CreateUi()` | Giao diện riêng (WPF/WinForms/web/kiosk) hoặc `null` (chạy nền). Chỉ dùng `IScadaView`. |
| `SOLUTION.md` | **Yêu cầu + quyết định + lịch sử thay đổi** của khách hàng: bộ nhớ cho người và LLM sửa về sau. |

Vòng đời (`SolutionRunner.RunAsync`) do framework lo: nạp/tạo cấu hình → `Enforce` → kiểm tra → khởi động máy chính (lõi + dịch vụ) **hoặc** máy phụ → khởi động module → chạy giao diện → tắt gọn; hỗ trợ chạy lại sau khi lưu cài đặt. Điểm vào của khách hàng chỉ một dòng:

```csharp
return await SolutionRunner.RunAsync(new MyFactorySolution(), args);   // --config đường_dẫn  --station main|screen  --headless
```

## Có sẵn
- `solutions/Plciot.Solution.Template` — mẫu trống chạy nền + ví dụ module (`TargetReachedLogModule`) + `SOLUTION.md`. **Sao chép để bắt đầu khách hàng mới.**
- `solutions/Plciot.Solution.Conveyor` — giải pháp tham chiếu có giao diện WPF đầy đủ (Giám sát / Điều khiển / Nhật ký / Cài đặt): một màn hình, điện thoại tắt, ghi D3/D4/D6/D7/D9. Giao diện lấy quyền từ `IScadaView.CanControl`, không tự quyết.

## Ví dụ cấu hình theo nhu cầu
```csharp
// Nhà máy A: một màn hình, điện thoại chỉ xem
new ScadaConfig().UsePlc(PlcSource.ModbusTcp, "192.168.1.10").UseSingleScreen().UseMobile(MobileAccess.MonitorOnly);

// Nhà máy B: 3 màn hình, màn hình phụ chỉ xem, điện thoại không được điều khiển
new ScadaConfig().UsePlc(PlcSource.S7, "192.168.0.1").UseMultiScreen(remoteScreensCanControl: false).UseMobile(MobileAccess.MonitorOnly);

// Nhà máy C: nhiều màn hình đều điều khiển được, điện thoại điều khiển được
new ScadaConfig().UsePlc(PlcSource.OmronFins, "192.168.250.1").UseMultiScreen(remoteScreensCanControl: true).UseMobile(MobileAccess.Control);
```

## Quy trình sửa bằng LLM cho một khách hàng
1. Mô tả yêu cầu bằng tiếng Việt; LLM đọc `scada/CLAUDE.md` và `solutions/<Ten>/SOLUTION.md`.
2. LLM cập nhật `SOLUTION.md` (yêu cầu + lý do), rồi sửa **chỉ** trong thư mục giải pháp.
3. Chạy `dotnet build` + `dotnet test`; đổi chế độ/quyền thì thêm test.
4. Cần khả năng mới dùng chung → LLM đề xuất đưa vào framework (nêu rõ), không nhét vào một khách hàng.

## Đã kiểm thử
102 test xUnit: ma trận quyền điều khiển (11 tổ hợp nguồn × chế độ), một/nhiều màn hình, màn hình phụ điều khiển được/không, điện thoại, thanh ghi tuỳ biến, vòng đời giải pháp (tạo cấu hình, khoá quyết định, module, máy chính + máy phụ cùng một giải pháp), cô lập (framework không tham chiếu giải pháp; giải pháp không tham chiếu MQTT/ASP.NET/OPC). **Chưa chạy**: giao diện WPF của `Conveyor` khi mở thật (mới build), triển khai trên nhiều máy thật.
