# scada/ — hướng dẫn cho LLM (và người) khi sửa code

Đây là **framework SCADA C#** + **giải pháp riêng của từng khách hàng**. Đọc file này trước khi sửa. Tài liệu đầy đủ: `docs/SCADA-FRAMEWORK.md`.

## Bản đồ thư mục
```
src/Plciot.Scada.Core        CỐ ĐỊNH. Driver PLC, ScadaCore (đọc + điều khiển trực tiếp), DeviceState, IScadaView, ScadaConfig, CommandPolicy
src/Plciot.Scada.Services    CỐ ĐỊNH. Cloud/điện thoại, web + RemoteScreenClient (nhiều màn hình), server Modbus/OPC UA, InfluxDB, broker LAN, ScadaHost
src/Plciot.Scada.Framework   CỐ ĐỊNH. IScadaSolution/IScadaModule/IScadaUi, SolutionRunner (vòng đời), ScadaConfigExtensions (UseSingleScreen…)
src/Plciot.Scada.Host        Chạy nền với DefaultSolution (thử nhanh)
solutions/Plciot.Solution.*  RIÊNG TỪNG KHÁCH HÀNG. Mỗi thư mục là một dự án độc lập + SOLUTION.md
tests/Plciot.Scada.Tests     Kiểm thử cho framework và giải pháp mẫu
```

## Quy tắc vàng
1. **Yêu cầu của một khách hàng → chỉ sửa trong `solutions/<TenKhach>/`.** Không sửa Core/Services/Framework cho nhu cầu riêng. Cần một khả năng mới dùng chung được → thêm vào framework, kèm test, và nói rõ trong câu trả lời.
2. **Giải pháp chỉ tham chiếu `Plciot.Scada.Framework`.** Không tham chiếu MQTTnet/ASP.NET/OPC trực tiếp (có test `SolutionIsolationTests` canh việc này). Framework không bao giờ tham chiếu `Plciot.Solution.*`.
3. **Giao diện chỉ dùng `IScadaView`** (`ctx.View`): `State`, `CanControl`, `WriteAsync`. Giao diện KHÔNG tự quyết quyền điều khiển — đọc `CanControl`.
4. **Quyền điều khiển có đúng một nơi kiểm soát:** `ScadaCore.ExecuteAsync(payload, ControlSource, actor)` + `ScadaConfig.AllowsControl`. Không thêm kiểm tra rải rác ở giao diện/dịch vụ; nếu cần nguồn mới, thêm vào `ControlSource` và `AllowsControl`.
5. **Mọi ghi xuống PLC đi qua `CommandPolicy`** (danh sách `WritableRegisters`). Không ghi thẳng driver từ module/giao diện.
6. Chế độ (một/nhiều màn hình, điện thoại, quyền) chọn bằng **extension method đọc như câu** trong `CreateDefaultConfig()`/`Enforce()` của giải pháp. Không đọc cờ thô rải trong mã giao diện.

## Việc thường gặp → làm ở đâu
| Yêu cầu | Làm |
|---|---|
| Khách hàng mới | `cp -r solutions/Plciot.Solution.Template solutions/Plciot.Solution.<Ten>`; đổi tên; điền `SOLUTION.md`; `dotnet sln add` |
| Một màn hình / nhiều màn hình | `.UseSingleScreen()` / `.UseMultiScreen(remoteScreensCanControl: false\|true)` |
| Điện thoại tắt / chỉ xem / điều khiển | `.UseMobile(MobileAccess.Off\|MonitorOnly\|Control)` |
| Khoá quyết định không cho sửa bằng file | `Enforce(cfg)` của giải pháp |
| Thanh ghi D được ghi | `.UseWritableRegisters(...)` |
| Logic riêng (cảnh báo, báo cáo ca, thông báo…) | một file trong `solutions/<Ten>/Modules/` implement `IScadaModule`, thêm vào `CreateModules()` |
| Giao diện riêng | implement `IScadaUi` (xem `Plciot.Solution.Conveyor`), trả về từ `CreateUi()` |
| Giao thức PLC khác | `.UsePlc(PlcSource.X, host)`; giao thức mới → thêm `IRegisterDriver` trong Core + `DriverFactory` + test |
| Máy màn hình phụ | chạy cùng giải pháp với `--station screen` và file cấu hình có `ScreenServerUrl/User/Password` |

## Cách làm việc (LLM)
1. Đọc `solutions/<Ten>/SOLUTION.md` để biết khách hàng đã quyết định gì. **Cập nhật nó trước khi sửa mã** (ghi yêu cầu mới + lý do) và thêm một dòng vào "Lịch sử thay đổi".
2. Sửa nhỏ, mỗi file một việc, đặt tên rõ nghĩa. Bình luận tiếng Việt giải thích *vì sao*.
3. Chạy `dotnet build scada/Plciot.Scada.sln` và `dotnet test scada/tests/Plciot.Scada.Tests`. Thay đổi quyền/chế độ phải có test (xem `FrameworkTests.cs`: ma trận quyền, topology, giải pháp khoá cấu hình).
4. Không đoán hành vi PLC thật: ghi vào `SOLUTION.md` phần nào đã/chưa kiểm chứng trên phần cứng.
5. Không commit mật khẩu hay file `config.json` thật (đã có trong `.gitignore`).
