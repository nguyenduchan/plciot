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
    /// <summary>Kênh HTTPS (board MCU): chứng chỉ tự ký, kiểm bằng GHIM khoá — dấu nhận dạng = mã phần cứng của board.</summary>
    public bool Tls { get; }
    /// <summary>Mã phần cứng tính từ khoá công khai trong chứng chỉ TLS của board (đúng công thức GatewayIdentity.Hw / idHw của firmware).</summary>
    public string ObservedHw { get; private set; } = "";
    string? _pinHw;

    RemoteClient(string host, int port, bool tls = false)
    {
        Address = $"{host}:{port}"; Tls = tls;
        var handler = new HttpClientHandler();
        if (tls)
            handler.ServerCertificateCustomValidationCallback = (_, cert, _, _) =>
            {
                if (cert == null) return false;
                ObservedHw = HwOf(cert.PublicKey.ExportSubjectPublicKeyInfo());
                return _pinHw == null || ObservedHw == _pinHw;   // đã ghim: board khác (giả mạo) bị từ chối
            };
        _http = new HttpClient(handler) { BaseAddress = new Uri($"{(tls ? "https" : "http")}://{host}:{port}/"), Timeout = TimeSpan.FromSeconds(15) };
    }

    /// <summary>Mã phần cứng: 20 ký tự Crockford đầu của SHA-256(SPKI) — trùng GatewayIdentity.Hw và idHw() của firmware.</summary>
    public static string HwOf(byte[] spki)
    {
        const string B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        var h = System.Security.Cryptography.SHA256.HashData(spki);
        var sb = new StringBuilder(); int bits = 0, acc = 0;
        foreach (var b in h)
        {
            acc = (acc << 8) | b; bits += 8;
            while (bits >= 5 && sb.Length < 20) { sb.Append(B32[(acc >> (bits - 5)) & 31]); bits -= 5; }
            if (sb.Length >= 20) break;
        }
        return sb.ToString();
    }

    /// <summary>
    /// Board MCU qua HTTPS, không mã: lấy thử thách → kiểm/ghim mã phần cứng (board lạ: hỏi người dùng đối chiếu với tem) →
    /// ký "admin-login|&lt;mã phần cứng&gt;|&lt;nonce&gt;" bằng khoá PC → phiên. PC chưa ghép: board nhận nếu đang mở ghép (nhấn BOOT),
    /// hoặc <paramref name="webToken"/> là phiên webapp của chủ board; không thì lỗi not_paired.
    /// </summary>
    public static async Task<(RemoteClient Client, bool Paired)> ConnectMcuAsync(string host, int port, Plciot.Scada.Services.Ui.GatewayIdentity id,
        Func<string, bool> confirmNewBoard, string webToken = "", CancellationToken ct = default)
    {
        var c = new RemoteClient(host.Trim(), port, tls: true);
        try
        {
            var ch = await c.SendAsync<ApiChallenge>(HttpMethod.Get, "api/challenge", null, ct);
            var hw = c.ObservedHw;
            if (hw.Length == 0) throw new RemoteException("tls_failed");
            if (!TrustedBoards.Contains(hw) && !confirmNewBoard(hw)) throw new RemoteException("untrusted_board");
            c._pinHw = hw;
            var r = await c.SendAsync<ApiLoginResult>(HttpMethod.Post, "api/login", new ApiKeyLogin
            {
                Pubkey = id.PublicKey, Nonce = ch.Nonce, Sig = id.Sign($"admin-login|{hw}|{ch.Nonce}"), Name = Environment.MachineName, WebToken = webToken,
            }, ct);
            if (!r.Ok || r.Token.Length == 0) throw new RemoteException("unauthorized");
            c._http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", r.Token);
            TrustedBoards.Add(hw, host.Trim());
            return (c, r.Paired);
        }
        catch { c.Dispose(); throw; }
    }

    /// <summary>Board có đang mở ghép PC mới không (đọc thử thách, không đăng nhập) — để hướng dẫn "nhấn BOOT".</summary>
    public static async Task<ApiChallenge?> PeekAsync(string host, int port)
    {
        using var c = new RemoteClient(host.Trim(), port, tls: true);
        try { return await c.SendAsync<ApiChallenge>(HttpMethod.Get, "api/challenge", null); } catch (RemoteException) { return null; }
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
    /// <summary>Cấu hình IP (chỉ board MCU có; gateway PC trả not_found).</summary>
    public Task<ApiNetwork> NetworkAsync() => SendAsync<ApiNetwork>(HttpMethod.Get, "api/network", null);
    /// <summary>Đổi IP: board lưu rồi tự khởi động lại sau ~1,5 giây — phiên hiện tại mất, nối lại bằng IP mới.</summary>
    public Task<ApiResult> PutNetworkAsync(ApiNetwork n) => SendAsync<ApiResult>(HttpMethod.Put, "api/network", n);
    /// <summary>Board MCU: các PC quản trị (đang dùng / đang chờ).</summary>
    public Task<List<ApiAdmin>> AdminsAsync() => SendAsync<List<ApiAdmin>>(HttpMethod.Get, "api/admins", null);
    /// <summary>action = approve (kích hoạt PC đang chờ ngay) | reject (từ chối PC đang chờ) | remove (gỡ PC).</summary>
    public Task<ApiResult> AdminActionAsync(string id, string action) => SendAsync<ApiResult>(HttpMethod.Post, "api/admins", new { Id = id, Action = action });
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
        "too_many_attempts" => "Thử sai quá nhiều lần — thiết bị tạm khoá 60 giây.",
        "press_boot" => "Board Waveshare đang đóng cài đặt — nhấn nút BOOT trên board (mở 10 phút) rồi kết nối lại.",
        "device_locked" => "Board này đã bị KHOÁ vì được báo mất trộm. Không cài đặt được — liên hệ nhà cung cấp để mở khoá.",
        "pair_pending" => "Đã gửi yêu cầu ghép PC này. Board đã có PC quản trị: chờ PC đó bấm Đồng ý (\"PC quản trị…\"), hoặc tự kích hoạt sau 24 giờ nếu không ai từ chối. Chủ board đăng nhập webapp thì kích hoạt ngay.",
        "not_paired" => "PC này chưa được ghép với board. Nhấn nút BOOT trên board (mở ghép 10 phút) rồi kết nối lại — hoặc đăng nhập webapp của chủ board.",
        "not_owner" => "Tài khoản webapp vừa đăng nhập không phải chủ board này — nhấn nút BOOT trên board để ghép.",
        "board_not_registered" => "Board chưa đăng ký server nào nên không xác nhận được bằng webapp — nhấn nút BOOT trên board để ghép.",
        "server_unreachable" => "Board không hỏi được server (offline?) — nhấn nút BOOT trên board để ghép.",
        "untrusted_board" => "Đã huỷ: không tin cậy board này.",
        "tls_failed" => "Không lập được kênh bảo mật với board.",
        "bad_signature" or "bad_nonce" => "Board từ chối chữ ký đăng nhập (thử lại).",
        "use_https" => "Board chỉ nhận cài đặt qua HTTPS (cổng 443).",
        "offline" => "Không nối được thiết bị (sai IP/cổng, thiết bị tắt hoặc khác mạng LAN).",
        "timeout" => "Thiết bị không trả lời kịp.",
        "bad_json" => "Thiết bị trả dữ liệu không đúng định dạng (phiên bản không khớp?).",
        _ => "Thiết bị báo lỗi: " + r.Code,
    } : e.Message;

    // ------------------------------------------------------------------ tìm thiết bị trong LAN
    /// <summary>Cổng UDP tìm gateway trong LAN: admin broadcast <see cref="DiscoverMagic"/>, gateway đang bật API trả <see cref="ApiHello"/> (JSON).</summary>
    public const int DiscoverPort = 8751;
    public const string DiscoverMagic = "PLCIOT-DISCOVER";

    /// <summary>IP của thiết bị có cùng mạng con với một card mạng của PC này không (khác thì HTTP không tới được, phải đổi IP PC hoặc board).</summary>
    public static bool SameSubnetAsThisPc(string ip)
    {
        if (!IPAddress.TryParse(ip, out var target) || target.AddressFamily != AddressFamily.InterNetwork) return true;
        if (IPAddress.IsLoopback(target)) return true;
        var t = target.GetAddressBytes();
        foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != System.Net.NetworkInformation.OperationalStatus.Up) continue;
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork || ua.IPv4Mask == null) continue;
                var a = ua.Address.GetAddressBytes(); var m = ua.IPv4Mask.GetAddressBytes();
                if (Enumerable.Range(0, 4).All(i => (a[i] & m[i]) == (t[i] & m[i]))) return true;
            }
        }
        return false;
    }

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
                // board trả lời cả unicast lẫn broadcast: gộp theo MAC/mã phần cứng; địa chỉ = IP board tự báo (khác mạng con vẫn đúng)
                if (h?.Port > 0)
                {
                    var ip = IPAddress.TryParse(h.Ip, out var own) && !own.Equals(IPAddress.Any) ? own : r.RemoteEndPoint.Address;
                    var key = (h.Mac.Length > 0 ? h.Mac : h.Hw.Length > 0 ? h.Hw : ip.ToString()) + ":" + h.Port;
                    if (!found.ContainsKey(key) || IPAddress.IsLoopback(found[key].Item1)) found[key] = (ip, h);
                }
            }
            catch (JsonException) { }
        }
        return found.Values.OrderBy(x => x.Item1.ToString()).ToList();
    }
}

/// <summary>
/// Board MCU PC này đã tin (ghim): mã phần cứng → IP gần nhất. Lưu cạnh cấu hình GatewayApp (remote-boards.json).
/// Board lạ: GatewayApp hỏi người dùng đối chiếu mã phần cứng với tem một lần; sau đó board khác giả IP bị từ chối ở bắt tay TLS.
/// </summary>
public static class TrustedBoards
{
    public static string FilePath { get; set; } = Path.Combine(Path.GetTempPath(), "remote-boards.json");
    static Dictionary<string, string> Load()
    {
        try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(FilePath)) ?? new() : new(); }
        catch (Exception) { return new(); }
    }
    public static bool Contains(string hw) => Load().ContainsKey(hw);
    public static void Add(string hw, string ip)
    {
        var d = Load(); d[hw] = ip;
        try { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(FilePath))!); File.WriteAllText(FilePath, JsonSerializer.Serialize(d)); } catch (IOException) { }
    }
}

public sealed class RemoteException : Exception
{
    public string Code { get; }
    public RemoteException(string code, string? detail = null) : base(detail ?? code) { Code = code; }
}
