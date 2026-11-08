using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GatewayProvisioner;

/// <summary>Cấu hình lưu trong %APPDATA%; token mã hoá bằng DPAPI (chỉ tài khoản Windows này đọc được).</summary>
public sealed class Settings
{
    public string Vps { get; set; } = "https://plc.dieukhientudong.net";
    public string Gateway { get; set; } = "";
    public bool Activate { get; set; } = false;
    public string Kind { get; set; } = "mcu";
    public bool Offline { get; set; } = false;
    public string Site { get; set; } = "";
    public string Device { get; set; } = "gw01";
    public string Profile { get; set; } = "generic";
    public int Days { get; set; } = 0;
    public string TokenProtected { get; set; } = "";

    static string PathFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "GatewayProvisioner", "settings.json");

    public static Settings Load()
    {
        try { return JsonSerializer.Deserialize<Settings>(File.ReadAllText(PathFile)) ?? new(); } catch { return new(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(PathFile)!);
        File.WriteAllText(PathFile, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public string GetToken()
    {
        if (TokenProtected.Length == 0) return "";
        try
        {
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(
                Convert.FromBase64String(TokenProtected), null, DataProtectionScope.CurrentUser));
        }
        catch { return ""; }
    }

    public void SetToken(string token) =>
        TokenProtected = token.Length == 0 ? "" : Convert.ToBase64String(ProtectedData.Protect(
            Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));
}

static class Program
{
    [STAThread]
    static async Task<int> Main(string[] args)
    {
        if (args.Length > 0) return await Headless(args);
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }

    /// <summary>Chạy không giao diện (script / test): --vps --token --link --site --device [--request] [--activate true|false] [--kind mcu|pc|generic] [--offline true|false] [--profile] [--days]
    /// Token có thể truyền bằng biến môi trường GP_TOKEN. Thoát 0 nếu thành công.</summary>
    static async Task<int> Headless(string[] args)
    {
        // Xuất UTF-8 thẳng ra stdout (đặt Console.OutputEncoding bị lỗi khi chạy WinExe qua pipe).
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        var a = new Dictionary<string, string>();
        for (var i = 0; i + 1 < args.Length; i += 2) a[args[i].TrimStart('-')] = args[i + 1];
        string G(string k, string d = "") => a.TryGetValue(k, out var v) ? v : d;
        var s = Settings.Load();
        var o = new Options(
            G("vps", s.Vps), G("token", Environment.GetEnvironmentVariable("GP_TOKEN") ?? s.GetToken()),
            G("link", G("gateway", s.Gateway)), G("site", s.Site), G("device", s.Device),
            G("profile", s.Profile), int.TryParse(G("days", "0"), out var d) ? d : 0, G("request"),
            G("activate", s.Activate ? "true" : "false").Equals("true", StringComparison.OrdinalIgnoreCase),
            a.ContainsKey("kind") ? G("kind") : null,
            G("offline", "false").Equals("true", StringComparison.OrdinalIgnoreCase));
        var r = await Provisioner.RunAsync(o, m => Console.WriteLine(m));
        Console.WriteLine((r.Ok ? "OK: " : "LOI: ") + r.Message);
        return r.Ok ? 0 : 1;
    }
}
