using System.Net.Sockets;
using System.Text;
using Plciot.Solution.Template;

namespace Plciot.Scada.Tests;

public class TopologyTests
{
    static ScadaConfig Cfg(FakeModbusPlc plc, Topology t) => new()
    {
        Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150,
        Topology = t, WebEnabled = true, WebBind = "127.0.0.1", WebPort = Net.FreePort(), LocalPort = Net.FreePort(), LocalBind = "127.0.0.1",
        LocalUsers = { new LocalUser { User = "v", Password = "p", Role = LocalRole.Monitor } },
    };

    [Fact]
    public async Task Single_screen_opens_no_client_server_port_even_if_web_is_enabled()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc, Topology.SingleScreen);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.Equal(0, host.WebPort);
        using var t = new TcpClient();
        await Assert.ThrowsAnyAsync<Exception>(() => t.ConnectAsync("127.0.0.1", cfg.WebPort));
        Assert.Null(await host.Core.WriteAsync(6, 1));                  // vẫn điều khiển trực tiếp tại máy
        Assert.Equal(1, plc.Get(6));
    }

    [Fact]
    public async Task Multi_screen_serves_the_other_screens()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc, Topology.MultiScreen);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.True(host.WebPort > 0);
        await using var screen = new RemoteScreenClient($"http://127.0.0.1:{cfg.WebPort}", "v", "p");
        screen.Start();
        Assert.True(await Net.WaitFor(() => screen.Connected && screen.State.Fresh));
    }

    [Fact]
    public void Screen_station_is_only_valid_in_multi_screen()
    {
        var cfg = new ScadaConfig { Station = StationRole.Screen, Topology = Topology.SingleScreen };
        Assert.NotNull(cfg.Validate());
        cfg.Topology = Topology.MultiScreen;
        Assert.Null(cfg.Validate());
    }
}

public class ControlPolicyTests
{
    static byte[] Cmd(int a, int v) => Encoding.UTF8.GetBytes($"{{\"id\":\"t\",\"a\":{a},\"v\":{v}}}");

    // topology, remoteScreens, mobile, lan, source, mong đợi được ghi
    [Theory]
    [InlineData(Topology.SingleScreen, false, MobileAccess.Off, false, ControlSource.LocalScreen, true)]
    [InlineData(Topology.SingleScreen, true, MobileAccess.Off, false, ControlSource.RemoteScreen, false)]    // một màn hình: không có màn hình phụ
    [InlineData(Topology.MultiScreen, false, MobileAccess.Off, false, ControlSource.RemoteScreen, false)]
    [InlineData(Topology.MultiScreen, true, MobileAccess.Off, false, ControlSource.RemoteScreen, true)]
    [InlineData(Topology.MultiScreen, true, MobileAccess.Off, false, ControlSource.LocalScreen, true)]
    [InlineData(Topology.SingleScreen, false, MobileAccess.Off, false, ControlSource.Mobile, false)]
    [InlineData(Topology.SingleScreen, false, MobileAccess.MonitorOnly, false, ControlSource.Mobile, false)]
    [InlineData(Topology.SingleScreen, false, MobileAccess.Control, false, ControlSource.Mobile, true)]
    [InlineData(Topology.SingleScreen, false, MobileAccess.Control, false, ControlSource.RemoteScreen, false)]   // điện thoại được phép KHÔNG kéo theo màn hình phụ
    [InlineData(Topology.SingleScreen, false, MobileAccess.Off, false, ControlSource.Lan, false)]
    [InlineData(Topology.SingleScreen, false, MobileAccess.Off, true, ControlSource.Lan, true)]
    public async Task Write_permission_matrix(Topology top, bool remote, MobileAccess mobile, bool lan, ControlSource src, bool allowed)
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 5000,
            Topology = top, Mobile = mobile, Control = { RemoteScreens = remote, Lan = lan }, WebEnabled = false,
        };
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        var ack = await core.ExecuteAsync(Cmd(7, 55), src, "test");
        Assert.NotNull(ack);
        Assert.Equal(allowed, ack!.Contains("\"ok\":true"));
        Assert.Equal(allowed ? 55 : 0, plc.Get(7));
        if (!allowed) Assert.Contains(src == ControlSource.Mobile ? "remote_disabled" : "control_disabled", ack);
    }

    [Fact]
    public async Task Reads_are_always_allowed_from_every_source()
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig { Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 5000, Control = { LocalScreen = false }, WebEnabled = false };
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        foreach (var src in Enum.GetValues<ControlSource>())
        {
            var ack = await core.ExecuteAsync(Encoding.UTF8.GetBytes("{\"id\":\"r\",\"op\":\"read\",\"a\":0,\"n\":2}"), src, "t");
            Assert.Contains("\"ok\":true", ack);
        }
        Assert.Equal("control_disabled", await core.WriteAsync(7, 1));        // màn hình chính bị khoá bởi chính sách
    }

    [Fact]
    public async Task Writable_registers_are_customisable_per_solution()
    {
        using var plc = new FakeModbusPlc();
        var cfg = new ScadaConfig { Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 5000, WebEnabled = false };
        await using (var core = new ScadaCore(cfg, DriverFactory.Create(cfg)))
        {
            await core.StartAsync();
            Assert.Equal("not_writable", await core.WriteAsync(10, 1));      // mặc định D10 không ghi được
        }
        cfg.WritableRegisters = new() { 3, 4, 6, 7, 9, 10 };
        await using (var core2 = new ScadaCore(cfg, DriverFactory.Create(cfg)))
        {
            await core2.StartAsync();
            Assert.Null(await core2.WriteAsync(10, 1));
            Assert.Equal(1, plc.Get(10));
            Assert.Equal("not_writable", await core2.WriteAsync(0, 1));      // vẫn từ chối thanh ghi ngoài danh sách
        }
    }

    [Fact]
    public void Invalid_writable_registers_are_rejected()
    {
        Assert.NotNull(new ScadaConfig { WritableRegisters = new() { 3, 3 } }.Validate());
        Assert.NotNull(new ScadaConfig { WritableRegisters = new() { 300 } }.Validate());
    }

    [Fact]
    public void Mobile_off_means_no_cloud_bridge()
    {
        Assert.False(new ScadaConfig { Mobile = MobileAccess.Off }.CloudEnabled);
        Assert.True(new ScadaConfig { Mobile = MobileAccess.MonitorOnly }.CloudEnabled);
        Assert.True(new ScadaConfig { Mobile = MobileAccess.Control }.AllowRemoteControl);
        Assert.False(new ScadaConfig { Mobile = MobileAccess.MonitorOnly }.AllowRemoteControl);
    }
}

public class RemoteScreenControlTests
{
    static ScadaConfig Main(FakeModbusPlc plc, bool remoteControl) => new()
    {
        Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150,
        Topology = Topology.MultiScreen, WebBind = "127.0.0.1", WebPort = Net.FreePort(), LocalPort = Net.FreePort(), LocalBind = "127.0.0.1",
        Control = { RemoteScreens = remoteControl },
        LocalUsers = { new LocalUser { User = "oper", Password = "o", Role = LocalRole.Operator }, new LocalUser { User = "view", Password = "v", Role = LocalRole.Monitor } },
    };

    [Fact]
    public async Task Operator_screen_can_control_when_policy_allows_and_viewer_cannot()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Main(plc, remoteControl: true);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        var url = $"http://127.0.0.1:{cfg.WebPort}";
        await using var op = new RemoteScreenClient(url, "oper", "o");
        await using var vw = new RemoteScreenClient(url, "view", "v");
        op.Start(); vw.Start();
        Assert.True(await Net.WaitFor(() => op.Connected && op.State.Fresh && vw.Connected && vw.State.Fresh));
        Assert.True(await Net.WaitFor(() => op.CanControl));
        Assert.False(vw.CanControl);
        Assert.Null(await op.WriteAsync(7, 21));                              // màn hình phụ → máy chủ → lõi → PLC
        Assert.Equal(21, plc.Get(7));
        Assert.Equal("monitor_only", await vw.WriteAsync(7, 22));
        Assert.Equal(21, plc.Get(7));
    }

    [Fact]
    public async Task Operator_screen_is_monitor_only_when_policy_forbids()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Main(plc, remoteControl: false);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        await using var op = new RemoteScreenClient($"http://127.0.0.1:{cfg.WebPort}", "oper", "o");
        op.Start();
        Assert.True(await Net.WaitFor(() => op.Connected && op.State.Fresh));
        await Task.Delay(500);
        Assert.False(op.CanControl);
        Assert.Equal("monitor_only", await op.WriteAsync(7, 21));
        Assert.Equal(0, plc.Get(7));
    }
}

public class SolutionRunnerTests
{
    static string TempCfg() => Path.Combine(Path.GetTempPath(), $"sol-{Guid.NewGuid():N}.json");

    [Fact]
    public async Task Template_solution_creates_its_config_and_runs_its_modules()
    {
        var path = TempCfg();
        try
        {
            using var plc = new FakeModbusPlc();
            // lần chạy đầu: chưa có file → dùng CreateDefaultConfig rồi ghi ra; sau đó nhân viên hiện trường sửa IP bằng file
            try { await using var first = await SolutionRunner.StartAsync(new TemplateSolution(), new[] { "--config", path }); } catch { /* PLC mặc định chưa tồn tại: chỉ cần file được tạo */ }
            Assert.True(File.Exists(path));
            var cfg = ConfigStore.Load(path);
            cfg.PlcPort = plc.Port; cfg.PlcHost = "127.0.0.1"; cfg.PollMs = 150; cfg.WebEnabled = false;
            ConfigStore.Save(path, cfg);

            await using var run = await SolutionRunner.StartAsync(new TemplateSolution(), new[] { "--config", path });
            Assert.True(run.Context.IsMainStation);
            Assert.True(await Net.WaitFor(() => run.Context.View.State.Fresh));
            Assert.Contains(run.Context.Core!.RecentLog, l => l.Contains("Module khởi động: TargetReachedLog"));
            Assert.Null(await run.Context.View.WriteAsync(6, 1));
            Assert.Equal(1, plc.Get(6));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task Solution_enforces_decisions_the_config_file_cannot_override()
    {
        var path = TempCfg();
        try
        {
            using var plc = new FakeModbusPlc();
            var cfg = new TemplateSolution().CreateDefaultConfig();
            cfg.PlcHost = "127.0.0.1"; cfg.PlcPort = plc.Port;
            cfg.Topology = Topology.MultiScreen;                     // nhà máy cố tình sửa file…
            cfg.Mobile = MobileAccess.Off;
            cfg.Control.RemoteScreens = true;
            cfg.WritableRegisters = new() { 3, 4, 6, 7, 9, 10, 11 };
            cfg.WebEnabled = false;
            ConfigStore.Save(path, cfg);

            await using var run = await SolutionRunner.StartAsync(new TemplateSolution(), new[] { "--config", path });
            var c = run.Context.Config;                              // …nhưng giải pháp khoá lại
            Assert.Equal(Topology.SingleScreen, c.Topology);
            Assert.False(c.Control.RemoteScreens);
            Assert.Equal(new[] { 3, 4, 6, 7, 9 }, c.WritableRegisters);
            Assert.True(await Net.WaitFor(() => run.Context.View.State.Fresh));
            Assert.Equal("not_writable", await run.Context.View.WriteAsync(10, 1));
        }
        finally { File.Delete(path); }
    }

    sealed class MultiSolution : IScadaSolution
    {
        public string Name => "Multi";
        public ScadaConfig CreateDefaultConfig() => new ScadaConfig().UseMultiScreen(remoteScreensCanControl: true).UseMobile(MobileAccess.Off);
        public void Enforce(ScadaConfig cfg) { }
        public IEnumerable<IScadaModule> CreateModules() => Array.Empty<IScadaModule>();
        public IScadaUi? CreateUi() => null;
    }

    [Fact]
    public async Task Main_and_screen_stations_run_from_the_same_solution()
    {
        var mainPath = TempCfg(); var screenPath = TempCfg();
        try
        {
            using var plc = new FakeModbusPlc();
            var m = new MultiSolution().CreateDefaultConfig();
            m.Source = PlcSource.ModbusTcp; m.PlcHost = "127.0.0.1"; m.PlcPort = plc.Port; m.PollMs = 150; m.WebBind = "127.0.0.1"; m.WebPort = Net.FreePort(); m.LocalPort = Net.FreePort(); m.LocalBind = "127.0.0.1";
            m.LocalUsers = new() { new LocalUser { User = "oper", Password = "o", Role = LocalRole.Operator } };
            ConfigStore.Save(mainPath, m);
            var s = new ScadaConfig().AsScreenStation($"http://127.0.0.1:{m.WebPort}", "oper", "o");
            ConfigStore.Save(screenPath, s);

            await using var main = await SolutionRunner.StartAsync(new MultiSolution(), new[] { "--config", mainPath });
            await using var screen = await SolutionRunner.StartAsync(new MultiSolution(), new[] { "--config", screenPath });
            Assert.True(main.Context.IsMainStation);
            Assert.False(screen.Context.IsMainStation);                       // máy phụ không có lõi, không nối PLC
            Assert.True(await Net.WaitFor(() => screen.Context.View.State.Fresh && screen.Context.View.CanControl));
            Assert.Null(await screen.Context.View.WriteAsync(7, 9));
            Assert.Equal(9, plc.Get(7));
        }
        finally { File.Delete(mainPath); File.Delete(screenPath); }
    }

    [Fact]
    public async Task Invalid_config_is_reported_not_run()
    {
        var path = TempCfg();
        try
        {
            var cfg = new TemplateSolution().CreateDefaultConfig();
            cfg.PollMs = 10;
            ConfigStore.Save(path, cfg);
            await Assert.ThrowsAsync<InvalidOperationException>(() => SolutionRunner.StartAsync(new TemplateSolution(), new[] { "--config", path }));
        }
        finally { File.Delete(path); }
    }
}

public class SolutionIsolationTests
{
    [Fact]
    public void Framework_layers_never_reference_a_customer_solution()
    {
        foreach (var t in new[] { typeof(ScadaCore), typeof(ScadaHost), typeof(SolutionRunner) })
            Assert.DoesNotContain(t.Assembly.GetReferencedAssemblies(), a => a.Name!.StartsWith("Plciot.Solution", StringComparison.Ordinal));
    }

    [Fact]
    public void A_solution_depends_on_the_framework_only_not_on_transport_libraries()
    {
        var refs = typeof(TemplateSolution).Assembly.GetReferencedAssemblies().Select(a => a.Name!).ToList();
        Assert.DoesNotContain(refs, r => r.StartsWith("MQTTnet", StringComparison.Ordinal) || r.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
        Assert.DoesNotContain(refs, r => r.StartsWith("Opc.Ua", StringComparison.Ordinal) || r == "S7.Net");
    }
}
