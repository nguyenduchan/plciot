using System.IO.Ports;
using System.Text.Json;
using Microsoft.Win32;

namespace GatewayApp;

/// <summary>
/// Cài Wi-Fi cho board qua CÁP USB (cổng COM của ESP32-S3, VID_303A): PC giữ nguyên mạng, không phải nối vào hotspot.
/// Giao thức dòng JSON của firmware (serialcfg.cpp): gửi {"cmd":"wifi.set","Ssid":..,"Password":..}, board trả "@@{...}".
/// </summary>
static class SerialBoard
{
    /// <summary>Cổng COM của board ESP32-S3 đang cắm (VID_303A, USB-Serial/JTAG); null nếu không có.</summary>
    public static string? FindPort()
    {
        var present = SerialPort.GetPortNames().ToHashSet(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var usb = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB");
            if (usb == null) return null;
            foreach (var dev in usb.GetSubKeyNames().Where(n => n.StartsWith("VID_303A", StringComparison.OrdinalIgnoreCase)))
            {
                using var d = usb.OpenSubKey(dev);
                foreach (var inst in d?.GetSubKeyNames() ?? Array.Empty<string>())
                {
                    using var dp = d!.OpenSubKey($@"{inst}\Device Parameters");
                    if (dp?.GetValue("PortName") is string pn && present.Contains(pn)) return pn;
                }
            }
        }
        catch (Exception) { }
        return null;
    }

    static JsonDocument Request(SerialPort sp, string json, int timeoutMs)
    {
        sp.DiscardInBuffer();
        sp.Write(json + "\n");
        var t0 = Environment.TickCount64;
        while (Environment.TickCount64 - t0 < timeoutMs)
        {
            string line;
            try { line = sp.ReadLine(); } catch (TimeoutException) { continue; }
            line = line.Trim();
            var i = line.IndexOf("@@{", StringComparison.Ordinal);
            if (i >= 0) return JsonDocument.Parse(line[(i + 2)..]);
        }
        throw new TimeoutException("Board không trả lời qua cáp USB.");
    }

    /// <summary>Gửi Wi-Fi cho board. Trả (IP Wi-Fi của board, null) khi nối được; (null, mã lỗi) khi thất bại. Mật khẩu không ghi log.</summary>
    public static Task<(string? Ip, string? Err)> SetWifiAsync(string port, string ssid, string password, Action<string> say) => Task.Run<(string?, string?)>(() =>
    {
        using var sp = new SerialPort(port, 115200) { DtrEnable = false, RtsEnable = false, ReadTimeout = 500, WriteTimeout = 2000, NewLine = "\n" };
        sp.Open();
        say("Đang kết nối board qua cáp USB…");
        JsonDocument? hello = null;
        for (var k = 0; k < 8 && hello == null; k++)   // mở cổng có thể làm board khởi động lại: chờ tới khi nó trả lời
        {
            try { hello = Request(sp, "{\"cmd\":\"info\"}", 1500); } catch (TimeoutException) { Thread.Sleep(800); }
        }
        if (hello == null) return (null, "usb_no_reply");
        using (hello) say($"Board {hello.RootElement.GetProperty("Version").GetString()} — đang gửi Wi-Fi \"{ssid}\" (tối đa 20 giây)…");
        using var r = Request(sp, JsonSerializer.Serialize(new { cmd = "wifi.set", Ssid = ssid, Password = password }), 30000);
        var root = r.RootElement;
        if (root.GetProperty("Ok").GetBoolean())
        {
            var ip = root.TryGetProperty("Wifi", out var w) && w.TryGetProperty("Ip", out var ipv) ? ipv.GetString() : "";
            return (string.IsNullOrEmpty(ip) ? null : ip, string.IsNullOrEmpty(ip) ? "wifi_timeout" : null);
        }
        return (null, root.TryGetProperty("Err", out var e) ? e.GetString() : "unknown");
    });
}
