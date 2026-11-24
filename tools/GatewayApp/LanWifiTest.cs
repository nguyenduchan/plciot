using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Wi-Fi của board Waveshare THẬT, không giao diện (--lanwifi KQ.txt --lan-target IP:443 [--wifi-ssid TÊN --wifi-pass-file FILE]):
/// nối bằng khoá PC → trạng thái Wi-Fi → quét mạng (in tên + sóng) → nếu có --wifi-ssid thì nối (mật khẩu đọc từ file, không in ra).
/// </summary>
public sealed partial class MainForm
{
    public async Task LanWifiAsync(string result)
    {
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var lines = new List<string>();
        try
        {
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var st = await c.WifiAsync();
            lines.Add($"INFO wifi supported={st.Supported} saved='{st.Saved}' connected={st.Connected} ip={st.Ip} mac={st.Mac}");
            var nets = await c.WifiScanAsync();
            lines.Add($"{(nets.Count > 0 ? "PASS" : "FAIL")} board thấy {nets.Count} mạng Wi-Fi");
            foreach (var n in nets.OrderByDescending(n => n.Rssi).Take(15)) lines.Add($"  {n.Ssid} · {n.Rssi} dBm · {(n.Open ? "mở" : "bảo mật")}");
            var ssid = ArgValue(args, "--wifi-ssid");
            if (ssid.Length > 0)
            {
                var pf = ArgValue(args, "--wifi-pass-file");
                var pass = pf.Length > 0 ? File.ReadAllText(pf).Trim() : "";
                var r = await c.PutWifiAsync(ssid, pass);
                lines.Add($"{(r.Connected ? "PASS" : "FAIL")} nối \"{ssid}\": connected={r.Connected} ip={r.Ip} rssi={r.Rssi}");
            }
            c.Dispose();
        }
        catch (Exception e) { lines.Add("FAIL " + RemoteClient.Explain(e) + " | " + e.GetType().Name); }
        File.WriteAllLines(result, lines);
        Close();
    }

    /// <summary>--lanui --lan-target IP:443: chỉ mở cửa sổ cài đặt Waveshare (như nút "Kết nối Waveshare (LAN)") cho người dùng thao tác tay, không bật gateway PC.</summary>
    public async Task LanUiAsync()
    {
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        try
        {
            var found = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2));
            var hello = found.FirstOrDefault(f => f.Ip.ToString() == host).Hello ?? new ApiHello { Kind = "mcu", Port = port };
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), hw => Ask.Yes(this, $"Board lạ, mã phần cứng {hw}. Tin cậy?", "Board mới"))).Client;
            var first = await c.ConfigAsync();
            var rf = RemoteForm.ForTest(c, hello, host, port, first);
            rf.FormClosed += (_, _) => Close();
            rf.Show();
            Hide();
        }
        catch (Exception e) { MessageBox.Show(RemoteClient.Explain(e), "Không nối được board"); Close(); }
    }
}
