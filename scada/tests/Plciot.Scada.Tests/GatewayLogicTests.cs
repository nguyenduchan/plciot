using System.Text;

namespace Plciot.Scada.Tests;

/// <summary>
/// Chương trình logic của gateway PC (GatewayLogic, cùng hợp đồng với board Waveshare — docs/GATEWAY-LOGIC.md):
/// kiểm chương trình, chặn lệnh (điều kiện, liên động), tự tắt (mất điều kiện, chạy quá lâu), hẹn giờ theo phút, logic khi mất mạng,
/// và nối vào ScadaCore (mọi nguồn lệnh đi qua ExecuteKeyAsync; chương trình ghi bằng ControlSource.Logic).
/// </summary>
public class GatewayLogicTests
{
    static PackMap P(string child, string field, int addr, PackAccess acc = PackAccess.ReadWrite) => new()
    { Child = child, Field = field, Address = addr, Protocol = "ModbusTcp", Access = acc, Params = new() { ["unit"] = "1" } };

    static ScadaConfig Cfg() => new()
    {
        Site = "f1", Device = "gw", PollMs = 100, WebEnabled = false, Mobile = MobileAccess.Control,
        Pack = new() { P("pump1", "run", 51), P("pump1", "boost", 55), P("pump1", "ok", 56, PackAccess.Read), P("tank1", "level", 50, PackAccess.Read) },
        Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = 1502 } },
    };

    sealed class World
    {
        public readonly Dictionary<string, double> V = new();
        public long Mono = 1_000_000;
        public DateTimeOffset Now = new(2026, 11, 23, 23, 59, 30, TimeSpan.Zero);   // thứ Hai 06:59:30 giờ VN
        public bool? Link = null;
        public readonly ScadaConfig Cfg = GatewayLogicTests.Cfg();
        public readonly GatewayLogic L;
        public World()
        {
            L = new GatewayLogic(Cfg, () => Now, () => Mono) { ValueOf = k => V.TryGetValue(k, out var x) ? (x, 0) : (null, long.MaxValue), LinkUp = () => Link };
        }
        public PackMap F(string key) => Cfg.Pack.First(p => p.Child + "." + p.Field == key);
        public List<LogicWrite> Tick(long advanceMs = 500) { Mono += advanceMs; Now = Now.AddMilliseconds(advanceMs); return L.Tick(); }
    }

    static LogicProgram Prog(params LogicRule[] r) => new() { Do = r.ToList() };

    [Fact]
    public void Validate_rejects_unknown_or_read_only_outputs_and_bad_parameters()
    {
        var w = new World();
        Assert.Contains("chỉ đọc", w.L.Validate(Prog(new LogicRule { Out = "pump1.ok" })));
        Assert.Contains("không có", w.L.Validate(Prog(new LogicRule { Out = "x.y" })));
        Assert.Contains("liên động", w.L.Validate(Prog(new LogicRule { Out = "pump1.run", Block = new() { "pump1.run" } })));
        Assert.Contains("khác nhau", w.L.Validate(Prog(new LogicRule { Out = "pump1.run", Timer = new() { new LogicTimer { On = "08:00", Off = "08:00" } } })));
        Assert.Contains("cần ít nhất", w.L.Validate(Prog(new LogicRule { Out = "pump1.run", NeedHold = true })));
        Assert.Contains("không có trong cấu hình", w.L.Validate(Prog(new LogicRule { Out = "pump1.run", Need = new() { new LogicCond { Field = "nope.x", Op = ">=", Val = 1 } } })));
        Assert.Null(w.L.Validate(Prog(new LogicRule { Out = "pump1.run", Mode = "threshold", Field = "tank1.level", On = 20, Off = 90, MaxAgeSec = 30 })));
    }

    [Fact]
    public void Guard_blocks_turn_on_without_condition_or_with_interlock_but_off_is_always_allowed()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "pump1.run", Need = new() { new LogicCond { Field = "pump1.ok", Op = ">=", Val = 1 } }, Block = new() { "pump1.boost" } }));
        w.V["pump1.run"] = 0; w.V["pump1.boost"] = 0;
        Assert.Equal("logic_need", w.L.Guard(w.F("pump1.run"), 1, out var why)); Assert.Contains("pump1.ok", why);   // chưa đọc được → không thoả
        w.V["pump1.ok"] = 0;
        Assert.Equal("logic_need", w.L.Guard(w.F("pump1.run"), 1, out _));
        w.V["pump1.ok"] = 1;
        Assert.Null(w.L.Guard(w.F("pump1.run"), 1, out _));
        w.V["pump1.boost"] = 1;
        Assert.Equal("logic_interlock", w.L.Guard(w.F("pump1.run"), 1, out why)); Assert.Contains("pump1.boost", why);
        w.V["pump1.boost"] = 0; w.V["pump1.run"] = 1;
        Assert.Equal("logic_interlock", w.L.Guard(w.F("pump1.boost"), 1, out _));   // liên động HAI chiều
        Assert.Null(w.L.Guard(w.F("pump1.run"), 0, out _));                         // tắt luôn được
        w.V["pump1.ok"] = 0;
        Assert.Null(w.L.Guard(w.F("pump1.run"), 1, out _));                         // đang bật: gửi lại không phải "bật mới"
    }

    [Fact]
    public void Hold_and_max_on_turn_the_output_off()
    {
        var w = new World();
        w.L.Load(Prog(
            new LogicRule { Out = "pump1.run", Need = new() { new LogicCond { Field = "pump1.ok", Op = ">=", Val = 1 } }, NeedHold = true },
            new LogicRule { Out = "pump1.boost", MaxOnSec = 3 }));
        w.V["pump1.ok"] = 1; w.V["pump1.run"] = 1; w.V["pump1.boost"] = 1;
        Assert.Empty(w.Tick());
        w.V["pump1.ok"] = 0;
        var wr = w.Tick();
        Assert.Contains(wr, x => x.Field.Field == "run" && x.Value == 0 && x.Why.Contains("mất điều kiện"));
        Assert.Empty(w.Tick(100));   // vừa thử ghi: không dồn lệnh mỗi nhịp
        w.V["pump1.run"] = 0;
        wr = w.Tick(3000);
        Assert.Contains(wr, x => x.Field.Field == "boost" && x.Value == 0 && x.Why.Contains("chạy quá 3 s"));
    }

    [Fact]
    public void Timer_fires_on_the_minute_and_respects_days()
    {
        var w = new World();
        w.L.Load(Prog(
            new LogicRule { Out = "pump1.run", Timer = new() { new LogicTimer { On = "07:00", Off = "07:01" } } },
            new LogicRule { Out = "pump1.boost", Timer = new() { new LogicTimer { On = "07:00", Days = new() { 6, 7 } } } }));   // chỉ T7, CN
        w.V["pump1.run"] = 0; w.V["pump1.boost"] = 0;
        Assert.Empty(w.Tick());                 // 06:59:30 — nhịp đầu chỉ ghi nhớ phút
        var wr = w.Tick(30_000);                // 07:00:00 thứ Hai
        Assert.Single(wr);
        Assert.Equal(("run", 1.0), (wr[0].Field.Field, wr[0].Value));
        w.V["pump1.run"] = 1;
        Assert.Empty(w.Tick(30_000));           // cùng phút: không lặp
        wr = w.Tick(30_000);                    // 07:01
        Assert.Equal(("run", 0.0), (wr.Single().Field.Field, wr.Single().Value));
    }

    [Fact]
    public void Offline_modes_run_only_after_delay_and_stop_when_link_returns()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "pump1.run", Mode = "threshold", Field = "tank1.level", On = 20, Off = 90, DelaySec = 5, MaxAgeSec = 30 }));
        w.V["pump1.run"] = 0; w.V["tank1.level"] = 10;
        w.Link = null;                                        // không dùng cloud: không bao giờ "mất mạng"
        Assert.Empty(w.Tick());
        w.Link = true; Assert.Empty(w.Tick());
        w.Link = false;
        Assert.Empty(w.Tick(1000));                           // chưa đủ 5 s
        var wr = w.Tick(5000);
        Assert.Equal(1.0, wr.Single().Value);                 // mức 10 ≤ 20 → bật
        w.V["pump1.run"] = 1; w.V["tank1.level"] = 50;
        Assert.Empty(w.Tick(6000));                           // giữa hai ngưỡng: giữ
        w.V["tank1.level"] = 95;
        Assert.Equal(0.0, w.Tick(6000).Single().Value);       // ≥ 90 → tắt
        w.V["pump1.run"] = 0; w.V["tank1.level"] = 10;
        w.L.NoteManual(w.F("pump1.run"));                     // người tại chỗ đổi tay → nhường
        Assert.Empty(w.Tick(6000));
        w.Link = true; Assert.Empty(w.Tick(6000));            // có mạng lại: dừng, giữ nguyên
        w.Link = false; Assert.Empty(w.Tick(1000));           // mất lại: phải chờ lại 5 s
        Assert.Single(w.Tick(5000));
    }

    sealed class MemDriver : IRegisterDriver
    {
        public readonly ushort[] Regs = new ushort[200];
        public Task<ushort[]> ReadAsync(int a, int n, CancellationToken ct = default) { lock (Regs) return Task.FromResult(Regs.Skip(a).Take(n).ToArray()); }
        public Task WriteAsync(int a, ushort v, CancellationToken ct = default) { lock (Regs) Regs[a] = v; return Task.CompletedTask; }
        public void Dispose() { }
    }

    [Fact]
    public async Task Core_applies_program_to_every_command_source_and_runs_the_hold_rule()
    {
        var drv = new MemDriver();
        var cfg = Cfg();
        await using var core = new ScadaCore(cfg, null, new PackDriverPool(cfg, (_, _) => drv));
        Assert.Null(core.Logic.Validate(Prog(new LogicRule { Out = "pump1.run", Need = new() { new LogicCond { Field = "pump1.ok", Op = ">=", Val = 1 } }, NeedHold = true })));
        core.Logic.Load(Prog(new LogicRule { Out = "pump1.run", Need = new() { new LogicCond { Field = "pump1.ok", Op = ">=", Val = 1 } }, NeedHold = true }));
        await core.StartAsync();
        static byte[] Cmd(string key, double v) => Encoding.UTF8.GetBytes($"{{\"id\":\"k\",\"child\":\"pump1\",\"key\":\"{key}\",\"v\":{v}}}");
        Assert.True(await Net.WaitFor(() => core.State.Status == "online", 3000));
        await Task.Delay(300);
        Assert.Contains("logic_need", await core.ExecuteKeyAsync(Cmd("run", 1), ControlSource.Mobile, "t", default, trusted: true));
        Assert.Contains("logic_need", await core.ExecuteKeyAsync(Cmd("run", 1), ControlSource.LocalScreen, "t"));
        Assert.Equal(0, drv.Regs[51]);
        lock (drv.Regs) drv.Regs[56] = 1;   // pump1.ok = 1
        Assert.True(await Net.WaitFor(() => core.ExecuteKeyAsync(Cmd("run", 1), ControlSource.LocalScreen, "t").Result!.Contains("\"ok\":true"), 3000));
        Assert.Equal(1, drv.Regs[51]);
        lock (drv.Regs) drv.Regs[56] = 0;   // mất điều kiện → chương trình tự tắt
        Assert.True(await Net.WaitFor(() => drv.Regs[51] == 0, 4000));
        Assert.Contains(core.RecentLog, l => l.Contains("logic: ") && l.Contains("mất điều kiện"));
    }
}
