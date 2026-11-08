using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using GatewayLicense;
using Plciot.Scada.Services.Ui;

namespace Plciot.Scada;

public enum ActivationState { NotRequired, Active, NotActivated, WrongMachine, Invalid, Expired, ClockTampered, Rejected }

/// <summary>Kết quả kiểm kích hoạt. <see cref="MachineId"/> là ID khách đọc cho admin khi chưa kích hoạt.</summary>
public sealed record ActivationStatus(ActivationState State, string MachineId, string Message, int ExpDay = 0)
{
    public bool Allowed => State is ActivationState.NotRequired or ActivationState.Active;
}

/// <summary>Ném khi chưa được phép chạy; giao diện bắt lỗi này để hiện màn hình kích hoạt (kèm ID máy).</summary>
public sealed class LicenseRequiredException(ActivationStatus status) : Exception(status.Message)
{
    public ActivationStatus Status { get; } = status;
}

/// <summary>
/// Kích hoạt gateway PC, hai đường theo <see cref="ScadaConfig.LicenseMode"/>:
///  • "online"  : gửi ID máy cho server khi enroll bằng QR; server gắn tem với máy này (máy khác bị từ chối).
///                Mất mạng khi khởi động thì dùng dấu "đã gắn" lưu cục bộ, không chặn nhà máy đang chạy.
///  • "offline" : file giấy phép admin cấp theo ID máy; tự kiểm bằng HMAC (xem tools/GatewayLicense), không cần mạng.
/// </summary>
public static class GatewayActivation
{
    const string B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    /// <summary>ID máy ổn định, 12 ký tự Crockford, băm từ định danh hệ điều hành (không lộ GUID gốc).</summary>
    public static string MachineId()
    {
        var raw = ReadOsMachineId();
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes("plciot-machine|" + raw));
        var sb = new StringBuilder();
        for (var i = 0; i < 12; i++) sb.Append(B32[hash[i] & 31]);
        return sb.ToString();
    }

    static string ReadOsMachineId()
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                using var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
                if (k?.GetValue("MachineGuid") is string g && g.Length > 0) return g;
            }
            else if (File.Exists("/etc/machine-id")) return File.ReadAllText("/etc/machine-id").Trim();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException) { /* dùng dự phòng */ }
        return Environment.MachineName;
    }

    // ------------------------------------------------------------------ offline: file giấy phép
    /// <summary>Kiểm giấy phép offline tại <paramref name="path"/> cho máy <paramref name="machineId"/>.</summary>
    public static ActivationStatus CheckLicenseFile(string path, string machineId, DateTime utcNow)
    {
        if (!File.Exists(path))
            return new(ActivationState.NotActivated, machineId, $"Chưa kích hoạt. ID máy: {machineId}. Đọc ID này cho nhà cung cấp để nhận giấy phép.");
        return CheckLicenseText(File.ReadAllText(path), machineId, utcNow, path + ".seen");
    }

    public static ActivationStatus CheckLicenseText(string json, string machineId, DateTime utcNow, string? statePath = null)
    {
        string hw, key, code;
        try
        {
            var j = JsonSerializer.Deserialize<JsonElement>(json);
            hw = j.GetProperty("hw").GetString() ?? "";
            key = j.GetProperty("key").GetString() ?? "";
            code = j.GetProperty("code").GetString() ?? "";
            if (key.Length != 64 || !key.All(Uri.IsHexDigit)) throw new FormatException();
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            return new(ActivationState.Invalid, machineId, "File giấy phép không đọc được. Xin nhà cung cấp gửi lại.");
        }
        if (ActivationCode.Normalize(hw) != machineId)
            return new(ActivationState.WrongMachine, machineId, $"Giấy phép này cấp cho máy khác. ID máy này là {machineId}; xin giấy phép mới.");
        var err = ActivationCode.VerifyLicense(code, hw, key, utcNow, out var expDay);
        switch (err)
        {
            case VerifyError.Typo: return new(ActivationState.Invalid, machineId, "Giấy phép bị hỏng (sai ký tự). Xin nhà cung cấp gửi lại.");
            case VerifyError.WrongDevice: return new(ActivationState.Invalid, machineId, "Giấy phép không hợp lệ. Xin nhà cung cấp gửi lại.");
            case VerifyError.Expired: return new(ActivationState.Expired, machineId, "Giấy phép đã hết hạn. Liên hệ nhà cung cấp để gia hạn.", expDay);
        }
        // Có hạn dùng: chống chỉnh lùi đồng hồ bằng mốc chạy gần nhất (chỉ ghi khi hợp lệ).
        if (expDay != 0 && statePath != null)
        {
            var last = ReadLastSeen(statePath);
            if (last.HasValue && utcNow < last.Value.AddDays(-1))
                return new(ActivationState.ClockTampered, machineId, "Đồng hồ máy bị chỉnh lùi. Đặt lại đúng ngày giờ rồi chạy lại.", expDay);
            TryWriteLastSeen(statePath, last.HasValue && last.Value > utcNow ? last.Value : utcNow);
        }
        return new(ActivationState.Active, machineId, expDay == 0 ? "Đã kích hoạt (không hết hạn)." : "Đã kích hoạt (có thời hạn).", expDay);
    }

    /// <summary>Khách dán/nhập nội dung giấy phép: kiểm đúng máy này rồi mới lưu.</summary>
    public static ActivationStatus InstallLicense(string path, string text, DateTime utcNow)
    {
        var st = CheckLicenseText(text, MachineId(), utcNow);
        if (st.Allowed)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path, text);
        }
        return st;
    }

    static DateTime? ReadLastSeen(string p)
    {
        try { return DateTime.TryParse(File.ReadAllText(p), null, System.Globalization.DateTimeStyles.RoundtripKind, out var d) ? d.ToUniversalTime() : null; }
        catch (IOException) { return null; }
    }

    static void TryWriteLastSeen(string p, DateTime t)
    {
        try { File.WriteAllText(p, t.ToString("o")); } catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* không ghi được: bỏ qua */ }
    }

    // ------------------------------------------------------------------ online: server gắn máy
    /// <summary>
    /// Enroll bằng QR kèm ID máy. Thành công → lưu dấu "đã gắn" cục bộ. Server từ chối (máy khác đã gắn) → Rejected.
    /// Không có mạng: nếu dấu cục bộ đúng máy này thì vẫn cho chạy.
    /// </summary>
    public static async Task<(ActivationStatus Status, GatewayProvisionKit? Kit)> BindOnlineAsync(
        HttpClient http, string qr, string path, CancellationToken ct = default)
    {
        var mid = MachineId();
        try
        {
            var kit = await new GatewayEnrollClient(http).EnrollAsync(qr, false, mid, ct).ConfigureAwait(false);
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllText(path, JsonSerializer.Serialize(new { v = 1, type = "bound", hw = mid, site = kit?.Site, device = kit?.Device, at = DateTime.UtcNow }));
            return (new(ActivationState.Active, mid, "Đã gắn với tem trên server."), kit);
        }
        catch (InvalidOperationException e)
        {
            return (e.Message == "device_already_activated"
                ? new(ActivationState.Rejected, mid, $"Tem này đã gắn với máy khác. Nhờ admin bấm \"Gỡ máy đã gắn\" nếu đổi máy (ID máy này: {mid}).")
                : new ActivationStatus(ActivationState.Rejected, mid, $"Server từ chối: {e.Message}"), null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            if (File.Exists(path) && BoundHw(path) == mid)
                return (new(ActivationState.Active, mid, "Không nối được server; chạy theo dấu đã gắn lưu trên máy."), null);
            return (new(ActivationState.NotActivated, mid, "Chưa kích hoạt và không nối được server. Kiểm tra mạng Internet."), null);
        }
    }

    static string? BoundHw(string p)
    {
        try { return JsonSerializer.Deserialize<JsonElement>(File.ReadAllText(p)).GetProperty("hw").GetString(); }
        catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException) { return null; }
    }

    // ------------------------------------------------------------------ gọi từ ScadaHost
    /// <summary>Chặn chạy nếu chưa được phép. LicenseMode "none" (mặc định) → không làm gì.</summary>
    public static async Task EnsureAsync(ScadaConfig cfg, Action<string> log, CancellationToken ct = default)
    {
        var mode = (cfg.LicenseMode ?? "none").ToLowerInvariant();
        if (mode == "none") return;
        ActivationStatus st;
        if (mode == "offline") st = CheckLicenseFile(cfg.LicenseFile, MachineId(), DateTime.UtcNow);
        else if (mode == "online")
        {
            using var http = new HttpClient { BaseAddress = new Uri(cfg.LicenseServerUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(15) };
            st = string.IsNullOrWhiteSpace(cfg.GatewayQr)
                ? new(ActivationState.NotActivated, MachineId(), "Chưa có QR tem. Nhập QR của thiết bị vào cấu hình (GatewayQr).")
                : (await BindOnlineAsync(http, cfg.GatewayQr, cfg.LicenseFile, ct).ConfigureAwait(false)).Status;
        }
        else st = new(ActivationState.Invalid, MachineId(), $"LicenseMode không hợp lệ: {cfg.LicenseMode} (none | online | offline).");
        log($"Kích hoạt ({mode}): {st.Message}");
        if (!st.Allowed) throw new LicenseRequiredException(st);
    }
}
