using System.Runtime.CompilerServices;
using System.Text.Json;

namespace GatewayApp.Ui;

/// <summary>
/// Giao diện theo GIẢI PHÁP của gateway là DỮ LIỆU, không phải mã: một bản GatewayApp dùng chung cho mọi khách.
/// Admin chọn giải pháp khi phát mã ghép cặp → server trả <c>ui</c> (bảng màu + cấu hình các khối hiển thị + công thức) trong kit lúc Enroll /
/// cập nhật cấu hình → lưu cạnh file cấu hình (<c>*.skin.json</c>) → áp dụng khi mở lại gateway (bảng màu phải có trước khi dựng cửa sổ).
/// Không có file (hoặc đặt GATEWAYAPP_NOSKIN=1) → bản cơ bản, đúng như trước. Mọi tính năng khác của gateway không đổi.
/// </summary>
static class SkinStore
{
    public static string PathFor => MainForm.SettingsPath + ".skin.json";

    static Color Hex(JsonElement p, string k, Color d)
    {
        if (!p.TryGetProperty(k, out var v) || v.GetString() is not { Length: 7 } h || h[0] != '#') return d;
        try { return Color.FromArgb(Convert.ToInt32(h[1..3], 16), Convert.ToInt32(h[3..5], 16), Convert.ToInt32(h[5..7], 16)); } catch (FormatException) { return d; }
    }

    [ModuleInitializer]
    internal static void Boot()
    {
        try
        {
            if (Environment.GetEnvironmentVariable("GATEWAYAPP_NOSKIN") == "1") return;
            var path = PathFor;
            if (!File.Exists(path)) return;
            var root = JsonDocument.Parse(File.ReadAllText(path)).RootElement.Clone();
            var spec = root.GetProperty("spec"); var pal = root.GetProperty("palette");
            var bg = Hex(pal, "bg", Theme.Bg); var card = Hex(pal, "card", Theme.Panel); var line = Hex(pal, "line", Theme.Border); var acc = Hex(pal, "acc", Theme.Accent);
            // đổi màu TRƯỚC khi bất kỳ điều khiển nào được dựng (module initializer chạy trước Main)
            Theme.Bg = bg; Theme.Side = Theme.Mix(bg, Color.Black, 0.3); Theme.Panel = card; Theme.Panel2 = Theme.Mix(card, line, 0.45); Theme.Border = line;
            Theme.Text = Hex(pal, "fg", Theme.Text); Theme.Muted = Hex(pal, "mut", Theme.Muted); Theme.Accent = acc; Theme.Teal = Theme.Mix(acc, Color.White, 0.25);
            var id = root.TryGetProperty("id", out var i) ? i.GetString() ?? "" : "";
            var name = root.TryGetProperty("short", out var s) ? s.GetString() ?? id : id;
            var glyph = root.TryGetProperty("glyph", out var g) ? g.GetString() ?? "▦" : "▦";
            var specJson = spec.GetRawText();
            SolutionHost.Name = id; SolutionHost.Title = name;
            SolutionHost.ExtraPage = app => (glyph, name, new IndustryPage(app, specJson) { Dock = DockStyle.Fill });
        }
        catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException) { /* file hỏng → bản cơ bản */ }
    }

    /// <summary>Lưu giao diện server gửi (kit.Solution + kit.Ui). Trả (có đổi, tên giao diện mới; rỗng = về bản cơ bản).</summary>
    public static (bool Changed, string Title) Save(string? solution, JsonElement? ui)
    {
        try
        {
            var path = PathFor;
            if (string.IsNullOrEmpty(solution))
            {
                if (!File.Exists(path)) return (false, "");
                File.Delete(path); return (true, "");
            }
            if (ui is not { ValueKind: JsonValueKind.Object } u) return (false, "");   // server chưa có giao diện cho giải pháp này: giữ nguyên
            var text = u.GetRawText();
            if (File.Exists(path) && File.ReadAllText(path) == text) return (false, "");
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
            File.WriteAllText(path, text);
            return (true, u.TryGetProperty("title", out var t) ? t.GetString() ?? solution : solution);
        }
        catch (IOException) { return (false, ""); }
    }
}
