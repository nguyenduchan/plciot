using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace GatewayProvisioner;

/// <param name="Link">COM3 | COM3:9600 | tcp://host:port | http://host</param>
/// <param name="Link">... | file:C:\\kit.json (ghi kit ra file, dùng cho gateway PC)</param>
/// <param name="Activate">Chỉ dùng khi Kind = null (cách cũ): true = có mã kích hoạt; false = bán kèm cấu hình.</param>
/// <param name="Kind">mcu | pc | generic — quyết định cách kích hoạt cùng với Offline (bảng trong docs/DEVICE-BINDING.md).</param>
/// <param name="Offline">true = gateway chỉ có mạng LAN, không internet.</param>
public sealed record Options(
    string Vps, string Token, string Link, string Site, string Device,
    string Profile, int Days, string Request, bool Activate = true,
    string? Kind = null, bool Offline = false);

/// <summary>Kết quả suy ra từ loại gateway × online/offline. Mode: challenge | license | null (không kích hoạt).</summary>
public sealed record Plan(bool Activate, string? Mode, string? Error = null)
{
    /// <summary>Cùng bảng với server (cloud/app/src/gatewayKinds.js).</summary>
    public static Plan For(string? kind, bool offline, bool legacyActivate) => (kind?.Trim().ToLowerInvariant(), offline) switch
    {
        (null or "", _) => new(legacyActivate, legacyActivate ? "challenge" : null),
        ("mcu", false) => new(false, null),
        ("mcu", true) => new(true, "challenge"),
        ("pc", false) => new(false, null),            // server tự gắn máy khi gateway enroll kèm ID máy
        ("pc", true) => new(true, "license"),
        ("generic", false) => new(false, null),
        ("generic", true) => new(false, null, "offline_not_supported"),
        _ => new(false, null, "invalid_gateway_kind"),
    };
}

public sealed record Result(bool Ok, string Message, string? Code = null, string? Qr = null);

/// <summary>Luồng nạp: (tuỳ chọn) đọc mã yêu cầu từ gateway → VPS cấp QR + kit MQTT (+ mã kích hoạt) → ghi vào gateway.</summary>
public static class Provisioner
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    // Cùng bảng Crockford base32 với server (bỏ I L O U).
    static readonly Regex ReqRx = new("^[0-9A-HJKMNP-TV-Z]{12,48}$");
    static readonly Regex IdRx = new("^[0-9A-HJKMNP-TV-Z]{4,48}$");

    /// <summary>Chuẩn hoá giống server: hoa, bỏ khoảng trắng/gạch, O→0, I/L→1.</summary>
    public static string NormalizeRequest(string? raw) =>
        Regex.Replace((raw ?? "").ToUpperInvariant(), @"[\s\-_.]", "")
             .Replace('O', '0').Replace('I', '1').Replace('L', '1');

    public static string BaseUrl(string url)
    {
        var u = (url ?? "").Trim().TrimEnd('/');
        if (u.Length == 0) return u;
        return Regex.IsMatch(u, "^https?://", RegexOptions.IgnoreCase) ? u : "http://" + u;
    }

    /// <summary>Lỗi do server/gateway → câu tiếng Việt, đúng một nguyên nhân.</summary>
    public static string Explain(string? code, int status = 0) => code switch
    {
        "factory_token_invalid" => "Token nạp sai hoặc đã bị thu hồi. Nhờ admin cấp token mới.",
        "invalid_activation_request" => "Mã yêu cầu / ID máy không hợp lệ (chỉ chữ và số, 4–48 ký tự). Gõ lại đúng chuỗi hiển thị trên gateway.",
        "invalid_gateway_kind" => "Loại gateway không hợp lệ (mcu, pc hoặc generic).",
        "offline_not_supported" => "Gateway mua sẵn không hỗ trợ chế độ không internet (cần cloud). Bỏ chọn \"không internet\" hoặc đổi loại.",
        "device_already_claimed" => "Thiết bị này đã có người dùng thêm vào tài khoản. Admin cần thu hồi trước khi nạp lại.",
        "device_already_activated" => "Thiết bị này đã nạp cho một máy khác. Admin cần thu hồi hoặc xác nhận chuyển máy.",
        "invalid_site_or_device" => "Tên nhà máy hoặc thiết bị không hợp lệ (chỉ chữ, số, - và _, tối đa 48 ký tự).",
        "claim_root_private_key_missing" => "Server chưa cấu hình khoá ký tem. Báo admin.",
        "provision_failed" => "Server chưa tạo xong tài khoản MQTT cho thiết bị. Thử lại sau ít phút.",
        "rate_limited" => "Thao tác quá nhanh. Đợi một phút rồi thử lại.",
        "activation_typo" => "Gateway báo mã kích hoạt bị sai ký tự.",
        "activation_wrong_device" => "Gateway từ chối mã: mã yêu cầu đã đổi (gateway vừa khởi động lại?) hoặc khoá không khớp. Đọc lại mã yêu cầu rồi nạp lại.",
        "activation_expired" => "Gateway báo mã kích hoạt đã hết hạn (kiểm tra đồng hồ gateway).",
        "storage_failed" => "Gateway không lưu được cấu hình (bộ nhớ đầy hoặc bị khoá ghi).",
        _ when status == 401 => "Token nạp sai hoặc đã bị thu hồi. Nhờ admin cấp token mới.",
        _ when status >= 500 => "Server đang gặp sự cố. Thử lại sau ít phút.",
        _ => $"Không nạp được vì lý do chưa xác định ({code ?? $"HTTP {status}"}).",
    };

    /// <summary>Đọc mã yêu cầu (ID + nonce) mà gateway đang hiển thị.</summary>
    public static async Task<string> ReadRequestAsync(string link)
    {
        using var l = Links.Open(link);
        return await l.ReadRequestAsync();
    }

    public static async Task<Result> RunAsync(Options o, Action<string> log)
    {
        var plan = Plan.For(o.Kind, o.Offline, o.Activate);
        if (plan.Error != null) return new(false, Explain(plan.Error));
        var request = NormalizeRequest(o.Request);
        var licenseMode = plan.Mode == "license";
        if (plan.Activate && !(licenseMode ? IdRx.IsMatch(request) : ReqRx.IsMatch(request))) return new(false, Explain("invalid_activation_request"));
        if (!plan.Activate && request.Length > 0 && !IdRx.IsMatch(request)) return new(false, Explain("invalid_activation_request"));
        var vps = BaseUrl(o.Vps);
        if (vps.Length == 0) return new(false, "Chưa nhập địa chỉ VPS.");
        if (string.IsNullOrWhiteSpace(o.Token)) return new(false, "Chưa nhập token nạp (admin cấp trên trang quản trị).");

        IGatewayLink link;
        try { link = Links.Open(o.Link); }
        catch (InvalidOperationException e) { return new(false, e.Message); }

        using (link)
        {
            log("1/3 Xin QR và cấu hình MQTT" + (plan.Activate ? (licenseMode ? ", giấy phép" : ", mã kích hoạt") : "") + " từ VPS…");
            JsonElement srv;
            try
            {
                using var req = new HttpRequestMessage(HttpMethod.Post, $"{vps}/api/v1/factory/provision");
                req.Headers.Authorization = new("Bearer", o.Token.Trim());
                req.Content = JsonContent.Create(new
                {
                    site = o.Site.Trim(), device = o.Device.Trim(), request,
                    profile = string.IsNullOrWhiteSpace(o.Profile) ? "generic" : o.Profile.Trim(),
                    days = o.Days, activate = plan.Activate,
                    kind = string.IsNullOrWhiteSpace(o.Kind) ? null : o.Kind.Trim().ToLowerInvariant(),
                    connectivity = o.Offline ? "offline" : "online",
                });
                using var resp = await Http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                JsonElement j = default;
                try { j = JsonSerializer.Deserialize<JsonElement>(body); } catch { /* không phải JSON */ }
                if (!resp.IsSuccessStatusCode)
                {
                    string? code = j.ValueKind == JsonValueKind.Object && j.TryGetProperty("error", out var ec) ? ec.GetString() : null;
                    return new(false, Explain(code, (int)resp.StatusCode));
                }
                srv = j;
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
            {
                return new(false, "Không kết nối được VPS. Kiểm tra mạng Internet và địa chỉ VPS.");
            }

            var qr = srv.GetProperty("qr").GetString()!;
            var site = srv.GetProperty("site").GetString();
            var device = srv.GetProperty("device").GetString();
            string? actCode = null;
            object? activation = null;
            if (plan.Activate && srv.TryGetProperty("activation", out var act) && act.ValueKind == JsonValueKind.Object)
            {
                actCode = act.GetProperty("code").GetString();
                activation = new
                {
                    key = act.GetProperty("key").GetString(),
                    code = actCode,
                    exp = act.GetProperty("exp").GetInt64(),
                };
                log($"    Mã kích hoạt {actCode} (lần cấp thứ {act.GetProperty("activations").GetInt32()}).");
            }

            log("2/3 Ghi vào gateway…");
            (bool Ok, string? Error) w;
            try
            {
                var payload = new Dictionary<string, object?>
                {
                    ["site"] = site, ["device"] = device, ["qr"] = qr, ["gateway"] = srv.GetProperty("gateway"), ["activation"] = activation,
                };
                // Gateway PC không internet: giấy phép + kit đủ để chạy LAN (type/widget). Bỏ qua nếu server không trả.
                if (srv.TryGetProperty("licenseFile", out var lf) && lf.ValueKind == JsonValueKind.Object) payload["licenseFile"] = lf;
                if (srv.TryGetProperty("offline", out var off) && off.ValueKind == JsonValueKind.Object) payload["offline"] = off;
                w = await link.WriteAsync(payload);
            }
            catch (InvalidOperationException e)
            {
                return new(false, e.Message + " Nạp lại để thử tiếp.", actCode, qr);
            }
            if (!w.Ok) return new(false, Explain(w.Error), actCode, qr);

            var toFile = o.Link.Trim().StartsWith("file:", StringComparison.OrdinalIgnoreCase);
            log(toFile ? "3/3 Đã ghi file." : plan.Activate ? "3/3 Gateway đã kiểm mã và xác nhận kích hoạt." : "3/3 Gateway đã lưu cấu hình.");
            var how = toFile ? " Đã ghi file kit" + (licenseMode ? " và file giấy phép (gửi cho khách cài vào gateway PC)." : ".")
                : plan.Activate ? " Gateway đã kích hoạt." : " Gateway đã nhận cấu hình MQTT.";
            return new(true, $"Nạp thành công: {site}/{device}." + how, actCode, qr);
        }
    }
}
