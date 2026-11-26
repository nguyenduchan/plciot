using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử CHƯƠNG TRÌNH LOGIC trên BOARD WAVESHARE THẬT (firmware ≥ mcu-0.4.0) theo từng nguồn I/O — bản Debug:
///   GatewayApp.exe --boardlogictest THƯ_MỤC --lan-target IP_BOARD:443 [--tcp-port 15020]
///   (GATEWAYAPP_SETTINGS = file thử riêng; lần đầu cần nhấn BOOT trên board để ghép PC test.)
/// Nguồn I/O:
///   Digital    — DO1..DO3 / DI1 của chính board (Modbus RTU Unit 0)
///   Modbus TCP — PLC GIẢ chạy ngay trong tiến trình này (cổng --tcp-port trên PC), board đọc/ghi qua mạng thật
///   RS485      — biến tần Unit 7 KHÔNG có trên bus: kịch bản "thiết bị RS485 mất kết nối" (trạng thái không rõ → liên động chặn)
/// Trình tự: sao lưu cấu hình + chương trình của board → cài thiết bị thử + chương trình → kiểm từng kịch bản → TRẢ LẠI nguyên trạng
/// (cấu hình, chương trình, DO tắt). Kết quả: boardlogictest-result.txt (FAIL = lỗi). Relay DO1/DO3 sẽ đóng/ngắt thật trong lúc chạy.
/// </summary>
public sealed partial class MainForm
{
    public async Task BoardLogicTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void L(string s) { log.Add(s); File.WriteAllLines(Path.Combine(outDir, "boardlogictest-result.txt"), log); }
        void Check(string name, bool ok, string detail = "") => L($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}");
        var args = RunOptions.Args;
        var target = ArgValue(args, "--lan-target");
        var i = target.LastIndexOf(':');
        var host = i > 0 ? target[..i] : target; var port = i > 0 ? int.Parse(target[(i + 1)..]) : 443;
        var tcpPort = int.TryParse(ArgValue(args, "--tcp-port"), out var tp) ? tp : 15020;
        var plc = new MiniModbusSlave(tcpPort);
        RemoteClient? c = null; ApiConfig? backupCfg = null; ApiOffline? backupProg = null;
        try
        {
            TrustedBoards.FilePath = Path.Combine(outDir, "remote-boards.json");
            // ---- ghép PC test (nhấn BOOT trên board) — chờ tối đa 15 phút
            for (var k = 0; k < 300 && c == null; k++)
            {
                try { c = (await RemoteClient.ConnectMcuAsync(host, port, Identity(), _ => true)).Client; }
                catch (Exception e) { File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), $"{DateTime.Now:HH:mm:ss} chờ nhấn BOOT trên board — {e.Message}"); await Task.Delay(3000); }
            }
            Check("ghép / đăng nhập board", c != null);
            if (c == null) return;
            File.WriteAllText(Path.Combine(outDir, "pair-status.txt"), "paired");
            var st0 = await c.StateAsync();
            L($"board: mode={st0.Mode} cloud={st0.Cloud} status={st0.Status}");

            // ---- sao lưu
            backupCfg = await c.ConfigAsync();
            backupProg = await c.OfflineAsync();
            File.WriteAllText(Path.Combine(outDir, "backup-config.json"), JsonSerializer.Serialize(backupCfg, new JsonSerializerOptions { WriteIndented = true }));
            File.WriteAllText(Path.Combine(outDir, "backup-offline.json"), JsonSerializer.Serialize(backupProg, new JsonSerializerOptions { WriteIndented = true }));
            L($"đã sao lưu cấu hình ({backupCfg.Config.Pack.Count} field) + chương trình (rev {backupProg.Rev}, {backupProg.Do.Count} mục)");

            // ---- PLC giả (Modbus TCP) + cấu hình thiết bị thử
            plc.Start();
            var pcIp = LocalIpFor(host);
            L($"PLC giả Modbus TCP: {pcIp}:{tcpPort}");
            static PackMap F(string child, string field, int addr, string proto, int unit, PackAccess acc = PackAccess.ReadWrite) =>
                new() { Child = child, Field = field, Address = addr, Protocol = proto, Access = acc, Params = new() { ["unit"] = unit.ToString() } };
            var cfg = JsonSerializer.Deserialize<ApiConfig>(JsonSerializer.Serialize(backupCfg))!;
            cfg.Config.Pack = new()
            {
                F("board", "do1", 20, "ModbusRtu", 0), F("board", "do2", 21, "ModbusRtu", 0), F("board", "do3", 22, "ModbusRtu", 0),
                F("board", "di1", 10, "ModbusRtu", 0, PackAccess.Read),
                F("vfd", "run", 200, "ModbusRtu", 7, PackAccess.Write),                       // RS485: không có trên bus
                F("plc", "valve", 100, "ModbusTcp", 1), F("plc", "apsuat", 101, "ModbusTcp", 1, PackAccess.Read),
                F("plc", "cmd", 102, "ModbusTcp", 1, PackAccess.Write),
            };
            var rtu = backupCfg.Config.Connections.FirstOrDefault(x => x.Protocol == PlcSource.ModbusRtu)
                      ?? new PlcConnection { Protocol = PlcSource.ModbusRtu, Port = 19200, Options = new() { ["parity"] = "Even" } };
            cfg.Config.Connections = new() { rtu, new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = pcIp, Port = tcpPort } };
            var pr = await c.PutConfigAsync(cfg);
            Check("cài thiết bị thử (Digital + RS485 + Modbus TCP)", pr.Ok, pr.Err ?? "");
            plc.Reg[101] = 0;
            var seen = await Until(async () => (await c.StateAsync()).Values.ContainsKey("plc.apsuat"), 15);
            Check("board đọc được PLC Modbus TCP qua mạng", seen && plc.Requests > 0, $"requests={plc.Requests}");

            // ---- chương trình
            var rev = (await c.OfflineAsync()).Rev;
            try { await c.PutOfflineAsync(new ApiOffline { Rev = rev, Do = new() { new OfflineRule { Out = "board.di1", Mode = "off" } } }); Check("từ chối đầu ra là DI chỉ đọc", false); }
            catch (RemoteException e) { Check("từ chối đầu ra là DI chỉ đọc", e.Message.Contains("không phải field ghi được") || RemoteClient.Explain(e).Contains("không phải field ghi được"), RemoteClient.Explain(e)); }
            var prog = new ApiOffline
            {
                Rev = (await c.OfflineAsync()).Rev,
                Do = new()
                {
                    new OfflineRule { Out = "plc.valve", Need = new() { new OfflineCond { Field = "plc.apsuat", Op = ">=", Val = 2, MaxAgeSec = 30 } }, NeedHold = true, Block = new() { 1 } },
                    new OfflineRule { Ch = 2, Block = new() { "vfd.run" } },
                    new OfflineRule { Ch = 3, Mode = "threshold", Field = "plc.apsuat", On = 5, Off = 1, MaxAgeSec = 30, DelaySec = 0 },
                    new OfflineRule { Out = "plc.cmd", Mode = "follow", Field = "plc.apsuat", DelaySec = 0 },
                },
            };
            var saved = await c.PutOfflineAsync(prog);
            var got = await c.OfflineAsync();
            Check("lưu chương trình trộn DO + RS485 + Modbus TCP", saved.Ok && got.Do.Any(x => x.Out == "plc.valve") && got.Do.Any(x => x.Out == "plc.cmd"),
                string.Join(" | ", got.Do.Select(x => $"{x.Out ?? "DO" + x.Ch}:{x.Mode}")));
            Check("liên động hai chiều có trong trạng thái", got.Status?.Ch.Any(x => x.Key == "plc.valve") == true);

            async Task<string> W(string ch, string f, double v) { try { var r = await c.WriteAsync(ch, f, v); return r.Ok ? "ok" : r.Err ?? "?"; } catch (RemoteException e) { return e.Code; } }
            async Task<double?> V(string k) => (await c.StateAsync()).Values.TryGetValue(k, out var x) ? x : null;

            // ---- Modbus TCP: điều kiện theo giá trị PLC
            plc.Reg[101] = 0; plc.Reg[100] = 0; await Task.Delay(2500);
            Check("TCP: áp suất 0 → không cho mở van (logic_need)", await W("plc", "valve", 1) == "logic_need");
            plc.Reg[101] = 3; await Task.Delay(2500);
            var w1 = await W("plc", "valve", 1);
            Check("TCP: áp suất 3 → mở van, PLC nhận lệnh", w1 == "ok" && plc.Reg[100] == 1, $"{w1} D100={plc.Reg[100]}");
            // ---- Digital ↔ TCP: liên động hai chiều
            await Task.Delay(1500);
            Check("liên động: van PLC đang mở → chặn bật DO1", await W("board", "do1", 1) == "logic_interlock");
            await W("plc", "valve", 0); await Task.Delay(1500);
            var w2 = await W("board", "do1", 1);
            Check("van đóng → DO1 bật được", w2 == "ok", w2);
            await Task.Delay(1500);
            Check("liên động ngược: DO1 đang bật → chặn mở van PLC", await W("plc", "valve", 1) == "logic_interlock");
            await W("board", "do1", 0);
            // ---- hold: mất điều kiện → tự đóng van
            await Task.Delay(1500);
            await W("plc", "valve", 1);
            plc.Reg[101] = 0;
            var held = await Until(() => Task.FromResult(plc.Reg[100] == 0), 12);
            var why = (await c.OfflineAsync()).Status?.Ch.FirstOrDefault(x => x.Key == "plc.valve")?.GuardWhy ?? "";
            Check("hold: áp suất về 0 → board tự đóng van PLC", held, why);
            // ---- RS485: thiết bị không trả lời
            var w3 = await W("board", "do2", 1);
            var st = (await c.OfflineAsync()).Status?.Ch.FirstOrDefault(x => x.Ch == 2)?.GuardWhy ?? "";
            Check("RS485 mất kết nối: không rõ trạng thái biến tần → chặn bật DO2", w3 == "logic_interlock" && st.Contains("không rõ"), $"{w3} — {st}");
            var w4 = await W("vfd", "run", 0);
            Check("RS485 mất kết nối: lệnh TẮT không bị logic chặn, chỉ lỗi bus", w4 is "plc_error" or "ok", w4);
            // ---- Modbus TCP mất kết nối
            plc.Stop();
            var stale = await Until(async () => (await c.OfflineAsync()).Status?.Ch.FirstOrDefault(x => x.Key == "plc.valve")?.State == -1, 40);
            Check("TCP mất kết nối: van chuyển sang KHÔNG RÕ", stale);
            var w5 = await W("board", "do1", 1);
            Check("TCP mất kết nối: chặn bật DO1 (liên động không rõ trạng thái)", w5 == "logic_interlock", w5);
            plc.Start();
            var back = await Until(async () => (await c.OfflineAsync()).Status?.Ch.FirstOrDefault(x => x.Key == "plc.valve")?.State == 0, 30);
            var w6 = back ? await W("board", "do1", 1) : "chưa nối lại";
            Check("TCP nối lại → DO1 bật được", w6 == "ok", w6);
            await W("board", "do1", 0);
            // ---- thử mất mạng: TCP → DO3 (ngưỡng) và TCP → TCP chỉ ghi (follow)
            plc.Reg[101] = 0; await Task.Delay(2000);
            var tr = await c.OfflineTestAsync(90);
            Check("bắt đầu thử mất mạng", tr.Ok, tr.Err ?? "");
            plc.Reg[101] = 6;
            var on3 = await Until(async () => await V("board.do3") == 1 && plc.Reg[102] == 1, 15);
            Check("mất mạng: áp suất 6 → DO3 bật (ngưỡng) + PLC.cmd = 1 (follow)", on3, $"do3={await V("board.do3")} D102={plc.Reg[102]}");
            plc.Reg[101] = 0;
            var off3 = await Until(async () => await V("board.do3") == 0 && plc.Reg[102] == 0, 15);
            Check("mất mạng: áp suất 0 → DO3 tắt + PLC.cmd = 0", off3, $"do3={await V("board.do3")} D102={plc.Reg[102]}");
            await c.OfflineTestAsync(0);
            // ---- bản tin config gửi cloud có đầu ra field
            var cm = await c.ConfigMessageAsync();
            var lg = cm.TryGetProperty("logic", out var x1) ? x1 : default;
            var hasOut = lg.ValueKind == JsonValueKind.Object && lg.TryGetProperty("names", out var nm) && nm.TryGetProperty("out", out var no) && no.TryGetProperty("plc.valve", out _)
                         && lg.TryGetProperty("keys", out var ks) && ks.TryGetProperty("plc.valve", out _);
            Check("bản tin config cho cloud: tên + nút của đầu ra field", hasOut);
        }
        catch (Exception e) { L("FAIL ngoại lệ: " + e); }
        finally
        {
            // ---- trả lại nguyên trạng
            if (c != null && backupCfg != null)
            {
                try
                {
                    try { await c.OfflineTestAsync(0); } catch (Exception) { }
                    foreach (var d in new[] { "do1", "do2", "do3" }) { try { await c.WriteAsync("board", d, 0); } catch (Exception) { } }
                    var cur = await c.OfflineAsync();
                    await c.PutOfflineAsync(new ApiOffline { Rev = cur.Rev, TzMin = backupProg!.TzMin, Do = backupProg.Do });
                    var r = await c.PutConfigAsync(backupCfg);
                    var after = await c.ConfigAsync();
                    Check("trả lại cấu hình + chương trình ban đầu", r.Ok && after.Config.Pack.Count == backupCfg.Config.Pack.Count, $"{after.Config.Pack.Count} field");
                }
                catch (Exception e) { L("FAIL trả lại nguyên trạng: " + e.Message + " — dùng backup-config.json / backup-offline.json"); }
            }
            plc.Stop();
            L($"RESULT={(log.Any(x => x.StartsWith("FAIL")) ? "FAIL" : "PASS")}");
            Application.Exit();
        }
    }

    static async Task<bool> Until(Func<Task<bool>> ok, int sec)
    {
        for (var k = 0; k < sec * 2; k++) { try { if (await ok()) return true; } catch (Exception) { } await Task.Delay(500); }
        return false;
    }

    static string LocalIpFor(string host)
    {
        using var s = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
        s.Connect(host, 9);
        return ((IPEndPoint)s.LocalEndPoint!).Address.ToString();
    }

    /// <summary>PLC Modbus TCP tối giản cho kiểm thử: FC03 / FC06 / FC16 trên 300 thanh ghi, mọi Unit ID.</summary>
    sealed class MiniModbusSlave(int port)
    {
        public readonly ushort[] Reg = new ushort[300];
        public int Requests;
        TcpListener? _l; CancellationTokenSource? _cts;
        readonly List<TcpClient> _clients = new();

        public void Start()
        {
            _cts = new(); _l = new TcpListener(IPAddress.Any, port); _l.Start();
            var ct = _cts.Token;
            _ = Task.Run(async () =>
            {
                while (!ct.IsCancellationRequested)
                {
                    TcpClient cl;
                    try { cl = await _l.AcceptTcpClientAsync(ct); } catch (Exception) { return; }
                    lock (_clients) _clients.Add(cl);
                    _ = Task.Run(() => Serve(cl, ct));
                }
            });
        }

        public void Stop()
        {
            _cts?.Cancel(); try { _l?.Stop(); } catch (Exception) { }
            lock (_clients) { foreach (var cl in _clients) try { cl.Close(); } catch (Exception) { } _clients.Clear(); }
        }

        async Task Serve(TcpClient cl, CancellationToken ct)
        {
            using var _ = cl; var s = cl.GetStream(); var h = new byte[7];
            try
            {
                while (!ct.IsCancellationRequested)
                {
                    await s.ReadExactlyAsync(h, ct);
                    var len = (h[4] << 8) | h[5];
                    var pdu = new byte[len - 1];
                    await s.ReadExactlyAsync(pdu, ct);
                    Interlocked.Increment(ref Requests);
                    byte[] resp;
                    int a = (pdu[1] << 8) | pdu[2], n = (pdu[3] << 8) | pdu[4];
                    switch (pdu[0])
                    {
                        case 3 when a + n <= Reg.Length:
                            resp = new byte[2 + n * 2]; resp[0] = 3; resp[1] = (byte)(n * 2);
                            for (var k = 0; k < n; k++) { resp[2 + k * 2] = (byte)(Reg[a + k] >> 8); resp[3 + k * 2] = (byte)Reg[a + k]; }
                            break;
                        case 6 when a < Reg.Length: Reg[a] = (ushort)n; resp = pdu[..5]; break;
                        case 16 when a + n <= Reg.Length:
                            for (var k = 0; k < n; k++) Reg[a + k] = (ushort)((pdu[6 + k * 2] << 8) | pdu[7 + k * 2]);
                            resp = pdu[..5]; break;
                        default: resp = new byte[] { (byte)(pdu[0] | 0x80), 2 }; break;
                    }
                    var o = new byte[7 + resp.Length];
                    Array.Copy(h, o, 4); o[4] = (byte)((resp.Length + 1) >> 8); o[5] = (byte)(resp.Length + 1); o[6] = h[6];
                    resp.CopyTo(o, 7);
                    await s.WriteAsync(o, ct);
                }
            }
            catch (Exception) { }
        }
    }
}
