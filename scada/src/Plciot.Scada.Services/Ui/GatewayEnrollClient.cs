using System.Net.Http.Json;
using System.Text.Json;

namespace Plciot.Scada.Services.Ui;

/// <summary>
/// PC gateway kéo MQTT + pack (id/fields) từ cloud bằng QR tem.
/// Gateway chỉ gom/đóng gói số liệu; phân loại/vẽ widget do server (UI dashboard), không dùng type trên PC gateway.
/// </summary>
public sealed class GatewayEnrollClient
{
    static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    readonly HttpClient _http;

    public GatewayEnrollClient(HttpClient http) => _http = http;

    /// <param name="hw">ID máy (vân tay PC). Có internet: server gắn tem với máy này ở lần enroll đầu và
    /// từ chối máy khác (lỗi device_already_activated). Null = không ràng buộc.</param>
    public Task<GatewayProvisionKit?> EnrollAsync(string qr, bool rotateMqtt = false, string? hw = null, CancellationToken ct = default)
        => PostAsync("/api/v1/gateway/enroll", new { qr, rotateMqtt, hw }, ct);

    public Task<GatewayProvisionKit?> RefreshConfigAsync(string qr, bool includeCredentials = false, string? hw = null, CancellationToken ct = default)
        => PostAsync("/api/v1/gateway/config", new { qr, includeCredentials, hw }, ct);

    /// <summary>Enroll có chữ ký khoá riêng (server bắt buộc với tem đã ghép cặp): chỉ ảnh QR thì không đủ.</summary>
    public Task<GatewayProvisionKit?> EnrollAsync(string qr, GatewayIdentity id, bool rotateMqtt = false, CancellationToken ct = default)
        => SignedAsync("/api/v1/gateway/enroll", "enroll", qr, id, new Dictionary<string, object?> { ["rotateMqtt"] = rotateMqtt }, ct);

    /// <param name="solution">Giải pháp (UI) gateway đang chọn — gửi kèm (có chữ ký) để server đồng bộ; null = không báo. Chuỗi rỗng = giao diện cơ bản.</param>
    public Task<GatewayProvisionKit?> RefreshConfigAsync(string qr, GatewayIdentity id, bool includeCredentials = false, CancellationToken ct = default, string? solution = null)
    {
        var extra = new Dictionary<string, object?> { ["includeCredentials"] = includeCredentials };
        if (solution != null) extra["solution"] = solution;
        return SignedAsync("/api/v1/gateway/config", "config", qr, id, extra, ct);
    }

    Task<GatewayProvisionKit?> SignedAsync(string path, string kind, string qr, GatewayIdentity id, Dictionary<string, object?> extra, CancellationToken ct)
    {
        var sd = GatewayIdentity.SiteDeviceOfQr(qr) ?? throw new InvalidOperationException("invalid_claim_payload");
        var (ts, sig) = id.RequestProof(kind, sd.Site, sd.Device);
        var body = new Dictionary<string, object?>(extra) { ["qr"] = qr, ["hw"] = id.Hw, ["ts"] = ts, ["sig"] = sig };
        return PostAsync(path, body, ct);
    }

    /// <summary>Bước 1 đăng nhập qua trình duyệt: nhận mã người dùng + địa chỉ để duyệt trên webapp.</summary>
    public async Task<LoginStart> LoginStartAsync(CancellationToken ct = default)
    {
        using var res = await _http.PostAsync("/api/v1/gateway/login/start", null, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        string S(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        return new LoginStart(S("deviceCode"), S("userCode"), S("verifyUrl"), r.TryGetProperty("expiresIn", out var e) ? e.GetInt32() : 600, r.TryGetProperty("interval", out var i) ? i.GetInt32() : 3);
    }

    /// <summary>Bước 2: hỏi kết quả duyệt. Chưa duyệt → Token rỗng; đã duyệt → token đăng ký ngắn hạn (chỉ trao một lần).</summary>
    public async Task<LoginPoll> LoginPollAsync(string deviceCode, CancellationToken ct = default)
    {
        using var res = await _http.PostAsJsonAsync("/api/v1/gateway/login/poll", new { deviceCode }, JsonOpts, ct).ConfigureAwait(false);
        if ((int)res.StatusCode == 429) return new LoginPoll("pending", "", "", 0);   // hỏi quá nhanh: coi như chưa duyệt, thử lại sau
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        var status = r.TryGetProperty("status", out var s) ? s.GetString() ?? "" : "";
        return new LoginPoll(status, r.TryGetProperty("token", out var t) ? t.GetString() ?? "" : "", r.TryGetProperty("user", out var u) ? u.GetString() ?? "" : "", r.TryGetProperty("uid", out var d) && d.TryGetInt64(out var id) ? id : 0);
    }

    /// <summary>Đăng ký gateway bằng token đăng nhập + chữ ký khoá riêng: server cấp tem/MQTT trong hạn mức của tài khoản và trả kit.</summary>
    public async Task<PairResult> RegisterAsync(string token, long userId, string fp, byte[] configJson, GatewayIdentity id, string solution = "", CancellationToken ct = default)
    {
        using var cfg = JsonDocument.Parse(configJson);
        var (ts, sig) = id.RegisterProof(userId);
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/gateway/register")
        {
            Content = JsonContent.Create(new { fp, pubkey = id.PublicKey, ts, sig, solution, config = cfg.RootElement.Clone() }, options: JsonOpts),
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        string? S(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var approved = r.TryGetProperty("approved", out var ap) && ap.ValueKind == JsonValueKind.True;
        GatewayProvisionKit? kit = approved && r.TryGetProperty("kit", out var k) ? JsonSerializer.Deserialize<GatewayProvisionKit>(k.GetRawText(), JsonOpts) : null;
        return new PairResult(S("id") ?? "", r.TryGetProperty("devices", out var n) ? n.GetInt32() : 0, approved, S("site"), S("device"), S("qr"), S("loginUrl"), kit);
    }

    static async Task<JsonElement> ReadAsync(HttpResponseMessage res, CancellationToken ct)
    {
        var json = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var r = doc.RootElement.Clone();
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException(r.TryGetProperty("error", out var e) ? e.GetString() : $"HTTP {(int)res.StatusCode}");
        return r;
    }

    /// <summary>
    /// Ghép cặp bằng mã do admin phát (cũ, sẽ bỏ): gửi KHOÁ CÔNG KHAI + chữ ký (chứng minh giữ khoá riêng) + bản khai (thiết bị, field, setting, UI).
    /// Mã TỰ DUYỆT (admin chọn site lúc phát mã): server trả luôn kit (site/device/MQTT/pack) + QR → gateway tự enroll, không cần dán gì.
    /// Mã duyệt tay: chỉ nhận bản khai, admin duyệt và đưa QR sau.
    /// </summary>
    public async Task<PairResult> PairAsync(string code, string fp, byte[] configJson, GatewayIdentity id, CancellationToken ct = default)
    {
        using var cfg = JsonDocument.Parse(configJson);
        var (ts, sig) = id.PairProof(code);
        using var res = await _http.PostAsJsonAsync("/api/v1/gateway/pair", new { code, fp, pubkey = id.PublicKey, ts, sig, config = cfg.RootElement.Clone() }, JsonOpts, ct).ConfigureAwait(false);
        var json = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var r = doc.RootElement;
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException(r.TryGetProperty("error", out var e) ? e.GetString() : $"HTTP {(int)res.StatusCode}");
        string? S(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        var approved = r.TryGetProperty("approved", out var ap) && ap.ValueKind == JsonValueKind.True;
        GatewayProvisionKit? kit = approved && r.TryGetProperty("kit", out var k) ? JsonSerializer.Deserialize<GatewayProvisionKit>(k.GetRawText(), JsonOpts) : null;
        return new PairResult(S("id") ?? "", r.TryGetProperty("devices", out var n) ? n.GetInt32() : 0, approved, S("site"), S("device"), S("qr"), S("loginUrl"), kit);
    }

    async Task<GatewayProvisionKit?> PostAsync(string path, object body, CancellationToken ct)
    {
        using var res = await _http.PostAsJsonAsync(path, body, JsonOpts, ct).ConfigureAwait(false);
        var json = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
            var err = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : $"HTTP {(int)res.StatusCode}";
            throw new InvalidOperationException(err ?? "gateway_enroll_failed");
        }
        return JsonSerializer.Deserialize<GatewayProvisionKit>(json, JsonOpts);
    }
}

public sealed record LoginStart(string DeviceCode, string UserCode, string VerifyUrl, int ExpiresIn, int Interval);
public sealed record LoginPoll(string Status, string Token, string User, long Uid);

public sealed record PairResult(string Id, int Devices, bool Approved = false, string? Site = null, string? Device = null, string? Qr = null, string? LoginUrl = null, GatewayProvisionKit? Kit = null);

public sealed class GatewayProvisionKit
{
    public string? Site { get; set; }
    public string? Device { get; set; }
    public string? Profile { get; set; }
    public int Schema { get; set; }
    public int ConfigRev { get; set; }
    /// <summary>false = tem chưa có user: gateway chỉ đồng bộ setting, không gửi data.</summary>
    public bool? Claimed { get; set; }
    /// <summary>Khoảng cách tối thiểu (ms) giữa hai bản telemetry theo gói của chủ; gateway tự gửi chậm theo mức này. 0/null = không giới hạn.</summary>
    public int? TelemetryMinMs { get; set; }
    /// <summary>Id MQTT ngẫu nhiên server cấp (16 hex); topic = gw/&lt;MqttId&gt;/&lt;kind&gt;.</summary>
    public string? MqttId { get; set; }
    public string? TopicBase { get; set; }
    public Dictionary<string, string>? Topics { get; set; }
    /// <summary>Chỉ id + fields để đóng gói — không dùng type để vẽ.</summary>
    public List<GatewayPackItem>? Pack { get; set; }
    public List<GatewaySeedChild>? Seed { get; set; }
    public GatewayMqttConfig? Mqtt { get; set; }
    /// <summary>Giải pháp (kiểu giao diện) admin gán cho gateway này; rỗng = bản cơ bản. Webapp của user quét QR tự map cùng giải pháp.</summary>
    public string? Solution { get; set; }
    /// <summary>Giao diện của giải pháp dạng DỮ LIỆU (bảng màu + khối hiển thị + công thức); GatewayApp lưu cache và áp dụng khi mở.</summary>
    public System.Text.Json.JsonElement? Ui { get; set; }
}

public sealed class GatewayPackItem
{
    public string? Id { get; set; }
    public List<string>? Fields { get; set; }
    /// <summary>Khoảng giá trị được ghi cho từng trường (do tem provisioning đặt).</summary>
    public Dictionary<string, GatewayLimit>? Limits { get; set; }
}

public sealed class GatewayLimit
{
    public double Min { get; set; }
    public double Max { get; set; }
}

public sealed class GatewaySeedChild
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public string? Title { get; set; }
    public List<string>? Binds { get; set; }
}

public sealed class GatewayMqttConfig
{
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string? Host { get; set; }
    public string? Mqtts { get; set; }
    public string? Wss { get; set; }
    public string? ClientIdHint { get; set; }
    public bool UseTls { get; set; }
    /// <summary>SHA-256 (hex) chứng chỉ TLS tự ký của broker do server trao; gateway ghim đúng chứng chỉ này.</summary>
    public string? PinSha256 { get; set; }
}
