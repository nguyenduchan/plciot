namespace GatewayApp.Ui;

/// <summary>
/// Điểm cắm của GIẢI PHÁP (kiểu giao diện gateway). Bản cơ bản không đăng ký gì → hành vi y như cũ.
/// Giao diện giải pháp là dữ liệu (SkinBoot đọc ui.json do server gửi, một bản GatewayApp dùng chung): đặt bảng màu Theme và thêm trang vào đây. Mọi thứ về cloud (ghép cặp QR, server.json, MQTT) dùng chung.
/// </summary>
static class SolutionHost
{
    /// <summary>Tên giải pháp ("" = cơ bản).</summary>
    public static string Name { get; set; } = "";
    /// <summary>Tên hiện ở tiêu đề cửa sổ và thanh bên (rỗng = giữ chữ cũ).</summary>
    public static string Title { get; set; } = "";
    /// <summary>Trang bổ sung chèn ngay sau "Tổng quan".</summary>
    public static Func<IGatewayApp, (string Icon, string Name, Control Page)>? ExtraPage { get; set; }
    /// <summary>
    /// Các ô của SƠ ĐỒ VẼ SẴN (chỉ số trong spec giải pháp): Nhãn + các khoá field nhận số. Field của thiết bị có tên trùng một khoá
    /// → số vào sơ đồ (gateway + webapp dùng cùng quy tắc); không trùng → thành widget riêng. Rỗng = bản cơ bản.
    /// </summary>
    public static List<(string Label, string Unit, string[] Keys)> Slots { get; } = new();
    /// <summary>Field này có ô trong sơ đồ vẽ sẵn không (so khớp tên field, không phân biệt hoa thường).</summary>
    public static bool InDiagram(string field) => Slots.Any(s => s.Keys.Contains(field, StringComparer.OrdinalIgnoreCase));
}
