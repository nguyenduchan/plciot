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
        _http = new HttpClient(handler) { BaseAddress = new Uri($"{(tls ? "https" : "http")}://{host}:{port}/"), Timeout = Timeout.InfiniteTimeSpan };   // hạn chờ đặt riêng từng yêu cầu (SendAsync / OtaAsync)
    }

    /// <summary>
    /// Đường truyền khác LAN (GatewayAdmin: relay qua server → MQTT tới gateway): <paramref name="handler"/> nhận đúng yêu cầu HTTP
    /// của API LAN (method, /api/…, thân) và trả lời như gateway. Mọi hộp thoại dùng RemoteClient chạy nguyên vẹn.
    /// </summary>
    public RemoteClient(HttpMessageHandler handler, string address)
    {
        Address = address;
        _http = new HttpClient(handler) { BaseAddress = new Uri("http://relay/"), Timeout = Timeout.InfiniteTimeSpan };
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
    public Task<System.Text.Json.JsonElement> ConfigMessageAsync() => SendAsync<System.Text.Json.JsonElement>(HttpMethod.Get, "api/config-message", null);
    public Task<ApiConfig> ConfigAsync(CancellationToken ct = default) => SendAsync<ApiConfig>(HttpMethod.Get, "api/config", null, ct);
    public Task<ApiResult> PutConfigAsync(ApiConfig cfg, CancellationToken ct = default) => SendAsync<ApiResult>(HttpMethod.Put, "api/config", cfg, ct, longOp: true);
    public Task<ApiResult> WriteAsync(string child, string field, double v) => SendAsync<ApiResult>(HttpMethod.Post, "api/write", new ApiWrite { Child = child, Field = field, Value = v });
    public Task<ApiResult> RunAsync(bool run) => SendAsync<ApiResult>(HttpMethod.Post, "api/run", new ApiRun { Run = run }, longOp: true);
    public Task<ApiResult> DeviceAsync(string child, bool enabled) => SendAsync<ApiResult>(HttpMethod.Post, "api/device", new ApiDevice { Child = child, Enabled = enabled });
    /// <summary>Board MCU: xin / gia hạn lease chế độ gateway (board dừng MQTTS, mở Modbus TCP slave cho IP của PC này) hoặc trả lease. Lỗi lease_held = PC khác đang giữ.</summary>
    /// <param name="doMinMs">8 số: ms tối thiểu giữa hai lần đổi trạng thái DO1..DO8 của board theo cấu hình gateway PC (firmware chặn ghi Modbus quá nhanh); null = không gửi.</param>
    public Task<ApiLease> LeaseAsync(bool acquire, int ttlSec = 15, int[]? doMinMs = null) =>
        SendAsync<ApiLease>(HttpMethod.Post, "api/lease", doMinMs == null ? new { Action = acquire ? "acquire" : "release", TtlSec = ttlSec }
            : new { Action = acquire ? "acquire" : "release", TtlSec = ttlSec, DoMinMs = doMinMs });
    /// <summary>Cấu hình IP (chỉ board MCU có; gateway PC trả not_found).</summary>
    /// <summary>Board MCU: trạng thái cập nhật (Version, Approved, ApprovedBy, RemainSec, PendingVerify, Enrolled) và nhật ký sự kiện.</summary>
    public Task<System.Text.Json.JsonElement> OtaStateAsync() => SendAsync<System.Text.Json.JsonElement>(HttpMethod.Get, "api/ota", null);
    /// <summary>Board MCU là slave của gateway PC này: mã dùng một lần để gói "cho phép cập nhật" do server ký gắn với đúng lần hỏi này.</summary>
    public Task<System.Text.Json.JsonElement> OtaNonceAsync() => SendAsync<System.Text.Json.JsonElement>(HttpMethod.Get, "api/ota/nonce", null);
    /// <summary>Chuyển gói ota_allow server đã ký (kèm nonce) xuống board → board mở cửa sổ cập nhật như khi nhận qua MQTT.</summary>
    public Task<System.Text.Json.JsonElement> OtaAllowAsync(string packet) => SendAsync<System.Text.Json.JsonElement>(HttpMethod.Post, "api/ota/allow", new { Packet = packet });
    public Task<System.Text.Json.JsonElement> EventsAsync() => SendAsync<System.Text.Json.JsonElement>(HttpMethod.Get, "api/events", null);
    /// <summary>Logic khi mất mạng của board (xem OfflineContract.cs).</summary>
    public Task<ApiOffline> OfflineAsync(CancellationToken ct = default) => SendAsync<ApiOffline>(HttpMethod.Get, "api/offline", null, ct);
    public Task<ApiOfflineSaved> PutOfflineAsync(ApiOffline p) => SendAsync<ApiOfflineSaved>(HttpMethod.Put, "api/offline", new ApiOffline { Rev = p.Rev, TzMin = p.TzMin, Do = p.Do });
    /// <summary>Thử mất mạng sec giây (0 = dừng): logic chạy ngay, bỏ qua thời gian chờ.</summary>
    public Task<ApiResult> OfflineTestAsync(int sec) => SendAsync<ApiResult>(HttpMethod.Post, "api/offline/test", new { Sec = sec });
    public Task<ApiNetwork> NetworkAsync() => SendAsync<ApiNetwork>(HttpMethod.Get, "api/network", null);
    /// <summary>Board MCU: quét Wi-Fi (~3–5 giây). Trả mạng đã bỏ trùng SSID, mỗi mạng một dòng.</summary>
    public Task<List<ApiWifiNet>> WifiScanAsync() => SendAsync<List<ApiWifiNet>>(HttpMethod.Get, "api/wifi/scan", null, longOp: true);
    public Task<ApiWifi> WifiAsync() => SendAsync<ApiWifi>(HttpMethod.Get, "api/wifi", null);
    /// <summary>Nối Wi-Fi (board thử tối đa ~15 giây rồi mới lưu; sai mật khẩu → lỗi wifi_auth_failed, mạng cũ giữ nguyên). Ssid rỗng = quên mạng đã lưu.</summary>
    public Task<ApiWifi> PutWifiAsync(string ssid, string password) => SendAsync<ApiWifi>(HttpMethod.Put, "api/wifi", new { Ssid = ssid, Password = password }, longOp: true);
    /// <summary>Đổi IP: board lưu rồi tự khởi động lại sau ~1,5 giây — phiên hiện tại mất, nối lại bằng IP mới.</summary>
    public Task<ApiResult> PutNetworkAsync(ApiNetwork n) => SendAsync<ApiResult>(HttpMethod.Put, "api/network", n);
    /// <summary>Board MCU: các PC quản trị (đang dùng / đang chờ).</summary>
    public Task<List<ApiAdmin>> AdminsAsync() => SendAsync<List<ApiAdmin>>(HttpMethod.Get, "api/admins", null);
    /// <summary>action = approve (kích hoạt PC đang chờ ngay) | reject (từ chối PC đang chờ) | remove (gỡ PC).</summary>
    public Task<ApiResult> AdminActionAsync(string id, string action) => SendAsync<ApiResult>(HttpMethod.Post, "api/admins", new { Id = id, Action = action });
    /// <summary>
    /// Board MCU: nạp firmware qua mạng (POST /api/ota, thân = file .bin thô, X-Sha256 = SHA-256 của file). Board kiểm SHA-256 rồi mới đổi
    /// phân vùng và tự khởi động lại sau ~1,5 giây — phiên hiện tại mất, nối lại sau 10–15 giây. Lỗi giữa chừng: board giữ nguyên bản cũ.
    /// </summary>
    /// <param name="version">Phiên bản + <paramref name="sig"/>: chữ ký nhà phát triển "fw1|&lt;sha256&gt;|&lt;phiên bản&gt;" (file firmware.bin.json do
    /// cloud/app/scripts/sign-mcu-firmware.js sinh). Board từ chối bản không ký / sai chữ ký; board có chủ còn cần chủ trạm duyệt trên webapp.</param>
    public async Task<ApiResult> OtaAsync(byte[] firmware, string version, string sig, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        var sha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(firmware)).ToLowerInvariant();
        using var req = new HttpRequestMessage(HttpMethod.Post, "api/ota") { Content = new ProgressContent(firmware, progress) };
        req.Headers.Add("X-Sha256", sha);
        req.Headers.Add("X-Fw-Version", version);
        req.Headers.Add("X-Fw-Sig", sig);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromMinutes(3));
        try
        {
            using var res = await _http.SendAsync(req, cts.Token);
            var text = await res.Content.ReadAsStringAsync(ct);
            ApiResult? r = null;
            try { r = JsonSerializer.Deserialize<ApiResult>(text, J); } catch (JsonException) { }
            if (!res.IsSuccessStatusCode || r == null || !r.Ok) throw new RemoteException(r?.Err ?? ((int)res.StatusCode).ToString());
            return r;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new RemoteException("timeout"); }
        catch (HttpRequestException e) { throw new RemoteException("offline", e.Message); }
    }

    /// <summary>Gửi mảng byte theo khúc 16 KB và báo tiến độ 0..1.</summary>
    sealed class ProgressContent : HttpContent
    {
        readonly byte[] _data; readonly IProgress<double>? _progress;
        public ProgressContent(byte[] data, IProgress<double>? progress) { _data = data; _progress = progress; Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream"); }
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            for (var off = 0; off < _data.Length; off += 16384)
            {
                var n = Math.Min(16384, _data.Length - off);
                await stream.WriteAsync(_data.AsMemory(off, n));
                _progress?.Report((double)(off + n) / _data.Length);
            }
        }
        protected override bool TryComputeLength(out long length) { length = _data.Length; return true; }
    }

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
        "wifi_auth_failed" => "Sai mật khẩu Wi-Fi (hoặc kiểu bảo mật không được hỗ trợ). Mạng cũ vẫn giữ nguyên.",
        "wifi_not_found" => "Board không thấy mạng này — lại gần router hơn hoặc quét lại.",
        "wifi_timeout" => "Nối Wi-Fi quá lâu không được (router không cấp IP?). Mạng cũ vẫn giữ nguyên.",
        "wifi_password_length" => "Mật khẩu Wi-Fi phải từ 8 đến 63 ký tự.",
        "wifi_ssid_too_long" => "Tên Wi-Fi (SSID) tối đa 32 ký tự.",
        "wifi_unsupported" => "Thiết bị này không có Wi-Fi.",
        "ota_bad_sha256" => "Board nhận file bị lỗi (sai SHA-256) — đã huỷ, board giữ nguyên firmware cũ. Thử lại.",
        "ota_incomplete" => "Đứt kết nối giữa chừng — board giữ nguyên firmware cũ. Thử lại.",
        "ota_unsupported" => "Thiết bị này không hỗ trợ cập nhật firmware qua mạng.",
        "bad_json" => "Thiết bị trả dữ liệu không đúng định dạng (phiên bản không khớp?).",
        "rev_conflict" => "Cài đặt vừa bị thay đổi ở nơi khác (GatewayApp/GatewayAdmin khác) — đã tải lại bản mới nhất, hãy sửa lại.",
        "safe_mode" => "Board đang ở CHẾ ĐỘ AN TOÀN (vừa khởi động lại bất thường nhiều lần liền) — chỉ cho TẮT đầu ra. Kiểm tra nguồn cấp và tải nối vào DO.",
        "not_found" => "Firmware board chưa có chức năng này — cập nhật firmware (nút Firmware…).",
        { } c when c.Contains(' ') => c,   // board trả câu báo lỗi tiếng Việt (kiểm tra cài đặt)
        "ota_not_approved" => "Board có chủ: chỉ nhận cập nhật trong 15 phút sau khi CHỦ TRẠM bấm \"Cho phép cập nhật\" trên webapp (Cài đặt → Lịch sử hệ thống).",
        "ota_unsigned" => "Firmware chưa được ký — chạy cloud/app/scripts/sign-mcu-firmware.js sign … (sinh firmware.bin.json cạnh file .bin).",
        "ota_bad_signature" => "Board TỪ CHỐI: chữ ký firmware không khớp khoá của nhà phát triển (file bị sửa hoặc ký bằng khoá khác).",
        "logic_need" => "Chương trình logic của board chặn: chưa đủ điều kiện để BẬT (logic_need).",
        "logic_interlock" => "Chương trình logic của board chặn: đầu ra liên động đang bật (logic_interlock).",
        "owner_approval_required" => "Đổi chương trình logic từ xa cần chủ trạm duyệt trên webapp (GatewayAdmin → 📝 Logic → Gửi đề xuất).",
        "toggle_too_fast" => "Đầu ra vừa đổi trạng thái — chưa đủ thời gian tối thiểu giữa 2 lần bật/tắt (bảo vệ tiếp điểm relay). Đợi rồi thử lại.",
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
    // Giao thức board hỗ trợ (firmware báo) nhớ lại để hộp "Thêm thiết bị" dựng danh sách giao thức mà không phải dò lại mạng.
    static string CapsPath => Path.Combine(Path.GetDirectoryName(Path.GetFullPath(FilePath))!, "remote-board-protocols.json");
    public static void SetProtocols(string hw, string[] protocols)
    {
        if (hw.Length == 0 || protocols.Length == 0) return;
        Dictionary<string, string[]> d;
        try { d = File.Exists(CapsPath) ? JsonSerializer.Deserialize<Dictionary<string, string[]>>(File.ReadAllText(CapsPath)) ?? new() : new(); } catch (Exception) { d = new(); }
        d[hw] = protocols;
        try { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(CapsPath))!); File.WriteAllText(CapsPath, JsonSerializer.Serialize(d)); } catch (IOException) { }
    }
    public static string[] ProtocolsOf(string hw)
    {
        try { if (File.Exists(CapsPath) && (JsonSerializer.Deserialize<Dictionary<string, string[]>>(File.ReadAllText(CapsPath)) ?? new()).TryGetValue(hw, out var p) && p.Length > 0) return p; } catch (Exception) { }
        return new[] { "dio", "rs485" };   // firmware cũ chưa báo
    }
    /// <summary>Mọi board đã tin cậy: mã phần cứng → IP gần nhất.</summary>
    public static Dictionary<string, string> All() => Load();
    /// <summary>Địa chỉ IP của các board đã tin cậy.</summary>
    public static HashSet<string> Hosts() => Load().Values.ToHashSet();
    // Chế độ của từng board đối với GATEWAY PC NÀY (remote-board-modes.json cạnh remote-boards.json): "slave" (mặc định) = board là slave Modbus TCP của gateway C#,
    // gateway C# giữ lease và là đường báo lên server duy nhất; "standalone" = board tự chạy như gateway độc lập, tự nối cloud — gateway C# chỉ là chương trình
    // nối vào board (cài đặt / xem), KHÔNG nối lên server thay board và không giữ lease.
    public const string Slave = "slave", Standalone = "standalone";
    static string ModesPath => Path.Combine(Path.GetDirectoryName(Path.GetFullPath(FilePath))!, "remote-board-modes.json");
    static Dictionary<string, string> LoadModes()
    {
        try { return File.Exists(ModesPath) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(ModesPath)) ?? new() : new(); }
        catch (Exception) { return new(); }
    }
    public static string ModeOf(string hw) => LoadModes().TryGetValue(hw, out var m) && m == Standalone ? Standalone : Slave;
    public static void SetMode(string hw, string mode)
    {
        var d = LoadModes(); d[hw] = mode == Standalone ? Standalone : Slave;
        try { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(ModesPath))!); File.WriteAllText(ModesPath, JsonSerializer.Serialize(d)); } catch (IOException) { }
    }
    /// <summary>Board ở địa chỉ này được đặt chạy độc lập (không giữ lease)?</summary>
    public static bool IsStandalone(string host) => Load().Where(kv => kv.Value == host).Any(kv => ModeOf(kv.Key) == Standalone);
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
