using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace GatewayApp;

/// <summary>
/// Bản nháp ánh xạ cho gateway mua sẵn (no-code) từ bản tin của hãng: mọi giá trị số/bool (tối đa 32) thành field của MỘT thiết bị.
/// Định dạng ánh xạ: cloud/app/src/nocodeMap.js (server kiểm lại khi lưu). Chủ trạm sửa tên/đơn vị/widget rồi lưu.
/// </summary>
public static class NocodeDraft
{
    const int MaxFields = 32, MaxDepth = 8;
    static readonly Regex Seg = new("^[A-Za-z0-9_\\-:@$]{1,64}$");

    public static string FromRaw(string raw)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(raw); } catch (JsonException) { return Empty(); }
        var fields = new JsonArray();
        var used = new HashSet<string>();
        Walk(root, "$", 0, fields, used);
        return Wrap(fields);
    }

    public static string Empty() => Wrap(new JsonArray());

    /// <summary>
    /// Mẫu cho USR-M100 (2 relay + 2 DI trên thân máy): giám sát + điều khiển relay qua "rw_prot".
    /// Trên M100 phải đặt tên điểm đúng DO1, DO2, DI1, DI2 và mẫu báo dữ liệu <see cref="M100ReportTemplate"/>.
    /// </summary>
    public static string M100Template()
    {
        JsonObject Relay(int n) => new()
        {
            ["key"] = $"do{n}", ["lbl"] = $"Relay {n}", ["widget"] = "switch", ["writable"] = true,
            ["point"] = $"DO{n}", ["path"] = $"$.DO{n}", ["toggleMs"] = 3000,
        };
        JsonObject Input(int n) => new() { ["key"] = $"di{n}", ["lbl"] = $"Đầu vào {n}", ["widget"] = "led_status", ["path"] = $"$.DI{n}" };
        var map = new JsonObject
        {
            ["v"] = 1,
            ["mode"] = "object",
            ["control"] = "usr_rw_prot",
            ["devices"] = new JsonArray(new JsonObject
            {
                ["id"] = "m100", ["name"] = "USR-M100",
                ["fields"] = new JsonArray(Relay(1), Relay(2), Input(1), Input(2)),
            }),
        };
        return map.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    /// <summary>Mẫu JSON báo dữ liệu nhập vào M100 (mục Data report → template), khớp <see cref="M100Template"/>. Thêm "t":"sys_unix_time" khi đã bật NTP.</summary>
    public const string M100ReportTemplate = "{\"DO1\":\"DO1\",\"DO2\":\"DO2\",\"DI1\":\"DI1\",\"DI2\":\"DI2\"}";

    static string Wrap(JsonArray fields)
    {
        var map = new JsonObject
        {
            ["v"] = 1,
            ["mode"] = "object",
            ["devices"] = new JsonArray(new JsonObject { ["id"] = "thiet_bi_1", ["name"] = "Thiết bị 1", ["fields"] = fields }),
        };
        return map.ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
    }

    static void Walk(JsonNode? v, string path, int depth, JsonArray fields, HashSet<string> used)
    {
        if (fields.Count >= MaxFields || depth > MaxDepth || v is null) return;
        switch (v)
        {
            case JsonArray a:
                for (var i = 0; i < a.Count && i < MaxFields; i++) Walk(a[i], $"{path}[{i}]", depth + 1, fields, used);
                return;
            case JsonObject o:
                foreach (var (k, child) in o) Walk(child, path + (Seg.IsMatch(k) ? "." + k : $"['{k.Replace("'", "")}']"), depth + 1, fields, used);
                return;
            case JsonValue val:
                if (!IsNumeric(val)) return;
                var key = KeyOf(path, used);
                fields.Add(new JsonObject { ["key"] = key, ["lbl"] = key, ["widget"] = "kpi", ["path"] = path });
                return;
        }
    }

    static bool IsNumeric(JsonValue v)
    {
        var e = v.GetValue<JsonElement>();
        return e.ValueKind switch
        {
            JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False => true,
            JsonValueKind.String => double.TryParse(e.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out _),
            _ => false,
        };
    }

    static string KeyOf(string path, HashSet<string> used)
    {
        var k = Regex.Replace(Regex.Replace(path.TrimStart('$').TrimStart('.'), "[^A-Za-z0-9_]", "_"), "_+", "_").Trim('_');
        if (k.Length == 0) k = "v";
        if (k.Length > 32) k = k[..32];
        var n = k; var i = 2;
        while (!used.Add(n)) n = $"{(k.Length > 29 ? k[..29] : k)}_{i++}";
        return n;
    }
}
