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
