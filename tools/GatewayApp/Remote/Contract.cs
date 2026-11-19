using Plciot.Scada;

namespace GatewayApp;

/// <summary>Hợp đồng JSON giữa gateway (khách) và tool admin. File này dùng chung cho cả hai chương trình.</summary>
public sealed class ApiState
{
    public bool Running { get; set; }
    public string Status { get; set; } = "";
    public string Cloud { get; set; } = "";
    /// <summary>Tăng mỗi khi cấu hình đổi: tool admin thấy đổi thì tải lại.</summary>
    public int Rev { get; set; }
    public bool Customer { get; set; }
    public Dictionary<string, double> Values { get; set; } = new();
    public string Fingerprint { get; set; } = "";
}

/// <summary>Cấu hình đầy đủ của gateway: kết nối + danh sách thiết bị/field (Pack) + cách hiển thị. Mật khẩu không gửi về (để trống).</summary>
public sealed class ApiConfig
{
    public ScadaConfig Config { get; set; } = new();
    public Dictionary<string, FieldMeta> Fields { get; set; } = new();
    public Dictionary<string, DeviceMeta> Devices { get; set; } = new();
}

public sealed class ApiWrite { public string Child { get; set; } = ""; public string Field { get; set; } = ""; public double Value { get; set; } }
public sealed class ApiRun { public bool Run { get; set; } }
/// <summary>Chạy / tạm dừng một thiết bị.</summary>
public sealed class ApiDevice { public string Child { get; set; } = ""; public bool Enabled { get; set; } = true; }
public sealed class ApiResult { public bool Ok { get; set; } public string? Err { get; set; } public bool Running { get; set; } public string? Msg { get; set; } }
/// <summary>Việc cloud do gateway làm: ghép cặp bằng mã admin hoặc enroll bằng QR.</summary>
public sealed class ApiCloud { public string Action { get; set; } = ""; public string Api { get; set; } = ""; public string Value { get; set; } = ""; }
/// <summary>
/// Trả lời gói tìm thiết bị UDP (cổng <see cref="RemoteClient.DiscoverPort"/>). Kind: "pc" (GatewayApp) | "mcu" (Waveshare ESP32-S3).
/// Hw: mã phần cứng (MAC với MCU). Name: tên hiển thị (site/device nếu đã đăng ký).
/// </summary>
public sealed class ApiHello
{
    public string Kind { get; set; } = ""; public string Name { get; set; } = ""; public string Hw { get; set; } = ""; public int Port { get; set; } public string Version { get; set; } = "";
    /// <summary>IP / subnet / MAC của thiết bị (board MCU gửi; gateway PC để trống). Board trả lời cả broadcast nên khác mạng con vẫn thấy.</summary>
    public string Ip { get; set; } = ""; public string Mask { get; set; } = ""; public string Mac { get; set; } = "";
    /// <summary>true = API cài đặt qua HTTPS (board MCU, cổng 443): đăng nhập bằng khoá PC, không mã.</summary>
    public bool Tls { get; set; }
    /// <summary>true = board bị khoá (báo mất trộm, admin khoá theo mã phần cứng) — không cài đặt được tới khi server mở khoá.</summary>
    public bool Locked { get; set; }
}
/// <summary>Board MCU: một PC quản trị (GET /api/admins). Active=false: đang chờ — PC quản trị cũ đồng ý/từ chối, hoặc tự kích hoạt sau RemainMin phút.</summary>
public sealed class ApiAdmin { public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string How { get; set; } = ""; public bool Active { get; set; } public int RemainMin { get; set; } public bool Self { get; set; } }
/// <summary>Board MCU: thử thách đăng nhập (GET /api/challenge) — Nonce dùng một lần; Window = đang mở ghép PC mới (nhấn BOOT).</summary>
public sealed class ApiChallenge { public string Nonce { get; set; } = ""; public string Hw { get; set; } = ""; public bool Window { get; set; } }
/// <summary>Board MCU: POST /api/login — Sig = khoá PC ký "admin-login|&lt;mã phần cứng board&gt;|&lt;Nonce&gt;". WebToken (tuỳ chọn) = phiên webapp của chủ board để ghép PC khi không nhấn được BOOT.</summary>
public sealed class ApiKeyLogin { public string Pubkey { get; set; } = ""; public string Nonce { get; set; } = ""; public string Sig { get; set; } = ""; public string Name { get; set; } = ""; public string WebToken { get; set; } = ""; }
/// <summary>Cấu hình IP của board MCU (GET/PUT /api/network). Mặc định IP tĩnh 192.168.1.200/24 như thiết bị Ethernet sẵn firmware của Waveshare. Current = IP đang dùng.</summary>
public sealed class ApiNetwork
{
    public bool Dhcp { get; set; }
    public string Ip { get; set; } = ""; public string Mask { get; set; } = ""; public string Gateway { get; set; } = ""; public string Dns { get; set; } = "";
    public string Mac { get; set; } = ""; public string Current { get; set; } = "";
}
