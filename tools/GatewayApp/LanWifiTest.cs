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

    /// <summary>
    /// --lantime KQ.txt --lan-target IP:443 [--time-force]: giờ của board THẬT (quản lý giờ khi offline). Đọc → đặt theo PC (không force:
    /// board đang có giờ server phải trả time_from_server) → [--time-force: ghi đè] → đọc lại, so độ lệch với PC.
    /// </summary>
    public async Task LanTimeAsync(string result)
    {
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var lines = new List<string>();
        try
        {
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var watch = ArgValue(args, "--time-watch");   // chỉ ĐỌC N lần, cách 20 s (không đặt giờ): giờ board có chạy đúng khi không có giờ server
            if (int.TryParse(watch, out var n) && n > 0)
            {
                for (var k = 0; k < n; k++)
                {
                    if (k > 0) await Task.Delay(20_000);
                    var tw = await c.TimeAsync(); var st = await c.StateAsync();
                    var pcw = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    lines.Add($"WATCH {DateTime.Now:HH:mm:ss} cloud={st.Cloud} source={tw.Source} trusted={tw.Trusted} lechPC={tw.NowMs - pcw}ms rtcDrift={tw.RtcDriftMs}ms up={tw.UpSec}s lastSync={tw.LastSyncBy}");
                    File.WriteAllLines(result, lines);
                }
                c.Dispose(); Close(); return;
            }
            var t0 = await c.TimeAsync();
            var pc0 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            lines.Add($"INFO source={t0.Source} trusted={t0.Trusted} rtc={t0.RtcFound}/{t0.RtcValid} rtcDrift={t0.RtcDriftMs} lechPC={t0.NowMs - pc0}ms lastSync={t0.LastSyncBy}");
            lines.Add($"{(t0.Ok && t0.NowMs > 0 ? "PASS" : "FAIL")} đọc giờ board");
            string code;
            try { await c.PutTimeAsync(false); code = "ok"; } catch (RemoteException e) { code = e.Code; }
            if (t0.Source == "ntp") lines.Add($"{(code == "time_from_server" ? "PASS" : "FAIL")} đang có giờ server: không ghi đè khi không force ({code})");
            else lines.Add($"{(code == "ok" ? "PASS" : "FAIL")} chưa có giờ server: đặt theo PC ({code})");
            if (args.Contains("--time-force") || t0.Source != "ntp")
            {
                if (args.Contains("--time-force")) { try { await c.PutTimeAsync(true); code = "ok"; } catch (RemoteException e) { code = e.Code; } lines.Add($"{(code == "ok" ? "PASS" : "FAIL")} force: ghi đè ({code})"); }
                var t1 = await c.TimeAsync();
                var d = t1.NowMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                lines.Add($"{(Math.Abs(d) < 2000 ? "PASS" : "FAIL")} sau khi đặt: lệch PC {d} ms, nguồn {t1.Source}, RTC {t1.RtcValid} (lệch {t1.RtcDriftMs} ms), đặt bởi {t1.LastSyncBy}");
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
