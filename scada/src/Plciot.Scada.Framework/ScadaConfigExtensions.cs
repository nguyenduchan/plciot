namespace Plciot.Scada;

/// <summary>
/// Các chế độ cố định của framework, viết như câu để giải pháp của khách hàng dễ đọc và dễ sửa:
/// <code>
/// cfg.UseSingleScreen()                         // một màn hình điều khiển, không client-server
///    .UseMobile(MobileAccess.MonitorOnly);       // điện thoại chỉ xem
/// cfg.UseMultiScreen(remoteScreensCanControl: false)   // nhiều màn hình, màn hình phụ chỉ xem
///    .UseMobile(MobileAccess.Control);                  // điện thoại được điều khiển
/// </code>
/// </summary>
public static class ScadaConfigExtensions
{
    /// <summary>MỘT màn hình duy nhất trên máy chính, điều khiển trực tiếp PLC, KHÔNG client-server (không mở web / cổng màn hình phụ).</summary>
    public static ScadaConfig UseSingleScreen(this ScadaConfig cfg)
    {
        cfg.Topology = Topology.SingleScreen;
        cfg.Station = StationRole.Main;
        cfg.Control.LocalScreen = true;
        cfg.Control.RemoteScreens = false;
        return cfg;
    }

    /// <summary>Nhiều màn hình (client-server): máy chính phục vụ web/màn hình phụ.</summary>
    /// <param name="remoteScreensCanControl">true = màn hình phụ (tài khoản operator) được điều khiển; false = chỉ giám sát.</param>
    public static ScadaConfig UseMultiScreen(this ScadaConfig cfg, bool remoteScreensCanControl = false, int webPort = 8080)
    {
        cfg.Topology = Topology.MultiScreen;
        cfg.WebEnabled = true;
        cfg.WebPort = webPort;
        cfg.Control.LocalScreen = true;
        cfg.Control.RemoteScreens = remoteScreensCanControl;
        return cfg;
    }

    /// <summary>Điện thoại (qua MQTT server): Off = không kết nối; MonitorOnly = chỉ xem; Control = xem + điều khiển.</summary>
    public static ScadaConfig UseMobile(this ScadaConfig cfg, MobileAccess access)
    {
        cfg.Mobile = access;
        return cfg;
    }

    /// <summary>Danh sách thanh ghi D mà mọi nguồn được ghi (riêng từng khách hàng).</summary>
    public static ScadaConfig UseWritableRegisters(this ScadaConfig cfg, params int[] registers)
    {
        cfg.WritableRegisters = registers.Distinct().ToList();
        return cfg;
    }

    /// <summary>Nguồn dữ liệu PLC (giao thức + địa chỉ).</summary>
    public static ScadaConfig UsePlc(this ScadaConfig cfg, PlcSource source, string host, int port = 0)
    {
        cfg.Source = source;
        cfg.PlcHost = host;
        cfg.PlcPort = port;
        return cfg;
    }

    /// <summary>Biến máy này thành MÁY MÀN HÌNH PHỤ nối tới máy chính (chỉ ở topology nhiều màn hình).</summary>
    public static ScadaConfig AsScreenStation(this ScadaConfig cfg, string mainStationUrl, string user, string password)
    {
        cfg.Topology = Topology.MultiScreen;
        cfg.Station = StationRole.Screen;
        cfg.ScreenServerUrl = mainStationUrl;
        cfg.ScreenServerUser = user;
        cfg.ScreenServerPassword = password;
        return cfg;
    }
}
