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
}
