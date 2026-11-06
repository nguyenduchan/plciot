using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>Modbus TCP slave: FC03/FC04 đọc, FC06/FC16 ghi. Địa chỉ holding register = số thanh ghi D (D0 → 0).</summary>
public sealed class ModbusTcpSlave : IEndpoint
{
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    int _peers;

    public string Name => "Modbus TCP";
    public int Peers => _peers;

    public ModbusTcpSlave(PlcModel m, string bind, int port, Action<string> log)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _log = log;
    }

    public Task StartAsync()
    {
        _l = new TcpListener(_bind, _port);
        _l.Start();
        _log($"Modbus TCP slave nghe {_bind}:{_port}");
        _ = Task.Run(AcceptLoop);
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("Modbus: dữ liệu đã cập nhật vào ảnh thanh ghi, chờ gateway poll"); return Task.CompletedTask; }

    async Task AcceptLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var c = await _l!.AcceptTcpClientAsync(_cts.Token);
                _ = Task.Run(() => Serve(c));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _log($"Modbus accept: {ex.Message}"); }
    }

    async Task Serve(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        _log($"Modbus: gateway {who} kết nối");
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var hdr = new byte[7];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, hdr, _cts.Token)) return;
                var len = BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(4));
                if (len < 2 || len > 254) return;
                var pdu = new byte[len - 1];
                if (!await Io.ReadExact(ns, pdu, _cts.Token)) return;
                var rsp = Handle(pdu);
                var outp = new byte[7 + rsp.Length];
                hdr.AsSpan(0, 4).CopyTo(outp);
                BinaryPrimitives.WriteUInt16BigEndian(outp.AsSpan(4), (ushort)(rsp.Length + 1));
                outp[6] = hdr[6];
                rsp.CopyTo(outp, 7);
                await ns.WriteAsync(outp, _cts.Token);
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally
        {
            Interlocked.Decrement(ref _peers);
            _log($"Modbus: gateway {who} ngắt");
        }
    }

    public byte[] Handle(byte[] pdu)
    {
        var fc = pdu[0];
        byte[] Exc(byte code) => new[] { (byte)(fc | 0x80), code };
        if (pdu.Length < 5) return Exc(3);
        var addr = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(1));
        var arg = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(3));
        switch (fc)
        {
            case 3:
            case 4:
            {
                if (arg < 1 || arg > 125) return Exc(3);
                if (!_m.InRange(addr, arg)) return Exc(2);
                var v = _m.Read(addr, arg);
                var r = new byte[2 + arg * 2];
                r[0] = fc; r[1] = (byte)(arg * 2);
                for (var i = 0; i < arg; i++) BinaryPrimitives.WriteUInt16BigEndian(r.AsSpan(2 + i * 2), v[i]);
                return r;
            }
            case 6:
                if (!_m.InRange(addr, 1)) return Exc(2);
                _log($"Modbus nhận lệnh FC06: D{addr} = {arg}");
                _m.Set(addr, arg, "gateway");
                return pdu[..5];
            case 16:
            {
                if (pdu.Length < 6 || arg < 1 || arg > 123 || pdu[5] != arg * 2 || pdu.Length < 6 + arg * 2) return Exc(3);
                if (!_m.InRange(addr, arg)) return Exc(2);
                for (var i = 0; i < arg; i++)
                {
                    var v = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(6 + i * 2));
                    _log($"Modbus nhận lệnh FC16: D{addr + i} = {v}");
                    _m.Set(addr + i, v, "gateway");
                }
                return pdu[..5];
            }
            default: return Exc(1);
        }
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        return ValueTask.CompletedTask;
    }
}
