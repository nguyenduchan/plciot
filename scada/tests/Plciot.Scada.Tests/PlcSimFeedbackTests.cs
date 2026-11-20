using System.Text.Json;

namespace Plciot.Scada.Tests;

/// <summary>
/// CHẶNG 1 của "điều khiển + phản hồi thật": gateway C# (ScadaHost) ↔ PlcSim (PlcModel + máy chủ Modbus TCP thật, biên dịch thẳng từ tools/PlcSim).
/// PlcSim mô phỏng một RELAY: field DO "run" (ghi được) và field DI "di1" ở chế độ Follow (lặp lại run sau 1 giây).
/// Webapp gửi {child,key,v} qua cloud → gateway ghi D50 → PlcSim đổi di1 → telemetry mang di1 lên cloud; bản tin config mang `fb`.
/// </summary>
public class PlcSimFeedbackTests
{
    sealed class Desc : IConfigDescriber
    {
        public string? DeviceTitle(string child) => "Bơm";
        public FieldView? Field(string child, string field) => field switch
        {
            "run" => new FieldView("Chạy bơm", "", "switch", Fb: "di1"),    // đúng thứ GatewayApp (MetaDescriber) trả khi người dùng đặt "Phản hồi từ field"
            "di1" => new FieldView("Tiếp điểm relay", "", "kpi"),
            _ => null,
        };
    }

    sealed class Sim : IAsyncDisposable
    {
        public readonly PlcSim.PlcModel Model = new();
        public readonly int Port = Net.FreePort();
        readonly PlcSim.Protocols.ModbusTcpSlave _slave;
        readonly Timer _tick;
        public Sim(double relayDelaySec)
        {
            Model.SetField("pump1", "run", 0, "ui"); Model.MapField("pump1", "run", 50, 1);
            Model.SetMeta("pump1", "run", new PlcSim.PlcModel.Meta("modbus", PlcSim.PlcModel.Access.ReadWrite, "1"));
            Model.SetField("pump1", "di1", 0, "ui"); Model.MapField("pump1", "di1", 51, 1);
            Model.SetMeta("pump1", "di1", new PlcSim.PlcModel.Meta("modbus", PlcSim.PlcModel.Access.Read, "1"));
            Model.SetMode("pump1", "di1", new PlcSim.PlcModel.Gen(PlcSim.PlcModel.FieldMode.Follow, 0, 1, Follow: "run", Delay: relayDelaySec));
            _slave = new PlcSim.Protocols.ModbusTcpSlave(Model, "127.0.0.1", Port, _ => { });
            _slave.StartAsync().GetAwaiter().GetResult();
            _tick = new Timer(_ => Model.SimTick(), null, 1000, 1000);   // PlcSim chạy GenTick mỗi giây
        }
        public async ValueTask DisposeAsync() { _tick.Dispose(); await _slave.DisposeAsync(); }
    }

    static ScadaConfig Cfg(Sim sim, FakeCloud cloud) => new()
    {
        Site = "f1", Device = "plc01", PollMs = 150, HistoryMs = 500,
        LocalBind = "127.0.0.1", LocalPort = Net.FreePort(), WebEnabled = false,
        CloudHost = "127.0.0.1", CloudPort = cloud.Port, CloudUser = "gw", CloudPassword = "secret", CloudPinSha256 = cloud.PinSha256,
        CloudTelemetryMinMs = 100, Mobile = MobileAccess.Control, LocalBrokerEnabled = true,
        Topology = Topology.MultiScreen, Control = { Lan = true },
        LocalUsers = { new LocalUser { User = "gw", Password = "gwpass", Role = LocalRole.Device } },
        Connections = new() { new PlcConnection { Protocol = PlcSource.ModbusTcp, Host = "127.0.0.1", Port = sim.Port } },
        Pack =
        {
            new() { Child = "pump1", Field = "run", Address = 50, Scale = 1, Min = 0, Max = 1, Access = PackAccess.ReadWrite, Protocol = "ModbusTcp", DataType = PlcDataType.UInt16, Params = new() { ["unit"] = "1" } },
            new() { Child = "pump1", Field = "di1", Address = 51, Scale = 1, Access = PackAccess.Read, Protocol = "ModbusTcp", DataType = PlcDataType.UInt16, Params = new() { ["unit"] = "1" } },
        },
    };

    static double? D(string payload, string child, string key)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            return doc.RootElement.TryGetProperty("d", out var d) && d.TryGetProperty(child, out var c) && c.TryGetProperty(key, out var v) ? v.GetDouble() : null;
        }
        catch (JsonException) { return null; }
    }

    static double? Last(FakeCloud cloud, string baseTopic, string key) =>
        cloud.Snapshot().Where(m => m.Topic == baseTopic + "/telemetry").Select(m => D(m.Payload, "pump1", key)).LastOrDefault(v => v != null);

    [Fact]
    public async Task Command_from_cloud_reaches_plcsim_and_the_feedback_input_follows_into_telemetry()
    {
        await using var cloud = new FakeCloud(); await cloud.StartAsync();
        await using var sim = new Sim(relayDelaySec: 1);
        var cfg = Cfg(sim, cloud);
        await using var host = new ScadaHost(cfg) { Describer = new Desc() };
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Cloud == CloudState.Connected), "gateway phải nối cloud");
        Assert.True(await Net.WaitFor(() => Last(cloud, cfg.BaseTopic, "di1") == 0), "telemetry ban đầu: di1 = 0");

        // bản tin config mang `fb` cho field lệnh (webapp dựa vào đây để biết cặp lệnh ↔ phản hồi)
        Assert.True(await Net.WaitFor(() => cloud.Snapshot().Any(m => m.Topic == cfg.BaseTopic + "/config")));
        using (var conf = JsonDocument.Parse(cloud.Snapshot().Last(m => m.Topic == cfg.BaseTopic + "/config").Payload))
        {
            var fields = conf.RootElement.GetProperty("devices")[0].GetProperty("fields").EnumerateArray().ToDictionary(f => f.GetProperty("key").GetString()!);
            Assert.Equal("di1", fields["run"].GetProperty("fb").GetString());
            Assert.False(fields["di1"].TryGetProperty("fb", out _), "field chỉ đọc không có fb");
        }

        // webapp bấm BẬT
        await Task.Delay(300);
        await cloud.SendCmd(cfg.BaseTopic, "{\"id\":\"c1\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1}");
        Assert.True(await Net.WaitFor(() => cloud.Snapshot().Any(m => m.Topic == cfg.BaseTopic + "/ack" && m.Payload.Contains("\"c1\"") && m.Payload.Contains("\"ok\":true"))), "gateway phải ack ok");
        Assert.True(await Net.WaitFor(() => sim.Model.Get(50) == 1), "PlcSim nhận D50 = 1");
        Assert.True(await Net.WaitFor(() => Last(cloud, cfg.BaseTopic, "run") == 1), "telemetry: run = 1 (lệnh)");
        // relay đóng sau ~1 s → DI phản hồi lên telemetry
        Assert.True(await Net.WaitFor(() => Last(cloud, cfg.BaseTopic, "di1") == 1, 8000), "telemetry: di1 = 1 (cảm biến xác nhận)");

        // webapp bấm TẮT
        await cloud.SendCmd(cfg.BaseTopic, "{\"id\":\"c2\",\"child\":\"pump1\",\"key\":\"run\",\"v\":0}");
        Assert.True(await Net.WaitFor(() => Last(cloud, cfg.BaseTopic, "run") == 0 && Last(cloud, cfg.BaseTopic, "di1") == 0, 8000), "tắt: run và di1 cùng về 0");

        // Ghi lại đúng những gì gateway đã đẩy lên cloud (config + telemetry + ack) để chặng 2 phát lại cho webapp thật: PLCSIM_FB_DUMP=<file>
        if (Environment.GetEnvironmentVariable("PLCSIM_FB_DUMP") is { Length: > 0 } dump)
        {
            var all = cloud.Snapshot();
            var steps = new List<object>(); (double?, double?) prev = (null, null);
            foreach (var m in all.Where(m => m.Topic == cfg.BaseTopic + "/telemetry"))
            {
                var cur = (D(m.Payload, "pump1", "run"), D(m.Payload, "pump1", "di1"));
                if (cur.Item1 == null || cur.Item2 == null || cur == prev) continue;
                prev = cur; steps.Add(JsonDocument.Parse(m.Payload).RootElement.Clone());
            }
            File.WriteAllText(dump, JsonSerializer.Serialize(new
            {
                config = JsonDocument.Parse(all.Last(m => m.Topic == cfg.BaseTopic + "/config").Payload).RootElement.Clone(),
                telemetry = steps,
                acks = all.Where(m => m.Topic == cfg.BaseTopic + "/ack").Select(m => JsonDocument.Parse(m.Payload).RootElement.Clone()).ToList(),
            }));
        }
    }

    [Fact]
    public async Task Broken_relay_keeps_feedback_at_zero_so_webapp_can_warn()
    {
        await using var cloud = new FakeCloud(); await cloud.StartAsync();
        await using var sim = new Sim(relayDelaySec: -1);          // relay/cảm biến hỏng: DI không bao giờ đổi
        var cfg = Cfg(sim, cloud);
        await using var host = new ScadaHost(cfg) { Describer = new Desc() };
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Cloud == CloudState.Connected));
        await Task.Delay(300);
        await cloud.SendCmd(cfg.BaseTopic, "{\"id\":\"c3\",\"child\":\"pump1\",\"key\":\"run\",\"v\":1}");
        Assert.True(await Net.WaitFor(() => Last(cloud, cfg.BaseTopic, "run") == 1), "lệnh vẫn tới PLC");
        await Task.Delay(3500);
        Assert.Equal(0, Last(cloud, cfg.BaseTopic, "di1"));       // lệch kéo dài: lệnh = 1, cảm biến = 0
    }
}
