namespace GatewayApp.Ui;

/// <summary>
/// Điểm cắm của GIẢI PHÁP (kiểu giao diện gateway). Bản cơ bản không đăng ký gì → hành vi y như cũ.
/// Một giải pháp nằm trong thư mục độc lập solutions/&lt;id&gt;/gateway/ (file .cs + solution.json): build với
/// <c>dotnet build tools/GatewayApp -p:Solution=&lt;id&gt;</c> thì csproj biên dịch các file đó vào, và [ModuleInitializer]
/// của giải pháp gọi vào đây (đổi bảng màu Theme, thêm trang). Mọi thứ về cloud (ghép cặp QR, server.json, MQTT) dùng chung.
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
