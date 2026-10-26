using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Plciot.Scada;

/// <summary>
/// Modbus TCP slave CHỈ ĐỌC cho HMI/MES khác: FC03/FC04 trả ảnh thanh ghi D0–D299; mọi lệnh ghi bị từ chối
/// (illegal function). PLC mất liên lạc → exception 4 thay vì dữ liệu cũ. Cùng hành vi với luồng Node-RED.
/// </summary>
public sealed class ModbusTcpServer : IAsyncDisposable
{
    const int MaxClients = 20;

    readonly IPAddress _bind;
    readonly int _requestedPort;
    readonly Func<(ushort[] Image, bool Fresh)> _source;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _listener;
    int _clients;

    public int Port { get; private set; }
    public event Action<string>? Log;

    public ModbusTcpServer(string bind, int port, Func<(ushort[] Image, bool Fresh)> source)
    {
        _bind = IPAddress.Parse(bind);
        _requestedPort = port;
        _source = source;
    }

    public void Start()
    {
        _listener = new TcpListener(_bind, _requestedPort);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _ = Task.Run(AcceptLoop);
    }

    async Task AcceptLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var c = await _listener!.AcceptTcpClientAsync(_cts.Token);
                if (Interlocked.Increment(ref _clients) > MaxClients) { Interlocked.Decrement(ref _clients); c.Dispose(); continue; }
                _ = Task.Run(() => Serve(c));
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { Log?.Invoke($"Modbus server: {ex.Message}"); }
    }

    async Task Serve(TcpClient c)
    {
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var hdr = new byte[7];
            while (!_cts.IsCancellationRequested)
            {
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
                idle.CancelAfter(TimeSpan.FromSeconds(60));              // kết nối im lặng quá 60 s thì cắt
                if (!await ReadExact(ns, hdr, idle.Token)) return;
                var len = BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(4));
                if (BinaryPrimitives.ReadUInt16BigEndian(hdr.AsSpan(2)) != 0 || len < 2 || len > 254) return;   // không phải Modbus TCP
                var pdu = new byte[len - 1];
                if (!await ReadExact(ns, pdu, idle.Token)) return;
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
        finally { Interlocked.Decrement(ref _clients); }
    }

    /// <summary>Xử lý một PDU; công khai để kiểm thử.</summary>
    public byte[] Handle(byte[] pdu)
    {
        var fc = pdu[0];
        byte[] Exc(byte code) => new[] { (byte)(fc | 0x80), code };
        if ((fc == 3 || fc == 4) && pdu.Length == 5)
        {
            var addr = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(1));
            var qty = BinaryPrimitives.ReadUInt16BigEndian(pdu.AsSpan(3));
            if (qty < 1 || qty > 125) return Exc(3);
            if (addr + qty > Contract.MaxRegister) return Exc(2);
            var (image, fresh) = _source();
            if (!fresh) return Exc(4);
            var r = new byte[2 + qty * 2];
            r[0] = fc; r[1] = (byte)(qty * 2);
            for (var i = 0; i < qty; i++) BinaryPrimitives.WriteUInt16BigEndian(r.AsSpan(2 + i * 2), image[addr + i]);
            return r;
        }
        return Exc(1);                                                   // chỉ giám sát: ghi bị từ chối
    }

    static async Task<bool> ReadExact(NetworkStream ns, byte[] buf, CancellationToken ct)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var n = await ns.ReadAsync(buf.AsMemory(got), ct);
            if (n == 0) return false;
            got += n;
        }
        return true;
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _listener?.Stop();
        return ValueTask.CompletedTask;
    }
}
