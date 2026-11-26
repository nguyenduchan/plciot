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
/// <summary>Nguồn lệnh. Logic = chương trình logic của gateway (GatewayLogic: hẹn giờ, tự tắt, logic mất mạng) — chương trình do chủ trạm duyệt nên luôn được ghi.</summary>
public enum ControlSource { LocalScreen, RemoteScreen, Mobile, Lan, Logic }

public sealed class ControlPolicy
{
    /// <summary>Màn hình trên máy chính.</summary>
    public bool LocalScreen { get; set; } = true;
    /// <summary>Các màn hình phụ (web / máy khách) trong topology nhiều màn hình. false = chỉ giám sát.</summary>
    public bool RemoteScreens { get; set; } = false;
    /// <summary>HMI nói MQTT trong LAN (vai trò operator).</summary>
    public bool Lan { get; set; } = false;
}

/// <summary>Gateway gom thanh ghi D thành số liệu thiết bị con: d.&lt;Child&gt;.&lt;Field&gt; = D[Address] / Scale (telemetry schema:2).</summary>
public sealed class PackMap
{
    public string Child { get; set; } = "";
    public string Field { get; set; } = "";
    /// <summary>Khoá của field trong bản tin MQTT (telemetry d.&lt;child&gt;.&lt;khoá&gt;, config key, cmd key). Rỗng = dùng đúng tên <see cref="Field"/>.</summary>
    public string MqttKey { get; set; } = "";
    public int Address { get; set; }
    public double Scale { get; set; } = 1;
    /// <summary>Khoảng giá trị (đơn vị kỹ thuật, trước khi nhân Scale) cho phép GHI xuống trường này; do tem provisioning đặt. null = không giới hạn.</summary>
    public double? Min { get; set; }
    public double? Max { get; set; }

    // ---- Gán kết nối RÕ RÀNG cho field (Protocol rỗng = field cũ chưa gán, chạy theo nguồn chung ScadaConfig.Source như trước).
    /// <summary>Tên <see cref="PlcSource"/> của giao thức dùng cho field này; rỗng = chưa gán.</summary>
    public string Protocol { get; set; } = "";
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public PackAccess Access { get; set; } = PackAccess.ReadWrite;
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public PlcDataType DataType { get; set; } = PlcDataType.UInt16;
    /// <summary>Đảo thứ tự word cho kiểu ≥ 32-bit (CD AB thay vì AB CD).</summary>
    public bool WordSwap { get; set; }
    /// <summary>Thông số riêng của giao thức theo <see cref="ProtocolSpec.Params"/> (đủ mọi khoá).</summary>
    public Dictionary<string, string> Params { get; set; } = new();
    /// <summary>Tên struct nếu field thuộc một struct (chỉ để nhóm hiển thị; mọi field vẫn là field của thiết bị).</summary>
    public string Group { get; set; } = "";
    /// <summary>false = thiết bị tạm dừng: gateway không đọc, không ghi, không gửi dữ liệu của field này (cấu hình vẫn giữ). Đặt chung cho mọi field của một thiết bị.</summary>
    public bool Enabled { get; set; } = true;
    /// <summary>
    /// Đầu ra số (DO / relay / công tắc): thời gian TỐI THIỂU (ms) giữa hai lần ĐỔI trạng thái — bảo vệ tiếp điểm relay, máy nén… khỏi bị bật/tắt dồn dập.
    /// 0 = không giới hạn. Gửi lên cloud trong bản tin config (<c>toggleMs</c>) để webapp/server chặn trước; gateway (<see cref="ToggleGuard"/>)
    /// và firmware board Waveshare (DO trên board) tự chặn lần cuối — không tin hoàn toàn vào cloud hay script.
    /// </summary>
    public int MinToggleMs { get; set; }
    /// <summary>
    /// Đầu ra số trên board Waveshare chạy ĐỘC LẬP (DO của chính board, Unit 0): mất người điều khiển (MQTT cloud khi chạy độc lập,
    /// PC giữ lease khi ở chế độ gateway) liên tục quá ngần này GIÂY thì firmware tự TẮT đầu ra — không có ai thấy/tắt được từ xa.
    /// Bật lại khi đang mất kết nối (vd. từ GatewayApp qua LAN) cũng chỉ giữ được ngần ấy. 0 = giữ nguyên trạng thái (mặc định).
    /// Gateway PC (lõi C#) không dùng trường này. Không tự bật lại khi có kết nối: người vận hành quyết định.
    /// </summary>
    public int LossOffSec { get; set; }

    /// <summary>Khoá thực sự đi trên MQTT.</summary>
    [JsonIgnore] public string WireKey => string.IsNullOrWhiteSpace(MqttKey) ? Field : MqttKey.Trim();
    [JsonIgnore] public bool IsBound => Protocol.Length > 0;
    [JsonIgnore] public PlcSource? Source => Enum.TryParse<PlcSource>(Protocol, out var s) ? s : null;
    [JsonIgnore] public int Words => PackCodec.Words(DataType);
    public string Param(string key) => Params.TryGetValue(key, out var v) ? v : "";
}

public enum PlcSource { Gateway, ModbusTcp, ModbusRtu }   // giao thức khác (S7, EtherNet/IP, MC, FINS, ADS, OPC UA) đã gỡ; mở rộng sau
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
    /// <summary>Phiên bản định dạng file cấu hình (0 = file cũ chưa ghi). Ứng dụng nâng dần từng bước khi mở file của bản cũ (GatewayApp/ConfigMigrations.cs).</summary>
    public int ConfigSchema { get; set; }
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
    /// <summary>Đóng gói thiết bị con từ thanh ghi (rỗng = chỉ gửi r[] kiểu băng tải cũ).</summary>
    public List<PackMap> Pack { get; set; } = new();
    /// <summary>Kết nối tới từng PLC theo giao thức, dùng cho các field đã gán giao thức (<see cref="PackMap.Protocol"/>).</summary>
    public List<PlcConnection> Connections { get; set; } = new();
    /// <summary>Có field đã gán giao thức → lõi đọc/ghi theo từng field (kiểu, quyền, thông số), không dùng nguồn chung và không đọc D0–D39 ngầm.</summary>
    [JsonIgnore] public bool PackBound => Pack.Any(p => p.IsBound);
    public PlcConnection? ConnectionFor(PlcSource s) => Connections.FirstOrDefault(c => c.Protocol == s);

    /// <summary>Quyền ghi theo nguồn lệnh (đọc luôn được phép).</summary>
    public bool AllowsControl(ControlSource s) => s switch
    {
        ControlSource.LocalScreen => Control.LocalScreen,
        ControlSource.RemoteScreen => Topology == Topology.MultiScreen && Control.RemoteScreens,
        ControlSource.Mobile => Mobile == MobileAccess.Control,
        ControlSource.Lan => Control.Lan,
        ControlSource.Logic => true,
        _ => false,
    };

    // ---- Nguồn dữ liệu PLC
    [JsonConverter(typeof(TolerantPlcSourceConverter))]
    public PlcSource Source { get; set; } = PlcSource.Gateway;
    public string PlcHost { get; set; } = "192.168.1.10";
    /// <summary>0 = cổng mặc định của giao thức (Modbus 502).</summary>
    public int PlcPort { get; set; } = 0;
    public int ModbusUnit { get; set; } = 1;
    // Modbus RTU (RS485): PlcHost = tên cổng (COM3), PlcPort = baud (0 = 19200), parity Even/None/Odd (PLC Xinje: 19200 8E1)
    public string SerialParity { get; set; } = "Even";
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
    /// <summary>Cổng MQTTS công khai trên VPS (HAProxy <c>PUB_PORT_MQTTS</c>, mặc định 48263). WSS qua tunnel dùng 443.</summary>
    public int CloudPort { get; set; } = 48263;
    /// <summary>"mqtts" (TCP+TLS thẳng VPS, mặc định) hoặc "wss" (WebSocket+TLS, qua cổng 443 / Cloudflare Tunnel).</summary>
    public string CloudTransport { get; set; } = "mqtts";
    public string CloudWsPath { get; set; } = "/";
    public string CloudUser { get; set; } = "gw";
    public string CloudPassword { get; set; } = "";
    /// <summary>SHA-256 (hex) của chứng chỉ máy chủ; trống = xác thực chuỗi chứng chỉ thông thường. Dùng cho chứng chỉ tự ký.</summary>
    public string CloudPinSha256 { get; set; } = "";
    /// <summary>Nhịp tim: telemetry KHÔNG đổi chỉ gửi lại sau khoảng này (giữ webapp thấy gateway còn sống).</summary>
    public int CloudTelemetryMinMs { get; set; } = 1000;
    /// <summary>Telemetry ĐỔI được gửi ngay, cách nhau tối thiểu khoảng này (chống dồn; server ingest giới hạn ~120 tin/phút/thiết bị).</summary>
    public int CloudTelemetryFastMs { get; set; } = 300;
    /// <summary>Tốc độ gửi telemetry (ms) khi KHÔNG ai xem webapp = chu kỳ lưu của gói (server báo lúc đăng ký). Có người xem (server báo sys:live) thì gửi nhanh theo CloudTelemetryMinMs. 0 = tắt (luôn gửi nhanh như cũ).</summary>
    public int CloudIdleTelemetryMs { get; set; }
    /// <summary>Lưu lịch sử giá trị trong SQLite của gateway (history.db): số ngày giữ. 0 = không giới hạn.</summary>
    public int LocalHistoryDays { get; set; } = 30;
    /// <summary>Chu kỳ ghi một mẫu vào lịch sử cục bộ (giây), mỗi field.</summary>
    public int LocalHistoryIntervalSec { get; set; } = 10;
    /// <summary>Số ngày cloud lưu data theo gói (server báo lúc đăng ký). Dữ liệu offline chỉ được bù trong khoảng này. 0 = không giới hạn.</summary>
    public int CloudRetentionDays { get; set; } = 1;
    // ---- Kích hoạt gateway PC (xem GatewayActivation). "none" = không yêu cầu (mặc định, giữ nguyên hành vi cũ).
    /// <summary>"none" | "online" (server gắn máy khi enroll bằng QR) | "offline" (file giấy phép theo ID máy, không cần mạng).</summary>
    public string LicenseMode { get; set; } = "none";
    /// <summary>offline: file giấy phép admin cấp; online: dấu "đã gắn" lưu cục bộ.</summary>
    public string LicenseFile { get; set; } = "license.json";
    public string LicenseServerUrl { get; set; } = "https://plc.dieukhientudong.net";
    /// <summary>QR tem của thiết bị (chỉ dùng khi LicenseMode = online).</summary>
    public string GatewayQr { get; set; } = "";
    /// <summary>URL API cloud đã dùng để enroll; gateway hỏi lại để biết tem đã có user (claimed) chưa.</summary>
    public string CloudApiUrl { get; set; } = "";
    /// <summary>Khoá RIÊNG ECDSA P-256 của gateway (PKCS#8 base64, mã hoá DPAPI khi lưu). Khoá công khai gửi server lúc ghép cặp; không bao giờ rời máy.</summary>
    public string GatewayKey { get; set; } = "";
    /// <summary>Khoá công khai (SPKI base64url) của server để kiểm chữ ký lệnh cloud — nhận qua HTTPS lúc enroll/config. Có khoá → lệnh cloud KHÔNG ký bị từ chối, lệnh ký hợp lệ không cần OTP. Rỗng = bản server cũ (vẫn cần mở khoá cục bộ).</summary>
    public string CloudCmdKey { get; set; } = "";
    /// <summary>Mật khẩu CỤC BỘ mở khoá sửa cấu hình/điều khiển tại máy (băm PBKDF2, xem LocalPassword). Không phụ thuộc webapp/Internet. Rỗng = chưa đặt.</summary>
    public string LocalAdminHash { get; set; } = "";
    /// <summary>ID máy (băm MachineGuid) lúc đăng ký. Khác máy hiện tại = config bị sao chép sang PC khác → không nối cloud, phải "Chuyển gateway sang PC này".</summary>
    public string BoundMachineId { get; set; } = "";
    /// <summary>false = tem chưa có user: chỉ đồng bộ setting (config/status), KHÔNG gửi telemetry/history. Server cũng bỏ nếu gửi.</summary>
    public bool CloudSendData { get; set; } = true;
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
    /// <summary>Chống phát lại: lệnh từ cloud có "ts" cũ (hoặc ở tương lai) hơn khoảng này bị từ chối. 0 = tắt. Cần đồng hồ gateway lệch server không quá khoảng này.</summary>
    public int CmdMaxAgeSec { get; set; } = 10;

    /// <summary>Id MQTT ngẫu nhiên do server cấp khi đăng ký (enroll): gateway ghép vào topic gw/&lt;MqttId&gt;/&lt;kind&gt;. Rỗng = chưa đăng ký cloud.</summary>
    public string MqttId { get; set; } = "";
    /// <summary>Giải pháp (kiểu UI giám sát/điều khiển của webapp) do gateway setup quyết định; gửi kèm bản tin config để server đồng bộ cho webapp. Rỗng = giao diện cơ bản. Mỗi gateway đúng một giải pháp.</summary>
    public string Solution { get; set; } = "";
    [JsonIgnore] public string BaseTopic => Contract.IsMqttId(MqttId) ? Contract.Base(MqttId) : Contract.LocalBase(Site, Device);
    /// <summary>Web/màn hình phụ chỉ chạy ở topology nhiều màn hình (một màn hình thì không có client-server).</summary>
    [JsonIgnore] public bool WebActive => WebEnabled && Topology == Topology.MultiScreen;

    /// <summary>Kiểm tra việc gán giao thức/kiểu/quyền/thông số của Pack và các kết nối; không gán gì thì bỏ qua (chế độ cũ).</summary>
    string? ValidateBinding()
    {
        if (!PackBound) return null;
        var unbound = Pack.FirstOrDefault(p => !p.IsBound);
        if (unbound != null) return $"Pack: {unbound.Child}.{unbound.Field} chưa gán giao thức (đã có field khác được gán). Gán hoặc xoá field này.";
        var seen = new Dictionary<string, string>();
        foreach (var p in Pack)
        {
            var what = $"{p.Child}.{p.Field}";
            if (p.Source is not { } src || Array.IndexOf(ProtocolSpec.Streamable, src) < 0) return $"{what}: giao thức \"{p.Protocol}\" không hợp lệ.";
            var e = ProtocolSpec.ValidateParams(src, p.Params, what);
            if (e != null) return e;
            if (p.Address + p.Words > Contract.MaxRegister) return $"{what}: kiểu {p.DataType} chiếm {p.Words} word từ D{p.Address}, vượt quá D{Contract.MaxRegister - 1}.";
            // hai field cùng một PLC (cùng giao thức + thông số) không được chồng lên nhau trên các word
            var key = PackDriverPool.Key(p);
            for (var i = 0; i < p.Words; i++)
            {
                var cell = key + "@" + (p.Address + i);
                if (seen.TryGetValue(cell, out var other)) return $"{what} và {other} chồng nhau tại D{p.Address + i} (cùng PLC).";
                seen[cell] = what;
            }
        }
        foreach (var src in Pack.Select(p => p.Source!.Value).Distinct())
        {
            var c = ConnectionFor(src);
            var name = ProtocolSpec.Name(src);
            if (c == null) return $"Thiếu kết nối cho giao thức {name} (Connections).";
            if (ProtocolSpec.UsesHostPort(src))
            {
                if (string.IsNullOrWhiteSpace(c.Host)) return $"Kết nối {name}: thiếu địa chỉ.";
                if (c.Port is < 1 or > 65535) return $"Kết nối {name}: cổng không hợp lệ.";
            }
            var oe = ProtocolSpec.ValidateParams(src, c.Options, $"Kết nối {name}", ProtocolSpec.ConnOptions(src));
            if (oe != null) return oe;
        }
        if (Connections.GroupBy(c => c.Protocol).Any(g => g.Count() > 1)) return "Mỗi giao thức chỉ có một kết nối.";
        return null;
    }

    /// <param name="driverSupplied">
    /// true khi app chủ tự cấp driver thay cho kết nối theo cấu hình (vd. PLC giả của chế độ Demo trong GatewayApp):
    /// khi đó không cần địa chỉ PLC / OPC UA endpoint. Cấu hình thật (driver tạo từ cấu hình) luôn gọi với false.
    /// </param>
    public string? Validate(bool driverSupplied = false)
    {
        var safe = new System.Text.RegularExpressions.Regex("^[A-Za-z0-9_-]{1,48}$");
        if (!safe.IsMatch(Site) || !safe.IsMatch(Device)) return "Site/Device chỉ gồm chữ, số, '_' và '-'.";
        if (MqttId.Length > 0 && !Contract.IsMqttId(MqttId)) return "MqttId phải là 16 ký tự hex do server cấp.";
        if (WritableRegisters.Any(r => r is < 0 or >= Contract.MaxRegister) || WritableRegisters.Distinct().Count() != WritableRegisters.Count)
            return "WritableRegisters phải là số D 0–299, không trùng.";
        if (Station == StationRole.Screen)
        {
            if (Topology != Topology.MultiScreen) return "Máy màn hình phụ chỉ dùng được ở topology MultiScreen.";
            return string.IsNullOrWhiteSpace(ScreenServerUrl) ? "Thiếu địa chỉ máy chính (ScreenServerUrl)." : null;
        }
        if (LocalPort is < 1 or > 65535) return "Cổng broker nội bộ không hợp lệ.";
        if (WebActive && (WebPort is < 1 or > 65535 || WebPort == LocalPort)) return "Cổng web không hợp lệ hoặc trùng cổng broker.";
        var bound = PackBound || driverSupplied;   // Pack đã gán giao thức hoặc driver do app cấp: nguồn chung không cần địa chỉ
        if (!bound && Source != PlcSource.Gateway && string.IsNullOrWhiteSpace(PlcHost)) return "Thiếu địa chỉ PLC.";
        if (ModbusServerEnabled && (ModbusServerPort is < 1 or > 65535)) return "Cổng Modbus server không hợp lệ.";
        if (InfluxEnabled && (string.IsNullOrWhiteSpace(InfluxUrl) || string.IsNullOrWhiteSpace(InfluxToken))) return "Thiếu URL/token InfluxDB.";
        if (Source == PlcSource.ModbusRtu && !Enum.TryParse<System.IO.Ports.Parity>(SerialParity, true, out _)) return "SerialParity phải là None, Even hoặc Odd.";
        if (PollMs < 100) return "Chu kỳ đọc tối thiểu 100 ms.";
        var unset = Pack.FirstOrDefault(x => !string.IsNullOrWhiteSpace(x.Child) && !string.IsNullOrWhiteSpace(x.Field) && (x.Address < 0 || x.Scale <= 0));
        if (unset != null) return $"Pack: {unset.Child}.{unset.Field} chưa khai báo thanh ghi D / hệ số (mở trang Thiết bị để khai báo).";
        if (Pack.Any(x => string.IsNullOrWhiteSpace(x.Child) || string.IsNullOrWhiteSpace(x.Field) || x.Address is < 0 or >= Contract.MaxRegister || x.Scale <= 0))
            return "Pack: child/field không được trống, địa chỉ D 0–299, scale > 0.";
        var packErr = ValidateBinding();
        if (packErr != null) return packErr;
        if (Pack.Any(x => x.Min.HasValue && x.Max.HasValue && x.Min > x.Max)) return "Pack: Min không được lớn hơn Max.";
        // khoá MQTT: cloud chỉ nhận chữ/số/_ (≤32 ký tự), và không trùng nhau trong cùng một thiết bị
        var wire = new System.Text.RegularExpressions.Regex("^[A-Za-z0-9_]{1,32}$");
        var badWire = Pack.FirstOrDefault(x => !wire.IsMatch(x.WireKey));
        if (badWire != null) return $"Pack: khoá MQTT \"{badWire.WireKey}\" của {badWire.Child}.{badWire.Field} chỉ gồm chữ, số, '_' (tối đa 32 ký tự).";
        var dupWire = Pack.GroupBy(x => (x.Child, x.WireKey)).FirstOrDefault(g => g.Count() > 1);
        if (dupWire != null) return $"Pack: khoá MQTT \"{dupWire.Key.WireKey}\" bị trùng trong thiết bị {dupWire.Key.Child}.";
        if (CmdMaxAgeSec < 0) return "CmdMaxAgeSec không được âm.";
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
        cfg.GatewayKey = Unprotect(cfg.GatewayKey);
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
        copy.GatewayKey = Protect(copy.GatewayKey);
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
