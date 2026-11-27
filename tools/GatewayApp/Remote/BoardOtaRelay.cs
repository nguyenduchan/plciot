using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace GatewayApp;

/// <summary>
/// Cập nhật firmware board Waveshare đang là SLAVE của gateway PC này (giữ lease → board tạm dừng MQTTS, không tự lên cloud).
/// Board tự có internet (độc lập) thì board tự tải từ server — lớp này chỉ lo board đang giữ lease.
/// Mỗi phút một lần / board:
///   1. GET /api/ota trên board (phiên bản, kênh, mqttId) — bản đang chờ xác nhận thì thôi.
///   2. GET /api/ota/nonce trên board → POST {server}/api/v1/mcu-firmware/allow {id, nonce, version}: server ghi phiên bản board (webapp hiện
///      "Bản mới" + nút Cho phép), và nếu CHỦ TRẠM đã bấm cho phép (15 phút) thì trả gói ota_allow SERVER KÝ kèm nonce + thông tin bản mới.
///   3. Bản mới khác bản đang chạy → POST /api/ota/allow (board kiểm chữ ký server + nonce, mở cửa sổ) → tải firmware từ server, đối chiếu
///      SHA-256 → POST /api/ota (board kiểm chữ ký nhà phát triển, cài, khởi động lại, tự quay về nếu bản mới không ổn).
/// Gateway PC không tạo được lệnh cho phép (không có khoá server) và không sửa được firmware (chữ ký nhà phát triển).
/// </summary>
public sealed class BoardOtaRelay
{
    public const int CheckEveryMs = 60_000;
    readonly Func<string> _server;
    readonly Dictionary<string, DateTime> _next = new();
    readonly Dictionary<string, DateTime> _failed = new();   // host → phiên bản vừa cài hỏng (không thử lại liên tục trong cùng cửa sổ)
    public Action<string>? Log { get; set; }
    /// <summary>Kiểm thử: hỏi ngay, không chờ một phút.</summary>
    public bool NoThrottle { get; set; }

    public BoardOtaRelay(Func<string> server) { _server = server; }

    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    /// <summary>Gọi trong nhịp lease khi board <paramref name="host"/> đang ở chế độ gateway. Lỗi không ném ra ngoài (lease vẫn chạy).</summary>
    public async Task TickAsync(string host, RemoteClient board)
    {
        if (!NoThrottle && _next.TryGetValue(host, out var at) && DateTime.UtcNow < at) return;
        _next[host] = DateTime.UtcNow.AddMilliseconds(CheckEveryMs);
        try { await CheckAsync(host, board); }
        catch (RemoteException e) { Log?.Invoke($"{host}: lỗi board {e.Code}"); }
        catch (HttpRequestException e) { Log?.Invoke($"{host}: không hỏi được server ({e.Message})"); }
        catch (TaskCanceledException) { Log?.Invoke($"{host}: hết thời gian chờ server"); }
        catch (JsonException e) { Log?.Invoke($"{host}: trả lời server sai dạng ({e.Message})"); }
    }

    async Task CheckAsync(string host, RemoteClient board)
    {
        var st = await board.OtaStateAsync();
        var ver = Str(st, "Version");
        if (!ver.StartsWith("mcu-") || Bool(st, "PendingVerify")) return;   // không phải board / bản mới đang tự kiểm tra sức khoẻ
        var cloudId = Str(st, "CloudId");
        if (!Bool(st, "Enrolled") || cloudId.Length == 0) return;          // board chưa gắn cloud: cập nhật tay qua nút Firmware…
        var server = _server().TrimEnd('/');
        var nonce = Str(await board.OtaNonceAsync(), "Nonce");
        using var res = await Http.PostAsJsonAsync(server + "/api/v1/mcu-firmware/allow", new { id = cloudId, nonce, version = ver });
        var body = await res.Content.ReadFromJsonAsync<JsonElement>();
        var rel = body.TryGetProperty("release", out var r) && r.ValueKind == JsonValueKind.Object ? r : default;
        var newVer = rel.ValueKind == JsonValueKind.Object ? Str(rel, "version") : "";
        if (!res.IsSuccessStatusCode)
        {
            var err = Str(body, "error");
            if (err == "not_approved" && newVer.Length > 0 && newVer != ver && !_failed.ContainsKey(host + "|" + newVer))
                Log?.Invoke($"{host}: có bản mới {newVer} (đang chạy {ver}) — chờ chủ trạm bấm \"Cho phép cập nhật\" trên webapp");
            else if (err != "not_approved") Log?.Invoke($"{host}: server trả {(int)res.StatusCode} {err}");
            return;
        }
        if (newVer.Length == 0 || newVer == ver) return;
        if (_failed.TryGetValue(host + "|" + newVer, out var when) && DateTime.UtcNow < when.AddMinutes(20)) return;
        var sha = Str(rel, "sha256"); var sig = Str(rel, "sig");
        Log?.Invoke($"{host}: chủ trạm đã cho phép — chuyển lệnh cho phép xuống board, tải {newVer}");
        await board.OtaAllowAsync(Str(body, "packet"));
        var ch = ver.EndsWith("-dev") ? "?ch=dev" : "";
        var fw = await Http.GetByteArrayAsync(server + "/api/v1/mcu-firmware/download" + ch);
        var got = Convert.ToHexString(SHA256.HashData(fw)).ToLowerInvariant();
        if (got != sha) { Log?.Invoke($"{host}: firmware tải về sai SHA-256 — bỏ"); _failed[host + "|" + newVer] = DateTime.UtcNow; return; }
        Log?.Invoke($"{host}: gửi {newVer} ({fw.Length / 1024} KB) qua LAN…");
        try
        {
            var o = await board.OtaAsync(fw, newVer, sig);
            Log?.Invoke($"{host}: board đã nạp {newVer} (từ {ver}) — {o.Msg}");
        }
        catch (RemoteException e)
        {
            _failed[host + "|" + newVer] = DateTime.UtcNow;
            Log?.Invoke($"{host}: board từ chối {newVer}: {e.Code}");
            throw;
        }
    }

    static string Str(JsonElement e, string k) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    static bool Bool(JsonElement e, string k) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.True;
}
