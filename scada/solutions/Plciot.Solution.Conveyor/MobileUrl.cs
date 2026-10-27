using System.IO;

namespace Plciot.Solution.Conveyor;

/// <summary>
/// Địa chỉ webapp cho điện thoại. Mặc định là tên miền qua Cloudflare Tunnel; đổi bằng cách ghi URL vào
/// <c>mobile-url.txt</c> cạnh config.json (không cần sửa mã khi chuyển domain/VPS).
/// </summary>
public static class MobileUrl
{
    public const string Default = "https://plc.dieukhientudong.net";

    public static string Resolve(string configPath)
    {
        try
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(configPath)) ?? ".";
            var f = Path.Combine(dir, "mobile-url.txt");
            if (File.Exists(f))
            {
                var t = File.ReadAllText(f).Trim();
                if (Uri.TryCreate(t, UriKind.Absolute, out var u) && (u.Scheme == "https" || u.Scheme == "http")) return t;
            }
        }
        catch (IOException) { }
        return Default;
    }
}
