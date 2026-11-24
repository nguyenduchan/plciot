namespace Plciot.Scada.Tests;

/// <summary>
/// Driver do app chủ tự cấp (vd. PLC giả của chế độ Demo trong GatewayApp): chạy được khi chưa khai báo địa chỉ PLC,
/// nhưng cấu hình thật (driver tạo từ cấu hình) vẫn bị kiểm tra đủ như cũ.
/// </summary>
public class SuppliedDriverTests
{
    sealed class FixedDriver : IRegisterDriver
    {
        public readonly ushort[] Regs = new ushort[Contract.MaxRegister];
        public Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default) => Task.FromResult(Regs[address..(address + count)]);
        public Task WriteAsync(int address, ushort value, CancellationToken ct = default) { Regs[address] = value; return Task.CompletedTask; }
        public void Dispose() { }
    }

    // giống cấu hình mặc định của GatewayApp lúc mới cài: chưa có PLC
    static ScadaConfig NoPlc(PlcSource src = PlcSource.ModbusTcp) => new()
    {
        Site = "factory1", Device = "plc01", Source = src, PlcHost = "", PollMs = 150,
        Mobile = MobileAccess.Off, LocalBrokerEnabled = false, WebEnabled = false,
        Pack = { new PackMap { Child = "tank1", Field = "level", Address = 50, Scale = 10 } },
    };

    [Theory]
    [InlineData(PlcSource.ModbusTcp, "Thiếu địa chỉ PLC")]
    public void Missing_plc_address_is_only_allowed_when_the_driver_is_supplied(PlcSource src, string err)
    {
        var cfg = NoPlc(src);
        Assert.Contains(err, cfg.Validate());                      // cấu hình thật: vẫn bắt buộc
        Assert.Null(cfg.Validate(driverSupplied: true));           // driver do app cấp: không cần địa chỉ
    }

    [Fact]
    public void Supplied_driver_does_not_relax_the_other_checks()
    {
        var cfg = NoPlc(); cfg.PollMs = 50;
        Assert.Contains("Chu kỳ đọc", cfg.Validate(driverSupplied: true));
        cfg = NoPlc(); cfg.Pack.Add(new PackMap { Child = "tank1", Field = "x", Address = 999, Scale = 1 });
        Assert.NotNull(cfg.Validate(driverSupplied: true));
    }

    [Fact]
    public void Host_without_driver_override_still_rejects_a_missing_plc_address()
    {
        var ex = Assert.Throws<ArgumentException>(() => new ScadaHost(NoPlc()));
        Assert.Contains("Thiếu địa chỉ PLC", ex.Message);
        Assert.Throws<ArgumentException>(() => new ScadaCore(NoPlc(), null, driverSupplied: true));   // "tự cấp" mà không có driver
    }

    [Fact]
    public async Task Host_with_driver_override_runs_without_plc_address()
    {
        var drv = new FixedDriver();
        drv.Regs[50] = 425;                                        // tank1.level = 42.5
        await using var host = new ScadaHost(NoPlc(), drv);
        double? level = null;
        host.Core.Publish += (kind, payload, _) =>
        {
            if (kind != "telemetry") return;
            using var doc = System.Text.Json.JsonDocument.Parse(payload);   // schema:2 {"d":{child:{field:số}}}
            if (doc.RootElement.TryGetProperty("d", out var d) && d.TryGetProperty("tank1", out var t) && t.TryGetProperty("level", out var v)) level = v.GetDouble();
        };
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Core.State.Fresh && level == 42.5), "đọc được từ driver tự cấp");
    }
}
