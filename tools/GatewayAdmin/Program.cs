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
