using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace GatewayApp;

/// <summary>
/// Phía ADMIN của API LAN (xem <see cref="RemoteApi"/>): nối tới một gateway khác bằng IP — gateway PC bật "Kết nối admin"
/// hoặc gateway MCU (Waveshare ESP32-S3-POE-ETH-8DI-8DO, firmware trong gateway/). Cùng hợp đồng JSON <c>Remote/Contract.cs</c>.
/// Nối 2 bước: POST /api/login {Code} (mã 8 số hiện trên gateway) → mã phiên; mọi yêu cầu sau gửi "Authorization: Bearer &lt;mã phiên&gt;".
/// </summary>
public sealed class RemoteClient : IDisposable
{
    static readonly JsonSerializerOptions J = new() { PropertyNameCaseInsensitive = true };
    readonly HttpClient _http;
    public string Address { get; }

    RemoteClient(string host, int port)
    {
        Address = $"{host}:{port}";
        _http = new HttpClient { BaseAddress = new Uri($"http://{host}:{port}/"), Timeout = TimeSpan.FromSeconds(15) };
    }

    /// <summary>Đăng nhập bằng mã kết nối; lỗi → ném <see cref="RemoteException"/> với mã lỗi của gateway (unauthorized, too_many_attempts…).</summary>
    public static async Task<RemoteClient> ConnectAsync(string host, int port, string code, CancellationToken ct = default)
    {
        var c = new RemoteClient(host.Trim(), port);
        try
        {
            var r = await c.SendAsync<ApiLoginResult>(HttpMethod.Post, "api/login", new ApiLogin { Code = code.Trim() }, ct);
            if (!r.Ok || r.Token.Length == 0) throw new RemoteException("unauthorized");
            c._http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", r.Token);
            return c;
        }
        catch { c.Dispose(); throw; }
    }

    public Task<ApiState> StateAsync(CancellationToken ct = default) => SendAsync<ApiState>(HttpMethod.Get, "api/state", null, ct);
    public Task<ApiConfig> ConfigAsync(CancellationToken ct = default) => SendAsync<ApiConfig>(HttpMethod.Get, "api/config", null, ct);
    public Task<ApiResult> PutConfigAsync(ApiConfig cfg, CancellationToken ct = default) => SendAsync<ApiResult>(HttpMethod.Put, "api/config", cfg, ct, longOp: true);
    public Task<ApiResult> WriteAsync(string child, string field, double v) => SendAsync<ApiResult>(HttpMethod.Post, "api/write", new ApiWrite { Child = child, Field = field, Value = v });
    public Task<ApiResult> RunAsync(bool run) => SendAsync<ApiResult>(HttpMethod.Post, "api/run", new ApiRun { Run = run }, longOp: true);
    public Task<ApiResult> DeviceAsync(string child, bool enabled) => SendAsync<ApiResult>(HttpMethod.Post, "api/device", new ApiDevice { Child = child, Enabled = enabled });
    public Task<ApiResult> CloudAsync(string action, string api, string value) => SendAsync<ApiResult>(HttpMethod.Post, "api/cloud", new ApiCloud { Action = action, Api = api, Value = value }, longOp: true);

    async Task<T> SendAsync<T>(HttpMethod m, string path, object? body, CancellationToken ct = default, bool longOp = false)
    {
        using var req = new HttpRequestMessage(m, path);
        if (body != null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(longOp ? TimeSpan.FromSeconds(60) : TimeSpan.FromSeconds(8));   // lưu cấu hình/đăng ký cloud: gateway khởi động lại luồng đọc, gọi server → chờ lâu hơn
        HttpResponseMessage res;
        try { res = await _http.SendAsync(req, cts.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new RemoteException("timeout"); }
        catch (HttpRequestException e) { throw new RemoteException("offline", e.Message); }
        using (res)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                string? err = null;
                try { err = JsonSerializer.Deserialize<ApiResult>(text, J)?.Err; } catch (JsonException) { }
                throw new RemoteException(err ?? ((int)res.StatusCode).ToString());
            }
            try { return JsonSerializer.Deserialize<T>(text, J) ?? throw new RemoteException("bad_json"); }
            catch (JsonException) { throw new RemoteException("bad_json"); }
        }
    }

    public void Dispose() => _http.Dispose();

    /// <summary>Câu báo lỗi dễ hiểu cho mã lỗi của API.</summary>
    public static string Explain(Exception e) => e is RemoteException r ? r.Code switch
    {
        "unauthorized" => "Mã kết nối sai hoặc đã đổi — xem mã mới trên thiết bị.",
        "too_many_attempts" => "Nhập sai quá nhiều lần — thiết bị tạm khoá 60 giây.",
        "press_boot" => "Board Waveshare đang đóng cài đặt — nhấn nút BOOT trên board (mở 10 phút) rồi kết nối lại.",
        "offline" => "Không nối được thiết bị (sai IP/cổng, thiết bị tắt hoặc khác mạng LAN).",
        "timeout" => "Thiết bị không trả lời kịp.",
        "bad_json" => "Thiết bị trả dữ liệu không đúng định dạng (phiên bản không khớp?).",
        _ => "Thiết bị báo lỗi: " + r.Code,
    } : e.Message;

    // ------------------------------------------------------------------ tìm thiết bị trong LAN
    /// <summary>Cổng UDP tìm gateway trong LAN: admin broadcast <see cref="DiscoverMagic"/>, gateway đang bật API trả <see cref="ApiHello"/> (JSON).</summary>
    public const int DiscoverPort = 8751;
    public const string DiscoverMagic = "PLCIOT-DISCOVER";

    /// <summary>Broadcast lên mọi card mạng IPv4 rồi gom câu trả lời trong <paramref name="wait"/>.</summary>
    public static async Task<List<(IPAddress Ip, ApiHello Hello)>> DiscoverAsync(TimeSpan wait)
    {
        var found = new Dictionary<string, (IPAddress, ApiHello)>();
        using var udp = new UdpClient(AddressFamily.InterNetwork) { EnableBroadcast = true };
        udp.Client.Bind(new IPEndPoint(IPAddress.Any, 0));
        var msg = Encoding.ASCII.GetBytes(DiscoverMagic);
        var targets = new HashSet<IPAddress> { IPAddress.Broadcast };
        foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(ua.Address) || ua.IPv4Mask == null) continue;
                var ip = ua.Address.GetAddressBytes(); var mask = ua.IPv4Mask.GetAddressBytes();
                for (var i = 0; i < 4; i++) ip[i] = (byte)(ip[i] | ~mask[i]);
                targets.Add(new IPAddress(ip));
            }
        }
        foreach (var t in targets) { try { await udp.SendAsync(msg, msg.Length, new IPEndPoint(t, DiscoverPort)); } catch (SocketException) { } }
        try { await udp.SendAsync(msg, msg.Length, new IPEndPoint(IPAddress.Loopback, DiscoverPort)); } catch (SocketException) { }   // gateway PC trên chính máy này
        using var cts = new CancellationTokenSource(wait);
        while (!cts.IsCancellationRequested)
        {
            UdpReceiveResult r;
            try { r = await udp.ReceiveAsync(cts.Token); } catch (OperationCanceledException) { break; } catch (SocketException) { continue; }
            try
            {
                var h = JsonSerializer.Deserialize<ApiHello>(r.Buffer, J);
                if (h?.Port > 0) found[r.RemoteEndPoint.Address + ":" + h.Port] = (r.RemoteEndPoint.Address, h);
            }
            catch (JsonException) { }
        }
        return found.Values.OrderBy(x => x.Item1.ToString()).ToList();
    }
}

public sealed class RemoteException : Exception
{
    public string Code { get; }
    public RemoteException(string code, string? detail = null) : base(detail ?? code) { Code = code; }
}
