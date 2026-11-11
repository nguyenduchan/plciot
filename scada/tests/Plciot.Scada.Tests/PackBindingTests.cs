using System.Text;
using System.Text.Json;

namespace Plciot.Scada.Tests;

/// <summary>Field gán giao thức rõ ràng: kiểu dữ liệu, đảo word, quyền, thông số riêng, kết nối riêng — không có giá trị ngầm định.</summary>
public class PackBindingTests
{
    sealed class RecordingDriver : IRegisterDriver
    {
        public readonly ushort[] Regs = new ushort[300];
        public readonly List<(int A, int N)> Reads = new();
        public readonly List<(int A, ushort[] V)> Writes = new();
        public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
        {
            lock (Reads) Reads.Add((address, count));
            return Task.FromResult(Regs[address..(address + count)]);
        }
        public Task WriteAsync(int address, ushort value, CancellationToken ct = default) { Regs[address] = value; lock (Writes) Writes.Add((address, new[] { value })); return Task.CompletedTask; }
        public void Dispose() { }
    }

    static PackMap P(string child, string field, int addr, PlcDataType t = PlcDataType.UInt16, PackAccess acc = PackAccess.ReadWrite, double scale = 1, bool swap = false,
        PlcSource src = PlcSource.ModbusTcp, Dictionary<string, string>? prm = null) => new()
    {
        Child = child, Field = field, Address = addr, Scale = scale, Protocol = src.ToString(), Access = acc, DataType = t, WordSwap = swap,
        Params = prm ?? new() { ["unit"] = "7" },
    };

    static ScadaConfig Cfg(params PackMap[] pack) => new()
    {
        Site = "f1", Device = "plc01", PollMs = 200, WebEnabled = false, Mobile = MobileAccess.Control,
        Pack = pack.ToList(),
        Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = 1502 } },
    };

    [Theory]
    [InlineData(PlcDataType.UInt16, 65000.0, false)]
    [InlineData(PlcDataType.Int16, -1234.0, false)]
    [InlineData(PlcDataType.Bool, 1.0, false)]
    [InlineData(PlcDataType.UInt32, 4000000000.0, false)]
    [InlineData(PlcDataType.UInt32, 4000000000.0, true)]
    [InlineData(PlcDataType.Int32, -70000.0, false)]
    [InlineData(PlcDataType.Int32, -70000.0, true)]
    [InlineData(PlcDataType.Float32, 12.5, false)]
    [InlineData(PlcDataType.Float32, 3.25, true)]
    [InlineData(PlcDataType.Float64, 123456.789, false)]
    [InlineData(PlcDataType.Float64, -0.001, true)]
    public void Codec_round_trips_every_type(PlcDataType t, double v, bool swap)
    {
        var w = PackCodec.Encode(v, t, swap);
        Assert.Equal(PackCodec.Words(t), w.Length);
        Assert.Equal(v, PackCodec.Decode(w, t, swap));
    }

    [Fact]
    public void Codec_word_order_matches_documented_layout()
    {
        Assert.Equal(new ushort[] { 0x4148, 0x0000 }, PackCodec.Encode(12.5, PlcDataType.Float32, false));   // AB CD
        Assert.Equal(new ushort[] { 0x0000, 0x4148 }, PackCodec.Encode(12.5, PlcDataType.Float32, true));    // CD AB
        Assert.Equal(new ushort[] { 0xFFFE }, PackCodec.Encode(-2, PlcDataType.Int16, false));
    }

    [Theory]
    [InlineData(PlcDataType.UInt16, 70000.0)]
    [InlineData(PlcDataType.UInt16, -1.0)]
    [InlineData(PlcDataType.Int16, 40000.0)]
    [InlineData(PlcDataType.UInt32, -5.0)]
    public void Codec_rejects_values_outside_the_type_range(PlcDataType t, double v) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => PackCodec.Encode(v, t, false));

    [Fact]
    public void Validate_demands_every_parameter_explicitly()
    {
        var c = Cfg(P("a", "x", 10, prm: new()));            // thiếu unit
        Assert.Contains("Unit ID", c.Validate());
        c = Cfg(P("a", "x", 10, prm: new() { ["unit"] = "abc" }));
        Assert.Contains("số nguyên", c.Validate());
        c = Cfg(P("a", "x", 10, src: PlcSource.S7, prm: new() { ["cpu"] = "S71500", ["rack"] = "0", ["slot"] = "1" }));   // thiếu db
        c.Connections.Add(new PlcConnection { Protocol = PlcSource.S7, Host = "h", Port = 102 });
        Assert.Contains("Số DB", c.Validate());
        c = Cfg(P("a", "x", 10, src: PlcSource.MitsubishiMc, prm: new() { ["plc"] = "ZZ" }));
        Assert.Contains("phải là một trong", c.Validate());
    }

    [Fact]
    public void Validate_checks_connections_overlap_mixed_binding_and_range()
    {
        var c = Cfg(P("a", "x", 10)); c.Connections.Clear();
        Assert.Contains("Thiếu kết nối", c.Validate());
        c = Cfg(P("a", "x", 10)); c.Connections[0].Port = 0;
        Assert.Contains("cổng", c.Validate());
        c = Cfg(P("a", "x", 10, PlcDataType.UInt32), P("a", "y", 11));                       // x chiếm D10-D11, y nằm đè D11
        Assert.Contains("chồng nhau", c.Validate());
        c = Cfg(P("a", "x", 10), P("b", "y", 10, prm: new() { ["unit"] = "8" }));            // cùng D10 nhưng PLC (unit) khác → được
        Assert.Null(c.Validate());
        c = Cfg(P("a", "x", 299, PlcDataType.Float32));
        Assert.Contains("vượt quá", c.Validate());
        c = Cfg(P("a", "x", 10), new PackMap { Child = "b", Field = "y", Address = 20, Scale = 1 });   // một field chưa gán
        Assert.Contains("chưa gán giao thức", c.Validate());
        c = Cfg(new PackMap { Child = "b", Field = "y", Address = 20, Scale = 1 });          // toàn bộ chưa gán = chế độ cũ, hợp lệ
        c.Connections.Clear(); c.PlcHost = "127.0.0.1";
        Assert.Null(c.Validate());
    }

    [Fact]
    public void Config_round_trips_binding_through_json()
    {
        var c = Cfg(P("a", "x", 10, PlcDataType.Float32, PackAccess.Read, 10, true));
        var back = JsonSerializer.Deserialize<ScadaConfig>(JsonSerializer.Serialize(c))!;
        var p = back.Pack[0];
        Assert.True(p.IsBound);
        Assert.Equal((PlcSource.ModbusTcp, PlcDataType.Float32, PackAccess.Read, true), (p.Source!.Value, p.DataType, p.Access, p.WordSwap));
        Assert.Equal("7", p.Param("unit"));
        Assert.Equal(1502, back.ConnectionFor(PlcSource.ModbusTcp)!.Port);
    }

    [Fact]
    public async Task Pool_reads_only_declared_words_and_decodes_by_type_swap_and_scale()
    {
        var drv = new RecordingDriver();
        var f = BitConverter.SingleToUInt32Bits(12.5f);
        drv.Regs[20] = (ushort)(f >> 16); drv.Regs[21] = (ushort)f;                      // REAL AB CD
        drv.Regs[22] = 0xFFFF; drv.Regs[23] = unchecked((ushort)(uint)-70000);          // DINT, word cao rồi thấp
        drv.Regs[22] = unchecked((ushort)((uint)-70000 >> 16));
        drv.Regs[24] = 1;                                                                // BOOL
        drv.Regs[26] = 0; drv.Regs[27] = 0x4150;                                         // REAL đảo word = 13.0
        drv.Regs[40] = 215;                                                              // UINT, hệ số 10 → 21.5
        var cfg = Cfg(P("s", "temp", 20, PlcDataType.Float32), P("s", "count", 22, PlcDataType.Int32), P("s", "on", 24, PlcDataType.Bool),
                      P("t", "rev", 26, PlcDataType.Float32, swap: true), P("t", "lvl", 40, scale: 10));
        using var pool = new PackDriverPool(cfg, (_, _) => drv);
        var r = await pool.ReadAllAsync();
        Assert.Equal(0, r.FailedGroups);
        Assert.Equal(12.5, r.Values[("s", "temp")]);
        Assert.Equal(-70000, r.Values[("s", "count")]);
        Assert.Equal(1, r.Values[("s", "on")]);
        Assert.Equal(13.0, r.Values[("t", "rev")]);
        Assert.Equal(21.5, r.Values[("t", "lvl")]);
        Assert.DoesNotContain(drv.Reads, x => x.A < 20);                                 // không đọc D0–D39 ngầm định
        Assert.All(drv.Reads, x => Assert.InRange(x.A + x.N, 1, 41));
    }

    [Fact]
    public async Task Pool_skips_and_refuses_writes_for_paused_device_and_resumes_without_restart()
    {
        var drv = new RecordingDriver(); drv.Regs[10] = 5; drv.Regs[20] = 7;
        var cfg = Cfg(P("a", "x", 10, acc: PackAccess.ReadWrite), P("b", "y", 20, acc: PackAccess.ReadWrite));
        using var pool = new PackDriverPool(cfg, (_, _) => drv);
        cfg.Pack[0].Enabled = false;
        var r = await pool.ReadAllAsync();
        Assert.False(r.Values.ContainsKey(("a", "x")));
        Assert.Equal(7, r.Values[("b", "y")]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => pool.WriteAsync(cfg.Pack[0], 1));
        cfg.Pack[0].Enabled = true;                          // bật lại: lần đọc kế tiếp có ngay, cùng pool
        Assert.Equal(5, (await pool.ReadAllAsync()).Values[("a", "x")]);
    }

    [Fact]
    public async Task Pool_isolates_each_plc_and_skips_write_only_fields()
    {
        var good = new RecordingDriver { }; good.Regs[10] = 5;
        var seen = new List<string>();
        var cfg = Cfg(P("a", "x", 10), P("b", "y", 10, prm: new() { ["unit"] = "8" }), P("c", "wo", 12, acc: PackAccess.Write));
        using var pool = new PackDriverPool(cfg, (_, p) =>
        {
            seen.Add(p.Param("unit"));
            return p.Param("unit") == "8" ? new ThrowingDriver() : good;
        });
        var r = await pool.ReadAllAsync();
        Assert.Equal(2, r.Groups);                      // unit 7 và unit 8; field chỉ ghi (unit 7) không được đọc
        Assert.Equal(1, r.FailedGroups);
        Assert.Equal(5, r.Values[("a", "x")]);
        Assert.False(r.Values.ContainsKey(("b", "y")));
        Assert.False(r.Values.ContainsKey(("c", "wo")));
        Assert.DoesNotContain(good.Reads, x => x.A <= 12 && x.A + x.N > 12 && x.N == 1 && x.A == 12);
    }

    sealed class ThrowingDriver : IRegisterDriver
    {
        public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default) => throw new IOException("plc down");
        public Task WriteAsync(int address, ushort value, CancellationToken ct = default) => throw new IOException("plc down");
        public void Dispose() { }
    }

    [Fact]
    public async Task Core_writes_typed_words_enforces_access_and_publishes_d_only_telemetry()
    {
        var drv = new RecordingDriver();
        var cfg = Cfg(P("s", "temp", 20, PlcDataType.Float32, swap: true), P("s", "ro", 30, acc: PackAccess.Read), P("s", "n", 31, PlcDataType.Int32));
        await using var core = new ScadaCore(cfg, null, new PackDriverPool(cfg, (_, _) => drv));
        byte[]? telemetry = null;
        core.Publish += (k, b, _) => { if (k == "telemetry") telemetry = b; };
        await core.StartAsync();

        static byte[] Cmd(string key, double v) => Encoding.UTF8.GetBytes($"{{\"id\":\"k\",\"child\":\"s\",\"key\":\"{key}\",\"v\":{v.ToString(System.Globalization.CultureInfo.InvariantCulture)}}}");
        var ok = await core.ExecuteKeyAsync(Cmd("temp", 12.5), ControlSource.LocalScreen, "t");
        Assert.Contains("\"ok\":true", ok);
        Assert.Equal(new ushort[] { 0x0000, 0x4148 }, new[] { drv.Regs[20], drv.Regs[21] });          // REAL đảo word

        var neg = await core.ExecuteKeyAsync(Cmd("n", -2), ControlSource.LocalScreen, "t");
        Assert.Contains("\"ok\":true", neg);
        Assert.Equal(new ushort[] { 0xFFFF, 0xFFFE }, new[] { drv.Regs[31], drv.Regs[32] });

        var ro = await core.ExecuteKeyAsync(Cmd("ro", 1), ControlSource.LocalScreen, "t");
        Assert.Contains("read_only", ro);
        Assert.Equal(0, drv.Regs[30]);

        var big = await core.ExecuteKeyAsync(Encoding.UTF8.GetBytes("{\"id\":\"k\",\"child\":\"s\",\"key\":\"ro\",\"v\":1}"), ControlSource.Mobile, "t");
        Assert.Contains("read_only", big);

        var raw = await core.ExecuteAsync(Encoding.UTF8.GetBytes("{\"id\":\"r\",\"a\":3,\"v\":1}"), ControlSource.LocalScreen, "t");
        Assert.Contains("use_key_command", raw);                                                       // địa chỉ D trần không xác định PLC

        for (var i = 0; i < 50 && telemetry == null; i++) await Task.Delay(50);
        Assert.NotNull(telemetry);
        using var doc = JsonDocument.Parse(telemetry!);
        Assert.False(doc.RootElement.TryGetProperty("r", out _));                                      // không còn r[] D0–D39 ngầm định
        Assert.Equal(12.5, doc.RootElement.GetProperty("d").GetProperty("s").GetProperty("temp").GetDouble());
        Assert.Equal(-2, doc.RootElement.GetProperty("d").GetProperty("s").GetProperty("n").GetDouble());
        Assert.DoesNotContain(drv.Reads, x => x.A < 20);
    }
}
