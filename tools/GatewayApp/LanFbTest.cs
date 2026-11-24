using System.Globalization;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử "lệnh → phản hồi thật" trên board ESP32 giả lập (--fbtest THƯ_MỤC --lan-target IP:CỔNG [--lan-http CỔNG]); chạy gw-sim với SIM_LOOPBACK=1
/// (DO1 nối DI1 qua relay, trễ 1 giây): thêm bơm bằng HỘP THOẠI THẬT (field `run` ← DO1 D20, field `flow` ← DI1 D10, cột "Phản hồi từ field" = flow),
/// lưu lên board, kiểm bản tin config của board có `fb`, ghi lệnh run=1 rồi chờ DI về 1, tắt thì cả hai về 0. Kết quả: fbtest-result.txt (FAIL = lỗi).
/// </summary>
public sealed partial class MainForm
{
    public async Task FbTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target");
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 8443;
        RemoteForm? rf = null;
        try
        {
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
            if (File.Exists(TrustedBoards.FilePath)) File.Delete(TrustedBoards.FilePath);
            var found = await RemoteClient.DiscoverAsync(TimeSpan.FromSeconds(2));
            Check("discover thấy board giả lập", found.Any(f => f.Hello.Port == port && f.Hello.Tls));
            var c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client;
            var first = await c.ConfigAsync();
            var hello = found.FirstOrDefault(f => f.Hello.Port == port).Hello ?? new ApiHello { Kind = "mcu", Port = port };
            rf = RemoteForm.ForTest(c, hello, host, port, first);
            rf.Show(this); await Task.Delay(1000);
            foreach (var ch in rf.Config.Pack.Select(p => p.Child).Distinct().ToList()) DeviceDialog.Remove(rf, ch);
            if (first.Config.Pack.Count > 0) await rf.ApplyAsync("fbtest: dọn thiết bị cũ");

            // 1) thêm bơm bằng hộp thoại: I/O trên board = Modbus RTU Unit ID 0; run ← DO1 (D20), flow ← DI1 (D10); "Phản hồi từ field" của run = flow
            var e = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusRtu, "RS485", 9600, new() { ["parity"] = "Even" }, new() { ["unit"] = "0" }, g =>
            {
                for (var k = g.Rows.Count - 1; k >= 0; k--)
                {
                    var n = Convert.ToString(g.Rows[k].Cells[0].Value);
                    if (n is not ("run" or "flow")) { if (!g.Rows[k].IsNewRow) g.Rows.RemoveAt(k); }
                }
                foreach (DataGridViewRow r in g.Rows)
                {
                    var n = Convert.ToString(r.Cells[0].Value);
                    if (n == "run") { r.Cells[5].Value = "20"; r.Cells[15].Value = "flow"; }
                    if (n == "flow") { r.Cells[5].Value = "10"; r.Cells[6].Value = "1"; }   // DI 0/1 = giá trị thẳng (hệ số 1)
                }
            });
            Check("thêm bơm có cột 'Phản hồi từ field' bằng hộp thoại", e.Length == 0, e);
            // phản hồi trỏ vào field không có → hộp thoại phải từ chối
            var bad = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusRtu, "RS485", 9600, new() { ["parity"] = "Even" }, new() { ["unit"] = "0" }, g =>
            {
                foreach (DataGridViewRow r in g.Rows) if (Convert.ToString(r.Cells[0].Value) == "run") r.Cells[15].Value = "khong_co";
            });
            Check("phản hồi trỏ field không tồn tại bị từ chối", bad.Contains("không có trong thiết bị"), bad);
            await rf.ApplyAsync("fbtest: thêm bơm + phản hồi");

            // 2) bản tin config board sẽ gửi lên cloud mang fb
            var msg = await c.ConfigMessageAsync();
            var fields = msg.GetProperty("devices").EnumerateArray().SelectMany(d => d.GetProperty("fields").EnumerateArray()).ToDictionary(f => f.GetProperty("key").GetString()!);
            Check("config board: run có fb = flow", fields.TryGetValue("run", out var run) && run.TryGetProperty("fb", out var fb) && fb.GetString() == "flow", msg.GetRawText());
            Check("config board: flow (chỉ đọc) không có fb", fields.TryGetValue("flow", out var flow) && !flow.TryGetProperty("fb", out _));

            // 3) lệnh bật → DO1 → (relay, trễ 1 s) → DI1
            async Task<(double? run, double? flow)> Vals() { var s = await c.StateAsync(); return (s.Values.TryGetValue("pump1.run", out var a) ? a : null, s.Values.TryGetValue("pump1.flow", out var b) ? b : null); }
            (double? run, double? flow) v = (null, null);
            for (var k = 0; k < 20 && v.flow == null; k++) { await Task.Delay(500); v = await Vals(); }
            Check("trạng thái đầu: run=0, flow(DI)=0", v is { run: 0, flow: 0 }, $"{v}");
            var seq = new List<string> { $"{v.run}/{v.flow}" };
            var err = await rf.WriteAsync("pump1", "run", 1);
            Check("ghi lệnh run=1", err == null, err ?? "");
            var t0 = DateTime.Now; var sawCmdFirst = false;
            while ((DateTime.Now - t0).TotalSeconds < 10 && v.flow != 1)
            {
                await Task.Delay(250); v = await Vals(); var tok = $"{v.run}/{v.flow}";
                if (seq[^1] != tok) seq.Add(tok);
                if (v is { run: 1, flow: 0 }) sawCmdFirst = true;
            }
            Check("lệnh tới trước, DI phản hồi sau (run=1 flow=0 → run=1 flow=1)", v is { run: 1, flow: 1 } && sawCmdFirst, $"chuỗi {string.Join(" → ", seq)}, sau {(DateTime.Now - t0).TotalSeconds:0.0} s");
            err = await rf.WriteAsync("pump1", "run", 0);
            for (var k = 0; k < 40 && v is not { run: 0, flow: 0 }; k++) { await Task.Delay(250); v = await Vals(); }
            Check("tắt: run=0 và DI về 0", v is { run: 0, flow: 0 } && err == null, $"{v}");
            rf.ShowPage(1); await Task.Delay(800); SaveForm(rf, Path.Combine(outDir, "fb-devices.png"));
            DeviceDialog.Remove(rf, "pump1"); await rf.ApplyAsync("fbtest: dọn");
        }
        catch (Exception e) { Check("chạy kiểm thử", false, RemoteClient.Explain(e) + " " + e.GetType().Name + ": " + e.Message); }
        File.WriteAllLines(Path.Combine(outDir, "fbtest-result.txt"), log);
        rf?.Close();
        await StopAsync();
        Close();
    }
}
