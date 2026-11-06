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

    public Task<GatewayProvisionKit?> EnrollAsync(string qr, bool rotateMqtt = false, CancellationToken ct = default)
        => PostAsync("/api/v1/gateway/enroll", new { qr, rotateMqtt }, ct);

    public Task<GatewayProvisionKit?> RefreshConfigAsync(string qr, bool includeCredentials = false, CancellationToken ct = default)
        => PostAsync("/api/v1/gateway/config", new { qr, includeCredentials }, ct);

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

public sealed class GatewayProvisionKit
{
    public string? Site { get; set; }
    public string? Device { get; set; }
    public string? Profile { get; set; }
    public int Schema { get; set; }
    public int ConfigRev { get; set; }
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
