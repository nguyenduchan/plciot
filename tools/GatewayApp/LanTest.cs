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
        var args = Environment.GetCommandLineArgs();
        var target = ArgValue(args, "--lan-target"); var code = ArgValue(args, "--lan-code");
        var mb = int.TryParse(ArgValue(args, "--lan-mb"), out var m) ? m : 5020;
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 8750;
        RemoteForm? rf = null;
        try
        {
            var found = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2));
            log.Add("discover: " + string.Join(", ", found.Select(f => $"{f.Ip}:{f.Hello.Port} {f.Hello.Kind} \"{f.Hello.Name}\" hw={f.Hello.Hw}")));
            Check("discover thấy thiết bị đích", found.Any(f => f.Hello.Port == port));

            try { using var bad = await RemoteClient.ConnectAsync(host, port, code == "00000000" ? "11111111" : "00000000"); Check("mã sai bị từ chối", false, "lại nối được"); }
            catch (RemoteException e) { Check("mã sai bị từ chối", e.Code == "unauthorized", e.Code); }

            var c = await RemoteClient.ConnectAsync(host, port, code);
            var first = await c.ConfigAsync();
            var st0 = await c.StateAsync();
            Check("nối bằng mã đúng + đọc cấu hình/trạng thái", true, $"pack={first.Config.Pack.Count} rev={st0.Rev} running={st0.Running}");
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
            var other = await RemoteClient.ConnectAsync(host, port, code);
            var oc = await other.ConfigAsync();
            oc.Config.PollMs = oc.Config.PollMs == 700 ? 800 : 700;
            await other.PutConfigAsync(oc);
            other.Dispose();
            await Task.Delay(2500);
            Check("cửa sổ tự nạp lại khi thiết bị đổi cấu hình", rf.Config.PollMs == oc.Config.PollMs, $"PollMs={rf.Config.PollMs}");
            log.Add("--- nhật ký cửa sổ từ xa ---");
            log.Add(rf.LogText);
        }
        catch (Exception e) { Check("chạy kiểm thử", false, RemoteClient.Explain(e) + " " + e.GetType().Name + ": " + e.Message); }
        File.WriteAllLines(Path.Combine(outDir, "lantest-result.txt"), log);
        rf?.Close();
        await StopAsync();
        Close();
    }

    static void SaveForm(Form f, string path)
    {
        using var bmp = new Bitmap(f.Width, f.Height);
        f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
        bmp.Save(path);
    }
}
