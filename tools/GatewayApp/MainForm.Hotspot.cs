using System.Net;
using GatewayApp.Ui;

namespace GatewayApp;

/// <summary>
/// Cài Wi-Fi cho board Waveshare MỚI, theo kiểu app IoT thông dụng — nhập Wi-Fi TRƯỚC, GatewayApp tự làm phần còn lại và không để PC mất mạng lâu:
///   1. Hộp thoại nhập tên Wi-Fi + mật khẩu (PC còn mạng; gợi ý sẵn mạng đang dùng).
///   2a. Có cáp USB tới board → gửi qua cổng COM, PC không đổi mạng.
///   2b. Không có cáp → board phát hotspot "PLCIOT-xxxx" (khi chưa có dây + chưa Wi-Fi): GatewayApp tự nối PC vào hotspot (hoặc chờ người dùng nối tay),
///       đăng nhập bằng khoá PC, gửi Wi-Fi, rồi TỰ NỐI PC LẠI mạng cũ (xoá profile tạm).
///   3. Chờ board lên Wi-Fi (dò UDP) rồi mở cửa sổ cài đặt board ở IP Wi-Fi mới. Không phải gõ IP nào.
/// </summary>
public sealed partial class MainForm
{
    readonly System.Windows.Forms.Timer _hotTimer = new() { Interval = 7000 };
    readonly HashSet<string> _hotSeen = new();
    bool _hotBusy;

    /// <summary>Gọi một lần khi cửa sổ chính đã hiện (không chạy trong các lệnh kiểm thử): thấy board ở chế độ hotspot (PC đã tự nối vào) thì mời cài Wi-Fi.</summary>
    void InitHotspotWatch()
    {
        _hotTimer.Tick += async (_, _) => await HotspotTickAsync();
        _hotTimer.Start();
        FormClosed += (_, _) => _hotTimer.Stop();
    }

    static bool IsHotspotBoard(IPAddress ip, ApiHello h) => h.Kind == "mcu" && ip.ToString().StartsWith("192.168.4.");

    async Task HotspotTickAsync()
    {
        if (_hotBusy || IsDisposed || !Visible) return;
        _hotBusy = true;
        try
        {
            var found = await RemoteClient.DiscoverAsync(TimeSpan.FromMilliseconds(1500));
            var b = found.FirstOrDefault(f => IsHotspotBoard(f.Ip, f.Hello));
            if (b.Hello == null) { _hotSeen.Clear(); return; }
            if (!_hotSeen.Add(b.Hello.Hw)) return;
            if (Ask.Yes(this, "Phát hiện board Waveshare đang ở chế độ cài đặt (hotspot).\n\nCài Wi-Fi cho board ngay?", "Board Waveshare mới")) await WifiSetupAsync();
        }
        catch (Exception) { /* dò lỗi mạng: thử lại ở nhịp sau */ }
        finally { _hotBusy = false; }
    }

    /// <summary>Cửa sổ tiến độ nhỏ, luôn nổi trên cùng, cho phép huỷ.</summary>
    sealed class Progress : Form
    {
        readonly Label _l = new() { Dock = DockStyle.Fill, Padding = new Padding(18, 16, 18, 0), UseMnemonic = false };
        public bool Cancelled { get; private set; }
        public Progress()
        {
            Text = "Cài Wi-Fi cho board Waveshare"; StartPosition = FormStartPosition.CenterScreen; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = MinimizeBox = false; TopMost = true; ShowInTaskbar = true;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Normal; ClientSize = new Size(520, 150);
            var c = new FlatButton { Caption = "Huỷ", Width = 90, Dock = DockStyle.Bottom }; c.Click += (_, _) => { Cancelled = true; Close(); };
            Controls.Add(_l); Controls.Add(c);
            FormClosing += (_, _) => Cancelled = true;
        }
        public void Say(string t) { if (!IsDisposed) _l.Text = t; }
    }

    /// <summary>Toàn bộ quy trình (xem mô tả lớp). Gọi từ nút / watcher / --wifisetup.</summary>
    public async Task WifiSetupAsync()
    {
        string ssid = "", pass = "", msg = "";
        string? boardIp = null;
        Progress? prog = null;
        while (boardIp == null)
        {
            // lỗi (sai mật khẩu, không thấy mạng…) hiện NGAY trong hộp nhập, giữ sẵn tên + mật khẩu để sửa rồi thử lại (không dùng MessageBox: chủ bị ẩn nên dễ bị che → như treo)
            var cred = WifiSetupForm.Ask(null, ssid, pass, msg);
            if (cred == null) return;
            (ssid, pass) = cred.Value;
            prog = new Progress(); prog.Show(); prog.Activate();
            string? err = null;
            try
            {
                var com = SerialBoard.FindPort();
                if (com != null)
                {
                    prog.Say($"Đã thấy board qua cáp USB ({com}). Đang cài Wi-Fi — PC giữ nguyên mạng (tối đa ~20 giây)…");
                    (boardIp, err) = await SerialBoard.SetWifiAsync(com, ssid, pass, prog.Say);
                }
                else (boardIp, err) = await WifiViaHotspotAsync(ssid, pass, prog);
            }
            catch (Exception e) { err = e is RemoteException re ? re.Code : e.Message; }
            if (boardIp != null) break;
            var cancelled = prog.Cancelled; prog.Dispose(); prog = null;
            if (cancelled || err == "cancelled") return;
            msg = err is { Length: > 0 } && !err.Contains(' ') ? RemoteClient.Explain(new RemoteException(err)) : (err ?? "Không cài được Wi-Fi cho board.");
        }
        using var _p = prog!;
        prog!.Say("");

        prog.Say($"Board đã nối \"{ssid}\" — IP {boardIp}. Đang chờ PC thấy board trong mạng…");
        for (var k = 0; k < 30 && !prog.Cancelled; k++)   // tới ~90 giây: hotspot tắt, PC về Wi-Fi nhà
        {
            try
            {
                var found = await RemoteClient.DiscoverAsync(TimeSpan.FromMilliseconds(1500));
                if (found.Any(f => f.Ip.ToString() == boardIp)) { prog.Close(); RemoteForm.Open(this, boardIp, 443, "", $"Board đã nối Wi-Fi \"{ssid}\" ({boardIp}) — cài đặt qua Wi-Fi giống khi cắm dây."); return; }
            }
            catch (Exception) { }
            await Task.Delay(2000);
        }
        prog.Close();
        MessageBox.Show($"Board đã nối Wi-Fi \"{ssid}\", IP {boardIp}. PC chưa thấy board: kiểm PC cùng mạng Wi-Fi đó rồi bấm \"Kết nối Waveshare (LAN)\".", "Board Waveshare", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    /// <summary>Không có cáp USB: dùng hotspot của board. Luôn đưa PC về mạng cũ khi xong (kể cả lỗi).</summary>
    async Task<(string? Ip, string? Err)> WifiViaHotspotAsync(string ssid, string pass, Progress prog)
    {
        var prev = PcWifi.CurrentSsid();
        var back = prev.Length == 0 || prev.StartsWith("PLCIOT-") ? ssid : prev;   // PC đang ở hotspot sẵn (người dùng tự nối) → quay về đúng mạng vừa nhập
        string? joined = null;
        try
        {
            async Task<(IPAddress Ip, ApiHello Hello)> FindHot(int sec)
            {
                for (var k = 0; k < sec * 2 && !prog.Cancelled; k++)
                {
                    try { var b = (await RemoteClient.DiscoverAsync(TimeSpan.FromMilliseconds(1200))).FirstOrDefault(f => IsHotspotBoard(f.Ip, f.Hello)); if (b.Hello != null) return b; } catch (Exception) { }
                    await Task.Delay(400);
                }
                return default;
            }
            var hot = await FindHot(2);   // PC đã ở trong hotspot (người dùng tự nối)?
            if (hot.Hello == null)
            {
                var spots = await Task.Run(PcWifi.ScanHotspots);
                if (spots.Count == 1)
                {
                    prog.Say($"Đang nối PC vào hotspot \"{spots[0]}\" của board (PC sẽ tự quay lại \"{back}\" sau khi cài xong)…");
                    if (await Task.Run(() => PcWifi.JoinOpen(spots[0]))) joined = spots[0];
                    hot = await FindHot(30);
                }
                if (hot.Hello == null)
                {
                    prog.Say("Không có cáp USB và chưa thấy hotspot của board.\r\n\r\nNối Wi-Fi của PC vào mạng \"PLCIOT-xxxx\" (không mật khẩu): cửa sổ này tự tiếp tục, và sau khi cài xong GatewayApp tự đưa PC về mạng cũ.");
                    hot = await FindHot(300);
                }
            }
            if (prog.Cancelled) return (null, "cancelled");
            if (hot.Hello == null) return (null, "Không thấy board ở chế độ hotspot (192.168.4.x).");

            prog.Say($"Đã thấy board ở {hot.Ip}. Đang đăng nhập và gửi Wi-Fi \"{ssid}\" (tối đa 20 giây)…");
            using var client = (await RemoteClient.ConnectMcuAsync(hot.Ip.ToString(), hot.Hello.Port, Identity(), _ => true)).Client;
            var st = await client.PutWifiAsync(ssid, pass);
            return string.IsNullOrEmpty(st.Ip) ? (null, "wifi_timeout") : (st.Ip, null);
        }
        finally
        {
            if (joined != null) { prog.Say($"Đang đưa PC về mạng \"{back}\"…"); await Task.Run(() => { PcWifi.Forget(joined); PcWifi.Rejoin(back); }); }
            else if (PcWifi.CurrentSsid().StartsWith("PLCIOT-")) { prog.Say($"Đang đưa PC về mạng \"{back}\"…"); await Task.Run(() => PcWifi.Rejoin(back)); }
        }
    }
}
