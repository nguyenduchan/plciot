using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace Plciot.Scada;

/// <summary>Omron FINS (UDP hoặc TCP), vùng DM (mã 0x82). Thanh ghi D n = DM n.</summary>
public sealed class OmronFinsDriver : IRegisterDriver
{
    const byte AreaDm = 0x82;
    const int MaxWords = 200;

    readonly string _host;
    readonly int _port;
    readonly bool _tcp;
    byte _destNode, _srcNode;
    readonly int _timeoutMs;
    readonly SemaphoreSlim _lock = new(1, 1);
    UdpClient? _udp;
    TcpClient? _tcpClient;
    NetworkStream? _ns;
    byte _sid;

    public OmronFinsDriver(string host, int port, string protocol, int destNode, int srcNode, int timeoutMs = 2000)
    {
        _host = host;
        _port = port > 0 ? port : 9600;
        _tcp = protocol.Equals("tcp", StringComparison.OrdinalIgnoreCase);
        _timeoutMs = timeoutMs;
        _srcNode = (byte)srcNode;
        if (destNode > 0) _destNode = (byte)destNode;
        else _destNode = IPAddress.TryParse(host, out var ip) && ip.GetAddressBytes().Length == 4 ? ip.GetAddressBytes()[3] : (byte)0;
    }

    public async Task<ushort[]> ReadAsync(int address, int count, CancellationToken ct = default)
    {
        var res = new ushort[count];
        for (var done = 0; done < count; done += MaxWords)
        {
            var n = Math.Min(MaxWords, count - done);
            var data = await CommandAsync(0x01, 0x01, MemParams(address + done, n), ct);
            if (data.Length != n * 2) throw new IOException("fins_bad_length");
            for (var i = 0; i < n; i++) res[done + i] = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(i * 2));
        }
        return res;
    }

    public async Task WriteAsync(int address, ushort value, CancellationToken ct = default)
    {
        var p = MemParams(address, 1).Concat(new byte[] { (byte)(value >> 8), (byte)value }).ToArray();
        await CommandAsync(0x01, 0x02, p, ct);
    }

    static byte[] MemParams(int address, int count) =>
        new[] { AreaDm, (byte)(address >> 8), (byte)address, (byte)0, (byte)(count >> 8), (byte)count };

    /// <summary>Khung FINS: 10 byte header + MRC SRC + tham số (công khai để kiểm thử).</summary>
    public byte[] BuildFrame(byte mrc, byte src, byte[] parameters)
    {
        var f = new List<byte> { 0x80, 0x00, 0x02, 0x00, _destNode, 0x00, 0x00, _srcNode, 0x00, ++_sid, mrc, src };
        f.AddRange(parameters);
        return f.ToArray();
    }

    async Task<byte[]> CommandAsync(byte mrc, byte src, byte[] parameters, CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(_timeoutMs);
            try
            {
                if (_tcp && _ns == null) await HandshakeAsync(cts.Token);
                var frame = BuildFrame(mrc, src, parameters);
                var resp = _tcp ? await ExchangeTcpAsync(frame, cts.Token) : await ExchangeUdpAsync(frame, cts.Token);
                // header(10) + MRC SRC (2) + end code (2) + data
                if (resp.Length < 14 || resp[10] != mrc || resp[11] != src) throw new IOException("fins_bad_response");
                if (resp[12] != 0 || resp[13] != 0) throw new IOException($"fins_end_code_{resp[12]:X2}{resp[13]:X2}");
                return resp[14..];
            }
            catch
            {
                Close();
                throw;
            }
        }
        finally { _lock.Release(); }
    }

    async Task<byte[]> ExchangeUdpAsync(byte[] frame, CancellationToken ct)
    {
        _udp ??= new UdpClient();
        await _udp.SendAsync(frame, _host, _port, ct);
        var r = await _udp.ReceiveAsync(ct);
        return r.Buffer;
    }

    /// <summary>FINS/TCP: "FINS" len=12 cmd=0 error=0 client node=0 (xin cấp phát); PLC trả số node của client và của chính nó.</summary>
    async Task HandshakeAsync(CancellationToken ct)
    {
        var c = new TcpClient { NoDelay = true };
        await c.ConnectAsync(_host, _port, ct);
        _tcpClient = c; _ns = c.GetStream();
        var hs = new byte[] { 0x46, 0x49, 0x4E, 0x53, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
        await _ns.WriteAsync(hs, ct);
        var hr = await ReadTcpFrameAsync(ct);               // "FINS" len cmd(4)=1 error(4) client node(4) server node(4)
        if (hr.Length < 24 || BinaryPrimitives.ReadUInt32BigEndian(hr.AsSpan(12, 4)) != 0) throw new IOException("fins_handshake");
        _srcNode = hr[19];
        _destNode = hr[23];
    }

    async Task<byte[]> ExchangeTcpAsync(byte[] frame, CancellationToken ct)
    {
        var msg = new byte[16 + frame.Length];
        new byte[] { 0x46, 0x49, 0x4E, 0x53 }.CopyTo(msg, 0);
        BinaryPrimitives.WriteUInt32BigEndian(msg.AsSpan(4), (uint)(8 + frame.Length));
        BinaryPrimitives.WriteUInt32BigEndian(msg.AsSpan(8), 2);              // command: frame send
        frame.CopyTo(msg, 16);
        await _ns.WriteAsync(msg, ct);
        var r = await ReadTcpFrameAsync(ct);
        return r[16..];
    }

    async Task<byte[]> ReadTcpFrameAsync(CancellationToken ct)
    {
        var hdr = new byte[8];
        await ReadExactAsync(hdr, ct);
        if (hdr[0] != 0x46 || hdr[1] != 0x49 || hdr[2] != 0x4E || hdr[3] != 0x53) throw new IOException("fins_bad_tcp_header");
        var len = (int)BinaryPrimitives.ReadUInt32BigEndian(hdr.AsSpan(4));
        if (len < 8 || len > 4096) throw new IOException("fins_bad_tcp_length");
        var rest = new byte[len];
        await ReadExactAsync(rest, ct);
        return hdr.Concat(rest).ToArray();
    }

    async Task ReadExactAsync(byte[] buf, CancellationToken ct)
    {
        var got = 0;
        while (got < buf.Length)
        {
            var r = await _ns!.ReadAsync(buf.AsMemory(got), ct);
            if (r == 0) throw new IOException("fins_closed");
            got += r;
        }
    }

    void Close()
    {
        try { _ns?.Dispose(); _tcpClient?.Dispose(); _udp?.Dispose(); } catch { /* ignore */ }
        _ns = null; _tcpClient = null; _udp = null;
    }

    public void Dispose() { Close(); _lock.Dispose(); }
}
