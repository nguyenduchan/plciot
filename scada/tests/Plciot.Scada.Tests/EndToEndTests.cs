using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using MQTTnet;
using MQTTnet.Client;
using MQTTnet.Protocol;

namespace Plciot.Scada.Tests;

public sealed class Rig : IAsyncDisposable
{
    public readonly FakeModbusPlc Plc = new();
    public readonly FakeCloud Cloud = new();
    public readonly ScadaConfig Cfg;
    public ScadaHost Engine = null!;
    public string Base => Cfg.BaseTopic;

    public Rig(bool pinCorrect = true, bool allowRemote = false)
    {
        Cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01",
            Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = Plc.Port, PollMs = 150, HistoryMs = 500,
            LocalBind = "127.0.0.1", LocalPort = Net.FreePort(),
            WebBind = "127.0.0.1", WebPort = Net.FreePort(),
            CloudHost = "127.0.0.1", CloudPort = Cloud.Port, CloudUser = "gw", CloudPassword = "secret",
            CloudPinSha256 = pinCorrect ? Cloud.PinSha256 : new string('0', 64),
            CloudTelemetryMinMs = 100,
            Mobile = allowRemote ? MobileAccess.Control : MobileAccess.MonitorOnly, LocalBrokerEnabled = true,
            Topology = Topology.MultiScreen, Control = { Lan = true },
            LocalUsers =
            {
                new LocalUser { User = "gw", Password = "gwpass", Role = LocalRole.Device },
                new LocalUser { User = "oper", Password = "operpass", Role = LocalRole.Operator },
                new LocalUser { User = "view", Password = "viewpass", Role = LocalRole.Monitor },
            },
        };
        Cfg.LocalUsers.RemoveAll(u => u.User == "gw" && u.Password == "");
    }

    public async Task StartAsync()
    {
        await Cloud.StartAsync();
        Engine = new ScadaHost(Cfg);
        await Engine.StartAsync();
    }

    public bool CloudGot(Func<(string Topic, string Payload, bool Retain), bool> f) => Cloud.Snapshot().Any(f);

    public async ValueTask DisposeAsync()
    {
        await Engine.DisposeAsync();
        await Cloud.DisposeAsync();
        Plc.Dispose();
    }

    public async Task<IMqttClient> LanClient(string user, string pass)
    {
        var c = new MqttFactory().CreateMqttClient();
        var res = await c.ConnectAsync(new MqttClientOptionsBuilder().WithTcpServer("127.0.0.1", Cfg.LocalPort)
            .WithCredentials(user, pass).WithClientId("lan-" + Guid.NewGuid().ToString("N")[..6]).Build());
        Assert.Equal(MqttClientConnectResultCode.Success, res.ResultCode);
        return c;
    }
}

public class TlsBridgeTests
{
    [Fact]
    public async Task Telemetry_and_status_reach_the_cloud_over_tls()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/telemetry" && m.Retain && m.Payload.StartsWith("{\"r\":[5,"))),
            "telemetry (D0=5) phải lên cloud, retained");
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/status" && m.Payload == "online")));
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/history")), "history phải lên cloud");
        Assert.Equal(CloudState.Connected, rig.Engine.Cloud);
    }

    [Fact]
    public async Task Wrong_certificate_pin_is_refused()
    {
        await using var rig = new Rig(pinCorrect: false);
        await rig.StartAsync();
        await Task.Delay(2500);
        Assert.NotEqual(CloudState.Connected, rig.Engine.Cloud);
        Assert.Empty(rig.Cloud.Snapshot());
    }

    [Fact]
    public async Task Cmd_topic_is_never_sent_up_to_the_cloud()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        await rig.Engine.Core.WriteAsync(7, 12);
        await Task.Delay(800);
        Assert.False(rig.CloudGot(m => m.Topic.EndsWith("/cmd")));
    }
}

public class RemoteControlTests
{
    [Fact]
    public async Task Remote_write_is_rejected_when_switch_is_off()
    {
        await using var rig = new Rig(allowRemote: false);
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        await Task.Delay(300);
        await rig.Cloud.SendCmd(rig.Base, "{\"id\":\"p1\",\"a\":6,\"v\":1}");
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/ack" && m.Payload.Contains("remote_disabled") && m.Payload.Contains("\"p1\""))));
        Assert.Equal(0, rig.Plc.Get(6));
    }

    [Fact]
    public async Task Remote_write_goes_through_when_enabled_and_is_acked()
    {
        await using var rig = new Rig(allowRemote: true);
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        await Task.Delay(300);
        await rig.Cloud.SendCmd(rig.Base, "{\"id\":\"p2\",\"a\":6,\"v\":1}");
        Assert.True(await Net.WaitFor(() => rig.Plc.Get(6) == 1), "PLC D6 phải được ghi");
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/ack" && m.Payload.Contains("\"p2\"") && m.Payload.Contains("\"ok\":true"))));
    }

    [Fact]
    public async Task Remote_cannot_write_registers_outside_whitelist_even_when_enabled()
    {
        await using var rig = new Rig(allowRemote: true);
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        await Task.Delay(300);
        await rig.Cloud.SendCmd(rig.Base, "{\"id\":\"p3\",\"a\":0,\"v\":99}");     // D0 = đầu vào
        await rig.Cloud.SendCmd(rig.Base, "{\"id\":\"p4\",\"a\":14,\"v\":0}");     // số đếm
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Payload.Contains("\"p3\"") && m.Payload.Contains("not_writable"))));
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Payload.Contains("\"p4\"") && m.Payload.Contains("not_writable"))));
        Assert.Equal(5, rig.Plc.Get(0));
        Assert.Equal(7, rig.Plc.Get(14));
    }

    [Fact]
    public async Task Remote_reads_work_even_when_control_switch_is_off()
    {
        await using var rig = new Rig(allowRemote: false);
        rig.Plc.Regs[100] = 42;
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        await Task.Delay(300);
        await rig.Cloud.SendCmd(rig.Base, "{\"id\":\"r1\",\"op\":\"read\",\"a\":100,\"n\":2}");
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Payload.Contains("\"r1\"") && m.Payload.Contains("\"v\":[42,0]"))));
    }

    [Fact]
    public async Task Remote_commands_are_rate_limited()
    {
        await using var rig = new Rig(allowRemote: true);
        rig.Cfg.RemoteCmdPerSec = 2;
        await rig.StartAsync();
        Assert.True(await Net.WaitFor(() => rig.Engine.Cloud == CloudState.Connected));
        await Task.Delay(300);
        for (var i = 0; i < 12; i++) await rig.Cloud.SendCmd(rig.Base, $"{{\"id\":\"f{i}\",\"a\":7,\"v\":{i}}}");
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Payload.Contains("rate_limited"))));
    }
}

public class LanBrokerTests
{
    [Fact]
    public async Task Wrong_password_and_anonymous_are_refused()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = new MqttFactory().CreateMqttClient();
        await Assert.ThrowsAnyAsync<Exception>(() => c.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer("127.0.0.1", rig.Cfg.LocalPort).WithCredentials("oper", "wrong").Build()));
        var c2 = new MqttFactory().CreateMqttClient();
        await Assert.ThrowsAnyAsync<Exception>(() => c2.ConnectAsync(new MqttClientOptionsBuilder()
            .WithTcpServer("127.0.0.1", rig.Cfg.LocalPort).Build()));
    }

    [Fact]
    public async Task Cannot_impersonate_internal_components()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = new MqttFactory().CreateMqttClient();
        await Assert.ThrowsAnyAsync<Exception>(() => c.ConnectAsync(new MqttClientOptionsBuilder().WithTcpServer("127.0.0.1", rig.Cfg.LocalPort)
            .WithCredentials("oper", "operpass").WithClientId("scada-cloud").Build()));
    }

    [Fact]
    public async Task Monitor_role_can_read_telemetry_but_not_cmd_and_cannot_publish()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var v = await rig.LanClient("view", "viewpass");
        var got = new List<string>();
        v.ApplicationMessageReceivedAsync += e => { got.Add(e.ApplicationMessage.Topic); return Task.CompletedTask; };
        var okSub = await v.SubscribeAsync(new MqttClientSubscribeOptionsBuilder().WithTopicFilter(rig.Base + "/telemetry").Build());
        Assert.Equal(MqttClientSubscribeResultCode.GrantedQoS0, okSub.Items.Single().ResultCode);
        Assert.True(await Net.WaitFor(() => got.Contains(rig.Base + "/telemetry")), "retained/live telemetry phải tới");

        var badSub = await v.SubscribeAsync(new MqttClientSubscribeOptionsBuilder().WithTopicFilter(rig.Base + "/cmd").Build());
        Assert.NotEqual(MqttClientSubscribeResultCode.GrantedQoS0, badSub.Items.Single().ResultCode);
        var wild = await v.SubscribeAsync(new MqttClientSubscribeOptionsBuilder().WithTopicFilter("#").Build());
        Assert.NotEqual(MqttClientSubscribeResultCode.GrantedQoS0, wild.Items.Single().ResultCode);

        await v.PublishStringAsync(rig.Base + "/cmd", "{\"id\":\"v\",\"a\":6,\"v\":1}");
        await Task.Delay(600);
        Assert.Equal(0, rig.Plc.Get(6));
    }

    [Fact]
    public async Task Operator_role_can_control_via_lan()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var o = await rig.LanClient("oper", "operpass");
        await o.PublishStringAsync(rig.Base + "/cmd", "{\"id\":\"o1\",\"a\":7,\"v\":25}");
        Assert.True(await Net.WaitFor(() => rig.Plc.Get(7) == 25));
    }

    [Fact]
    public async Task Device_role_cannot_send_cmd()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var g = await rig.LanClient("gw", "gwpass");
        await g.PublishStringAsync(rig.Base + "/cmd", "{\"id\":\"g\",\"a\":6,\"v\":1}");
        await Task.Delay(600);
        Assert.Equal(0, rig.Plc.Get(6));
    }

    [Fact]
    public async Task Gateway_mode_telemetry_from_lan_gateway_is_forwarded_to_cloud()
    {
        await using var rig = new Rig();
        rig.Cfg.Source = PlcSource.Gateway;      // ESP32 trong nhà máy nối vào broker nội bộ
        await rig.StartAsync();
        var g = await rig.LanClient("gw", "gwpass");
        await g.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(rig.Base + "/telemetry")
            .WithPayload("{\"r\":[9,0,0,0,0,0,0,0,1]}").WithRetainFlag().Build());
        await g.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(rig.Base + "/status").WithPayload("online").WithRetainFlag().Build());
        Assert.True(await Net.WaitFor(() => rig.CloudGot(m => m.Topic == rig.Base + "/telemetry" && m.Payload.StartsWith("{\"r\":[9,"))));
        Assert.True(await Net.WaitFor(() => rig.Engine.Core.State.Inputs == 9));
        // gateway không được publish sang site khác
        await g.PublishStringAsync("plc/other/plc01/telemetry", "{\"r\":[1]}");
        await Task.Delay(500);
        Assert.False(rig.CloudGot(m => m.Topic.StartsWith("plc/other/")));
    }
}

public class WebUiTests
{
    static HttpClient Client(Rig rig, out CookieContainer jar)
    {
        jar = new CookieContainer();
        var h = new HttpClientHandler { CookieContainer = jar, UseCookies = true };
        var c = new HttpClient(h) { BaseAddress = new Uri($"http://127.0.0.1:{rig.Cfg.WebPort}") };
        c.DefaultRequestHeaders.Add("X-Requested-With", "scada");
        return c;
    }

    static async Task<HttpClient> LoggedIn(Rig rig, string user, string pass)
    {
        var c = Client(rig, out _);
        var r = await c.PostAsJsonAsync("/api/login", new { user, password = pass });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        return c;
    }

    [Fact]
    public async Task Pages_are_served_and_state_requires_login()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = Client(rig, out _);
        Assert.Contains("SCADA", await c.GetStringAsync("/"));
        Assert.Contains("EventSource", await c.GetStringAsync("/app.js"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/state")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/cmd", new { a = 6, v = 1 })).StatusCode);
    }

    [Fact]
    public async Task Login_rejects_bad_credentials_and_device_accounts()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = Client(rig, out _);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/login", new { user = "oper", password = "nope" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/login", new { user = "gw", password = "gwpass" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/login", new { user = "oper", password = "" })).StatusCode);
    }

    [Fact]
    public async Task Repeated_failures_lock_out_the_ip()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = Client(rig, out _);
        for (var i = 0; i < 5; i++) await c.PostAsJsonAsync("/api/login", new { user = "oper", password = "bad" + i });
        Assert.Equal((HttpStatusCode)429, (await c.PostAsJsonAsync("/api/login", new { user = "oper", password = "operpass" })).StatusCode);
    }

    [Fact]
    public async Task Writes_need_the_csrf_header()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = Client(rig, out _);
        c.DefaultRequestHeaders.Remove("X-Requested-With");
        Assert.Equal(HttpStatusCode.BadRequest, (await c.PostAsJsonAsync("/api/login", new { user = "oper", password = "operpass" })).StatusCode);
    }

    [Fact]
    public async Task State_shows_live_plc_data()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = await LoggedIn(rig, "view", "viewpass");
        Assert.True(await Net.WaitFor(() => rig.Engine.Core.State.Fresh));
        var j = JsonDocument.Parse(await c.GetStringAsync("/api/state")).RootElement;
        Assert.Equal("monitor", j.GetProperty("role").GetString());
        Assert.Equal(5, j.GetProperty("inputs").GetInt32());
        Assert.Equal(7, j.GetProperty("count").GetInt32());
        Assert.Equal("Chạy", j.GetProperty("conveyorText").GetString());
        Assert.Equal("online", j.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Viewer_cannot_control_operator_can()
    {
        await using var rig = new Rig();
        rig.Cfg.Control.RemoteScreens = true;
        await rig.StartAsync();
        var v = await LoggedIn(rig, "view", "viewpass");
        Assert.Equal(HttpStatusCode.Forbidden, (await v.PostAsJsonAsync("/api/cmd", new { a = 6, v = 1 })).StatusCode);
        await Task.Delay(400);
        Assert.Equal(0, rig.Plc.Get(6));

        var o = await LoggedIn(rig, "oper", "operpass");
        Assert.Equal(HttpStatusCode.OK, (await o.PostAsJsonAsync("/api/cmd", new { a = 6, v = 1 })).StatusCode);
        Assert.True(await Net.WaitFor(() => rig.Plc.Get(6) == 1));
        Assert.Equal(HttpStatusCode.BadRequest, (await o.PostAsJsonAsync("/api/cmd", new { a = 0, v = 1 })).StatusCode);   // D0 không ghi được
        Assert.Contains(rig.Engine.Core.RecentLog, l => l.Contains("oper") && l.Contains("D6 = 1"));
    }

    [Fact]
    public async Task Logout_invalidates_the_session()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = await LoggedIn(rig, "oper", "operpass");
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/state")).StatusCode);
        await c.PostAsync("/api/logout", null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/state")).StatusCode);
    }

    [Fact]
    public async Task Event_stream_pushes_snapshots()
    {
        await using var rig = new Rig();
        await rig.StartAsync();
        var c = await LoggedIn(rig, "view", "viewpass");
        using var resp = await c.GetAsync("/api/events", HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal("text/event-stream", resp.Content.Headers.ContentType?.MediaType);
        using var sr = new StreamReader(await resp.Content.ReadAsStreamAsync());
        var line = await sr.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.StartsWith("data: {", line);
    }
}
