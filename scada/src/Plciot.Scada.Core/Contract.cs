using System.Text.Json;

namespace Plciot.Scada;

/// <summary>Hợp đồng MQTT/thanh ghi dùng chung với gateway, webapp và cloud (xem docs/PROTOCOL.md).</summary>
public static class Contract
{
    public static readonly string[] Kinds = { "telemetry", "status", "ack", "history", "cmd" };

    /// <summary>Nhóm topic đi từ thiết bị lên cloud (cmd thì chỉ đi chiều ngược lại).</summary>
    public static bool IsUpstream(string kind) => kind is "telemetry" or "status" or "ack" or "history";

    public static string Base(string site, string device) => $"plc/{site}/{device}";

    /// <summary>"plc/s/d/kind" → kind; null nếu không thuộc base.</summary>
    public static string? KindOf(string topic, string baseTopic)
    {
        if (!topic.StartsWith(baseTopic + "/", StringComparison.Ordinal)) return null;
        var k = topic[(baseTopic.Length + 1)..];
        return Array.IndexOf(Kinds, k) >= 0 ? k : null;
    }

    public const int Mode = 3, ManMask = 4, RunReq = 6, Target = 7, ConvState = 8, Reset = 9;
    public const int TelemetryRegs = 40, MaxRegister = 300;
}

public sealed record PlcCommand(string? Id, bool IsRead, int Address, int Count, int Value);

/// <summary>
/// Kiểm tra lệnh điều khiển, giống whitelist của gateway (config.h WRITABLE) – áp dụng ở mọi cửa vào:
/// lệnh từ cloud, từ máy trạm trong LAN và từ giao diện cục bộ.
/// </summary>
public static class CommandPolicy
{
    /// <summary>Mặc định; mỗi khách hàng đặt riêng qua <c>ScadaConfig.WritableRegisters</c>.</summary>
    public static readonly IReadOnlySet<int> Writable = new HashSet<int> { 3, 4, 6, 7, 9 };
    public const int MaxPayload = 512;

    public static (PlcCommand? Cmd, string? Error, string? Id) Parse(ReadOnlySpan<byte> payload, IReadOnlySet<int>? writable = null)
    {
        writable ??= Writable;
        if (payload.Length == 0 || payload.Length > MaxPayload) return (null, "bad_size", null);
        string? id = null;
        try
        {
            using var doc = JsonDocument.Parse(payload.ToArray());
            var r = doc.RootElement;
            if (r.ValueKind != JsonValueKind.Object) return (null, "bad_cmd", null);
            if (r.TryGetProperty("id", out var idEl))
                id = idEl.ValueKind == JsonValueKind.String ? idEl.GetString() : idEl.ToString();
            if (id is { Length: > 64 }) return (null, "bad_id", null);

            if (!r.TryGetProperty("a", out var aEl) || !aEl.TryGetInt32(out var a) || a < 0 || a >= Contract.MaxRegister)
                return (null, "bad_address", id);

            if (r.TryGetProperty("op", out var op) && op.ValueKind == JsonValueKind.String && op.GetString() == "read")
            {
                if (!r.TryGetProperty("n", out var nEl) || !nEl.TryGetInt32(out var n) || n < 1 || n > 60 || a + n > Contract.MaxRegister)
                    return (null, "bad_range", id);
                return (new PlcCommand(id, true, a, n, 0), null, id);
            }

            if (!r.TryGetProperty("v", out var vEl) || !vEl.TryGetInt32(out var v) || v < 0 || v > 65535)
                return (null, "bad_value", id);
            if (!writable.Contains(a)) return (null, "not_writable", id);
            return (new PlcCommand(id, false, a, 1, v), null, id);
        }
        catch (JsonException)
        {
            return (null, "bad_json", null);
        }
    }

    public static string AckJson(string? id, bool ok, string? err = null, int? a = null, IEnumerable<ushort>? values = null)
    {
        var o = new Dictionary<string, object?> { ["id"] = id, ["ok"] = ok };
        if (a != null) o["a"] = a;
        if (values != null) o["v"] = values.ToArray();
        if (err != null) o["err"] = err;
        return JsonSerializer.Serialize(o);
    }
}
