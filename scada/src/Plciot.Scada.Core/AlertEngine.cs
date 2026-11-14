using System.Text.Json;

namespace Plciot.Scada;

/// <summary>
/// Cảnh báo ngưỡng low/high TÍNH TẠI GATEWAY (server không tính): so từng giá trị telemetry với ngưỡng người dùng đặt khi
/// thêm thiết bị, và khi CHUYỂN trạng thái (bình thường → thấp/cao) phát sự kiện lên &lt;base&gt;/alert:
///   {"schema":1,"k":"tank1.level","lv":"high","v":95.2,"txt":"Bồn nước: Mức nước vượt ngưỡng cao (95.2 %)","ts":1700000000000}
/// Mỗi mức của cùng một field báo lại sau tối thiểu <see cref="CooldownMs"/> để không spam.
/// </summary>
public sealed class AlertEngine
{
    public const int CooldownMs = 300_000;

    readonly Func<IEnumerable<(string Wire, string Title, string Label, string Unit, double? Low, double? High)>> _limits;
    readonly Func<long> _now;
    readonly Dictionary<string, string> _state = new();       // "child.key" → ok | low | high
    readonly Dictionary<string, long> _lastSent = new();      // "child.key/level" → ms
    Dictionary<string, (string Title, string Label, string Unit, double? Low, double? High)> _map = new();
    long _mapAt; bool _mapBuilt;

    public AlertEngine(Func<IEnumerable<(string Wire, string Title, string Label, string Unit, double? Low, double? High)>> limits, Func<long>? now = null)
    {
        _limits = limits; _now = now ?? (() => Environment.TickCount64);
    }

    void Refresh(long now)
    {
        if (_mapBuilt && now - _mapAt < 30_000) return;      // cấu hình đổi hiếm: dựng lại bảng ngưỡng mỗi 30 giây
        _mapAt = now; _mapBuilt = true;
        var m = new Dictionary<string, (string, string, string, double?, double?)>();
        foreach (var l in _limits())
            if (l.Low != null || l.High != null) m[l.Wire] = (l.Title, l.Label, l.Unit, l.Low, l.High);
        _map = m;
    }

    /// <summary>Payload telemetry {"d":{child:{field:số}}} → các sự kiện cảnh báo (JSON) cần phát.</summary>
    public List<byte[]> Evaluate(byte[] telemetry)
    {
        var fired = new List<byte[]>();
        var now = _now();
        Refresh(now);
        if (_map.Count == 0) return fired;
        try
        {
            using var doc = JsonDocument.Parse(telemetry);
            if (!doc.RootElement.TryGetProperty("d", out var d) || d.ValueKind != JsonValueKind.Object) return fired;
            foreach (var c in d.EnumerateObject())
            {
                if (c.Value.ValueKind != JsonValueKind.Object) continue;
                foreach (var f in c.Value.EnumerateObject())
                {
                    var path = c.Name + "." + f.Name;
                    if (!_map.TryGetValue(path, out var lim) || !f.Value.TryGetDouble(out var v)) continue;
                    var next = lim.High is { } hi && v > hi ? "high" : lim.Low is { } lo && v < lo ? "low" : "ok";
                    var was = _state.GetValueOrDefault(path, "ok");
                    _state[path] = next;
                    if (next == "ok" || next == was) continue;
                    var key = path + "/" + next;
                    if (_lastSent.TryGetValue(key, out var t) && now - t < CooldownMs) continue;
                    _lastSent[key] = now;
                    var unit = string.IsNullOrEmpty(lim.Unit) ? "" : " " + lim.Unit;
                    var txt = $"{lim.Title}: {lim.Label} {(next == "high" ? "vượt ngưỡng cao" : "xuống dưới ngưỡng thấp")} ({Math.Round(v, 1)}{unit})";
                    fired.Add(JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, k = path, lv = next, v = Math.Round(v, 3), txt, ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }));
                }
            }
        }
        catch (JsonException) { /* gói hỏng: bỏ qua */ }
        return fired;
    }
}
