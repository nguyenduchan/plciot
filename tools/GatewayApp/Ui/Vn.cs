using System.Globalization;
using System.Text;

namespace GatewayApp.Ui;

/// <summary>Hỗ trợ tiếng Việt: tên/nhãn hiển thị là Unicode đầy đủ; MÃ (thiết bị, field, khoá MQTT) là ASCII nên sinh từ tên bằng cách bỏ dấu.</summary>
static class Vn
{
    /// <summary>"Bồn nước số 1" → "bon_nuoc_so_1" (bỏ dấu, đ→d, ký tự lạ → "_", gọn "_" thừa), tối đa <paramref name="max"/> ký tự. Rỗng nếu không còn gì.</summary>
    public static string Slug(string? text, int max = 48, bool allowDash = false)
    {
        var d = (text ?? "").Trim().Normalize(NormalizationForm.FormD);
        var b = new StringBuilder(d.Length);
        foreach (var c in d)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            var x = c switch { 'đ' => 'd', 'Đ' => 'D', _ => c };
            if (x < 128 && (char.IsLetterOrDigit(x) || x == '_' || (allowDash && x == '-'))) b.Append(char.ToLowerInvariant(x));
            else if (b.Length > 0 && b[^1] != '_') b.Append('_');
        }
        var s = b.ToString().Trim('_');
        return s.Length > max ? s[..max].TrimEnd('_') : s;
    }
}
