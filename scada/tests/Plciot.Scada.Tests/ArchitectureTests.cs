using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using System.Diagnostics;

namespace Plciot.Scada.Tests;

public class CoreSeparationTests
{
    [Fact]
    public void Core_has_no_ui_web_or_mqtt_dependencies()
    {
        var refs = typeof(ScadaCore).Assembly.GetReferencedAssemblies().Select(a => a.Name!).ToList();
        Assert.DoesNotContain(refs, r => r.StartsWith("MQTTnet", StringComparison.Ordinal));
        Assert.DoesNotContain(refs, r => r.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
        Assert.DoesNotContain(refs, r => r.StartsWith("PresentationFramework", StringComparison.Ordinal) || r.StartsWith("System.Windows", StringComparison.Ordinal));
        Assert.DoesNotContain(refs, r => r.StartsWith("Opc.Ua.Server", StringComparison.Ordinal));
    }

    [Fact]
    public void Core_exposes_the_view_interface_that_every_ui_uses()
    {
        Assert.True(typeof(IScadaView).IsAssignableFrom(typeof(ScadaCore)));
        Assert.True(typeof(IScadaView).IsAssignableFrom(typeof(RemoteScreenClient)));
    }
}

public class DirectControlTests
{
    static ScadaConfig Cfg(FakeModbusPlc plc) => new()
    {
        Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port,
        PollMs = 5000,                       // chu kỳ đọc dài: nếu lệnh phải đợi chu kỳ đọc thì test sẽ chậm
        LocalBind = "127.0.0.1", LocalPort = Net.FreePort(), WebBind = "127.0.0.1", WebPort = Net.FreePort(),
        Mobile = MobileAccess.Off,
    };

    [Fact]
    public async Task Core_alone_runs_with_no_broker_no_web_and_controls_the_plc_directly()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc); cfg.WebEnabled = false;
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        Assert.True(await Net.WaitFor(() => core.State.Fresh));
        Assert.Equal(5, core.State.Inputs);

        var sw = Stopwatch.StartNew();
        Assert.Null(await core.WriteAsync(7, 42));
        sw.Stop();
        Assert.Equal(42, plc.Get(7));                                    // đã tới PLC ngay khi WriteAsync trả về
        Assert.True(sw.ElapsedMilliseconds < 250, $"ghi trực tiếp mất {sw.ElapsedMilliseconds} ms");
        Assert.True(await Net.WaitFor(() => core.State.Target == 42, 1500), "đọc lại ngay sau khi ghi, không đợi chu kỳ 5 s");
    }

    [Fact]
    public async Task Writes_outside_the_whitelist_never_reach_the_plc()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc); cfg.WebEnabled = false;
        await using var core = new ScadaCore(cfg, DriverFactory.Create(cfg));
        await core.StartAsync();
        Assert.Equal("not_writable", await core.WriteAsync(0, 99));
        Assert.Equal("bad_value", await core.WriteAsync(7, 70000));
        Assert.Equal(5, plc.Get(0));
    }

    [Fact]
    public async Task Host_opens_no_lan_broker_unless_asked()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc); cfg.WebEnabled = false;
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        await Task.Delay(300);
        using var t = new TcpClient();
        await Assert.ThrowsAnyAsync<Exception>(() => t.ConnectAsync("127.0.0.1", cfg.LocalPort));
        Assert.Null(await host.Core.WriteAsync(6, 1));
        Assert.Equal(1, plc.Get(6));
    }
}

public class RemoteScreenTests
{
    static ScadaConfig HostCfg(FakeModbusPlc plc) => new()
    {
        Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150,
        Topology = Topology.MultiScreen, LocalBind = "127.0.0.1", LocalPort = Net.FreePort(), WebBind = "127.0.0.1", WebPort = Net.FreePort(), Mobile = MobileAccess.Off,
        LocalUsers = { new LocalUser { User = "viewer", Password = "vpw", Role = LocalRole.Monitor }, new LocalUser { User = "oper", Password = "opw", Role = LocalRole.Operator } },
    };

    [Fact]
    public async Task Remote_client_mirrors_state_but_cannot_control()
    {
        using var plc = new FakeModbusPlc();
        var cfg = HostCfg(plc);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Core.State.Fresh));

        await using var client = new RemoteScreenClient($"http://127.0.0.1:{cfg.WebPort}", "viewer", "vpw");
        client.Start();
        Assert.True(await Net.WaitFor(() => client.State.Fresh && client.State.Status == "online"), "client nhận được trạng thái");
        Assert.Equal(5, client.State.Inputs);
        Assert.Equal(7, client.State.Count);
        Assert.Equal("f1", client.Site);
        Assert.False(client.CanControl);
        Assert.Equal("monitor_only", await client.WriteAsync(6, 1));
        await Task.Delay(300);
        Assert.Equal(0, plc.Get(6));

        // dữ liệu đổi ở PLC → client thấy
        lock (plc.Regs) plc.Regs[14] = 99;
        Assert.True(await Net.WaitFor(() => client.State.Count == 99));
    }

    [Fact]
    public async Task Server_refuses_control_over_web_by_default_even_for_operator()
    {
        using var plc = new FakeModbusPlc();
        var cfg = HostCfg(plc);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        var jar = new CookieContainer();
        using var http = new HttpClient(new HttpClientHandler { CookieContainer = jar }) { BaseAddress = new Uri($"http://127.0.0.1:{cfg.WebPort}") };
        http.DefaultRequestHeaders.Add("X-Requested-With", "scada");
        Assert.Equal(HttpStatusCode.OK, (await http.PostAsJsonAsync("/api/login", new { user = "oper", password = "opw" })).StatusCode);
        var r = await http.PostAsJsonAsync("/api/cmd", new { a = 6, v = 1 });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Contains("monitor_only", await r.Content.ReadAsStringAsync());
        await Task.Delay(300);
        Assert.Equal(0, plc.Get(6));
        var st = JsonDocument.Parse(await http.GetStringAsync("/api/state")).RootElement;
        Assert.False(st.GetProperty("canControl").GetBoolean());
    }

    [Fact]
    public async Task Remote_client_reconnects_after_the_server_restarts()
    {
        using var plc = new FakeModbusPlc();
        var cfg = HostCfg(plc);
        var host = new ScadaHost(cfg);
        await host.StartAsync();
        await using var client = new RemoteScreenClient($"http://127.0.0.1:{cfg.WebPort}", "viewer", "vpw");
        client.Start();
        Assert.True(await Net.WaitFor(() => client.Connected));
        await host.DisposeAsync();
        Assert.True(await Net.WaitFor(() => !client.Connected, 6000));
        Assert.False(client.State.Fresh);
        host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => client.Connected && client.State.Fresh, 15000), "tự nối lại");
        await host.DisposeAsync();
    }

    [Fact]
    public async Task Remote_client_with_wrong_password_never_connects()
    {
        using var plc = new FakeModbusPlc();
        var cfg = HostCfg(plc);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        await using var client = new RemoteScreenClient($"http://127.0.0.1:{cfg.WebPort}", "viewer", "sai");
        client.Start();
        await Task.Delay(2500);
        Assert.False(client.Connected);
    }
}
