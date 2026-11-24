using System.Globalization;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Thêm thiết bị vào từng chân DO của board Waveshare THẬT trên GATEWAY C# rồi điều khiển từ webapp
/// (--boarddo THƯ_MỤC --noauth --lan-target IP:443; GATEWAYAPP_SETTINGS = file riêng, GW_TEST_TOKEN/GW_TEST_UID nếu cần đăng ký lại):
/// đăng ký gateway test → chắc chắn PC test đã ghép với board → thêm 8 thiết bị bằng hộp thoại THẬT (mẫu "Nối chân DI / DO của board",
/// chân DO tự chọn lần lượt DO1..DO8, Modbus TCP tới IP board, Unit 0) → ghi qr.txt cho script ngoài claim → theo dõi giá trị ioN.doN
/// và ghi mỗi lần đổi vào boarddo-log.txt cho tới khi có stop.txt (tối đa --watch-sec, mặc định 600 giây).
/// </summary>
public sealed partial class MainForm
{
    public async Task BoardDoTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void L(string s) { log.Add($"{DateTime.Now:HH:mm:ss} {s}"); File.WriteAllLines(Path.Combine(outDir, "boarddo-log.txt"), log); }
        async Task<bool> Until(Func<bool> c, int sec) { for (var i = 0; i < sec * 4 && !c(); i++) await Task.Delay(250); return c(); }
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var ti = target.LastIndexOf(':');
        var host = ti > 0 ? target[..ti] : target; var port = ti > 0 ? int.Parse(target[(ti + 1)..]) : 443;
        var watch = int.TryParse(ArgValue(args, "--watch-sec"), out var w) ? w : 600;
        try
        {
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");

            var reg = await Until(() => _cfg.MqttId.Length > 0 && _cfg.GatewayQr.Length > 0, 90);
            L($"gateway test: {(reg ? "OK" : "LỖI")} site={_cfg.Site} device={_cfg.Device}");
            if (!reg) { L("RESULT=FAIL"); Application.Exit(); return; }
            File.WriteAllText(Path.Combine(outDir, "qr.txt"), _cfg.GatewayQr);

            var paired = false;
            for (var k = 0; k < 600 && !paired; k++)
            {
                try { (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client.Dispose(); paired = true; }
                catch (Exception e) { File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), e is RemoteException re ? re.Code : e.Message); await Task.Delay(3000); }
            }
            L($"PC test đã ghép với board: {(paired ? "OK" : "LỖI")}");
            if (!paired) { L("RESULT=FAIL"); Application.Exit(); return; }

            // 8 thiết bị thật (bơm, van, đèn, quạt…) mỗi cái tick "Nối với phần cứng Waveshare" (hộp thoại tự chọn chân DO còn rảnh đầu tiên)
            var hwTpl = new[] { "pump", "valve", "bulb", "fan", "alarm", "door", "motor", "conveyor" };
            for (var n = 1; n <= 8; n++)
            {
                var e = AddDeviceViaDialog(hwTpl[n - 1], PlcSource.ModbusTcp, host, 502, new(), new() { ["unit"] = "0" }, null, dlg =>
                {
                    var f = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance; var ty = dlg.GetType();
                    var target = (ComboBox)ty.GetField("_target", f)!.GetValue(dlg)!; target.SelectedIndex = 1;   // thiết bị đích = Waveshare đã ghép → danh sách giao thức của board, mục đầu = Digital I/O
                    var conn = (Dictionary<string, Control>)ty.GetField("_connInputs", f)!.GetValue(dlg)!;
                    if (conn.TryGetValue("host", out var h)) h.Text = host; if (conn.TryGetValue("port", out var p)) p.Text = "502";
                    var prm = (Dictionary<string, Control>)ty.GetField("_paramInputs", f)!.GetValue(dlg)!; if (prm.TryGetValue("unit", out var u)) u.Text = "0";
                });
                L($"thêm thiết bị #{n} (nối chân DO): {(e.Length == 0 ? "OK" : "LỖI " + e)}");
                if (e.Length > 0) break;
            }
            L("pack: " + string.Join(", ", _cfg.Pack.Select(p => $"{p.Child}.{p.Field}=D{p.Address}")));
            await ApplyAsync("boarddo: thêm 8 thiết bị DO");
            var up = await Until(() => Running, 30);
            var have = await Until(() => _cfg.Pack.Count > 0 && _cfg.Pack.All(p => TryValue(UiMetaStore.Key(p.Child, p.Field), out _)), 40);
            L($"gateway chạy: {(up ? "OK" : "LỖI")}; đọc đủ {_cfg.Pack.Count} field từ board qua Modbus TCP: {(have ? "OK" : "LỖI")}");
            File.WriteAllText(Path.Combine(outDir, "ready.txt"), "1");

            // theo dõi thay đổi (lệnh từ webapp → DO) tới khi có stop.txt
            var last = new Dictionary<string, double>();
            var t0 = DateTime.Now;
            while ((DateTime.Now - t0).TotalSeconds < watch && !File.Exists(Path.Combine(outDir, "stop.txt")))
            {
                foreach (var p in _cfg.Pack)
                {
                    var key = UiMetaStore.Key(p.Child, p.Field);
                    if (!TryValue(key, out var v)) continue;
                    if (!last.TryGetValue(key, out var old) || Math.Abs(old - v) > 0.01)
                    {
                        if (last.ContainsKey(key)) L($"ĐỔI {p.Child}.{p.Field}: {old.ToString("0.##", CultureInfo.InvariantCulture)} → {v.ToString("0.##", CultureInfo.InvariantCulture)}");
                        last[key] = v;
                    }
                }
                await Task.Delay(250);
            }
            L("RESULT=DONE");
        }
        catch (Exception e) { L("NGOẠI LỆ " + e.GetType().Name + ": " + RemoteClient.Explain(e)); }
        Application.Exit();
    }
}
