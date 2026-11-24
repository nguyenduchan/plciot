using System.Globalization;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử kết nối LAN tới gateway khác (--lantest THƯ_MỤC --lan-target IP:CỔNG --lan-code MÃ [--lan-mb CỔNG_MODBUS]):
/// tìm thiết bị (UDP), mã sai bị từ chối, nối bằng mã đúng, mở cửa sổ thiết lập từ xa, thêm bồn + bơm bằng HỘP THOẠI THẬT
/// (Modbus TCP 127.0.0.1:CỔNG_MODBUS — chạy tools/modbus_tcp_sim.py), kiểm tra cấu hình đã nằm trên thiết bị, giá trị chạy về,
/// ghi lệnh, tạm dừng thiết bị, xoá thiết bị, chụp ảnh. Thiết bị đích: GatewayApp thứ hai (--api --bind 0.0.0.0 --token MÃ)
/// hoặc board Waveshare thật. Kết quả: lantest-result.txt (dòng "FAIL" = lỗi).
/// </summary>
public sealed partial class MainForm
{
    public async Task LanTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var code = ArgValue(args, "--lan-code");
        var mb = int.TryParse(ArgValue(args, "--lan-mb"), out var m) ? m : 5020;
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 8750;
        RemoteForm? rf = null;
        try
        {
            var found = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2));
            log.Add("discover: " + string.Join(", ", found.Select(f => $"{f.Ip}:{f.Hello.Port} {f.Hello.Kind} tls={f.Hello.Tls} \"{f.Hello.Name}\" hw={f.Hello.Hw}")));
            Check("discover thấy thiết bị đích", found.Any(f => f.Hello.Port == port));
            var mcu = found.Any(f => f.Hello.Port == port && f.Hello.Tls);

            RemoteClient c;
            if (mcu)
            {
                // board MCU: HTTPS + khoá PC, không mã. Thử bảo mật TRƯỚC (cửa sổ ghép đang mở vì board chưa có PC nào)
                TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
                if (File.Exists(TrustedBoards.FilePath)) File.Delete(TrustedBoards.FilePath);
                var http = int.TryParse(ArgValue(args, "--lan-http"), out var hp) ? hp : 80;
                var boardHw = found.First(f => f.Hello.Port == port).Hello.Hw;
                await McuSecurityTestAsync(host, port, http, boardHw, Check, log);
                c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            }
            else
            {
                try { using var bad = await RemoteClient.ConnectAsync(host, port, code == "00000000" ? "11111111" : "00000000"); Check("mã sai bị từ chối", false, "lại nối được"); }
                catch (RemoteException e) { Check("mã sai bị từ chối", e.Code == "unauthorized", e.Code); }
                c = await RemoteClient.ConnectAsync(host, port, code);
            }
            var first = await c.ConfigAsync();
            var st0 = await c.StateAsync();
            Check("đăng nhập + đọc cấu hình/trạng thái", true, $"pack={first.Config.Pack.Count} rev={st0.Rev} running={st0.Running}");
            Check("không lộ mật khẩu cloud", string.IsNullOrEmpty(first.Config.CloudPassword));
            var hello = found.FirstOrDefault(f => f.Hello.Port == port).Hello ?? new ApiHello { Kind = "pc", Port = port };
            rf = RemoteForm.ForTest(c, hello, host, port, first);
            rf.StartPosition = FormStartPosition.Manual; rf.Location = new Point(40, 40); rf.Size = new Size(1400, 860);
            rf.Show(this);
            await Task.Delay(1500);

            // xoá sạch thiết bị cũ trên đích (lần chạy trước) để kết quả lặp lại được
            foreach (var ch in rf.Config.Pack.Select(p => p.Child).Distinct().ToList()) DeviceDialog.Remove(rf, ch);
            if (first.Config.Pack.Count > 0) await rf.ApplyAsync("lantest: dọn thiết bị cũ");

            var none = new Dictionary<string, string>();
            var modbus = new Dictionary<string, string> { ["unit"] = "1" };
            var e1 = AddDeviceViaDialog(rf, "tank", PlcSource.ModbusTcp, "127.0.0.1", mb, none, modbus);
            // run → D6: thanh ghi PLC giả (modbus_tcp_sim.py) cho phép ghi (WRITABLE = D3, D4, D6, D7, D9)
            var e2 = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusTcp, "127.0.0.1", mb, none, modbus, g =>
            {
                foreach (DataGridViewRow r in g.Rows) if (Convert.ToString(r.Cells[0].Value) == "run") r.Cells[5].Value = "6";
            });
            Check("thêm bồn + bơm bằng hộp thoại", e1.Length == 0 && e2.Length == 0, $"{e1} {e2}".Trim());
            var children = rf.Config.Pack.Select(p => p.Child).Distinct().ToList();
            await rf.ApplyAsync("lantest: thêm bồn + bơm");

            var after = await c.ConfigAsync();
            var onDev = after.Config.Pack.Select(p => p.Child).Distinct().ToList();
            Check("cấu hình đã lưu trên thiết bị", children.All(onDev.Contains) && after.Config.Pack.Count == rf.Config.Pack.Count, $"thiết bị có: {string.Join(",", onDev)} ({after.Config.Pack.Count} field)");
            Check("nhãn/hiển thị (metadata) lên thiết bị", after.Devices.Count >= children.Count, $"devices={after.Devices.Count} fields={after.Fields.Count}");

            ApiState st = st0;
            for (var k = 0; k < 20; k++) { await Task.Delay(500); st = await c.StateAsync(); if (st.Values.Count > 0) break; }
            Check("thiết bị chạy + giá trị về qua LAN", st.Running && st.Values.Count > 0, $"status={st.Status} values={string.Join(" ", st.Values.Take(6).Select(kv => $"{kv.Key}={kv.Value.ToString("0.##", CultureInfo.InvariantCulture)}"))}");
            Check("rev tăng sau khi lưu", st.Rev > st0.Rev, $"{st0.Rev}→{st.Rev}");
            await Task.Delay(1500);   // cửa sổ từ xa nhận giá trị ở nhịp đọc trạng thái kế
            Check("cửa sổ từ xa có giá trị", rf.Config.Pack.Any(p => rf.TryValue(UiMetaStore.Key(p.Child, p.Field), out _)));

            var w = rf.Config.Pack.FirstOrDefault(p => p.Access != PackAccess.Read && p.Address >= 0);
            if (w != null)
            {
                var err = await rf.WriteAsync(w.Child, w.Field, 1);
                Check($"ghi lệnh {w.Child}.{w.Field}=1 qua LAN", err == null, err ?? "");
            }
            else log.Add("SKIP ghi lệnh — không có field ghi được");

            var pump = children.FirstOrDefault(x => x.StartsWith("pump")) ?? children.Last();
            var e3 = await rf.SetDeviceEnabledAsync(pump, false);
            var cfgP = await c.ConfigAsync();
            Check($"tạm dừng {pump} qua LAN", e3 == null && cfgP.Config.Pack.Where(p => p.Child == pump).All(p => !p.Enabled), e3 ?? "");
            await rf.SetDeviceEnabledAsync(pump, true);

            rf.ShowPage(0); await Task.Delay(1200); SaveForm(rf, Path.Combine(outDir, "lan-dashboard.png"));
            rf.ShowPage(1); await Task.Delay(800); SaveForm(rf, Path.Combine(outDir, "lan-devices.png"));
            rf.ShowPage(2); await Task.Delay(500); SaveForm(rf, Path.Combine(outDir, "lan-cloud.png"));

            var tank = children.First(x => x != pump);
            DeviceDialog.Remove(rf, tank);
            await rf.ApplyAsync("lantest: xoá bồn");
            var cfgD = await c.ConfigAsync();
            Check($"xoá {tank} qua LAN", cfgD.Config.Pack.All(p => p.Child != tank) && cfgD.Config.Pack.Any(p => p.Child == pump));

            // đổi cấu hình từ phía thiết bị (admin khác) → cửa sổ tự nạp lại
            var other = mcu ? (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => false)).Client : await RemoteClient.ConnectAsync(host, port, code);
            var oc = await other.ConfigAsync();
            oc.Config.PollMs = oc.Config.PollMs == 700 ? 800 : 700;
            await other.PutConfigAsync(oc);
            other.Dispose();
            await Task.Delay(2500);
            Check("cửa sổ tự nạp lại khi thiết bị đổi cấu hình", rf.Config.PollMs == oc.Config.PollMs, $"PollMs={rf.Config.PollMs}");
            log.Add("--- nhật ký cửa sổ từ xa ---");
            log.Add(rf.LogText);
            // đổi IP làm board khởi động lại (mất phiên): đóng cửa sổ từ xa trước để nó không bật hộp hỏi mã giữa bài thử
            rf.Close(); rf = null;
            if (mcu)
            {
                Func<Task<RemoteClient>> connect = async () => (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => false)).Client;
                await NetworkTestAsync(connect, Check, log);
                // sau khởi động lại (đổi IP): board đã có PC quản trị nên KHÔNG mở cửa sổ ghép → PC lạ bị từ chối, PC đã ghép vẫn vào
                var k = ""; var stranger = Plciot.Scada.Services.Ui.GatewayIdentity.LoadOrCreate(ref k, out _);
                try { using var s = (await RemoteClient.ConnectMcuAsync(host, port, stranger, _ => true)).Client; Check("sau khởi động lại: PC lạ không ghép được (cấp điện không mở cửa sổ ghép)", false, "lại vào được"); }
                catch (RemoteException e) { Check("sau khởi động lại: PC lạ không ghép được (cấp điện không mở cửa sổ ghép)", e.Code == "not_paired", e.Code); }
                try { using var me = await connect(); Check("PC đã ghép vẫn vào không cần BOOT", true); }
                catch (Exception e) { Check("PC đã ghép vẫn vào không cần BOOT", false, RemoteClient.Explain(e)); }
            }
        }
        catch (Exception e) { Check("chạy kiểm thử", false, RemoteClient.Explain(e) + " " + e.GetType().Name + ": " + e.Message); }
        File.WriteAllLines(Path.Combine(outDir, "lantest-result.txt"), log);
        rf?.Close();
        await StopAsync();
        Close();
    }

    /// <summary>Board MCU: mạng mặc định 192.168.1.200/24, từ chối cấu hình sai, đổi IP → board khởi động lại → nối lại → đã lưu; trả về mặc định.</summary>
    /// <summary>
    /// Board MCU, kênh bảo mật: cổng HTTP thường không nhận lệnh; PC đầu ghép dùng ngay; PC sau chờ → PC cũ đồng ý / từ chối;
    /// PC chờ đủ thời gian tự kích hoạt (SIM_PAIR_WAIT_SEC); ghim khoá: board lạ phải được người dùng xác nhận.
    /// </summary>
    async Task McuSecurityTestAsync(string host, int port, int httpPort, string boardHw, Action<string, bool, string> Check, List<string> log)
    {
        using (var plain = new HttpClient { Timeout = TimeSpan.FromSeconds(5) })
        {
            try
            {
                var r = await plain.GetAsync($"http://{host}:{httpPort}/api/state");
                Check("cổng HTTP thường không nhận lệnh cấu hình (use_https)", (int)r.StatusCode == 403 && (await r.Content.ReadAsStringAsync()).Contains("use_https"), $"HTTP {(int)r.StatusCode}");
            }
            catch (Exception e) { Check("cổng HTTP thường không nhận lệnh cấu hình (use_https)", false, e.Message); }
        }
        var asked = "";
        try { using var _ = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), hw => { asked = hw; return false; })).Client; Check("board lạ: hỏi người dùng đối chiếu mã phần cứng", false, "không hỏi"); }
        catch (RemoteException e) { Check("board lạ: hỏi người dùng đối chiếu mã phần cứng (khoá trong chứng chỉ TLS = mã của board)", e.Code == "untrusted_board" && asked == boardHw, $"hỏi {asked}, board {boardHw}"); }

        var (c1, paired1) = await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true);
        Check("PC đầu tiên (board chưa có PC quản trị): ghép dùng ngay", paired1, "");
        Plciot.Scada.Services.Ui.GatewayIdentity NewKey() { var k = ""; return Plciot.Scada.Services.Ui.GatewayIdentity.LoadOrCreate(ref k, out _); }
        async Task<string> Try(Plciot.Scada.Services.Ui.GatewayIdentity id)
        {
            try { using var x = (await RemoteClient.ConnectMcuAsync(host, port, id, _ => true)).Client; return "ok"; }
            catch (RemoteException e) { return e.Code; }
        }
        async Task<ApiAdmin?> Find(string name) => (await c1.AdminsAsync()).FirstOrDefault(a => !a.Self && !a.Active);
        // PC thứ hai: chờ → PC cũ đồng ý → vào được
        var pc2 = NewKey();
        Check("PC thứ hai (đã có PC quản trị): phải chờ", await Try(pc2) == "pair_pending", "");
        var p2 = await Find("");
        Check("PC quản trị thấy PC đang chờ", p2 != null && p2.RemainMin > 0, p2 == null ? "không thấy" : $"còn {p2.RemainMin} phút");
        if (p2 != null) await c1.AdminActionAsync(p2.Id, "approve");
        Check("PC cũ bấm Đồng ý → PC thứ hai vào được ngay", await Try(pc2) == "ok", "");
        // PC thứ ba: chờ → PC cũ từ chối → bị gỡ khỏi danh sách
        var pc3 = NewKey();
        await Try(pc3);
        var p3 = await Find("");
        if (p3 != null) await c1.AdminActionAsync(p3.Id, "reject");
        var after = await c1.AdminsAsync();
        Check("PC cũ bấm Từ chối → PC thứ ba bị gỡ", p3 != null && after.All(a => a.Id != p3.Id), $"{after.Count} PC trong danh sách");
        foreach (var a in after.Where(a => !a.Self)) await c1.AdminActionAsync(a.Id, "remove");   // dọn PC thứ hai trước bài thử tự kích hoạt
        // PC thứ tư: chờ, không ai từ chối → tự kích hoạt khi hết thời gian chờ
        var pc4 = NewKey();
        await Try(pc4);
        var p4 = await Find("");
        log.Add($"PC thứ tư chờ {p4?.RemainMin} phút (bản giả lập rút ngắn bằng SIM_PAIR_WAIT_SEC)");
        var r4 = "";
        for (var i = 0; i < 40 && (r4 = await Try(pc4)) != "ok"; i++) await Task.Delay(1000);
        Check("PC chờ đủ thời gian, không ai từ chối → tự kích hoạt", r4 == "ok", r4);
        foreach (var a in (await c1.AdminsAsync()).Where(a => !a.Self)) await c1.AdminActionAsync(a.Id, "remove");
        var rmSelf = await c1.AdminActionAsync((await c1.AdminsAsync()).First(a => a.Self).Id, "remove").ContinueWith(t => t.IsFaulted ? (t.Exception!.InnerException as RemoteException)?.Code ?? "lỗi" : t.Result.Ok ? "ok" : t.Result.Err ?? "");
        Check("không gỡ được PC quản trị cuối cùng", rmSelf != "ok", rmSelf);
        c1.Dispose();
    }

    static async Task NetworkTestAsync(Func<Task<RemoteClient>> connect, Action<string, bool, string> Check, List<string> log)
    {
        var c = await connect();   // thay bằng phiên mới sau mỗi lần board khởi động lại
        var n0 = await c.NetworkAsync();
        log.Add($"mạng hiện tại: dhcp={n0.Dhcp} ip={n0.Ip}/{n0.Mask} gw={n0.Gateway} dns={n0.Dns} mac={n0.Mac} đang dùng={n0.Current}");
        Check("mạng mặc định = IP tĩnh 192.168.1.200/24, gw 192.168.1.1", !n0.Dhcp && n0.Ip == "192.168.1.200" && n0.Mask == "255.255.255.0" && n0.Gateway == "192.168.1.1", "");
        foreach (var (bad, why) in new[] { (new ApiNetwork { Ip = "192.168.1.300", Mask = "255.255.255.0" }, "IP sai"), (new ApiNetwork { Ip = "192.168.1.50", Mask = "255.0.255.0" }, "mask không liền bit"), (new ApiNetwork { Ip = "192.168.1.50", Mask = "255.255.255.0", Gateway = "10.0.0.1" }, "gateway khác mạng con") })
        {
            try { var r = await c.PutNetworkAsync(bad); Check($"từ chối cấu hình mạng sai ({why})", !r.Ok, r.Err ?? ""); }
            catch (RemoteException e) { Check($"từ chối cấu hình mạng sai ({why})", true, e.Code); }
        }
        async Task<ApiNetwork?> PutAndReconnect(ApiNetwork n)
        {
            var r = await c.PutNetworkAsync(n);
            if (!r.Ok) { log.Add("đổi mạng lỗi: " + r.Err); return null; }
            // board hẹn 1,5 giây mới khởi động lại: phải chờ nó THẬT SỰ mất kết nối, không thì nối lại vào bản cũ chưa khởi động lại
            for (var i = 0; i < 20; i++) { await Task.Delay(500); try { await c.StateAsync(); } catch (RemoteException) { break; } }
            c.Dispose();
            for (var i = 0; i < 30; i++)   // board khởi động lại (bản giả lập: tự chạy lại) → cửa sổ cài đặt mở lại → nối bằng mã
            {
                await Task.Delay(1000);
                try { c = await connect(); return await c.NetworkAsync(); } catch (Exception) { }
            }
            return null;
        }
        var n1 = await PutAndReconnect(new ApiNetwork { Ip = "192.168.1.201", Mask = "255.255.255.0", Gateway = "192.168.1.1", Dns = "1.1.1.1" });
        Check("đổi IP → board khởi động lại → nối lại, IP mới đã lưu", n1 is { Dhcp: false, Ip: "192.168.1.201", Dns: "1.1.1.1" }, n1 == null ? "không nối lại được" : $"{n1.Ip} dns {n1.Dns}");
        var n2 = await PutAndReconnect(new ApiNetwork { Ip = "192.168.1.200", Mask = "255.255.255.0", Gateway = "192.168.1.1", Dns = "8.8.8.8" });
        Check("trả về mạng mặc định", n2 is { Ip: "192.168.1.200" }, n2?.Ip ?? "không nối lại được");
        c.Dispose();
    }

    static void SaveForm(Form f, string path)
    {
        using var bmp = new Bitmap(f.Width, f.Height);
        f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
        bmp.Save(path);
    }
}
