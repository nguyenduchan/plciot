namespace GatewayApp;

/// <summary>
/// Giữ giờ cho board Waveshare đang là SLAVE của gateway PC này (giữ lease → board tạm dừng MQTTS, không nhận giờ từ server).
/// Mỗi 10 phút / board (gọi trong nhịp lease): board chưa có giờ tin được, hoặc giờ không phải từ server mà lệch PC quá
/// <see cref="MaxDriftMs"/> → đặt theo đồng hồ PC (Windows tự đồng bộ giờ Internet). Giờ server (Source "ntp") không bị ghi đè.
/// Firmware cũ (chưa có /api/time) → bỏ qua lặng lẽ. Lỗi không ném ra ngoài (lease vẫn chạy).
/// </summary>
public sealed class BoardTimeSync
{
    public const int CheckEveryMs = 600_000;
    public const long MaxDriftMs = 2_000;
    readonly Dictionary<string, DateTime> _next = new();
    public Action<string>? Log { get; set; }

    public async Task TickAsync(string host, RemoteClient board)
    {
        if (_next.TryGetValue(host, out var at) && DateTime.UtcNow < at) return;
        _next[host] = DateTime.UtcNow.AddMilliseconds(CheckEveryMs);
        try
        {
            var t = await board.TimeAsync();
            var why = Reason(t, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (why == null) return;
            var r = await board.PutTimeAsync();
            Log?.Invoke($"{host}: đặt giờ board theo PC ({why}) → nguồn {r.Source}");
        }
        catch (RemoteException e) when (e.Code is "not_found") { _next[host] = DateTime.UtcNow.AddHours(6); }   // firmware cũ
        catch (RemoteException e) { Log?.Invoke($"{host}: không đặt được giờ board ({e.Code})"); }
        catch (HttpRequestException) { /* mất kết nối LAN: lease tự xử lý */ }
        catch (TaskCanceledException) { }
    }

    /// <summary>Lý do cần đặt giờ (null = không cần). Dùng chung với nút "Giờ…" khi mở cửa sổ board.</summary>
    public static string? Reason(ApiTime t, long pcMs)
    {
        if (!t.Trusted || t.NowMs <= 0) return "board chưa có giờ";
        if (t.Source == "ntp") return null;   // giờ server: không ghi đè
        var d = t.NowMs - pcMs;
        return Math.Abs(d) > MaxDriftMs ? $"lệch {d / 1000.0:+0.0;-0.0} s" : null;
    }
}
