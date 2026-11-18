using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PlcSim;

/// <summary>
/// Giải pháp (cùng danh sách với gateway: thư mục <c>solutions/&lt;id&gt;/gateway</c>) → bộ luồng dữ liệu PlcSim đúng thiết bị/field
/// mà giao diện giải pháp cần (setup.json) với giá trị sinh theo bộ mẫu của spec (ui.json → spec.demo), giống tools/solution-kit/lab.py.
/// Mỗi field: Modbus TCP, REAL (2 word) từ D50, hệ số 1; field điều khiển được (công tắc) đọc/ghi + giá trị cố định để lệnh ghi giữ nguyên.
/// Cũng dựng cấu hình GatewayApp THỬ riêng cho giải pháp (Pack khớp D, giao diện = ui.json) để mở gateway đọc thẳng PlcSim.
/// </summary>
static class SolutionKit
{
    public sealed record Info(string Id, string Title, string Dir);

    /// <summary>Thư mục solutions/: biến môi trường PLCSIM_SOLUTIONS, hoặc đi ngược từ thư mục chạy tới gốc repo.</summary>
    public static string? Root()
    {
        if (Environment.GetEnvironmentVariable("PLCSIM_SOLUTIONS") is { Length: > 0 } env && Directory.Exists(env)) return env;
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var s = Path.Combine(d.FullName, "solutions");
            if (Directory.Exists(s) && Directory.EnumerateDirectories(s).Any(x => File.Exists(Path.Combine(x, "gateway", "setup.json")))) return s;
        }
        return null;
    }

    public static List<Info> List()
    {
        var root = Root(); var list = new List<Info>();
        if (root == null) return list;
        foreach (var dir in Directory.EnumerateDirectories(root).OrderBy(x => x, StringComparer.Ordinal))
        {
            var id = Path.GetFileName(dir);
            if (id.StartsWith('_') || !File.Exists(Path.Combine(dir, "gateway", "setup.json")) || !File.Exists(Path.Combine(dir, "gateway", "ui.json"))) continue;
            var title = id;
            try { using var j = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "gateway", "ui.json"))); title = j.RootElement.GetProperty("title").GetString() ?? id; }
            catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException) { }
            list.Add(new Info(id, title, dir));
        }
        return list;
    }

    /// <summary>Một luồng dữ liệu sinh từ giải pháp.</summary>
    public sealed record Row(string Child, string Title, string Field, string Label, string Unit, string Widget, double Value, int Addr, PlcModel.Gen Gen, bool Writable, double? Min, double? Max, string On, string Off);

    public const int FirstAddr = 50;

    /// <summary>Đọc setup.json (thiết bị + field) và ui.json (bộ sinh mẫu) của giải pháp.</summary>
    public static List<Row> Build(Info s)
    {
        using var setup = JsonDocument.Parse(File.ReadAllText(Path.Combine(s.Dir, "gateway", "setup.json")));
        using var ui = JsonDocument.Parse(File.ReadAllText(Path.Combine(s.Dir, "gateway", "ui.json")));
        var demo = ui.RootElement.GetProperty("spec").TryGetProperty("demo", out var dm) && dm.TryGetProperty("devices", out var dd) ? dd : default;
        var rows = new List<Row>(); var addr = FirstAddr;
        foreach (var dv in setup.RootElement.GetProperty("devices").EnumerateArray())
        {
            var id = dv.GetProperty("id").GetString()!; var title = Str(dv, "name", id);
            var gens = demo.ValueKind == JsonValueKind.Object && demo.TryGetProperty(id, out var dj) && dj.TryGetProperty("f", out var fj) ? fj : default;
            foreach (var f in dv.GetProperty("fields").EnumerateArray())
            {
                var key = f.GetProperty("key").GetString()!;
                var writable = f.TryGetProperty("writable", out var w) && w.ValueKind == JsonValueKind.True;
                var (gen, val) = GenOf(gens.ValueKind == JsonValueKind.Object && gens.TryGetProperty(key, out var g) ? g : default);
                if (writable) gen = new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 1);   // lệnh ghi từ gateway/webapp phải giữ nguyên, không bị bộ sinh đè
                rows.Add(new Row(id, title, key, Str(f, "lbl", key), Str(f, "unit", ""), Str(f, "widget", "kpi"), val, addr, gen, writable,
                    Dbl(f, "min"), Dbl(f, "max"), Str(f, "on", ""), Str(f, "off", "")));
                addr += 2;
                if (addr + 2 > PlcModel.Size) return rows;   // hết 300 thanh ghi D
            }
        }
        return rows;
    }

    static string Str(JsonElement e, string k, string d) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? d : d;
    static double? Dbl(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    /// <summary>Bộ sinh mẫu của spec → chế độ PlcSim. Xung vuông (sq) lấy trạng thái chiếm phần lớn chu kỳ; bộ đếm (cnt) → tăng dần.</summary>
    static (PlcModel.Gen Gen, double Value) GenOf(JsonElement g)
    {
        switch (g.ValueKind)
        {
            case JsonValueKind.Number: return (new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), g.GetDouble());
            case JsonValueKind.Array when g.GetArrayLength() >= 2:
            {
                var b = g[0].GetDouble(); var a = Math.Abs(g[1].GetDouble()); var per = g.GetArrayLength() > 2 ? g[2].GetDouble() : 60;
                return (new PlcModel.Gen(PlcModel.FieldMode.Sine, b - a, b + a, per), b);
            }
            case JsonValueKind.Object:
                if (g.TryGetProperty("sin", out var s) && s.GetArrayLength() >= 2)
                {
                    var b = s[0].GetDouble(); var a = Math.Abs(s[1].GetDouble()); var per = s.GetArrayLength() > 2 ? s[2].GetDouble() : 60;
                    return (new PlcModel.Gen(PlcModel.FieldMode.Sine, b - a, b + a, per), b);
                }
                if (g.TryGetProperty("sq", out var q) && q.GetArrayLength() >= 2)
                {
                    var duty = g.TryGetProperty("duty", out var du) && du.ValueKind == JsonValueKind.Number ? du.GetDouble() : 0.7;
                    return (new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 1), duty >= 0.5 ? q[1].GetDouble() : q[0].GetDouble());
                }
                if (g.TryGetProperty("cnt", out var c) && c.ValueKind == JsonValueKind.Number)
                {
                    var st = g.TryGetProperty("start", out var sv) && sv.ValueKind == JsonValueKind.Number ? sv.GetDouble() : 0; var r = c.GetDouble();
                    return (new PlcModel.Gen(PlcModel.FieldMode.Ramp, st, st + Math.Max(1, r * 3600 * 24), 60, Math.Max(r, 0.01)), st);
                }
                break;
        }
        return (new PlcModel.Gen(PlcModel.FieldMode.Fixed, 0, 100), 0);
    }

    // ------------------------------------------------------------------ cấu hình GatewayApp thử
    static readonly Dictionary<string, string> Kind = new() { ["gauge"] = "gauge", ["switch"] = "toggle", ["kpi"] = "number", ["led"] = "number", ["tank"] = "tank" };

    /// <summary>
    /// Ghi (hoặc cập nhật) cấu hình GatewayApp thử của giải pháp vào thư mục riêng: Pack + kết nối Modbus TCP tới PlcSim, giải pháp, giao diện (ui.json).
    /// Giữ nguyên mọi thứ khác đã có trong file (đăng ký cloud, mật khẩu cục bộ…) để lần sau mở lại vẫn như cũ. Trả đường dẫn config.json.
    /// </summary>
    public sealed record PackRow(string Child, string Field, int Addr, double Scale, PlcModel.Access Access, PlcModel.DataType Type);

    public static string WriteGatewayProfile(Info s, IReadOnlyList<Row> rows, IReadOnlyList<PackRow> packRows, string dir, string host, int port)
    {
        Directory.CreateDirectory(dir);
        var cfgPath = Path.Combine(dir, "config.json");
        JsonObject cfg;
        try { cfg = File.Exists(cfgPath) ? JsonNode.Parse(File.ReadAllText(cfgPath)) as JsonObject ?? new JsonObject() : new JsonObject(); }
        catch (JsonException) { cfg = new JsonObject(); }
        void Def(string k, JsonNode v) { if (!cfg.ContainsKey(k)) cfg[k] = v; }
        Def("Site", "plcsim"); Def("Device", s.Id.Length <= 40 ? s.Id : s.Id[..40]); Def("PollMs", 500); Def("Mobile", "Off");
        Def("LocalBrokerEnabled", false); Def("WebEnabled", false); Def("CloudTelemetryMinMs", 2000);
        cfg["Source"] = "ModbusTcp"; cfg["PlcHost"] = host; cfg["PlcPort"] = port; cfg["Solution"] = s.Id;
        cfg["Connections"] = new JsonArray(new JsonObject { ["Protocol"] = "ModbusTcp", ["Host"] = host, ["Port"] = port, ["Options"] = new JsonObject() });
        var pack = new JsonArray();
        var byKey = rows.ToDictionary(r => (r.Child, r.Field));
        foreach (var p in packRows)   // Pack theo đúng luồng đang có trong PlcSim (người dùng có thể đã đổi D/kiểu/hệ số)
        {
            byKey.TryGetValue((p.Child, p.Field), out var r);
            var w = p.Access != PlcModel.Access.Read;
            pack.Add(new JsonObject
            {
                ["Child"] = p.Child, ["Field"] = p.Field, ["MqttKey"] = "", ["Address"] = p.Addr, ["Scale"] = p.Scale,
                ["Min"] = w ? (r?.Min ?? 0) : null, ["Max"] = w ? (r?.Max ?? 1) : null,
                ["Protocol"] = "ModbusTcp", ["Access"] = p.Access.ToString(), ["DataType"] = p.Type.ToString(), ["WordSwap"] = false,
                ["Params"] = new JsonObject { ["unit"] = "1" }, ["Group"] = "", ["Enabled"] = true,
            });
        }
        cfg["Pack"] = pack;
        File.WriteAllText(cfgPath, cfg.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));

        // cách hiển thị (nhãn, đơn vị, kiểu widget) — chỉ ghi lần đầu hoặc khi bộ field đổi, để chỉnh sửa trên gateway được giữ
        var uiPath = Path.ChangeExtension(cfgPath, ".ui.json"); var sig = string.Join("|", packRows.Select(r => $"{r.Child}.{r.Field}"));
        var old = File.Exists(uiPath) ? File.ReadAllText(uiPath) : "";
        if (!old.Contains("\"PlcSimSig\": " + JsonSerializer.Serialize(sig)))
        {
            var fields = new JsonObject(); var devs = new JsonObject();
            foreach (var r in rows)
            {
                fields[$"{r.Child}.{r.Field}"] = new JsonObject
                {
                    ["Kind"] = Kind.GetValueOrDefault(r.Widget, "auto"), ["Unit"] = r.Unit, ["Title"] = r.Label, ["Min"] = r.Min, ["Max"] = r.Max,
                    ["OnText"] = r.On, ["OffText"] = r.Off, ["Low"] = null, ["High"] = null,
                };
                devs[r.Child] = new JsonObject { ["Title"] = r.Title, ["Template"] = "", ["Icon"] = "", ["Color"] = "" };
            }
            File.WriteAllText(uiPath, new JsonObject { ["Fields"] = fields, ["Devices"] = devs, ["PlcSimSig"] = sig }.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        }
        // giao diện giải pháp: đúng dữ liệu server gửi trong kit (ui.json) — GatewayApp đọc file *.skin.json cạnh cấu hình
        File.Copy(Path.Combine(s.Dir, "gateway", "ui.json"), cfgPath + ".skin.json", true);
        return cfgPath;
    }

    /// <summary>GatewayApp.exe: biến môi trường PLCSIM_GATEWAYAPP, hoặc bản build mới nhất trong tools/GatewayApp/bin của repo.</summary>
    public static string? GatewayExe()
    {
        if (Environment.GetEnvironmentVariable("PLCSIM_GATEWAYAPP") is { Length: > 0 } p && File.Exists(p)) return p;
        var root = Root(); if (root == null) return null;
        var bin = Path.Combine(Path.GetDirectoryName(root)!, "tools", "GatewayApp", "bin");
        if (!Directory.Exists(bin)) return null;
        return Directory.EnumerateFiles(bin, "GatewayApp.exe", SearchOption.AllDirectories).OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
    }

    public static Process? LaunchGateway(string exe, string cfgPath, IEnumerable<string> args)
    {
        var psi = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! };
        foreach (var a in args) psi.ArgumentList.Add(a);
        psi.Environment["GATEWAYAPP_SETTINGS"] = cfgPath;
        return Process.Start(psi);
    }

    public static string N(double d) => d.ToString(CultureInfo.InvariantCulture);
}
