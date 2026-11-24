using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace GatewayApp;

/// <summary>
/// Wi-Fi của CHÍNH PC này qua netsh (không cần quyền admin): đọc mạng đang nối, liệt kê profile đã lưu, quét hotspot PLCIOT-xxxx của board,
/// nối tạm vào hotspot rồi QUAY LẠI mạng cũ — để cài Wi-Fi cho board mà người dùng không phải tự đổi mạng và không mất mạng lâu.
/// </summary>
static class PcWifi
{
    static string Netsh(string args)
    {
        var psi = new ProcessStartInfo("netsh", args) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
        using var p = Process.Start(psi)!;
        var o = p.StandardOutput.ReadToEnd(); p.WaitForExit(15000);
        return o;
    }

    /// <summary>Tên Wi-Fi (SSID) PC đang nối; rỗng nếu không nối Wi-Fi.</summary>
    public static string CurrentSsid()
    {
        var m = Regex.Match(Netsh("wlan show interfaces"), @"^\s*SSID\s*:\s*(.+?)\s*$", RegexOptions.Multiline);
        return m.Success ? m.Groups[1].Value : "";
    }

    /// <summary>Tên các profile Wi-Fi đã lưu trên PC (để gợi ý ô chọn mạng).</summary>
    public static List<string> SavedProfiles()
        => Regex.Matches(Netsh("wlan show profiles"), @":\s*(.+?)\s*$", RegexOptions.Multiline).Select(m => m.Groups[1].Value).Where(s => s.Length > 0 && !s.StartsWith("<")).Distinct().ToList();

    /// <summary>Hotspot cài đặt của board đang thấy (PLCIOT-xxxx). Windows có thể không liệt kê (quyền vị trí) → danh sách rỗng.</summary>
    public static List<string> ScanHotspots()
        => Regex.Matches(Netsh("wlan show networks mode=bssid"), @"^\s*SSID\s+\d+\s*:\s*(PLCIOT-\S+)\s*$", RegexOptions.Multiline).Select(m => m.Groups[1].Value).Distinct().ToList();

    /// <summary>Nối vào hotspot mở của board (tạo profile tạm, kể cả khi Windows không liệt kê SSID).</summary>
    public static bool JoinOpen(string ssid)
    {
        var xml = $"<?xml version=\"1.0\"?><WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\"><name>{ssid}</name><SSIDConfig><SSID><name>{ssid}</name></SSID><nonBroadcast>true</nonBroadcast></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption></security></MSM></WLANProfile>";
        var f = Path.Combine(Path.GetTempPath(), $"plciot-{Guid.NewGuid():N}.xml");
        try
        {
            File.WriteAllText(f, xml, new UTF8Encoding(false));
            Netsh($"wlan add profile filename=\"{f}\"");
            return Netsh($"wlan connect name=\"{ssid}\"").Contains("success", StringComparison.OrdinalIgnoreCase);
        }
        finally { try { File.Delete(f); } catch (IOException) { } }
    }

    public static void Forget(string ssid) => Netsh($"wlan delete profile name=\"{ssid}\"");

    /// <summary>Nối lại mạng đã lưu (profile trùng tên SSID, hoặc theo ssid=).</summary>
    public static bool Rejoin(string ssid)
    {
        if (ssid.Length == 0) return false;
        var r = Netsh($"wlan connect name=\"{ssid}\"");
        if (r.Contains("success", StringComparison.OrdinalIgnoreCase)) return true;
        return Netsh($"wlan connect name=\"{ssid}\" ssid=\"{ssid}\"").Contains("success", StringComparison.OrdinalIgnoreCase);
    }
}
