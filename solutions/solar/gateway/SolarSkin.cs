using System.Runtime.CompilerServices;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>Đăng ký giải pháp "Năng lượng mặt trời" vào gateway: bảng màu xanh trời + hổ phách, trang "Năng lượng". Chỉ có tác dụng khi build với -p:Solution=solar.</summary>
static class SolarSkin
{
    [ModuleInitializer]
    internal static void Register()
    {
        // đổi màu TRƯỚC khi bất kỳ điều khiển nào được dựng (module initializer chạy trước Main)
        Theme.Bg = Color.FromArgb(10, 22, 32);
        Theme.Side = Color.FromArgb(7, 16, 24);
        Theme.Panel = Color.FromArgb(17, 36, 51);
        Theme.Panel2 = Color.FromArgb(24, 48, 67);
        Theme.Border = Color.FromArgb(36, 66, 90);
        Theme.Text = Color.FromArgb(230, 241, 248);
        Theme.Muted = Color.FromArgb(143, 169, 186);
        Theme.Accent = Color.FromArgb(245, 163, 0);      // hổ phách (mặt trời)
        Theme.Teal = Color.FromArgb(76, 180, 234);
        SolutionHost.Name = "solar";
        SolutionHost.Title = "Solar";
        SolutionHost.ExtraPage = app => ("☀", "Năng lượng", new SolarPage(app) { Dock = DockStyle.Fill });
    }
}
