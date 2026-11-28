using System.Text.Json;
using GatewayApp;

namespace GatewayAdmin;

static class Program
{
    /// <summary>Server mặc định; đổi bằng file admin.json {"Server":"https://…"} cạnh exe hoặc trong %LOCALAPPDATA%\PlciotGatewayAdmin.</summary>
    const string DefaultServer = "https://plc.dieukhientudong.net";

    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var key = AdminKey.LoadOrCreate();
#if DEBUG
        var pk = Array.IndexOf(args, "--printkey");   // ghi dòng lệnh đăng ký khoá máy này ra file (để đăng ký qua SSH khi kiểm thử)
        if (pk >= 0 && pk + 1 < args.Length) { File.WriteAllText(args[pk + 1], key.RegisterCommand); return; }
#endif
        var form = new AdminForm(key, ServerUrl());
#if DEBUG
        // Kiểm thử (chỉ bản Debug): --relaytest THƯ_MỤC --gw site/device → mở gateway qua cloud, đọc/ghi thật, ghi relaytest-result.txt
        var i = Array.IndexOf(args, "--relaytest");
        if (i >= 0 && i + 1 < args.Length)
        {
            var j = Array.IndexOf(args, "--gw");
            var gw = j >= 0 && j + 1 < args.Length ? args[j + 1] : "";
            form.Shown += async (_, _) => { await RelayTest.RunAsync(form, args[i + 1], gw); form.Close(); };
        }
        // --fieldtest THƯ_MỤC --gw site/device [--child c]: board Waveshare qua internet — xem toàn bộ cấu hình, sửa ở cửa sổ cài đặt + 📱 Cài đặt hiện trường
        var ft = Array.IndexOf(args, "--fieldtest");
        if (ft >= 0 && ft + 1 < args.Length)
        {
            string A(string n) { var x = Array.IndexOf(args, n); return x >= 0 && x + 1 < args.Length ? args[x + 1] : ""; }
            form.Shown += async (_, _) => { await FieldTest.RunAsync(form, args[ft + 1], A("--gw"), A("--child") is { Length: > 0 } ch ? ch : "invt-gd20"); form.Close(); };
        }
        // --rpcget KQ.txt --gw site/device --path /api/events: đọc một route GET của gateway qua relay cloud (cần "Hỗ trợ từ xa" bật)
        var rg = Array.IndexOf(args, "--rpcget");
        if (rg >= 0 && rg + 1 < args.Length)
        {
            string A(string n) { var x = Array.IndexOf(args, n); return x >= 0 && x + 1 < args.Length ? args[x + 1] : ""; }
            form.Shown += async (_, _) =>
            {
                var gw = A("--gw").Split('/');
                string text;
                try { var (st, body) = await form.Api.RpcAsync(gw[0], gw[1], "GET", A("--path"), ""); text = $"HTTP {st}" + Environment.NewLine + body; }
                catch (Exception e) { text = "FAIL " + AdminApi.Explain(e); }
                File.WriteAllText(args[rg + 1], text);
                form.Close();
            };
        }
        // --logicpropose KQ.txt --gw site/device --text-file FILE [--note "…"]: kiểm text + gửi đề xuất logic (đúng đường cửa sổ 📝 Logic)
        var lp = Array.IndexOf(args, "--logicpropose");
        if (lp >= 0 && lp + 1 < args.Length)
        {
            string A(string n) { var x = Array.IndexOf(args, n); return x >= 0 && x + 1 < args.Length ? args[x + 1] : ""; }
            form.Shown += async (_, _) =>
            {
                var outFile = args[lp + 1]; var lines = new List<string>();
                var gw = A("--gw").Split('/');
                try
                {
                    var text = File.ReadAllText(A("--text-file"));
                    using (var cur = JsonDocument.Parse(await form.Api.LogicAsync(gw[0], gw[1])))
                        lines.Add($"INFO loại {cur.RootElement.GetProperty("kind")} · đang chạy: {(cur.RootElement.GetProperty("current").ValueKind == JsonValueKind.Object ? "rev " + cur.RootElement.GetProperty("current").GetProperty("rev") : "chưa báo")}");
                    using (var chk = JsonDocument.Parse(await form.Api.LogicCheckAsync(gw[0], gw[1], text)))
                        lines.Add($"PASS kiểm text — thay đổi: {chk.RootElement.GetProperty("changed")}");
                    using var pr = JsonDocument.Parse(await form.Api.LogicProposeAsync(gw[0], gw[1], text, A("--note")));
                    lines.Add($"PASS gửi đề xuất #{pr.RootElement.GetProperty("id")}");
                }
                catch (Exception e) { lines.Add("FAIL " + AdminApi.Explain(e)); }
                File.WriteAllLines(outFile, lines);
                form.Close();
            };
        }
        // --templateput KQ.txt --file mau.json: mở 📚 Thiết bị mẫu, đưa JSON lên bảng rồi bấm Lưu (đúng đường kỹ sư lưu mẫu lên server)
        var tp = Array.IndexOf(args, "--templateput");
        if (tp >= 0 && tp + 1 < args.Length)
        {
            string A(string n) { var x = Array.IndexOf(args, n); return x >= 0 && x + 1 < args.Length ? args[x + 1] : ""; }
            form.Shown += async (_, _) =>
            {
                string text;
                try
                {
                    var tf = new TemplateForm(form.Api); tf.Show(form);
                    var res = await tf.SaveForTestAsync(System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(A("--file")))!.AsObject());
                    var all = await form.Api.TemplatesAsync();
                    text = (res.StartsWith("Đã lưu") ? "PASS " : "FAIL ") + res + Environment.NewLine + all;
                    tf.Close();
                }
                catch (Exception e) { text = "FAIL " + AdminApi.Explain(e); }
                File.WriteAllText(args[tp + 1], text);
                form.Close();
            };
        }
#endif
        Application.Run(form);
    }

    static string ServerUrl()
    {
        foreach (var f in new[] { Path.Combine(AppContext.BaseDirectory, "admin.json"), Path.Combine(AdminKey.Dir, "admin.json") })
        {
            try
            {
                if (!File.Exists(f)) continue;
                using var d = JsonDocument.Parse(File.ReadAllText(f));
                if (d.RootElement.TryGetProperty("Server", out var s) && s.GetString() is { Length: > 0 } url) return url;
            }
            catch (Exception e) when (e is IOException or JsonException) { }
        }
        return DefaultServer;
    }
}
