using Plciot.Scada;
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
    public static string PathFor => (Environment.GetEnvironmentVariable("GATEWAYAPP_SETTINGS") is { Length: > 0 } p ? p : ConfigStore.PathFor("gateway-app")) + ".skin.json";

    static Color Hex(JsonElement p, string k, Color d)
    {
        if (!p.TryGetProperty(k, out var v) || v.GetString() is not { Length: 7 } h || h[0] != '#') return d;
        try { return Color.FromArgb(Convert.ToInt32(h[1..3], 16), Convert.ToInt32(h[3..5], 16), Convert.ToInt32(h[5..7], 16)); } catch (FormatException) { return d; }
    }

    /// <summary>Màu mặc định (bản cơ bản), chụp trước khi bất kỳ giải pháp nào đổi màu — để quay về cơ bản khi đổi giải pháp lúc đang chạy.</summary>
    static (Color Bg, Color Side, Color Panel, Color Panel2, Color Border, Color Text, Color Muted, Color Accent, Color Teal)? _defaults;

    /// <summary>Nạp lại giao diện từ file đã lưu (gọi khi đổi giải pháp lúc gateway đang chạy, trước khi dựng cửa sổ mới).</summary>
    public static void Reload()
    {
        if (_defaults is { } d) { Theme.Bg = d.Bg; Theme.Side = d.Side; Theme.Panel = d.Panel; Theme.Panel2 = d.Panel2; Theme.Border = d.Border; Theme.Text = d.Text; Theme.Muted = d.Muted; Theme.Accent = d.Accent; Theme.Teal = d.Teal; }
        SolutionHost.Name = ""; SolutionHost.Title = ""; SolutionHost.Icon = ""; SolutionHost.Heading = ""; SolutionHost.ExtraPage = null; SolutionHost.Slots.Clear();
        Boot();
    }

    [ModuleInitializer]
    internal static void Boot()
    {
        _defaults ??= (Theme.Bg, Theme.Side, Theme.Panel, Theme.Panel2, Theme.Border, Theme.Text, Theme.Muted, Theme.Accent, Theme.Teal);
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
            // icon vector (icons.json); ui.json cũ chỉ có "glyph" → dùng icon trong spec
            var icon = root.TryGetProperty("icon", out var ic) && Icons.Has(ic.GetString()) ? ic.GetString()! : spec.TryGetProperty("icon", out var si) && Icons.Has(si.GetString()) ? si.GetString()! : "grid";
            var specJson = spec.GetRawText();
            // ô sơ đồ: chỉ số đọc trực tiếp từ field (bỏ chỉ số suy diễn bằng công thức — không gắn field vào được)
            SolutionHost.Slots.Clear();
            if (spec.TryGetProperty("metrics", out var ms))
                foreach (var m in ms.EnumerateArray())
                {
                    if (m.TryGetProperty("expr", out var ex) && ex.ValueKind == JsonValueKind.String && ex.GetString()!.Length > 0) continue;
                    var mid = m.TryGetProperty("id", out var mi) ? mi.GetString() ?? "" : "";
                    var keys = m.TryGetProperty("keys", out var ks) ? ks.EnumerateArray().Select(k => (k.ValueKind == JsonValueKind.Array ? k[0].GetString() : k.GetString()) ?? "").Where(k => k.Length > 0).ToArray() : new[] { mid };
                    if (keys.Length == 0) continue;
                    SolutionHost.Slots.Add((m.TryGetProperty("label", out var l) ? l.GetString() ?? mid : mid, m.TryGetProperty("unit", out var u) ? u.GetString() ?? "" : "", keys));
                }
            SolutionHost.Name = id; SolutionHost.Title = name; SolutionHost.Icon = icon;
            SolutionHost.Heading = spec.TryGetProperty("heading", out var hd) && hd.GetString() is { Length: > 0 } h1 ? h1 : root.TryGetProperty("title", out var tt) ? tt.GetString() ?? name : name;
            SolutionHost.ExtraPage = app => (icon, name, new IndustryPage(app, specJson) { Dock = DockStyle.Fill });
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
