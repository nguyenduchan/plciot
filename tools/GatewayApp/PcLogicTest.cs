using System.Text.Json;
using Plciot.Scada;

namespace GatewayApp;

/// <summary>
/// Kiểm thử CHƯƠNG TRÌNH LOGIC trên gateway PC với PLC giả lập PlcSim (bản Debug):
///   GATEWAYAPP_SETTINGS=&lt;file thử&gt; GatewayApp.exe --pclogictest THƯ_MỤC --noauth --plc 127.0.0.1:PORT [--cloud-down]
/// PlcSim chạy Modbus TCP với: pump1.run D51, pump1.boost D55 (ghi), pump1.ok D56, tank1.level D50 (gateway chỉ đọc; bài thử đổi trực tiếp
/// trên PlcSim qua Modbus như cảm biến thật). Đi đúng đường API: PUT/GET /api/offline, ghi lệnh như màn hình gateway, rpc từ xa không có mã duyệt.
/// --cloud-down: bật cloud tới một địa chỉ không có broker → "mất mạng" THẬT (không phải nút thử). Kết quả: pclogictest-result.txt (FAIL = lỗi).
/// </summary>
public sealed partial class MainForm
{
    public async Task PcLogicTestAsync(string outDir)
    {
        Directory.CreateDirectory(outDir);
        var log = new List<string>();
        void Check(string name, bool ok, string detail = "") { log.Add($"{(ok ? "PASS" : "FAIL")} {name}{(detail.Length > 0 ? " — " + detail : "")}"); File.WriteAllLines(Path.Combine(outDir, "pclogictest-result.txt"), log); }
        var args = RunOptions.Args;
        var target = ArgValue(args, "--plc"); var i = target.LastIndexOf(':');
        var host = target[..i]; var port = int.Parse(target[(i + 1)..]);
        var cloudDown = args.Contains("--cloud-down");
        using var plc = new ModbusTcpClient(host, port, 1);
        async Task Set(int d, ushort v) { await plc.WriteAsync(d, v); }
        async Task<int> Get(int d) => (await plc.ReadAsync(d, 1))[0];
        async Task<bool> Wait(Func<Task<bool>> ok, int sec) { for (var k = 0; k < sec * 4; k++) { if (await ok()) return true; await Task.Delay(250); } return false; }
        try
        {
            if (File.Exists(LogicPath)) File.Delete(LogicPath);
            await StopAsync();
            PackMap P(string c, string f, int d, PackAccess a) => new() { Child = c, Field = f, MqttKey = f, Address = d, Protocol = "ModbusTcp", Access = a, Params = new() { ["unit"] = "1" } };
            _cfg.Source = PlcSource.ModbusTcp; _cfg.PlcHost = host; _cfg.PlcPort = port; _cfg.PollMs = 200;
            _cfg.Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = host, Port = port } };
            _cfg.Pack = new() { P("pump1", "run", 51, PackAccess.ReadWrite), P("pump1", "boost", 55, PackAccess.ReadWrite), P("pump1", "ok", 56, PackAccess.Read), P("tank1", "level", 50, PackAccess.Read) };
            if (cloudDown)
            {   // cloud bật nhưng không có broker ở đó → đường cloud luôn mất = "mất mạng" thật
                _cfg.Mobile = MobileAccess.MonitorOnly; _cfg.CloudHost = "127.0.0.1"; _cfg.CloudPort = 1; _cfg.MqttId = "0123456789abcdef";
                _cfg.CloudUser = "gw"; _cfg.CloudPassword = "x"; _cfg.CloudPinSha256 = new string('0', 64);
            }
            else _cfg.Mobile = MobileAccess.Off;
            foreach (var (d, v) in new[] { (51, 0), (55, 0), (56, 0), (50, 50) }) await Set(d, (ushort)v);
            await StartAsync();
            Check("gateway chạy với PlcSim", _host != null && await Wait(() => Task.FromResult(_host!.Core.State.Status == "online"), 10), _host?.Core.State.Status ?? "không chạy");

            async Task<(int St, JsonElement J)> Api(string m, string p, object? b = null)
            {
                var (st, json) = await HandleApi(m, p, b == null ? "" : JsonSerializer.Serialize(b));
                return (st, JsonDocument.Parse(json).RootElement.Clone());
            }
            var g = await Api("GET", "/api/offline");
            var rev0 = g.J.GetProperty("Rev").GetUInt32();
            Check("GET /api/offline (chưa có chương trình)", g.St == 200 && g.J.GetProperty("Do").GetArrayLength() == 0, $"rev {rev0}");

            // ---- chương trình sai → câu báo lỗi, không lưu
            var bad = await Api("PUT", "/api/offline", new { Rev = rev0, Do = new[] { new { Out = "pump1.ok", Mode = "off" } } });
            Check("đầu ra là field chỉ đọc → từ chối", bad.St == 400 && bad.J.GetProperty("Err").GetString()!.Contains("chỉ đọc"), bad.J.ToString());

            // ---- chặn lệnh + tự tắt
            var now = DateTime.UtcNow.AddHours(7);
            var prog = new
            {
                Rev = rev0, TzMin = 420,
                Do = new object[]
                {
                    new { Out = "pump1.run", Mode = "threshold", Field = "tank1.level", On = 20.0, Off = 90.0, MaxAgeSec = 30, DelaySec = cloudDown ? 5 : 60,
                          Need = new[] { new { Field = "pump1.ok", Op = ">=", Val = 1.0 } }, NeedHold = true, Block = new[] { "pump1.boost" } },
                    new { Out = "pump1.boost", Mode = "off", DelaySec = cloudDown ? 5 : 60, MaxOnSec = 3,
                          Timer = new[] { new { On = now.AddMinutes(1).ToString("HH:mm"), Off = now.AddMinutes(2).ToString("HH:mm") } } },
                },
            };
            var put = await Api("PUT", "/api/offline", prog);
            Check("PUT /api/offline → lưu + nạp", put.St == 200 && put.J.GetProperty("Rev").GetUInt32() == rev0 + 1, put.J.ToString());
            Check("file chương trình đã lưu", File.Exists(LogicPath) && ReadLogicFile().Do.Count == 2);
            var stale = await Api("PUT", "/api/offline", prog);
            Check("PUT với Rev cũ → rev_conflict", stale.St == 409, stale.J.ToString());
            var remote = await HandleRpcAsync("PUT", "/api/offline", JsonSerializer.Serialize(prog));
            Check("PUT từ xa KHÔNG có mã duyệt chủ trạm → owner_approval_required", remote.Status == 403 && remote.Json.Contains("owner_approval_required"), remote.Json);
            var rtest = await HandleRpcAsync("POST", "/api/offline/test", "{\"Sec\":5}");
            Check("thử mất mạng từ xa → chặn", rtest.Status == 403, rtest.Json);

            await Task.Delay(600);
            var e1 = await WriteAsync("pump1", "run", 1);
            Check("bật bơm khi pump1.ok = 0 → logic_need, PLC không đổi", e1 != null && e1.Contains("logic_need") && await Get(51) == 0, $"{e1} D51={await Get(51)}");
            await Set(56, 1);
            Check("pump1.ok = 1 → bật được", await Wait(async () => await WriteAsync("pump1", "run", 1) == null && await Get(51) == 1, 4), $"D51={await Get(51)}");
            var e2 = await WriteAsync("pump1", "boost", 1);
            Check("bật bơm tăng áp khi bơm chạy → logic_interlock", e2 != null && e2.Contains("logic_interlock") && await Get(55) == 0, e2 ?? "");
            await Set(56, 0);
            Check("pump1.ok mất → bơm TỰ TẮT (hold)", await Wait(async () => await Get(51) == 0, 4), $"D51={await Get(51)}");
            Check("tắt luôn được", await WriteAsync("pump1", "run", 0) == null);
            Check("bơm tăng áp bật được khi bơm tắt", await WriteAsync("pump1", "boost", 1) == null && await Get(55) == 1);
            Check("maxon 3 s → bơm tăng áp tự tắt", await Wait(async () => await Get(55) == 0, 6), $"D55={await Get(55)}");
            var st = await Api("GET", "/api/offline");
            Check("trạng thái báo lý do tự tắt", st.J.GetProperty("Status").GetProperty("Ch").EnumerateArray().Any(c => c.GetProperty("GuardWhy").GetString()!.Contains("tự tắt")), st.J.GetProperty("Status").ToString());

            // ---- khi mất mạng: ngưỡng mức bồn (bơm cần pump1.ok = 1 để bật)
            await Set(56, 1); await Set(50, 10);
            if (cloudDown)
            {
                Check("cloud không nối được → logic chưa chạy trong thời gian chờ 5 s", await Get(51) == 0);
                Check("mất mạng THẬT quá 5 s: mức 10 ≤ 20 → bơm BẬT", await Wait(async () => await Get(51) == 1, 15), $"D51={await Get(51)}");
            }
            else
            {
                await Api("POST", "/api/offline/test", new { Sec = 60 });
                Check("thử mất mạng: mức 10 ≤ 20 → bơm BẬT", await Wait(async () => await Get(51) == 1, 5), $"D51={await Get(51)}");
            }
            await Set(50, 50);
            await Task.Delay(1500);
            Check("mức 50 (giữa hai ngưỡng) → giữ BẬT", await Get(51) == 1);
            await Set(50, 95);
            Check("mức 95 ≥ 90 → bơm TẮT", await Wait(async () => await Get(51) == 0, 5), $"D51={await Get(51)}");
            await Set(50, 10);
            Check("mức xuống 10 → BẬT lại", await Wait(async () => await Get(51) == 1, 5));
            await Set(56, 0);
            Check("đang chạy logic mất mạng mà mất điều kiện → vẫn TẮT (hold thắng)", await Wait(async () => await Get(51) == 0, 5));
            await Set(56, 1);
            Check("đủ điều kiện lại → logic mất mạng bật lại", await Wait(async () => await Get(51) == 1, 8));
            var w0 = await WriteAsync("pump1", "run", 0);   // người tại chỗ tắt tay → logic nhường
            await Task.Delay(2500);
            Check("thao tác tay lúc mất mạng → logic nhường (bơm giữ TẮT dù mức thấp)", w0 == null && await Get(51) == 0, $"err={w0} D51={await Get(51)}");
            Check("bơm tăng áp theo 'off' khi mất mạng", await Get(55) == 0);
            if (!cloudDown) await Api("POST", "/api/offline/test", new { Sec = 0 });

            // ---- hẹn giờ (đúng phút): đặt mốc ngay lúc này (phần mất mạng phía trên có thể đã qua mốc cũ)
            var cur = await Api("GET", "/api/offline");
            var t1 = DateTime.UtcNow.AddHours(7).AddMinutes(1);
            var pt = await Api("PUT", "/api/offline", new
            {
                Rev = cur.J.GetProperty("Rev").GetUInt32(), TzMin = 420,
                Do = new object[]
                {
                    new { Out = "pump1.run", Mode = "hold", DelaySec = 60, Need = new[] { new { Field = "pump1.ok", Op = ">=", Val = 1.0 } }, NeedHold = true, Block = new[] { "pump1.boost" } },
                    new { Out = "pump1.boost", Mode = "off", DelaySec = 60, MaxOnSec = 3, Timer = new[] { new { On = t1.ToString("HH:mm"), Off = t1.AddMinutes(1).ToString("HH:mm") } } },
                },
            });
            Check("đặt lại hẹn giờ", pt.St == 200, pt.J.ToString());
            await WriteAsync("pump1", "run", 0);   // bơm giếng tắt (liên động không chặn bơm tăng áp)
            Check("hẹn giờ: đúng phút → bơm tăng áp BẬT", await Wait(async () => await Get(55) == 1, 75), $"D55={await Get(55)}");
            Check("hẹn giờ bật xong maxon 3 s vẫn áp dụng → tự tắt", await Wait(async () => await Get(55) == 0, 6));

            // ---- khởi động lại: chương trình nạp lại từ file
            await StopAsync(); await StartAsync();
            Check("khởi động lại → chương trình nạp lại từ file", _host != null && _host.Core.Logic.Rev == rev0 + 2 && !_host.Core.Logic.Empty, $"rev {_host?.Core.Logic.Rev}");
            var cfgMsg = Encoding().GetString(ConfigBuilder.Build(_cfg, null, _host!.Core.Logic.CloudSummary(null)));
            Check("bản tin config mang 'logic' (do, keys, names)", cfgMsg.Contains("\"logic\"") && cfgMsg.Contains("\"pump1.run\":\"pump1.run\"") && cfgMsg.Contains("\"Out\":\"pump1.run\""), cfgMsg.Length.ToString());
            await StopAsync();
            if (File.Exists(LogicPath)) File.Delete(LogicPath);
        }
        catch (Exception e) { Check("chạy kiểm thử", false, e.GetType().Name + ": " + e.Message); }
        await StopAsync();
        Close();
    }

    static System.Text.Encoding Encoding() => System.Text.Encoding.UTF8;
}
