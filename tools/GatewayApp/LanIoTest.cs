using System.Globalization;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử I/O + RS485 + Modbus TCP trên board ESP32 giả lập (--iotest THƯ_MỤC --lan-target IP:CỔNG --io-data THƯ_MỤC_SIMDATA [--lan-mb 5020]):
/// chạy tools/esp32_field_sim.py (RS485 giả :5485, Modbus TCP :5020, ghi di.txt) và gw-sim với SIM_RS485_TCP=127.0.0.1:5485 + cùng SIM_DATA.
/// Thiết lập HOÀN TOÀN bằng hộp thoại thiết bị của GatewayApp: (1) DI/DO trên board (Unit 0), (2) slave RS485 Unit 1, (3) PLC Modbus TCP.
/// Kết quả: iotest-result.txt (FAIL = lỗi).
/// </summary>
public sealed partial class MainForm
{
    public async Task IoTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") => log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target"); var data = ArgValue(args, "--io-data");
        var mb = int.TryParse(ArgValue(args, "--lan-mb"), out var m) ? m : 5020;
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
            if (first.Config.Pack.Count > 0) await rf.ApplyAsync("iotest: dọn thiết bị cũ");

            static Action<DataGridView> Keep(params (string name, string addr)[] f) => g =>
            {
                for (var k = g.Rows.Count - 1; k >= 0; k--)
                    if (!g.Rows[k].IsNewRow && !f.Any(x => x.name == Convert.ToString(g.Rows[k].Cells[0].Value))) g.Rows.RemoveAt(k);
                foreach (DataGridViewRow r in g.Rows)
                    if (f.FirstOrDefault(x => x.name == Convert.ToString(r.Cells[0].Value)) is { name: not null } x) { r.Cells[5].Value = x.addr; r.Cells[6].Value = "1"; }
            };
            var rtu = new Dictionary<string, string> { ["parity"] = "Even" };
            // (1) DI/DO trên board: Modbus RTU Unit 0. run <- DO1 (D20), flow <- DI1 (D10)
            var e1 = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusRtu, "RS485", 9600, new() { ["parity"] = "Even", ["difilter"] = "200" }, new() { ["unit"] = "0" }, Keep(("run", "20"), ("flow", "10")));
            // (2) slave RS485 (giả lập qua TCP) Unit 1: run <- D10 (ghi được), flow <- D1 (bộ đếm +1/giây)
            var e2 = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusRtu, "RS485", 9600, rtu, new() { ["unit"] = "1" }, Keep(("run", "10"), ("flow", "1")));
            // (3) PLC Modbus TCP Unit 1, cùng ngân hàng thanh ghi: run <- D11, flow <- D0 (nhiệt độ x10)
            var e3 = AddDeviceViaDialog(rf, "pump", PlcSource.ModbusTcp, "127.0.0.1", mb, new(), new() { ["unit"] = "1" }, Keep(("run", "11"), ("flow", "0")));
            Check("thêm 3 thiết bị (DI/DO board, RS485, Modbus TCP) bằng hộp thoại", e1.Length + e2.Length + e3.Length == 0, $"{e1}|{e2}|{e3}");
            // (4) bộ đếm cạnh lên của DI1 (mẫu "bộ đếm" chọn khi thêm thiết bị): cnt1 <- D30, ghi 0 để đặt lại
            var e4 = AddDeviceViaDialog(rf, "dicount", PlcSource.ModbusRtu, "RS485", 9600, new() { ["parity"] = "Even", ["difilter"] = "200" }, new() { ["unit"] = "0" }, Keep(("cnt1", "30")));
            Check("thêm bộ đếm cạnh DI1 bằng mẫu 'bộ đếm' (địa chỉ D30)", e4.Length == 0, e4);
            var kids = rf.Config.Pack.Select(p => p.Child).Distinct().ToList();
            await rf.ApplyAsync("iotest: thêm 3 thiết bị");
            string io = kids[0], rs = kids[1], tcp = kids[2];
            log.Add($"thiết bị: board={io} rs485={rs} tcp={tcp}");

            async Task<Dictionary<string, double>> St() => (await c.StateAsync()).Values;
            async Task<bool> Wait(Func<Dictionary<string, double>, bool> ok, int sec = 12) { for (var k = 0; k < sec * 4; k++) { if (ok(await St())) return true; await Task.Delay(250); } return false; }
            double V(Dictionary<string, double> v, string k) => v.TryGetValue(k, out var x) ? x : double.NaN;
            var diFile = Path.Combine(data, "di.txt"); var doFile = Path.Combine(data, "do.txt");

            File.WriteAllText(diFile, "0");
            Check("DI1=0 lúc đầu", await Wait(v => V(v, $"{io}.flow") == 0));
            File.WriteAllText(diFile, "1");
            Check("bật DI1 → board đọc flow=1 về GatewayApp", await Wait(v => V(v, $"{io}.flow") == 1));
            File.WriteAllText(diFile, "0");
            Check("tắt DI1 → flow=0", await Wait(v => V(v, $"{io}.flow") == 0));
            var err = await rf.WriteAsync(io, "run", 1);
            await Task.Delay(1500);
            var doTxt = File.Exists(doFile) ? File.ReadAllText(doFile).Trim() : "";
            Check("ghi DO1=1 → do.txt = 1 và đọc lại run=1", err == null && doTxt == "1" && V(await St(), $"{io}.run") == 1, $"err={err} do.txt={doTxt}");
            await rf.WriteAsync(io, "run", 0);

            double a = double.NaN;
            Check("RS485 unit 1 đọc được (bộ đếm)", await Wait(v => !double.IsNaN(a = V(v, $"{rs}.flow"))), $"{a}");
            await Task.Delay(2500); var b = V(await St(), $"{rs}.flow");
            Check("RS485 bộ đếm tăng theo thời gian", b > a, $"{a}→{b}");
            err = await rf.WriteAsync(rs, "run", 1);
            Check("RS485 ghi D10=1 rồi đọc lại", err == null && await Wait(v => V(v, $"{rs}.run") == 1), err ?? "");
            err = await rf.WriteAsync(tcp, "run", 1);
            Check("Modbus TCP ghi D11=1 rồi đọc lại", err == null && await Wait(v => V(v, $"{tcp}.run") == 1), err ?? "");
            var t = V(await St(), $"{tcp}.flow");
            Check("Modbus TCP đọc nhiệt độ D0 (x10, 200..300)", t is > 150 and < 350, $"{t}");
            // lọc rung (200 ms) + bộ đếm cạnh lên
            var cn = kids.First(k => k.StartsWith("cnt")); var ck = $"{cn}.cnt1";
            var cfgDf = (await c.ConfigAsync()).Config.Connections.FirstOrDefault(k => k.Protocol == PlcSource.ModbusRtu);
            Check("tuỳ chọn lọc rung (200 ms) đã lưu lên board", cfgDf?.Opt("difilter") == "200", cfgDf?.Opt("difilter"));
            await rf.WriteAsync(cn, "cnt1", 0);
            Check("đặt lại bộ đếm = 0", await Wait(v => V(v, ck) == 0));
            File.WriteAllText(diFile, "1"); await Task.Delay(60); File.WriteAllText(diFile, "0");   // nhiễu 60 ms < 200 ms
            await Task.Delay(1500);
            Check("nhiễu 60 ms bị lọc (bộ đếm vẫn 0)", V(await St(), ck) == 0, $"{V(await St(), ck)}");
            File.WriteAllText(diFile, "1");   // mức thật giữ lâu
            Check("DI giữ ổn định → bộ đếm +1", await Wait(v => V(v, ck) == 1), $"{V(await St(), ck)}");
            File.WriteAllText(diFile, "0"); await Task.Delay(800);
            File.WriteAllText(diFile, "1"); await Task.Delay(800); File.WriteAllText(diFile, "0"); await Task.Delay(800);
            Check("thêm một xung nữa → bộ đếm = 2", await Wait(v => V(v, ck) == 2), $"{V(await St(), ck)}");
            // (5) LEASE chế độ gateway: board độc lập ↔ gateway (Modbus TCP slave cho PC giữ lease). Cổng slave: --lan-mbs (mặc định 5502).
            var mbs = int.TryParse(ArgValue(args, "--lan-mbs"), out var mp) ? mp : 5502;
            static async Task<byte[]?> Mb(string h, int pt, byte unit, params byte[] pdu)
            {
                try
                {
                    using var tc = new System.Net.Sockets.TcpClient(); using var cts = new CancellationTokenSource(2500);
                    await tc.ConnectAsync(h, pt, cts.Token);
                    var ns = tc.GetStream(); var req = new byte[7 + pdu.Length];
                    req[1] = 1; req[4] = (byte)((pdu.Length + 1) >> 8); req[5] = (byte)(pdu.Length + 1); req[6] = unit; pdu.CopyTo(req, 7);
                    await ns.WriteAsync(req, cts.Token);
                    var hd = new byte[7]; var got = 0;
                    while (got < 7) { var n = await ns.ReadAsync(hd.AsMemory(got), cts.Token); if (n == 0) return null; got += n; }
                    var body = new byte[((hd[4] << 8) | hd[5]) - 1]; got = 0;
                    while (got < body.Length) { var n = await ns.ReadAsync(body.AsMemory(got), cts.Token); if (n == 0) return null; got += n; }
                    return body;
                }
                catch (Exception) { return null; }
            }
            static int W(byte[]? r) => r is { Length: >= 4 } && r[0] == 3 ? (r[2] << 8) | r[3] : -1;
            Check("mặc định board chạy ĐỘC LẬP", (await c.StateAsync()).Mode == "standalone");
            Check("chưa có lease → Modbus TCP slave từ chối", await Mb(host, mbs, 0, 3, 0, 10, 0, 1) == null);
            var ls = await c.LeaseAsync(true, 8);
            Check("xin lease → chế độ GATEWAY", ls.Ok && ls.Mode == "gateway" && ls.Port == mbs, $"{ls.Mode}:{ls.Port}");
            var gs = await c.StateAsync();
            Check("state báo gateway, cloud tạm dừng", gs.Mode == "gateway" && gs.Cloud == "Disabled", $"{gs.Mode}/{gs.Cloud}");
            File.WriteAllText(diFile, "1"); await Task.Delay(700);
            Check("Modbus TCP Unit 0: FC03 D10 = DI1 = 1", W(await Mb(host, mbs, 0, 3, 0, 10, 0, 1)) == 1);
            var fc2 = await Mb(host, mbs, 0, 2, 0, 0, 0, 8);
            Check("Modbus TCP Unit 0: FC02 discrete input DI1 = 1", fc2 is { Length: 3 } && (fc2[2] & 1) == 1);
            var wr5 = await Mb(host, mbs, 0, 5, 0, 2, 0xFF, 0);
            Check("Modbus TCP Unit 0: FC05 bật coil DO3", wr5 is { Length: 5 } && wr5[0] == 5);
            var fc1 = await Mb(host, mbs, 0, 1, 0, 0, 0, 8);
            Check("FC01 đọc coil: DO3 = 1", fc1 is { Length: 3 } && (fc1[2] & 4) == 4);
            Check("FC03 D22 (DO3) = 1", W(await Mb(host, mbs, 0, 3, 0, 22, 0, 1)) == 1);
            await Mb(host, mbs, 0, 6, 0, 22, 0, 0);
            Check("FC06 ghi D22 = 0 → DO3 tắt", W(await Mb(host, mbs, 0, 3, 0, 22, 0, 1)) == 0);
            Check("Modbus TCP Unit 0: ghi DI (D10) bị từ chối", (await Mb(host, mbs, 0, 6, 0, 10, 0, 1)) is { Length: 2 } e5 && e5[0] == 0x86);
            Check("coil với Unit ≠ 0 → illegal function", (await Mb(host, mbs, 1, 1, 0, 0, 0, 1)) is { Length: 2 } e6 && e6[1] == 1);
            await Mb(host, mbs, 1, 6, 0, 10, 0, 7);
            Check("CẦU RS485: ghi/đọc slave Unit 1 D10 = 7 (board là master RS485)", W(await Mb(host, mbs, 1, 3, 0, 10, 0, 1)) == 7);
            await c.LeaseAsync(true, 8);   // gia hạn
            Check("trong chế độ gateway board không poll thiết bị ngoài (field RS485 ngừng cập nhật)", await Wait(v => double.IsNaN(V(v, $"{rs}.flow"))), $"{V(await St(), $"{rs}.flow")}");
            var rel = await c.LeaseAsync(false);
            Check("trả lease → về ĐỘC LẬP, slave đóng", rel.Mode == "standalone" && await Mb(host, mbs, 0, 3, 0, 10, 0, 1) == null);
            Check("độc lập: board poll lại thiết bị ngoài", await Wait(v => !double.IsNaN(V(v, $"{rs}.flow"))));
            await c.LeaseAsync(true, 5);
            await Task.Delay(7500);
            Check("mất nhịp tim quá hạn → tự về ĐỘC LẬP", (await c.StateAsync()).Mode == "standalone");
            File.WriteAllText(diFile, "0");
            rf.ShowPage(1); await Task.Delay(800); SaveForm(rf, Path.Combine(outDir, "io-devices.png"));
            foreach (var k in kids) DeviceDialog.Remove(rf, k);
            await rf.ApplyAsync("iotest: dọn");
        }
        catch (Exception e) { Check("chạy kiểm thử", false, RemoteClient.Explain(e) + " " + e.GetType().Name + ": " + e.Message); }
        File.WriteAllLines(Path.Combine(outDir, "iotest-result.txt"), log);
        rf?.Close();
        await StopAsync();
        Close();
    }
}
