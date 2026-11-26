using System.Text.Json.Serialization;

namespace GatewayApp;

// Hợp đồng JSON của logic KHI MẤT MẠNG trên board Waveshare (firmware gateway-mcu/src/offline.cpp):
//   GET  /api/offline       → ApiOffline (chính sách + Status)
//   PUT  /api/offline       ← ApiOffline (Rev = bản đã đọc; người khác vừa sửa → 409 rev_conflict) → ApiOfflineSaved
//   POST /api/offline/test  ← {Sec} thử mất mạng (0 = dừng)
// Dùng chung cho GatewayApp (LAN) và GatewayAdmin (từ xa, qua relay cloud — cùng route).

/// <summary>Chính sách một chân DO khi mất mạng. Mode: hold | off | on | schedule | follow | threshold | cycle.</summary>
public sealed class OfflineRule
{
    public int Ch { get; set; }
    public string Mode { get; set; } = "hold";
    /// <summary>Mất mạng liên tục quá ngần này giây mới chạy chính sách.</summary>
    public int DelaySec { get; set; } = 60;
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? From { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? To { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Di { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Invert { get; set; }
    /// <summary>threshold: "child.field" (tên field nội bộ, không phải khoá MQTT).</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Field { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? On { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public double? Off { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? MaxAgeSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? OnSec { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? OffSec { get; set; }
}

/// <summary>Cài đặt cũ (PackMap.LossOffSec — "tắt sau N giây" trong hộp thoại thiết bị) còn hiệu lực cho chân chưa có chính sách.</summary>
public sealed class OfflineLegacy { public int Ch { get; set; } public int DelaySec { get; set; } }

public sealed class OfflineChStatus
{
    public int Ch { get; set; }
    public string Mode { get; set; } = "";
    /// <summary>Đang chạy theo chính sách (đã quá thời gian chờ).</summary>
    public bool Active { get; set; }
    /// <summary>Người tại chỗ vừa đổi DO tay → logic nhường tới khi có mạng lại.</summary>
    public bool Manual { get; set; }
    public int Out { get; set; }
    public string Text { get; set; } = "";
    public string Note { get; set; } = "";
}

public sealed class OfflineStatus
{
    /// <summary>Đang mất người điều khiển (hoặc đang thử).</summary>
    public bool Down { get; set; }
    public long DownSec { get; set; }
    /// <summary>Board có cần người điều khiển không (cloud đã cài / PC từng giữ lease). false = chạy LAN thuần: không bao giờ "mất mạng".</summary>
    public bool Expected { get; set; }
    public long TestSec { get; set; }
    /// <summary>Có giờ tin được (NTP / RTC) — lịch giờ cần cái này.</summary>
    public bool TimeOk { get; set; }
    public List<OfflineChStatus> Ch { get; set; } = new();
}

public sealed class ApiOffline
{
    public uint Rev { get; set; }
    /// <summary>Múi giờ cho lịch: phút lệch UTC (Việt Nam = 420).</summary>
    public int TzMin { get; set; } = 420;
    public List<OfflineRule> Do { get; set; } = new();
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public List<OfflineLegacy>? Legacy { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public OfflineStatus? Status { get; set; }
}

public sealed class ApiOfflineSaved { public bool Ok { get; set; } public uint Rev { get; set; } }
