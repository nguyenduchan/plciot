using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>Omron FINS (UDP hoặc TCP), vùng DM (0x82): MRC/SRC 0101 đọc, 0102 ghi. Thanh ghi D n = DM n.</summary>
public sealed class OmronFinsServer : IEndpoint
{
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly bool _tcp;
    readonly byte _node;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    UdpClient? _udp;
    int _peers;

    public string Name => _tcp ? "Omron FINS/TCP" : "Omron FINS/UDP";
    public int Peers => _peers;

    public OmronFinsServer(PlcModel m, string bind, int port, bool tcp, Action<string> log, byte node = 1)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _tcp = tcp; _log = log; _node = node;
    }

    public Task StartAsync()
    {
        if (_tcp)
        {
            _l = new TcpListener(_bind, _port);
            _l.Start();
            _ = Task.Run(async () =>
            {
                try { while (!_cts.IsCancellationRequested) { var c = await _l.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => ServeTcp(c)); } }
                catch (OperationCanceledException) { }
                catch (Exception ex) { _log($"FINS accept: {ex.Message}"); }
            });
        }
        else
        {
            _udp = new UdpClient(new IPEndPoint(_bind, _port));
            _ = Task.Run(UdpLoop);
        }
        _log($"{Name} server nghe {_bind}:{_port}");
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("FINS: dữ liệu đã cập nhật vào DM, chờ gateway poll"); return Task.CompletedTask; }

    async Task UdpLoop()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                var r = await _udp!.ReceiveAsync(_cts.Token);
                var rsp = Handle(r.Buffer);
                if (rsp != null) await _udp.SendAsync(rsp, r.RemoteEndPoint, _cts.Token);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _log($"FINS UDP: {ex.Message}"); }
    }

    async Task ServeTcp(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        _log($"FINS: gateway {who} kết nối");
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var h = new byte[8];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, h, _cts.Token)) return;
                if (h[0] != 0x46 || h[1] != 0x49 || h[2] != 0x4E || h[3] != 0x53) return;
                var len = (int)BinaryPrimitives.ReadUInt32BigEndian(h.AsSpan(4));
                if (len < 8 || len > 4096) return;
                var rest = new byte[len];
                if (!await Io.ReadExact(ns, rest, _cts.Token)) return;
                var cmd = BinaryPrimitives.ReadUInt32BigEndian(rest.AsSpan(0));
                if (cmd == 0)           // xin cấp phát node: trả node của client (=2 hoặc theo yêu cầu) và node của PLC
                {
                    var clientNode = rest.Length >= 12 && rest[11] != 0 ? rest[11] : (byte)2;
                    var rsp = new byte[24];
                    "FINS"u8.CopyTo(rsp);
                    BinaryPrimitives.WriteUInt32BigEndian(rsp.AsSpan(4), 16);
                    BinaryPrimitives.WriteUInt32BigEndian(rsp.AsSpan(8), 1);
                    rsp[19] = clientNode; rsp[23] = _node;
                    await ns.WriteAsync(rsp, _cts.Token);
                }
                else if (cmd == 2)      // khung FINS
                {
                    var frame = Handle(rest[8..]);
                    if (frame == null) continue;
                    var rsp = new byte[16 + frame.Length];
                    "FINS"u8.CopyTo(rsp);
                    BinaryPrimitives.WriteUInt32BigEndian(rsp.AsSpan(4), (uint)(8 + frame.Length));
                    BinaryPrimitives.WriteUInt32BigEndian(rsp.AsSpan(8), 2);
                    frame.CopyTo(rsp, 16);
                    await ns.WriteAsync(rsp, _cts.Token);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { Interlocked.Decrement(ref _peers); _log($"FINS: gateway {who} ngắt"); }
    }

    /// <summary>Khung FINS: header 10 + MRC SRC + tham số. Trả khung phản hồi (header đảo địa chỉ + MRC SRC + end code + dữ liệu).</summary>
    public byte[]? Handle(byte[] f)
    {
        if (f.Length < 12) return null;
        byte mrc = f[10], src = f[11];
        ushort end = 0;
        var data = Array.Empty<byte>();
        if (mrc == 0x01 && f.Length >= 18 && f[12] == 0x82)
        {
            var addr = f[13] << 8 | f[14];
            var n = f[16] << 8 | f[17];
            if (n < 1 || !_m.InRange(addr, n)) end = 0x1103;
            else if (src == 0x01)
            {
                var v = _m.Read(addr, n);
                data = new byte[n * 2];
                for (var i = 0; i < n; i++) BinaryPrimitives.WriteUInt16BigEndian(data.AsSpan(i * 2), v[i]);
            }
            else if (src == 0x02)
            {
                if (f.Length < 18 + n * 2) end = 0x1001;
                else
                    for (var i = 0; i < n; i++)
                    {
                        var v = BinaryPrimitives.ReadUInt16BigEndian(f.AsSpan(18 + i * 2));
                        _log($"FINS nhận lệnh ghi: D{addr + i} = {v}");
                        _m.Set(addr + i, v, "gateway");
                    }
            }
            else end = 0x0401;
        }
        else end = 0x0401;                                    // lệnh không hỗ trợ

        var r = new byte[14 + data.Length];
        r[0] = 0xC0; r[1] = 0x00; r[2] = 0x02;
        r[3] = f[6]; r[4] = f[7]; r[5] = f[8];                // DNA/DA1/DA2 = SNA/SA1/SA2 của yêu cầu
        r[6] = f[3]; r[7] = f[4]; r[8] = f[5];
        r[9] = f[9];                                          // SID
        r[10] = mrc; r[11] = src;
        r[12] = (byte)(end >> 8); r[13] = (byte)end;
        data.CopyTo(r, 14);
        return r;
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        _udp?.Dispose();
        return ValueTask.CompletedTask;
    }
}
