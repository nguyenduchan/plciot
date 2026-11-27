using System.Text.Json;
using Plciot.Scada.Services.Ui;

namespace GatewayApp;

/// <summary>
/// GATEWAY MUA SẴN (no-code, hiện hỗ trợ USR-M100): chỉ cài đặt trên GatewayApp. Gateway PC này (đã đăng ký cloud) bắt tay với VPS bằng
/// khoá máy để tạo gateway no-code cho CHỦ của nó, lấy thông số MQTT, soạn/lưu ánh xạ, xoay mật khẩu. Sau đó gateway mua sẵn nối
/// THẲNG VPS (PC tắt cũng không sao); webapp thấy như mọi gateway. Server: cloud/app/src/nocode.js. Xem docs/NOCODE-GATEWAY.md.
/// </summary>
public sealed partial class MainForm
{
    NocodePage _nocodePage = null!;
    internal void NocodeLog(string t, bool warn = false) => _log.Add(warn ? "WARN" : "INFO", "no-code", t);

    /// <summary>Gọi API no-code của server (ký bằng khoá gateway PC).</summary>
    internal async Task<JsonElement> NocodeAsync(string op, string? target = null, IReadOnlyDictionary<string, object?>? extra = null)
    {
        if (string.IsNullOrEmpty(_cfg.MqttId)) throw new InvalidOperationException("gateway này chưa đăng ký cloud");
        using var http = new HttpClient { BaseAddress = new Uri(CloudPage.ServerOf(_cfg).Trim()), Timeout = TimeSpan.FromSeconds(20) };
        var (site, device) = CloudSiteDevice();
        return await new GatewayEnrollClient(http).NocodeAsync(op, site, device, Identity(), target, extra);
    }

    /// <summary>File CA của broker MQTTS (chỉ chứng chỉ) để nạp vào gateway mua sẵn; null nếu server chưa đặt.</summary>
    internal async Task<string?> NocodeCaAsync()
    {
        using var http = new HttpClient { BaseAddress = new Uri(CloudPage.ServerOf(_cfg).Trim()), Timeout = TimeSpan.FromSeconds(20) };
        using var res = await http.GetAsync("/api/nocode/ca.crt");
        if (!res.IsSuccessStatusCode) return null;
        var pem = await res.Content.ReadAsStringAsync();
        return pem.Contains("-----BEGIN CERTIFICATE-----") ? pem : null;
    }
}
