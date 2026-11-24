using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử điều khiển từ webapp tới board Waveshare THẬT theo đường "PC làm gateway, board làm Modbus TCP slave"
/// (--boardctl THƯ_MỤC --noauth --lan-target IP:443; GATEWAYAPP_SETTINGS = file chưa tồn tại, GW_TEST_TOKEN/GW_TEST_UID = token đăng ký):
/// đăng ký gateway test (cấp ID + QR) → ghép PC test với board (cần nhấn BOOT; PC quản trị cũ duyệt bằng --lanadmin) →
/// thêm thiết bị "nối chân DI/DO của board" bằng hộp thoại thật (Modbus TCP, Unit 0: run ← DO1 D20, flow ← DI1 D10) →
/// chờ script ngoài gửi lệnh qua API webapp (cmd-sent.txt = "1"/"0") → DO của board phải đổi theo.
/// Điều phối qua file trong THƯ_MỤC: qr.txt, pair-status.txt, cmd-ready.txt, cmd-sent.txt, cmd-sent-off.txt, boardctl-log.txt.
/// </summary>
public sealed partial class MainForm
{
    public async Task BoardCtlTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void L(string s) { log.Add($"{DateTime.Now:HH:mm:ss} {s}"); File.WriteAllLines(Path.Combine(outDir, "boardctl-log.txt"), log); }
        async Task<bool> Until(Func<bool> c, int sec) { for (var i = 0; i < sec * 4 && !c(); i++) await Task.Delay(250); return c(); }
        var args = Environment.GetCommandLineArgs();
        var target = ArgValue(args, "--lan-target"); var ti = target.LastIndexOf(':');
        var host = ti > 0 ? target[..ti] : target; var port = ti > 0 ? int.Parse(target[(ti + 1)..]) : 443;
        try
        {
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
            if (File.Exists(TrustedBoards.FilePath)) File.Delete(TrustedBoards.FilePath);

            // 1) đăng ký gateway test lần đầu
            var reg = await Until(() => _cfg.MqttId.Length > 0 && _cfg.GatewayQr.Length > 0, 90);
            L($"đăng ký gateway test: {(reg ? "OK" : "LỖI")} site={_cfg.Site} device={_cfg.Device} mqttId={_cfg.MqttId}");
            if (!reg) { L("RESULT=FAIL"); Application.Exit(); return; }
            File.WriteAllText(Path.Combine(outDir, "qr.txt"), _cfg.GatewayQr);

            // 2) ghép PC test với board (nhấn BOOT mở cửa sổ; PC quản trị cũ duyệt)
            var paired = false;
            for (var k = 0; k < 600 && !paired; k++)
            {
                try { (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client.Dispose(); paired = true; }
                catch (RemoteException e) { File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), e.Code); await Task.Delay(3000); }
                catch (Exception e) { File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), e.GetType().Name + ": " + e.Message); await Task.Delay(3000); }
            }
            L($"ghép PC test với board: {(paired ? "OK" : "LỖI hết giờ")}");
            if (!paired) { L("RESULT=FAIL"); Application.Exit(); return; }
            File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), "paired");

            // 3) thêm thiết bị nối chân DI/DO của board (Modbus TCP tới IP board, Unit 0)
            static Action<DataGridView> Keep(params (string name, string addr)[] f) => g =>
            {
                for (var k = g.Rows.Count - 1; k >= 0; k--)
                    if (!g.Rows[k].IsNewRow && !f.Any(x => x.name == Convert.ToString(g.Rows[k].Cells[0].Value))) g.Rows.RemoveAt(k);
                foreach (DataGridViewRow r in g.Rows)
                    if (f.FirstOrDefault(x => x.name == Convert.ToString(r.Cells[0].Value)) is { name: not null } x) { r.Cells[5].Value = x.addr; r.Cells[6].Value = "1"; }
            };
            var e1 = AddDeviceViaDialog("pump", PlcSource.ModbusTcp, host, 502, new(), new() { ["unit"] = "0" }, Keep(("run", "20"), ("flow", "10")));
            L($"thêm thiết bị DI/DO board: {(e1.Length == 0 ? "OK" : "LỖI " + e1)}");
            await ApplyAsync("boardctl: thêm thiết bị DI/DO board");
            var up = await Until(() => Running, 30);
            var have = await Until(() => TryValue("pump1.run", out _), 40);
            TryValue("pump1.run", out var run0); TryValue("pump1.flow", out var flow0);
            L($"gateway chạy: {(up ? "OK" : "LỖI")}; đọc board qua Modbus TCP (lease): {(have ? "OK" : "LỖI")} run(DO1)={run0} flow(DI1)={flow0}");

            // 4) chờ user claim QR + lệnh từ API webapp
            var claimed = await Until(() => _cfg.CloudSendData, 120);
            L($"user claim QR → gateway nhận claimed: {(claimed ? "OK" : "LỖI hết giờ")}");
            File.WriteAllText(Path.Combine(outDir, "cmd-ready.txt"), "1");
            foreach (var (file, label) in new[] { ("cmd-sent.txt", "bật"), ("cmd-sent-off.txt", "tắt") })
            {
                var sent = await Until(() => File.Exists(Path.Combine(outDir, file)), 120);
                if (!sent) { L($"không nhận được tín hiệu đã gửi lệnh {label}"); continue; }
                var want = File.ReadAllText(Path.Combine(outDir, file)).Trim() == "1" ? 1.0 : 0.0;
                var ok = await Until(() => TryValue("pump1.run", out var v) && Math.Abs(v - want) < 0.01, 30);
                TryValue("pump1.run", out var now);
                L($"lệnh {label} từ webapp → DO1 của board = {want}: {(ok ? "OK" : "LỖI")} (đọc lại={now})");
                File.WriteAllText(Path.Combine(outDir, file + ".done"), ok ? "ok" : "fail");
            }
            await Task.Delay(6000);
            L("RESULT=DONE");
        }
        catch (Exception e) { L("NGOẠI LỆ " + e.GetType().Name + ": " + RemoteClient.Explain(e)); }
        Application.Exit();
    }

    /// <summary>--lanadmin KQ.txt --lan-target IP:443: PC quản trị hiện tại (khoá của GATEWAYAPP_SETTINGS đang dùng) đồng ý mọi PC đang chờ ghép.</summary>
    public async Task LanAdminAsync(string result)
    {
        var args = Environment.GetCommandLineArgs();
        var target = ArgValue(args, "--lan-target"); var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var lines = new List<string>();
        try
        {
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            foreach (var a in await c.AdminsAsync())
            {
                lines.Add($"INFO PC {a.Name} id={a.Id} active={a.Active} self={a.Self}");
                if (!a.Active) { var r = await c.AdminActionAsync(a.Id, "approve"); lines.Add($"{(r.Ok ? "PASS" : "FAIL")} approve {a.Name}"); }
            }
            c.Dispose();
        }
        catch (Exception e) { lines.Add("FAIL " + RemoteClient.Explain(e)); }
        File.WriteAllLines(result, lines);
        Close();
    }
}
