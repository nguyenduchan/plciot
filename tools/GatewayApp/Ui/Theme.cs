using System.Drawing.Drawing2D;

namespace GatewayApp.Ui;

/// <summary>Bảng màu + font dùng chung (nền tối kiểu Grafana, chữ Segoe UI). Chỉ dùng GDI+ của .NET — chạy hoàn toàn offline.</summary>
static class Theme
{
    public static readonly Color Bg = Color.FromArgb(17, 18, 23);
    public static readonly Color Side = Color.FromArgb(13, 14, 18);
    public static readonly Color Panel = Color.FromArgb(24, 27, 31);
    public static readonly Color Panel2 = Color.FromArgb(32, 36, 41);
    public static readonly Color Border = Color.FromArgb(44, 50, 53);
    public static readonly Color Text = Color.FromArgb(216, 217, 218);
    public static readonly Color Muted = Color.FromArgb(139, 148, 158);
    public static readonly Color Accent = Color.FromArgb(50, 116, 217);
    public static readonly Color Green = Color.FromArgb(115, 191, 105);
    public static readonly Color Yellow = Color.FromArgb(242, 204, 12);
    public static readonly Color Red = Color.FromArgb(242, 73, 92);
    public static readonly Color Teal = Color.FromArgb(31, 186, 214);

    public static readonly Font Small = new("Segoe UI", 8.5f);
    public static readonly Font Normal = new("Segoe UI", 10f);
    public static readonly Font Semi = new("Segoe UI Semibold", 10f);
    public static readonly Font Title = new("Segoe UI Semibold", 11f);
    public static readonly Font Big = new("Segoe UI Semibold", 20f);
    public static readonly Font Huge = new("Segoe UI Semibold", 26f);
    public static readonly Font Mono = new("Consolas", 9f);

    public static GraphicsPath Round(RectangleF r, float radius)
    {
        var d = radius * 2;
        var p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static void Quality(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
    }

    public static Color Mix(Color a, Color b, double t) => Color.FromArgb(
        (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));

    /// <summary>Làm tròn đẹp để hiện số: 12 → "12", 12.345 → "12.3".</summary>
    public static string Num(double v) => Math.Abs(v) >= 100 ? v.ToString("0") : Math.Abs(v) >= 10 ? v.ToString("0.#") : v.ToString("0.##");
}
