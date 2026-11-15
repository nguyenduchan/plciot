using System.Text.Json;
using GatewayApp.Ui;

namespace GatewayApp.Tests;

/// <summary>Bộ tính công thức của gateway phải cho CÙNG kết quả với bản JS của webapp (vector chung tools/solution-kit/expr-vectors.json).</summary>
public class ExprTests
{
    static string VectorsPath()
    {
        var d = new DirectoryInfo(AppContext.BaseDirectory);
        while (d != null && !File.Exists(Path.Combine(d.FullName, "tools", "solution-kit", "expr-vectors.json"))) d = d.Parent;
        return Path.Combine(d!.FullName, "tools", "solution-kit", "expr-vectors.json");
    }

    [Fact]
    public void Chung_vector_voi_webapp()
    {
        var arr = JsonDocument.Parse(File.ReadAllText(VectorsPath())).RootElement;
        var n = 0; var bad = new List<string>();
        foreach (var t in arr.EnumerateArray())
        {
            var vars = t.GetProperty("vars").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetDouble());
            var got = Expr.Eval(t.GetProperty("expr").GetString()!, k => vars.TryGetValue(k, out var v) ? v : null);
            double? want = t.GetProperty("expect").ValueKind == JsonValueKind.Null ? null : t.GetProperty("expect").GetDouble();
            var ok = want == null ? got == null : got != null && Math.Abs(got.Value - want.Value) < 1e-9;
            if (!ok) bad.Add($"{t.GetProperty("expr").GetString()} → {got?.ToString() ?? "null"} (cần {want?.ToString() ?? "null"})");
            n++;
        }
        Assert.True(n >= 40);
        Assert.True(bad.Count == 0, string.Join("; ", bad));
    }

    [Fact]
    public void Kiem_cu_phap()
    {
        Assert.Null(Expr.Check("min(a,b)/c*100"));
        Assert.NotNull(Expr.Check("1 +"));
        Assert.NotNull(Expr.Check("(1"));
    }
}
