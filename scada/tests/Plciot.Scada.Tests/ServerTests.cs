using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace Plciot.Scada.Tests;

public class ModbusServerTests
{
    static ScadaConfig Cfg(FakeModbusPlc plc) => new()
    {
        Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150, HistoryMs = 300,
        WebEnabled = false, Mobile = MobileAccess.Off, ServerBind = "127.0.0.1", ModbusServerEnabled = true, ModbusServerPort = Net.FreePort(),
    };

    [Fact]
    public async Task Another_hmi_can_read_the_image_but_not_write()
    {
        using var plc = new FakeModbusPlc();
        lock (plc.Regs) { plc.Regs[100] = 77; plc.Regs[199] = 33; }
        var cfg = Cfg(plc);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Core.State.Fresh && host.Core.State.History != null));

        using var c = new ModbusTcpClient("127.0.0.1", cfg.ModbusServerPort, 1);       // client Modbus của chính dự án đọc server của dự án
        var r = await c.ReadAsync(0, 40);
        Assert.Equal(5, r[0]);
        Assert.Equal(7, r[14]);
        var h = await c.ReadAsync(100, 1);
        Assert.Equal(77, h[0]);                                                          // vùng lịch sử D100…
        Assert.Equal(33, (await c.ReadAsync(199, 1))[0]);
        await Assert.ThrowsAsync<ModbusException>(() => c.WriteAsync(6, 1));            // ghi: illegal function
        await Task.Delay(300);
        Assert.Equal(0, plc.Get(6));
        using var c2 = new ModbusTcpClient("127.0.0.1", cfg.ModbusServerPort, 1);
        await Assert.ThrowsAsync<ModbusException>(() => c2.ReadAsync(290, 20));          // vượt 300 → illegal address
    }

    [Fact]
    public async Task Garbage_and_oversized_requests_drop_the_connection()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc);
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        using var t = new TcpClient();
        await t.ConnectAsync("127.0.0.1", cfg.ModbusServerPort);
        var ns = t.GetStream();
        await ns.WriteAsync(Encoding.ASCII.GetBytes("GET / HTTP/1.1\r\n\r\n"));
        var buf = new byte[16];
        using var cts = new CancellationTokenSource(3000);
        int n;
        try { n = await ns.ReadAsync(buf, cts.Token); } catch (IOException) { n = 0; }    // đóng êm (0 byte) hoặc RST đều là "đã cắt"
        Assert.Equal(0, n);
    }

    [Fact]
    public async Task Stale_plc_returns_exception_instead_of_old_data()
    {
        using var plc = new FakeModbusPlc();
        var cfg = Cfg(plc);
        var server = new ModbusTcpServer("127.0.0.1", 0, () => (new ushort[300], false));
        server.Start();
        using var c = new ModbusTcpClient("127.0.0.1", server.Port, 1);
        var ex = await Assert.ThrowsAsync<ModbusException>(() => c.ReadAsync(0, 1));
        Assert.Contains("exception_4", ex.Message);
        await server.DisposeAsync();
    }
}

public class OpcUaTests
{
    [Fact]
    public async Task Opc_ua_server_exposes_the_image_and_our_own_client_reads_it()
    {
        using var plc = new FakeModbusPlc();
        var port = Net.FreePort();
        var cfg = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Source = PlcSource.ModbusTcp, PlcHost = "127.0.0.1", PlcPort = plc.Port, PollMs = 150, HistoryMs = 300,
            WebEnabled = false, Mobile = MobileAccess.Off, ServerBind = "127.0.0.1", OpcUaServerEnabled = true, OpcUaServerPort = port,
        };
        await using var host = new ScadaHost(cfg);
        await host.StartAsync();
        Assert.True(await Net.WaitFor(() => host.Core.State.Fresh));
        Assert.Contains($":{port}/plciot", host.OpcUaServerEndpoint);

        // Host thứ hai KHÔNG nối PLC mà nối OPC UA của host thứ nhất: đủ cả client lẫn server
        var cfg2 = new ScadaConfig
        {
            Site = "f1", Device = "plc01", Source = PlcSource.OpcUa, OpcUaEndpoint = $"opc.tcp://127.0.0.1:{port}/plciot", OpcUaImageNode = "ns=2;s=PLC_D",
            PollMs = 200, HistoryMs = 500, WebEnabled = false, Mobile = MobileAccess.Off,
        };
        await using var core2 = new ScadaCore(cfg2, DriverFactory.Create(cfg2));
        await core2.StartAsync();
        Assert.True(await Net.WaitFor(() => core2.State.Fresh && core2.State.Status == "online", 30000), "client OPC UA đọc được ảnh thanh ghi");
        Assert.Equal(5, core2.State.Inputs);
        Assert.Equal(7, core2.State.Count);
        lock (plc.Regs) plc.Regs[14] = 1234;
        Assert.True(await Net.WaitFor(() => core2.State.Count == 1234, 8000), "giá trị đổi ở PLC tới được client OPC UA");

        // server chỉ đọc: ghi qua OPC UA bị từ chối, PLC không đổi
        Assert.NotNull(await core2.WriteAsync(6, 1));
        await Task.Delay(400);
        Assert.Equal(0, plc.Get(6));
    }
}

public class InfluxTests
{
    static ScadaConfig Cfg() => new() { Site = "f1", Device = "plc01", InfluxUrl = "http://x", InfluxToken = "t", Mobile = MobileAccess.Off, WebEnabled = false };

    static DeviceState.Snapshot Snap(bool fresh)
    {
        var r = new ushort[40]; r[0] = 5; r[1] = 2; r[2] = 1; r[3] = 1; r[6] = 1; r[7] = 20; r[8] = 1; r[14] = 7; r[16] = 70; r[10] = 3600;
        return new DeviceState.Snapshot(r, "online", fresh ? DateTime.UtcNow : DateTime.UtcNow.AddMinutes(-5), null, null);
    }

    [Fact]
    public void Line_protocol_matches_the_node_red_schema_and_uses_floats()
    {
        var w = new InfluxWriter(Cfg(), () => Snap(true));
        var lines = w.BuildLines(Snap(true), DateTimeOffset.FromUnixTimeMilliseconds(1700000000000)).TrimEnd().Split('\n');
        Assert.Equal(2, lines.Length);
        Assert.Equal("plc_status,site=f1,device=plc01 online=1 1700000000000", lines[0]);
        Assert.StartsWith("plc,site=f1,device=plc01 inputs=5,", lines[1]);
        Assert.DoesNotMatch(new Regex(@"=\d+i[, ]"), lines[1]);                          // float, không có hậu tố i (Node-RED ghi float)
        Assert.Contains("count=7,", lines[1]); Assert.Contains("total=70,", lines[1]); Assert.Contains("run_s=3600,", lines[1]);
        Assert.Contains("x0=1,", lines[1]); Assert.Contains("x1=0,", lines[1]); Assert.Contains("y1=1,", lines[1]); Assert.Contains("estop=1,", lines[1]);
    }

    [Fact]
    public void Offline_plc_writes_only_the_status_point()
    {
        var w = new InfluxWriter(Cfg(), () => Snap(false));
        var lines = w.BuildLines(Snap(false), DateTimeOffset.UtcNow).TrimEnd().Split('\n');
        Assert.Single(lines);
        Assert.StartsWith("plc_status,site=f1,device=plc01 online=0 ", lines[0]);
    }

    [Fact]
    public void Field_names_are_identical_to_the_node_red_flow_generator()
    {
        var dir = AppContext.BaseDirectory;
        string? py = null;
        for (var d = new DirectoryInfo(dir); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "tools", "gen_flows.py");
            if (File.Exists(p)) { py = p; break; }
        }
        Assert.NotNull(py);
        var src = File.ReadAllText(py!);
        var nodeRed = Regex.Matches(src[src.IndexOf("const f = {inputs:", StringComparison.Ordinal)..][..500], @"\b([a-z_]+):\s*R\[").Select(m => m.Groups[1].Value)
            .Concat(new[] { "x0", "y0" }).ToHashSet();
        var w = new InfluxWriter(Cfg(), () => Snap(true));
        var csharp = Regex.Matches(w.BuildLines(Snap(true), DateTimeOffset.UtcNow).Split('\n')[1], @"([a-z_0-9]+)=").Select(m => m.Groups[1].Value).ToHashSet();
        foreach (var f in nodeRed.Where(f => f is not ("x0" or "y0"))) Assert.Contains(f, csharp);        // mọi trường Node-RED ghi, C# cũng ghi
        for (var b = 0; b < 8; b++) { Assert.Contains($"x{b}", csharp); Assert.Contains($"y{b}", csharp); }
    }

    sealed class CaptureHandler : HttpMessageHandler
    {
        public readonly List<(string Url, string Auth, string Body)> Calls = new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken ct)
        {
            Calls.Add((r.RequestUri!.ToString(), r.Headers.Authorization?.ToString() ?? "", await r.Content!.ReadAsStringAsync(ct)));
            return new HttpResponseMessage(HttpStatusCode.NoContent);
        }
    }

    [Fact]
    public async Task Posts_to_the_v2_write_endpoint_with_the_token()
    {
        var h = new CaptureHandler();
        var cfg = Cfg(); cfg.InfluxUrl = "http://influx:8086/"; cfg.InfluxOrg = "plciot"; cfg.InfluxBucket = "plc"; cfg.InfluxToken = "tok123"; cfg.InfluxEverySec = 1;
        await using var w = new InfluxWriter(cfg, () => Snap(true), h);
        w.Start();
        Assert.True(await Net.WaitFor(() => h.Calls.Count > 0, 4000));
        var c = h.Calls[0];
        Assert.Equal("http://influx:8086/api/v2/write?org=plciot&bucket=plc&precision=ms", c.Url);
        Assert.Equal("Token tok123", c.Auth);
        Assert.Contains("plc_status,site=f1,device=plc01 online=1", c.Body);
    }
}
