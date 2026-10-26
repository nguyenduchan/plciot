using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Plciot.Scada.Tests;

/// <summary>PLC Mitsubishi giả (MC 3E nhị phân) theo đặc tả SLMP; đủ để kiểm tra khung yêu cầu/đáp của driver.</summary>
sealed class FakeMcPlc : IDisposable
{
    public readonly ushort[] D = new ushort[2000];
    public readonly bool Iqr;
    public readonly TcpListener L = new(IPAddress.Loopback, 0);
    public int Port => ((IPEndPoint)L.LocalEndpoint).Port;
    public readonly List<string> Errors = new();
    readonly CancellationTokenSource _cts = new();

    public FakeMcPlc(bool iqr) { Iqr = iqr; L.Start(); for (var i = 0; i < 300; i++) D[i] = (ushort)(i * 3); _ = Task.Run(Accept); }

    async Task Accept()
    {
        try { while (true) { var c = await L.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => Serve(c)); } } catch { }
    }

    async Task Serve(TcpClient c)
    {
        using var _ = c; var ns = c.GetStream();
        try
        {
            while (true)
            {
                var h = new byte[9]; if (!await Fill(ns, h)) return;
                if (h[0] != 0x50 || h[1] != 0x00 || h[2] != 0x00 || h[3] != 0xFF || h[4] != 0xFF || h[5] != 0x03 || h[6] != 0x00) Errors.Add("bad request header");
                var len = BinaryPrimitives.ReadUInt16LittleEndian(h.AsSpan(7));
                var b = new byte[len]; if (!await Fill(ns, b)) return;
                var cmd = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(2));
                var sub = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(4));
                int dev, off;
                if (Iqr) { if (sub != 2) Errors.Add("iqr subcommand"); dev = (int)BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(6)); if (BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(10)) != 0xA8) Errors.Add("iqr device code"); off = 12; }
                else { if (sub != 0) Errors.Add("q subcommand"); dev = b[6] | (b[7] << 8) | (b[8] << 16); if (b[9] != 0xA8) Errors.Add("q device code"); off = 10; }
                var pts = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(off));
                byte[] data = Array.Empty<byte>(); ushort end = 0;
                if (cmd == 0x0401) { data = new byte[pts * 2]; for (var i = 0; i < pts; i++) BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(i * 2), D[dev + i]); }
                else if (cmd == 0x1401) { for (var i = 0; i < pts; i++) D[dev + i] = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(off + 2 + i * 2)); }
                else end = 0xC059;
                var rsp = new byte[11 + data.Length];
                rsp[0] = 0xD0; rsp[1] = 0; rsp[2] = 0; rsp[3] = 0xFF; rsp[4] = 0xFF; rsp[5] = 3; rsp[6] = 0;
                BinaryPrimitives.WriteUInt16LittleEndian(rsp.AsSpan(7), (ushort)(2 + data.Length));
                BinaryPrimitives.WriteUInt16LittleEndian(rsp.AsSpan(9), end);
                data.CopyTo(rsp, 11);
                await ns.WriteAsync(rsp);
            }
        }
        catch { }
    }

    static async Task<bool> Fill(NetworkStream ns, byte[] buf) { var g = 0; while (g < buf.Length) { var n = await ns.ReadAsync(buf.AsMemory(g)); if (n == 0) return false; g += n; } return true; }
    public void Dispose() { _cts.Cancel(); L.Stop(); }
}

/// <summary>PLC Omron giả (FINS/UDP và FINS/TCP), vùng DM.</summary>
sealed class FakeFinsPlc : IDisposable
{
    public readonly ushort[] DM = new ushort[1000];
    public readonly bool Tcp;
    public readonly byte ServerNode = 10, ClientNode = 5;
    public readonly List<string> Errors = new();
    readonly UdpClient? _udp; readonly TcpListener? _tcp;
    readonly CancellationTokenSource _cts = new();
    public int Port { get; }

    public FakeFinsPlc(bool tcp)
    {
        Tcp = tcp;
        for (var i = 0; i < 300; i++) DM[i] = (ushort)(i * 5);
        if (tcp) { _tcp = new TcpListener(IPAddress.Loopback, 0); _tcp.Start(); Port = ((IPEndPoint)_tcp.LocalEndpoint).Port; _ = Task.Run(AcceptTcp); }
        else { _udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0)); Port = ((IPEndPoint)_udp.Client.LocalEndPoint!).Port; _ = Task.Run(UdpLoop); }
    }

    byte[] Process(byte[] f)
    {
        // header 10 bytes: ICF RSV GCT DNA DA1 DA2 SNA SA1 SA2 SID
        if (f[0] != 0x80 || f[2] != 0x02) Errors.Add("bad icf/gct");
        if (Tcp && (f[4] != ServerNode || f[7] != ClientNode)) Errors.Add($"bad nodes da1={f[4]} sa1={f[7]}");
        var mrc = f[10]; var src = f[11];
        if (f[12] != 0x82) Errors.Add("area is not DM");
        var addr = (f[13] << 8) | f[14]; var cnt = (f[16] << 8) | f[17];
        var rsp = new List<byte> { 0xC0, 0x00, 0x02, f[6], f[7], f[8], f[3], f[4], f[5], f[9], mrc, src, 0, 0 };
        if (mrc == 1 && src == 1) for (var i = 0; i < cnt; i++) { rsp.Add((byte)(DM[addr + i] >> 8)); rsp.Add((byte)DM[addr + i]); }
        else if (mrc == 1 && src == 2) for (var i = 0; i < cnt; i++) DM[addr + i] = (ushort)((f[18 + i * 2] << 8) | f[19 + i * 2]);
        else { rsp[12] = 0x04; }
        return rsp.ToArray();
    }

    async Task UdpLoop()
    {
        try { while (true) { var r = await _udp!.ReceiveAsync(_cts.Token); await _udp.SendAsync(Process(r.Buffer), r.RemoteEndPoint, _cts.Token); } } catch { }
    }

    async Task AcceptTcp()
    {
        try { while (true) { var c = await _tcp!.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => ServeTcp(c)); } } catch { }
    }

    async Task ServeTcp(TcpClient c)
    {
        using var _ = c; var ns = c.GetStream();
        try
        {
            var hs = new byte[20]; if (!await Fill(ns, hs)) return;
            var resp = new byte[24];
            "FINS"u8.CopyTo(resp); BinaryPrimitives.WriteUInt32BigEndian(resp.AsSpan(4), 16); BinaryPrimitives.WriteUInt32BigEndian(resp.AsSpan(8), 1);
            resp[19] = ClientNode; resp[23] = ServerNode;
            await ns.WriteAsync(resp);
            while (true)
            {
                var h = new byte[8]; if (!await Fill(ns, h)) return;
                var len = (int)BinaryPrimitives.ReadUInt32BigEndian(h.AsSpan(4));
                var rest = new byte[len]; if (!await Fill(ns, rest)) return;
                var frame = rest[8..];
                var rsp = Process(frame);
                var outp = new byte[16 + rsp.Length];
                "FINS"u8.CopyTo(outp); BinaryPrimitives.WriteUInt32BigEndian(outp.AsSpan(4), (uint)(8 + rsp.Length)); BinaryPrimitives.WriteUInt32BigEndian(outp.AsSpan(8), 2);
                rsp.CopyTo(outp, 16);
                await ns.WriteAsync(outp);
            }
        }
        catch { }
    }

    static async Task<bool> Fill(NetworkStream ns, byte[] buf) { var g = 0; while (g < buf.Length) { var n = await ns.ReadAsync(buf.AsMemory(g)); if (n == 0) return false; g += n; } return true; }
    public void Dispose() { _cts.Cancel(); _udp?.Dispose(); _tcp?.Stop(); }
}

public class MitsubishiMcTests
{
    [Theory]
    [InlineData("Q")]
    [InlineData("iQ-R")]
    public async Task Reads_and_writes_D_registers(string type)
    {
        using var plc = new FakeMcPlc(type.StartsWith("iQ"));
        using var d = new MitsubishiMcDriver("127.0.0.1", plc.Port, type);
        var r = await d.ReadAsync(0, 40);
        Assert.Equal(40, r.Length);
        Assert.Equal(9, r[3]);
        var big = await d.ReadAsync(100, 250);                  // > 120 từ: tự chia khối
        Assert.Equal(250, big.Length);
        Assert.Equal((ushort)(299 * 3), big[199]);   // D299; vượt chunk 120 từ nên đã được ghép lại
        await d.WriteAsync(6, 1);
        Assert.Equal(1, plc.D[6]);
        Assert.Empty(plc.Errors);
    }

    [Fact]
    public async Task End_code_error_is_reported()
    {
        using var plc = new FakeMcPlc(false);
        using var d = new MitsubishiMcDriver("127.0.0.1", plc.Port, "Q");
        await Assert.ThrowsAnyAsync<IOException>(() => d.ReadAsync(0, 3000));   // vượt vùng giả lập → ngoại lệ, không treo
    }
}

public class OmronFinsTests
{
    [Theory]
    [InlineData("udp")]
    [InlineData("tcp")]
    public async Task Reads_and_writes_DM(string proto)
    {
        using var plc = new FakeFinsPlc(proto == "tcp");
        using var d = new OmronFinsDriver("127.0.0.1", plc.Port, proto, 10, 5);
        var r = await d.ReadAsync(0, 40);
        Assert.Equal(40, r.Length);
        Assert.Equal(15, r[3]);
        var big = await d.ReadAsync(0, 250);
        Assert.Equal((ushort)(249 * 5), big[249]);
        await d.WriteAsync(7, 33);
        Assert.Equal(33, plc.DM[7]);
        Assert.Empty(plc.Errors);
    }
}

public class OtherDriverTests
{
    [Fact]
    public async Task S7_unreachable_fails_fast()
    {
        using var d = new S7Driver("127.0.0.1", Net.FreePort(), "S71500", 0, 1, 1);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        await Assert.ThrowsAnyAsync<Exception>(() => d.ReadAsync(0, 40, cts.Token));
    }

    [Fact]
    public void S7_rejects_unknown_cpu() => Assert.Throws<ArgumentException>(() => new S7Driver("127.0.0.1", 0, "S7-9999", 0, 1, 1));

    [Fact]
    public async Task EtherNetIp_unreachable_fails_fast()
    {
        using var d = new EtherNetIpDriver("127.0.0.1", 0, "PLC_D");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await Assert.ThrowsAnyAsync<Exception>(() => d.ReadAsync(0, 40, cts.Token));
    }

    [Fact]
    public async Task Ads_without_router_fails_fast()
    {
        using var d = new BeckhoffAdsDriver("127.0.0.1.1.1", 851, "GVL_PLC.D");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await Assert.ThrowsAnyAsync<Exception>(() => d.ReadAsync(0, 40, cts.Token));
    }

    [Fact]
    public void Factory_builds_a_driver_for_every_source_except_gateway()
    {
        foreach (var src in Enum.GetValues<PlcSource>())
        {
            var cfg = new ScadaConfig { Source = src, PlcHost = "127.0.0.1" };
            using var d = DriverFactory.Create(cfg) as IDisposable;
            if (src == PlcSource.Gateway) Assert.Null(d); else Assert.NotNull(d);
        }
    }
}
