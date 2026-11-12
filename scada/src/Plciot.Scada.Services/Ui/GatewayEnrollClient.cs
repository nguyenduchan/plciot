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

    /// <summary>
    /// Ghép cặp bằng mã do admin phát: gửi TOÀN BỘ bản khai (thiết bị, field, setting, UI — đúng bản tin &lt;base&gt;/config) lên server.
    /// Server chỉ nhận khi mã còn hạn; admin xem trước rồi duyệt và cấp QR. <paramref name="fp"/> = vân tay ngắn của gateway để admin đối chiếu.
    /// </summary>
    public async Task<PairResult> PairAsync(string code, string fp, byte[] configJson, CancellationToken ct = default)
    {
        using var cfg = JsonDocument.Parse(configJson);
        using var res = await _http.PostAsJsonAsync("/api/v1/gateway/pair", new { code, fp, config = cfg.RootElement.Clone() }, JsonOpts, ct).ConfigureAwait(false);
        var json = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var r = doc.RootElement;
        if (!res.IsSuccessStatusCode)
            throw new InvalidOperationException(r.TryGetProperty("error", out var e) ? e.GetString() : $"HTTP {(int)res.StatusCode}");
        return new PairResult(r.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "", r.TryGetProperty("devices", out var n) ? n.GetInt32() : 0);
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

public sealed record PairResult(string Id, int Devices);

public sealed class GatewayProvisionKit
{
    public string? Site { get; set; }
    public string? Device { get; set; }
    public string? Profile { get; set; }
    public int Schema { get; set; }
    public int ConfigRev { get; set; }
    /// <summary>Id MQTT ngẫu nhiên server cấp (16 hex); topic = gw/&lt;MqttId&gt;/&lt;kind&gt;.</summary>
    public string? MqttId { get; set; }
    public string? TopicBase { get; set; }
    public Dictionary<string, string>? Topics { get; set; }
    /// <summary>Chỉ id + fields để đóng gói — không dùng type để vẽ.</summary>
    public List<GatewayPackItem>? Pack { get; set; }
    public List<GatewaySeedChild>? Seed { get; set; }
    public GatewayMqttConfig? Mqtt { get; set; }
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
}
