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

    /// <summary>
    /// --lannet KQ.txt --lan-target IP:443 [--net-pref wifi|eth|auto]: đọc cấu hình mạng của board THẬT (Pref = đường ra Internet ưu tiên).
    /// Có --net-pref: PUT giữ nguyên IP/DNS, chỉ đổi Pref → board khởi động lại → nối lại → kiểm Pref đã lưu.
    /// </summary>
    public async Task LanNetAsync(string result)
    {
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var lines = new List<string>();
        async Task<RemoteClient> Connect() => (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
        try
        {
            var c = await Connect();
            var n0 = await c.NetworkAsync();
            lines.Add($"INFO dhcp={n0.Dhcp} ip={n0.Ip}/{n0.Mask} gw={n0.Gateway} dns='{n0.Dns}' current={n0.Current} pref='{n0.Pref}'");
            lines.Add($"{(n0.Pref is "auto" or "wifi" or "eth" ? "PASS" : "FAIL")} board báo đường ưu tiên (Pref)");
            var want = ArgValue(args, "--net-pref");
            if (want.Length > 0)
            {
                var r = await c.PutNetworkAsync(new ApiNetwork { Dhcp = n0.Dhcp, Ip = n0.Ip, Mask = n0.Mask, Gateway = n0.Gateway, Dns = n0.Dns, Pref = want });
                lines.Add($"{(r.Ok ? "PASS" : "FAIL")} PUT Pref={want}: {r.Msg ?? r.Err}");
                c.Dispose();
                ApiNetwork? n1 = null;
                for (var t = 0; t < 30 && n1 == null; t++)
                {
                    await Task.Delay(3000);
                    try { c = await Connect(); n1 = await c.NetworkAsync(); } catch { /* board đang khởi động lại */ }
                }
                lines.Add(n1 == null ? "FAIL không nối lại được board sau khi khởi động lại"
                    : $"{(n1.Pref == want ? "PASS" : "FAIL")} sau khởi động lại Pref='{n1.Pref}' (ip {n1.Ip}, dns '{n1.Dns}')");
                string badErr;   // board trả lỗi → RemoteClient ném RemoteException (không khởi động lại)
                try { var bad = await c.PutNetworkAsync(new ApiNetwork { Dhcp = n0.Dhcp, Ip = n0.Ip, Mask = n0.Mask, Gateway = n0.Gateway, Dns = n0.Dns, Pref = "lte" }); badErr = bad.Ok ? "" : bad.Err ?? "lỗi"; }
                catch (RemoteException e) { badErr = e.Message; }
                lines.Add($"{(badErr.Length > 0 ? "PASS" : "FAIL")} từ chối Pref sai: {badErr}");
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
