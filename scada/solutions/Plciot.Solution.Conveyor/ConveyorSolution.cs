using Plciot.Scada;

namespace Plciot.Solution.Conveyor;

/// <summary>
/// Giải pháp tham chiếu: dây chuyền băng tải, MỘT màn hình điều khiển trên máy chính, điện thoại chỉ xem.
/// Muốn đổi chế độ (nhiều màn hình, điện thoại được điều khiển...) chỉ sửa hai hàm dưới đây — xem SOLUTION.md.
/// </summary>
public sealed class ConveyorSolution : IScadaSolution
{
    public string Name => "Conveyor";

    /// <summary>Giá trị khởi tạo khi chưa có file cấu hình (nhân viên hiện trường sẽ sửa IP, mật khẩu trong file).</summary>
    public ScadaConfig CreateDefaultConfig()
    {
        var cfg = new ScadaConfig { Site = "factory1", Device = "plc01" }
            .UsePlc(PlcSource.ModbusTcp, "192.168.1.10")
            .UseSingleScreen()                       // một màn hình, điều khiển trực tiếp, không client-server
            .UseMobile(MobileAccess.Off)             // điện thoại tắt cho tới khi điền CloudHost/CloudPassword (đổi thành MonitorOnly)
            .UseWritableRegisters(3, 4, 6, 7, 9);    // chế độ, mặt nạ đầu ra, chạy/dừng, mục tiêu, xoá đếm
        return cfg;
    }

    /// <summary>Các quyết định nhà máy KHÔNG được đổi bằng file cấu hình.</summary>
    public void Enforce(ScadaConfig cfg)
    {
        if (cfg.Station == StationRole.Main) cfg.UseSingleScreen();
        if (cfg.Mobile == MobileAccess.Control) cfg.UseMobile(MobileAccess.MonitorOnly);   // khách hàng này không cho điều khiển từ điện thoại
        cfg.UseWritableRegisters(3, 4, 6, 7, 9);
    }

    public IEnumerable<IScadaModule> CreateModules() => Array.Empty<IScadaModule>();

    public IScadaUi? CreateUi() => new ConveyorWpfUi();
}
