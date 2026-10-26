using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Plciot.Scada.Tests;

/// <summary>Slave Modbus RTU giả: một luồng TCP loopback đóng vai cổng RS485 (cùng khung RTU + CRC16 như dây thật).</summary>
sealed class FakeRtuSlave : IDisposable
{
    public readonly ushort[] Regs = new ushort[300];
    public byte Unit = 1;
    public bool CorruptCrc;
    readonly TcpListener _l = new(IPAddress.Loopback, 0);
    public int Port => ((IPEndPoint)_l.LocalEndpoint).Port;

    public FakeRtuSlave()
    {
        _l.Start();
        Regs[14] = 42; Regs[15] = 0; Regs[16] = 1000;
        _ = Task.Run(async () => { try { while (true) { var c = await _l.AcceptTcpClientAsync(); _ = Task.Run(() => Serve(c)); } } catch { } });
    }

    async Task Serve(TcpClient c)
    {
        using var _ = c; var ns = c.GetStream();
        try
        {
            while (true)
            {
                var h = new byte[2]; if (!await Fill(ns, h)) return;
                var body = new byte[h[1] == 3 || h[1] == 6 ? 6 : 0]; if (!await Fill(ns, body)) return;
                var addr = BinaryPrimitives.ReadUInt16BigEndian(body);
                var val = BinaryPrimitives.ReadUInt16BigEndian(body.AsSpan(2));
                if (h[0] != Unit) continue;       // không phải trạm này: im lặng như RS485 thật
                byte[] rsp;
                if (h[1] == 3) { rsp = new byte[5 + val * 2]; rsp[2] = (byte)(val * 2); for (var i = 0; i < val; i++) BinaryPrimitives.WriteUInt16BigEndian(rsp.AsSpan(3 + i * 2), Regs[addr + i]); }
                else if (h[1] == 6) { Regs[addr] = val; rsp = new byte[8]; BinaryPrimitives.WriteUInt16BigEndian(rsp.AsSpan(2), addr); BinaryPrimitives.WriteUInt16BigEndian(rsp.AsSpan(4), val); }
                else { rsp = new byte[5]; h[1] |= 0x80; rsp[2] = 1; }
                rsp[0] = h[0]; rsp[1] = h[1];
                BinaryPrimitives.WriteUInt16LittleEndian(rsp.AsSpan(rsp.Length - 2), (ushort)(ModbusRtuClient.Crc16(rsp.AsSpan(0, rsp.Length - 2)) ^ (CorruptCrc ? 1 : 0)));
                await ns.WriteAsync(rsp);
            }
        }
        catch { }
    }

    static async Task<bool> Fill(NetworkStream ns, byte[] b) { var g = 0; while (g < b.Length) { var n = await ns.ReadAsync(b.AsMemory(g)); if (n == 0) return false; g += n; } return true; }
    public void Dispose() => _l.Stop();
}

public class ModbusRtuTests
{
    static ModbusRtuClient Client(FakeRtuSlave s, int unit = 1, int timeout = 500) => new(() => new TcpClient("127.0.0.1", s.Port).GetStream(), unit, timeout);

    [Fact]
    public void Crc16_matches_modbus_reference_vector()
    {
        // ví dụ chuẩn: 01 03 00 00 00 0A -> CRC C5 CD (gửi thấp trước)
        Assert.Equal(0xCDC5, ModbusRtuClient.Crc16(new byte[] { 0x01, 0x03, 0x00, 0x00, 0x00, 0x0A }));
    }

    [Fact]
    public async Task Reads_counter_registers_and_writes_one()
    {
        using var s = new FakeRtuSlave(); using var c = Client(s);
        var r = await c.ReadAsync(14, 3);
        Assert.Equal(new ushort[] { 42, 0, 1000 }, r);
        await c.WriteAsync(7, 100);
        Assert.Equal(100, s.Regs[7]);
    }

    [Fact]
    public async Task Bad_crc_is_rejected_and_link_recovers()
    {
        using var s = new FakeRtuSlave(); using var c = Client(s);
        s.CorruptCrc = true;
        await Assert.ThrowsAsync<ModbusException>(() => c.ReadAsync(0, 2));
        s.CorruptCrc = false;
        Assert.Equal(42, (await c.ReadAsync(14, 1))[0]);
    }

    [Fact]
    public async Task Wrong_unit_times_out()
    {
        using var s = new FakeRtuSlave { Unit = 5 }; using var c = Client(s, unit: 1);
        await Assert.ThrowsAsync<TimeoutException>(() => c.ReadAsync(0, 1));
    }

    [Fact]
    public void Config_validates_parity_and_factory_builds_rtu_driver()
    {
        var cfg = new ScadaConfig { Source = PlcSource.ModbusRtu, PlcHost = "COM3", PlcPort = 19200, SerialParity = "Even" };
        Assert.Null(cfg.Validate());
        using var d = DriverFactory.Create(cfg) as IDisposable;
        Assert.IsType<ModbusRtuClient>(d);
        cfg.SerialParity = "xyz";
        Assert.NotNull(cfg.Validate());
    }
}
