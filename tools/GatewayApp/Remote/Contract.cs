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
public sealed class ApiResult { public bool Ok { get; set; } public string? Err { get; set; } public bool Running { get; set; } }
