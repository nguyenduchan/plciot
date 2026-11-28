using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GatewayAdmin;

/// <summary>
/// Khoá của MÁY GatewayAdmin (ECDSA P-256), sinh lần đầu, lưu %LOCALAPPDATA%\PlciotGatewayAdmin\admin-key.bin mã hoá DPAPI (chỉ user Windows này mở được).
/// Server chỉ nhận khoá đã đăng ký qua SSH: <c>node scripts/remote-admin-key.js add &lt;tên&gt; &lt;SPKI&gt;</c> — không có mật khẩu/đăng nhập.
/// </summary>
public sealed class AdminKey
{
    public ECDsa Key { get; }
    public string Spki { get; }
    public string KeyId { get; }
    public static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PlciotGatewayAdmin");

    AdminKey(ECDsa k)
    {
        Key = k;
        var spki = k.ExportSubjectPublicKeyInfo();
        Spki = B64u(spki);
        KeyId = Convert.ToHexString(SHA256.HashData(spki))[..16].ToLowerInvariant();
    }

    public static AdminKey LoadOrCreate()
    {
        Directory.CreateDirectory(Dir);
        var file = Path.Combine(Dir, "admin-key.bin");
        var k = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        if (File.Exists(file)) k.ImportPkcs8PrivateKey(ProtectedData.Unprotect(File.ReadAllBytes(file), null, DataProtectionScope.CurrentUser), out _);
        else File.WriteAllBytes(file, ProtectedData.Protect(k.ExportPkcs8PrivateKey(), null, DataProtectionScope.CurrentUser));
        return new AdminKey(k);
    }

    /// <summary>Dòng lệnh chạy trên VPS để đăng ký máy này.</summary>
    public string RegisterCommand => $"cd /root/plciot/cloud && docker compose exec -T app node scripts/remote-admin-key.js add \"{Environment.MachineName}\" {Spki}";

    public static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed record GatewayRow(string Site, string Device, string MqttId, string? Version, long? LastSeen, bool Allowed, string? Owner, string Kind);

/// <summary>Lỗi do server trả (radmin_*, gateway_timeout…).</summary>
public sealed class AdminApiException(string code, int status, string? detail = null) : Exception(detail ?? code)
{
    public string Code { get; } = code; public int Status { get; } = status;
    /// <summary>Câu chi tiết của server (vd lỗi cú pháp logic: "Dòng 3: …").</summary>
    public string? Detail { get; } = detail;
}

/// <summary>Gọi /api/v1/radmin/* — mỗi yêu cầu ký radm1|METHOD|path|ts|nonce|sha256(thân) (cloud/app/src/remoteAdmin.js).</summary>
public sealed class AdminApi : IDisposable
{
    static readonly JsonSerializerOptions J = new() { PropertyNameCaseInsensitive = true };
    readonly HttpClient _http;
    readonly AdminKey _key;
    public string Server { get; }

    public AdminApi(string server, AdminKey key)
    {
        Server = server.TrimEnd('/'); _key = key;
        _http = new HttpClient { BaseAddress = new Uri(Server + "/"), Timeout = TimeSpan.FromSeconds(40) };
    }

    async Task<string> SendAsync(HttpMethod m, string path, string body, CancellationToken ct = default)
    {
        var ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString();
        var nonce = AdminKey.B64u(RandomNumberGenerator.GetBytes(16));
        var bytes = Encoding.UTF8.GetBytes(body);
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        // ký đường dẫn KHÔNG kèm query (?site=…): server kiểm theo req.path
        var sig = _key.Key.SignData(Encoding.UTF8.GetBytes($"radm1|{m.Method}|{path.Split('?')[0]}|{ts}|{nonce}|{hash}"), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        using var req = new HttpRequestMessage(m, path.TrimStart('/'));
        if (body.Length > 0) req.Content = new ByteArrayContent(bytes) { Headers = { ContentType = new("application/json") } };
        req.Headers.Add("X-Radm-Key", _key.KeyId); req.Headers.Add("X-Radm-Ts", ts); req.Headers.Add("X-Radm-Nonce", nonce); req.Headers.Add("X-Radm-Sig", AdminKey.B64u(sig));
        using var res = await _http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            string code = ((int)res.StatusCode).ToString(); string? detail = null;
            try
            {
                using var d = JsonDocument.Parse(text);
                if (d.RootElement.TryGetProperty("error", out var e)) code = e.GetString() ?? code;
                if (d.RootElement.TryGetProperty("message", out var msgEl) && msgEl.ValueKind == JsonValueKind.String) detail = msgEl.GetString();
                if (d.RootElement.TryGetProperty("detail", out var dtEl) && dtEl.ValueKind == JsonValueKind.String) detail = dtEl.GetString();
            }
            catch (JsonException) { }
            throw new AdminApiException(code, (int)res.StatusCode, detail);
        }
        return text;
    }

    public async Task<List<GatewayRow>> GatewaysAsync()
    {
        using var d = JsonDocument.Parse(await SendAsync(HttpMethod.Get, "/api/v1/radmin/gateways", ""));
        return d.RootElement.GetProperty("gateways").Deserialize<List<GatewayRow>>(J) ?? new();
    }

    /// <summary>Gọi một route API LAN của gateway qua relay → (status, json của gateway).</summary>
    public async Task<(int Status, string Body)> RpcAsync(string site, string device, string method, string path, string body, CancellationToken ct = default)
    {
        var req = JsonSerializer.Serialize(new { site, device, method, path, body });
        using var d = JsonDocument.Parse(await SendAsync(HttpMethod.Post, "/api/v1/radmin/rpc", req, ct));
        return (d.RootElement.GetProperty("status").GetInt32(), d.RootElement.GetProperty("body").GetString() ?? "");
    }

    // ---- chương trình logic (text) — đề xuất cho chủ trạm duyệt trên webapp (cloud/app/src/gatewayLogic.js)
    /// <summary>Chương trình đang chạy + đề xuất gần đây (JSON thô của server).</summary>
    public Task<string> LogicAsync(string site, string device) =>
        SendAsync(HttpMethod.Get, $"/api/v1/radmin/logic?site={Uri.EscapeDataString(site)}&device={Uri.EscapeDataString(device)}", "");
    /// <summary>Kiểm text → {program, text, rows, changed}. Lỗi cú pháp: AdminApiException Code "logic_syntax", Detail = "Dòng n: …".</summary>
    public Task<string> LogicCheckAsync(string site, string device, string text) =>
        SendAsync(HttpMethod.Post, "/api/v1/radmin/logic/check", JsonSerializer.Serialize(new { site, device, text }));
    public Task<string> LogicProposeAsync(string site, string device, string text, string note) =>
        SendAsync(HttpMethod.Post, "/api/v1/radmin/logic/propose", JsonSerializer.Serialize(new { site, device, text, note }));

    // ---- thư viện thiết bị mẫu RS485 (cloud/app/src/deviceLibrary.js) — board Waveshare tải cho trang cài đặt điện thoại của kỹ thuật viên
    public Task<string> TemplatesAsync() => SendAsync(HttpMethod.Get, "/api/v1/radmin/templates", "");
    public Task<string> TemplatePutAsync(string id, string json) => SendAsync(HttpMethod.Put, "/api/v1/radmin/templates/" + Uri.EscapeDataString(id), json);
    public Task<string> TemplateDeleteAsync(string id) => SendAsync(HttpMethod.Delete, "/api/v1/radmin/templates/" + Uri.EscapeDataString(id), "");

    public void Dispose() => _http.Dispose();

    /// <summary>Câu báo cho mã lỗi của server.</summary>
    public static string Explain(Exception e) => e is AdminApiException a ? a.Code switch
    {
        "radmin_unknown_key" => "Máy này chưa được đăng ký trên server — bấm \"Khoá máy này\" và chạy dòng lệnh trên VPS.",
        "radmin_clock" => "Đồng hồ máy này lệch quá 1 phút so với server — chỉnh giờ Windows.",
        "radmin_not_allowed" => "Chủ gateway chưa bật \"Cho phép hỗ trợ từ xa\" trên webapp.",
        "radmin_route_blocked" => "Thao tác này không làm được từ xa (chỉ qua LAN tại chỗ).",
        "gateway_timeout" => "Gateway không trả lời (đang tắt, mất mạng, hoặc bản cũ chưa hỗ trợ cài đặt từ xa).",
        "gateway_not_found" => "Không thấy gateway này trên server.",
        "mqtt_unavailable" => "Server chưa nối được broker MQTT.",
        "logic_syntax" => a.Detail ?? "Lỗi cú pháp.",
        "template_invalid" => a.Detail ?? "Mẫu không hợp lệ.",
        "template_not_found" => "Không có mẫu này trên server.",
        "not_mcu" => "Chỉ board Waveshare có chương trình logic.",
        _ => "Server báo lỗi: " + a.Code,
    } : e is HttpRequestException ? "Không nối được server: " + e.Message : e.Message;
}

/// <summary>
/// Đường truyền "qua cloud" cho RemoteClient của GatewayApp: mỗi yêu cầu HTTP của API LAN (GET /api/state, PUT /api/config…)
/// được gói thành /api/v1/radmin/rpc, trả lời của gateway trả lại như thể gateway nằm trong LAN.
/// </summary>
public sealed class RelayHandler(AdminApi api, string site, string device) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content == null ? "" : await request.Content.ReadAsStringAsync(ct);
        try
        {
            var (st, json) = await api.RpcAsync(site, device, request.Method.Method, request.RequestUri!.AbsolutePath, body, ct);
            return new HttpResponseMessage((HttpStatusCode)st) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
        catch (AdminApiException e)
        {
            return new HttpResponseMessage((HttpStatusCode)e.Status) { Content = new StringContent(JsonSerializer.Serialize(new { Ok = false, Err = e.Code }), Encoding.UTF8, "application/json") };
        }
    }
}
