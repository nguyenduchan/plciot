namespace Plciot.Scada;

/// <summary>
/// Ghim chứng chỉ broker MQTTS tự ký (<see cref="ScadaConfig.CloudPinSha256"/>): một HOẶC NHIỀU SHA-256 hex, cách nhau dấu phẩy
/// ("chứng chỉ đang dùng,chứng chỉ dự phòng"). Server cấp danh sách lúc đăng ký và mỗi lần đồng bộ cấu hình (HTTPS, kiểm CA) →
/// khi VPS đổi sang chứng chỉ dự phòng, gateway vẫn nối được mà không phải đăng ký lại / cập nhật thủ công.
/// Cùng quy ước với board Waveshare (gateway-mcu/src/cloud.cpp).
/// </summary>
public static class CloudPins
{
    /// <summary>Tách danh sách, bỏ ":"/khoảng trắng, chữ thường; chỉ giữ chuỗi đúng 64 hex, không trùng.</summary>
    public static string[] Parse(string? pins) =>
        (pins ?? "").Split(',', ';', '\n')
            .Select(p => p.Replace(":", "").Replace(" ", "").Trim().ToLowerInvariant())
            .Where(p => p.Length == 64 && p.All(Uri.IsHexDigit))
            .Distinct().ToArray();

    /// <summary>Chuỗi lưu cấu hình từ danh sách server trao (<c>pins</c>) hoặc, với server cũ, một <c>pinSha256</c>. Rỗng nếu không có pin hợp lệ.</summary>
    public static string FromKit(IEnumerable<string>? pins, string? single)
    {
        var list = Parse(string.Join(",", pins ?? Array.Empty<string>()));
        if (list.Length == 0) list = Parse(single);
        return string.Join(",", list);
    }

    /// <summary>Hash SHA-256 của chứng chỉ server (hex, hoa/thường đều được) có nằm trong danh sách ghim không.</summary>
    public static bool Matches(string? pins, string certSha256Hex) =>
        Parse(pins).Contains(certSha256Hex.ToLowerInvariant());
}
