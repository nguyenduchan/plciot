using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;

namespace PlcSim.Protocols;

/// <summary>
/// Rockwell EtherNet/IP + CIP (kiểu ControlLogix): RegisterSession, Forward Open/Close, Unconnected Send,
/// Read Tag (0x4C/0x52), Write Tag (0x4D/0x53). Tag INT[300] (mặc định "PLC_D"), phần tử n = thanh ghi D n.
/// </summary>
public sealed class EtherNetIpServer : IEndpoint
{
    readonly PlcModel _m;
    readonly IPAddress _bind;
    readonly int _port;
    readonly string _tag;
    readonly Action<string> _log;
    readonly CancellationTokenSource _cts = new();
    TcpListener? _l;
    int _peers;
    uint _nextId = 0x10000000;

    public string Name => "EtherNet/IP (CIP)";
    public int Peers => _peers;

    public EtherNetIpServer(PlcModel m, string bind, int port, string tag, Action<string> log)
    {
        _m = m; _bind = IPAddress.Parse(bind); _port = port; _tag = string.IsNullOrWhiteSpace(tag) ? "PLC_D" : tag.Trim(); _log = log;
    }

    public Task StartAsync()
    {
        _l = new TcpListener(_bind, _port);
        _l.Start();
        _log($"EtherNet/IP server nghe {_bind}:{_port}, tag INT[300] \"{_tag}\"");
        _ = Task.Run(async () =>
        {
            try { while (!_cts.IsCancellationRequested) { var c = await _l.AcceptTcpClientAsync(_cts.Token); _ = Task.Run(() => Serve(c)); } }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _log($"EIP accept: {ex.Message}"); }
        });
        return Task.CompletedTask;
    }

    public Task PushAsync() { _log("EtherNet/IP: dữ liệu đã cập nhật vào tag, chờ gateway poll"); return Task.CompletedTask; }

    sealed class Conn { public uint OtId, ToId; public uint Session; }

    async Task Serve(TcpClient c)
    {
        Interlocked.Increment(ref _peers);
        var who = c.Client.RemoteEndPoint?.ToString();
        _log($"EIP: gateway {who} kết nối");
        var conn = new Conn();
        try
        {
            using var _ = c;
            c.NoDelay = true;
            var ns = c.GetStream();
            var h = new byte[24];
            while (!_cts.IsCancellationRequested)
            {
                if (!await Io.ReadExact(ns, h, _cts.Token)) return;
                var cmd = BinaryPrimitives.ReadUInt16LittleEndian(h);
                var len = BinaryPrimitives.ReadUInt16LittleEndian(h.AsSpan(2));
                var data = new byte[len];
                if (len > 0 && !await Io.ReadExact(ns, data, _cts.Token)) return;
                var rsp = Encapsulation(cmd, h, data, conn);
                if (rsp != null) await ns.WriteAsync(rsp, _cts.Token);
            }
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or SocketException or ObjectDisposedException) { }
        finally { Interlocked.Decrement(ref _peers); _log($"EIP: gateway {who} ngắt"); }
    }

    static byte[] Pack(ushort cmd, byte[] reqHdr, uint session, byte[] data)
    {
        var r = new byte[24 + data.Length];
        BinaryPrimitives.WriteUInt16LittleEndian(r, cmd);
        BinaryPrimitives.WriteUInt16LittleEndian(r.AsSpan(2), (ushort)data.Length);
        BinaryPrimitives.WriteUInt32LittleEndian(r.AsSpan(4), session);
        reqHdr.AsSpan(12, 8).CopyTo(r.AsSpan(12));                    // sender context
        data.CopyTo(r, 24);
        return r;
    }

    byte[]? Encapsulation(ushort cmd, byte[] h, byte[] d, Conn conn)
    {
        switch (cmd)
        {
            case 0x0065:                                              // RegisterSession
                conn.Session = 0x1A2B3C4D;
                return Pack(cmd, h, conn.Session, new byte[] { 1, 0, 0, 0 });
            case 0x0066: return null;                                 // UnRegisterSession
            case 0x006F:                                              // SendRRData: interface(4) timeout(2) items(2) ...
            {
                if (d.Length < 16) return null;
                var (cip, _) = ParseItems(d, 6);
                if (cip == null) return null;
                var reply = Cip(cip, conn);
                var o = new List<byte>(new byte[] { 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0xB2, 0 });
                o.Add((byte)reply.Length); o.Add((byte)(reply.Length >> 8)); o.AddRange(reply);
                return Pack(cmd, h, conn.Session, o.ToArray());
            }
            case 0x0070:                                              // SendUnitData: address item (conn id) + data item (seq + CIP)
            {
                if (d.Length < 16) return null;
                var (item, _) = ParseItems(d, 6);
                if (item == null || item.Length < 2) return null;
                var reply = Cip(item[2..], conn);
                var o = new List<byte>(new byte[] { 0, 0, 0, 0, 0, 0, 2, 0, 0xA1, 0, 4, 0 });
                o.AddRange(BitConverter.GetBytes(conn.ToId));
                o.Add(0xB1); o.Add(0);
                var dl = reply.Length + 2;
                o.Add((byte)dl); o.Add((byte)(dl >> 8));
                o.Add(item[0]); o.Add(item[1]);
                o.AddRange(reply);
                return Pack(cmd, h, conn.Session, o.ToArray());
            }
            default: return null;
        }
    }

    /// <summary>Lấy mục dữ liệu (0xB2 hoặc 0xB1) trong danh sách item bắt đầu từ vị trí off+... (đã bỏ interface+timeout).</summary>
    static (byte[]? Data, int End) ParseItems(byte[] d, int off)
    {
        var n = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(off));
        var p = off + 2;
        for (var i = 0; i < n && p + 4 <= d.Length; i++)
        {
            var type = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(p));
            var l = BinaryPrimitives.ReadUInt16LittleEndian(d.AsSpan(p + 2));
            if (p + 4 + l > d.Length) break;
            if (type is 0x00B2 or 0x00B1) return (d.AsSpan(p + 4, l).ToArray(), p + 4 + l);
            p += 4 + l;
        }
        return (null, p);
    }

    byte[] Cip(byte[] r, Conn conn)
    {
        var svc = r[0];
        var pathWords = r[1];
        var path = r.AsSpan(2, pathWords * 2);
        var body = r.AsSpan(2 + pathWords * 2);

        switch (svc)
        {
            case 0x54:
            case 0x5B:                                                // Forward Open / Large Forward Open
            {
                conn.ToId = BinaryPrimitives.ReadUInt32LittleEndian(body.Slice(6, 4));
                conn.OtId = _nextId++;
                var o = new List<byte> { (byte)(svc | 0x80), 0, 0, 0 };
                o.AddRange(BitConverter.GetBytes(conn.OtId));
                o.AddRange(BitConverter.GetBytes(conn.ToId));
                o.AddRange(body.Slice(10, 8).ToArray());                // serial, vendor, originator serial
                var apiOt = body.Slice(22, 4).ToArray();                // O→T RPI
                var toRpiOff = svc == 0x54 ? 22 + 4 + 2 : 22 + 4 + 4;
                o.AddRange(apiOt);
                o.AddRange(body.Slice(toRpiOff, 4).ToArray());
                o.Add(0); o.Add(0);
                _log("EIP: Forward Open");
                return o.ToArray();
            }
            case 0x4E:                                                // Forward Close
            {
                var o = new List<byte> { 0xCE, 0, 0, 0 };
                o.AddRange(body.Slice(2, 8).ToArray()); o.Add(0); o.Add(0);
                return o.ToArray();
            }
            case 0x52 when path.Length >= 4 && path[0] == 0x20 && path[1] == 0x06:   // Unconnected Send: bọc một CIP
            {
                var msgLen = BinaryPrimitives.ReadUInt16LittleEndian(body.Slice(2, 2));
                return Cip(body.Slice(4, msgLen).ToArray(), conn);
            }
            case 0x4C:
            case 0x52:
            case 0x4D:
            case 0x53:
                return TagService(svc, path.ToArray(), body.ToArray());
            default:
                return new byte[] { (byte)(svc | 0x80), 0, 0x08, 0 };
        }
    }

    byte[] TagService(byte svc, byte[] path, byte[] body)
    {
        byte[] Err(byte code) => new[] { (byte)(svc | 0x80), (byte)0, code, (byte)0 };
        // path: 0x91 len name [pad] [0x28 idx | 0x29 pad idx16 | 0x2A pad idx32]
        if (path.Length < 2 || path[0] != 0x91) return Err(0x04);
        var nameLen = path[1];
        var name = System.Text.Encoding.ASCII.GetString(path, 2, nameLen);
        if (!string.Equals(name, _tag, StringComparison.OrdinalIgnoreCase)) { _log($"EIP: tag không tồn tại \"{name}\""); return Err(0x04); }
        var p = 2 + nameLen + (nameLen % 2);
        var idx = 0;
        if (p < path.Length)
        {
            if (path[p] == 0x28) idx = path[p + 1];
            else if (path[p] == 0x29) idx = BinaryPrimitives.ReadUInt16LittleEndian(path.AsSpan(p + 2));
            else if (path[p] == 0x2A) idx = (int)BinaryPrimitives.ReadUInt32LittleEndian(path.AsSpan(p + 2));
        }

        switch (svc)
        {
            case 0x4C:
            case 0x52:
            {
                var count = BinaryPrimitives.ReadUInt16LittleEndian(body);
                var skip = svc == 0x52 ? (int)BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(2)) : 0;   // offset byte (đọc phân mảnh)
                var firstElem = idx + skip / 2;
                if (count < 1 || !_m.InRange(firstElem, count - skip / 2 < 1 ? 1 : count - skip / 2)) return Err(0x05);
                var n = count - skip / 2;
                var v = _m.Read(firstElem, Math.Max(1, n));
                var o = new List<byte> { (byte)(svc | 0x80), 0, 0, 0, 0xC3, 0x00 };
                foreach (var w in v) { o.Add((byte)w); o.Add((byte)(w >> 8)); }
                return o.ToArray();
            }
            default:                                                   // 0x4D / 0x53 ghi
            {
                // body: type(2) count(2) [offset(4) nếu 0x53] data
                var count = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(2));
                var dataOff = svc == 0x53 ? 8 : 4;
                var first = idx + (svc == 0x53 ? (int)BinaryPrimitives.ReadUInt32LittleEndian(body.AsSpan(4)) / 2 : 0);
                if (body.Length < dataOff + 2 || !_m.InRange(first, 1)) return Err(0x05);
                var elems = (body.Length - dataOff) / 2;
                for (var i = 0; i < elems && _m.InRange(first + i, 1); i++)
                {
                    var v = BinaryPrimitives.ReadUInt16LittleEndian(body.AsSpan(dataOff + i * 2));
                    _log($"EIP nhận lệnh ghi: D{first + i} = {v}");
                    _m.Set(first + i, v, "gateway");
                }
                return new byte[] { (byte)(svc | 0x80), 0, 0, 0 };
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        _cts.Cancel();
        _l?.Stop();
        return ValueTask.CompletedTask;
    }
}
