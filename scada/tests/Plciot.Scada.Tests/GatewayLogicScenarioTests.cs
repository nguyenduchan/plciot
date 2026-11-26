namespace Plciot.Scada.Tests;

/// <summary>
/// Kịch bản chương trình logic trên gateway PC theo từng NGUỒN I/O (docs/GATEWAY-LOGIC.md, mục "Kịch bản"):
///   Digital  — DI/DO của board Waveshare đọc qua Modbus RTU Unit 0 (D10..17 = DI, D20..27 = DO)
///   RS485    — thiết bị Modbus RTU (biến tần: lệnh chạy CHỈ GHI, cảm biến mức đọc chậm)
///   Modbus TCP — PLC qua Ethernet (van, áp suất); mất kết nối = giá trị cũ dần
/// Điểm chung: chương trình theo field nên không phân biệt giao thức; khác nhau ở trạng thái KHÔNG RÕ (mất kết nối / không đọc lại được).
/// </summary>
public class GatewayLogicScenarioTests
{
    static PackMap P(string child, string field, int addr, string proto, int unit, PackAccess acc = PackAccess.ReadWrite) => new()
    { Child = child, Field = field, Address = addr, Protocol = proto, Access = acc, Params = new() { ["unit"] = unit.ToString() } };

    static ScadaConfig Cfg() => new()
    {
        Site = "f1", Device = "gw", PollMs = 1000, WebEnabled = false, Mobile = MobileAccess.Control,
        Pack = new()
        {
            // Digital I/O của board (Modbus RTU Unit 0)
            P("board", "di1", 10, "ModbusRtu", 0, PackAccess.Read), P("board", "di2", 11, "ModbusRtu", 0, PackAccess.Read),
            P("board", "do1", 20, "ModbusRtu", 0), P("board", "do2", 21, "ModbusRtu", 0),
            // RS485: biến tần (lệnh chạy chỉ ghi) + cảm biến mức
            P("vfd", "run", 8192, "ModbusRtu", 2, PackAccess.Write), P("vfd", "hz", 8193, "ModbusRtu", 2, PackAccess.Read),
            P("bon", "muc", 0, "ModbusRtu", 3, PackAccess.Read),
            // Modbus TCP: PLC
            P("plc", "valve", 100, "ModbusTcp", 1), P("plc", "apsuat", 101, "ModbusTcp", 1, PackAccess.Read),
        },
        Connections = new()
        {
            new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = 1502 },
        },
    };

    /// <summary>Thế giới giả: giá trị + TUỔI từng field (mô phỏng thiết bị mất kết nối bằng cách cho tuổi tăng).</summary>
    sealed class World
    {
        public readonly Dictionary<string, (double V, long At)> V = new();
        public long Mono = 1_000_000;
        public DateTimeOffset Now = new(2026, 11, 23, 3, 0, 0, TimeSpan.Zero);
        public bool? Link = true;
        public readonly ScadaConfig Cfg = GatewayLogicScenarioTests.Cfg();
        public readonly GatewayLogic L;
        public World()
        {
            L = new GatewayLogic(Cfg, () => Now, () => Mono)
            {
                ValueOf = k => V.TryGetValue(k, out var x) ? (x.V, Mono - x.At) : (null, long.MaxValue),
                LinkUp = () => Link,
            };
        }
        public void Set(string key, double v) => V[key] = (v, Mono);
        /// <summary>Mọi thiết bị trả lời bình thường (gia hạn tuổi) — trừ các field trong <paramref name="dead"/>.</summary>
        public void Poll(params string[] dead) { foreach (var k in V.Keys.ToList()) if (!dead.Contains(k) && F(k).Access != PackAccess.Write) V[k] = (V[k].V, Mono); }
        public PackMap F(string key) => Cfg.Pack.First(p => p.Child + "." + p.Field == key);
        public List<LogicWrite> Tick(long ms = 500) { Mono += ms; Now = Now.AddMilliseconds(ms); return L.Tick(); }
        /// <summary>ScadaCore ghi xong → giá trị thấy ngay (như ScadaCore.ExecuteKeyAsync).</summary>
        public void Apply(IEnumerable<LogicWrite> ws) { foreach (var w in ws) Set(w.Field.Child + "." + w.Field.Field, w.Value); }
    }

    static LogicProgram Prog(params LogicRule[] r) => new() { Do = r.ToList() };
    static LogicCond C(string f, string op, double v, int? age = null) => new() { Field = f, Op = op, Val = v, MaxAgeSec = age };

    [Fact]
    public void Program_mixing_digital_rs485_and_modbus_tcp_outputs_validates()
    {
        var w = new World();
        var p = Prog(
            new LogicRule { Out = "vfd.run", Need = new() { C("board.di1", ">=", 1), C("bon.muc", ">=", 10) }, NeedHold = true, Block = new() { "board.do1" } },
            new LogicRule { Out = "board.do1", Mode = "follow", Field = "board.di2" },
            new LogicRule { Out = "plc.valve", Mode = "threshold", Field = "bon.muc", On = 20, Off = 90, MaxAgeSec = 30 });
        Assert.Null(w.L.Validate(p));
        Assert.Contains("liên động", w.L.Validate(Prog(new LogicRule { Out = "vfd.run", Block = new() { "vfd.hz" } })));     // đầu ra kia chỉ đọc
        Assert.Contains("không có trong cấu hình", w.L.Validate(Prog(new LogicRule { Out = "plc.valve", Need = new() { C("vfd.run", ">=", 1) } })));   // field chỉ ghi không làm điều kiện được
    }

    [Fact]
    public void Digital_float_switch_gates_the_board_relay_and_hold_turns_it_off()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "board.do1", Need = new() { C("board.di1", ">=", 1) }, NeedHold = true }));
        w.Set("board.di1", 0); w.Set("board.do1", 0);
        Assert.Equal("logic_need", w.L.Guard(w.F("board.do1"), 1, out _));
        w.Set("board.di1", 1);
        Assert.Null(w.L.Guard(w.F("board.do1"), 1, out _));
        w.Set("board.do1", 1);
        Assert.Empty(w.Tick());
        w.Set("board.di1", 0);   // phao cạn
        var wr = w.Tick();
        Assert.Contains(wr, x => x.Field.Field == "do1" && x.Value == 0);
    }

    [Fact]
    public void Rs485_write_only_vfd_is_tracked_by_last_written_value_for_interlock()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "vfd.run", Block = new() { "board.do1" } }));
        w.Set("board.do1", 0);
        Assert.Null(w.L.StateOf("vfd.run"));                                   // chưa ghi lần nào: không rõ
        Assert.Equal("logic_interlock", w.L.Guard(w.F("board.do1"), 1, out var why));
        Assert.Contains("không rõ trạng thái vfd.run", why);
        w.Set("vfd.run", 0);                                                   // đã ra lệnh dừng
        w.Mono += 3_600_000;                                                   // một giờ sau: field chỉ ghi không "cũ" đi
        w.Poll();
        Assert.False(w.L.StateOf("vfd.run"));
        Assert.Null(w.L.Guard(w.F("board.do1"), 1, out _));
        w.Set("vfd.run", 1);
        Assert.Equal("logic_interlock", w.L.Guard(w.F("board.do1"), 1, out why));
        Assert.Contains("vfd.run đang bật", why);
    }

    [Fact]
    public void Modbus_tcp_link_loss_makes_state_unknown_blocks_interlocked_output_and_fails_conditions()
    {
        var w = new World();
        w.L.Load(Prog(
            new LogicRule { Out = "vfd.run", Block = new() { "plc.valve" } },
            new LogicRule { Out = "board.do2", Need = new() { C("plc.apsuat", ">=", 2) } }));
        w.Set("plc.valve", 0); w.Set("plc.apsuat", 3); w.Set("vfd.run", 0); w.Set("board.do2", 0);
        Assert.Null(w.L.Guard(w.F("vfd.run"), 1, out _));
        Assert.Null(w.L.Guard(w.F("board.do2"), 1, out _));
        // PLC rút cáp mạng: các vòng đọc sau không còn giá trị mới của PLC
        for (int i = 0; i < 70; i++) { w.Tick(1000); w.Poll("plc.valve", "plc.apsuat"); }
        Assert.Null(w.L.StateOf("plc.valve"));
        Assert.Equal("logic_interlock", w.L.Guard(w.F("vfd.run"), 1, out var why));
        Assert.Contains("mất kết nối", why);
        Assert.Equal("logic_need", w.L.Guard(w.F("board.do2"), 1, out why));
        Assert.Contains("mất số liệu", why);
        Assert.Null(w.L.Guard(w.F("vfd.run"), 0, out _));                    // TẮT luôn được
        w.Poll(); w.Set("plc.valve", 0);                                        // PLC trả lời lại
        Assert.Null(w.L.Guard(w.F("vfd.run"), 1, out _));
    }

    [Fact]
    public void Offline_rs485_level_drives_modbus_tcp_valve_and_sensor_loss_turns_it_off()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "plc.valve", Mode = "threshold", Field = "bon.muc", On = 20, Off = 90, MaxAgeSec = 30, DelaySec = 0 }));
        w.Set("plc.valve", 0); w.Set("bon.muc", 15);
        w.Link = false;
        var wr = w.Tick(); w.Apply(wr);
        Assert.Contains(wr, x => x.Field.Field == "valve" && x.Value == 1);   // mức thấp → mở van cấp nước
        w.Set("bon.muc", 50); w.Poll();
        Assert.Empty(w.Tick());                                                 // giữa hai ngưỡng: giữ
        w.Set("bon.muc", 95); w.Poll();
        wr = w.Tick(); w.Apply(wr);
        Assert.Contains(wr, x => x.Field.Field == "valve" && x.Value == 0);
        w.Set("bon.muc", 10); w.Poll();
        wr = w.Tick(); w.Apply(wr);
        Assert.Contains(wr, x => x.Value == 1);
        var all = new List<LogicWrite>();
        for (int i = 0; i < 25; i++) { all.AddRange(w.Tick(1000)); w.Poll("bon.muc"); }   // cảm biến RS485 không trả lời, chưa quá 30 s
        Assert.Empty(all);
        for (int i = 0; i < 8; i++) { all.AddRange(w.Tick(1000)); w.Poll("bon.muc"); }
        Assert.Contains(all, x => x.Field.Field == "valve" && x.Value == 0);   // quá MaxAgeSec → mất số liệu → đóng van
    }

    [Fact]
    public void Offline_follow_board_di_drives_rs485_vfd_across_protocols()
    {
        var w = new World();
        w.L.Load(Prog(new LogicRule { Out = "vfd.run", Mode = "follow", Field = "board.di2", DelaySec = 60 }));
        w.Set("board.di2", 1); w.Set("vfd.run", 0);
        w.Link = false;
        Assert.Empty(w.Tick());                                                 // còn chờ 60 s
        var wr = new List<LogicWrite>();
        for (int i = 0; i < 58; i++) { wr.AddRange(w.Tick(1000)); w.Poll(); }
        Assert.Empty(wr);                                                       // 58,5 s: chưa tới thời gian chờ
        for (int i = 0; i < 3; i++) { wr.AddRange(w.Tick(1000)); w.Poll(); }
        w.Apply(wr);
        Assert.Contains(wr, x => x.Field.Child == "vfd" && x.Value == 1);
        w.Set("board.di2", 0);
        wr = w.Tick(); w.Apply(wr);   // đổi ý (bật → tắt) ghi ngay, không chờ 5 s
        Assert.Contains(wr, x => x.Field.Child == "vfd" && x.Value == 0);
        w.Link = true;                                                          // có mạng lại: dừng, giữ nguyên
        w.Set("board.di2", 1);
        Assert.Empty(w.Tick());
    }

    [Fact]
    public void Once_timer_fires_only_on_its_date_like_an_iphone_alarm_and_off_crosses_midnight()
    {
        var w = new World();   // 2026-11-23 03:00 UTC = 10:00 giờ VN (thứ Hai)
        w.Link = null;
        var t = new LogicTimer { On = "10:01", Off = "10:00", Date = "2026-11-23", Days = new() };   // tắt 10:00 hôm SAU
        Assert.Null(w.L.Validate(Prog(new LogicRule { Out = "board.do1", Timer = new() { t } })));
        Assert.Contains("YYYY-MM-DD", w.L.Validate(Prog(new LogicRule { Out = "board.do1", Timer = new() { new LogicTimer { On = "10:01", Date = "2026-02-30", Days = new() } } })));
        Assert.Contains("không kèm", w.L.Validate(Prog(new LogicRule { Out = "board.do1", Timer = new() { new LogicTimer { On = "10:01", Date = "2026-11-23", Days = new() { 1 } } } })));
        Assert.Contains("từ 1", w.L.Validate(Prog(new LogicRule { Out = "board.do1", Timer = new() { new LogicTimer { On = "10:01", Days = new() } } })));   // Days rỗng không có Date: như gateway cũ
        w.L.Load(Prog(new LogicRule { Out = "board.do1", Timer = new() { t } }));
        w.Set("board.do1", 0);
        var all = new List<LogicWrite>();
        for (int i = 0; i < 4; i++) { var x = w.Tick(30_000); w.Apply(x); all.AddRange(x); w.Poll(); }   // 10:00 → 10:02
        Assert.Contains(all, x => x.Value == 1 && x.Why.Contains("10:01"));
        all.Clear();
        for (int i = 0; i < 24 * 120 + 4; i++) { var x = w.Tick(30_000); w.Apply(x); all.AddRange(x); w.Poll(); }   // hết hôm sau 10:02
        Assert.Single(all);                                                       // chỉ một lần: tắt 10:00 hôm sau, KHÔNG bật lại
        Assert.True(all[0].Value == 0 && all[0].Why.Contains("10:00"));
    }
}
