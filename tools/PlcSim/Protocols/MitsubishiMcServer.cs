using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>
/// Mitsubishi MC (SLMP) khung 3E nhị phân qua TCP, thiết bị D (0xA8). Hiểu cả Q/L/QnA (lệnh con 0000, 3 byte địa chỉ)
/// lẫn iQ-R/iQ-L (lệnh con 0002, 4 byte địa chỉ). Lệnh 0401 = đọc word, 1401 = ghi word.
/// </summary>
public sealed class MitsubishiMcServer : IEndpoint
{
    const byte DeviceD = 0xA8;
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    int _peers;

    public string Name => "Mitsubishi MC 3E";
    public int Peers => _peers;

    public MitsubishiMcServer(PlcModel m, string bind, int port, Action<string> log)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _log = log;
    }

    public Task StartAsync()
    {
        _l = new TcpListener(_bind, _port);
        _l.Start();
        _log($"MC 3E server nghe {_bind}:{_port}");
        _ = Task.Run(async () =>
        {
            try { while (!_cts.IsCancellationRequested) { var c = await _l.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => Serve(c)); } }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _log($"MC accept: {ex.Message}"); }
        });
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("MC: dữ liệu đã cập nhật vào thanh ghi D, chờ gateway poll"); return Task.CompletedTask; }

    async Task Serve(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        _log($"MC: gateway {who} kết nối");
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var hdr = new byte[9];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, hdr, _cts.Token)) return;
                if (hdr[0] != 0x50 || hdr[1] != 0x00) return;
                var len = BinaryPrimitives.ReadUInt16LittleEndian(hdr.AsSpan(7));
                if (len < 6 || len > 4096) return;
                var body = new byte[len];
                if (!await Io.ReadExact(ns, body, _cts.Token)) return;
                var data = Handle(body, out var end);
                var rsp = new byte[11 + data.Length];
                rsp[0] = 0xD0; rsp[1] = 0x00;
                hdr.AsSpan(2, 5).CopyTo(rsp.AsSpan(2));                       // network, PC, module IO, station
                BinaryPrimitives.WriteUInt16LittleEndian(rsp.AsSpan(7), (ushort)(2 + data.Length));
                BinaryPrimitives.WriteUInt16LittleEndian(rsp.AsSpan(9), end);
                data.CopyTo(rsp, 11);
                await ns.WriteAsync(rsp, _cts.Token);
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { Interlocked.Decrement(ref _peers); _log($"MC: gateway {who} ngắt"); }
    }

    /// <summary>body = monitoring timer(2) + command(2) + subcommand(2) + thiết bị + số điểm [+ dữ liệu]. Trả dữ liệu và end code.</summary>
    public byte[] Handle(byte[] body, out ushort endCode)
    {
        endCode = 0;
        var cmd = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(2));
        var sub = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(4));
        var iqr = sub == 0x0002;
        var devLen = iqr ? 6 : 4;
        if (body.Length < 6 + devLen + 2) { endCode = 0xC061; return Array.Empty<byte>(); }
        var addr = iqr ? (int)BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(6)) : body[6] | body[7] << 8 | body[8] << 16;
        var code = iqr ? BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(10)) : body[9];
        var pts = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(6 + devLen));
        if (code != DeviceD) { endCode = 0xC051; return Array.Empty<byte>(); }
        if (pts < 1 || !_m.InRange(addr, pts)) { endCode = 0xC056; return Array.Empty<byte>(); }

        if (cmd == 0x0401)
        {
            var v = _m.Read(addr, pts);
            var r = new byte[pts * 2];
            for (var i = 0; i < pts; i++) BinaryPrimitives.WriteUInt16LittleEndian(r.AsSpan(i * 2), v[i]);
            return r;
        }
        if (cmd == 0x1401)
        {
            var off = 6 + devLen + 2;
            if (body.Length < off + pts * 2) { endCode = 0xC061; return Array.Empty<byte>(); }
            for (var i = 0; i < pts; i++)
            {
                var v = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(off + i * 2));
                _log($"MC nhận lệnh ghi: D{addr + i} = {v}");
                _m.Set(addr + i, v, "gateway");
            }
            return Array.Empty<byte>();
        }
        endCode = 0xC059;
        return Array.Empty<byte>();
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        return ValueTask.CompletedTask;
    }
}
