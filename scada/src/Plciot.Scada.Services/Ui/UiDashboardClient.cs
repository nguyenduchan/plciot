using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace Plciot.Scada.Services.Ui;

/// <summary>Tải UI contract từ cloud để WPF/solution dựng widget đúng loại.</summary>
public sealed class UiDashboardClient
{
    static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    readonly HttpClient _http;

    public UiDashboardClient(HttpClient http) => _http = http;

    public void SetBearer(string token)
    {
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    public Task<UiDashboardDocument?> GetDashboardAsync(string mode = "simple", CancellationToken ct = default)
        => _http.GetFromJsonAsync<UiDashboardDocument>($"/api/v1/ui/dashboard?mode={Uri.EscapeDataString(mode)}", JsonOpts, ct);

    public Task<JsonElement> GetSchemaAsync(CancellationToken ct = default)
        => _http.GetFromJsonAsync<JsonElement>("/api/v1/ui/schema", ct);

    /// <summary>Thêm thiết bị bằng QR — server tự chọn type/widget.</summary>
    public async Task<HttpResponseMessage> AddDeviceFromQrAsync(string qr, CancellationToken ct = default)
    {
        return await _http.PostAsJsonAsync("/api/devices", new { qr }, JsonOpts, ct).ConfigureAwait(false);
    }
}
