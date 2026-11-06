using System.Text;

namespace Plciot.Scada.Tests;

/// <summary>Gateway tự bảo vệ trước lệnh từ cloud: giới hạn giá trị theo trường, chống phát lại (trùng id / ts quá cũ).</summary>
public class CommandHardeningTests
{
    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [Theory]
    [InlineData(1, true)]
    [InlineData(2, false)]      // ngoài Max = 1
    [InlineData(-1, false)]     // dưới Min = 0
    public async Task Pack_limits_are_enforced_by_gateway(int v, bool allowed)
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 5000,
            Mobile = MobileAccess.Control, WebEnabled = false,
            Pack = new() { new PackMap { Child = "pump1", Field = "run", Address = 52, Scale = 1, Min = 0, Max = 1 } },
        };
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        var payload = Encoding.UTF8.GetBytes($"{{\"id\":\"k1\",\"child\":\"pump1\",\"key\":\"run\",\"v\":{v}}}");
        var ack = await core.ExecuteKeyAsync(payload, ControlSource.Mobile, "test");
        Assert.NotNull(ack);
        Assert.Equal(allowed, ack!.Contains("\"ok\":true"));
        if (!allowed) Assert.Contains("value_out_of_range", ack);
        Assert.Equal(allowed ? v : 0, plc.Get(52));
    }

    [Fact]
    public async Task Replayed_command_id_and_stale_timestamp_are_rejected()
    {
        await using var rig = new Rig(allowRemote: true);
        rig.Cfg.Pack.Add(new PackMap { Child = "pump1", Field = "run", Address = 52, Scale = 1 });
        rig.Cfg.CmdMaxAgeSec = 10;
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        string Ack(string id) => rig.Cloud.Snapshot().LastOrDefault(m => m.Topic.EndsWith("/ack") && m.Payload.Contains($"\"{id}\"")).Payload ?? "";

        await rig.Cloud.SendCmd(rig.Base, $"{{\"id\":\"c1\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1,\"ts\":{Now()}}}");
        Assert.True(await Net.WaitFor(() => rig.Plc.Get(52) == 1));

        // cùng id gửi lại (kẻ nghe lén phát lại) → từ chối, PLC không bị ghi lần nữa
        rig.Plc.Regs[52] = 0;
        await rig.Cloud.SendCmd(rig.Base, $"{{\"id\":\"c1\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1,\"ts\":{Now()}}}");
        Assert.True(await Net.WaitFor(() => Ack("c1").Contains("replayed_cmd")));
        Assert.Equal(0, rig.Plc.Get(52));

        // lệnh mới nhưng ts cũ 60 s → từ chối
        await rig.Cloud.SendCmd(rig.Base, $"{{\"id\":\"c2\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1,\"ts\":{Now() - 60_000}}}");
        Assert.True(await Net.WaitFor(() => Ack("c2").Contains("stale_cmd")));
        Assert.Equal(0, rig.Plc.Get(52));
    }
}
