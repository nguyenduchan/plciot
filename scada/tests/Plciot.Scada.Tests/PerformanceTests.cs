using System.Diagnostics;
using Xunit.Abstractions;

namespace Plciot.Scada.Tests;

/// <summary>Đo độ trễ điều khiển trực tiếp (không đặt ngưỡng chặt: máy chạy test khác nhau). Chạy: dotnet test --filter Category=Perf -v n</summary>
[Trait("Category", "Perf")]
public class PerformanceTests
{
    readonly ITestOutputHelper _out;
    public PerformanceTests(ITestOutputHelper o) { _out = o; }

    static double Pct(List<double> a, double p) { var s = a.OrderBy(x => x).ToList(); return s[Math.Min(s.Count - 1, (int)(p / 100 * s.Count))]; }
    static string Fmt(List<double> a) => $"p50 {Pct(a, 50):F2} ms  p95 {Pct(a, 95):F2} ms  p99 {Pct(a, 99):F2} ms  max {a.Max():F2} ms";

    [Fact]
    public async Task Direct_control_overhead_versus_a_raw_modbus_write()
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig { Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 200, WebEnabled = false, Mobile = MobileAccess.Off };
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        Assert.True(await Net.WaitFor(() => core.State.Fresh));

        using var raw = new ModbusTcpClient("127.0.0.1", plc.Port, 1);
        for (var i = 0; i < 50; i++) { await raw.WriteAsync(7, (ushort)i); await core.WriteAsync(7, i); }     // làm nóng
        var rawLat = new List<double>(); var coreLat = new List<double>();
        for (var i = 0; i < 300; i++)
        {
            var t = Stopwatch.GetTimestamp(); await raw.WriteAsync(7, (ushort)(i + 1000));
            rawLat.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
            t = Stopwatch.GetTimestamp(); Assert.Null(await core.WriteAsync(7, i + 2000));
            coreLat.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
        }
        _out.WriteLine($"ghi Modbus thô          : {Fmt(rawLat)}");
        _out.WriteLine($"ScadaCore.WriteAsync    : {Fmt(coreLat)}   (xuống thẳng driver, kèm kiểm tra whitelist + ack)");
        Assert.True(Pct(coreLat, 50) < 20, "lõi không được thêm độ trễ đáng kể so với ghi thô");
    }

    [Fact]
    public async Task Poll_cycle_cost_does_not_block_writes()
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig { Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 100, HistoryMs = 200, WebEnabled = false, Mobile = MobileAccess.Off };
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        Assert.True(await Net.WaitFor(() => core.State.Fresh));
        var lat = new List<double>();
        for (var i = 0; i < 300; i++)
        {
            var t = Stopwatch.GetTimestamp(); await core.WriteAsync(7, i);
            lat.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
            await Task.Delay(7);                                        // ghi xen kẽ với vòng đọc 100 ms
        }
        _out.WriteLine($"ghi khi đang đọc 10 Hz (+ lịch sử 5 Hz): {Fmt(lat)}");
    }
}
