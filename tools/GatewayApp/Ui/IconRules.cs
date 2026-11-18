using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace GatewayApp.Ui;

/// <summary>
/// Chọn icon ĐẠI LƯỢNG ĐO cho một chỉ số / field — cùng luật với webapp (PlcQIcons.forMetric, sinh từ tools/solution-kit/icons.json).
/// Kiểm tra chéo bằng tools/solution-kit/icon-vectors.json (GatewayApp.Tests). Không phụ thuộc WinForms.
/// </summary>
static partial class IconData
{
    static string Strip(string? s)
    {
        var d = (s ?? "").ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var b = new StringBuilder(d.Length);
        foreach (var c in d) if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) b.Append(c == 'đ' ? 'd' : c);
        return b.ToString();
    }

    static readonly Regex NonAlnum = new("[^a-z0-9]+", RegexOptions.CultureInvariant);
    static readonly Regex Ws = new(@"\s+", RegexOptions.CultureInvariant);

    /// <summary>Nhãn/khoá: thường, bỏ dấu, đ→d, ký tự khác chữ/số → một khoảng trắng.</summary>
    public static string Norm(string? s) => NonAlnum.Replace(Strip(s), " ").Trim();
    /// <summary>Đơn vị: thường, bỏ dấu, bỏ khoảng trắng (giữ ° ³ µ / %).</summary>
    public static string UNorm(string? s) => Ws.Replace(Strip(s), "");

    /// <summary>Mã icon cho chỉ số {id, nhãn, đơn vị, các khoá field, bảng chữ trạng thái}. Không khớp luật nào → "chart".</summary>
    public static string ForMetric(string? id, string? label, string? unit, IEnumerable<string>? keys, IEnumerable<string>? mapValues)
    {
        var mv = mapValues?.ToList();
        var f = new Dictionary<string, string>
        {
            ["label"] = Norm(label),
            ["key"] = Norm(string.Join(" ", keys ?? Array.Empty<string>())),
            ["unit"] = UNorm(unit),
            ["map"] = Norm(string.Join(" ", mv ?? new List<string>())),
        };
        f["any"] = string.Join(" ", new[] { f["label"], f["key"], Norm(id) }.Where(x => x.Length > 0));
        f["state"] = mv != null ? f["any"] : "";
        foreach (var (field, re, icon) in Rules)
            if (f.TryGetValue(field, out var v) && v.Length > 0 && re.IsMatch(v)) return icon;
        return "chart";
    }

    /// <summary>Icon cho một field của thiết bị (widget thường): công tắc coi như chỉ số trạng thái.</summary>
    public static string ForField(string key, string? unit, string? label, string? kind) =>
        ForMetric(key, label, unit, new[] { key }, kind == "toggle" ? new[] { "tắt", "bật" } : null);
}
