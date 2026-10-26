using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Plciot.Scada;

/// <summary>Nguồn dữ liệu PLC. Gateway = ESP32 nối vào broker nội bộ; còn lại là máy này nói thẳng giao thức Ethernet của PLC.</summary>
/// <summary>Vai trò của MÁY này trong hệ thống.</summary>
public enum StationRole
{
    /// <summary>Máy chính: nối PLC, chạy lõi và các dịch vụ; có màn hình điều khiển riêng của nó.</summary>
    Main,
    /// <summary>Máy màn hình phụ (chỉ ở topology nhiều màn hình): không nối PLC, nối tới máy chính qua mạng.</summary>
    Screen,
}

/// <summary>Cách bố trí màn hình của nhà máy.</summary>
public enum Topology
{
    /// <summary>MỘT màn hình duy nhất trên máy chính; điều khiển trực tiếp, KHÔNG client-server (không mở web/cổng màn hình phụ).</summary>
    SingleScreen,
    /// <summary>Nhiều màn hình: máy chính phục vụ các màn hình phụ (client-server). Quyền điều khiển của màn hình phụ do <see cref="ControlPolicy.RemoteScreens"/>.</summary>
    MultiScreen,
}

/// <summary>Quyền của điện thoại (qua MQTT server).</summary>
public enum MobileAccess { Off, MonitorOnly, Control }

/// <summary>Nguồn của một lệnh ghi: chính sách điều khiển được kiểm tra tại MỘT chỗ duy nhất (ScadaCore).</summary>
public enum ControlSource { LocalScreen, RemoteScreen, Mobile, Lan }

public sealed class ControlPolicy
{
    /// <summary>Màn hình trên máy chính.</summary>
    public bool LocalScreen { get; set; } = true;
    /// <summary>Các màn hình phụ (web / máy khách) trong topology nhiều màn hình. false = chỉ giám sát.</summary>
    public bool RemoteScreens { get; set; } = false;
    /// <summary>HMI nói MQTT trong LAN (vai trò operator).</summary>
    public bool Lan { get; set; } = false;
}

public enum PlcSource { Gateway, ModbusTcp, ModbusRtu, S7, EtherNetIp, MitsubishiMc, OmronFins, BeckhoffAds, OpcUa }
public enum LocalRole { Device, Monitor, Operator }

public sealed class LocalUser
{
    public string User { get; set; } = "";
    public string Password { get; set; } = "";
    /// <summary>Device: gateway (ghi telemetry/status/ack/history, đọc cmd). Monitor: chỉ xem. Operator: xem + gửi cmd.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public LocalRole Role { get; set; } = LocalRole.Monitor;
}

public sealed class ScadaConfig
{
    public string Site { get; set; } = "factory1";
    public string Device { get; set; } = "plc01";

    // ---- Các chế độ CỐ ĐỊNH của framework (giải pháp của khách hàng chọn giá trị, không viết lại logic)
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public StationRole Station { get; set; } = StationRole.Main;
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public Topology Topology { get; set; } = Topology.SingleScreen;
    public ControlPolicy Control { get; set; } = new();
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public MobileAccess Mobile { get; set; } = MobileAccess.Off;
    /// <summary>Các thanh ghi D mà MỌI nguồn được phép ghi. Mỗi khách hàng có thể khác nhau (đặt trong giải pháp của họ).</summary>
    public List<int> WritableRegisters { get; set; } = new() { 3, 4, 6, 7, 9 };

    /// <summary>Quyền ghi theo nguồn lệnh (đọc luôn được phép).</summary>
    public bool AllowsControl(ControlSource s) => s switch
    {
        ControlSource.LocalScreen => Control.LocalScreen,
        ControlSource.RemoteScreen => Topology == Topology.MultiScreen && Control.RemoteScreens,
        ControlSource.Mobile => Mobile == MobileAccess.Control,
        ControlSource.Lan => Control.Lan,
        _ => false,
    };

    // ---- Nguồn dữ liệu PLC
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public PlcSource Source { get; set; } = PlcSource.Gateway;
    public string PlcHost { get; set; } = "192.168.1.10";
    /// <summary>0 = cổng mặc định của giao thức (Modbus 502, S7 102, EtherNet/IP 44818, MC 5001, FINS 9600, ADS 48898).</summary>
    public int PlcPort { get; set; } = 0;
    public int ModbusUnit { get; set; } = 1;
    // Modbus RTU (RS485): PlcHost = tên cổng (COM3), PlcPort = baud (0 = 19200), parity Even/None/Odd (PLC Xinje: 19200 8E1)
    public string SerialParity { get; set; } = "Even";
    // Siemens S7 (DB chứa INT[300]: thanh ghi D n = DBW(2*n))
    public string S7Cpu { get; set; } = "S71500";      // S7200 | S7300 | S7400 | S71200 | S71500
    public int S7Rack { get; set; } = 0;
    public int S7Slot { get; set; } = 1;
    public int S7Db { get; set; } = 1;
    // Rockwell EtherNet/IP: tag INT[300]
    public string EipTag { get; set; } = "PLC_D";
    public int EipSlot { get; set; } = 0;
    // Mitsubishi MC (3E nhị phân, TCP): thiết bị D
    public string McPlcType { get; set; } = "Q";        // Q | L | QnA | iQ-R | iQ-L
    // Omron FINS: vùng DM
    public string FinsProtocol { get; set; } = "udp";   // udp | tcp
    public int FinsDestNode { get; set; } = 0;           // 0 = lấy octet cuối của PlcHost
    public int FinsSourceNode { get; set; } = 0;
    // Beckhoff ADS (cần router ADS: TwinCAT hoặc AdsRouter trên máy này)
    public string AdsNetId { get; set; } = "127.0.0.1.1.1";
    public int AdsPort { get; set; } = 851;
    public string AdsSymbol { get; set; } = "GVL_PLC.D";   // ARRAY[0..299] OF INT
    // OPC UA client
    public string OpcUaEndpoint { get; set; } = "opc.tcp://127.0.0.1:4840";
    public string OpcUaImageNode { get; set; } = "ns=2;s=PLC_D";          // UInt16[300]
    public string OpcUaWriteNode { get; set; } = "ns=2;s=PLC_W{a}";        // {a} = số thanh ghi D
    public bool OpcUaSecurity { get; set; } = false;                      // true = Sign&Encrypt
    public bool OpcUaAcceptUntrusted { get; set; } = false;
    public int PollMs { get; set; } = 1000;
    public int HistoryMs { get; set; } = 60000;

    // ---- Broker nội bộ (không mã hoá, chỉ trong LAN nhà máy). Tuỳ chọn: chỉ cần khi dùng gateway ESP32 hoặc cho HMI MQTT trong LAN.
    //      Điều khiển từ giao diện của chương trình KHÔNG đi qua broker: gọi thẳng driver PLC.
    public bool LocalBrokerEnabled { get; set; } = false;
    public string LocalBind { get; set; } = "0.0.0.0";
    public int LocalPort { get; set; } = 1883;
    public List<LocalUser> LocalUsers { get; set; } = new()
    {
        new LocalUser { User = "gw", Password = "", Role = LocalRole.Device },
    };

    // ---- Cầu nối lên cloud (luôn mã hoá)
    /// <summary>Cầu nối cloud chạy khi điện thoại được phép (xem hoặc điều khiển) — suy ra từ <see cref="Mobile"/>.</summary>
    [JsonIgnore] public bool CloudEnabled => Mobile != MobileAccess.Off;
    public string CloudHost { get; set; } = "plc-mqtt.dieukhientudong.net";
    public int CloudPort { get; set; } = 8883;
    /// <summary>"mqtts" (TCP+TLS, mặc định) hoặc "wss" (WebSocket+TLS, qua cổng 443 khi tường lửa chặn 8883).</summary>
    public string CloudTransport { get; set; } = "mqtts";
    public string CloudWsPath { get; set; } = "/";
    public string CloudUser { get; set; } = "gw";
    public string CloudPassword { get; set; } = "";
    /// <summary>SHA-256 (hex) của chứng chỉ máy chủ; trống = xác thực chuỗi chứng chỉ thông thường. Dùng cho chứng chỉ tự ký.</summary>
    public string CloudPinSha256 { get; set; } = "";
    public int CloudTelemetryMinMs { get; set; } = 1000;
    public string ClientSuffix { get; set; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();

    // ---- Giao diện web cục bộ (nhiều màn hình trong nhà máy). Dùng tài khoản LocalUsers vai trò Monitor/Operator.
    public bool WebEnabled { get; set; } = true;
    /// <summary>false (mặc định) = web chỉ GIÁM SÁT (kể cả máy khách giám sát từ xa); true = tài khoản operator được điều khiển qua web.</summary>
    public string WebBind { get; set; } = "0.0.0.0";
    public int WebPort { get; set; } = 8080;
    /// <summary>Đường dẫn .pfx để bật HTTPS cho web cục bộ (trống = HTTP thường, chỉ nên dùng trong LAN tin cậy).</summary>
    public string WebCertPath { get; set; } = "";
    public string WebCertPassword { get; set; } = "";

    // ---- Lắng nghe làm server cho HMI/MES khác (chỉ đọc)
    public string ServerBind { get; set; } = "0.0.0.0";
    public bool ModbusServerEnabled { get; set; } = false;
    public int ModbusServerPort { get; set; } = 1502;
    public bool OpcUaServerEnabled { get; set; } = false;
    public int OpcUaServerPort { get; set; } = 4840;

    // ---- InfluxDB 2 (cho Grafana; cùng sơ đồ với luồng Node-RED)
    public bool InfluxEnabled { get; set; } = false;
    public string InfluxUrl { get; set; } = "http://127.0.0.1:8086";
    public string InfluxOrg { get; set; } = "plciot";
    public string InfluxBucket { get; set; } = "plc";
    public string InfluxToken { get; set; } = "";
    public int InfluxEverySec { get; set; } = 2;

    // ---- Máy màn hình phụ (Station = Screen): nối tới máy chính
    public string ScreenServerUrl { get; set; } = "http://192.168.1.20:8080";
    public string ScreenServerUser { get; set; } = "viewer";
    public string ScreenServerPassword { get; set; } = "";

    // ---- Điều khiển từ xa
    /// <summary>Công tắc an toàn: false = lệnh ghi từ điện thoại/cloud bị từ chối tại nhà máy (vẫn xem được).</summary>
    [JsonIgnore] public bool AllowRemoteControl => Mobile == MobileAccess.Control;
    public int RemoteCmdPerSec { get; set; } = 5;

    [JsonIgnore] public string BaseTopic => Contract.Base(Site, Device);
    /// <summary>Web/màn hình phụ chỉ chạy ở topology nhiều màn hình (một màn hình thì không có client-server).</summary>
    [JsonIgnore] public bool WebActive => WebEnabled && Topology == Topology.MultiScreen;

    public string? Validate()
    {
        var safe = new System.Text.RegularExpressions.Regex("^[A-Za-z0-9_-]{1,48}$");
        if (!safe.IsMatch(Site) || !safe.IsMatch(Device)) return "Site/Device chỉ gồm chữ, số, '_' và '-'.";
        if (WritableRegisters.Any(r => r is < 0 or >= Contract.MaxRegister) || WritableRegisters.Distinct().Count() != WritableRegisters.Count)
            return "WritableRegisters phải là số D 0–299, không trùng.";
        if (Station == StationRole.Screen)
        {
            if (Topology != Topology.MultiScreen) return "Máy màn hình phụ chỉ dùng được ở topology MultiScreen.";
            return string.IsNullOrWhiteSpace(ScreenServerUrl) ? "Thiếu địa chỉ máy chính (ScreenServerUrl)." : null;
        }
        if (LocalPort is < 1 or > 65535) return "Cổng broker nội bộ không hợp lệ.";
        if (WebActive && (WebPort is < 1 or > 65535 || WebPort == LocalPort)) return "Cổng web không hợp lệ hoặc trùng cổng broker.";
        if (Source is not (PlcSource.Gateway or PlcSource.OpcUa) && string.IsNullOrWhiteSpace(PlcHost)) return "Thiếu địa chỉ PLC.";
        if (Source == PlcSource.OpcUa && string.IsNullOrWhiteSpace(OpcUaEndpoint)) return "Thiếu OPC UA endpoint.";
        if (ModbusServerEnabled && (ModbusServerPort is < 1 or > 65535)) return "Cổng Modbus server không hợp lệ.";
        if (OpcUaServerEnabled && (OpcUaServerPort is < 1 or > 65535)) return "Cổng OPC UA server không hợp lệ.";
        if (InfluxEnabled && (string.IsNullOrWhiteSpace(InfluxUrl) || string.IsNullOrWhiteSpace(InfluxToken))) return "Thiếu URL/token InfluxDB.";
        if (Source == PlcSource.ModbusRtu && !Enum.TryParse<System.IO.Ports.Parity>(SerialParity, true, out _)) return "SerialParity phải là None, Even hoặc Odd.";
        if (PollMs < 100) return "Chu kỳ đọc tối thiểu 100 ms.";
        if (CloudEnabled)
        {
            if (string.IsNullOrWhiteSpace(CloudHost)) return "Thiếu địa chỉ máy chủ cloud.";
            if (CloudTransport is not ("mqtts" or "wss")) return "CloudTransport phải là mqtts hoặc wss.";
            if (string.IsNullOrWhiteSpace(CloudUser)) return "Thiếu tài khoản cloud.";
        }
        if (LocalUsers.Any(u => string.IsNullOrWhiteSpace(u.User))) return "Tài khoản nội bộ không được để trống.";
        return null;
    }
}

/// <summary>Lưu cấu hình dạng JSON; mật khẩu được mã hoá bằng DPAPI (Windows, theo máy) khi ghi ra đĩa.</summary>
public static class ConfigStore
{
    const string Prefix = "dpapi:";
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static string DefaultPath()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlciotScada");
        return Path.Combine(dir, "config.json");
    }

    /// <summary>File cấu hình riêng của một giải pháp: ProgramData\PlciotScada\&lt;ten-giai-phap&gt;\config.json.</summary>
    public static string PathFor(string solutionName)
    {
        var slug = new string(solutionName.ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray()).Trim('-');
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlciotScada", slug.Length > 0 ? slug : "default");
        return Path.Combine(dir, "config.json");
    }

    public static ScadaConfig Load(string path)
    {
        if (!File.Exists(path)) return new ScadaConfig();
        var cfg = JsonSerializer.Deserialize<ScadaConfig>(File.ReadAllText(path), Json) ?? new ScadaConfig();
        cfg.CloudPassword = Unprotect(cfg.CloudPassword);
        foreach (var u in cfg.LocalUsers) u.Password = Unprotect(u.Password);
        cfg.WebCertPassword = Unprotect(cfg.WebCertPassword);
        cfg.InfluxToken = Unprotect(cfg.InfluxToken);
        cfg.ScreenServerPassword = Unprotect(cfg.ScreenServerPassword);
        return cfg;
    }

    public static void Save(string path, ScadaConfig cfg)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        var copy = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(cfg, Json), Json)!;
        copy.CloudPassword = Protect(copy.CloudPassword);
        foreach (var u in copy.LocalUsers) u.Password = Protect(u.Password);
        copy.WebCertPassword = Protect(copy.WebCertPassword);
        copy.InfluxToken = Protect(copy.InfluxToken);
        copy.ScreenServerPassword = Protect(copy.ScreenServerPassword);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(copy, Json));
        File.Move(tmp, path, overwrite: true);
    }

    static string Protect(string s)
    {
        if (string.IsNullOrEmpty(s) || !OperatingSystem.IsWindows()) return s;
        var enc = ProtectedData.Protect(Encoding.UTF8.GetBytes(s), null, DataProtectionScope.LocalMachine);
        return Prefix + Convert.ToBase64String(enc);
    }

    static string Unprotect(string s)
    {
        if (string.IsNullOrEmpty(s) || !s.StartsWith(Prefix, StringComparison.Ordinal)) return s;
        if (!OperatingSystem.IsWindows()) return "";
        try
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(s[Prefix.Length..]), null, DataProtectionScope.LocalMachine));
        }
        catch (CryptographicException) { return ""; }
    }
}
