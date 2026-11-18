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

    /// <summary>
    /// Lấy lại QR HIỆN HÀNH của tem (khi QR trên máy bị từ chối vì tem đã được cấp lại QR). Chứng minh bằng khoá riêng của gateway
    /// (chữ ký "qr|site|device|ts" + khoá công khai), không cần QR cũ hay đăng nhập. Trả chuỗi QR mới.
    /// </summary>
    public async Task<string> RefreshQrAsync(string site, string device, GatewayIdentity id, CancellationToken ct = default)
    {
        var (ts, sig) = id.RequestProof("qr", site, device);
        using var res = await _http.PostAsJsonAsync("/api/v1/gateway/qr", new { site, device, pubkey = id.PublicKey, ts, sig }, JsonOpts, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        return r.TryGetProperty("qr", out var q) && q.GetString() is { Length: > 0 } s ? s : throw new InvalidOperationException("qr_missing");
    }

    /// <summary>Lỗi do QR trên máy đã cũ (server không còn nhận) — gọi RefreshQrAsync rồi thử lại.</summary>
    public static bool IsStaleQr(Exception ex) => ex is InvalidOperationException { Message: "invalid_claim_signature" or "invalid_claim_secret" or "invalid_claim_payload" };

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

    /// <summary>Đăng nhập: tên + mật khẩu + mã ghép (tạo trên webapp bằng điện thoại). Thiếu một trong ba thì server không cấp token.</summary>
    public async Task<LoginPoll> LoginPasswordAsync(string username, string password, string code, CancellationToken ct = default)
    {
        using var res = await _http.PostAsJsonAsync("/api/v1/gateway/login/password", new { username, password, code }, JsonOpts, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        return new LoginPoll(r.TryGetProperty("status", out var s) ? s.GetString() ?? "" : "", r.TryGetProperty("token", out var t) ? t.GetString() ?? "" : "",
            r.TryGetProperty("user", out var u) ? u.GetString() ?? "" : "", r.TryGetProperty("uid", out var d) && d.TryGetInt64(out var id) ? id : 0);
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
        // 202 transfer_pending: gateway đang thuộc tài khoản khác → server tạo yêu cầu đổi chủ chờ chủ cũ duyệt (hoặc hết hạn chờ)
        var due = r.TryGetProperty("dueAt", out var da) && da.TryGetInt64(out var dms) ? dms : 0;
        return new PairResult(S("id") ?? "", r.TryGetProperty("devices", out var n) ? n.GetInt32() : 0, approved, S("site"), S("device"), S("qr"), S("loginUrl"), kit, S("status"), due);
    }

    /// <summary>Gateway của tài khoản (token đăng nhập) — chọn gateway cũ để chuyển sang PC này.</summary>
    public async Task<List<(string Site, string Device, string Label)>> MineAsync(string token, CancellationToken ct = default)
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/gateway/mine");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        var list = new List<(string, string, string)>();
        if (r.TryGetProperty("gateways", out var g))
            foreach (var x in g.EnumerateArray())
            {
                string S(string n) => x.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
                list.Add((S("site"), S("device"), S("label")));
            }
        return list;
    }

    /// <summary>Chuyển gateway cũ sang PC này: giữ tem/QR/id MQTT/lịch sử; server đổi khoá công khai + xoay mật khẩu MQTT (PC cũ bị cắt).</summary>
    public async Task<PairResult> RebindAsync(string token, string site, string device, GatewayIdentity id, CancellationToken ct = default)
    {
        var (ts, sig) = id.RebindProof(site, device);
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/v1/gateway/rebind")
        {
            Content = JsonContent.Create(new { site, device, pubkey = id.PublicKey, ts, sig }, options: JsonOpts),
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        var r = await ReadAsync(res, ct).ConfigureAwait(false);
        string? S(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        GatewayProvisionKit? kit = r.TryGetProperty("kit", out var k) ? JsonSerializer.Deserialize<GatewayProvisionKit>(k.GetRawText(), JsonOpts) : null;
        return new PairResult("", 0, kit != null, S("site"), S("device"), S("qr"), S("loginUrl"), kit);
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

public sealed record PairResult(string Id, int Devices, bool Approved = false, string? Site = null, string? Device = null, string? Qr = null, string? LoginUrl = null, GatewayProvisionKit? Kit = null, string? Status = null, long DueAt = 0);

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
    /// <summary>Số ngày cloud lưu data theo gói của chủ (0 = không giới hạn); null = server cũ.</summary>
    public int? RetentionDays { get; set; }
    /// <summary>Chu kỳ lưu (ms) theo gói: tốc độ gửi khi không ai xem webapp. null/0 = server cũ, luôn gửi nhanh.</summary>
    public int? StoreEveryMs { get; set; }
    /// <summary>Id MQTT ngẫu nhiên server cấp (16 hex); topic = gw/&lt;MqttId&gt;/&lt;kind&gt;.</summary>
    public string? MqttId { get; set; }
    /// <summary>Khoá công khai (SPKI base64url) của server để kiểm chữ ký lệnh cloud. Null = server cũ.</summary>
    public string? CmdKey { get; set; }
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
