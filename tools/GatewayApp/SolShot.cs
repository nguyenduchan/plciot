using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Chụp giao diện GIẢI PHÁP để rà soát (--solshot THƯ_MỤC, dữ liệu thật từ PlcSim): cần file giao diện (*.skin.json cạnh GATEWAYAPP_SETTINGS).
/// Ghi window.png (cả cửa sổ như người dùng thấy) và page.png (toàn bộ trang giải pháp, đủ chiều cao, không bị cắt bởi thanh cuộn).
/// </summary>
public sealed partial class MainForm
{
    /// <summary>--iconsheet FILE.png: vẽ toàn bộ icon (đại lượng đo + thiết bị) thành một bảng để so với webapp.</summary>
    internal static void IconSheet(string file)
    {
        var ids = IconData.Q.Keys.Select(k => ("q", k)).Concat(IconData.Device.Keys.Select(k => ("d", k))).ToList();
        const int cell = 96, cols = 12;
        var rows = (ids.Count + cols - 1) / cols;
        using var bmp = new Bitmap(cols * cell, rows * cell);
        using var g = Graphics.FromImage(bmp);
        Theme.Quality(g); g.Clear(Theme.Bg);
        for (var i = 0; i < ids.Count; i++)
        {
            var (kind, id) = ids[i]; var x = i % cols * cell; var y = i / cols * cell;
            var c = kind == "q" ? Theme.Teal : Theme.Yellow;
            Icons.Badge(g, id, new RectangleF(x + 22, y + 8, 52, 52), c, 12, 46, kind == "d");
            TextRenderer.DrawText(g, id, Theme.Small, new Rectangle(x, y + 64, cell, 20), Theme.Muted, TextFormatFlags.HorizontalCenter);
        }
        bmp.Save(file);
    }

    public async Task SolShotAsync(string dir)
    {
        Directory.CreateDirectory(dir);
        WindowState = FormWindowState.Normal; Size = new Size(1400, 860);
        await Task.Delay(7000);
        Show(_pages[0].Page); Tick();
        await Task.Delay(800);
        using (var bmp = new Bitmap(Width, Height))
        {
            DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
            bmp.Save(Path.Combine(dir, "window.png"));
        }
        if (FindAll<IndustryPage>(this).FirstOrDefault() is { } ip && ip.Width > 0 && ip.Height > 0)
        {
            using var bmp = new Bitmap(ip.Width, ip.Height);
            ip.DrawToBitmap(bmp, new Rectangle(0, 0, ip.Width, ip.Height));
            bmp.Save(Path.Combine(dir, "page.png"));
        }
        var miss = FindAll<IndustryPage>(this).FirstOrDefault()?.UnfilledMetrics() ?? new List<string>();
        File.WriteAllText(Path.Combine(dir, "state.txt"), $"running={Running} missing={miss.Count} [{string.Join(",", miss)}] toast={LastToast.Text}");
        Close();
    }
}
