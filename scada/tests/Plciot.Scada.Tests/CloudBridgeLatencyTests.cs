using System.Text;

namespace Plciot.Scada.Tests;

/// <summary>Telemetry gửi lên cloud: đổi → gửi ngay (cách nhau CloudTelemetryFastMs); không đổi → chỉ nhịp tim CloudTelemetryMinMs.</summary>
public class CloudBridgeLatencyTests
{
    static byte[] Tele(int v) => Encoding.UTF8.GetBytes($"{{\"r\":[{v}]}}");

    static async Task<(ScadaConfig Cfg, FakeCloud Cloud, CloudBridge Bridge, CancellationTokenSource Cts)> StartAsync()
    {
        var cloud = new FakeCloud();
        await cloud.StartAsync();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Mobile = MobileAccess.MonitorOnly,
            CloudHost = "127.0.0.1", CloudPort = cloud.Port, CloudUser = "gw", CloudPassword = "secret", CloudPinSha256 = cloud.PinSha256,
            CloudTelemetryMinMs = 5000, CloudTelemetryFastMs = 50,
        };
        var bridge = new CloudBridge(cfg);
        var cts = new CancellationTokenSource();
        _ = bridge.RunAsync(cts.Token);
        Assert.True(await Net.WaitFor(() => bridge.State == CloudState.Connected));
        return (cfg, cloud, bridge, cts);
    }

    static int Count(FakeCloud c, string payload) => c.Snapshot().Count(m => m.Topic.EndsWith("/telemetry") && m.Payload == payload);

    [Fact]
    public async Task Changed_telemetry_is_forwarded_within_fast_interval_not_heartbeat_interval()
    {
        var (cfg, cloud, bridge, cts) = await StartAsync();
        try
        {
            var t = cfg.BaseTopic + "/telemetry";
            bridge.Forward(t, Tele(1), true);
            Assert.True(await Net.WaitFor(() => Count(cloud, "{\"r\":[1]}") == 1, 3000));
            var start = DateTime.UtcNow;
            bridge.Forward(t, Tele(2), true);                               // đổi → không phải chờ 5 s
            Assert.True(await Net.WaitFor(() => Count(cloud, "{\"r\":[2]}") == 1, 3000));
            Assert.True((DateTime.UtcNow - start).TotalMilliseconds < 1500);
        }
        finally { cts.Cancel(); await cloud.DisposeAsync(); await bridge.DisposeAsync(); }
    }

    [Fact]
    public async Task Unchanged_telemetry_is_held_until_heartbeat()
    {
        var (cfg, cloud, bridge, cts) = await StartAsync();
        try
        {
            var t = cfg.BaseTopic + "/telemetry";
            bridge.Forward(t, Tele(7), true);
            Assert.True(await Net.WaitFor(() => Count(cloud, "{\"r\":[7]}") == 1, 3000));
            for (var i = 0; i < 5; i++) { bridge.Forward(t, Tele(7), true); await Task.Delay(100); }
            Assert.Equal(1, Count(cloud, "{\"r\":[7]}"));                    // giống hệt: chưa tới nhịp tim 5 s
        }
        finally { cts.Cancel(); await cloud.DisposeAsync(); await bridge.DisposeAsync(); }
    }

    [Fact]
    public async Task Expedite_sends_next_telemetry_immediately()
    {
        var (cfg, cloud, bridge, cts) = await StartAsync();
        try
        {
            var t = cfg.BaseTopic + "/telemetry";
            cfg.CloudTelemetryFastMs = 5000;                                // chống dồn dài, chỉ Expedite mới vượt được
            bridge.Forward(t, Tele(1), true);
            Assert.True(await Net.WaitFor(() => Count(cloud, "{\"r\":[1]}") == 1, 3000));
            bridge.Expedite(2000);
            bridge.Forward(t, Tele(2), true);
            Assert.True(await Net.WaitFor(() => Count(cloud, "{\"r\":[2]}") == 1, 1500));
        }
        finally { cts.Cancel(); await cloud.DisposeAsync(); await bridge.DisposeAsync(); }
    }
}
