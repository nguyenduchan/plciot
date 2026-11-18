using System.Text.Json;
using GatewayApp.Ui;

namespace GatewayApp.Tests;

/// <summary>Gateway phải chọn CÙNG icon đại lượng đo như webapp (vector chung tools/solution-kit/icon-vectors.json, sinh bởi gen.py).</summary>
public class IconTests
{
    static string VectorsPath()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "tools", "solution-kit", "icon-vectors.json"))) d = d.Parent;
        return Path.Combine(d!.FullName, "tools", "solution-kit", "icon-vectors.json");
    }

    [Fact]
    public void Chung_vector_voi_webapp()
    {
        var arr = JsonDocument.Parse(File.ReadAllText(VectorsPath())).RootElement;
        var n = 0; var bad = new List<string>();
        foreach (var t in arr.EnumerateArray())
        {
            var m = t.GetProperty("m");
            string? S(string k) => m.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            var keys = m.TryGetProperty("keys", out var ks) ? ks.EnumerateArray().Select(k => k.ValueKind == JsonValueKind.Array ? k[0].GetString()! : k.GetString()!).ToList() : null;
            var map = m.TryGetProperty("map", out var mp) ? mp.EnumerateObject().Select(p => p.Value.GetString() ?? "").ToList() : null;
            var got = IconData.ForMetric(S("id"), S("label"), S("unit"), keys, map);
            var want = t.GetProperty("icon").GetString();
            if (got != want) bad.Add($"{S("label")} [{S("unit")}] → {got} (cần {want})");
            n++;
        }
        Assert.True(n >= 200);
        Assert.True(bad.Count == 0, string.Join("; ", bad));
    }

    [Theory]
    [InlineData("temp_c", "°C", "Nhiệt độ", "number", "temp")]
    [InlineData("hum", "%", "Độ ẩm", "gauge", "humidity")]
    [InlineData("level", "%", "Mức nước", "tank", "level")]
    [InlineData("p", "bar", "Áp suất", "gauge", "pressure")]
    [InlineData("run", "", "Bơm", "toggle", "pump")]
    [InlineData("on", "", "Van", "toggle", "valve")]
    [InlineData("kwh", "kWh", "Điện năng", "number", "energy")]
    [InlineData("a", "A", "Dòng điện", "gauge", "current")]
    [InlineData("hours", "h", "Giờ chạy", "number", "clock")]
    public void Field_thuong(string key, string unit, string label, string kind, string want) =>
        Assert.Equal(want, IconData.ForField(key, unit, label, kind));

    [Fact]
    public void Bo_dau_tieng_Viet() => Assert.Equal("do am dat", IconData.Norm("Độ ẩm đất"));
}
