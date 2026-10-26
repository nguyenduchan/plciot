using Plciot.Scada;
using Plciot.Solution.Template.Modules;

namespace Plciot.Solution.Template;

/// <summary>
/// MẪU: một nhà máy, MỘT màn hình, điện thoại chỉ xem. Sao chép và đổi theo yêu cầu khách hàng; ghi lại yêu cầu trong SOLUTION.md.
///
/// Bảng chọn nhanh (mỗi dòng là MỘT lời gọi trong CreateDefaultConfig/Enforce):
///   Một màn hình, không client-server ............ .UseSingleScreen()
///   Nhiều màn hình, màn hình phụ chỉ xem ......... .UseMultiScreen(remoteScreensCanControl: false)
///   Nhiều màn hình, màn hình phụ được điều khiển .. .UseMultiScreen(remoteScreensCanControl: true)
///   Điện thoại tắt / chỉ xem / điều khiển ......... .UseMobile(MobileAccess.Off | MonitorOnly | Control)
///   Thanh ghi D được phép ghi ..................... .UseWritableRegisters(3, 4, 6, 7, 9)
///   Giao thức PLC .................................. .UsePlc(PlcSource.ModbusTcp, "192.168.1.10")
/// </summary>
public sealed class TemplateSolution : IScadaSolution
{
    public string Name => "Template";

    public ScadaConfig CreateDefaultConfig() =>
        new ScadaConfig { Site = "factory1", Device = "plc01" }
            .UsePlc(PlcSource.ModbusTcp, "192.168.1.10")
            .UseSingleScreen()
            .UseMobile(MobileAccess.Off)
            .UseWritableRegisters(3, 4, 6, 7, 9);

    /// <summary>Quyết định nhà máy không được đổi bằng file cấu hình.</summary>
    public void Enforce(ScadaConfig cfg)
    {
        if (cfg.Station == StationRole.Main) cfg.UseSingleScreen();
        if (cfg.Mobile == MobileAccess.Control) cfg.UseMobile(MobileAccess.MonitorOnly);
        cfg.UseWritableRegisters(3, 4, 6, 7, 9);
    }

    /// <summary>Logic riêng của khách hàng: thêm module ở đây (mỗi module một file trong Modules/).</summary>
    public IEnumerable<IScadaModule> CreateModules() => new IScadaModule[] { new TargetReachedLogModule() };

    /// <summary>Không có giao diện (chạy nền). Muốn giao diện: trả về một IScadaUi, xem Plciot.Solution.Conveyor.</summary>
    public IScadaUi? CreateUi() => null;
}
